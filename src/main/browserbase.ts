/**
 * @fileoverview Browserbase API client for managing remote browser sessions.
 *
 * This module provides the BrowserbaseClient class which handles all communication
 * with the Browserbase REST API. It manages session creation, retrieval, and cleanup,
 * as well as obtaining debug URLs for the live view embedding.
 *
 * @module main/browserbase
 */

import {
  BrowserbaseSession,
  BrowserbaseSessionStatus,
  SessionCapability,
  SessionConfig,
} from "../shared/types";

/** Browserbase API base URL */
const BROWSERBASE_API_URL = "https://api.browserbase.com/v1";

/** Maximum number of retry attempts for failed API requests */
const MAX_RETRIES = 3;

/** Base delay in milliseconds between retry attempts (uses exponential backoff) */
const RETRY_DELAY_MS = 1000;

/** Default maximum time to wait for a deferred session to become RUNNING */
const DEFAULT_SESSION_READY_TIMEOUT_MS = 120000;

/** Default polling interval for deferred session readiness checks */
const DEFAULT_SESSION_READY_POLL_INTERVAL_MS = 1500;

/** Browserbase statuses that mean a session will never become connectable */
const TERMINAL_SESSION_STATUSES = new Set(["COMPLETED", "TIMED_OUT", "ERROR", "STOPPED"]);

const VERIFIED_DOCS_URL = "https://docs.browserbase.com/platform/identity/overview";
const PROXIES_DOCS_URL = "https://docs.browserbase.com/platform/identity/proxies";

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function extractApiErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message;
    }
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error;
    }
  } catch {
    // Body is not JSON; use the raw text.
  }

  return body.trim();
}

function classifyDeniedCapabilities(
  apiMessage: string,
  requested: { verified: boolean; proxies: boolean }
): SessionCapability[] {
  const text = apiMessage.toLowerCase();
  const denied: SessionCapability[] = [];

  if (requested.verified && /verified|scale plan|scale-only/.test(text)) {
    denied.push("verified");
  }
  if (requested.proxies && /prox(y|ies)/.test(text)) {
    denied.push("proxies");
  }

  if (denied.length === 0) {
    if (requested.verified) {
      denied.push("verified");
    }
    if (requested.proxies) {
      denied.push("proxies");
    }
  }

  return denied;
}

function isPlanDenial(
  status: number,
  apiMessage: string,
  requested: { verified: boolean; proxies: boolean }
): boolean {
  if (!requested.verified && !requested.proxies) {
    return false;
  }

  const mentionsPaidFeature = /verified|scale plan|scale-only|prox(y|ies)|paid plan/.test(
    apiMessage.toLowerCase()
  );
  return status === 403 || (status === 400 && mentionsPaidFeature);
}

function buildAgentNotice(verified: boolean, proxies: boolean): string | null {
  if (verified && proxies) {
    return null;
  }

  const missing: string[] = [];
  if (!verified) {
    missing.push(`Verified Browser Mode (Scale-only: ${VERIFIED_DOCS_URL})`);
  }
  if (!proxies) {
    missing.push(`managed proxies (paid plan: ${PROXIES_DOCS_URL})`);
  }

  return [
    "AGENT NOTICE: This Desktop Browserbase session is degraded.",
    `Missing ${missing.join(" and ")}.`,
    "Bot detection, IP blocks, and protected sites will fail more often.",
    "Do not assume stealth or proxy protection is active.",
    "Upgrade the Browserbase plan for reliable automation.",
  ].join(" ");
}

interface BrowserbaseApiSession {
  id: string;
  status: BrowserbaseSessionStatus;
  connectUrl?: string;
  seleniumRemoteUrl?: string;
  signingKey?: string;
}

interface BrowserbaseDebugPage {
  id?: string;
  url?: string;
  debuggerFullscreenUrl?: string;
  debuggerUrl?: string;
}

interface BrowserbaseDebugInfo {
  debuggerFullscreenUrl?: string;
  debuggerUrl?: string;
  pages?: BrowserbaseDebugPage[];
}

interface CreateSessionRequest {
  browserSettings: Record<string, unknown>;
  proxies?: boolean;
  scheduleMode?: "deferred";
  timeout?: number;
  region?: string;
}

/**
 * Client for interacting with the Browserbase API.
 *
 * Handles authentication, session lifecycle management, and provides methods
 * for creating, retrieving, and stopping remote browser sessions.
 *
 * @example
 * ```typescript
 * const client = new BrowserbaseClient();
 * const session = await client.createSession({
 *   browserSettings: { viewport: { width: 1920, height: 1080 } }
 * });
 * // Use session.connectUrl for CDP connection
 * // Use session.debugUrl for live view iframe
 * await client.stopSession(session.id);
 * ```
 */
export class BrowserbaseClient {
  private apiKey: string;

  constructor() {
    const apiKey = process.env.BROWSERBASE_API_KEY;

    if (!apiKey) {
      throw new Error("BROWSERBASE_API_KEY environment variable is required");
    }

    this.apiKey = apiKey;
  }

  /**
   * Makes an HTTP request with automatic retry logic and exponential backoff.
   *
   * Retries on server errors (5xx) and rate limiting (429). Does not retry
   * on client errors (4xx) except for rate limiting.
   *
   * @param url - The URL to fetch
   * @param options - Fetch request options
   * @param retries - Maximum number of retry attempts
   * @returns The fetch Response object
   * @throws Error if all retry attempts fail
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    retries: number = MAX_RETRIES
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(url, options);

        // Don't retry client errors (4xx) except for rate limiting (429)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return response;
        }

        // Retry server errors (5xx) and rate limiting (429)
        if (response.ok) {
          return response;
        }

        if (response.status === 429 || response.status >= 500) {
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
          console.log(`Request failed with ${response.status}, retrying in ${delay}ms...`);
          await this.sleep(delay);
          continue;
        }

        return response;
      } catch (error) {
        lastError = error as Error;
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
        console.log(`Request failed: ${(error as Error).message}, retrying in ${delay}ms...`);
        await this.sleep(delay);
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  /** Utility function to pause execution for a specified duration */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getPositiveIntegerEnv(name: string, fallback: number): number {
    const value = process.env[name];
    if (!value) {
      return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private shouldUseAsyncBrowsers(): boolean {
    return parseBooleanEnv("BROWSERBASE_ASYNC_BROWSERS", false);
  }

  private getDefaultVerified(): boolean {
    return parseBooleanEnv("BROWSERBASE_VERIFIED", true);
  }

  private getDefaultProxies(): boolean {
    return parseBooleanEnv("BROWSERBASE_PROXIES", true);
  }

  private logSessionCapabilities(verified: boolean, proxies: boolean): void {
    console.log("[browserbase] Creating session", { verified, proxies });
  }

  private logDegradedSession(
    identity: { verified: boolean; proxies: boolean; denied: SessionCapability[] },
    reason: "plan" | "opt-out",
    apiMessage?: string
  ): void {
    const agentNotice = buildAgentNotice(identity.verified, identity.proxies);
    if (!agentNotice) {
      return;
    }

    console.warn("[browserbase]", agentNotice, {
      reason,
      verified: identity.verified,
      proxies: identity.proxies,
      denied: identity.denied,
      ...(apiMessage ? { apiMessage } : {}),
    });
  }

  private attachIdentity(
    session: BrowserbaseSession,
    identity: { verified: boolean; proxies: boolean; denied: SessionCapability[] }
  ): BrowserbaseSession {
    return {
      ...session,
      identity: {
        verified: identity.verified,
        proxies: identity.proxies,
        denied: identity.denied,
        agentNotice: buildAgentNotice(identity.verified, identity.proxies),
      },
    };
  }

  private throwSessionCreateError(status: number, body: string): never {
    const apiMessage = extractApiErrorMessage(body);

    if (status === 401) {
      throw new Error("Authentication failed. Please check your BROWSERBASE_API_KEY.");
    }
    if (status === 429) {
      throw new Error("Rate limit exceeded. Please try again later.");
    }
    if (status === 403) {
      throw new Error("Access denied. Please check your API key permissions.");
    }

    throw new Error(
      apiMessage
        ? `Failed to create Browserbase session: ${apiMessage}`
        : "Failed to create Browserbase session."
    );
  }

  private buildCreateSessionBody(
    config: Partial<SessionConfig> | undefined,
    capabilities: { verified: boolean; proxies: boolean }
  ): CreateSessionRequest {
    const browserSettings: Record<string, unknown> = {
      verified: capabilities.verified,
    };

    if (config?.browserSettings?.viewport) {
      browserSettings.viewport = config.browserSettings.viewport;
    }

    if (config?.browserSettings?.deviceScaleFactor) {
      browserSettings.deviceScaleFactor = config.browserSettings.deviceScaleFactor;
    }

    const scheduleMode =
      config?.scheduleMode ?? (this.shouldUseAsyncBrowsers() ? "deferred" : undefined);

    const requestBody: CreateSessionRequest = {
      proxies: capabilities.proxies,
      browserSettings,
    };

    if (scheduleMode) {
      requestBody.scheduleMode = scheduleMode;
    }

    if (typeof config?.timeout === "number") {
      requestBody.timeout = config.timeout;
    }

    if (config?.region) {
      requestBody.region = config.region;
    }

    return requestBody;
  }

  private getDefaultReadyTimeoutMs(): number {
    return this.getPositiveIntegerEnv(
      "BROWSERBASE_ASYNC_READY_TIMEOUT_MS",
      DEFAULT_SESSION_READY_TIMEOUT_MS
    );
  }

  private getDefaultReadyPollIntervalMs(): number {
    return this.getPositiveIntegerEnv(
      "BROWSERBASE_ASYNC_POLL_INTERVAL_MS",
      DEFAULT_SESSION_READY_POLL_INTERVAL_MS
    );
  }

  private async fetchSession(sessionId: string): Promise<BrowserbaseApiSession> {
    const response = await this.fetchWithRetry(`${BROWSERBASE_API_URL}/sessions/${sessionId}`, {
      method: "GET",
      headers: {
        "x-bb-api-key": this.apiKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get Browserbase session: ${error}`);
    }

    return await response.json() as BrowserbaseApiSession;
  }

  private appendNavbarParam(debugUrl: string): string {
    return debugUrl.includes("?") ? `${debugUrl}&navbar=false` : `${debugUrl}?navbar=false`;
  }

  private getDebugUrlFromPage(page: BrowserbaseDebugPage): string | null {
    const debugUrl = page.debuggerFullscreenUrl || page.debuggerUrl;
    return debugUrl ? this.appendNavbarParam(debugUrl) : null;
  }

  private fallbackDebugUrl(sessionId: string): string {
    return `https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=connect.browserbase.com&apiKey=${this.apiKey}&sessionId=${sessionId}`;
  }

  private async fetchDebugInfo(sessionId: string): Promise<BrowserbaseDebugInfo> {
    const response = await this.fetchWithRetry(`${BROWSERBASE_API_URL}/sessions/${sessionId}/debug`, {
      method: "GET",
      headers: {
        "x-bb-api-key": this.apiKey,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get Browserbase debug info: ${error}`);
    }

    return await response.json() as BrowserbaseDebugInfo;
  }

  private async toReadySession(session: BrowserbaseApiSession): Promise<BrowserbaseSession> {
    if (session.status !== "RUNNING") {
      throw new Error(
        `Browserbase session ${session.id} is ${session.status}; connection details are not available yet`
      );
    }

    // Get the debug/live view URL from the debug endpoint once the browser is running.
    const debugUrl = await this.getDebugUrl(session.id);
    console.log("Using debugUrl:", debugUrl);

    return {
      id: session.id,
      status: session.status,
      connectUrl: session.connectUrl || this.getDebugConnectionUrl(session.id),
      debugUrl,
      seleniumRemoteUrl: session.seleniumRemoteUrl,
      signingKey: session.signingKey,
    };
  }

  /**
   * Creates a new Browserbase remote browser session.
   *
   * Sessions use standard synchronous scheduling unless async browsers are
   * explicitly enabled. When the API returns a PENDING session, this method
   * polls until the browser is RUNNING and only then returns connection details.
   *
   * Every session defaults to Browserbase proxies and Verified Browser Mode.
   * Set BROWSERBASE_VERIFIED=false or BROWSERBASE_PROXIES=false to opt out.
   * If the API key cannot use a requested feature, we retry without it, log an
   * AGENT NOTICE, and stamp the session so automation clients see the degradation.
   * projectId is omitted so the API can infer it from the key.
   *
   * @param config - Optional session configuration
   * @returns Session information including connection URLs
   * @throws Error if session creation fails (auth, permissions, rate limit, etc.)
   */
  async createSession(config?: Partial<SessionConfig>): Promise<BrowserbaseSession> {
    let verified = config?.browserSettings?.verified ?? this.getDefaultVerified();
    let proxies = config?.proxies ?? this.getDefaultProxies();
    const denied: SessionCapability[] = [];

    this.logSessionCapabilities(verified, proxies);
    if (!verified || !proxies) {
      this.logDegradedSession({ verified, proxies, denied }, "opt-out");
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const requestBody = this.buildCreateSessionBody(config, { verified, proxies });

      if (config?.browserSettings?.viewport) {
        console.log("Creating session with viewport:", config.browserSettings.viewport);
      }
      if (config?.browserSettings?.deviceScaleFactor) {
        console.log(
          "Creating session with deviceScaleFactor:",
          config.browserSettings.deviceScaleFactor
        );
      }
      if (requestBody.scheduleMode) {
        console.log("Creating session with scheduleMode:", requestBody.scheduleMode);
      }

      const response = await this.fetchWithRetry(`${BROWSERBASE_API_URL}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-bb-api-key": this.apiKey,
        },
        body: JSON.stringify(requestBody),
      });

      if (response.ok) {
        const session = (await response.json()) as BrowserbaseApiSession;
        console.log("Browserbase session created:", JSON.stringify(session, null, 2));

        if (session.status === "PENDING") {
          console.log(`Browserbase session ${session.id} is pending; polling until RUNNING...`);
          const ready = await this.waitForSessionReady(
            session.id,
            config?.readyTimeoutMs,
            config?.readyPollIntervalMs
          );
          return this.attachIdentity(ready, { verified, proxies, denied });
        }

        return this.attachIdentity(await this.toReadySession(session), {
          verified,
          proxies,
          denied,
        });
      }

      const error = await response.text();
      const apiMessage = extractApiErrorMessage(error);
      const requested = { verified, proxies };

      if (!isPlanDenial(response.status, apiMessage, requested)) {
        this.throwSessionCreateError(response.status, error);
      }

      const newlyDenied = classifyDeniedCapabilities(apiMessage, requested);
      let changed = false;
      for (const capability of newlyDenied) {
        if (capability === "verified" && verified) {
          verified = false;
          if (!denied.includes("verified")) {
            denied.push("verified");
          }
          changed = true;
        }
        if (capability === "proxies" && proxies) {
          proxies = false;
          if (!denied.includes("proxies")) {
            denied.push("proxies");
          }
          changed = true;
        }
      }

      if (!changed) {
        this.throwSessionCreateError(response.status, error);
      }

      this.logDegradedSession({ verified, proxies, denied }, "plan", apiMessage);
    }

    throw new Error("Failed to create Browserbase session.");
  }

  /**
   * Retrieves the debug/live view URL for a session.
   *
   * The URL can be embedded in an iframe to display the remote browser's
   * screen. Appends `navbar=false` to hide Browserbase's navigation UI.
   *
   * @param sessionId - The session ID to get the debug URL for
   * @returns The debug URL for iframe embedding
   */
  async getDebugUrl(sessionId: string): Promise<string> {
    try {
      const debugInfo = await this.fetchDebugInfo(sessionId);
      console.log("Debug info:", JSON.stringify(debugInfo, null, 2));

      // Use debuggerFullscreenUrl for the embedded view, hide navbar since we have our own
      const baseUrl = debugInfo.debuggerFullscreenUrl || debugInfo.debuggerUrl ||
        this.fallbackDebugUrl(sessionId);

      return this.appendNavbarParam(baseUrl);
    } catch (error) {
      console.error("Error getting debug URL:", error);
      return this.fallbackDebugUrl(sessionId);
    }
  }

  /**
   * Gets the debug URL for a specific page/tab within a session.
   *
   * Used when switching tabs to get the correct live view URL for the
   * newly active page. Matches pages by their current URL.
   *
   * @param sessionId - The session ID
   * @param pageUrl - The URL of the page to find
   * @returns The debug URL for the page, or null if not found
   */
  async getDebugUrlForPage(
    sessionId: string,
    pageUrl: string,
    options: { fallbackToPrimary?: boolean } = {}
  ): Promise<string | null> {
    try {
      const debugInfo = await this.fetchDebugInfo(sessionId);

      console.log("Looking for page with URL:", pageUrl);
      console.log("Available pages:", debugInfo.pages?.map(p => ({ id: p.id, url: p.url })));

      // Find the page by URL match
      if (debugInfo.pages) {
        const matchingPage = debugInfo.pages.find(p => p.url === pageUrl);
        if (matchingPage) {
          const debugUrl = this.getDebugUrlFromPage(matchingPage);
          if (debugUrl) {
            console.log("Found matching page:", matchingPage.id);
            return debugUrl;
          }
        }
      }

      if (options.fallbackToPrimary !== false) {
        const baseUrl = debugInfo.debuggerFullscreenUrl;
        if (baseUrl) {
          console.log("Using fallback primary page debug URL");
          return this.appendNavbarParam(baseUrl);
        }
      }

      return null;
    } catch (error) {
      console.error("Error getting debug URL for page:", error);
      return null;
    }
  }

  /**
   * Gets the debug URL for a specific CDP target within a session.
   *
   * Matching by target ID is more stable than matching by URL while a new tab is
   * still about:blank or navigating to its first page.
   *
   * @param sessionId - The session ID
   * @param targetId - The CDP target ID for the page
   * @returns The debug URL for the page, or null if not found
   */
  async getDebugUrlForTarget(sessionId: string, targetId: string): Promise<string | null> {
    try {
      const debugInfo = await this.fetchDebugInfo(sessionId);
      const matchingPage = debugInfo.pages?.find((page) => page.id === targetId);

      if (!matchingPage) {
        return null;
      }

      console.log("Found matching target:", targetId);
      return this.getDebugUrlFromPage(matchingPage);
    } catch (error) {
      console.error("Error getting debug URL for target:", error);
      return null;
    }
  }

  /**
   * Retrieves information about an existing session.
   *
   * @param sessionId - The session ID to retrieve
   * @returns Session information including current status and URLs
   * @throws Error if session retrieval fails
   */
  async getSession(sessionId: string): Promise<BrowserbaseSession> {
    const session = await this.fetchSession(sessionId);
    return await this.toReadySession(session);
  }

  /**
   * Stops/releases a Browserbase session.
   *
   * Called during cleanup to release cloud resources. Errors are logged
   * but not thrown since this is typically called during shutdown.
   *
   * @param sessionId - The session ID to stop
   */
  async stopSession(sessionId: string): Promise<void> {
    try {
      const response = await this.fetchWithRetry(`${BROWSERBASE_API_URL}/sessions/${sessionId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-bb-api-key": this.apiKey,
        },
        body: JSON.stringify({
          status: "REQUEST_RELEASE",
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`Failed to stop Browserbase session: ${error}`);
      }
    } catch (error) {
      // Log but don't throw - this is cleanup code
      console.error("Error stopping session:", error);
    }
  }

  /**
   * Waits for a session to reach the RUNNING state.
   *
   * Polls the session status until it's ready or times out. Used after
   * session creation to ensure the browser is fully initialized.
   *
   * @param sessionId - The session ID to wait for
   * @param timeoutMs - Maximum time to wait in milliseconds
   * @param pollIntervalMs - Delay between readiness checks in milliseconds
   * @returns Session information once ready
   * @throws Error if session fails or times out
   */
  async waitForSessionReady(
    sessionId: string,
    timeoutMs: number = this.getDefaultReadyTimeoutMs(),
    pollIntervalMs: number = this.getDefaultReadyPollIntervalMs()
  ): Promise<BrowserbaseSession> {
    const startTime = Date.now();
    let lastStatus: BrowserbaseSessionStatus = "UNKNOWN";

    while (Date.now() - startTime <= timeoutMs) {
      const session = await this.fetchSession(sessionId);
      lastStatus = session.status;

      if (session.status === "RUNNING") {
        console.log(`Browserbase session ${sessionId} is RUNNING`);
        return await this.toReadySession(session);
      }

      if (TERMINAL_SESSION_STATUSES.has(session.status)) {
        throw new Error(`Session failed with status: ${session.status}`);
      }

      console.log(`Browserbase session ${sessionId} is ${session.status}; polling again...`);

      const remainingMs = timeoutMs - (Date.now() - startTime);
      if (remainingMs <= 0) {
        break;
      }

      await this.sleep(Math.min(pollIntervalMs, remainingMs));
    }

    throw new Error(
      `Session startup timeout after ${timeoutMs}ms; last status was ${lastStatus}`
    );
  }

  /**
   * Constructs the WebSocket URL for CDP connection.
   *
   * @param sessionId - The session ID
   * @returns WebSocket URL for Chrome DevTools Protocol connection
   */
  getDebugConnectionUrl(sessionId: string): string {
    return `wss://connect.browserbase.com?apiKey=${this.apiKey}&sessionId=${sessionId}`;
  }

  /**
   * Checks if the client has valid configuration.
   *
   * @returns true if API key is set
   */
  isConfigured(): boolean {
    return !!this.apiKey;
  }
}

/** Lazily initialized singleton client instance */
let _browserbaseClient: BrowserbaseClient | null = null;

/**
 * Gets or creates the singleton BrowserbaseClient instance.
 *
 * Uses lazy initialization to avoid throwing errors on module import
 * when environment variables are not yet set.
 *
 * @returns The singleton BrowserbaseClient instance
 */
export function getBrowserbaseClient(): BrowserbaseClient {
  if (!_browserbaseClient) {
    _browserbaseClient = new BrowserbaseClient();
  }
  return _browserbaseClient;
}

// For backwards compatibility
export const browserbaseClient = new Proxy({} as BrowserbaseClient, {
  get(_, prop) {
    return getBrowserbaseClient()[prop as keyof BrowserbaseClient];
  },
});

/**
 * @fileoverview Browserbase API client for managing remote browser sessions.
 *
 * This module provides the BrowserbaseClient class which handles all communication
 * with the Browserbase API via the official Node SDK. It manages session creation,
 * retrieval, and cleanup, as well as obtaining debug URLs for the live view embedding.
 *
 * @module main/browserbase
 */

import Browserbase, {
  APIError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from "@browserbasehq/sdk";
import { BrowserbaseSession, BrowserbaseSessionStatus, SessionConfig } from "../shared/types";

/** Maximum number of retry attempts for failed API requests */
const MAX_RETRIES = 3;

/** Default maximum time to wait for a deferred session to become RUNNING */
const DEFAULT_SESSION_READY_TIMEOUT_MS = 120000;

/** Default polling interval for deferred session readiness checks */
const DEFAULT_SESSION_READY_POLL_INTERVAL_MS = 1500;

/** Browserbase statuses that mean a session will never become connectable */
const TERMINAL_SESSION_STATUSES = new Set(["COMPLETED", "TIMED_OUT", "ERROR", "STOPPED"]);

type SessionCreateParams = Browserbase.SessionCreateParams;

/**
 * Session create body accepted by the API. The SDK types omit a few fields the
 * Create Session API still accepts (scheduleMode, deviceScaleFactor). projectId
 * is intentionally left optional and never sent — the API infers it from the key.
 */
type CreateSessionBody = Omit<SessionCreateParams, "browserSettings" | "projectId"> & {
  projectId?: never;
  scheduleMode?: "deferred";
  browserSettings?: Browserbase.SessionCreateParams.BrowserSettings & {
    deviceScaleFactor?: number;
  };
};

type BrowserbaseApiSession = {
  id: string;
  status: BrowserbaseSessionStatus;
  connectUrl?: string;
  seleniumRemoteUrl?: string;
  signingKey?: string;
};

type BrowserbaseDebugPage = {
  id?: string;
  url?: string;
  debuggerFullscreenUrl?: string;
  debuggerUrl?: string;
};

type BrowserbaseDebugInfo = {
  debuggerFullscreenUrl?: string;
  debuggerUrl?: string;
  pages?: BrowserbaseDebugPage[];
};

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
  private sdk: Browserbase;

  constructor() {
    const apiKey = process.env.BROWSERBASE_API_KEY;

    if (!apiKey) {
      throw new Error("BROWSERBASE_API_KEY environment variable is required");
    }

    this.apiKey = apiKey;
    this.sdk = new Browserbase({
      apiKey,
      maxRetries: MAX_RETRIES,
    });
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
    const value = process.env.BROWSERBASE_ASYNC_BROWSERS;
    if (!value) {
      return false;
    }

    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
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

  private mapCreateError(error: unknown): Error {
    if (error instanceof AuthenticationError) {
      return new Error("Authentication failed. Please check your BROWSERBASE_API_KEY.");
    }
    if (error instanceof PermissionDeniedError) {
      return new Error("Access denied. Please check your API key permissions.");
    }
    if (error instanceof RateLimitError) {
      return new Error("Rate limit exceeded. Please try again later.");
    }
    if (error instanceof APIError) {
      return new Error(`Failed to create Browserbase session: ${error.message}`);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private async fetchSession(sessionId: string): Promise<BrowserbaseApiSession> {
    try {
      const session = await this.sdk.sessions.retrieve(sessionId);
      return {
        id: session.id,
        status: session.status,
        connectUrl: session.connectUrl,
        seleniumRemoteUrl: session.seleniumRemoteUrl,
        signingKey: session.signingKey,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get Browserbase session: ${message}`);
    }
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
    const debugInfo = await this.sdk.sessions.debug(sessionId);
    return {
      debuggerFullscreenUrl: debugInfo.debuggerFullscreenUrl,
      debuggerUrl: debugInfo.debuggerUrl,
      pages: debugInfo.pages,
    };
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
   * advancedStealth is omitted unless the caller sets it explicitly. projectId
   * is omitted so the API can infer it from the key.
   *
   * @param config - Optional session configuration
   * @returns Session information including connection URLs
   * @throws Error if session creation fails (auth, permissions, rate limit, etc.)
   */
  async createSession(config?: Partial<SessionConfig>): Promise<BrowserbaseSession> {
    const browserSettings: NonNullable<CreateSessionBody["browserSettings"]> = {
      verified: config?.browserSettings?.verified ?? true,
    };

    // Only send advancedStealth when the caller explicitly sets it.
    if (config?.browserSettings?.advancedStealth !== undefined) {
      browserSettings.advancedStealth = config.browserSettings.advancedStealth;
    }

    // Add viewport if provided
    if (config?.browserSettings?.viewport) {
      browserSettings.viewport = config.browserSettings.viewport;
      console.log("Creating session with viewport:", config.browserSettings.viewport);
    }

    // Add deviceScaleFactor if provided (for Retina displays)
    if (config?.browserSettings?.deviceScaleFactor) {
      browserSettings.deviceScaleFactor = config.browserSettings.deviceScaleFactor;
      console.log("Creating session with deviceScaleFactor:", config.browserSettings.deviceScaleFactor);
    }

    const scheduleMode = config?.scheduleMode ?? (
      this.shouldUseAsyncBrowsers() ? "deferred" : undefined
    );

    const requestBody: CreateSessionBody = {
      proxies: config?.proxies ?? true,
      browserSettings,
    };

    if (scheduleMode) {
      requestBody.scheduleMode = scheduleMode;
      console.log("Creating session with scheduleMode:", scheduleMode);
    }

    if (typeof config?.timeout === "number") {
      // SDK types this as api_timeout and serializes it as the API `timeout` field.
      requestBody.api_timeout = config.timeout;
    }

    if (config?.region) {
      requestBody.region = config.region as SessionCreateParams["region"];
    }

    console.log(
      "Creating session with proxies:",
      requestBody.proxies,
      "verified:",
      browserSettings.verified
    );

    let session: BrowserbaseApiSession;
    try {
      const created = await this.sdk.sessions.create(requestBody);
      session = {
        id: created.id,
        status: created.status,
        connectUrl: created.connectUrl,
        seleniumRemoteUrl: created.seleniumRemoteUrl,
        signingKey: created.signingKey,
      };
    } catch (error) {
      throw this.mapCreateError(error);
    }

    console.log("Browserbase session created:", JSON.stringify(session, null, 2));

    if (session.status === "PENDING") {
      console.log(`Browserbase session ${session.id} is pending; polling until RUNNING...`);
      return await this.waitForSessionReady(
        session.id,
        config?.readyTimeoutMs,
        config?.readyPollIntervalMs
      );
    }

    return await this.toReadySession(session);
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
      await this.sdk.sessions.update(sessionId, {
        status: "REQUEST_RELEASE",
      });
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

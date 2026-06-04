/**
 * @fileoverview Browserbase API client for managing remote browser sessions.
 *
 * This module provides the BrowserbaseClient class which handles all communication
 * with the Browserbase REST API. It manages session creation, retrieval, and cleanup,
 * as well as obtaining debug URLs for the live view embedding.
 *
 * @module main/browserbase
 */

import { BrowserbaseSession, BrowserbaseSessionStatus, SessionConfig } from "../shared/types";

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

interface BrowserbaseApiSession {
  id: string;
  status: BrowserbaseSessionStatus;
  connectUrl?: string;
  seleniumRemoteUrl?: string;
  signingKey?: string;
}

interface CreateSessionRequest {
  projectId: string;
  browserSettings: Record<string, unknown>;
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
  private projectId: string;

  constructor() {
    const apiKey = process.env.BROWSERBASE_API_KEY;
    const projectId = process.env.BROWSERBASE_PROJECT_ID;

    if (!apiKey) {
      throw new Error("BROWSERBASE_API_KEY environment variable is required");
    }
    if (!projectId) {
      throw new Error("BROWSERBASE_PROJECT_ID environment variable is required");
    }

    this.apiKey = apiKey;
    this.projectId = projectId;
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
   * @param config - Optional session configuration
   * @returns Session information including connection URLs
   * @throws Error if session creation fails (auth, permissions, rate limit, etc.)
   */
  async createSession(config?: Partial<SessionConfig>): Promise<BrowserbaseSession> {
    const browserSettings: Record<string, unknown> = {
      stealth: true,
    };

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

    const requestBody: CreateSessionRequest = {
      projectId: config?.projectId || this.projectId,
      browserSettings,
    };

    if (scheduleMode) {
      requestBody.scheduleMode = scheduleMode;
      console.log("Creating session with scheduleMode:", scheduleMode);
    }

    if (typeof config?.timeout === "number") {
      requestBody.timeout = config.timeout;
    }

    if (config?.region) {
      requestBody.region = config.region;
    }

    const response = await this.fetchWithRetry(`${BROWSERBASE_API_URL}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bb-api-key": this.apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.text();
      let errorMessage = `Failed to create Browserbase session: ${error}`;

      // Provide helpful error messages
      if (response.status === 401) {
        errorMessage = "Authentication failed. Please check your BROWSERBASE_API_KEY.";
      } else if (response.status === 403) {
        errorMessage = "Access denied. Please check your BROWSERBASE_PROJECT_ID and API key permissions.";
      } else if (response.status === 429) {
        errorMessage = "Rate limit exceeded. Please try again later.";
      }

      throw new Error(errorMessage);
    }

    const session = await response.json() as BrowserbaseApiSession;
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
      const response = await this.fetchWithRetry(`${BROWSERBASE_API_URL}/sessions/${sessionId}/debug`, {
        method: "GET",
        headers: {
          "x-bb-api-key": this.apiKey,
        },
      });

      if (!response.ok) {
        console.warn("Failed to get debug URL from API, using fallback");
        return `https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=connect.browserbase.com&apiKey=${this.apiKey}&sessionId=${sessionId}`;
      }

      const debugInfo = await response.json() as { debuggerFullscreenUrl?: string; debuggerUrl?: string; pages?: Array<{ debuggerFullscreenUrl?: string }> };
      console.log("Debug info:", JSON.stringify(debugInfo, null, 2));

      // Use debuggerFullscreenUrl for the embedded view, hide navbar since we have our own
      const baseUrl = debugInfo.debuggerFullscreenUrl || debugInfo.debuggerUrl ||
        `https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=connect.browserbase.com&apiKey=${this.apiKey}&sessionId=${sessionId}`;

      // Append navbar=false to hide Browserbase's navbar
      return baseUrl.includes('?') ? `${baseUrl}&navbar=false` : `${baseUrl}?navbar=false`;
    } catch (error) {
      console.error("Error getting debug URL:", error);
      return `https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=connect.browserbase.com&apiKey=${this.apiKey}&sessionId=${sessionId}`;
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
  async getDebugUrlForPage(sessionId: string, pageUrl: string): Promise<string | null> {
    try {
      const response = await this.fetchWithRetry(`${BROWSERBASE_API_URL}/sessions/${sessionId}/debug`, {
        method: "GET",
        headers: {
          "x-bb-api-key": this.apiKey,
        },
      });

      if (!response.ok) {
        console.warn("Failed to get debug URL for page from API");
        return null;
      }

      const debugInfo = await response.json() as {
        debuggerFullscreenUrl?: string;
        pages?: Array<{ id: string; url: string; debuggerFullscreenUrl?: string; debuggerUrl?: string }>
      };

      console.log("Looking for page with URL:", pageUrl);
      console.log("Available pages:", debugInfo.pages?.map(p => ({ id: p.id, url: p.url })));

      // Find the page by URL match
      if (debugInfo.pages) {
        const matchingPage = debugInfo.pages.find(p => p.url === pageUrl);
        if (matchingPage) {
          const debugUrl = matchingPage.debuggerFullscreenUrl || matchingPage.debuggerUrl;
          if (debugUrl) {
            console.log("Found matching page:", matchingPage.id);
            return debugUrl.includes('?') ? `${debugUrl}&navbar=false` : `${debugUrl}?navbar=false`;
          }
        }
      }

      // Fallback to the main debug URL (first/primary page)
      const baseUrl = debugInfo.debuggerFullscreenUrl;
      if (baseUrl) {
        console.log("Using fallback primary page debug URL");
        return baseUrl.includes('?') ? `${baseUrl}&navbar=false` : `${baseUrl}?navbar=false`;
      }

      return null;
    } catch (error) {
      console.error("Error getting debug URL for page:", error);
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
   * @returns true if API key and project ID are set
   */
  isConfigured(): boolean {
    return !!this.apiKey && !!this.projectId;
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

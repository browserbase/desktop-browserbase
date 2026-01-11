import { BrowserbaseSession, SessionConfig } from "../shared/types";

const BROWSERBASE_API_URL = "https://api.browserbase.com/v1";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

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

    const response = await this.fetchWithRetry(`${BROWSERBASE_API_URL}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bb-api-key": this.apiKey,
      },
      body: JSON.stringify({
        projectId: this.projectId,
        browserSettings,
      }),
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

    const session = await response.json() as { id: string; status: string; connectUrl?: string };
    console.log("Browserbase session created:", JSON.stringify(session, null, 2));

    // Get the debug/live view URL from the debug endpoint
    const debugUrl = await this.getDebugUrl(session.id);
    console.log("Using debugUrl:", debugUrl);

    return {
      id: session.id,
      status: session.status,
      connectUrl: session.connectUrl || `wss://connect.browserbase.com?apiKey=${this.apiKey}&sessionId=${session.id}`,
      debugUrl,
    };
  }

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

  async getSession(sessionId: string): Promise<BrowserbaseSession> {
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

    const session = await response.json() as { id: string; status: string; connectUrl?: string };

    // Get the debug/live view URL from the debug endpoint
    const debugUrl = await this.getDebugUrl(sessionId);

    return {
      id: session.id,
      status: session.status,
      connectUrl: session.connectUrl || `wss://connect.browserbase.com?apiKey=${this.apiKey}&sessionId=${session.id}`,
      debugUrl,
    };
  }

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

  async waitForSessionReady(sessionId: string, timeoutMs: number = 30000): Promise<BrowserbaseSession> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const session = await this.getSession(sessionId);

      if (session.status === "RUNNING") {
        return session;
      }

      if (session.status === "ERROR" || session.status === "STOPPED") {
        throw new Error(`Session failed with status: ${session.status}`);
      }

      await this.sleep(1000);
    }

    throw new Error("Session startup timeout");
  }

  getDebugConnectionUrl(sessionId: string): string {
    return `wss://connect.browserbase.com?apiKey=${this.apiKey}&sessionId=${sessionId}`;
  }

  isConfigured(): boolean {
    return !!this.apiKey && !!this.projectId;
  }
}

// Lazy initialization to avoid throwing on import
let _browserbaseClient: BrowserbaseClient | null = null;

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

export class ContentArea {
  private element: HTMLElement | null;
  private loadingOverlay: HTMLElement | null;
  private debugView: Electron.WebviewTag | null;
  private isLoaded: boolean = false;
  private loadTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    console.log("[ContentArea] Initializing...");
    this.element = document.getElementById("content-area");
    this.loadingOverlay = document.getElementById("loading-overlay");
    this.debugView = document.getElementById("live-view-frame") as Electron.WebviewTag | null;

    console.log("[ContentArea] Elements found:", {
      element: !!this.element,
      loadingOverlay: !!this.loadingOverlay,
      debugView: !!this.debugView,
    });

    this.setupEventListeners();
    console.log("[ContentArea] Initialized successfully");
  }

  private setupEventListeners(): void {
    // Listen for session creation to load the debug view
    window.electronAPI.onSessionCreated(async (sessionId: string) => {
      console.log("[ContentArea] Session created event received:", sessionId);
      await this.loadDebugView();
    });

    // Listen for session errors
    window.electronAPI.onSessionError((error: string) => {
      console.error("[ContentArea] Session error:", error);
      this.showError(error);
    });

    // Listen for disconnection
    window.electronAPI.onSessionDisconnected(() => {
      console.log("[ContentArea] Session disconnected");
      this.showError("Connection to remote browser lost. Please restart the application.");
    });

    // Listen for debug URL changes (tab switching)
    window.electronAPI.onDebugUrlChanged((url: string) => {
      console.log("[ContentArea] Debug URL changed:", url);
      this.updateDebugView(url);
    });

    if (!this.debugView) {
      console.error("[ContentArea] Webview element not found!");
      return;
    }

    // Handle webview load events
    this.debugView.addEventListener("did-start-loading", () => {
      console.log("[ContentArea] Webview started loading");
    });

    this.debugView.addEventListener("did-finish-load", () => {
      console.log("[ContentArea] Webview finished loading");
      this.clearLoadTimeout();
      this.hideLoading();
    });

    this.debugView.addEventListener("did-fail-load", (event) => {
      console.error("[ContentArea] Webview failed to load:", event);
      this.showError(`Failed to load remote browser view: ${(event as any).errorDescription || 'Unknown error'}`);
    });

    this.debugView.addEventListener("dom-ready", () => {
      console.log("[ContentArea] Webview DOM ready");
    });

    this.debugView.addEventListener("console-message", (event) => {
      console.log("[Webview Console]", (event as any).message);
    });
  }

  public async loadDebugView(): Promise<void> {
    if (!this.debugView) {
      console.error("[ContentArea] Cannot load debug view - webview element not found");
      this.showError("Internal error: webview element not found");
      return;
    }

    try {
      this.showLoading();
      console.log("[ContentArea] Fetching debug URL...");
      const url = await window.electronAPI.getDebugUrl();
      console.log("[ContentArea] Got debug URL:", url);

      if (url) {
        // Set a timeout to hide loading even if load event doesn't fire
        this.loadTimeout = setTimeout(() => {
          console.log("[ContentArea] Load timeout reached, hiding overlay");
          this.hideLoading();
        }, 15000);

        // Log webview state before setting src
        console.log("[ContentArea] Setting webview src...");

        this.debugView.src = url;
        this.isLoaded = true;
        console.log("[ContentArea] Debug webview src set to:", url);

        // Check dimensions after a short delay
        setTimeout(() => {
          if (this.debugView) {
            const rect = this.debugView.getBoundingClientRect();
            console.log("[ContentArea] Webview dimensions:", rect.width, "x", rect.height);
          }
        }, 100);
      } else {
        this.showError("Failed to get debug URL from Browserbase - URL is empty");
      }
    } catch (error) {
      console.error("[ContentArea] Failed to load debug view:", error);
      this.showError(`Failed to load debug view: ${error}`);
    }
  }

  private clearLoadTimeout(): void {
    if (this.loadTimeout) {
      clearTimeout(this.loadTimeout);
      this.loadTimeout = null;
    }
  }

  public showLoading(): void {
    if (this.loadingOverlay) {
      this.loadingOverlay.classList.remove("hidden");
      const p = this.loadingOverlay.querySelector("p");
      if (p) {
        p.textContent = "Connecting to Browserbase...";
      }
    }
  }

  public hideLoading(): void {
    console.log("[ContentArea] Hiding loading overlay");
    if (this.loadingOverlay) {
      this.loadingOverlay.classList.add("hidden");
    }
  }

  public showError(message: string): void {
    this.clearLoadTimeout();
    if (this.loadingOverlay) {
      this.loadingOverlay.classList.remove("hidden");
      this.loadingOverlay.innerHTML = `
        <div style="text-align: center;">
          <svg width="48" height="48" viewBox="0 0 48 48" style="margin-bottom: 16px; color: #E81123;">
            <circle cx="24" cy="24" r="22" stroke="currentColor" stroke-width="2" fill="none"/>
            <line x1="24" y1="14" x2="24" y2="28" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
            <circle cx="24" cy="34" r="2" fill="currentColor"/>
          </svg>
          <p style="color: #202124; font-size: 16px; margin-bottom: 8px;">Connection Error</p>
          <p style="color: #5F6368; font-size: 14px; max-width: 400px;">${this.escapeHtml(message)}</p>
          <button onclick="window.location.reload()" style="margin-top: 16px; padding: 8px 24px; background: #1A73E8; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px;">
            Retry
          </button>
        </div>
      `;
    }
  }

  public refresh(): void {
    if (this.isLoaded && this.debugView) {
      this.debugView.reload();
    }
  }

  public updateDebugView(url: string): void {
    if (!this.debugView) {
      console.error("[ContentArea] Cannot update debug view - webview element not found");
      return;
    }

    if (url && url !== this.debugView.src) {
      console.log("[ContentArea] Updating debug view to:", url);
      this.debugView.src = url;
    }
  }

  public isConnected(): boolean {
    return this.isLoaded;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}

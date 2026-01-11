import { chromium, Browser, CDPSession, Page, BrowserContext } from "playwright-core";
import { BrowserWindow } from "electron";
import { BrowserbaseSession, TabInfo, IPC_CHANNELS, DownloadInfo } from "../shared/types";
import { BrowserbaseClient } from "./browserbase";

export class SessionManager {
  private browserbaseClient: BrowserbaseClient;
  private session: BrowserbaseSession | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private cdpSession: CDPSession | null = null;
  private mainWindow: BrowserWindow | null = null;
  private tabs: TabInfo[] = [];
  private currentUrl: string = "";
  private activeTabIndex: number = 0;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private isConnecting = false;

  constructor() {
    this.browserbaseClient = new BrowserbaseClient();
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  // Store current viewport dimensions for applying to new tabs
  private currentViewportWidth: number = 1440;
  private currentViewportHeight: number = 900;

  async updateViewport(width: number, height: number): Promise<void> {
    // Store dimensions for new tabs
    this.currentViewportWidth = width;
    this.currentViewportHeight = height;

    const activePage = this.getActivePage();
    if (!activePage) {
      console.log("[Viewport] No active page to update viewport");
      return;
    }

    await this.applyViewportToPage(activePage, width, height);
  }

  private async applyViewportToPage(page: Page, width: number, height: number): Promise<void> {
    try {
      // Always create a new CDP session for the specific page
      const cdp = await page.context().newCDPSession(page);

      const deviceScaleFactor = process.platform === "darwin" ? 2 : 1;

      console.log(`[Viewport] Applying viewport ${width}x${height} (scale: ${deviceScaleFactor}) to page: ${page.url()}`);

      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor,
        mobile: false,
      });

      console.log("[Viewport] Viewport applied successfully");
    } catch (error) {
      console.error("[Viewport] Failed to apply viewport:", error);
    }
  }

  async applyViewportToAllPages(): Promise<void> {
    if (!this.context) return;

    const pages = this.context.pages();
    for (const page of pages) {
      await this.applyViewportToPage(page, this.currentViewportWidth, this.currentViewportHeight);
    }
  }

  async initialize(): Promise<BrowserbaseSession> {
    try {
      // Calculate viewport size based on window content area
      // Chrome UI elements: tab bar (36px), nav bar (40px) = 76px total
      const windowBounds = this.mainWindow?.getContentBounds();
      const chromeUIHeight = 76; // 36 (tab bar) + 40 (nav bar)

      // Use actual window size, with reasonable defaults
      const defaultWidth = 1440;
      const defaultHeight = 900;

      const contentWidth = windowBounds?.width || defaultWidth;
      const contentHeight = windowBounds
        ? Math.max(400, windowBounds.height - chromeUIHeight)
        : defaultHeight - chromeUIHeight;

      // Store for later use with new tabs
      this.currentViewportWidth = contentWidth;
      this.currentViewportHeight = contentHeight;

      // For session creation, use larger viewport to avoid issues - we'll override with CDP later
      const viewportWidth = Math.max(2560, contentWidth);
      const viewportHeight = Math.max(1440, contentHeight);

      console.log("Window content bounds:", windowBounds);
      console.log(`Chrome UI height: ${chromeUIHeight}px`);
      console.log(`Actual viewport to use: ${contentWidth}x${contentHeight}`);
      console.log(`Creating session with initial viewport: ${viewportWidth}x${viewportHeight} (will override with CDP)`);

      // Create a new Browserbase session with viewport matching our window
      // Use deviceScaleFactor of 2 for Retina displays
      const scaleFactor = this.mainWindow?.webContents.getZoomFactor() || 1;
      const deviceScaleFactor = process.platform === 'darwin' ? 2 : 1;

      this.session = await this.browserbaseClient.createSession({
        browserSettings: {
          viewport: {
            width: viewportWidth,
            height: viewportHeight,
          },
          deviceScaleFactor,
        },
      });
      console.log(`Using deviceScaleFactor: ${deviceScaleFactor}`);
      console.log("Browserbase session created:", this.session.id);

      // Connect to the remote browser via CDP
      await this.connectToBrowser();

      return this.session;
    } catch (error) {
      console.error("Failed to initialize session:", error);
      this.notifyError(error as Error);
      throw error;
    }
  }

  private async connectToBrowser(): Promise<void> {
    if (!this.session) {
      throw new Error("No session available");
    }

    if (this.isConnecting) {
      console.log("Already connecting, skipping...");
      return;
    }

    this.isConnecting = true;

    try {
      // Connect to the remote browser using Playwright with timeout
      console.log("Connecting to remote browser via CDP...");
      this.browser = await chromium.connectOverCDP(this.session.connectUrl, {
        timeout: 30000,
      });
      console.log("Connected to remote browser via CDP");

      // Get the default context
      const contexts = this.browser.contexts();
      this.context = contexts[0] || await this.browser.newContext();

      // Get all pages (tabs)
      const pages = this.context.pages();
      if (pages.length === 0) {
        await this.context.newPage();
      }

      // Set up CDP session for advanced control
      const page = this.context.pages()[0];
      try {
        this.cdpSession = await page.context().newCDPSession(page);
      } catch (cdpError) {
        console.warn("Could not create CDP session:", cdpError);
        // Continue without CDP session - basic functionality still works
      }

      // Set up event listeners
      await this.setupEventListeners(this.context);

      // Initial tab sync
      await this.syncTabs();

      // Navigate to default URL
      const defaultUrl = process.env.BROWSERBASE_DEFAULT_URL || "https://www.google.com";
      await this.navigateTo(defaultUrl);

      // Apply viewport override via CDP to match actual window size
      console.log(`[Viewport] Applying initial viewport: ${this.currentViewportWidth}x${this.currentViewportHeight}`);
      await this.applyViewportToAllPages();

    } catch (error) {
      console.error("Failed to connect to browser:", error);
      throw error;
    } finally {
      this.isConnecting = false;
    }
  }

  private async setupEventListeners(context: any): Promise<void> {
    // Helper to setup page listeners
    const setupPageListeners = (page: Page) => {
      page.on("close", async () => {
        console.log("Page closed");
        await this.syncTabs();
      });

      // Listen for URL changes
      page.on("framenavigated", async (frame: any) => {
        if (frame === page.mainFrame()) {
          await this.syncTabs();
          this.notifyUrlChanged(page.url());
        }
      });

      // Listen for page load complete (this is when title is usually available)
      page.on("load", async () => {
        console.log("Page loaded");
        await this.syncTabs();
      });

      // Listen for DOM content loaded
      page.on("domcontentloaded", async () => {
        console.log("DOM content loaded");
        await this.syncTabs();
      });
    };

    // Listen for new pages (tabs)
    context.on("page", async (page: Page) => {
      console.log("New page created");
      setupPageListeners(page);
      await this.syncTabs();
    });

    // Setup listeners for existing pages
    context.pages().forEach((page: Page) => {
      setupPageListeners(page);
    });

    // Listen for browser disconnect
    this.browser?.on("disconnected", () => {
      console.log("Browser disconnected");
      this.handleDisconnect();
    });
  }

  private async syncTabs(): Promise<void> {
    if (!this.browser || !this.context) return;

    try {
      const pages = this.context.pages();

      // Ensure activeTabIndex is valid
      if (this.activeTabIndex >= pages.length) {
        this.activeTabIndex = Math.max(0, pages.length - 1);
      }

      this.tabs = await Promise.all(
        pages.map(async (page, index) => {
          let title = "";
          let url = "";

          try {
            title = await page.title();
            url = page.url();
          } catch {
            // Page might be loading
          }

          return {
            id: `tab-${index}`,
            targetId: `target-${index}`,
            title: title || "New Tab",
            url: url || "about:blank",
            active: index === this.activeTabIndex,
            favicon: this.getFaviconUrl(url),
          };
        })
      );

      // Update current URL from active tab
      if (pages[this.activeTabIndex]) {
        try {
          this.currentUrl = pages[this.activeTabIndex].url();
        } catch {
          // Page might be loading
        }
      }

      this.notifyTabsUpdated();
    } catch (error) {
      console.error("Failed to sync tabs:", error);
    }
  }

  private getFaviconUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
    } catch {
      return "";
    }
  }

  private getActivePage(): Page | null {
    if (!this.context) return null;
    const pages = this.context.pages();
    return pages[this.activeTabIndex] || pages[0] || null;
  }

  async navigateTo(url: string): Promise<void> {
    if (!this.browser || !this.context) {
      throw new Error("Browser not connected");
    }

    try {
      // Ensure URL has protocol
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        // Check if it looks like a URL or a search query
        if (url.includes(".") && !url.includes(" ")) {
          url = `https://${url}`;
        } else {
          url = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
        }
      }

      const activePage = this.getActivePage();
      if (activePage) {
        await activePage.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        this.currentUrl = url;
        await this.syncTabs();
      }
    } catch (error) {
      console.error("Navigation failed:", error);
      throw error;
    }
  }

  async goBack(): Promise<void> {
    const activePage = this.getActivePage();
    if (!activePage) return;

    try {
      await activePage.goBack();
      await this.syncTabs();
    } catch (error) {
      console.error("Go back failed:", error);
    }
  }

  async goForward(): Promise<void> {
    const activePage = this.getActivePage();
    if (!activePage) return;

    try {
      await activePage.goForward();
      await this.syncTabs();
    } catch (error) {
      console.error("Go forward failed:", error);
    }
  }

  async reload(): Promise<void> {
    const activePage = this.getActivePage();
    if (!activePage) return;

    try {
      await activePage.reload();
      await this.syncTabs();
    } catch (error) {
      console.error("Reload failed:", error);
    }
  }

  async newTab(): Promise<void> {
    if (!this.context) return;

    try {
      const newPage = await this.context.newPage();
      const pages = this.context.pages();
      this.activeTabIndex = pages.indexOf(newPage);

      // Apply viewport to the new tab
      console.log(`[Viewport] Applying viewport to new tab: ${this.currentViewportWidth}x${this.currentViewportHeight}`);
      await this.applyViewportToPage(newPage, this.currentViewportWidth, this.currentViewportHeight);

      // Navigate to Google like the initial tab
      const defaultUrl = process.env.BROWSERBASE_DEFAULT_URL || "https://www.google.com";
      await newPage.goto(defaultUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      await this.syncTabs();

      // Wait a moment for the page to register, then get the updated debug URL
      if (this.session) {
        const sessionId = this.session.id;
        setTimeout(async () => {
          try {
            const pageUrl = newPage.url();
            const newDebugUrl = await this.browserbaseClient.getDebugUrlForPage(sessionId, pageUrl);
            if (newDebugUrl) {
              this.notifyDebugUrlChanged(newDebugUrl);
            }
          } catch (e) {
            console.error("Failed to get debug URL for new page:", e);
          }
        }, 500);
      }
    } catch (error) {
      console.error("New tab failed:", error);
    }
  }

  async closeTab(tabId: string): Promise<void> {
    if (!this.context) return;

    try {
      const tabIndex = parseInt(tabId.replace("tab-", ""), 10);
      const pages = this.context.pages();

      if (pages[tabIndex] && pages.length > 1) {
        await pages[tabIndex].close();

        // Adjust active tab if necessary
        if (tabIndex <= this.activeTabIndex) {
          this.activeTabIndex = Math.max(0, this.activeTabIndex - 1);
        }

        await this.syncTabs();

        // Update debug URL for the new active tab
        if (this.session) {
          const sessionId = this.session.id;
          const remainingPages = this.context.pages();
          const activePage = remainingPages[this.activeTabIndex];
          if (activePage) {
            setTimeout(async () => {
              try {
                const pageUrl = activePage.url();
                const newDebugUrl = await this.browserbaseClient.getDebugUrlForPage(sessionId, pageUrl);
                if (newDebugUrl) {
                  this.notifyDebugUrlChanged(newDebugUrl);
                }
              } catch (e) {
                console.error("Failed to get debug URL after close:", e);
              }
            }, 300);
          }
        }
      }
    } catch (error) {
      console.error("Close tab failed:", error);
    }
  }

  async switchTab(tabId: string): Promise<void> {
    if (!this.context) return;

    try {
      const tabIndex = parseInt(tabId.replace("tab-", ""), 10);
      const pages = this.context.pages();

      if (pages[tabIndex]) {
        await pages[tabIndex].bringToFront();
        this.activeTabIndex = tabIndex;

        // Update URL to match new active tab
        try {
          this.currentUrl = pages[tabIndex].url();
          this.notifyUrlChanged(this.currentUrl);
        } catch {
          // Page might be loading
        }

        // Get the updated debug URL for this specific page and notify renderer
        if (this.session && pages[tabIndex]) {
          try {
            const pageUrl = pages[tabIndex].url();
            const newDebugUrl = await this.browserbaseClient.getDebugUrlForPage(this.session.id, pageUrl);
            if (newDebugUrl) {
              this.notifyDebugUrlChanged(newDebugUrl);
            }
          } catch (e) {
            console.error("Failed to get debug URL for page:", e);
          }
        }

        await this.syncTabs();
      }
    } catch (error) {
      console.error("Switch tab failed:", error);
    }
  }

  getTabs(): TabInfo[] {
    return this.tabs;
  }

  getCurrentUrl(): string {
    return this.currentUrl;
  }

  getDebugUrl(): string {
    return this.session?.debugUrl || "";
  }

  getSessionId(): string {
    return this.session?.id || "";
  }

  private handleDisconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

      setTimeout(async () => {
        try {
          await this.connectToBrowser();
          this.reconnectAttempts = 0;
        } catch (error) {
          console.error("Reconnection failed:", error);
          this.handleDisconnect();
        }
      }, 2000);
    } else {
      this.notifyDisconnected();
    }
  }

  private notifyTabsUpdated(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC_CHANNELS.TABS_UPDATED, this.tabs);
    }
  }

  private notifyUrlChanged(url: string): void {
    this.currentUrl = url;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC_CHANNELS.URL_CHANGED, url);
    }
  }

  private notifyError(error: Error): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC_CHANNELS.SESSION_ERROR, error.message);
    }
  }

  private notifyDisconnected(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC_CHANNELS.SESSION_DISCONNECTED);
    }
  }

  private notifyDebugUrlChanged(url: string): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      console.log("Notifying debug URL changed:", url);
      this.mainWindow.webContents.send(IPC_CHANNELS.DEBUG_URL_CHANGED, url);
    }
  }

  async cleanup(): Promise<void> {
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }

      if (this.session) {
        await this.browserbaseClient.stopSession(this.session.id);
        this.session = null;
      }
    } catch (error) {
      console.error("Cleanup failed:", error);
    }
  }
}

export const sessionManager = new SessionManager();

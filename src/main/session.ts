/**
 * @fileoverview Session management for Browserbase remote browser connections.
 *
 * This module provides the SessionManager class which handles the lifecycle of
 * remote browser sessions. It manages Playwright CDP connections, tab synchronization,
 * navigation, viewport updates, and IPC communication with the renderer process.
 *
 * @module main/session
 */

import { safeError } from "./diagnostics";
import { chromium, Browser, CDPSession, Page, BrowserContext } from "playwright-core";
import { BrowserWindow } from "electron";
import { BrowserbaseSession, TabInfo, IPC_CHANNELS, DownloadInfo, ScrollInputEvent } from "../shared/types";
import { BrowserbaseClient, getBrowserbaseClient } from "./browserbase";
import { AutomationSessionInfo } from "./automation";
import { browserMirrorManager } from "./mirror/manager";

/**
 * Manages the lifecycle and state of a Browserbase remote browser session.
 *
 * Responsibilities:
 * - Creating and connecting to Browserbase sessions
 * - Managing browser tabs (create, close, switch)
 * - Handling navigation (goto, back, forward, reload)
 * - Synchronizing tab state with the renderer
 * - Managing viewport dimensions via CDP
 * - Handling disconnection and reconnection
 *
 * @example
 * ```typescript
 * const manager = new SessionManager();
 * manager.setMainWindow(mainWindow);
 * const session = await manager.initialize();
 * await manager.navigateTo('https://example.com');
 * await manager.cleanup();
 * ```
 */
export class SessionManager {
  private browserbaseClient: BrowserbaseClient | null = null;
  private session: BrowserbaseSession | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private mainWindow: BrowserWindow | null = null;
  private tabs: TabInfo[] = [];
  private pageCdpSessions = new WeakMap<Page, Promise<CDPSession>>();
  private targetIds = new WeakMap<Page, string>();
  private activePage: Page | null = null;
  private tabSyncRevision = 0;
  private currentUrl: string = "";
  private activeTabIndex: number = 0;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private initializing: Promise<BrowserbaseSession> | null = null;
  private connecting: Promise<void> | null = null;
  private cleaningUp: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private permanentlyClosed = false;
  private generation = 0;

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  private getBrowserbaseClient(): BrowserbaseClient {
    if (!this.browserbaseClient) {
      this.browserbaseClient = getBrowserbaseClient();
    }
    return this.browserbaseClient;
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
      const cdp = await this.getCdpSessionForPage(page);

      const deviceScaleFactor = process.platform === "darwin" ? 2 : 1;

      console.log(`[Viewport] Applying viewport ${width}x${height} (scale: ${deviceScaleFactor})`);

      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor,
        mobile: false,
      });

      console.log("[Viewport] Viewport applied successfully");
    } catch (error) {
      console.error("[Viewport] Failed to apply viewport:", safeError(error).message);
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
    if (this.permanentlyClosed) throw new Error("Application is shutting down");
    if (this.cleaningUp) await this.cleaningUp;
    if (this.permanentlyClosed) throw new Error("Application is shutting down");
    if (this.initializing) return this.initializing;
    if (this.session) {
      if (!this.browser?.isConnected()) await this.connectToBrowser();
      return this.session;
    }

    this.shuttingDown = false;
    const generation = this.generation;
    const initializing = this.initializeSession(generation);
    this.initializing = initializing;
    try {
      return await initializing;
    } finally {
      if (this.initializing === initializing) this.initializing = null;
    }
  }

  private async initializeSession(generation: number): Promise<BrowserbaseSession> {
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

      // Create a Browserbase session with viewport matching our window.
      // BrowserbaseClient waits until the remote browser is RUNNING before
      // returning connection URLs when async/deferred scheduling is enabled.
      const deviceScaleFactor = process.platform === 'darwin' ? 2 : 1;

      const session = await this.getBrowserbaseClient().createSession({
        keepAlive: true,
        browserSettings: {
          viewport: {
            width: viewportWidth,
            height: viewportHeight,
          },
          deviceScaleFactor,
        },
      });
      if (this.shuttingDown || generation !== this.generation) {
        await this.getBrowserbaseClient().stopSession(session.id);
        throw new Error("Session startup cancelled");
      }
      this.session = session;
      console.log(`Using deviceScaleFactor: ${deviceScaleFactor}`);
      console.log("Browserbase session created:", this.session.id);

      // Connect to the remote browser via CDP
      await this.connectToBrowser();
      if (this.shuttingDown || generation !== this.generation) {
        throw new Error("Session startup cancelled");
      }

      // A failed start page should not discard an otherwise usable browser.
      const defaultUrl = process.env.BROWSERBASE_DEFAULT_URL || "https://www.google.com";
      try {
        await this.navigateTo(defaultUrl);
      } catch (error) {
        console.warn("Could not load the start page:", safeError(error).message);
      }
      if (this.shuttingDown || generation !== this.generation) {
        throw new Error("Session startup cancelled");
      }
      return session;
    } catch (error) {
      await this.releaseResources();
      console.error("Failed to initialize session:", safeError(error).message);
      if (!this.shuttingDown) this.notifyError(safeError(error));
      throw safeError(error);
    }
  }

  private async connectToBrowser(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (!this.session || this.shuttingDown) throw new Error("No session available");

    const connecting = this.openBrowserConnection(this.session, this.generation);
    this.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = null;
    }
  }

  private async openBrowserConnection(session: BrowserbaseSession, generation: number): Promise<void> {
    console.log("Connecting to remote browser via CDP...");
    const browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 30000 });
    if (this.shuttingDown || generation !== this.generation || this.session !== session) {
      await browser.close();
      throw new Error("Browser connection cancelled");
    }

    this.browser = browser;
    this.pageCdpSessions = new WeakMap();
    try {
      this.context = browser.contexts()[0] || await browser.newContext();
      if (this.context.pages().length === 0) await this.context.newPage();
      await this.setupEventListeners(this.context);
      await this.syncTabs();
      await this.applyViewportToAllPages();
      if (this.shuttingDown || generation !== this.generation || this.session !== session) {
        throw new Error("Browser connection cancelled");
      }
      // Attach before initial navigation so the mirror captures the full browsing flow.
      await browserMirrorManager.attachSession(session);
      console.log("Connected to remote browser via CDP");
    } catch (error) {
      if (this.browser === browser) {
        this.browser = null;
        this.context = null;
      }
      await browser.close().catch(() => {});
      throw safeError(error);
    }
  }

  private async setupEventListeners(context: BrowserContext): Promise<void> {
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
          if (page === this.getActivePage()) this.notifyUrlChanged(page.url());
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
    const browser = this.browser;
    browser?.on("disconnected", () => {
      if (this.shuttingDown || this.browser !== browser) return;
      console.log("Browser disconnected");
      this.browser = null;
      this.context = null;
      this.pageCdpSessions = new WeakMap();
      this.handleDisconnect();
    });
  }

  private async syncTabs(): Promise<void> {
    if (!this.browser || !this.context) return;
    const revision = ++this.tabSyncRevision;

    try {
      const pages = this.context.pages();
      if (!this.activePage || !pages.includes(this.activePage)) this.activePage = pages[Math.min(this.activeTabIndex, pages.length - 1)] || null;
      this.activeTabIndex = Math.max(0, pages.indexOf(this.activePage!));

      // Ensure activeTabIndex is valid
      if (this.activeTabIndex >= pages.length) {
        this.activeTabIndex = Math.max(0, pages.length - 1);
      }

      const tabs = await Promise.all(
        pages.map(async (page, index) => {
          let title = "";
          let url = "";

          try {
            title = await page.title();
            url = page.url();
          } catch {
            // Page might be loading
          }

          const targetId = await this.getTargetIdForPage(page);
          if (!targetId) return null;
          return {
            id: targetId,
            targetId,
            title: title || "New Tab",
            url: url || "about:blank",
            active: index === this.activeTabIndex,
            favicon: this.getFaviconUrl(url),
          };
        })
      );
      if (revision !== this.tabSyncRevision || this.shuttingDown) return;
      this.tabs = tabs.filter((tab): tab is NonNullable<typeof tab> => tab !== null);

      // Update current URL from active tab
      if (pages[this.activeTabIndex]) {
        try {
          this.currentUrl = pages[this.activeTabIndex].url();
        } catch {
          // Page might be loading
        }
      }

      this.notifyTabsUpdated();
      browserMirrorManager.syncTabs(this.tabs);
    } catch (error) {
      console.error("Failed to sync tabs:", safeError(error).message);
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
    return this.activePage && pages.includes(this.activePage) ? this.activePage : pages[0] || null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async getTargetIdForPage(page: Page): Promise<string | null> {
    const existing = this.targetIds.get(page);
    if (existing) return existing;
    try {
      const cdp = await this.getCdpSessionForPage(page);
      const targetInfo = await cdp.send("Target.getTargetInfo") as { targetInfo?: { targetId?: string } };
      const id = targetInfo.targetInfo?.targetId;
      if (id) this.targetIds.set(page, id);
      return id || null;
    } catch (error) {
      console.warn("Failed to read page target ID:", safeError(error).message);
      return null;
    }
  }

  private async getCdpSessionForPage(page: Page): Promise<CDPSession> {
    let cdp = this.pageCdpSessions.get(page);
    if (!cdp) {
      cdp = page.context().newCDPSession(page);
      this.pageCdpSessions.set(page, cdp);
      cdp.catch(() => {
        if (this.pageCdpSessions.get(page) === cdp) this.pageCdpSessions.delete(page);
      });
    }
    return cdp;
  }

  private getCdpModifierMask(modifiers: ScrollInputEvent["modifiers"]): number {
    let mask = 0;
    if (modifiers.alt) mask |= 1;
    if (modifiers.ctrl) mask |= 2;
    if (modifiers.meta) mask |= 4;
    if (modifiers.shift) mask |= 8;
    return mask;
  }

  private async waitForDebugUrlForPage(
    page: Page,
    timeoutMs: number = 5000,
    pollIntervalMs: number = 150
  ): Promise<string | null> {
    if (!this.session) {
      return null;
    }

    const sessionId = this.session.id;
    const targetId = await this.getTargetIdForPage(page);
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
      let debugUrl: string | null = null;

      if (targetId) {
        debugUrl = await this.getBrowserbaseClient().getDebugUrlForTarget(sessionId, targetId);
      }

      if (!debugUrl && (!targetId || page.url() !== "about:blank")) {
        debugUrl = await this.getBrowserbaseClient().getDebugUrlForPage(sessionId, page.url(), {
          fallbackToPrimary: false,
        });
      }

      if (debugUrl) {
        return debugUrl;
      }

      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        break;
      }

      await this.sleep(Math.min(pollIntervalMs, remainingMs));
    }

    return null;
  }

  async navigateTo(url: string): Promise<void> {
    if (!this.browser || !this.context) {
      throw new Error("Browser not connected");
    }

    try {
      // Ensure URL has protocol
      if (!/^(https?:|file:|about:)/i.test(url)) {
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
      console.error("Navigation failed:", safeError(error).message);
      if (url.startsWith("file:") && (error as Error).message.includes("ERR_BLOCKED_BY_ADMINISTRATOR")) {
        throw new Error("This remote browser blocks file:// navigation. Uploaded files remain available to file inputs.");
      }
      throw safeError(error);
    }
  }

  async goBack(): Promise<void> {
    const activePage = this.getActivePage();
    if (!activePage) return;

    try {
      await activePage.goBack();
      await this.syncTabs();
    } catch (error) {
      console.error("Go back failed:", safeError(error).message);
    }
  }

  async goForward(): Promise<void> {
    const activePage = this.getActivePage();
    if (!activePage) return;

    try {
      await activePage.goForward();
      await this.syncTabs();
    } catch (error) {
      console.error("Go forward failed:", safeError(error).message);
    }
  }

  async reload(): Promise<void> {
    const activePage = this.getActivePage();
    if (!activePage) return;

    try {
      await activePage.reload();
      await this.syncTabs();
    } catch (error) {
      console.error("Reload failed:", safeError(error).message);
    }
  }

  async dispatchScroll(scrollEvent: ScrollInputEvent): Promise<void> {
    const activePage = this.getActivePage();
    if (!activePage) return;

    try {
      const cdp = await this.getCdpSessionForPage(activePage);
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.max(0, Math.round(scrollEvent.x)),
        y: Math.max(0, Math.round(scrollEvent.y)),
        deltaX: scrollEvent.deltaX,
        deltaY: scrollEvent.deltaY,
        modifiers: this.getCdpModifierMask(scrollEvent.modifiers),
      });
    } catch (error) {
      console.error("Scroll dispatch failed:", safeError(error).message);
    }
  }

  async newTab(): Promise<void> {
    if (!this.context) return;

    try {
      const newPage = await this.context.newPage();
      this.activePage = newPage;
      const pages = this.context.pages();
      this.activeTabIndex = pages.indexOf(newPage);

      // Apply viewport to the new tab
      console.log(`[Viewport] Applying viewport to new tab: ${this.currentViewportWidth}x${this.currentViewportHeight}`);
      await this.applyViewportToPage(newPage, this.currentViewportWidth, this.currentViewportHeight);

      this.notifyDebugUrlLoading();
      await this.syncTabs();

      let newDebugUrl = await this.waitForDebugUrlForPage(newPage, 3000);
      if (newDebugUrl) {
        this.notifyDebugUrlChanged(newDebugUrl);
      } else {
        console.warn("Timed out waiting for debug URL for new page before navigation");
      }

      // Navigate to Google like the initial tab
      const defaultUrl = process.env.BROWSERBASE_DEFAULT_URL || "https://www.google.com";
      await newPage.goto(defaultUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      await this.syncTabs();

      if (!newDebugUrl) {
        newDebugUrl = await this.waitForDebugUrlForPage(newPage, 3000);
        if (newDebugUrl) {
          this.notifyDebugUrlChanged(newDebugUrl);
        } else {
          console.warn("Timed out waiting for debug URL for new page after navigation");
        }
      }
    } catch (error) {
      console.error("New tab failed:", safeError(error).message);
    }
  }

  async closeTab(tabId: string): Promise<void> {
    if (!this.context) return;

    try {
      const pages = this.context.pages();
      const tabIndex = pages.findIndex(page => this.targetIds.get(page) === tabId);

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
                const newDebugUrl = await this.waitForDebugUrlForPage(activePage);
                if (newDebugUrl) {
                  this.notifyDebugUrlChanged(newDebugUrl);
                }
              } catch (e) {
                console.error("Failed to get debug URL after close:", safeError(e).message);
              }
            }, 300);
          }
        }
      }
    } catch (error) {
      console.error("Close tab failed:", safeError(error).message);
    }
  }

  async switchTab(tabId: string): Promise<void> {
    if (!this.context) return;

    try {
      const pages = this.context.pages();
      const tabIndex = pages.findIndex(page => this.targetIds.get(page) === tabId);

      if (pages[tabIndex]) {
        await pages[tabIndex].bringToFront();
        this.activePage = pages[tabIndex];
        this.activeTabIndex = tabIndex;
        this.notifyDebugUrlLoading();

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
            const newDebugUrl = await this.waitForDebugUrlForPage(pages[tabIndex]);
            if (newDebugUrl) {
              this.notifyDebugUrlChanged(newDebugUrl);
            }
          } catch (e) {
            console.error("Failed to get debug URL for page:", safeError(e).message);
          }
        }

        await this.syncTabs();
      }
    } catch (error) {
      console.error("Switch tab failed:", safeError(error).message);
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

  getAutomationInfo(): AutomationSessionInfo | null {
    if (!this.session) {
      return null;
    }

    return {
      sessionId: this.session.id,
      status: this.session.status,
      connectUrl: this.session.connectUrl,
      debugUrl: this.session.debugUrl,
      currentUrl: this.currentUrl,
      tabs: this.tabs,
      mirror: browserMirrorManager.getStatus(),
    };
  }

  private handleDisconnect(): void {
    if (this.shuttingDown || !this.session || this.reconnectTimer) return;
    void browserMirrorManager.disconnect();
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.notifyDisconnected();
      return;
    }

    this.reconnectAttempts++;
    const generation = this.generation;
    console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.shuttingDown || generation !== this.generation) return;
      try {
        await this.connectToBrowser();
        this.reconnectAttempts = 0;
      } catch (error) {
        console.error("Reconnection failed:", safeError(error).message);
        this.handleDisconnect();
      }
    }, 2000);
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
      this.mainWindow.webContents.send(IPC_CHANNELS.DEBUG_URL_CHANGED, url);
    }
  }

  private notifyDebugUrlLoading(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC_CHANNELS.DEBUG_URL_LOADING);
    }
  }

  async shutdown(): Promise<void> {
    this.permanentlyClosed = true;
    await this.cleanup();
  }

  async cleanup(): Promise<void> {
    if (this.cleaningUp) return this.cleaningUp;
    this.shuttingDown = true;
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    const cleanup = (async () => {
      // Close an existing connection now, interrupting any pending navigation.
      const releasing = this.releaseResources();
      // A create/connect already in flight must settle so late resources are released too.
      await this.initializing?.catch(() => {});
      await this.connecting?.catch(() => {});
      await releasing;
      await this.releaseResources();
    })();
    this.cleaningUp = cleanup;
    try {
      await cleanup;
    } finally {
      if (this.cleaningUp === cleanup) this.cleaningUp = null;
    }
  }

  private async releaseResources(): Promise<void> {
    const browser = this.browser;
    const session = this.session;
    // Clear ownership before close emits 'disconnected'.
    this.browser = null;
    this.context = null;
    this.session = null;
    this.tabs = [];
    this.currentUrl = "";
    this.activeTabIndex = 0;
    this.reconnectAttempts = 0;
    this.pageCdpSessions = new WeakMap();
    this.targetIds = new WeakMap();
    this.activePage = null;
    this.tabSyncRevision++;
    // Flush the mirror before releasing its browser, even when the worker fails.
    await browserMirrorManager.endSession().catch(error => {
      console.error("Mirror cleanup failed:", safeError(error).message);
    });

    // Failure to close the transport must not skip the remote release request.
    const results = await Promise.allSettled([
      browser?.close(),
      session ? this.getBrowserbaseClient().stopSession(session.id) : undefined,
    ]);
    for (const result of results) {
      if (result.status === "rejected") console.error("Cleanup failed:", safeError(result.reason).message);
    }
  }

}

export const sessionManager = new SessionManager();

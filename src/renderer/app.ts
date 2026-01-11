import { TitleBar } from "./components/TitleBar";
import { TabBar } from "./components/TabBar";
import { NavigationBar } from "./components/NavigationBar";
import { BookmarksBar } from "./components/BookmarksBar";
import { ContentArea } from "./components/ContentArea";
import { DownloadsBar } from "./components/DownloadsBar";

class App {
  private titleBar!: TitleBar;
  private tabBar!: TabBar;
  private navigationBar!: NavigationBar;
  private bookmarksBar!: BookmarksBar;
  private contentArea!: ContentArea;
  private downloadsBar!: DownloadsBar;
  private statusBar!: HTMLElement;
  private statusMessage!: HTMLElement;

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    // Wait for DOM to be ready
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => this.setup());
    } else {
      this.setup();
    }
  }

  private setup(): void {
    // Detect platform and add class to body for platform-specific styling
    this.detectPlatform();

    // Initialize components
    this.titleBar = new TitleBar();
    this.tabBar = new TabBar();
    this.navigationBar = new NavigationBar();
    this.bookmarksBar = new BookmarksBar();
    this.contentArea = new ContentArea();
    this.downloadsBar = new DownloadsBar();

    // Get status bar elements
    this.statusBar = document.getElementById("status-bar") as HTMLElement;
    this.statusMessage = document.getElementById("status-message") as HTMLElement;

    // Setup status bar close button
    const closeStatusBtn = document.getElementById("btn-close-status");
    if (closeStatusBtn) {
      closeStatusBtn.addEventListener("click", () => this.hideStatus());
    }

    // Setup global error handling
    this.setupErrorHandling();

    console.log("Desktop Browserbase initialized");
  }

  private setupErrorHandling(): void {
    // Listen for session errors
    window.electronAPI.onSessionError((error: string) => {
      this.showStatus(error, "error");
    });

    // Listen for disconnection
    window.electronAPI.onSessionDisconnected(() => {
      this.showStatus("Connection lost. Attempting to reconnect...", "error");
    });

    // Global error handler
    window.onerror = (message, source, lineno, colno, error) => {
      console.error("Global error:", message, source, lineno, colno, error);
      return false;
    };

    window.onunhandledrejection = (event) => {
      console.error("Unhandled promise rejection:", event.reason);
    };
  }

  public showStatus(message: string, type: "info" | "error" = "info"): void {
    this.statusMessage.textContent = message;
    this.statusBar.classList.remove("hidden", "error");
    if (type === "error") {
      this.statusBar.classList.add("error");
    }
  }

  public hideStatus(): void {
    this.statusBar.classList.add("hidden");
  }

  // Public getters for components if needed
  public getTabBar(): TabBar {
    return this.tabBar;
  }

  public getNavigationBar(): NavigationBar {
    return this.navigationBar;
  }

  public getBookmarksBar(): BookmarksBar {
    return this.bookmarksBar;
  }

  public getContentArea(): ContentArea {
    return this.contentArea;
  }

  public getDownloadsBar(): DownloadsBar {
    return this.downloadsBar;
  }

  private detectPlatform(): void {
    // Detect platform from user agent
    const userAgent = navigator.userAgent.toLowerCase();
    let platform = "unknown";

    if (userAgent.includes("mac")) {
      platform = "darwin";
    } else if (userAgent.includes("win")) {
      platform = "win32";
    } else if (userAgent.includes("linux")) {
      platform = "linux";
    }

    // Add platform class to body
    document.body.classList.add(`platform-${platform}`);
    console.log(`Platform detected: ${platform}`);
  }
}

// Initialize the app
const app = new App();

// Expose app globally for debugging
(window as any).app = app;

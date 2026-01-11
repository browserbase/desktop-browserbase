export class NavigationBar {
  private backBtn: HTMLButtonElement | null;
  private forwardBtn: HTMLButtonElement | null;
  private reloadBtn: HTMLButtonElement | null;
  private urlInput: HTMLInputElement | null;
  private bookmarkBtn: HTMLButtonElement | null;
  private canGoBack: boolean = false;
  private canGoForward: boolean = false;

  constructor() {
    this.backBtn = document.getElementById("btn-back") as HTMLButtonElement | null;
    this.forwardBtn = document.getElementById("btn-forward") as HTMLButtonElement | null;
    this.reloadBtn = document.getElementById("btn-reload") as HTMLButtonElement | null;
    this.urlInput = document.getElementById("url-input") as HTMLInputElement | null;
    this.bookmarkBtn = document.getElementById("btn-bookmarks") as HTMLButtonElement | null;

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // Navigation buttons
    this.backBtn?.addEventListener("click", () => {
      window.electronAPI.navigateBack();
    });

    this.forwardBtn?.addEventListener("click", () => {
      window.electronAPI.navigateForward();
    });

    this.reloadBtn?.addEventListener("click", () => {
      window.electronAPI.navigateReload();
    });

    // URL input
    this.urlInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const url = this.urlInput?.value.trim();
        if (url) {
          window.electronAPI.navigateTo(url);
          this.urlInput?.blur();
        }
      }
    });

    // Select all on focus
    this.urlInput?.addEventListener("focus", () => {
      setTimeout(() => this.urlInput?.select(), 0);
    });

    // Listen for URL changes
    window.electronAPI.onUrlChanged((url: string) => {
      this.updateUrl(url);
    });
  }

  public updateUrl(url: string): void {
    if (this.urlInput) {
      this.urlInput.value = url;
    }
    this.updateNavigationButtons();
  }

  private updateNavigationButtons(): void {
    // For now, enable both buttons after first navigation
    if (this.backBtn) this.backBtn.disabled = false;
    if (this.forwardBtn) this.forwardBtn.disabled = false;
  }

  public setCanGoBack(canGoBack: boolean): void {
    this.canGoBack = canGoBack;
    if (this.backBtn) this.backBtn.disabled = !canGoBack;
  }

  public setCanGoForward(canGoForward: boolean): void {
    this.canGoForward = canGoForward;
    if (this.forwardBtn) this.forwardBtn.disabled = !canGoForward;
  }

  public focusUrlBar(): void {
    this.urlInput?.focus();
    this.urlInput?.select();
  }

  public getUrl(): string {
    return this.urlInput?.value || "";
  }
}

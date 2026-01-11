export class NavigationBar {
  private backBtn: HTMLButtonElement | null;
  private forwardBtn: HTMLButtonElement | null;
  private reloadBtn: HTMLButtonElement | null;
  private urlInput: HTMLInputElement | null;
  private bookmarkBtn: HTMLButtonElement | null;
  private menuBtn: HTMLButtonElement | null;
  private dropdownMenu: HTMLElement | null;
  private canGoBack: boolean = false;
  private canGoForward: boolean = false;

  constructor() {
    this.backBtn = document.getElementById("btn-back") as HTMLButtonElement | null;
    this.forwardBtn = document.getElementById("btn-forward") as HTMLButtonElement | null;
    this.reloadBtn = document.getElementById("btn-reload") as HTMLButtonElement | null;
    this.urlInput = document.getElementById("url-input") as HTMLInputElement | null;
    this.bookmarkBtn = document.getElementById("btn-bookmarks") as HTMLButtonElement | null;
    this.menuBtn = document.getElementById("btn-menu") as HTMLButtonElement | null;
    this.dropdownMenu = document.getElementById("dropdown-menu") as HTMLElement | null;

    this.setupEventListeners();
    this.setupDropdownMenu();
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

  private setupDropdownMenu(): void {
    // Toggle dropdown when menu button is clicked
    this.menuBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleDropdown();
    });

    // Close dropdown when clicking outside
    document.addEventListener("click", (e) => {
      if (this.dropdownMenu && !this.dropdownMenu.contains(e.target as Node) && e.target !== this.menuBtn) {
        this.closeDropdown();
      }
    });

    // Handle dropdown menu item clicks
    this.dropdownMenu?.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const item = target.closest(".dropdown-item") as HTMLElement;
      if (!item) return;

      const action = item.dataset.action;
      this.handleMenuAction(action);
      this.closeDropdown();
    });

    // Close on escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.closeDropdown();
      }
    });
  }

  private toggleDropdown(): void {
    if (this.dropdownMenu) {
      this.dropdownMenu.classList.toggle("hidden");
    }
  }

  private closeDropdown(): void {
    if (this.dropdownMenu) {
      this.dropdownMenu.classList.add("hidden");
    }
  }

  private handleMenuAction(action: string | undefined): void {
    if (!action) return;

    switch (action) {
      case "new-tab":
        window.electronAPI.newTab();
        break;
      case "new-window":
        // Not implemented yet - would need to create a new Electron window
        console.log("New window not implemented");
        break;
      case "bookmarks":
        window.electronAPI.toggleBookmarks();
        break;
      case "downloads":
        // Toggle downloads bar
        const downloadsBar = document.getElementById("downloads-bar");
        downloadsBar?.classList.toggle("hidden");
        break;
      case "zoom-in":
        window.electronAPI.zoomIn();
        break;
      case "zoom-out":
        window.electronAPI.zoomOut();
        break;
      case "fullscreen":
        window.electronAPI.toggleFullscreen();
        break;
      case "devtools":
        window.electronAPI.openDevTools();
        break;
      case "quit":
        window.electronAPI.closeWindow();
        break;
      default:
        console.log("Unknown menu action:", action);
    }
  }
}

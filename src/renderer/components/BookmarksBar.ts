export interface Bookmark {
  title: string;
  url: string;
  favicon?: string;
}

export class BookmarksBar {
  private element: HTMLElement | null;
  private container: HTMLElement | null;
  private visible: boolean = false; // Hidden by default
  private bookmarks: Bookmark[] = [
    { title: "Google", url: "https://www.google.com" },
    { title: "GitHub", url: "https://github.com" },
    { title: "Browserbase Docs", url: "https://docs.browserbase.com" },
  ];

  constructor() {
    this.element = document.getElementById("bookmarks-bar");
    this.container = this.element?.querySelector(".bookmarks-container") || null;

    this.setupEventListeners();
    if (this.container) {
      this.render();
    }
  }

  private setupEventListeners(): void {
    // Listen for bookmark toggle events
    window.electronAPI.onBookmarksToggle(() => {
      this.toggle();
    });
  }

  private render(): void {
    if (!this.container) return;

    this.container.innerHTML = this.bookmarks
      .map(
        (bookmark) => `
        <a href="#" class="bookmark-item" data-url="${this.escapeAttr(bookmark.url)}">
          <img src="https://www.google.com/s2/favicons?domain=${this.getDomain(bookmark.url)}&sz=16" alt="" class="bookmark-favicon" onerror="this.style.visibility='hidden'">
          <span>${this.escapeHtml(bookmark.title)}</span>
        </a>
      `
      )
      .join("");

    // Add click handlers
    this.container.querySelectorAll(".bookmark-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        e.preventDefault();
        const url = (item as HTMLElement).getAttribute("data-url");
        if (url) {
          window.electronAPI.navigateTo(url);
        }
      });
    });
  }

  public toggle(): void {
    this.visible = !this.visible;
    if (this.visible) {
      this.element?.classList.remove("hidden");
    } else {
      this.element?.classList.add("hidden");
    }
  }

  public show(): void {
    this.visible = true;
    this.element?.classList.remove("hidden");
  }

  public hide(): void {
    this.visible = false;
    this.element?.classList.add("hidden");
  }

  public isVisible(): boolean {
    return this.visible;
  }

  public addBookmark(bookmark: Bookmark): void {
    this.bookmarks.push(bookmark);
    this.render();
  }

  public removeBookmark(url: string): void {
    this.bookmarks = this.bookmarks.filter((b) => b.url !== url);
    this.render();
  }

  private getDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  private escapeAttr(text: string): string {
    return text.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
}

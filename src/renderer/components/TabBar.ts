import { TabInfo } from "../../shared/types";

export class TabBar {
  private element: HTMLElement;
  private tabsContainer: HTMLElement;
  private newTabBtn: HTMLButtonElement;
  private tabs: TabInfo[] = [];

  constructor() {
    this.element = document.getElementById("tab-bar") as HTMLElement;
    this.tabsContainer = document.getElementById("tabs-container") as HTMLElement;
    this.newTabBtn = document.getElementById("btn-new-tab") as HTMLButtonElement;

    this.setupEventListeners();
    this.renderDefaultTab();
  }

  private setupEventListeners(): void {
    this.newTabBtn.addEventListener("click", () => {
      window.electronAPI.newTab();
    });

    // Listen for tab updates from main process
    window.electronAPI.onTabsUpdated((tabs: TabInfo[]) => {
      this.updateTabs(tabs);
    });
  }

  private renderDefaultTab(): void {
    // Render a default "loading" tab
    this.tabsContainer.innerHTML = `
      <div class="tab active" data-tab-id="loading">
        <img class="tab-favicon" src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" alt="">
        <span class="tab-title">New Tab</span>
      </div>
    `;
  }

  public updateTabs(tabs: TabInfo[]): void {
    this.tabs = tabs;
    this.render();
  }

  private render(): void {
    this.tabsContainer.innerHTML = this.tabs
      .map(
        (tab) => `
        <div class="tab ${tab.active ? "active" : ""}" data-tab-id="${tab.id}">
          <img class="tab-favicon" src="${tab.favicon || "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>"}" alt="" onerror="this.style.visibility='hidden'">
          <span class="tab-title">${this.escapeHtml(tab.title || "New Tab")}</span>
          <button class="tab-close" data-close-tab="${tab.id}" title="Close tab">
            <svg width="8" height="8" viewBox="0 0 8 8">
              <line x1="0" y1="0" x2="8" y2="8" stroke="currentColor" stroke-width="1.5"/>
              <line x1="8" y1="0" x2="0" y2="8" stroke="currentColor" stroke-width="1.5"/>
            </svg>
          </button>
        </div>
      `
      )
      .join("");

    // Add click handlers for tabs
    this.tabsContainer.querySelectorAll(".tab").forEach((tabEl) => {
      const tabId = tabEl.getAttribute("data-tab-id");
      if (!tabId) return;

      // Tab click - switch to tab
      tabEl.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        // Don't switch if clicking close button
        if (target.closest(".tab-close")) return;
        window.electronAPI.switchTab(tabId);
      });
    });

    // Add click handlers for close buttons
    this.tabsContainer.querySelectorAll(".tab-close").forEach((closeBtn) => {
      const tabId = closeBtn.getAttribute("data-close-tab");
      if (!tabId) return;

      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        window.electronAPI.closeTab(tabId);
      });
    });
  }

  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  public getTabs(): TabInfo[] {
    return this.tabs;
  }

  public getActiveTab(): TabInfo | undefined {
    return this.tabs.find((tab) => tab.active);
  }
}

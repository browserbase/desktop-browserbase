export class TitleBar {
  private minimizeBtn: HTMLButtonElement | null;
  private maximizeBtn: HTMLButtonElement | null;
  private closeBtn: HTMLButtonElement | null;

  constructor() {
    // Window controls are now part of the tab bar in Chrome-style UI
    this.minimizeBtn = document.getElementById("btn-minimize") as HTMLButtonElement | null;
    this.maximizeBtn = document.getElementById("btn-maximize") as HTMLButtonElement | null;
    this.closeBtn = document.getElementById("btn-close") as HTMLButtonElement | null;

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    if (this.minimizeBtn) {
      this.minimizeBtn.addEventListener("click", () => {
        window.electronAPI.minimizeWindow();
      });
    }

    if (this.maximizeBtn) {
      this.maximizeBtn.addEventListener("click", () => {
        window.electronAPI.maximizeWindow();
      });
    }

    if (this.closeBtn) {
      this.closeBtn.addEventListener("click", () => {
        window.electronAPI.closeWindow();
      });
    }
  }
}

import { DownloadInfo } from "../../shared/types";

export class DownloadsBar {
  private element: HTMLElement;
  private container: HTMLElement;
  private closeBtn: HTMLButtonElement;
  private downloads: Map<string, DownloadInfo> = new Map();
  private autoHideTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.element = document.getElementById("downloads-bar") as HTMLElement;
    this.container = document.getElementById("downloads-container") as HTMLElement;
    this.closeBtn = document.getElementById("btn-close-downloads") as HTMLButtonElement;

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // Close button
    this.closeBtn.addEventListener("click", () => {
      this.hide();
    });

    // Listen for download events
    window.electronAPI.onDownloadStarted((download: DownloadInfo) => {
      this.addDownload(download);
    });

    window.electronAPI.onDownloadProgress((download: DownloadInfo) => {
      this.updateDownload(download);
    });

    window.electronAPI.onDownloadCompleted((download: DownloadInfo) => {
      this.completeDownload(download);
    });
  }

  public addDownload(download: DownloadInfo): void {
    this.downloads.set(download.id, download);
    this.show();
    this.render();

    // Cancel auto-hide when new download starts
    if (this.autoHideTimeout) {
      clearTimeout(this.autoHideTimeout);
      this.autoHideTimeout = null;
    }
  }

  public updateDownload(download: DownloadInfo): void {
    this.downloads.set(download.id, download);
    this.render();
  }

  public completeDownload(download: DownloadInfo): void {
    this.downloads.set(download.id, { ...download, state: "completed" });
    this.render();

    // Check if all downloads are complete
    const allComplete = Array.from(this.downloads.values()).every(
      (d) => d.state === "completed" || d.state === "cancelled"
    );

    if (allComplete) {
      // Auto-hide after 5 seconds when all downloads are complete
      this.autoHideTimeout = setTimeout(() => {
        this.hide();
      }, 5000);
    }
  }

  public removeDownload(id: string): void {
    this.downloads.delete(id);
    if (this.downloads.size === 0) {
      this.hide();
    } else {
      this.render();
    }
  }

  private render(): void {
    this.container.innerHTML = Array.from(this.downloads.values())
      .map((download) => this.renderDownloadItem(download))
      .join("");

    // Add click handlers for close buttons
    this.container.querySelectorAll(".download-close").forEach((btn) => {
      const id = btn.getAttribute("data-download-id");
      if (id) {
        btn.addEventListener("click", () => this.removeDownload(id));
      }
    });
  }

  private renderDownloadItem(download: DownloadInfo): string {
    const progress = download.totalBytes > 0
      ? Math.round((download.receivedBytes / download.totalBytes) * 100)
      : 0;

    const statusText = this.getStatusText(download);
    const icon = this.getIcon(download);

    return `
      <div class="download-item" data-download-id="${download.id}">
        <div class="download-icon">${icon}</div>
        <div class="download-info">
          <div class="download-filename">${this.escapeHtml(download.filename)}</div>
          <div class="download-status">${statusText}</div>
          ${download.state === "in_progress" ? `
            <div class="download-progress">
              <div class="download-progress-bar" style="width: ${progress}%"></div>
            </div>
          ` : ""}
        </div>
        <button class="download-close" data-download-id="${download.id}" title="Remove">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" stroke-width="1.5"/>
            <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" stroke-width="1.5"/>
          </svg>
        </button>
      </div>
    `;
  }

  private getStatusText(download: DownloadInfo): string {
    switch (download.state) {
      case "in_progress":
        const progress = download.totalBytes > 0
          ? Math.round((download.receivedBytes / download.totalBytes) * 100)
          : 0;
        const received = this.formatBytes(download.receivedBytes);
        const total = this.formatBytes(download.totalBytes);
        return `${received} of ${total} (${progress}%)`;
      case "completed":
        return "Completed";
      case "cancelled":
        return "Cancelled";
      case "interrupted":
        return "Interrupted";
      default:
        return "";
    }
  }

  private getIcon(download: DownloadInfo): string {
    if (download.state === "completed") {
      return `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="#188038" stroke-width="2"/>
          <path d="M8 12L11 15L16 9" stroke="#188038" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
    }
    return `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path d="M12 3V15M12 15L7 10M12 15L17 10" stroke="#1A73E8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M3 21H21" stroke="#1A73E8" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `;
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  public show(): void {
    this.element.classList.remove("hidden");
  }

  public hide(): void {
    this.element.classList.add("hidden");
    this.downloads.clear();
    if (this.autoHideTimeout) {
      clearTimeout(this.autoHideTimeout);
      this.autoHideTimeout = null;
    }
  }

  public isVisible(): boolean {
    return !this.element.classList.contains("hidden");
  }

  private escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}

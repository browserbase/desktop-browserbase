import { MirrorStatus } from "../../shared/types";

export class BrowserMirror {
  private status: MirrorStatus | null = null;
  private busy = false;
  private toggle = document.getElementById("mirror-enabled") as HTMLInputElement;
  private indicator = document.getElementById("mirror-status")!;
  private message = document.getElementById("mirror-message")!;
  private actions = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-mirror-action]"));

  constructor() {
    window.electronAPI.onMirrorStatus(status => this.update(status));
    void window.electronAPI.getMirrorStatus().then(status => this.update(status));
    this.toggle.addEventListener("change", () => {
      void this.run(() => this.status?.directory ? window.electronAPI.setMirrorEnabled(this.toggle.checked) : window.electronAPI.chooseMirrorFolder());
    });
    for (const button of this.actions) button.addEventListener("click", () => {
      const action = button.dataset.mirrorAction;
      void this.run(() => action === "choose" ? window.electronAPI.chooseMirrorFolder() : window.electronAPI.openMirrorFolder(action === "active"));
    });
  }

  private async run(action: () => Promise<{ success: boolean; error?: string; status?: MirrorStatus }>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.render();
    try {
      const result = await action();
      if (result.status) this.update(result.status);
      if (!result.success) this.message.textContent = result.error || "Folder sync failed";
    } catch (error) { this.message.textContent = (error as Error).message; }
    finally { this.busy = false; this.render(); }
  }

  private update(status: MirrorStatus): void {
    this.status = status;
    this.message.textContent = status.error || status.directory || "";
    this.render();
  }

  private render(): void {
    const status = this.status;
    if (!status) return;
    this.toggle.checked = status.enabled;
    this.toggle.disabled = this.busy;
    const labels = { disabled: "Sync off", waiting: "Waiting for session", connecting: "Connecting sync", syncing: "Syncing", reconnecting: "Reconnecting sync", error: "Sync error" };
    this.indicator.textContent = labels[status.state];
    this.indicator.dataset.state = status.state;
    this.indicator.title = status.error || status.directory || "Browser folder sync";
    for (const button of this.actions) {
      const action = button.dataset.mirrorAction;
      button.disabled = this.busy || (action !== "choose" && (!status.directory || (action === "active" && !status.activePageId)));
    }
  }
}

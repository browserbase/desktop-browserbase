import { app, shell, utilityProcess, UtilityProcess } from "electron";
import { EventEmitter } from "events";
import { promises as fs } from "fs";
import * as path from "path";
import { BrowserbaseSession, DownloadInfo, MirrorSettings, MirrorStatus, TabInfo } from "../../shared/types";
import { atomicWrite, readJson, safeId } from "./files";

export class BrowserMirrorManager extends EventEmitter {
  private settings: MirrorSettings = { enabled: false, parentDirectory: null };
  private status: MirrorStatus = { enabled: false, state: "disabled", directory: null, frames: 0, pendingFrames: 0 };
  private session?: BrowserbaseSession;
  private worker?: UtilityProcess;
  private tabs: TabInfo[] = [];
  private downloads = new Map<string, DownloadInfo>();
  private operations: Promise<unknown> = Promise.resolve();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private connected = false;
  private initialized = false;
  private resumeSessionId?: string;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const saved = await readJson<MirrorSettings>(this.settingsPath());
      if (saved && typeof saved.enabled === "boolean" && (!saved.parentDirectory || path.isAbsolute(saved.parentDirectory))) this.settings = saved;
    } catch { /* Invalid saved settings leave mirroring disabled. */ }
    this.publish({ enabled: this.settings.enabled, directory: this.directory(), state: this.settings.enabled ? "waiting" : "disabled" });
  }

  private settingsPath() { return path.join(app.getPath("userData"), "browser-mirror-settings.json"); }
  private directory() { return this.settings.parentDirectory ? path.join(this.settings.parentDirectory, "browser") : null; }
  getStatus(): MirrorStatus { return { ...this.status }; }
  private publish(update: Partial<MirrorStatus>) {
    this.status = { ...this.status, ...update };
    this.emit("status", this.getStatus());
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.catch(() => {}).then(operation);
    this.operations = next;
    return next;
  }

  async setFolder(parentDirectory: string): Promise<MirrorStatus> {
    return this.serialize(async () => {
      await this.stopWorker();
      this.settings = { enabled: true, parentDirectory: path.resolve(parentDirectory) };
      this.resumeSessionId = undefined;
      await this.saveSettings();
      await this.startWorker(true);
      return this.getStatus();
    });
  }

  async setEnabled(enabled: boolean): Promise<MirrorStatus> {
    return this.serialize(async () => {
      if (enabled && !this.settings.parentDirectory) throw new Error("Choose a sync folder first");
      if (enabled === this.settings.enabled && this.status.state !== "error") return this.getStatus();
      await this.stopWorker();
      this.settings.enabled = enabled;
      await this.saveSettings();
      if (enabled) await this.startWorker(true);
      else this.publish({ state: "disabled", enabled: false, error: undefined });
      return this.getStatus();
    });
  }

  private async saveSettings(): Promise<void> {
    await fs.mkdir(app.getPath("userData"), { recursive: true });
    await atomicWrite(this.settingsPath(), JSON.stringify(this.settings, null, 2));
    this.publish({ enabled: this.settings.enabled, directory: this.directory() });
  }

  attachSession(session: BrowserbaseSession): Promise<void> {
    return this.serialize(async () => {
      const sameSession = this.session?.id === session.id;
      this.session = session; this.connected = true;
      if (!sameSession) { await this.stopWorker(); this.downloads.clear(); this.resumeSessionId = undefined; this.reconnectAttempts = 0; }
      await this.startWorker(false);
    });
  }

  disconnect(): Promise<void> {
    // Set immediately so a queued worker restart cannot outlive the browser connection.
    this.connected = false;
    return this.serialize(async () => {
      await this.stopWorker();
      if (this.settings.enabled) this.publish({ state: "reconnecting" });
    });
  }

  endSession(): Promise<void> {
    this.connected = false;
    return this.serialize(async () => {
      await this.stopWorker(); this.session = undefined; this.tabs = [];
      this.publish({ state: this.settings.enabled ? "waiting" : "disabled", sessionId: undefined, activePageId: undefined, error: undefined });
    });
  }

  syncTabs(tabs: TabInfo[]): void {
    this.tabs = tabs;
    this.publish({ activePageId: tabs.find(tab => tab.active)?.targetId });
    this.worker?.postMessage({ type: "tabs", tabs });
  }

  async openFolder(active = false): Promise<void> {
    const root = this.directory();
    if (!root) throw new Error("Choose a sync folder first");
    const target = active && this.status.activePageId ? path.join(root, safeId(this.status.activePageId)) : root;
    await fs.access(target);
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  }

  async revealDownload(id: string): Promise<void> {
    const file = this.downloads.get(id)?.localPath;
    if (!file) throw new Error("Download is not available locally yet");
    await fs.access(file);
    shell.showItemInFolder(file);
  }

  private async startWorker(fresh: boolean): Promise<void> {
    try { await this.launchWorker(fresh); }
    catch (error) {
      await this.stopWorker();
      this.publish({ state: "error", error: (error as Error).message });
    }
  }

  private async launchWorker(fresh: boolean): Promise<void> {
    if (this.worker) return;
    if (!this.settings.enabled || !this.session || !this.connected || !this.directory()) {
      this.publish({ state: this.settings.enabled ? "waiting" : "disabled" }); return;
    }
    const session = this.session;
    if (session.keepAlive === false) {
      this.publish({ state: "error", error: "Folder sync requires Browserbase keep-alive (a paid plan). Browsing remains available." });
      return;
    }
    const isFresh = fresh || this.resumeSessionId !== session.id;
    if (isFresh) { this.downloads.clear(); this.publish({ frames: 0, pendingFrames: 0, lastFrameAt: undefined }); }
    this.publish({ enabled: true, state: "connecting", sessionId: session.id, directory: this.directory(), error: undefined });
    const worker = utilityProcess.fork(path.join(__dirname, "worker.js"), [], { serviceName: "Browser Folder Sync", stdio: "pipe" });
    this.worker = worker;
    let expectedExit = false;
    const startup = new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        this.publish({ state: "error", error: "Browser folder sync took too long to connect" });
        expectedExit = true; worker.kill(); resolve();
      }, 30_000);
      const settle = () => { clearTimeout(timeout); resolve(); };
      worker.on("message", message => {
        if (this.worker !== worker) return;
        if (message.type === "prepared") {
          this.resumeSessionId = session.id;
        } else if (message.type === "ready") {
          this.resumeSessionId = session.id; this.reconnectAttempts = 0;
          this.publish({ state: "syncing", error: undefined }); settle();
        } else if (message.type === "stats") {
          this.publish(message.stats);
        } else if (message.type === "download") {
          this.downloads.set(message.download.id, message.download);
          this.emit("download", message.download);
        } else if (message.type === "failure") {
          expectedExit = true;
          this.publish({ state: "error", error: message.error }); settle();
        } else if (message.type === "disconnected") {
          this.publish({ state: "reconnecting" });
        }
      });
      worker.once("exit", () => {
        settle();
        if (this.worker !== worker) return;
        this.worker = undefined;
        if (!expectedExit && this.connected && this.settings.enabled) this.scheduleReconnect();
      });
    });
    worker.postMessage({ type: "start", sessionId: session.id, connectUrl: session.connectUrl,
      apiKey: process.env.BROWSERBASE_API_KEY, directory: this.directory(), fresh: isFresh });
    worker.postMessage({ type: "tabs", tabs: this.tabs });
    await startup;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (++this.reconnectAttempts > 3) { this.publish({ state: "error", error: "Folder sync connection lost. Toggle sync to retry." }); return; }
    this.publish({ state: "reconnecting" });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.serialize(() => this.startWorker(false)).catch(error => this.publish({ state: "error", error: error.message }));
    }, 2000);
  }

  private async stopWorker(): Promise<void> {
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { worker.kill(); }, 7000);
      const forceTimeout = setTimeout(() => {
        try { if (worker.pid) process.kill(worker.pid, "SIGKILL"); }
        catch (error) { reject(error); }
      }, 9000);
      worker.once("exit", () => { clearTimeout(timeout); clearTimeout(forceTimeout); resolve(); });
      worker.postMessage({ type: "stop" });
    });
  }
}

export const browserMirrorManager = new BrowserMirrorManager();

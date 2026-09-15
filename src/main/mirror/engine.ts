import { EventEmitter } from "events";
import { promises as fs, watch, FSWatcher } from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { setTimeout as delay } from "timers/promises";
import { DownloadInfo, TabInfo } from "../../shared/types";
import { atomicWrite, FileQueue, readJson, safeId } from "./files";
import { ArchiveFile } from "./transfers";

interface Transport extends EventEmitter {
  send(method: string, params?: any, sessionId?: string): Promise<any>;
  close(): void;
}
interface Transfers {
  downloads(directory: string): Promise<ArchiveFile[]>;
  upload(file: string, filename: string): Promise<{ remotePath: string; fileUrl: string }>;
}
interface Upload {
  filename: string; localPath: string; fingerprint: string;
  state: "uploading" | "uploaded" | "error";
  remotePath?: string; fileUrl?: string; error?: string; updatedAt: string;
}
interface Download extends DownloadInfo { frameId?: string; updatedAt: string; archiveName?: string }
interface PageRecord {
  pageId: string; sessionId?: string; url: string; title: string;
  closed: boolean; dir: string; uploads: Map<string, Upload>;
}
const NETWORK_EVENTS = ["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished",
  "Network.loadingFailed", "Network.webSocketCreated", "Network.webSocketClosed",
  "Network.webSocketFrameReceived", "Network.webSocketFrameSent"];
const CONSOLE_EVENTS = ["Runtime.consoleAPICalled", "Runtime.exceptionThrown"];

export class MirrorEngine extends EventEmitter {
  private pages = new Map<string, PageRecord>();
  private sessions = new Map<string, string>();
  private frames = new Map<string, string>();
  private attaching = new Map<string, Promise<void>>();
  private downloads = new Map<string, Download>();
  private unattributedFiles = new Map<string, ArchiveFile>();
  private queue = new FileQueue();
  private tasks = new Set<Promise<unknown>>();
  private subscriptions: Array<[string, (...args: any[]) => void]> = [];
  private watchers = new Map<string, FSWatcher>();
  private uploadBusy = new Set<string>();
  private sampling = new Set<string>();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private downloadTimer?: ReturnType<typeof setTimeout>;
  private downloadBusy = false;
  private downloadRequested = false;
  private stopPromise?: Promise<void>;
  private stopped = false;
  private activePageId?: string;
  private latestTabs: TabInfo[] = [];
  private frameCount = 0;
  private pendingFrames = 0;
  private lastFrameAt?: string;

  constructor(private readonly client: Transport, private readonly directory: string,
    private readonly browserbaseSessionId: string, private readonly transfers: Transfers,
    private readonly abort: AbortController, private readonly intervalMs = 2000,
    private readonly retryDelayMs = 1000) { super(); }

  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }

  private subscribe(method: string, handler: (params: any, message: any) => Promise<unknown> | void): void {
    const listener = (params: any, message: any) => {
      if (this.stopped) return;
      void this.track(Promise.resolve().then(() => handler(params, message))).catch(error => {
        if (!this.stopped) this.emit("failure", error);
      });
    };
    this.client.on(method, listener);
    this.subscriptions.push([method, listener]);
  }

  async start(): Promise<void> {
    await this.restore();
    this.subscribe("Target.attachedToTarget", params => this.attach(params));
    this.subscribe("Target.detachedFromTarget", params => this.detach(params.sessionId));
    this.subscribe("Target.targetInfoChanged", params => this.updateTarget(params.targetInfo));
    this.subscribe("Page.frameNavigated", (params, message) => {
      const page = this.pageForSession(message.sessionId);
      if (page && params.frame?.id) {
        this.frames.set(params.frame.id, page.pageId);
        if (!params.frame.parentId) { page.url = params.frame.url; return this.metadata(page); }
      }
    });
    this.subscribe("Page.screencastFrame", (params, message) => this.writeFrame(params, message.sessionId));
    for (const method of NETWORK_EVENTS) this.subscribe(method, (params, message) => this.logEvent("network.log", method, params, message));
    for (const method of CONSOLE_EVENTS) this.subscribe(method, (params, message) => this.logEvent("console.log", method, params, message));
    this.subscribe("Browser.downloadWillBegin", params => this.queue.run("download-events", () => this.downloadStarted(params)));
    this.subscribe("Browser.downloadProgress", params => this.queue.run("download-events", () => this.downloadProgress(params)));
    this.subscribe("close", () => { this.emit("disconnected"); });
    this.subscribe("error", () => { this.emit("disconnected"); });
    await this.client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "downloads", eventsEnabled: true });
    await this.client.send("Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: false, filter: [{ type: "page" }] });
    await this.client.send("Target.setDiscoverTargets", { discover: true, filter: [{ type: "page" }] });
    const { targetInfos = [] } = await this.client.send("Target.getTargets", { filter: [{ type: "page" }] });
    for (const targetInfo of targetInfos) {
      if (targetInfo.type !== "page") continue;
      if (this.attaching.has(targetInfo.targetId)) { await this.attaching.get(targetInfo.targetId); continue; }
      if (this.pages.get(targetInfo.targetId)?.sessionId) continue;
      try {
        const { sessionId } = await this.client.send("Target.attachToTarget", { targetId: targetInfo.targetId, flatten: true });
        await this.attach({ sessionId, targetInfo });
      } catch (error) { if (!targetGone(error)) throw error; }
    }
    await Promise.all([...this.attaching.values()]);
    this.timers.push(setInterval(() => {
      for (const page of this.pages.values()) {
        if (!page.sessionId || page.closed) continue;
        void this.track(this.sampleHtml(page)).catch(error => this.emit("failure", error));
        this.scanSoon(page);
      }
      this.emit("stats", this.stats());
    }, this.intervalMs));
    this.scheduleDownloads();
  }

  stats() { return { frames: this.frameCount, pendingFrames: this.pendingFrames, lastFrameAt: this.lastFrameAt }; }

  updateTabs(tabs: TabInfo[]): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.track(this.updateTabState(tabs));
  }

  private async updateTabState(tabs: TabInfo[]): Promise<void> {
    this.latestTabs = tabs;
    this.activePageId = tabs.find(tab => tab.active)?.targetId;
    await Promise.all(tabs.map(async tab => {
      const page = this.pages.get(tab.targetId);
      if (page) { page.url = tab.url; page.title = tab.title; await this.metadata(page); }
    }));
    await this.writeActive();
  }

  private attach(params: any): Promise<void> {
    const { sessionId, targetInfo } = params;
    if (targetInfo?.type !== "page" || !sessionId || this.stopped) return Promise.resolve();
    const id = safeId(targetInfo.targetId);
    const pending = this.attaching.get(id);
    if (pending) return pending;
    if (this.pages.get(id)?.sessionId) return Promise.resolve();
    const task = this.attachPage(id, sessionId, targetInfo).catch(async error => {
      if (!this.stopped && !targetGone(error)) throw error;
      await this.detach(sessionId);
    }).finally(() => this.attaching.delete(id));
    this.attaching.set(id, task);
    return task;
  }

  private async attachPage(id: string, sessionId: string, info: any): Promise<void> {
    const page = await this.ensurePage(id);
    if (this.stopped) return;
    page.sessionId = sessionId; page.closed = false; page.url = info.url; page.title = info.title;
    this.sessions.set(sessionId, id);
    await this.client.send("Page.enable", {}, sessionId);
    await this.client.send("Runtime.enable", {}, sessionId);
    await this.client.send("Network.enable", { maxResourceBufferSize: 100_000, maxTotalBufferSize: 1_000_000 }, sessionId);
    const tree = await this.client.send("Page.getFrameTree", {}, sessionId);
    const recordFrames = (node: any) => {
      if (!node?.frame?.id) return;
      this.frames.set(node.frame.id, id);
      for (const child of node.childFrames || []) recordFrames(child);
    };
    recordFrames(tree.frameTree);
    await this.client.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 }, sessionId);
    this.startWatcher(page);
    await this.sampleHtml(page);
    await this.updateTabs(this.latestTabs);
    await this.metadata(page);
  }

  private async detach(sessionId: string): Promise<void> {
    const page = this.pageForSession(sessionId);
    if (!page) return;
    page.closed = true; page.sessionId = undefined;
    this.sessions.delete(sessionId);
    this.watchers.get(page.pageId)?.close(); this.watchers.delete(page.pageId);
    for (const [frame, id] of this.frames) if (id === page.pageId) this.frames.delete(frame);
    await this.metadata(page);
  }

  private async updateTarget(info: any): Promise<void> {
    const page = this.pages.get(info?.targetId);
    if (!page) return;
    page.url = info.url; page.title = info.title;
    await this.metadata(page);
    if (page.pageId === this.activePageId) await this.writeActive();
  }

  private pageForSession(sessionId: string): PageRecord | undefined { return this.pages.get(this.sessions.get(sessionId) || ""); }

  private async ensurePage(id: string): Promise<PageRecord> {
    const existing = this.pages.get(id);
    if (existing) return existing;
    const dir = path.join(this.directory, safeId(id));
    const page: PageRecord = { pageId: id, dir, title: "", url: "", closed: false, uploads: new Map() };
    this.pages.set(id, page);
    await fs.mkdir(path.join(dir, "uploads"), { recursive: true });
    await fs.mkdir(path.join(dir, "downloads"), { recursive: true });
    for (const name of ["console.log", "network.log", "downloads.log", "uploads.log"]) await fs.appendFile(path.join(dir, name), "");
    return page;
  }

  private async restore(): Promise<void> {
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const old = await readJson<any>(path.join(this.directory, entry.name, "metadata.json"));
      if (!old || old.browserbaseSessionId !== this.browserbaseSessionId) continue;
      const page = await this.ensurePage(entry.name);
      page.url = old.url; page.title = old.title; page.closed = true;
      if (entry.name === "_unattributed") for (const file of old.downloadFiles || []) {
        const hash = createHash("sha256").update(file.name).digest("hex").slice(0, 16);
        this.unattributedFiles.set(file.name, { ...file, path: path.join(page.dir, "downloads", hash, path.basename(file.name)) });
      }
      for (const download of old.downloads || []) {
        // Rebuild paths under the current mirror root on resume.
        const localPath = download.archiveName ? path.join(page.dir, "downloads", safeId(download.id), path.basename(download.filename)) : undefined;
        this.downloads.set(download.id, { ...download, localPath });
        this.emit("download", { ...download, localPath });
      }
      for (const upload of old.uploads || []) page.uploads.set(upload.filename, { ...upload, localPath: path.join(page.dir, "uploads", path.basename(upload.filename)) });
    }
  }

  private metadata(page: PageRecord): Promise<void> {
    const file = path.join(page.dir, "metadata.json");
    return this.queue.run(file, () => atomicWrite(file, JSON.stringify({
      browserbaseSessionId: this.browserbaseSessionId, pageId: page.pageId, targetId: page.pageId,
      sessionId: page.sessionId, title: page.title, url: page.url, closed: page.closed,
      active: page.pageId === this.activePageId, updatedAt: new Date().toISOString(),
      files: { screencast: path.join(page.dir, "screencast.jpg"), pageHtml: path.join(page.dir, "page.html"),
        networkLog: path.join(page.dir, "network.log"), consoleLog: path.join(page.dir, "console.log"),
        downloadsDir: path.join(page.dir, "downloads"), uploadsDir: path.join(page.dir, "uploads") },
      downloads: [...this.downloads.values()].filter(download => download.pageId === page.pageId),
      downloadFiles: page.pageId === "_unattributed" ? [...this.unattributedFiles.values()] : undefined,
      uploads: [...page.uploads.values()],
    }, null, 2)));
  }

  private writeActive(): Promise<void> {
    const file = path.join(this.directory, "active.json");
    return this.queue.run(file, () => {
      const page = this.pages.get(this.activePageId || "");
      return atomicWrite(file, JSON.stringify({ browserbaseSessionId: this.browserbaseSessionId,
        pageId: this.activePageId || null, dir: page?.dir || null, url: page?.url, title: page?.title,
        updatedAt: new Date().toISOString() }, null, 2));
    });
  }

  private async writeFrame(params: any, sessionId: string): Promise<void> {
    const page = this.pageForSession(sessionId);
    this.pendingFrames++;
    try {
      if (page && params.data) {
        const file = path.join(page.dir, "screencast.jpg");
        await this.queue.run(file, () => atomicWrite(file, Buffer.from(params.data, "base64")));
        this.frameCount++; this.lastFrameAt = new Date().toISOString();
      }
    } finally {
      this.pendingFrames--;
      // ACK after the write: Chrome provides backpressure without dropping received frames.
      await this.client.send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId).catch(() => {});
    }
  }

  private async sampleHtml(page: PageRecord): Promise<void> {
    if (!page.sessionId || this.sampling.has(page.pageId) || this.stopped) return;
    this.sampling.add(page.pageId);
    try {
      let response;
      try {
        response = await this.client.send("Runtime.evaluate", {
          expression: "({html: document.documentElement?.outerHTML || '', title: document.title, url: location.href})", returnByValue: true,
        }, page.sessionId);
      } catch { return; } // Execution contexts are replaced during navigation.
      const value = response?.result?.value;
      if (typeof value?.html !== "string" || !value.html || this.stopped) return;
      page.title = value.title; page.url = value.url;
      const file = path.join(page.dir, "page.html");
      await this.queue.run(file, () => atomicWrite(file, value.html));
      await this.metadata(page);
      if (page.pageId === this.activePageId) await this.writeActive();
    } finally { this.sampling.delete(page.pageId); }
  }

  private async logEvent(file: string, method: string, params: any, message: any): Promise<void> {
    const page = this.pageForSession(message.sessionId);
    if (page) await this.log(page, file, { method, sessionId: message.sessionId, params });
  }
  private log(page: PageRecord, name: string, value: any): Promise<void> {
    const file = path.join(page.dir, name);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...value }) + "\n";
    return this.queue.run(file, () => fs.appendFile(file, line));
  }

  private async downloadStarted(params: any): Promise<void> {
    const pageId = this.frames.get(params.frameId) || "_unattributed";
    const page = await this.ensurePage(pageId);
    const record: Download = { id: safeId(params.guid), pageId, filename: path.basename(params.suggestedFilename || params.guid),
      frameId: params.frameId, url: params.url, totalBytes: 0, receivedBytes: 0, state: "in_progress",
      syncState: "pending", updatedAt: new Date().toISOString() };
    this.downloads.set(record.id, record);
    await this.log(page, "downloads.log", { event: "downloadWillBegin", params });
    await this.metadata(page);
    this.emit("download", { ...record });
  }

  private async downloadProgress(params: any): Promise<void> {
    let record = this.downloads.get(params.guid);
    if (!record) { await this.downloadStarted({ guid: params.guid, url: "", suggestedFilename: params.guid }); record = this.downloads.get(params.guid)!; }
    const page = this.pages.get(record.pageId!)!;
    record.receivedBytes = params.receivedBytes; record.totalBytes = params.totalBytes;
    record.state = params.state === "canceled" ? "cancelled" : params.state === "completed" ? "completed" : "in_progress";
    record.updatedAt = new Date().toISOString();
    await this.log(page, "downloads.log", { event: "downloadProgress", params });
    await this.metadata(page);
    this.emit("download", { ...record });
    if (record.state === "completed") this.scheduleDownloads();
  }

  private scheduleDownloads(): void {
    if (this.stopped || ![...this.downloads.values()].some(d => d.state === "completed" && d.syncState !== "synced")) return;
    if (this.downloadBusy) { this.downloadRequested = true; return; }
    if (this.downloadTimer) return;
    this.downloadTimer = setTimeout(() => {
      this.downloadTimer = undefined;
      void this.track(this.fetchDownloads()).catch(error => { if (!this.stopped) this.emit("failure", error); });
    }, this.retryDelayMs);
  }

  private async fetchDownloads(): Promise<void> {
    this.downloadBusy = true;
    try {
      for (let attempt = 0; attempt < 12 && !this.stopped; attempt++) {
        const waiting = [...this.downloads.values()].filter(d => d.state === "completed" && d.syncState !== "synced");
        if (!waiting.length) break;
        const temporary = await fs.mkdtemp(path.join(this.directory, ".downloads-"));
        try {
          for (const record of waiting) { record.syncState = "syncing"; this.emit("download", { ...record }); }
          const files = await this.transfers.downloads(temporary);
          for (const record of waiting) {
            const match = matchDownload(record, files, [...this.downloads.values()]);
            if (!match) { record.error = "Waiting for an unambiguous file in the session archive"; continue; }
            const page = this.pages.get(record.pageId!)!;
            const dir = path.join(page.dir, "downloads", safeId(record.id));
            await fs.mkdir(dir, { recursive: true });
            const destination = path.join(dir, path.basename(record.filename));
            const temporaryFile = `${destination}.${randomUUID()}.tmp`;
            try { await fs.copyFile(match.path, temporaryFile); await fs.rename(temporaryFile, destination); }
            finally { await fs.rm(temporaryFile, { force: true }); }
            record.localPath = destination; record.archiveName = match.name; record.syncState = "synced"; record.error = undefined;
            await this.log(page, "downloads.log", { event: "downloadSynced", id: record.id, localPath: destination });
          }
          await this.preserveUnattributedFiles(files);
        } catch (error) {
          if (this.stopped) break;
          for (const record of waiting) if (record.syncState !== "synced") record.error = (error as Error).message;
        } finally { await fs.rm(temporary, { recursive: true, force: true }); }
        for (const record of waiting) {
          if (attempt === 11 && record.syncState !== "synced") record.syncState = "error";
          await this.metadata(this.pages.get(record.pageId!)!);
          this.emit("download", { ...record });
        }
        if (waiting.every(d => d.syncState === "synced")) break;
        await delay(Math.min(this.retryDelayMs * 2 ** attempt, 5000), undefined, { signal: this.abort.signal }).catch(() => {});
      }
    } finally {
      this.downloadBusy = false;
      if (this.downloadRequested) { this.downloadRequested = false; this.scheduleDownloads(); }
    }
  }

  private startWatcher(page: PageRecord): void {
    if (this.stopped || this.watchers.has(page.pageId)) return;
    try {
      const watcher = watch(path.join(page.dir, "uploads"), () => this.scanSoon(page));
      watcher.on("error", () => { watcher.close(); this.watchers.delete(page.pageId); });
      this.watchers.set(page.pageId, watcher);
    } catch { /* The periodic scan also covers filesystems without watch support. */ }
    this.scanSoon(page);
  }

  private async preserveUnattributedFiles(files: ArchiveFile[]): Promise<void> {
    const unmatched = files.filter(file => ![...this.downloads.values()].some(record => record.archiveName === file.name));
    if (!unmatched.length) return;
    const page = await this.ensurePage("_unattributed");
    for (const file of unmatched) {
      if (this.unattributedFiles.has(file.name)) continue;
      const hash = createHash("sha256").update(file.name).digest("hex").slice(0, 16);
      const directory = path.join(page.dir, "downloads", hash);
      await fs.mkdir(directory, { recursive: true });
      const destination = path.join(directory, path.basename(file.name));
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try { await fs.copyFile(file.path, temporary); await fs.rename(temporary, destination); }
      finally { await fs.rm(temporary, { force: true }); }
      this.unattributedFiles.set(file.name, { ...file, path: destination });
    }
    await this.metadata(page);
  }

  private scanSoon(page: PageRecord): void {
    if (this.stopped || page.closed) return;
    void this.track(this.scanUploads(page)).catch(error => { if (!this.stopped) this.emit("failure", error); });
  }

  private async scanUploads(page: PageRecord): Promise<void> {
    const dir = path.join(page.dir, "uploads");
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith(".") || /\.(tmp|part|crdownload)$/.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (this.uploadBusy.has(file) || this.stopped) continue;
      this.uploadBusy.add(file);
      try {
        const first = await fs.lstat(file);
        if (!first.isFile()) continue;
        const fingerprint = `${first.size}:${first.mtimeMs}:${first.ctimeMs}`;
        if (page.uploads.get(entry.name)?.state === "uploaded" && page.uploads.get(entry.name)?.fingerprint === fingerprint) continue;
        await delay(500, undefined, { signal: this.abort.signal });
        const next = await fs.lstat(file);
        if (!next.isFile() || first.size !== next.size || first.mtimeMs !== next.mtimeMs || first.ctimeMs !== next.ctimeMs) continue;
        const record: Upload = { filename: entry.name, localPath: file, fingerprint, state: "uploading", updatedAt: new Date().toISOString() };
        page.uploads.set(entry.name, record);
        await this.metadata(page);
        try {
          // Upload storage is session-wide; namespace names to avoid collisions between tabs.
          const namespace = createHash("sha256").update(page.pageId).digest("hex").slice(0, 12);
          const result = await this.transfers.upload(file, `${namespace}-${entry.name}`);
          Object.assign(record, result, { state: "uploaded", updatedAt: new Date().toISOString() });
          await this.log(page, "uploads.log", { event: "uploadCompleted", ...record });
        } catch (error) {
          record.state = "error"; record.error = (error as Error).message;
          if (!this.stopped) await this.log(page, "uploads.log", { event: "uploadFailed", ...record });
        }
        await this.metadata(page);
      } catch (error) {
        if (!this.stopped && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally { this.uploadBusy.delete(file); }
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.abort.abort();
    for (const timer of this.timers) clearInterval(timer);
    clearTimeout(this.downloadTimer);
    for (const watcher of this.watchers.values()) watcher.close();
    for (const [method, listener] of this.subscriptions) this.client.off(method, listener);
    this.stopPromise = (async () => {
      await Promise.allSettled([...this.sessions.keys()].map(sessionId => this.client.send("Page.stopScreencast", {}, sessionId)));
      this.client.close();
      await Promise.allSettled([...this.tasks, ...this.attaching.values()]);
      await this.queue.flush();
    })();
    return this.stopPromise;
  }
}

export function matchDownload(record: DownloadInfo, files: ArchiveFile[], records: DownloadInfo[]): ArchiveFile | undefined {
  const available = files.filter(file => !records.some(other => other.id !== record.id && (other as Download).archiveName === file.name));
  const byGuid = available.filter(file => {
    const parsed = path.parse(file.name);
    return parsed.base === record.id || parsed.name === record.id || parsed.name.endsWith(`-${record.id}`);
  });
  if (byGuid.length === 1 && byGuid[0].size === record.receivedBytes) return byGuid[0];
  const siblings = records.filter(other => other.filename === record.filename && other.syncState !== "synced");
  if (siblings.length !== 1) return undefined;
  const parsed = path.parse(record.filename);
  const matching = available.filter(file => {
    const filename = path.basename(file.name);
    const stored = path.parse(filename);
    const timestamp = stored.name.startsWith(`${parsed.name}-`) ? stored.name.slice(parsed.name.length + 1) : "";
    return file.size === record.receivedBytes && (filename === record.filename || (stored.ext === parsed.ext && /^\d{13}$/.test(timestamp)));
  });
  return matching.length === 1 ? matching[0] : undefined;
}

function targetGone(error: unknown): boolean {
  return /No (?:target|session) with given id|Target closed|Session closed|Target page.*closed/i.test((error as Error).message || "");
}

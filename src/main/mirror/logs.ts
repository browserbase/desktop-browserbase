import { promises as fs } from "fs";
import * as path from "path";
import { atomicWrite, FileQueue, readJson } from "./files";

export const LOG_FILES = ["console.log", "network.log", "downloads.log", "uploads.log"];
export const DEFAULT_LOG_LIMIT_BYTES = 128 * 1024 * 1024;

export class MirrorLogs {
  private bytes = 0;
  private limited = false;
  private marker?: Promise<void>;

  constructor(private readonly directory: string, private readonly queue: FileQueue,
    private readonly maxBytes = DEFAULT_LOG_LIMIT_BYTES) {}

  get stopped(): boolean { return this.limited; }

  async restore(): Promise<void> {
    if (await readJson(path.join(this.directory, "logs-limit.json"))) {
      this.limited = true;
      return;
    }
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      for (const name of LOG_FILES) {
        try { this.bytes += (await fs.stat(path.join(this.directory, entry.name, name))).size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    if (this.bytes >= this.maxBytes) await this.stop();
  }

  append(file: string, line: string): Promise<void> {
    if (this.limited) return this.marker || Promise.resolve();
    const size = Buffer.byteLength(line);
    if (size > this.maxBytes - this.bytes) return this.stop();
    // Reserve before queueing so concurrent pages and slow disks share one bound.
    this.bytes += size;
    return this.queue.run(file, () => fs.appendFile(file, line));
  }

  private stop(): Promise<void> {
    this.limited = true;
    const file = path.join(this.directory, "logs-limit.json");
    this.marker = this.queue.run(file, () => atomicWrite(file, JSON.stringify({
      event: "logLimitReached", message: "Log capture stopped at the session limit; existing logs are preserved.",
      maxBytes: this.maxBytes, capturedBytes: this.bytes, updatedAt: new Date().toISOString(),
    }, null, 2)));
    return this.marker;
  }
}

import { createWriteStream, openAsBlob, promises as fs } from "fs";
import * as path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
import * as yauzl from "yauzl";

export interface ArchiveLimits {
  maxDownloadBytes: number;
  maxExpandedBytes: number;
  maxFileBytes: number;
  maxEntries: number;
}

export const DEFAULT_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  maxDownloadBytes: 256 * 1024 * 1024,
  maxExpandedBytes: 1024 * 1024 * 1024,
  maxFileBytes: 512 * 1024 * 1024,
  maxEntries: 10_000,
});

export class DownloadLimitError extends Error {
  constructor(message: string) { super(message); this.name = "DownloadLimitError"; }
}

function byteLimit(maxBytes: number, message: string): Transform {
  let bytes = 0;
  return new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxBytes) callback(new DownloadLimitError(message));
    else callback(null, chunk);
  } });
}

export interface ArchiveFile { name: string; path: string; size: number }

export function archiveRelativePath(name: string): string | null {
  if (name.endsWith("/")) return null;
  if (name.includes("\0") || path.posix.isAbsolute(name) || path.win32.isAbsolute(name)) {
    throw new Error("Unsafe download archive path");
  }
  const parts = name.split(/[\\/]/);
  if (parts.some(part => !part || part === "." || part === ".." || part.includes(":"))) {
    throw new Error("Unsafe download archive path");
  }
  return parts.join(path.sep);
}

export async function extractArchive(zipPath: string, directory: string, signal: AbortSignal,
  limits: Readonly<ArchiveLimits> = DEFAULT_ARCHIVE_LIMITS): Promise<ArchiveFile[]> {
  signal.throwIfAborted();
  if ((await fs.stat(zipPath)).size > limits.maxDownloadBytes) throw new DownloadLimitError("Download archive exceeds the compressed size limit");
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (error, file) => error ? reject(error) : resolve(file!));
  });
  const files: ArchiveFile[] = [];
  let entries = 0;
  let expandedBytes = 0;
  try {
    if (zip.entryCount > limits.maxEntries) throw new DownloadLimitError("Download archive contains too many entries");
    await new Promise<void>((resolve, reject) => {
      const abort = () => { zip.close(); reject(signal.reason || new Error("Sync stopped")); };
      signal.addEventListener("abort", abort, { once: true });
      const finish = (error?: Error) => {
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      };
      zip.on("error", finish);
      zip.on("end", () => finish());
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          signal.throwIfAborted();
          if (++entries > limits.maxEntries) throw new DownloadLimitError("Download archive contains too many entries");
          if (entry.uncompressedSize > limits.maxFileBytes) throw new DownloadLimitError("A download exceeds the per-file size limit");
          if (entry.uncompressedSize > limits.maxExpandedBytes - expandedBytes) throw new DownloadLimitError("Download archive exceeds the expanded size limit");
          const relative = archiveRelativePath(entry.fileName);
          if (relative) {
            const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
            if (mode === 0xa000) throw new Error("Symbolic links are not supported in downloads");
            const output = path.join(directory, relative);
            await fs.mkdir(path.dirname(output), { recursive: true });
            const input = await new Promise<Readable>((res, rej) => zip.openReadStream(entry, (error, stream) => error ? rej(error) : res(stream!)));
            let fileBytes = 0;
            const expandedLimit = new Transform({ transform(chunk, _encoding, callback) {
              fileBytes += chunk.length;
              expandedBytes += chunk.length;
              const error = fileBytes > limits.maxFileBytes
                ? new DownloadLimitError("A download exceeds the per-file size limit")
                : expandedBytes > limits.maxExpandedBytes
                  ? new DownloadLimitError("Download archive exceeds the expanded size limit")
                  : null;
              if (error) callback(error);
              else callback(null, chunk);
            } });
            await pipeline(input, expandedLimit, createWriteStream(output, { flags: "wx" }), { signal });
            files.push({ name: relative, path: output, size: entry.uncompressedSize });
          }
          zip.readEntry();
        })().catch(finish);
      });
      if (signal.aborted) abort(); else zip.readEntry();
    });
    return files;
  } finally { zip.close(); }
}

export class BrowserbaseTransfers {
  constructor(private readonly sessionId: string, private readonly apiKey: string,
    private readonly signal: AbortSignal, private readonly baseUrl = "https://api.browserbase.com",
    private readonly limits: Readonly<ArchiveLimits> = DEFAULT_ARCHIVE_LIMITS) {}

  async downloads(directory: string): Promise<ArchiveFile[]> {
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(120_000)]);
    const response = await fetch(`${this.baseUrl}/v1/sessions/${encodeURIComponent(this.sessionId)}/downloads`, {
      headers: { "X-BB-API-Key": this.apiKey }, signal,
    });
    if (!response.ok || !response.body) throw new Error(`Download archive returned HTTP ${response.status}`);
    if (Number(response.headers.get("content-length")) > this.limits.maxDownloadBytes) {
      await response.body.cancel();
      throw new DownloadLimitError("Download archive exceeds the compressed size limit");
    }
    const zip = path.join(directory, `${randomUUID()}.zip`);
    try {
      await pipeline(Readable.fromWeb(response.body as any),
        byteLimit(this.limits.maxDownloadBytes, "Download archive exceeds the compressed size limit"),
        createWriteStream(zip, { flags: "wx" }), { signal });
      const output = path.join(directory, "extracted");
      await fs.mkdir(output, { recursive: true });
      return await extractArchive(zip, output, signal, this.limits);
    } finally { await fs.rm(zip, { force: true }); }
  }

  async upload(file: string, remoteFilename: string): Promise<{ remotePath: string; fileUrl: string }> {
    const form = new FormData();
    form.append("file", await openAsBlob(file), remoteFilename);
    const response = await fetch(`${this.baseUrl}/v1/sessions/${encodeURIComponent(this.sessionId)}/uploads`, {
      method: "POST", headers: { "X-BB-API-Key": this.apiKey }, body: form,
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(120_000)]),
    });
    if (!response.ok) throw new Error(`Upload returned HTTP ${response.status}`);
    await response.arrayBuffer();
    const remotePath = `/tmp/.uploads/${remoteFilename}`;
    return { remotePath, fileUrl: `file:///tmp/.uploads/${encodeURIComponent(remoteFilename)}` };
  }
}

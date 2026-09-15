import { promises as fs } from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

const OWNER_FILE = ".browserbase-mirror.json";

export function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid browser target ID");
  return id;
}

export async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, data);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function prepareMirrorDirectory(directory: string, sessionId: string, fresh: boolean): Promise<void> {
  const root = path.resolve(directory);
  if (path.basename(root) !== "browser") throw new Error("Mirror directory must be named browser");
  await fs.mkdir(root, { recursive: true });
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error("Mirror directory cannot be a symbolic link");
  const ownerPath = path.join(root, OWNER_FILE);
  const owner = await readJson<{ owner: string; sessionId: string }>(ownerPath);
  const entries = await fs.readdir(root);
  if (entries.length && owner?.owner !== "desktop-browserbase") {
    throw new Error("This browser folder contains existing files. Choose another parent folder.");
  }
  if (fresh || (owner && owner.sessionId !== sessionId)) {
    for (const entry of entries) await fs.rm(path.join(root, entry), { recursive: true, force: true });
  }
  await atomicWrite(ownerPath, JSON.stringify({ owner: "desktop-browserbase", sessionId }));
}

export class FileQueue {
  private pending = new Map<string, Promise<unknown>>();
  run<T>(file: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(file) || Promise.resolve()).catch(() => {}).then(operation);
    this.pending.set(file, next);
    void next.finally(() => {
      if (this.pending.get(file) === next) this.pending.delete(file);
    }).catch(() => {});
    return next;
  }
  async flush(): Promise<void> { await Promise.allSettled([...this.pending.values()]); }
}

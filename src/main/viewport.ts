import { ViewportConfig } from "../shared/types";

/** Reject hidden elements, malformed IPC values, and unreasonably large surfaces. */
export function parseViewport(value: unknown): ViewportConfig | null {
  if (!value || typeof value !== "object") return null;
  const { width, height } = value as Partial<ViewportConfig>;
  if (typeof width !== "number" || typeof height !== "number" ||
      !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > 8192 || height > 8192) return null;
  return { width, height };
}

/** Coalesce resize bursts and serialize CDP updates so the newest size wins. */
export class ViewportUpdater {
  private pending: ViewportConfig | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private applying = false;
  private disposed = false;

  constructor(private update: (viewport: ViewportConfig) => Promise<void>, private delayMs = 100) {}

  push(value: unknown): void {
    const viewport = parseViewport(value);
    if (!viewport || this.disposed) return;
    this.pending = viewport;
    if (!this.timer && !this.applying) {
      this.timer = setTimeout(() => { void this.flush(); }, this.delayMs);
    }
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const viewport = this.pending;
    this.pending = null;
    if (!viewport || this.disposed) return;
    this.applying = true;
    try {
      await this.update(viewport);
    } catch {
      console.error("Failed to update the remote viewport");
    } finally {
      this.applying = false;
      if (this.pending && !this.disposed) this.push(this.pending);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

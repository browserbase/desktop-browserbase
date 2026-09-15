import { CdpClient } from "./cdp-client";
import { MirrorEngine } from "./engine";
import { prepareMirrorDirectory } from "./files";
import { BrowserbaseTransfers } from "./transfers";
import { TabInfo } from "../../shared/types";

const port = process.parentPort;
let engine: MirrorEngine | undefined;
let client: CdpClient | undefined;
let stopping = false;
let startup: Promise<void> = Promise.resolve();
let latestTabs: TabInfo[] = [];

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  client?.close();
  await startup.catch(() => {});
  await engine?.stop();
  port?.postMessage({ type: "stopped" });
  process.exit(0);
}

port?.on("message", ({ data }: { data: any }) => {
  if (data.type === "stop") { void stop(); return; }
  if (data.type === "tabs") {
    latestTabs = data.tabs;
    if (engine && !stopping) void engine.updateTabs(latestTabs).catch(fail);
    return;
  }
  if (data.type !== "start" || client || stopping) return;
  startup = (async () => {
    await prepareMirrorDirectory(data.directory, data.sessionId, data.fresh);
    port?.postMessage({ type: "prepared" });
    if (stopping) return;
    const abort = new AbortController();
    client = new CdpClient(data.connectUrl, { commandTimeoutMs: 5000 });
    const transfers = new BrowserbaseTransfers(data.sessionId, data.apiKey, abort.signal);
    engine = new MirrorEngine(client, data.directory, data.sessionId, transfers, abort);
    engine.on("stats", stats => port?.postMessage({ type: "stats", stats }));
    engine.on("download", download => port?.postMessage({ type: "download", download }));
    engine.on("disconnected", () => { port?.postMessage({ type: "disconnected" }); void stop(); });
    engine.on("failure", fail);
    await client.connect();
    if (stopping) return;
    await engine.start();
    await engine.updateTabs(latestTabs);
    port?.postMessage({ type: "ready" });
  })();
  void startup.catch(fail);
});

function fail(error: Error): void {
  if (stopping) return;
  // Never send CDP URLs or API credentials to renderer-facing status messages.
  const message = String(error.message).replace(/(?:wss?|https?):\/\/\S+/g, "[remote endpoint]");
  port?.postMessage({ type: "failure", error: message });
  void stop();
}

process.on("SIGTERM", () => { void stop(); });

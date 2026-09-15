import { EventEmitter } from "node:events";

export class CdpClient extends EventEmitter {
  constructor(url, options = {}) {
    super();
    this.url = url;
    this.WebSocketImpl = options.WebSocketImpl;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async connect() {
    const WebSocketImpl = this.WebSocketImpl ?? (await defaultWebSocketImpl());
    const ws = new WebSocketImpl(this.url);
    this.ws = ws;

    try {
      await waitForOpen(ws, this.url);
    } catch (error) {
      ws.close();
      throw error;
    }
    addWsListener(ws, "message", (event) => {
      void this.handleMessage(event);
    });
    addWsListener(ws, "close", (event) => {
      this.rejectAll(new Error("CDP WebSocket closed."));
      this.emit("close", normalizeCloseEvent(event));
    });
    addWsListener(ws, "error", (event) => {
      const error = event instanceof Error ? event : new Error("CDP WebSocket error.");
      this.rejectAll(error);
      if (this.listenerCount("error") > 0) {
        this.emit("error", error);
      }
    });
  }

  send(method, params = {}, sessionId) {
    if (!this.ws || !isOpen(this.ws)) {
      return Promise.reject(new Error("CDP WebSocket is not open."));
    }

    const id = this.nextId;
    this.nextId += 1;
    const message = { id, method, params };
    if (sessionId) {
      message.sessionId = sessionId;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP response to ${method}.`));
      }, this.commandTimeoutMs);

      this.pending.set(id, { method, reject, resolve, timer });
      this.ws.send(JSON.stringify(message));
    });
  }

  close() {
    if (!this.ws) return;
    if (isOpen(this.ws) || isConnecting(this.ws)) {
      this.ws.close();
    }
    this.rejectAll(new Error("CDP client closed."));
    this.ws = null;
  }

  async handleMessage(event) {
    const raw = await normalizeMessage(event);
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method) {
      this.emit(message.method, message.params ?? {}, message);
      this.emit("event", message);
    }
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

async function defaultWebSocketImpl() {
  if (globalThis.WebSocket) {
    return globalThis.WebSocket;
  }

  try {
    const module = await import("ws");
    return module.default;
  } catch {
    throw new Error("No WebSocket implementation found. Use Node >=22 or install the ws package.");
  }
}

function waitForOpen(ws, url) {
  if (isOpen(ws)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out connecting to CDP WebSocket ${url}.`));
    }, 10_000);

    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (event) => {
      cleanup();
      reject(event instanceof Error ? event : new Error(`Failed to connect to CDP WebSocket ${url}.`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      removeWsListener(ws, "open", onOpen);
      removeWsListener(ws, "error", onError);
    };

    addWsListener(ws, "open", onOpen);
    addWsListener(ws, "error", onError);
  });
}

async function normalizeMessage(event) {
  const data = event?.data ?? event;
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (data && typeof data.arrayBuffer === "function") {
    return Buffer.from(await data.arrayBuffer()).toString("utf8");
  }
  return String(data);
}

function addWsListener(ws, event, listener) {
  if (typeof ws.addEventListener === "function") {
    ws.addEventListener(event, listener);
  } else {
    ws.on(event, listener);
  }
}

function removeWsListener(ws, event, listener) {
  if (typeof ws.removeEventListener === "function") {
    ws.removeEventListener(event, listener);
  } else {
    ws.off(event, listener);
  }
}

function isOpen(ws) {
  return ws.readyState === 1;
}

function isConnecting(ws) {
  return ws.readyState === 0;
}

function normalizeCloseEvent(event) {
  if (!event) return {};
  if (typeof event === "object" && ("code" in event || "reason" in event)) {
    return {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    };
  }
  return {};
}

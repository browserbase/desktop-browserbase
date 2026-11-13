import { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, session } from "electron";
import * as path from "path";
import { pathToFileURL } from "url";

const rendererUrl = pathToFileURL(path.join(__dirname, "../renderer/index.html")).href;
const liveViewPartition = "persist:browserbase";

export function isLiveViewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username && !url.password && !url.port &&
      url.hostname === "www.browserbase.com" &&
      ["/devtools/inspector.html", "/devtools-fullscreen/inspector.html"].includes(url.pathname);
  } catch {
    return false;
  }
}

export function isTrustedRenderer(
  event: IpcMainEvent | IpcMainInvokeEvent,
  mainWindow: BrowserWindow
): boolean {
  return !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    event.senderFrame.url === rendererUrl;
}

export function secureWindow(mainWindow: BrowserWindow): void {
  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-frame-navigate", (event) => event.preventDefault());

  // Remote pages run in Browserbase. The local guest only needs to display live view.
  const liveViewSession = session.fromPartition(liveViewPartition);
  // webview.src/loadURL changes do not emit will-navigate. Check the request too.
  liveViewSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: details.resourceType === "mainFrame" && !isLiveViewUrl(details.url) });
  });
  for (const localSession of [contents.session, liveViewSession]) {
    localSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    localSession.setPermissionCheckHandler(() => false);
  }

  contents.on("will-attach-webview", (event, preferences, params) => {
    if (!isLiveViewUrl(params.src) || params.partition !== liveViewPartition) {
      event.preventDefault();
      return;
    }

    delete preferences.preload;
    preferences.nodeIntegration = false;
    preferences.nodeIntegrationInSubFrames = false;
    preferences.nodeIntegrationInWorker = false;
    preferences.contextIsolation = true;
    preferences.sandbox = true;
    preferences.webSecurity = true;
    preferences.allowRunningInsecureContent = false;
    preferences.webviewTag = false;
    preferences.experimentalFeatures = false;
    delete params.allowpopups;
  });

  contents.on("did-attach-webview", (_event, guest) => {
    guest.setWindowOpenHandler(() => ({ action: "deny" }));
    guest.on("will-navigate", (event, url) => {
      if (!isLiveViewUrl(url)) event.preventDefault();
    });
    guest.on("will-redirect", (event, url) => {
      if (!isLiveViewUrl(url)) event.preventDefault();
    });
  });
}

import { app, BrowserWindow, globalShortcut, session, nativeTheme, dialog } from "electron";
import * as path from "path";
import * as fs from "fs";
import { sessionManager } from "./session";
import { setupIpcHandlers, removeIpcHandlers } from "./ipc";
import { IPC_CHANNELS } from "../shared/types";

let mainWindow: BrowserWindow | null = null;

// Window state persistence
interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
}

const windowStateFile = path.join(app.getPath("userData"), "window-state.json");

function loadWindowState(): WindowState {
  try {
    if (fs.existsSync(windowStateFile)) {
      return JSON.parse(fs.readFileSync(windowStateFile, "utf8"));
    }
  } catch (e) {
    console.error("Failed to load window state:", e);
  }
  // Default to a larger window for better desktop experience
  return { width: 1440, height: 900, isMaximized: false };
}

function saveWindowState(window: BrowserWindow): void {
  try {
    const bounds = window.getBounds();
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized: window.isMaximized(),
    };
    fs.writeFileSync(windowStateFile, JSON.stringify(state));
  } catch (e) {
    console.error("Failed to save window state:", e);
  }
}

// Validate environment variables
function validateEnvironment(): boolean {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;

  if (!apiKey || !projectId) {
    dialog.showErrorBox(
      "Configuration Error",
      "Missing required environment variables.\n\n" +
        "Please set:\n" +
        "- BROWSERBASE_API_KEY\n" +
        "- BROWSERBASE_PROJECT_ID\n\n" +
        "See README.md for setup instructions."
    );
    return false;
  }
  return true;
}

async function createWindow(): Promise<void> {
  const windowState = loadWindowState();

  // Create the browser window with Chrome-like appearance
  const isMac = process.platform === "darwin";

  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 400,
    minHeight: 300,
    frame: false, // Frameless for custom title bar
    titleBarStyle: isMac ? "hiddenInset" : "hidden", // Show traffic lights on macOS
    trafficLightPosition: isMac ? { x: 12, y: 12 } : undefined, // Position traffic lights in tab bar
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#202124" : "#DEE1E6",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // Required for preload script
      webviewTag: true, // Enable webview tag for live view embed
    },
  });

  // Restore maximized state
  if (windowState.isMaximized) {
    mainWindow.maximize();
  }

  // Save window state on resize/move
  mainWindow.on("resize", () => mainWindow && saveWindowState(mainWindow));
  mainWindow.on("move", () => mainWindow && saveWindowState(mainWindow));
  mainWindow.on("close", () => mainWindow && saveWindowState(mainWindow));

  // Set up IPC handlers
  setupIpcHandlers(mainWindow);
  sessionManager.setMainWindow(mainWindow);

  // Load the renderer HTML
  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  // Wait for renderer to be ready before initializing session
  mainWindow.webContents.on("did-finish-load", async () => {
    console.log("Renderer loaded, initializing Browserbase session...");

    // Initialize Browserbase session
    try {
      const bbSession = await sessionManager.initialize();
      console.log("Session initialized, sending SESSION_CREATED event");
      mainWindow?.webContents.send(IPC_CHANNELS.SESSION_CREATED, bbSession.id);
    } catch (error) {
      console.error("Failed to initialize Browserbase session:", error);
      mainWindow?.webContents.send(IPC_CHANNELS.SESSION_ERROR, (error as Error).message);
    }
  });

  // Register keyboard shortcuts
  registerShortcuts();

  // Handle window close
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Open DevTools in development
  if (process.env.NODE_ENV === "development") {
    mainWindow.webContents.openDevTools();
  }
}

function registerShortcuts(): void {
  if (!mainWindow) return;

  // Ctrl+T - New tab
  globalShortcut.register("CommandOrControl+T", () => {
    sessionManager.newTab();
  });

  // Ctrl+W - Close tab
  globalShortcut.register("CommandOrControl+W", () => {
    const tabs = sessionManager.getTabs();
    const activeTab = tabs.find((t) => t.active);
    if (activeTab && tabs.length > 1) {
      sessionManager.closeTab(activeTab.id);
    } else if (tabs.length === 1) {
      mainWindow?.close();
    }
  });

  // Ctrl+Tab - Next tab
  globalShortcut.register("CommandOrControl+Tab", () => {
    const tabs = sessionManager.getTabs();
    const activeIndex = tabs.findIndex((t) => t.active);
    const nextIndex = (activeIndex + 1) % tabs.length;
    if (tabs[nextIndex]) {
      sessionManager.switchTab(tabs[nextIndex].id);
    }
  });

  // Ctrl+Shift+Tab - Previous tab
  globalShortcut.register("CommandOrControl+Shift+Tab", () => {
    const tabs = sessionManager.getTabs();
    const activeIndex = tabs.findIndex((t) => t.active);
    const prevIndex = activeIndex === 0 ? tabs.length - 1 : activeIndex - 1;
    if (tabs[prevIndex]) {
      sessionManager.switchTab(tabs[prevIndex].id);
    }
  });

  // Ctrl+L - Focus URL bar
  globalShortcut.register("CommandOrControl+L", () => {
    mainWindow?.webContents.send("focus-url-bar");
  });

  // Ctrl+R / F5 - Reload
  globalShortcut.register("CommandOrControl+R", () => {
    sessionManager.reload();
  });
  globalShortcut.register("F5", () => {
    sessionManager.reload();
  });

  // Alt+Left - Back
  globalShortcut.register("Alt+Left", () => {
    sessionManager.goBack();
  });

  // Alt+Right - Forward
  globalShortcut.register("Alt+Right", () => {
    sessionManager.goForward();
  });

  // Ctrl+Shift+B - Toggle bookmarks bar
  globalShortcut.register("CommandOrControl+Shift+B", () => {
    mainWindow?.webContents.send(IPC_CHANNELS.BOOKMARKS_TOGGLE);
  });

  // F11 - Toggle fullscreen
  globalShortcut.register("F11", () => {
    if (mainWindow) {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  // Ctrl+1-9 - Switch to specific tab
  for (let i = 1; i <= 9; i++) {
    globalShortcut.register(`CommandOrControl+${i}`, () => {
      const tabs = sessionManager.getTabs();
      const targetIndex = i === 9 ? tabs.length - 1 : i - 1;
      if (tabs[targetIndex]) {
        sessionManager.switchTab(tabs[targetIndex].id);
      }
    });
  }
}

// Set up content security policy for Browserbase iframe
function setupContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.browserbase.com wss://*.browserbase.com; " +
            "frame-src https://*.browserbase.com https://www.browserbase.com; " +
            "img-src 'self' data: https: http:; " +
            "connect-src 'self' https://*.browserbase.com wss://*.browserbase.com wss://connect.browserbase.com https://www.google.com;",
        ],
      },
    });
  });
}

// App lifecycle
app.whenReady().then(async () => {
  // Validate environment before starting
  if (!validateEnvironment()) {
    app.quit();
    return;
  }

  setupContentSecurityPolicy();
  await createWindow();

  // Handle theme changes
  nativeTheme.on("updated", () => {
    if (mainWindow) {
      mainWindow.webContents.send("theme-changed", nativeTheme.shouldUseDarkColors);
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", async () => {
  // Clean up Browserbase session
  await sessionManager.cleanup();
  removeIpcHandlers();
  globalShortcut.unregisterAll();

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", async () => {
  await sessionManager.cleanup();
  globalShortcut.unregisterAll();
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled rejection at:", promise, "reason:", reason);
});

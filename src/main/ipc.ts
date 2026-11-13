/**
 * @fileoverview IPC (Inter-Process Communication) handlers for main process.
 *
 * This module sets up all IPC handlers that allow the renderer process to
 * communicate with the main process. Handlers are provided for navigation,
 * tab management, window controls, and menu actions.
 *
 * @module main/ipc
 */

import { ipcMain, BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS, ScrollInputEvent } from "../shared/types";
import { sessionManager } from "./session";
import { isTrustedRenderer } from "./security";

function isAcceleratedScrollEnabled(): boolean {
  const value = process.env.BROWSERBASE_ACCELERATED_SCROLL;
  return !!value && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/**
 * Sets up all IPC handlers for communication between renderer and main process.
 *
 * Registers handlers for:
 * - Navigation: navigateTo, back, forward, reload, home
 * - Tabs: new, close, switch
 * - Window: minimize, maximize, close
 * - View: zoom, fullscreen, devtools
 *
 * @param mainWindow - The main BrowserWindow instance
 */
export function setupIpcHandlers(mainWindow: BrowserWindow): void {
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedRenderer(event, mainWindow)) {
        throw new Error("Untrusted IPC sender");
      }
      return listener(event, ...args);
    });
  };
  const on = (channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void) => {
    ipcMain.on(channel, (event, ...args) => {
      if (isTrustedRenderer(event, mainWindow)) listener(event, ...args);
    });
  };

  // Navigation handlers
  handle(IPC_CHANNELS.NAVIGATE_TO, async (_event, url: string) => {
    try {
      await sessionManager.navigateTo(url);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  handle(IPC_CHANNELS.NAVIGATE_BACK, async () => {
    try {
      await sessionManager.goBack();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  handle(IPC_CHANNELS.NAVIGATE_FORWARD, async () => {
    try {
      await sessionManager.goForward();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  handle(IPC_CHANNELS.NAVIGATE_RELOAD, async () => {
    try {
      await sessionManager.reload();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  handle(IPC_CHANNELS.NAVIGATE_HOME, async () => {
    try {
      const homeUrl = process.env.BROWSERBASE_DEFAULT_URL || "https://www.google.com";
      await sessionManager.navigateTo(homeUrl);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  handle(IPC_CHANNELS.GET_ACCELERATED_SCROLL_ENABLED, () => {
    return isAcceleratedScrollEnabled();
  });

  on(IPC_CHANNELS.INPUT_SCROLL, (_event, scrollEvent: ScrollInputEvent) => {
    if (!isAcceleratedScrollEnabled()) {
      return;
    }

    void sessionManager.dispatchScroll(scrollEvent);
  });

  // Tab handlers
  handle(IPC_CHANNELS.TAB_NEW, async () => {
    try {
      await sessionManager.newTab();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  handle(IPC_CHANNELS.TAB_CLOSE, async (_event, tabId: string) => {
    try {
      await sessionManager.closeTab(tabId);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  handle(IPC_CHANNELS.TAB_SWITCH, async (_event, tabId: string) => {
    try {
      await sessionManager.switchTab(tabId);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Debug URL handler (Browserbase live view)
  handle(IPC_CHANNELS.GET_DEBUG_URL, () => {
    return sessionManager.getDebugUrl();
  });

  // Window control handlers
  on(IPC_CHANNELS.WINDOW_MINIMIZE, () => {
    mainWindow.minimize();
  });

  on(IPC_CHANNELS.WINDOW_MAXIMIZE, () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  on(IPC_CHANNELS.WINDOW_CLOSE, () => {
    mainWindow.close();
  });

  // Bookmarks toggle (for future implementation)
  on(IPC_CHANNELS.BOOKMARKS_TOGGLE, () => {
    mainWindow.webContents.send(IPC_CHANNELS.BOOKMARKS_TOGGLE);
  });

  // Menu action handlers
  on(IPC_CHANNELS.OPEN_DEVTOOLS, () => {
    mainWindow.webContents.openDevTools();
  });

  on(IPC_CHANNELS.TOGGLE_FULLSCREEN, () => {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });

  on(IPC_CHANNELS.ZOOM_IN, () => {
    const currentZoom = mainWindow.webContents.getZoomLevel();
    mainWindow.webContents.setZoomLevel(currentZoom + 0.5);
  });

  on(IPC_CHANNELS.ZOOM_OUT, () => {
    const currentZoom = mainWindow.webContents.getZoomLevel();
    mainWindow.webContents.setZoomLevel(currentZoom - 0.5);
  });

  on(IPC_CHANNELS.ZOOM_RESET, () => {
    mainWindow.webContents.setZoomLevel(0);
  });
}

/**
 * Removes all IPC handlers during application cleanup.
 *
 * Should be called when the application is quitting to prevent
 * memory leaks and ensure clean shutdown.
 */
export function removeIpcHandlers(): void {
  const channels = Object.values(IPC_CHANNELS);
  channels.forEach((channel) => {
    ipcMain.removeHandler(channel);
    ipcMain.removeAllListeners(channel);
  });
}

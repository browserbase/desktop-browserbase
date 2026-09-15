/**
 * @fileoverview IPC (Inter-Process Communication) handlers for main process.
 *
 * This module sets up all IPC handlers that allow the renderer process to
 * communicate with the main process. Handlers are provided for navigation,
 * tab management, window controls, and menu actions.
 *
 * @module main/ipc
 */

import { ipcMain, BrowserWindow, dialog } from "electron";
import { IPC_CHANNELS, ScrollInputEvent } from "../shared/types";
import { sessionManager } from "./session";
import { browserMirrorManager } from "./mirror/manager";

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
  const mirrorHandler = (channel: string, action: (...args: any[]) => Promise<unknown>) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return { success: false, error: "Invalid sender" };
      try { return { success: true, status: await action(...args) }; }
      catch (error) { return { success: false, error: (error as Error).message }; }
    });
  };
  ipcMain.handle(IPC_CHANNELS.MIRROR_GET_STATUS, () => browserMirrorManager.getStatus());
  mirrorHandler(IPC_CHANNELS.MIRROR_CHOOSE_FOLDER, async () => {
    const selected = await dialog.showOpenDialog(mainWindow, { title: "Sync Browser to Folder", buttonLabel: "Sync Here", properties: ["openDirectory", "createDirectory"] });
    if (selected.canceled || !selected.filePaths[0]) return browserMirrorManager.getStatus();
    return browserMirrorManager.setFolder(selected.filePaths[0]);
  });
  mirrorHandler(IPC_CHANNELS.MIRROR_SET_ENABLED, async enabled => {
    if (typeof enabled !== "boolean") throw new Error("Invalid sync setting");
    return browserMirrorManager.setEnabled(enabled);
  });
  mirrorHandler(IPC_CHANNELS.MIRROR_OPEN_FOLDER, async active => browserMirrorManager.openFolder(active === true));
  mirrorHandler(IPC_CHANNELS.DOWNLOAD_REVEAL, async id => {
    if (typeof id !== "string") throw new Error("Invalid download ID");
    return browserMirrorManager.revealDownload(id);
  });
  // Navigation handlers
  ipcMain.handle(IPC_CHANNELS.NAVIGATE_TO, async (_event, url: string) => {
    try {
      await sessionManager.navigateTo(url);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.NAVIGATE_BACK, async () => {
    try {
      await sessionManager.goBack();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.NAVIGATE_FORWARD, async () => {
    try {
      await sessionManager.goForward();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.NAVIGATE_RELOAD, async () => {
    try {
      await sessionManager.reload();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.NAVIGATE_HOME, async () => {
    try {
      const homeUrl = process.env.BROWSERBASE_DEFAULT_URL || "https://www.google.com";
      await sessionManager.navigateTo(homeUrl);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_ACCELERATED_SCROLL_ENABLED, () => {
    return isAcceleratedScrollEnabled();
  });

  ipcMain.on(IPC_CHANNELS.INPUT_SCROLL, (_event, scrollEvent: ScrollInputEvent) => {
    if (!isAcceleratedScrollEnabled()) {
      return;
    }

    void sessionManager.dispatchScroll(scrollEvent);
  });

  // Tab handlers
  ipcMain.handle(IPC_CHANNELS.TAB_NEW, async () => {
    try {
      await sessionManager.newTab();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.TAB_CLOSE, async (_event, tabId: string) => {
    try {
      await sessionManager.closeTab(tabId);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.TAB_SWITCH, async (_event, tabId: string) => {
    try {
      await sessionManager.switchTab(tabId);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Debug URL handler (Browserbase live view)
  ipcMain.handle(IPC_CHANNELS.GET_DEBUG_URL, () => {
    return sessionManager.getDebugUrl();
  });

  // Window control handlers
  ipcMain.on(IPC_CHANNELS.WINDOW_MINIMIZE, () => {
    mainWindow.minimize();
  });

  ipcMain.on(IPC_CHANNELS.WINDOW_MAXIMIZE, () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.on(IPC_CHANNELS.WINDOW_CLOSE, () => {
    mainWindow.close();
  });

  // Bookmarks toggle (for future implementation)
  ipcMain.on(IPC_CHANNELS.BOOKMARKS_TOGGLE, () => {
    mainWindow.webContents.send(IPC_CHANNELS.BOOKMARKS_TOGGLE);
  });

  // Menu action handlers
  ipcMain.on(IPC_CHANNELS.OPEN_DEVTOOLS, () => {
    mainWindow.webContents.openDevTools();
  });

  ipcMain.on(IPC_CHANNELS.TOGGLE_FULLSCREEN, () => {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });

  ipcMain.on(IPC_CHANNELS.ZOOM_IN, () => {
    const currentZoom = mainWindow.webContents.getZoomLevel();
    mainWindow.webContents.setZoomLevel(currentZoom + 0.5);
  });

  ipcMain.on(IPC_CHANNELS.ZOOM_OUT, () => {
    const currentZoom = mainWindow.webContents.getZoomLevel();
    mainWindow.webContents.setZoomLevel(currentZoom - 0.5);
  });

  ipcMain.on(IPC_CHANNELS.ZOOM_RESET, () => {
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

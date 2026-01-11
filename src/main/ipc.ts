import { ipcMain, BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../shared/types";
import { sessionManager } from "./session";

export function setupIpcHandlers(mainWindow: BrowserWindow): void {
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
}

export function removeIpcHandlers(): void {
  // Remove all handlers on cleanup
  const channels = Object.values(IPC_CHANNELS);
  channels.forEach((channel) => {
    ipcMain.removeHandler(channel);
    ipcMain.removeAllListeners(channel);
  });
}

/**
 * @fileoverview Preload script that bridges renderer and main processes.
 *
 * This script runs in a privileged context before the renderer process loads.
 * It uses Electron's contextBridge to safely expose a limited API (electronAPI)
 * to the renderer, enabling IPC communication while maintaining security through
 * context isolation.
 *
 * The exposed API provides methods for:
 * - Navigation control (goto, back, forward, reload)
 * - Tab management (new, close, switch)
 * - Window controls (minimize, maximize, close)
 * - Event subscriptions (tabs updated, URL changed, session events)
 *
 * @module main/preload
 */

import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, TabInfo } from "../shared/types";

/**
 * Expose the electronAPI to the renderer process via contextBridge.
 * All methods are safe to call from the renderer and communicate via IPC.
 */
contextBridge.exposeInMainWorld("electronAPI", {
  // Navigation
  navigateTo: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.NAVIGATE_TO, url),
  navigateBack: () => ipcRenderer.invoke(IPC_CHANNELS.NAVIGATE_BACK),
  navigateForward: () => ipcRenderer.invoke(IPC_CHANNELS.NAVIGATE_FORWARD),
  navigateReload: () => ipcRenderer.invoke(IPC_CHANNELS.NAVIGATE_RELOAD),
  navigateHome: () => ipcRenderer.invoke(IPC_CHANNELS.NAVIGATE_HOME),

  // Tabs
  newTab: () => ipcRenderer.invoke(IPC_CHANNELS.TAB_NEW),
  closeTab: (tabId: string) => ipcRenderer.invoke(IPC_CHANNELS.TAB_CLOSE, tabId),
  switchTab: (tabId: string) => ipcRenderer.invoke(IPC_CHANNELS.TAB_SWITCH, tabId),

  // Debug URL (Browserbase live view)
  getDebugUrl: () => ipcRenderer.invoke(IPC_CHANNELS.GET_DEBUG_URL),

  // Window controls
  minimizeWindow: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MINIMIZE),
  maximizeWindow: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MAXIMIZE),
  closeWindow: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_CLOSE),

  // Menu actions
  openDevTools: () => ipcRenderer.send(IPC_CHANNELS.OPEN_DEVTOOLS),
  toggleFullscreen: () => ipcRenderer.send(IPC_CHANNELS.TOGGLE_FULLSCREEN),
  zoomIn: () => ipcRenderer.send(IPC_CHANNELS.ZOOM_IN),
  zoomOut: () => ipcRenderer.send(IPC_CHANNELS.ZOOM_OUT),
  zoomReset: () => ipcRenderer.send(IPC_CHANNELS.ZOOM_RESET),

  // Bookmarks
  toggleBookmarks: () => ipcRenderer.send(IPC_CHANNELS.BOOKMARKS_TOGGLE),

  // Event listeners
  onTabsUpdated: (callback: (tabs: TabInfo[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tabs: TabInfo[]) => callback(tabs);
    ipcRenderer.on(IPC_CHANNELS.TABS_UPDATED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TABS_UPDATED, listener);
  },

  onUrlChanged: (callback: (url: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, url: string) => callback(url);
    ipcRenderer.on(IPC_CHANNELS.URL_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.URL_CHANGED, listener);
  },

  onSessionCreated: (callback: (sessionId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId);
    ipcRenderer.on(IPC_CHANNELS.SESSION_CREATED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SESSION_CREATED, listener);
  },

  onSessionError: (callback: (error: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, error: string) => callback(error);
    ipcRenderer.on(IPC_CHANNELS.SESSION_ERROR, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SESSION_ERROR, listener);
  },

  onSessionDisconnected: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.SESSION_DISCONNECTED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SESSION_DISCONNECTED, listener);
  },

  onBookmarksToggle: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.BOOKMARKS_TOGGLE, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BOOKMARKS_TOGGLE, listener);
  },

  onDebugUrlChanged: (callback: (url: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, url: string) => callback(url);
    ipcRenderer.on(IPC_CHANNELS.DEBUG_URL_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DEBUG_URL_CHANGED, listener);
  },

  // Download events
  onDownloadStarted: (callback: (download: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, download: any) => callback(download);
    ipcRenderer.on(IPC_CHANNELS.DOWNLOAD_STARTED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DOWNLOAD_STARTED, listener);
  },

  onDownloadProgress: (callback: (download: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, download: any) => callback(download);
    ipcRenderer.on(IPC_CHANNELS.DOWNLOAD_PROGRESS, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DOWNLOAD_PROGRESS, listener);
  },

  onDownloadCompleted: (callback: (download: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, download: any) => callback(download);
    ipcRenderer.on(IPC_CHANNELS.DOWNLOAD_COMPLETED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DOWNLOAD_COMPLETED, listener);
  },
});

// Type declarations for the renderer process
declare global {
  interface Window {
    electronAPI: {
      navigateTo: (url: string) => Promise<{ success: boolean; error?: string }>;
      navigateBack: () => Promise<{ success: boolean; error?: string }>;
      navigateForward: () => Promise<{ success: boolean; error?: string }>;
      navigateReload: () => Promise<{ success: boolean; error?: string }>;
      navigateHome: () => Promise<{ success: boolean; error?: string }>;
      newTab: () => Promise<{ success: boolean; error?: string }>;
      closeTab: (tabId: string) => Promise<{ success: boolean; error?: string }>;
      switchTab: (tabId: string) => Promise<{ success: boolean; error?: string }>;
      getDebugUrl: () => Promise<string>;
      minimizeWindow: () => void;
      maximizeWindow: () => void;
      closeWindow: () => void;
      openDevTools: () => void;
      toggleFullscreen: () => void;
      zoomIn: () => void;
      zoomOut: () => void;
      zoomReset: () => void;
      toggleBookmarks: () => void;
      onTabsUpdated: (callback: (tabs: TabInfo[]) => void) => () => void;
      onUrlChanged: (callback: (url: string) => void) => () => void;
      onSessionCreated: (callback: (sessionId: string) => void) => () => void;
      onSessionError: (callback: (error: string) => void) => () => void;
      onSessionDisconnected: (callback: () => void) => () => void;
      onBookmarksToggle: (callback: () => void) => () => void;
      onDebugUrlChanged: (callback: (url: string) => void) => () => void;
      onDownloadStarted: (callback: (download: any) => void) => () => void;
      onDownloadProgress: (callback: (download: any) => void) => () => void;
      onDownloadCompleted: (callback: (download: any) => void) => () => void;
    };
  }
}

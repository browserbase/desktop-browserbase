/**
 * @fileoverview Shared type definitions and constants for Desktop Browserbase.
 *
 * This module contains all TypeScript interfaces, types, and constants shared
 * between the main process and renderer process. It defines the data structures
 * for session management, tab handling, IPC communication, and application settings.
 *
 * @module shared/types
 */

/**
 * Configuration for browser viewport dimensions.
 * Used when creating sessions and updating viewport on window resize.
 */
export interface ViewportConfig {
  /** Viewport width in pixels */
  width: number;
  /** Viewport height in pixels */
  height: number;
}

/**
 * Configuration options for creating a Browserbase session.
 * Passed to the Browserbase API when initializing a new remote browser.
 */
export interface SessionConfig {
  /** Browserbase project ID (usually set via environment variable) */
  projectId?: string;
  /** Browser-specific settings */
  browserSettings?: {
    /** Enable stealth mode for bot detection bypass (default: true) */
    stealth?: boolean;
    /** Initial viewport dimensions */
    viewport?: ViewportConfig;
    /** Device scale factor for Retina displays (2 for macOS, 1 for others) */
    deviceScaleFactor?: number;
  };
}

/**
 * Information about a browser tab in the remote session.
 * Synchronized from Playwright pages and sent to the renderer for UI updates.
 */
export interface TabInfo {
  /** Unique tab identifier (format: "tab-{index}") */
  id: string;
  /** CDP target ID for the page */
  targetId: string;
  /** Page title (from document.title) */
  title: string;
  /** Current page URL */
  url: string;
  /** Favicon URL (fetched from Google's favicon service) */
  favicon?: string;
  /** Whether this tab is currently active/focused */
  active: boolean;
}

/**
 * Input events that can be forwarded to the remote browser.
 * Used for mouse, keyboard, scroll, and touch interactions.
 */
export interface InputEvent {
  type: "mouse" | "keyboard" | "scroll" | "touch";
  mouseEvent?: {
    type: "click" | "dblclick" | "mousedown" | "mouseup" | "mousemove" | "contextmenu";
    x: number;
    y: number;
    button: number;
  };
  keyboardEvent?: {
    type: "keydown" | "keyup" | "keypress";
    key: string;
    code: string;
    modifiers: { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean };
  };
  scrollEvent?: {
    deltaX: number;
    deltaY: number;
    x: number;
    y: number;
  };
}

/**
 * Information about a file download in progress or completed.
 * Used to display download progress in the downloads bar.
 */
export interface DownloadInfo {
  id: string;
  filename: string;
  url: string;
  totalBytes: number;
  receivedBytes: number;
  state: "in_progress" | "completed" | "cancelled" | "interrupted";
}

/**
 * Session information returned by the Browserbase API.
 * Contains connection URLs for CDP and live view embedding.
 */
export interface BrowserbaseSession {
  id: string;
  status: string;
  connectUrl: string;
  debugUrl: string;
}

// IPC channel names
export const IPC_CHANNELS = {
  // Session management
  SESSION_CREATED: "session:created",
  SESSION_ERROR: "session:error",
  SESSION_DISCONNECTED: "session:disconnected",

  // Navigation
  NAVIGATE_TO: "navigate:to",
  NAVIGATE_BACK: "navigate:back",
  NAVIGATE_FORWARD: "navigate:forward",
  NAVIGATE_RELOAD: "navigate:reload",
  NAVIGATE_HOME: "navigate:home",
  URL_CHANGED: "url:changed",

  // Tab management
  TABS_UPDATED: "tabs:updated",
  TAB_SWITCH: "tab:switch",
  TAB_NEW: "tab:new",
  TAB_CLOSE: "tab:close",

  // Downloads
  DOWNLOAD_STARTED: "download:started",
  DOWNLOAD_PROGRESS: "download:progress",
  DOWNLOAD_COMPLETED: "download:completed",

  // Window controls
  WINDOW_MINIMIZE: "window:minimize",
  WINDOW_MAXIMIZE: "window:maximize",
  WINDOW_CLOSE: "window:close",

  // Bookmarks
  BOOKMARKS_TOGGLE: "bookmarks:toggle",

  // Debug URL (Browserbase live view)
  GET_DEBUG_URL: "debug:get-url",
  DEBUG_URL_CHANGED: "debug:url-changed",

  // Menu actions
  OPEN_DEVTOOLS: "menu:open-devtools",
  TOGGLE_FULLSCREEN: "menu:toggle-fullscreen",
  ZOOM_IN: "menu:zoom-in",
  ZOOM_OUT: "menu:zoom-out",
  ZOOM_RESET: "menu:zoom-reset",
} as const;

// App settings
export interface AppSettings {
  appearance: {
    theme: "light" | "dark" | "system";
    showBookmarksBar: boolean;
  };
  browserbase: {
    defaultUrl: string;
    stealthMode: "advanced";
  };
}

// Default settings
export const DEFAULT_SETTINGS: AppSettings = {
  appearance: {
    theme: "system",
    showBookmarksBar: true,
  },
  browserbase: {
    defaultUrl: "https://www.google.com",
    stealthMode: "advanced",
  },
};

// Viewport configuration
export interface ViewportConfig {
  width: number;
  height: number;
}

// Session configuration for Browserbase
export interface SessionConfig {
  projectId?: string;
  browserSettings?: {
    stealth?: boolean;
    viewport?: ViewportConfig;
    deviceScaleFactor?: number;
  };
}

// Tab information from remote browser
export interface TabInfo {
  id: string;
  targetId: string;
  title: string;
  url: string;
  favicon?: string;
  active: boolean;
}

// Input events to forward to remote browser
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

// Download information
export interface DownloadInfo {
  id: string;
  filename: string;
  url: string;
  totalBytes: number;
  receivedBytes: number;
  state: "in_progress" | "completed" | "cancelled" | "interrupted";
}

// Browserbase session information
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

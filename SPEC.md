# Desktop Browserbase - Specification

## Overview

An Electron application that provides a high-fidelity Chrome browser interface while proxying all browsing activity through a Browserbase remote browser with advanced stealth enabled. The app enables desktop embedding support for Browserbase remote browsers, making cloud browser sessions appear and behave as native desktop Chrome instances.

## Goals

1. **Native Chrome Experience**: Users should feel like they're using a real Chrome browser installed on their desktop
2. **Browserbase Integration**: All browsing happens through Browserbase's stealth-enabled remote browsers
3. **Seamless Interaction**: Full mouse, keyboard, and scrolling support forwarded to the remote session
4. **Tab Synchronization**: Local tabs mirror the tabs open in the remote Browserbase session

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Electron App                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Chrome-like UI Shell                 │  │
│  │  [←] [→] [↻] [🏠]  [ URL Bar                  ]   │  │
│  │  ┌─────────┬─────────┬─────────┐                  │  │
│  │  │  Tab 1  │  Tab 2  │    +    │                  │  │
│  │  └─────────┴─────────┴─────────┘                  │  │
│  │  ☆ Bookmarks Bar                                  │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │         Browserbase Live-View Embed               │  │
│  │              (iframe / webview)                   │  │
│  │                                                   │  │
│  │    Remote browser session rendered here           │  │
│  │                                                   │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Downloads Bar (when active)          │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
            │
            │ WebSocket / API
            ▼
┌─────────────────────────────────────────────────────────┐
│                 Browserbase Cloud                       │
│  ┌───────────────────────────────────────────────────┐  │
│  │     Remote Browser (Advanced Stealth Enabled)     │  │
│  │                                                   │  │
│  │  - Real Chrome instance                           │  │
│  │  - Stealth fingerprinting                         │  │
│  │  - Proxy rotation (optional)                      │  │
│  │  - Session persistence                            │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Technical Specifications

### Platform & Framework

| Component | Technology |
|-----------|------------|
| Framework | Electron (latest stable) |
| UI | HTML/CSS/TypeScript |
| Build System | electron-builder |
| Target Platform | Windows (primary), macOS/Linux (secondary) |

### Browserbase Integration

| Feature | Implementation |
|---------|----------------|
| Live View | Native Browserbase live-view iframe embed |
| Session Creation | New session per app window |
| Authentication | Environment variables (`BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`) |
| Stealth Mode | Advanced stealth enabled by default |

### Session Configuration

```typescript
interface SessionConfig {
  projectId: string;
  browserSettings: {
    stealth: "advanced";
    viewport: { width: number; height: number };
  };
  // Additional Browserbase session options as needed
}
```

## UI Components

### 1. Title Bar / Window Controls

- Standard window controls (minimize, maximize, close)
- Frameless window with custom title bar to match Chrome's appearance
- Window draggable from title bar area

### 2. Navigation Bar

| Element | Functionality |
|---------|---------------|
| Back Button | Navigate back in remote browser history |
| Forward Button | Navigate forward in remote browser history |
| Reload Button | Reload current page in remote browser |
| Home Button | Navigate to default home page |
| URL Bar | Display current URL, allow URL entry for navigation |
| URL Bar Icons | SSL indicator, bookmark star |

### 3. Tab Bar

- Display tabs mirroring the remote Browserbase session's tabs
- Tab operations sync to remote browser via CDP:
  - New tab (Ctrl+T)
  - Close tab (Ctrl+W)
  - Switch tabs (Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+1-9)
  - Tab dragging (visual only, reordering handled remotely)
- Tab appearance matches Chrome stable (rounded tabs, close buttons, favicons)

### 4. Bookmarks Bar

- Visual bookmarks bar below the navigation bar
- Toggleable visibility (Ctrl+Shift+B)
- Static/decorative for initial version
- Future: Sync with Browserbase session bookmarks

### 5. Content Area

- Browserbase live-view embed filling the main content area
- Full interaction support:
  - Mouse events (click, double-click, right-click, hover, drag)
  - Keyboard events (typing, shortcuts)
  - Scroll events (wheel, touch scroll)
  - Touch events (for touch-enabled displays)

### 6. Downloads Bar

- Appears at bottom when downloads are detected in remote session
- Shows download progress, filename, and status
- Actions: Open, Show in folder, Cancel
- Auto-hides after completion (with delay)

## Interaction Layer

### Input Forwarding

All user input in the content area must be captured and forwarded to the Browserbase session:

```typescript
interface InputEvent {
  type: "mouse" | "keyboard" | "scroll" | "touch";
  // Mouse events
  mouseEvent?: {
    type: "click" | "dblclick" | "mousedown" | "mouseup" | "mousemove" | "contextmenu";
    x: number;
    y: number;
    button: number;
  };
  // Keyboard events
  keyboardEvent?: {
    type: "keydown" | "keyup" | "keypress";
    key: string;
    code: string;
    modifiers: { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean };
  };
  // Scroll events
  scrollEvent?: {
    deltaX: number;
    deltaY: number;
    x: number;
    y: number;
  };
}
```

### CDP Communication

Use Chrome DevTools Protocol for:
- Tab management (list, create, close, activate)
- Navigation commands
- URL retrieval
- Download monitoring
- Page events

## Chrome UI Fidelity Requirements

### Visual Matching (Chrome Stable - v130+)

1. **Color Scheme**
   - Tab bar background: `#DEE1E6` (light mode)
   - Active tab: `#FFFFFF`
   - URL bar background: `#F1F3F4`
   - Accent color: `#1A73E8` (Google Blue)

2. **Typography**
   - System font stack matching Chrome
   - URL bar: 14px
   - Tab titles: 12px

3. **Icons**
   - Use Chrome's icon set or pixel-perfect recreations
   - Back, Forward, Reload, Home, Star, Menu (three dots)

4. **Spacing & Layout**
   - Tab height: 34px
   - Navigation bar height: 40px
   - Bookmarks bar height: 28px
   - URL bar border-radius: 24px

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+T | New tab |
| Ctrl+W | Close tab |
| Ctrl+Tab | Next tab |
| Ctrl+Shift+Tab | Previous tab |
| Ctrl+L | Focus URL bar |
| Ctrl+R / F5 | Reload |
| Alt+Left | Back |
| Alt+Right | Forward |
| Ctrl+Shift+B | Toggle bookmarks bar |
| F11 | Toggle fullscreen |

## Configuration

### Environment Variables

```bash
# Required
BROWSERBASE_API_KEY=bb_live_xxxxxxxxxxxx
BROWSERBASE_PROJECT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Optional
BROWSERBASE_DEFAULT_URL=https://www.google.com
BROWSERBASE_PROXY_ENABLED=true
```

### App Settings (Future)

```json
{
  "appearance": {
    "theme": "system",
    "showBookmarksBar": true
  },
  "browserbase": {
    "defaultUrl": "https://www.google.com",
    "stealthMode": "advanced"
  }
}
```

## Project Structure

```
desktop-browserbase/
├── src/
│   ├── main/                 # Electron main process
│   │   ├── index.ts          # Main entry point
│   │   ├── browserbase.ts    # Browserbase API client
│   │   ├── session.ts        # Session management
│   │   └── ipc.ts            # IPC handlers
│   ├── renderer/             # Electron renderer process
│   │   ├── index.html        # Main window HTML
│   │   ├── styles/
│   │   │   ├── chrome.css    # Chrome UI styles
│   │   │   └── components.css
│   │   ├── components/
│   │   │   ├── TitleBar.ts
│   │   │   ├── TabBar.ts
│   │   │   ├── NavigationBar.ts
│   │   │   ├── BookmarksBar.ts
│   │   │   ├── ContentArea.ts
│   │   │   └── DownloadsBar.ts
│   │   └── app.ts            # Renderer entry point
│   └── shared/               # Shared types and utilities
│       └── types.ts
├── assets/
│   └── icons/                # App and UI icons
├── package.json
├── tsconfig.json
├── electron-builder.yml
└── README.md
```

## Implementation Phases

### Phase 1: Core Shell
- [ ] Electron app scaffolding
- [ ] Basic Chrome UI layout (non-functional)
- [ ] Browserbase session creation on app launch
- [ ] Live-view embed displaying remote browser

### Phase 2: Interaction
- [ ] Input forwarding (mouse, keyboard, scroll)
- [ ] URL bar navigation
- [ ] Back/Forward/Reload buttons
- [ ] Basic tab display (read-only)

### Phase 3: Tab Synchronization
- [ ] CDP connection to remote browser
- [ ] Real-time tab list sync
- [ ] Tab switching
- [ ] New tab / close tab

### Phase 4: Polish
- [ ] High-fidelity Chrome styling
- [ ] Keyboard shortcuts
- [ ] Downloads bar
- [ ] Bookmarks bar (visual)
- [ ] Window state persistence

### Phase 5: Packaging & Testing
- [ ] Windows executable build
- [ ] Installer creation
- [ ] VM testing documentation
- [ ] Performance optimization

## Success Criteria

1. **Visual**: App is visually indistinguishable from Chrome at first glance
2. **Functional**: All navigation and tab operations work seamlessly
3. **Performance**: Input latency < 100ms, video stream smooth at 30fps+
4. **Stealth**: Remote sessions pass common bot detection (Cloudflare, etc.)
5. **Stability**: No crashes during extended use sessions

## Open Questions

1. How to handle Browserbase session timeouts/disconnects gracefully?
2. Should the app support multiple windows (each with its own BB session)?
3. File download handling - stream to local disk or keep in cloud?
4. Right-click context menu - forward to remote or local implementation?

## References

- [Browserbase Documentation](https://docs.browserbase.com)
- [Browserbase Live View](https://docs.browserbase.com/features/live-view)
- [Electron Documentation](https://www.electronjs.org/docs)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)

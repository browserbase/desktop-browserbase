# Desktop Browserbase

A high-fidelity Chrome browser interface that proxies all browsing activity through Browserbase verified remote browsers. This Electron application makes cloud browser sessions appear and behave as native desktop Chrome instances.

## Download

Download the latest release for your platform:

| Platform | Download |
|----------|----------|
| Windows | [Desktop Browserbase Setup.exe](https://github.com/browserbase/desktop-browserbase/releases/latest) |
| macOS | [Desktop Browserbase.dmg](https://github.com/browserbase/desktop-browserbase/releases/latest) |
| Linux | [Desktop Browserbase.AppImage](https://github.com/browserbase/desktop-browserbase/releases/latest) |

> **Note:** You'll need a [Browserbase](https://browserbase.com) account with API access to use this application.

### macOS Installation

Since the app is not signed with an Apple Developer certificate, macOS will block it.

**If you see "app is damaged" error**, run this in Terminal:
```bash
xattr -cr /Applications/Desktop\ Browserbase.app
```

**Standard installation:**
1. Download the `.dmg` or `.zip` file
2. For DMG: Open and drag the app to Applications
3. For ZIP: Extract and move to Applications
4. **Right-click** the app and select **"Open"**
5. Click **"Open"** in the security dialog

**Alternative:** Go to **System Settings > Privacy & Security** and click **"Open Anyway"**

## Features

- **Native Chrome Experience** - Pixel-perfect Chrome v130+ UI styling
- **Tab Management** - Full tab synchronization with remote browser sessions
- **Navigation** - Back, Forward, Reload, Home, URL bar with smart URL/search handling
- **Keyboard Shortcuts** - All standard Chrome shortcuts (Ctrl+T, Ctrl+W, Ctrl+Tab, etc.)
- **Dark Mode** - Automatic theme detection matching system preferences
- **Window State Persistence** - Remembers size and position between sessions
- **Bookmarks Bar** - Visual bookmarks bar (toggleable with Ctrl+Shift+B)
- **Downloads Bar** - Download progress tracking
- **Async Browser Sessions** - Optional deferred Browserbase session creation with readiness polling
- **Verified Browsers** - Verified Browser Mode enabled by default

## Prerequisites

- Node.js 18+
- npm or yarn
- Browserbase account with API access

## Setup

1. Clone and install dependencies:

```bash
cd desktop-browserbase
npm install
```

2. Set required environment variables:

```bash
export BROWSERBASE_API_KEY=bb_live_xxxxxxxxxxxx
```

Or create a `.env` file:

```env
BROWSERBASE_API_KEY=bb_live_xxxxxxxxxxxx
BROWSERBASE_DEFAULT_URL=https://www.google.com  # optional
BROWSERBASE_VERIFIED=true                       # optional, Scale plan; default true
BROWSERBASE_PROXIES=true                        # optional, paid plan; default true
BROWSERBASE_ASYNC_BROWSERS=true                 # optional, enables async browsers
BROWSERBASE_ASYNC_READY_TIMEOUT_MS=120000       # optional
BROWSERBASE_ASYNC_POLL_INTERVAL_MS=1500         # optional
BROWSERBASE_AUTOMATION_SERVER=false             # optional, exposes local CDP metadata
BROWSERBASE_AUTOMATION_PORT=0                   # optional, 0 selects a free port
BROWSERBASE_ACCELERATED_SCROLL=false            # optional, sends wheel input over CDP
```

For packaged app launches, especially when opening the macOS app from Finder,
shell exports are usually not available. The app also loads `.env` and
`browserbase.env` files from these locations, without overriding values that
are already present in the environment:

- The current working directory
- The app data directory, such as `~/Library/Application Support/Desktop Browserbase/` on macOS
- Your home directory

### Browser Automation Integrations

Desktop Browserbase can expose an opt-in localhost metadata endpoint for
automation libraries that need the active Browserbase CDP URL:

```bash
BROWSERBASE_AUTOMATION_SERVER=true npm start
```

When enabled, the app binds to `127.0.0.1` only and writes `automation.json` in
the app data directory. The descriptor includes `/session`, `/json/version`,
and `/json/list` endpoints. Use the returned `connectUrl` or
`webSocketDebuggerUrl` with libraries that support CDP, such as Playwright's
`chromium.connectOverCDP`.

The endpoint is disabled by default because the CDP URL includes credentials for
the Browserbase session.

### Accelerated Scrolling

Live view handles mouse and keyboard input by default. For human browsing on
pages with standard scroll behavior, you can opt into CDP wheel dispatch:

```bash
BROWSERBASE_ACCELERATED_SCROLL=true npm start
```

This is disabled by default because some pages implement custom scroll behavior
inside the live-view layer.

### Sync Browser to Folder

Open the browser's three-dot menu and choose **Choose sync folder...**. The app
creates a managed `browser/` directory inside the selected folder and starts
mirroring the current Browserbase session. **Sync browser to folder** turns the
feature on or off. The selection is remembered across app launches.

Use **Open browser folder** or **Open current tab's folder** from the same menu.
The toolbar shows syncing, reconnecting, or error status; details appear in the
menu. Downloads show **Saved locally** and **Show in folder** after their bytes
have arrived on this computer.

```text
<chosen folder>/browser/
  active.json
  <CDP target ID>/
    metadata.json
    screencast.jpg
    page.html
    network.log
    console.log
    downloads.log
    downloads/<download GUID>/<filename>
    uploads.log
    uploads/
```

The mirror uses a separate Electron utility process and CDP connection. Live
View continues to display and control the browser. There is no separate CLI,
Node installation, or API-key setup needed beyond the app's existing settings.
The app requests Browserbase keep-alive so restarting the mirror's CDP
connection does not end the remote session. Keep-alive requires a paid plan;
when unavailable, browsing remains available and folder sync reports the
requirement. The app explicitly releases its session on shutdown.
An unclean app termination leaves the remote session running until its timeout.

- Screenshots use `Page.startScreencast` with `everyNthFrame: 1`. Every received
  frame is written atomically, then acknowledged. Slow storage applies
  backpressure instead of building an unbounded queue or discarding frames.
- `page.html` samples each page's `document.documentElement.outerHTML` every two
  seconds. It is a DOM snapshot, not a complete offline copy of the website.
- Network and console logs contain newline-delimited JSON from CDP `Network`
  and `Runtime` events. Network response bodies are not collected.
- Downloads use CDP start/progress events and Browserbase's session downloads
  archive. Archive availability is retried. Files without an unambiguous match
  are preserved under `_unattributed/downloads/`, with their metadata in
  `_unattributed/metadata.json`; they are never guessed into another tab's folder.
- Drop files directly into a page's `uploads/` directory to upload them. Metadata
  records the resulting `remotePath` and `fileUrl`. Remote filenames include a
  page prefix to prevent collisions between tabs. Open the recorded `file://`
  URL in the app's address bar when the remote browser permits file navigation.
  Some Browserbase policies block `file://` URLs with
  `ERR_BLOCKED_BY_ADMINISTRATOR`; uploads still work with file inputs using the
  recorded remote path. Temporary
  files, subdirectories, and symbolic links are ignored.

A new session or an explicit sync restart clears the managed mirror directory.
Automatic reconnection to the same session preserves logs, uploads, and
downloads. Existing non-mirror `browser/` folders are refused rather than
cleared. Stop sync before retaining a separate copy of any files you need to
keep across fresh sessions.

Mirroring is opt-in because these local files can contain page content, network
headers, console output, and downloaded documents. Credentials used to connect
to Browserbase are not included in sync status or the folder ownership file.

When the optional automation server is enabled, `/session` includes `mirror`
status, its directory, and the active page ID for local tools.

Run `npm test` for the capture, lifecycle, and transfer tests. The opt-in
`node test/cloud-smoke.cjs` test requires `BROWSERBASE_API_KEY`, creates one real
Browserbase session, checks uploads/downloads and Live View alongside capture,
then closes the session. Run `npm run build` first.

3. Build and run:

```bash
npm run build
npm start
```

## Development

```bash
# Build TypeScript
npm run build

# Start the app
npm start

# Development mode (build + start)
npm run dev

# Create distributable package
npm run dist
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd/Ctrl+T | New tab |
| Cmd/Ctrl+W | Close tab |
| Cmd/Ctrl+Tab | Next tab |
| Cmd/Ctrl+Shift+Tab | Previous tab |
| Cmd/Ctrl+1-9 | Switch to specific tab |
| Cmd/Ctrl+L | Focus URL bar |
| Cmd/Ctrl+R / F5 | Reload |
| Cmd+Left / Cmd+[ on macOS, Alt+Left elsewhere | Back |
| Cmd+Right / Cmd+] on macOS, Alt+Right elsewhere | Forward |
| Cmd/Ctrl+Shift+B | Toggle bookmarks bar |
| F11 | Toggle fullscreen |

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
│  │              (iframe)                             │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
            │
            │ WebSocket / API
            ▼
┌─────────────────────────────────────────────────────────┐
│                 Browserbase Cloud                       │
│  ┌───────────────────────────────────────────────────┐  │
│  │     Remote Browser (Verified Browser Mode)        │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Project Structure

```
desktop-browserbase/
├── src/
│   ├── main/                 # Electron main process
│   │   ├── index.ts          # Main entry point
│   │   ├── browserbase.ts    # Browserbase API client
│   │   ├── session.ts        # Session management
│   │   ├── ipc.ts            # IPC handlers
│   │   └── preload.ts        # Preload script
│   ├── renderer/             # Electron renderer process
│   │   ├── index.html        # Main window HTML
│   │   ├── styles/
│   │   │   ├── chrome.css    # Chrome UI styles
│   │   │   └── components.css
│   │   ├── components/       # UI components
│   │   └── app.ts            # Renderer entry point
│   └── shared/               # Shared types and utilities
│       └── types.ts
├── assets/
│   └── icons/                # App icons
├── package.json
├── tsconfig.json
└── electron-builder.yml
```

## Troubleshooting

### "Electron failed to install correctly"

```bash
rm -rf node_modules/electron
npm install
node node_modules/electron/install.js
```

### "Missing environment variables"

Make sure `BROWSERBASE_API_KEY` is set before running the app,
or place it in `.env` or `browserbase.env` in one of the supported config locations.

### Verified / proxies unavailable

Verified Browser Mode is Scale-only and includes proxies. Both are on by
default. If Verified is unavailable, the app retries with proxies still on. If
proxies are also unavailable, it retries without either and logs that the
session will work much better with Verified and Browserbase proxies (with docs
links).

You can also opt out before launch (same notice applies):

```env
BROWSERBASE_VERIFIED=false
BROWSERBASE_PROXIES=false
```

- [Verified](https://docs.browserbase.com/platform/identity/overview)
- [Proxies](https://docs.browserbase.com/platform/identity/proxies)

### Connection issues

- Check your internet connection
- Verify your API key is valid
- Check the Browserbase status page
- Async Browser sessions are disabled by default. Set `BROWSERBASE_ASYNC_BROWSERS=true` to use deferred session creation.
- If async provisioning is slow, raise `BROWSERBASE_ASYNC_READY_TIMEOUT_MS`. The app polls every `BROWSERBASE_ASYNC_POLL_INTERVAL_MS` milliseconds while an async session is `PENDING`.

## Building for Distribution

To create distributable packages for all platforms:

```bash
# Build for your current platform
npm run dist

# Build for specific platforms (requires appropriate OS or CI)
npm run dist -- --win      # Windows (NSIS installer)
npm run dist -- --mac      # macOS (DMG)
npm run dist -- --linux    # Linux (AppImage)
```

Built packages will be output to the `release/` directory.

### Platform Requirements

- **Windows builds:** Can be built on Windows or via CI
- **macOS builds:** Must be built on macOS (for code signing)
- **Linux builds:** Can be built on Linux or via CI

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes and add tests if applicable
4. Ensure the build passes: `npm run build`
5. Commit your changes: `git commit -m "Add my feature"`
6. Push to the branch: `git push origin feature/my-feature`
7. Open a Pull Request

### Development Guidelines

- Follow the existing code style (TypeScript, ESLint)
- Add JSDoc comments for new public APIs
- Test on multiple platforms when possible
- Keep commits focused and atomic

## Security

This application handles sensitive credentials (API keys). Please:

- Never commit `.env` files or API keys
- Use environment variables for configuration
- Report security vulnerabilities via GitHub Security Advisories

## License

MIT

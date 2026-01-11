# Desktop Browserbase

A high-fidelity Chrome browser interface that proxies all browsing activity through Browserbase remote browsers with advanced stealth enabled. This Electron application makes cloud browser sessions appear and behave as native desktop Chrome instances.

## Features

- **Native Chrome Experience** - Pixel-perfect Chrome v130+ UI styling
- **Tab Management** - Full tab synchronization with remote browser sessions
- **Navigation** - Back, Forward, Reload, Home, URL bar with smart URL/search handling
- **Keyboard Shortcuts** - All standard Chrome shortcuts (Ctrl+T, Ctrl+W, Ctrl+Tab, etc.)
- **Dark Mode** - Automatic theme detection matching system preferences
- **Window State Persistence** - Remembers size and position between sessions
- **Bookmarks Bar** - Visual bookmarks bar (toggleable with Ctrl+Shift+B)
- **Downloads Bar** - Download progress tracking
- **Stealth Mode** - Advanced stealth enabled by default for bot detection bypass

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
export BROWSERBASE_PROJECT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Or create a `.env` file:

```env
BROWSERBASE_API_KEY=bb_live_xxxxxxxxxxxx
BROWSERBASE_PROJECT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
BROWSERBASE_DEFAULT_URL=https://www.google.com  # optional
```

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
| Ctrl+T | New tab |
| Ctrl+W | Close tab |
| Ctrl+Tab | Next tab |
| Ctrl+Shift+Tab | Previous tab |
| Ctrl+1-9 | Switch to specific tab |
| Ctrl+L | Focus URL bar |
| Ctrl+R / F5 | Reload |
| Alt+Left | Back |
| Alt+Right | Forward |
| Ctrl+Shift+B | Toggle bookmarks bar |
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
│  │     Remote Browser (Advanced Stealth Enabled)     │  │
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

Make sure `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` are set before running the app.

### Connection issues

- Check your internet connection
- Verify your API key is valid
- Check the Browserbase status page

## License

MIT

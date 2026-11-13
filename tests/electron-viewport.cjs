// Run after npm run build: electron tests/electron-viewport.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { sessionManager } = require('../dist/main/session');
const { IPC_CHANNELS } = require('../dist/shared/types');
const config = require('../dist/main/config');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-viewport-test-'));
app.setPath('userData', profile);
process.env.BROWSERBASE_API_KEY = 'synthetic-test-key';
delete process.env.BROWSERBASE_AUTOMATION_SERVER;
config.loadEnvironmentConfig = () => [];
const updates = [];
let initialViewport;
sessionManager.updateViewport = async (width, height) => { updates.push({ width, height }); };
sessionManager.initialize = async () => { initialViewport = updates.at(-1); return { id: 'synthetic-session' }; };
sessionManager.getDebugUrl = () => 'https://www.browserbase.com/devtools-fullscreen-compiled/index.html';
const timeout = setTimeout(() => { console.error('Viewport test timed out'); app.exit(1); }, 20000);
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Timed out waiting for viewport update');
}
app.whenReady().then(async () => {
  const guestSession = session.fromPartition('persist:browserbase');
  guestSession.protocol.handle('https', () => new Response('<!doctype html><html><body style="font:18px system-ui;padding:36px;background:#f7f9fc"><h1>Viewport sizing fixture</h1><p>The desktop reports the visible content area after resizing, toolbar changes, and zoom.</p></body></html>', { headers: { 'content-type': 'text/html' } }));
  let passed = false;
  try {
    let window;
    await until(() => { window = BrowserWindow.getAllWindows()[0]; return window; });
    const shell = window.webContents;
    await until(() => shell.executeJavaScript('!!window.app && !!window.electronAPI'));
    const layout = () => shell.executeJavaScript('(() => { const r=document.getElementById("live-view-frame").getBoundingClientRect(); return {width:Math.round(r.width),height:Math.round(r.height)}; })()');
    await until(() => initialViewport);
    assert.deepEqual(initialViewport, await layout());
    const evidence = [];
    const expectSize = async (name, expected) => {
      await until(async () => JSON.stringify(updates.at(-1)) === JSON.stringify(await layout()));
      assert.deepEqual(await layout(), expected);
      evidence.push({ name, ...expected });
    };
    window.setContentSize(800, 600);
    await expectSize('window resized', { width: 800, height: 520 });
    await shell.executeJavaScript('window.electronAPI.toggleBookmarks()');
    await expectSize('bookmarks shown', { width: 800, height: 492 });
    shell.send(IPC_CHANNELS.DOWNLOAD_STARTED, { id: 'synthetic-download', filename: 'sample.txt', receivedBytes: 10, totalBytes: 100, state: 'in_progress' });
    await expectSize('downloads shown', { width: 800, height: 444 });
    if (process.env.DESKTOP_TEST_SCREENSHOT) fs.writeFileSync(process.env.DESKTOP_TEST_SCREENSHOT, (await shell.capturePage()).toPNG());
    shell.setZoomFactor(1.25);
    await expectSize('shell zoom 125 percent', { width: 640, height: 324 });
    shell.setZoomFactor(1);
    await shell.executeJavaScript('window.app.getBookmarksBar().hide(); window.app.getDownloadsBar().hide()');
    window.setContentSize(400, 300);
    await expectSize('small window', { width: 400, height: 220 });
    const count = updates.length;
    await shell.executeJavaScript('window.electronAPI.updateViewport(0, Infinity)');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(updates.length, count);
    console.log('PASS: measured viewport sizing', JSON.stringify(evidence));
    passed = true;
  } catch (error) { console.error(error); }
  finally {
    clearTimeout(timeout);
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    guestSession.protocol.unhandle('https');
    fs.rmSync(profile, { recursive: true, force: true });
    app.exit(passed ? 0 : 1);
  }
});
require('../dist/main/index');

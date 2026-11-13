// Run after npm run build: electron tests/electron-security.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { sessionManager } = require('../dist/main/session');
const { IPC_CHANNELS } = require('../dist/shared/types');
const config = require('../dist/main/config');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-security-test-'));
app.setPath('userData', userData);
// Keep cloud session provisioning out of this local Electron boundary test.
process.env.BROWSERBASE_API_KEY = 'synthetic-test-key';
delete process.env.BROWSERBASE_AUTOMATION_SERVER;
config.loadEnvironmentConfig = () => [];
sessionManager.initialize = async () => ({ id: 'synthetic-session' });
sessionManager.getDebugUrl = async () => 'https://www.browserbase.com/devtools-fullscreen/inspector.html';
let newTabs = 0;
sessionManager.newTab = async () => { newTabs++; };
let mainWindow;
let guest;
let done = false;
let externalFixtureRequests = 0;
const timeout = setTimeout(() => { console.error('Electron security test timed out'); app.exit(1); }, 20000);

async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for Electron state');
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() === 'webview') guest = contents;
});
app.whenReady().then(async () => {
  const fixtureSession = session.fromPartition('persist:browserbase');
  fixtureSession.protocol.handle('https', (request) => {
    if (!request.url.startsWith('https://www.browserbase.com/')) externalFixtureRequests++;
    return new Response(`<!doctype html>
    <html><head><title>Security test fixture</title></head><body style="font-family:system-ui;background:#f6f8fb;color:#17273a;padding:60px">
    <h1>Desktop Browserbase</h1><p>Local security test fixture</p>
    <p>The live-view guest is isolated from the desktop shell.</p>
    <button id="fixture-button">Test interaction</button></body></html>`, {
      headers: { 'content-type': 'text/html' },
    });
  });
  try {
    await until(() => { mainWindow = BrowserWindow.getAllWindows()[0]; return mainWindow; });
    await until(() => guest && guest.getURL().startsWith('https://www.browserbase.com/') && !guest.isLoading());
    const shell = mainWindow.webContents;
    await until(() => shell.executeJavaScript('!!window.app && !!window.electronAPI'));
    assert.equal(shell.getLastWebPreferences().sandbox, true);
    assert.equal(shell.getLastWebPreferences().contextIsolation, true);
    assert.equal(await shell.executeJavaScript('typeof require'), 'undefined');
    assert.equal((await shell.executeJavaScript('window.electronAPI.newTab()')).success, true);
    assert.equal(newTabs, 1);

    // Untrusted remote metadata remains text/attributes, even if it contains markup.
    shell.send(IPC_CHANNELS.TABS_UPDATED, [{ id: 'tab-0', targetId: 'test', title: '<img src=x onerror="window.__injected=true">', url: 'https://example.test', favicon: 'x" onerror="window.__injected=true', active: true }]);
    await until(() => shell.executeJavaScript('document.querySelector(".tab-title").textContent.includes("onerror")'));
    assert.equal(await shell.executeJavaScript('!!window.__injected || !!document.querySelector(".tab-title img") || !!document.querySelector(".tab-favicon[onerror]")'), false);
    assert.equal(await shell.executeJavaScript(`(() => { const script=document.createElement('script'); script.textContent='window.__inline=true'; document.body.append(script); return !!window.__inline; })()`), false);
    assert.equal(await shell.executeJavaScript(`(() => { try { eval('1'); return false; } catch { return true; } })()`), true);

    const originalUrl = shell.getURL();
    await shell.executeJavaScript(`window.location.href = 'https://example.test/'; void 0;`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(shell.getURL(), originalUrl);
    assert.equal(await shell.executeJavaScript(`window.open('https://example.test/') === null`), true);

    // A second window carrying the same preload still cannot call the shell's IPC.
    const outsider = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve('dist/main/preload.js'), sandbox: true, contextIsolation: true } });
    await outsider.loadURL('data:text/html,<title>Untrusted caller</title>');
    assert.match(await outsider.webContents.executeJavaScript('window.electronAPI.newTab().then(() => "allowed", error => error.message)'), /Untrusted IPC sender/);
    assert.equal(newTabs, 1);
    const initialZoom = shell.getZoomLevel();
    await outsider.webContents.executeJavaScript('window.electronAPI.zoomIn()');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(shell.getZoomLevel(), initialZoom);
    outsider.destroy();

    // A permitted live-view guest never gets a preload, Node, or popup permissions.
    const guestPreferences = guest.getLastWebPreferences();
    assert.equal(guestPreferences.sandbox, true);
    assert.equal(guestPreferences.nodeIntegration, false);
    assert.equal(guestPreferences.contextIsolation, true);
    assert.ok(!guestPreferences.preload);
    assert.equal(await guest.executeJavaScript('typeof require'), 'undefined');
    assert.equal(await guest.executeJavaScript('typeof window.electronAPI'), 'undefined');
    assert.equal(await guest.executeJavaScript(`window.open('https://example.test/') === null`), true);
    assert.equal(await guest.executeJavaScript('Notification.requestPermission()'), 'denied');
    const guestUrl = guest.getURL();
    await guest.executeJavaScript(`window.location.href = 'https://example.test/'; void 0;`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(guest.getURL(), guestUrl);

    let rejectedAttachment = false;
    shell.once('will-attach-webview', (event) => { rejectedAttachment = event.defaultPrevented; });
    await shell.executeJavaScript(`(() => { const view=document.createElement('webview'); view.setAttribute('partition','persist:browserbase'); view.setAttribute('preload', ${JSON.stringify(path.resolve('dist/main/preload.js'))}); view.setAttribute('nodeintegration',''); view.src='https://example.test/'; document.body.append(view); })()`);
    await until(() => rejectedAttachment);
    assert.equal(rejectedAttachment, true);

    const navigationError = await shell.executeJavaScript(`document.getElementById('live-view-frame').loadURL('https://example.test/').then(() => 'allowed', error => error.message)`);
    assert.match(navigationError, /ERR_FAILED|ERR_BLOCKED_BY_CLIENT/);
    assert.equal(externalFixtureRequests, 0);
    await shell.executeJavaScript(`document.getElementById('live-view-frame').loadURL(${JSON.stringify(guestUrl)})`);
    await until(() => guest.getURL() === guestUrl && !guest.isLoading());

    await shell.executeJavaScript(`window.app.showStatus('Synthetic connection error', 'error'); window.app.hideStatus(); window.app.getContentArea().showError('<img src=x onerror="window.__injected=true">')`);
    assert.equal(await shell.executeJavaScript('!!document.querySelector(".retry-connection") && !document.querySelector(".retry-connection").hasAttribute("onclick") && !document.querySelector("#loading-overlay img")'), true);
    await shell.executeJavaScript('window.app.getContentArea().hideLoading()');

    shell.send(IPC_CHANNELS.TABS_UPDATED, [{ id: 'tab-0', targetId: 'test', title: 'Security test fixture', url: 'https://example.test', active: true }]);
    await until(() => shell.executeJavaScript('document.querySelector(".tab-title").textContent === "Security test fixture"'));
    let hardenedGuest;
    shell.once('did-attach-webview', (_event, attached) => { hardenedGuest = attached; });
    await shell.executeJavaScript(`(() => {
      const view=document.createElement('webview');
      view.id='hostile-options-test';
      view.setAttribute('partition','persist:browserbase');
      view.setAttribute('preload', ${JSON.stringify(path.resolve('dist/main/preload.js'))});
      view.setAttribute('nodeintegration','');
      view.setAttribute('allowpopups','');
      view.setAttribute('webpreferences','contextIsolation=no,sandbox=no,webSecurity=no');
      view.src=${JSON.stringify(guestUrl)};
      document.body.append(view);
    })()`);
    await until(() => hardenedGuest && !hardenedGuest.isLoading());
    const hardenedPreferences = hardenedGuest.getLastWebPreferences();
    assert.equal(hardenedPreferences.sandbox, true);
    assert.equal(hardenedPreferences.nodeIntegration, false);
    assert.equal(hardenedPreferences.contextIsolation, true);
    assert.equal(hardenedPreferences.webSecurity, true);
    assert.ok(!hardenedPreferences.preload);
    assert.equal(await hardenedGuest.executeJavaScript('typeof window.electronAPI'), 'undefined');
    await shell.executeJavaScript(`document.getElementById('hostile-options-test').remove()`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (process.env.DESKTOP_TEST_SCREENSHOT) fs.writeFileSync(process.env.DESKTOP_TEST_SCREENSHOT, (await shell.capturePage()).toPNG());
    done = true;
    console.log('PASS: sandboxed preload, trusted IPC, CSP, escaped metadata, navigation, popups, guest attachment and denied permissions');
  } catch (error) {
    console.error(error);
  } finally {
    clearTimeout(timeout);
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    await fixtureSession.protocol.unhandle('https');
    fs.rmSync(userData, { recursive: true, force: true });
    app.exit(done ? 0 : 1);
  }
});
require('../dist/main/index');

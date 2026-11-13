// Run after npm run build: electron tests/electron-startup.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { sessionManager } = require('../dist/main/session');
const config = require('../dist/main/config');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-startup-test-'));
app.setPath('userData', profile);
// Exercise macOS's persistent app lifecycle on every test host.
Object.defineProperty(process, 'platform', { value: 'darwin' });
process.env.BROWSERBASE_API_KEY = 'synthetic-test-key';
delete process.env.BROWSERBASE_AUTOMATION_SERVER;
config.loadEnvironmentConfig = () => [];
let stage = 'measurement';
let releaseMeasurement;
let releaseViewport;
let measured = false;
let initialized = 0;
sessionManager.initialize = async () => { initialized++; return { id: 'synthetic-session' }; };
sessionManager.cleanup = async () => {};
sessionManager.getDebugUrl = () => '';
sessionManager.updateViewport = async () => {
  if (stage === 'viewport' && measured && !releaseViewport) {
    await new Promise(resolve => { releaseViewport = resolve; });
  }
};
app.on('web-contents-created', (_event, contents) => {
  const execute = contents.executeJavaScript.bind(contents);
  contents.executeJavaScript = (code, ...args) => {
    if (code.includes('const rect = document.getElementById("live-view-frame")')) {
      measured = true;
      if (stage === 'measurement') return new Promise(resolve => { releaseMeasurement = resolve; });
    }
    return execute(code, ...args);
  };
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(20); }
  throw new Error('Timed out waiting for window startup');
}
const timeout = setTimeout(() => { console.error('Startup test timed out'); app.exit(1); }, 15000);
app.whenReady().then(async () => {
  let passed = false;
  try {
    await until(() => releaseMeasurement);
    BrowserWindow.getAllWindows()[0].close();
    await until(() => BrowserWindow.getAllWindows().length === 0);
    releaseMeasurement({ width: 800, height: 520 });
    await delay(100);
    assert.equal(initialized, 0, 'a closed window cannot start a session after measurement');

    stage = 'viewport'; measured = false;
    app.emit('activate');
    await until(() => releaseViewport);
    BrowserWindow.getAllWindows()[0].close();
    await until(() => BrowserWindow.getAllWindows().length === 0);
    releaseViewport();
    await delay(100);
    assert.equal(initialized, 0, 'a closed window cannot start a session after a viewport update');

    stage = 'ready';
    app.emit('activate');
    await until(() => initialized === 1);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    console.log('PASS: stale measurement and viewport updates cannot initialize a closed window; reopening starts normally');
    passed = true;
  } catch (error) { console.error(error); }
  finally {
    clearTimeout(timeout);
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    fs.rmSync(profile, { recursive: true, force: true });
    app.exit(passed ? 0 : 1);
  }
});
require('../dist/main/index');

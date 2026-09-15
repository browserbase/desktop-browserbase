// Opt-in live test. Creates and closes one Browserbase session.
const { _electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

async function until(check, timeout = 90000) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw lastError || new Error('Timed out waiting for smoke test condition');
}

(async () => {
  if (!process.env.BROWSERBASE_API_KEY) throw new Error('Set BROWSERBASE_API_KEY to run the cloud smoke test');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-browserbase-smoke-'));
  const userData = path.join(root, 'app-data');
  const directory = path.join(root, 'browser');
  await fs.mkdir(userData);
  await fs.writeFile(path.join(userData, 'browser-mirror-settings.json'), JSON.stringify({ enabled: true, parentDirectory: root }));
  let app;
  let sessionId;
  const sessionModule = path.resolve(__dirname, '../dist/main/session.js');
  const managerModule = path.resolve(__dirname, '../dist/main/mirror/manager.js');
  try {
    app = await _electron.launch({ args: [path.join(__dirname, 'electron-smoke-main.cjs')], timeout: 120000,
      env: { ...process.env, MIRROR_SMOKE_USER_DATA: userData, BROWSERBASE_DEFAULT_URL: 'https://example.com', BROWSERBASE_AUTOMATION_SERVER: 'false' } });
    const window = await app.firstWindow();
    await until(async () => {
      const status = await window.evaluate(() => window.electronAPI.getMirrorStatus());
      if (status.state === 'error') throw new Error(status.error);
      sessionId = status.sessionId;
      return status.state === 'syncing';
    });
    console.log('App and mirror connected');
    await app.evaluate(async (_, module) => { await require(module).sessionManager.initialize(); }, sessionModule);
    const initial = await app.evaluate((_, module) => require(module).sessionManager.getAutomationInfo(), sessionModule);
    assert(initial.tabs[0].targetId && !initial.tabs[0].targetId.startsWith('target-'));
    const pageId = initial.tabs.find(tab => tab.active).targetId;
    const pageDir = path.join(directory, pageId);
    await app.evaluate(async (_, module) => {
      const page = require(module).sessionManager.getActivePage();
      await page.setContent('<!doctype html><title>Mirror smoke test</title><body style="margin:0;background:#fafafa;font:24px sans-serif"><h1>Browser folder sync</h1><canvas width="600" height="300"></canvas><script>let n=0;setInterval(()=>{const c=document.querySelector("canvas").getContext("2d");c.fillStyle=n++%2?"#159a76":"#ef5375";c.fillRect(0,0,600,300)},100);console.log("mirror-smoke-console");fetch("https://example.com/?mirror-network-smoke").catch(()=>{});</script>');
    }, sessionModule);
    await until(async () => (await fs.readFile(path.join(pageDir, 'page.html'), 'utf8')).includes('Mirror smoke test'));
    await until(async () => (await fs.readFile(path.join(pageDir, 'console.log'), 'utf8')).includes('mirror-smoke-console'));
    await until(async () => (await fs.readFile(path.join(pageDir, 'network.log'), 'utf8')).includes('mirror-network-smoke'));
    const image = await fs.readFile(path.join(pageDir, 'screencast.jpg'));
    assert.equal(image[0], 0xff); assert.equal(image[1], 0xd8);
    const firstFrameTime = (await fs.stat(path.join(pageDir, 'screencast.jpg'))).mtimeMs;
    await until(async () => (await fs.stat(path.join(pageDir, 'screencast.jpg'))).mtimeMs > firstFrameTime);
    console.log('Live frames, HTML, console, and network verified');
    await app.evaluate(async (_, module) => {
      await require(module).sessionManager.getActivePage().evaluate(() => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['mirror-download-content'], { type: 'text/plain' }));
        a.download = 'mirror-smoke.txt'; document.body.append(a); a.click();
      });
    }, sessionModule);
    const download = await until(async () => {
      const meta = JSON.parse(await fs.readFile(path.join(pageDir, 'metadata.json'), 'utf8'));
      const item = meta.downloads.find(download => download.filename === 'mirror-smoke.txt');
      if (item?.syncState === 'error') throw new Error(item.error);
      return item?.syncState === 'synced' ? item : false;
    });
    assert.equal(await fs.readFile(download.localPath, 'utf8'), 'mirror-download-content');
    console.log('Cloud download synced locally');
    await fs.writeFile(path.join(pageDir, 'uploads', 'hello.html'), '<!doctype html><title>Uploaded smoke file</title><h1>remote-upload-ok</h1>');
    const upload = await until(async () => {
      const meta = JSON.parse(await fs.readFile(path.join(pageDir, 'metadata.json'), 'utf8'));
      return meta.uploads.find(upload => upload.filename === 'hello.html' && upload.state === 'uploaded');
    });
    const text = await app.evaluate(async (_, { module, remotePath }) => {
      const manager = require(module).sessionManager;
      const page = manager.getActivePage();
      await page.setContent('<!doctype html><title>Browser folder sync</title><h1>Browser folder sync</h1><p>Cloud upload verified</p><input id="upload" type="file">');
      const cdp = await manager.getCdpSessionForPage(page);
      const { root } = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#upload' });
      await cdp.send('DOM.setFileInputFiles', { nodeId, files: [remotePath] });
      return page.$eval('#upload', input => input.files[0].text());
    }, { module: sessionModule, remotePath: upload.remotePath });
    assert.match(text, /remote-upload-ok/);
    console.log('Uploaded bytes verified through file input');
    await app.evaluate(async (_, module) => require(module).sessionManager.newTab(), sessionModule);
    const tabs = await app.evaluate((_, module) => require(module).sessionManager.getTabs(), sessionModule);
    assert.equal(tabs.length, 2);
    const newId = tabs.find(tab => tab.active).targetId;
    await until(async () => JSON.parse(await fs.readFile(path.join(directory, 'active.json'), 'utf8')).pageId === newId);
    await app.evaluate(async (_, { module, id }) => require(module).sessionManager.switchTab(id), { module: sessionModule, id: pageId });
    await until(async () => JSON.parse(await fs.readFile(path.join(directory, 'active.json'), 'utf8')).pageId === pageId);
    await app.evaluate(async (_, module) => require(module).browserMirrorManager.disconnect(), managerModule);
    const beforeReconnect = (await fs.stat(path.join(pageDir, 'screencast.jpg'))).mtimeMs;
    await app.evaluate(async (_, { sessionModule, managerModule }) => {
      await require(managerModule).browserMirrorManager.attachSession(require(sessionModule).sessionManager.session);
    }, { sessionModule, managerModule });
    await until(async () => (await window.evaluate(() => window.electronAPI.getMirrorStatus())).state === 'syncing');
    await until(async () => (await fs.stat(path.join(pageDir, 'screencast.jpg'))).mtimeMs > beforeReconnect);
    assert.equal(await app.evaluate((_, module) => require(module).sessionManager.browser.isConnected(), sessionModule), true);
    assert.equal((await app.evaluate((_, module) => require(module).sessionManager.getTabs(), sessionModule)).length, 2);
    assert.equal(await fs.readFile(download.localPath, 'utf8'), 'mirror-download-content');
    assert((await fs.readdir(path.join(pageDir, 'uploads'))).includes('hello.html'));
    console.log('Tab selection and reconnect preservation verified');
    await window.locator('#btn-menu').click();
    await window.screenshot({ path: path.join(root, 'desktop.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(480, 740));
    await window.screenshot({ path: path.join(root, 'narrow.png') });
    console.log(`Screenshots: ${root}`);
    await app.evaluate(async (_, module) => require(module).sessionManager.cleanup(), sessionModule);
    const status = await window.evaluate(() => window.electronAPI.getMirrorStatus());
    assert.equal(status.state, 'waiting');
    console.log('Graceful shutdown verified');
  } finally {
    if (app) await app.close().catch(() => {});
    // Cleanup also runs if a failed test interrupts Electron's normal shutdown.
    if (sessionId) await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}`, {
      method: 'POST', headers: { 'X-BB-API-Key': process.env.BROWSERBASE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'REQUEST_RELEASE' }), signal: AbortSignal.timeout(15000),
    }).catch(() => {});
  }
})().catch(error => {
  console.error(String(error.message).replace(/(?:wss?|https?):\/\/\S+/g, '[endpoint]'));
  process.exitCode = 1;
});

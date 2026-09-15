const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

let userData;
const workers = [];
class FakeWorker extends EventEmitter {
  messages = [];
  postMessage(message) {
    this.messages.push(message);
    if (message.type === 'start') queueMicrotask(() => { this.emit('message', { type: 'prepared' }); this.emit('message', { type: 'ready' }); });
    if (message.type === 'stop') queueMicrotask(() => this.emit('exit', 0));
  }
  kill() { this.emit('exit', 0); }
}
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return {
    app: { getPath: () => userData }, shell: { openPath: async () => '', showItemInFolder: () => {} },
    utilityProcess: { fork: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } },
  };
  return originalLoad.call(this, name, ...args);
};
const { BrowserMirrorManager } = require('../dist/main/mirror/manager');
const { SessionManager } = require('../dist/main/session');
Module._load = originalLoad;

async function setup(t) {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-mirror-manager-'));
  const root = userData;
  const manager = new BrowserMirrorManager();
  t.after(async () => { await manager.endSession(); await fs.rm(root, { recursive: true, force: true }); });
  await manager.initialize();
  return manager;
}

test('desktop enables sync, forwards tabs, preserves files on reconnect, and stops with its session', async t => {
  const manager = await setup(t);
  const session = { id: 'session-one', connectUrl: 'ws://test', debugUrl: '', status: 'RUNNING' };
  await manager.setFolder(userData);
  assert.equal(manager.getStatus().state, 'waiting');
  await manager.attachSession(session);
  const first = workers.at(-1);
  assert.equal(manager.getStatus().state, 'syncing');
  assert.equal(first.messages.find(m => m.type === 'start').fresh, true);
  manager.syncTabs([{ id: 'page-A', targetId: 'page-A', active: true, url: '', title: '' }]);
  assert.equal(manager.getStatus().activePageId, 'page-A');
  assert.equal(first.messages.at(-1).type, 'tabs');
  await manager.disconnect();
  assert.equal(first.messages.at(-1).type, 'stop');
  await manager.attachSession(session);
  assert.equal(workers.at(-1).messages.find(m => m.type === 'start').fresh, false);
  await manager.endSession();
  assert.equal(manager.getStatus().state, 'waiting');
  assert.equal(manager.getStatus().sessionId, undefined);
});

test('worker errors are isolated to folder sync and can be retried', async t => {
  const manager = await setup(t);
  await manager.setFolder(userData);
  await manager.attachSession({ id: 'one', connectUrl: 'ws://test' });
  const worker = workers.at(-1);
  worker.emit('message', { type: 'failure', error: 'Disk full' });
  worker.emit('exit', 1);
  assert.equal(manager.getStatus().state, 'error');
  assert.equal(manager.getStatus().error, 'Disk full');
  await manager.setEnabled(true);
  assert.equal(manager.getStatus().state, 'syncing');
  await manager.setEnabled(false);
  assert.equal(manager.getStatus().state, 'disabled');
});

test('sessions without keep-alive cannot start a second CDP connection', async t => {
  const manager = await setup(t);
  await manager.setFolder(userData);
  const count = workers.length;
  await manager.attachSession({ id: 'one', connectUrl: 'ws://test', keepAlive: false });
  assert.equal(workers.length, count);
  assert.equal(manager.getStatus().state, 'error');
  assert.match(manager.getStatus().error, /keep-alive/);
});

test('session creation requests keep-alive and supports a plan-limit fallback', async () => {
  const { BrowserbaseClient } = require('../dist/main/browserbase');
  const oldKey = process.env.BROWSERBASE_API_KEY;
  process.env.BROWSERBASE_API_KEY = 'test-only';
  try {
    const client = new BrowserbaseClient();
    const bodies = [];
    client.getDebugUrl = async () => 'https://example.test';
    client.fetchWithRetry = async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return body.keepAlive
        ? new Response('keepAlive requires a paid plan', { status: 403 })
        : new Response(JSON.stringify({ id: 'session', status: 'RUNNING', connectUrl: 'ws://test', keepAlive: false }));
    };
    const session = await client.createSession({ keepAlive: true, proxies: false, browserSettings: { verified: false } });
    assert.equal(bodies[0].keepAlive, true);
    assert.equal(bodies[1].keepAlive, false);
    assert.equal(session.keepAlive, false);
  } finally {
    if (oldKey === undefined) delete process.env.BROWSERBASE_API_KEY;
    else process.env.BROWSERBASE_API_KEY = oldKey;
  }
});

test('tab target IDs survive reordering and uploaded file URLs reach the browser unchanged', async t => {
  const manager = new SessionManager();
  const pages = [];
  const context = {
    pages: () => pages,
    newCDPSession: async page => ({ send: async method => method === 'Target.getTargetInfo' ? { targetInfo: { targetId: page.id } } : {} }),
  };
  const page = id => ({ id, title: async () => id, url: () => `https://${id}.test`, context: () => context,
    bringToFront: async () => {}, goto: async url => { manager.lastNavigation = url; } });
  pages.push(page('A'), page('B'));
  manager.context = context; manager.browser = {};
  await manager.syncTabs();
  assert.deepEqual(manager.getTabs().map(tab => tab.id), ['A', 'B']);
  await manager.switchTab('B');
  pages.reverse();
  await manager.syncTabs();
  assert.deepEqual(manager.getTabs().map(tab => tab.id), ['B', 'A']);
  assert.equal(manager.getTabs().find(tab => tab.active).id, 'B');
  await manager.navigateTo('file:///tmp/.uploads/report%20one.html');
  assert.equal(manager.lastNavigation, 'file:///tmp/.uploads/report%20one.html');
});

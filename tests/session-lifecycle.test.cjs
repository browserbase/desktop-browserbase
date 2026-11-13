const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright-core');
const { SessionManager } = require('../dist/main/session');

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function fixture(t) {
  const remote = { id: 'synthetic-session', status: 'RUNNING', connectUrl: 'wss://example.com', debugUrl: 'https://example.com/live' };
  const context = new EventEmitter();
  const page = new EventEmitter();
  let url = 'about:blank';
  const navigations = [];
  page.url = () => url;
  page.title = async () => 'Synthetic page';
  page.context = () => context;
  page.goto = async (next) => { url = next; navigations.push(next); };
  context.pages = () => [page];
  let cdpCount = 0;
  context.newCDPSession = async () => {
    cdpCount++;
    return { send: async () => ({ targetInfo: { targetId: 'synthetic-target' } }) };
  };
  const browser = new EventEmitter();
  let connected = true;
  browser.contexts = () => [context];
  browser.isConnected = () => connected;
  browser.close = async () => { connected = false; browser.emit('disconnected'); };
  const connects = t.mock.method(chromium, 'connectOverCDP', async () => { connected = true; return browser; });
  const released = [];
  const client = { createSession: async () => remote, stopSession: async (id) => released.push(id) };
  const manager = new SessionManager();
  manager.browserbaseClient = client;
  return { manager, client, browser, page, context, remote, connects, released, navigations, cdpCount: () => cdpCount };
}

test('concurrent initialization and renderer reload reuse one cloud session', async (t) => {
  const f = fixture(t);
  const gate = deferred();
  const create = t.mock.method(f.client, 'createSession', () => gate.promise);
  const first = f.manager.initialize();
  const second = f.manager.initialize();
  gate.resolve(f.remote);
  assert.deepEqual(await Promise.all([first, second]), [f.remote, f.remote]);
  assert.equal(await f.manager.initialize(), f.remote);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(f.connects.mock.callCount(), 1);
  await f.manager.cleanup();
});

test('cleanup cancels a startup and releases a session returned after the window closes', async (t) => {
  const f = fixture(t);
  const gate = deferred();
  f.client.createSession = () => gate.promise;
  const initialized = f.manager.initialize();
  const rejected = assert.rejects(initialized, /cancelled/);
  const cleanup = f.manager.cleanup();
  gate.resolve(f.remote);
  await Promise.all([cleanup, rejected]);
  assert.deepEqual(f.released, ['synthetic-session']);
  assert.equal(f.connects.mock.callCount(), 0);
  assert.equal(f.manager.getSessionId(), '');
});

test('cleanup releases the cloud session even when closing the transport fails', async (t) => {
  const f = fixture(t);
  await f.manager.initialize();
  f.browser.close = async () => { throw new Error('synthetic close failure'); };
  await Promise.all([f.manager.cleanup(), f.manager.cleanup()]);
  assert.deepEqual(f.released, ['synthetic-session']);
  assert.equal(f.manager.getSessionId(), '');
  assert.deepEqual(f.manager.getTabs(), []);
});

test('intentional cleanup does not schedule a reconnect', async (t) => {
  const f = fixture(t);
  await f.manager.initialize();
  await f.manager.cleanup();
  assert.equal(f.manager.reconnectTimer, null);
  assert.equal(f.manager.reconnectAttempts, 0);
  assert.equal(f.connects.mock.callCount(), 1);
});

test('failed CDP connection releases the newly created remote session', async (t) => {
  const f = fixture(t);
  f.connects.mock.mockImplementation(async () => { throw new Error('synthetic connection failure'); });
  await assert.rejects(f.manager.initialize(), /synthetic connection failure/);
  assert.deepEqual(f.released, ['synthetic-session']);
  assert.equal(f.manager.getSessionId(), '');
});

test('reconnect preserves navigation and cleanup cancels its retry timer', async (t) => {
  const f = fixture(t);
  await f.manager.initialize();
  await f.manager.navigateTo('https://example.com/keep-this-page');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.browser.emit('disconnected');
  t.mock.timers.tick(2000);
  await new Promise(setImmediate);
  assert.equal(f.connects.mock.callCount(), 2);
  assert.equal(f.page.url(), 'https://example.com/keep-this-page');
  assert.equal(f.navigations.length, 2);
  f.browser.emit('disconnected');
  await f.manager.cleanup();
  t.mock.timers.tick(10000);
  await new Promise(setImmediate);
  assert.equal(f.connects.mock.callCount(), 2);
});

test('viewport changes and target lookup share the page CDP connection', async (t) => {
  const f = fixture(t);
  await f.manager.initialize();
  await Promise.all(Array.from({ length: 20 }, (_, i) => f.manager.updateViewport(800 + i, 600)));
  assert.equal(await f.manager.getTargetIdForPage(f.page), 'synthetic-target');
  assert.equal(f.cdpCount(), 1);
  await f.manager.cleanup();
});

test('a failed start page keeps a connected session usable', async (t) => {
  const f = fixture(t);
  f.page.goto = async () => { throw new Error('synthetic navigation failure'); };
  assert.equal(await f.manager.initialize(), f.remote);
  assert.equal(f.manager.getSessionId(), 'synthetic-session');
  assert.deepEqual(f.released, []);
  await f.manager.cleanup();
});


test('final shutdown prevents initialization already waiting for window cleanup', async (t) => {
  const f = fixture(t);
  const created = t.mock.method(f.client, 'createSession', async () => f.remote);
  await f.manager.initialize();
  const release = deferred();
  f.client.stopSession = () => release.promise;
  const cleanup = f.manager.cleanup();
  const reopened = f.manager.initialize();
  const rejected = assert.rejects(reopened, /Application is shutting down/);
  const shutdown = f.manager.shutdown();
  release.resolve();
  await Promise.all([cleanup, shutdown, rejected]);
  await assert.rejects(f.manager.initialize(), /Application is shutting down/);
  assert.equal(created.mock.callCount(), 1);
});


test('renderer reload receives the existing tabs and address without creating a new session', async (t) => {
  const f = fixture(t);
  await f.manager.initialize();
  await f.manager.navigateTo('https://example.com/existing-page');
  const sent = [];
  f.manager.setMainWindow({ isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } });
  const { IPC_CHANNELS } = require('../dist/shared/types');
  assert.equal(await f.manager.initialize(), f.remote);
  assert.deepEqual(sent, [
    [IPC_CHANNELS.TABS_UPDATED, f.manager.getTabs()],
    [IPC_CHANNELS.URL_CHANGED, 'https://example.com/existing-page'],
  ]);
  assert.equal(f.connects.mock.callCount(), 1);
  await f.manager.cleanup();
});

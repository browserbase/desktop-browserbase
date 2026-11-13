const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright-core');
const { SessionManager } = require('../dist/main/session');
const { IPC_CHANNELS } = require('../dist/shared/types');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const context = new EventEmitter();
  const pages = [];
  for (let i = 0; i < 3; i++) {
    const page = new EventEmitter();
    const frame = {};
    page.target = `target-${i}`;
    page.currentUrl = 'https://example.com/same-url';
    page.url = () => page.currentUrl;
    page.title = async () => page.target;
    page.context = () => context;
    page.mainFrame = () => frame;
    page.bringToFront = async () => {};
    page.goto = async (url) => { page.currentUrl = url; };
    page.close = async () => { pages.splice(pages.indexOf(page), 1); page.emit('close'); };
    pages.push(page);
  }
  context.pages = () => [...pages];
  context.newCDPSession = async (page) => ({ send: async (method) => method === 'Target.getTargetInfo' ? { targetInfo: { targetId: page.target } } : {} });
  const browser = new EventEmitter();
  browser.contexts = () => [context];
  browser.isConnected = () => true;
  browser.close = async () => {};
  t.mock.method(chromium, 'connectOverCDP', async () => browser);
  const manager = new SessionManager();
  const lookups = [];
  const client = {
    createSession: async () => ({ id: 'synthetic-session', status: 'RUNNING', connectUrl: 'wss://example.com', debugUrl: 'https://example.com/target-0' }),
    stopSession: async () => {},
    getDebugUrlForTarget: async (_, target) => { lookups.push(target); return `https://example.com/${target}`; },
    getDebugUrlForPage: async () => { throw new Error('URL matching must not be used when the target is known'); },
  };
  manager.browserbaseClient = client;
  const events = [];
  manager.setMainWindow({ isDestroyed: () => false, getContentBounds: () => ({ width: 800, height: 600 }), webContents: { getZoomFactor: () => 1, send: (...args) => events.push(args) } });
  await manager.initialize();
  pages[0].currentUrl = pages[1].currentUrl;
  t.after(() => manager.cleanup());
  return { manager, pages, context, client, events, lookups };
}

test('duplicate-URL tabs select their exact CDP target and persist the active debug URL', async (t) => {
  const f = await fixture(t);
  const second = f.manager.getTabs()[1];
  await f.manager.switchTab(second.id);
  assert.deepEqual(f.lookups, ['target-1']);
  assert.equal(f.manager.getDebugUrl(), 'https://example.com/target-1');
  assert.equal(f.manager.getAutomationInfo().debugUrl, 'https://example.com/target-1');
  assert.equal(f.manager.getTabs().find((tab) => tab.active).targetId, 'target-1');
});

test('closing an earlier tab preserves active page identity and stable tab IDs', async (t) => {
  const f = await fixture(t);
  const [first, second, third] = f.manager.getTabs();
  await f.manager.switchTab(third.id);
  await f.manager.closeTab(first.id);
  assert.deepEqual(f.manager.getTabs().map((tab) => tab.id), [second.id, third.id]);
  assert.equal(f.manager.getTabs().find((tab) => tab.active).id, third.id);
  await f.manager.closeTab(first.id); // A stale click must not close the next tab.
  assert.equal(f.pages.length, 2);
});

test('background navigation never replaces the active address bar', async (t) => {
  const f = await fixture(t);
  await f.manager.switchTab(f.manager.getTabs()[1].id);
  f.events.length = 0;
  f.pages[2].currentUrl = 'https://example.com/background';
  f.pages[2].emit('framenavigated', f.pages[2].mainFrame());
  await new Promise(setImmediate);
  const addresses = f.events.filter(([channel]) => channel === IPC_CHANNELS.URL_CHANGED).map(([, url]) => url);
  assert.deepEqual(addresses, ['https://example.com/same-url']);
  assert.equal(f.manager.getCurrentUrl(), 'https://example.com/same-url');
});

test('a late live-view response cannot overwrite the more recent tab selection', async (t) => {
  const f = await fixture(t);
  const gate = deferred();
  const requested = deferred();
  f.client.getDebugUrlForTarget = async (_, target) => {
    if (target === 'target-1') { requested.resolve(); return gate.promise; }
    return `https://example.com/${target}`;
  };
  const second = f.manager.switchTab(f.manager.getTabs()[1].id);
  await requested.promise;
  await f.manager.switchTab(f.manager.getTabs()[2].id);
  gate.resolve('https://example.com/target-1');
  await second;
  assert.equal(f.manager.getDebugUrl(), 'https://example.com/target-2');
  const debugChanges = f.events.filter(([channel]) => channel === IPC_CHANNELS.DEBUG_URL_CHANGED).map(([, url]) => url);
  assert.deepEqual(debugChanges, ['https://example.com/target-2']);
});

test('a slow old tab sync cannot resurrect a closed page', async (t) => {
  const f = await fixture(t);
  const gate = deferred();
  const original = f.pages[0];
  original.title = () => gate.promise;
  const oldSync = f.manager.syncTabs();
  await f.manager.closeTab(f.manager.getTabs()[0].id);
  gate.resolve('Removed tab');
  await oldSync;
  assert.equal(f.manager.getTabs().length, 2);
  assert.ok(f.manager.getTabs().every((tab) => tab.targetId !== original.target));
});


test('a missing live-view target ends loading with an error for the current selection', async (t) => {
  const f = await fixture(t);
  f.manager.waitForDebugUrlForPage = async () => null;
  await f.manager.switchTab(f.manager.getTabs()[1].id);
  const errors = f.events.filter(([channel]) => channel === IPC_CHANNELS.SESSION_ERROR);
  assert.equal(errors.length, 1);
  assert.match(errors[0][1], /Select the tab again to retry/);
});

test('a timed out lookup for a previous tab does not show an error over the active tab', async (t) => {
  const f = await fixture(t);
  const gate = deferred();
  const requested = deferred();
  f.manager.waitForDebugUrlForPage = async (page) => {
    if (page.target === 'target-1') { requested.resolve(); return gate.promise; }
    return `https://example.com/${page.target}`;
  };
  const second = f.manager.switchTab(f.manager.getTabs()[1].id);
  await requested.promise;
  await f.manager.switchTab(f.manager.getTabs()[2].id);
  gate.resolve(null);
  await second;
  assert.equal(f.events.filter(([channel]) => channel === IPC_CHANNELS.SESSION_ERROR).length, 0);
});

test('tab operations await the newer sync when their own snapshot is superseded', async (t) => {
  const f = await fixture(t);
  const first = deferred();
  const second = deferred();
  let calls = 0;
  f.pages[0].title = () => (++calls === 1 ? first.promise : second.promise);
  let returned = false;
  const oldSync = f.manager.syncTabs().then(() => { returned = true; });
  const newSync = f.manager.syncTabs();
  first.resolve('Old title');
  await new Promise(setImmediate);
  assert.equal(returned, false);
  second.resolve('Current title');
  await Promise.all([oldSync, newSync]);
  assert.equal(f.manager.getTabs()[0].title, 'Current title');
});

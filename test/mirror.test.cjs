const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { MirrorEngine, matchDownload } = require('../dist/main/mirror/engine');
const { prepareMirrorDirectory, atomicWrite } = require('../dist/main/mirror/files');
const { archiveRelativePath } = require('../dist/main/mirror/transfers');

async function eventually(check, timeout = 5000) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    try { const result = await check(); if (result !== false) return result; } catch (e) { error = e; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw error || new Error('Timed out');
}
class FakeCdp extends EventEmitter {
  calls = [];
  constructor(ids = ['A', 'B']) { super(); this.ids = ids; }
  async send(method, params, sessionId) {
    this.calls.push({ method, params, sessionId });
    if (method === 'Target.getTargets') return { targetInfos: this.ids.map(targetId => ({ type: 'page', targetId, url: `https://${targetId}.test`, title: targetId })) };
    if (method === 'Target.attachToTarget') return { sessionId: `session-${params.targetId}` };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: sessionId.replace('session-', 'frame-') } } };
    if (method === 'Runtime.evaluate') return { result: { value: { html: `<html>${sessionId}</html>`, title: sessionId, url: `https://${sessionId}.test` } } };
    return {};
  }
  event(method, params, sessionId) { this.emit(method, params, { method, params, sessionId }); }
  close() { this.closed = true; }
}
async function fixture(t, overrides = {}, ids) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-mirror-test-'));
  const directory = path.join(parent, 'browser');
  await prepareMirrorDirectory(directory, 'session', true);
  const client = new FakeCdp(ids);
  const abort = new AbortController();
  const transfers = { downloads: async () => [], upload: async (_file, filename) => ({ remotePath: `/tmp/.uploads/${filename}`, fileUrl: `file:///tmp/.uploads/${filename}` }), ...overrides };
  const engine = new MirrorEngine(client, directory, 'session', transfers, abort, 25, 10);
  const failures = [];
  engine.on('failure', error => failures.push(error));
  t.after(async () => { await engine.stop(); await fs.rm(parent, { recursive: true, force: true }); assert.deepEqual(failures, []); });
  await engine.start();
  const json = file => fs.readFile(path.join(directory, file), 'utf8').then(JSON.parse);
  return { engine, client, directory, json, abort };
}

test('fresh sessions clear owned output; reconnects preserve it; foreign folders are refused', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mirror-root-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'browser');
  await fs.mkdir(root); await fs.writeFile(path.join(root, 'mine.txt'), 'keep');
  await assert.rejects(prepareMirrorDirectory(root, 'one', true), /existing files/);
  assert.equal(await fs.readFile(path.join(root, 'mine.txt'), 'utf8'), 'keep');
  await fs.rm(path.join(root, 'mine.txt'));
  await prepareMirrorDirectory(root, 'one', true);
  await fs.writeFile(path.join(root, 'upload.txt'), 'preserve');
  await prepareMirrorDirectory(root, 'one', false);
  assert.equal(await fs.readFile(path.join(root, 'upload.txt'), 'utf8'), 'preserve');
  await prepareMirrorDirectory(root, 'two', false);
  await assert.rejects(fs.access(path.join(root, 'upload.txt')));
});

test('all pages get HTML and logs, tab switches update active.json, every received frame is written', async t => {
  const { engine, client, directory, json } = await fixture(t);
  assert.match(await fs.readFile(path.join(directory, 'A/page.html'), 'utf8'), /session-A/);
  assert.match(await fs.readFile(path.join(directory, 'B/page.html'), 'utf8'), /session-B/);
  await engine.updateTabs([{ targetId: 'A', id: 'A', active: true, title: 'First', url: 'https://a.test' }, { targetId: 'B', id: 'B', active: false, title: 'Second', url: 'https://b.test' }]);
  assert.equal((await json('active.json')).pageId, 'A');
  await engine.updateTabs([{ targetId: 'B', id: 'B', active: true, title: 'Second', url: 'https://b.test' }]);
  assert.equal((await json('active.json')).pageId, 'B');
  for (let i = 0; i < 50; i++) client.event('Page.screencastFrame', { sessionId: i, data: Buffer.from(`frame-${i}`).toString('base64') }, 'session-A');
  client.event('Network.requestWillBeSent', { requestId: 'one' }, 'session-A');
  client.event('Runtime.consoleAPICalled', { type: 'log' }, 'session-B');
  await eventually(() => assert.equal(engine.stats().frames, 50));
  assert.equal(await fs.readFile(path.join(directory, 'A/screencast.jpg'), 'utf8'), 'frame-49');
  assert.equal(client.calls.filter(c => c.method === 'Page.screencastFrameAck').length, 50);
  await eventually(async () => assert.match(await fs.readFile(path.join(directory, 'B/console.log'), 'utf8'), /consoleAPICalled/));
  assert.equal((await fs.readFile(path.join(directory, 'A/network.log'), 'utf8')).trim().split('\n').length, 1);
  assert.deepEqual(client.calls.find(c => c.method === 'Browser.setDownloadBehavior').params, { behavior: 'allow', downloadPath: 'downloads', eventsEnabled: true });
  assert(client.calls.filter(c => c.method === 'Page.startScreencast').every(c => c.params.everyNthFrame === 1));
});

test('duplicate attach notifications do not start duplicate screencasts', async t => {
  const { client } = await fixture(t);
  for (let i = 0; i < 4; i++) client.event('Target.attachedToTarget', { sessionId: 'session-A', targetInfo: { type: 'page', targetId: 'A' } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(client.calls.filter(c => c.method === 'Page.startScreencast' && c.sessionId === 'session-A').length, 1);
});

test('a popup closed during attachment does not fail the mirror', async t => {
  const { client, json } = await fixture(t);
  const send = client.send.bind(client);
  client.send = async (method, params, sessionId) => {
    if (method === 'Page.enable' && sessionId === 'session-C') throw new Error('No session with given id');
    return send(method, params, sessionId);
  };
  client.event('Target.attachedToTarget', { sessionId: 'session-C', targetInfo: { targetId: 'C', type: 'page', title: '', url: '' } });
  await eventually(async () => assert.equal((await json('C/metadata.json')).closed, true));
});

test('session archives route files to the correct page and GUID directory', async t => {
  let fetches = 0;
  const { client, json } = await fixture(t, { downloads: async directory => {
    fetches++;
    await fs.writeFile(path.join(directory, 'a'), 'alpha');
    await fs.writeFile(path.join(directory, 'b'), 'beta');
    return [{ name: 'alpha-1719265797164.txt', size: 5, path: path.join(directory, 'a') }, { name: 'beta.txt', size: 4, path: path.join(directory, 'b') }];
  } });
  for (const [id, frameId, filename, size] of [['first', 'frame-A', 'alpha.txt', 5], ['second', 'frame-B', 'beta.txt', 4]]) {
    client.event('Browser.downloadWillBegin', { guid: id, frameId, suggestedFilename: filename, url: `https://test/${filename}` });
    client.event('Browser.downloadProgress', { guid: id, receivedBytes: size, totalBytes: size, state: 'completed' });
  }
  await eventually(async () => {
    assert.equal((await json('A/metadata.json')).downloads[0].syncState, 'synced');
    assert.equal((await json('B/metadata.json')).downloads[0].syncState, 'synced');
  });
  const a = (await json('A/metadata.json')).downloads[0];
  const b = (await json('B/metadata.json')).downloads[0];
  assert.match(a.localPath, /A[/\\]downloads[/\\]first/);
  assert.match(b.localPath, /B[/\\]downloads[/\\]second/);
  assert.equal(await fs.readFile(a.localPath, 'utf8'), 'alpha');
  assert.equal(await fs.readFile(b.localPath, 'utf8'), 'beta');
  assert(fetches >= 1);
});

test('filename collisions stay unresolved rather than assigning another page\'s file', () => {
  const a = { id: 'a', filename: 'report.csv', receivedBytes: 5 };
  const b = { id: 'b', filename: 'report.csv', receivedBytes: 5 };
  const files = [{ name: 'report-1719265797164.csv', size: 5, path: '/tmp/report' }];
  assert.equal(matchDownload(a, files, [a, b]), undefined);
  assert.equal(matchDownload(a, files, [a]), files[0]);
  assert.equal(matchDownload(a, [{ ...files[0], size: 2 }], [a]), undefined);
});

test('ambiguous archive files are still retained locally under unattributed metadata', async t => {
  const { client, json } = await fixture(t, { downloads: async directory => {
    const file = path.join(directory, 'report');
    await fs.writeFile(file, 'hello');
    return [{ name: 'report-1719265797164.csv', size: 5, path: file }];
  } });
  for (const [id, frameId] of [['same-one', 'frame-A'], ['same-two', 'frame-B']]) {
    client.event('Browser.downloadWillBegin', { guid: id, frameId, suggestedFilename: 'report.csv', url: 'https://test/report' });
    client.event('Browser.downloadProgress', { guid: id, totalBytes: 5, receivedBytes: 5, state: 'completed' });
  }
  const files = await eventually(async () => {
    const metadata = await json('_unattributed/metadata.json');
    return metadata.downloadFiles?.length ? metadata.downloadFiles : false;
  });
  assert.equal(await fs.readFile(files[0].path, 'utf8'), 'hello');
  assert.equal((await json('A/metadata.json')).downloads[0].localPath, undefined);
  assert.equal((await json('B/metadata.json')).downloads[0].localPath, undefined);
});

test('uploads are discovered by scans, kept stable, namespaced per page, and reflected in metadata', async t => {
  const uploaded = [];
  const { directory, json } = await fixture(t, { upload: async (file, filename) => {
    uploaded.push({ file, filename });
    return { remotePath: `/tmp/.uploads/${filename}`, fileUrl: `file:///tmp/.uploads/${filename}` };
  } });
  await fs.writeFile(path.join(directory, 'A/uploads/hello.html'), 'hello');
  await fs.writeFile(path.join(directory, 'A/uploads/hello2.html'), 'hello2');
  await fs.writeFile(path.join(directory, 'B/uploads/hello.html'), 'other');
  await fs.writeFile(path.join(directory, 'B/uploads/unfinished.tmp'), 'partial');
  await eventually(async () => {
    assert.equal((await json('A/metadata.json')).uploads.filter(u => u.state === 'uploaded').length, 2);
    assert.equal((await json('B/metadata.json')).uploads.filter(u => u.state === 'uploaded').length, 1);
  });
  assert.equal(uploaded.length, 3);
  assert.equal(new Set(uploaded.map(u => u.filename)).size, 3);
  assert.match((await json('B/metadata.json')).uploads[0].fileUrl, /^file:\/\/\/tmp\/\.uploads\//);
});

test('stop aborts in-flight transfers and drains file writes before resolving', async t => {
  let started = false;
  let abort;
  const fixtureValue = await fixture(t, { upload: async () => {
    started = true;
    await new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  ({ abort } = fixtureValue);
  await fs.writeFile(path.join(fixtureValue.directory, 'A/uploads/slow.txt'), 'test');
  await eventually(() => started);
  await fixtureValue.engine.stop();
  const before = await fs.readFile(path.join(fixtureValue.directory, 'A/metadata.json'), 'utf8');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await fs.readFile(path.join(fixtureValue.directory, 'A/metadata.json'), 'utf8'), before);
  assert.equal(abort.signal.aborted, true);
});

test('archive entries cannot escape the extraction directory', () => {
  for (const name of ['../a', '/a', 'C:\\a', 'a/../../x', 'a\\..\\x', 'a:stream']) assert.throws(() => archiveRelativePath(name));
  assert.equal(archiveRelativePath('sub/report.csv'), path.join('sub', 'report.csv'));
  assert.equal(archiveRelativePath('folder/'), null);
});

test('atomic replacement leaves no temporary files after rapid writes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 50 }, (_, i) => atomicWrite(path.join(dir, 'frame.jpg'), Buffer.from(String(i)))));
  assert.deepEqual(await fs.readdir(dir), ['frame.jpg']);
});

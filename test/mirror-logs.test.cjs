const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { FileQueue } = require('../dist/main/mirror/files');
const { MirrorLogs } = require('../dist/main/mirror/logs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mirror-logs-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const page of ['A', 'B']) await fs.mkdir(path.join(directory, page));
  return { directory, a: path.join(directory, 'A/console.log'), b: path.join(directory, 'B/network.log') };
}

test('concurrent log streams reserve a shared byte budget and preserve complete UTF-8 lines', async t => {
  const { directory, a, b } = await fixture(t);
  const queue = new FileQueue();
  const line = JSON.stringify({ message: 'évidence' }) + '\n';
  const bytes = Buffer.byteLength(line);
  const logs = new MirrorLogs(directory, queue, bytes * 2);
  await logs.restore();
  let unblock;
  const blocked = queue.run(a, () => new Promise(resolve => { unblock = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const writes = [logs.append(a, line), logs.append(b, line), logs.append(a, line)];
  assert.equal(logs.stopped, true);
  unblock(); await blocked; await Promise.all(writes);
  const markerFile = path.join(directory, 'logs-limit.json');
  const marker = await fs.readFile(markerFile, 'utf8');
  assert.equal(JSON.parse(marker).capturedBytes, bytes * 2);
  assert.equal(await fs.readFile(a, 'utf8'), line);
  assert.equal(await fs.readFile(b, 'utf8'), line);
  for (let i = 0; i < 20; i++) await logs.append(b, line);
  assert.equal(await fs.readFile(markerFile, 'utf8'), marker);
  assert.equal(await fs.readFile(b, 'utf8'), line);
});

test('automatic reconnection preserves the terminal log marker and existing evidence', async t => {
  const { directory, a } = await fixture(t);
  const line = 'existing evidence\n';
  const first = new MirrorLogs(directory, new FileQueue(), Buffer.byteLength(line));
  await first.restore(); await first.append(a, line); await first.append(a, line);
  const marker = await fs.readFile(path.join(directory, 'logs-limit.json'), 'utf8');
  const reconnected = new MirrorLogs(directory, new FileQueue(), Buffer.byteLength(line));
  await reconnected.restore(); await reconnected.append(a, line);
  assert.equal(reconnected.stopped, true);
  assert.equal(await fs.readFile(a, 'utf8'), line);
  assert.equal(await fs.readFile(path.join(directory, 'logs-limit.json'), 'utf8'), marker);
});

test('reconnection counts existing files across pages before accepting more log bytes', async t => {
  const { directory, a, b } = await fixture(t);
  await fs.writeFile(a, '1234\n'); await fs.writeFile(b, '5678\n');
  const logs = new MirrorLogs(directory, new FileQueue(), 15);
  await logs.restore(); await logs.append(a, '9012\n'); await logs.append(b, 'stop\n');
  assert.equal(await fs.readFile(a, 'utf8'), '1234\n9012\n');
  assert.equal(await fs.readFile(b, 'utf8'), '5678\n');
  const marker = JSON.parse(await fs.readFile(path.join(directory, 'logs-limit.json'), 'utf8'));
  assert.equal(marker.maxBytes, 15); assert.equal(marker.capturedBytes, 15);
});

test('legacy logs above the budget are preserved without further appends', async t => {
  const { directory, a } = await fixture(t);
  await fs.writeFile(a, 'legacy evidence\n');
  const logs = new MirrorLogs(directory, new FileQueue(), 4);
  await logs.restore(); await logs.append(a, 'more\n');
  assert.equal(logs.stopped, true);
  assert.equal(await fs.readFile(a, 'utf8'), 'legacy evidence\n');
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'logs-limit.json'), 'utf8')).event, 'logLimitReached');
});

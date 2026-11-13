const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { atomicWrite } = require('../dist/main/mirror/files');

async function fixture(t, platform = 'win32') {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mirror-replace-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'frame.jpg');
  await fs.writeFile(file, 'previous complete frame');
  return { directory, file };
}

test('Windows replacement retries temporary rename locks without removing the previous frame', async t => {
  const { directory, file } = await fixture(t);
  const rename = fs.rename;
  let attempts = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    assert.equal(await fs.readFile(file, 'utf8'), 'previous complete frame');
    const codes = ['EPERM', 'EACCES', 'EBUSY'];
    if (++attempts <= codes.length) throw Object.assign(new Error('temporary sharing violation'), { code: codes[attempts - 1] });
    return rename(from, to);
  });
  await atomicWrite(file, 'next complete frame');
  assert.equal(attempts, 4);
  assert.equal(await fs.readFile(file, 'utf8'), 'next complete frame');
  assert.deepEqual(await fs.readdir(directory), ['frame.jpg']);
});

test('persistent Windows rename locks have bounded retries and preserve existing output', async t => {
  const { directory, file } = await fixture(t);
  const error = Object.assign(new Error('persistent sharing violation'), { code: 'EBUSY' });
  const rename = t.mock.method(fs, 'rename', async () => { throw error; });
  await assert.rejects(atomicWrite(file, 'next complete frame'), value => value === error);
  assert.equal(rename.mock.callCount(), 6);
  assert.equal(await fs.readFile(file, 'utf8'), 'previous complete frame');
  assert.deepEqual(await fs.readdir(directory), ['frame.jpg']);
});

test('unrelated rename failures are not retried and leave no temporary file', async t => {
  const { directory, file } = await fixture(t);
  const error = Object.assign(new Error('out of space'), { code: 'ENOSPC' });
  const rename = t.mock.method(fs, 'rename', async () => { throw error; });
  await assert.rejects(atomicWrite(file, 'next complete frame'), value => value === error);
  assert.equal(rename.mock.callCount(), 1);
  assert.equal(await fs.readFile(file, 'utf8'), 'previous complete frame');
  assert.deepEqual(await fs.readdir(directory), ['frame.jpg']);
});

test('POSIX permission errors are returned without Windows lock retries', async t => {
  const { directory, file } = await fixture(t, 'linux');
  const error = Object.assign(new Error('permission denied'), { code: 'EPERM' });
  const rename = t.mock.method(fs, 'rename', async () => { throw error; });
  await assert.rejects(atomicWrite(file, 'next complete frame'), value => value === error);
  assert.equal(rename.mock.callCount(), 1);
  assert.deepEqual(await fs.readdir(directory), ['frame.jpg']);
});

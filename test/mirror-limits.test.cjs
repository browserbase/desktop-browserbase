const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { deflateRawSync } = require('node:zlib');
const { Buffer } = require('node:buffer');
const { BrowserbaseTransfers, extractArchive, DownloadLimitError, DEFAULT_ARCHIVE_LIMITS } = require('../dist/main/mirror/transfers');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Small ZIP fixtures exercise expansion limits without writing large files.
function archive(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const filename = Buffer.from(name), bytes = Buffer.from(data), compressed = deflateRawSync(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc32(bytes), 16); entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, filename, compressed); central.push(entry, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
async function fixture(t, files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mirror-limits-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const zip = path.join(dir, 'archive.zip');
  await fs.writeFile(zip, archive(files));
  const output = path.join(dir, 'output'); await fs.mkdir(output);
  return { dir, zip, output };
}
const signal = () => new AbortController().signal;

test('bounded archives retain normal nested-file extraction', async t => {
  const { zip, output } = await fixture(t, [['nested/hello.txt', 'hello']]);
  const files = await extractArchive(zip, output, signal());
  assert.equal(files.length, 1);
  assert.equal(await fs.readFile(files[0].path, 'utf8'), 'hello');
});

test('compressed size, entry count, per-file expansion and total expansion are bounded', async t => {
  for (const [override, message] of [
    [{ maxDownloadBytes: 16 }, /compressed size/],
    [{ maxEntries: 1 }, /too many entries/],
    [{ maxFileBytes: 100 }, /per-file size/],
    [{ maxExpandedBytes: 1200 }, /expanded size/],
  ]) {
    const { zip, output } = await fixture(t, [['one', Buffer.alloc(1024)], ['two', Buffer.alloc(1024)]]);
    await assert.rejects(extractArchive(zip, output, signal(), { ...DEFAULT_ARCHIVE_LIMITS, ...override }), error => {
      assert.ok(error instanceof DownloadLimitError); assert.match(error.message, message); return true;
    });
    const names = await fs.readdir(output);
    assert.ok(names.length <= 1);
  }
});

test('directory entries also count against the archive entry limit', async t => {
  const { zip, output } = await fixture(t, [['a/', ''], ['b/', ''], ['c/', '']]);
  await assert.rejects(extractArchive(zip, output, signal(), { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 2 }), DownloadLimitError);
  assert.deepEqual(await fs.readdir(output), []);
});

test('real HTTP downloads enforce size limits even without Content-Length and remove the partial archive', async t => {
  for (const advertised of [true, false]) {
    const { dir } = await fixture(t, []);
    const incoming = path.join(dir, 'incoming'); await fs.mkdir(incoming);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, advertised ? { 'content-length': 4096 } : { 'transfer-encoding': 'chunked' });
      res.end(Buffer.alloc(4096));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const transfer = new BrowserbaseTransfers('synthetic', 'synthetic-test-key', signal(),
        `http://127.0.0.1:${server.address().port}`, { ...DEFAULT_ARCHIVE_LIMITS, maxDownloadBytes: 1024 });
      await assert.rejects(transfer.downloads(incoming), DownloadLimitError);
      assert.deepEqual(await fs.readdir(incoming), []);
    } finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  }
});

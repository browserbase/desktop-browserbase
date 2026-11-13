const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, statSync, existsSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');
const { AutomationServer } = require('../dist/main/automation');

function request(port, endpoint, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: endpoint, headers }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
    }).on('error', reject);
  });
}

test('automation metadata requires a private, rotating token and rejects browser origins', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'desktop-automation-test-'));
  const descriptorPath = path.join(dir, 'automation.json');
  const info = { sessionId: 'test', status: 'RUNNING', connectUrl: 'wss://example.test/?apiKey=synthetic', debugUrl: '', currentUrl: '', tabs: [] };
  let providerCalls = 0;
  const server = new AutomationServer(() => { providerCalls++; return info; }, dir);
  try {
    // Existing broad permissions must not survive replacing a descriptor.
    writeFileSync(descriptorPath, '{}', { mode: 0o644 });
    const port = await server.start();
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
    if (process.platform !== 'win32') assert.equal(statSync(descriptorPath).mode & 0o777, 0o600);
    const auth = { Authorization: `Bearer ${descriptor.token}` };
    for (const endpoint of ['/session', '/json/version', '/json/list']) {
      assert.equal((await request(port, endpoint)).status, 401);
      assert.equal((await request(port, endpoint, { Authorization: 'Bearer invalid' })).status, 401);
      for (const hostileHeaders of [
        { Host: `rebind.example.test:${port}` },
        { Origin: 'https://example.test' },
        { Origin: 'null' },
        { 'Sec-Fetch-Site': 'same-origin' },
      ]) {
        const rejected = await request(port, endpoint, { ...auth, ...hostileHeaders });
        assert.equal(rejected.status, 403);
        assert.ok(!rejected.body.includes('synthetic'));
      }
    }
    assert.equal(providerCalls, 0);
    assert.equal((await request(port, '/health')).status, 200);
    const metadata = await request(port, '/session', auth);
    assert.equal(metadata.status, 200);
    assert.deepEqual(JSON.parse(metadata.body), info);
    assert.equal(metadata.headers['cache-control'], 'no-store');
    assert.equal(metadata.headers['x-content-type-options'], 'nosniff');
    assert.equal(JSON.parse((await request(port, '/json/version', auth)).body).webSocketDebuggerUrl, info.connectUrl);
    assert.deepEqual(JSON.parse((await request(port, '/json/list', auth)).body), []);
    await server.stop();
    assert.ok(!existsSync(descriptorPath));
    const nextPort = await server.start();
    const nextDescriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
    assert.notEqual(nextDescriptor.token, descriptor.token);
    assert.equal((await request(nextPort, '/session', auth)).status, 401);
    assert.equal((await request(nextPort, '/session', { Authorization: `Bearer ${nextDescriptor.token}` })).status, 200);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

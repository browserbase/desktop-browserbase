const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BrowserbaseClient } = require('../dist/main/browserbase');

function client(t) {
  const previous = process.env.BROWSERBASE_API_KEY;
  process.env.BROWSERBASE_API_KEY = 'synthetic-api-key';
  t.after(() => { if (previous === undefined) delete process.env.BROWSERBASE_API_KEY; else process.env.BROWSERBASE_API_KEY = previous; });
  return new BrowserbaseClient();
}

for (const status of [429, 500, 503]) {
  test(`creation does not retry a non-idempotent POST after HTTP ${status}`, async (t) => {
    const bb = client(t);
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status }));
    await assert.rejects(bb.createSession());
    assert.equal(fetch.mock.callCount(), 1);
  });
}

test('creation does not retry after the response is lost', async (t) => {
  const bb = client(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('synthetic network failure'); });
  await assert.rejects(bb.createSession(), /synthetic network failure/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('retryable reads retain the last HTTP response and do not sleep after the final attempt', async (t) => {
  const bb = client(t);
  const delays = [];
  bb.sleep = async (ms) => delays.push(ms);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(bb.getSession('synthetic-session'), /HTTP 503/);
  assert.equal(fetch.mock.callCount(), 3);
  assert.equal(delays.length, 2);
});

test('failed deferred startup releases its cloud session before rejecting', async (t) => {
  const bb = client(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push([url, options.method, options.body]);
    if (url.endsWith('/sessions')) return Response.json({ id: 'synthetic-session', status: 'PENDING' });
    if (options.method === 'GET') return Response.json({ id: 'synthetic-session', status: 'ERROR' });
    return Response.json({ status: 'COMPLETED' });
  });
  await assert.rejects(bb.createSession(), /Session failed with status: ERROR/);
  assert.equal(requests.length, 3);
  assert.deepEqual(JSON.parse(requests[2][2]), { status: 'REQUEST_RELEASE' });
});

test('readiness deadline aborts a stalled status request and still releases the session', async (t) => {
  const bb = client(t);
  // AbortSignal.timeout is unref'ed; keep this synthetic test alive until it fires.
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  let released = false;
  let aborted = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/sessions')) return Response.json({ id: 'synthetic-session', status: 'PENDING' });
    if (options.method === 'GET') return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); });
    });
    released = true;
    return Response.json({ status: 'COMPLETED' });
  });
  const started = Date.now();
  await assert.rejects(bb.createSession({ readyTimeoutMs: 30 }));
  assert.ok(Date.now() - started < 500);
  assert.equal(aborted, true);
  assert.equal(released, true);
});

test('readiness rejects invalid time limits instead of polling indefinitely', async (t) => {
  const bb = client(t);
  for (const timeout of [Infinity, NaN, 0, -1]) {
    await assert.rejects(bb.waitForSessionReady('synthetic-session', timeout), /positive finite/);
  }
});

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { BrowserbaseClient } = require('../dist/main/browserbase');
const { safeError } = require('../dist/main/diagnostics');

test('session creation and debug lookup do not log access credentials', async (t) => {
  const previous = process.env.BROWSERBASE_API_KEY;
  process.env.BROWSERBASE_API_KEY = 'synthetic-api-secret';
  t.after(() => { if (previous === undefined) delete process.env.BROWSERBASE_API_KEY; else process.env.BROWSERBASE_API_KEY = previous; });
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => output.push(args.join(' ')));
  t.mock.method(globalThis, 'fetch', async (url) => Response.json(url.endsWith('/debug') ? {
    debuggerFullscreenUrl: 'https://example.com/live?token=synthetic-signed-secret',
    pages: [{ url: 'https://example.com/private?query=synthetic-query-secret' }],
  } : {
    id: 'synthetic-session', status: 'RUNNING',
    connectUrl: 'wss://example.com?apiKey=synthetic-api-secret',
    signingKey: 'synthetic-signing-secret',
  }));
  const client = new BrowserbaseClient();
  await client.createSession();
  await client.getDebugUrlForPage('synthetic-session', 'https://example.com/private?query=synthetic-query-secret');
  assert.doesNotMatch(output.join('\n'), /synthetic-(api|signed|signing|query)-secret/);
});

test('HTTP error bodies never become user-facing errors', async (t) => {
  const previous = process.env.BROWSERBASE_API_KEY;
  process.env.BROWSERBASE_API_KEY = 'synthetic-api-secret';
  t.after(() => { if (previous === undefined) delete process.env.BROWSERBASE_API_KEY; else process.env.BROWSERBASE_API_KEY = previous; });
  t.mock.method(globalThis, 'fetch', async () => new Response('synthetic-upstream-secret', { status: 422 }));
  await assert.rejects(new BrowserbaseClient().createSession(), { message: 'Failed to create Browserbase session (HTTP 422)' });
});

test('connection errors redact URL credentials and unstructured API keys', (t) => {
  const previous = process.env.BROWSERBASE_API_KEY;
  process.env.BROWSERBASE_API_KEY = 'synthetic-api-secret';
  t.after(() => { if (previous === undefined) delete process.env.BROWSERBASE_API_KEY; else process.env.BROWSERBASE_API_KEY = previous; });
  const error = safeError(new Error('connect wss://example.com?apiKey=synthetic-api-secret and https://example.com/live/signed-value failed: synthetic-api-secret'));
  assert.equal(error.message, 'connect [URL redacted] and [URL redacted] failed: [credential redacted]');
  assert.doesNotMatch(error.stack, /synthetic-api-secret|signed-value/);
});

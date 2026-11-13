const assert = require('node:assert/strict');
const { test } = require('node:test');
const { isLiveViewUrl } = require('../dist/main/security');

test('live-view URL validation rejects scheme, credential, port, and hostname confusion', () => {
  for (const value of [
    'https://www.browserbase.com/devtools-fullscreen/inspector.html',
    'https://www.browserbase.com/devtools/inspector.html',
    'https://www.browserbase.com/devtools-fullscreen-compiled/index.html',
  ]) assert.equal(isLiveViewUrl(value), true, value);
  for (const value of [
    'file:///tmp/index.html',
    'javascript:alert(1)',
    'data:text/html,example',
    'http://www.browserbase.com/',
    'https://www.browserbase.com.example.test/',
    'https://example.test/?url=https://www.browserbase.com',
    'https://user:password@www.browserbase.com/',
    'https://www.browserbase.com:8443/',
    'https://browserbase.com@example.test/',
    'https://fakebrowserbase.com/',
    'https://www.browserbase.com/',
    'https://www.browserbase.com/blog/',
    'https://docs.browserbase.com/devtools/inspector.html',
    'https://www.browserbase.com/devtools/inspector.html/extra',
    'not a URL',
  ]) assert.equal(isLiveViewUrl(value), false, value);
});

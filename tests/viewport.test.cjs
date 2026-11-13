const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseViewport, ViewportUpdater } = require('../dist/main/viewport');

test('viewport input accepts bounded integer dimensions and rejects malformed or hidden surfaces', () => {
  assert.deepEqual(parseViewport({ width: 800, height: 220 }), { width: 800, height: 220 });
  for (const value of [null, '800x600', {}, { width: 0, height: 600 }, { width: 800, height: -1 }, { width: '800', height: 600 }, { width: 800.1, height: 600 }, { width: Infinity, height: 600 }, { width: 800, height: 8193 }]) {
    assert.equal(parseViewport(value), null);
  }
});

test('resize bursts send only the latest size and serialize updates while CDP is busy', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const updates = [];
  const updater = new ViewportUpdater(async (viewport) => {
    updates.push(viewport);
    if (updates.length === 1) await gate;
  });
  updater.push({ width: 700, height: 500 });
  updater.push({ width: 800, height: 520 });
  t.mock.timers.tick(100);
  assert.deepEqual(updates, [{ width: 800, height: 520 }]);
  updater.push({ width: 900, height: 620 });
  updater.push({ width: 1000, height: 720 });
  t.mock.timers.tick(500);
  assert.equal(updates.length, 1);
  release();
  await new Promise(setImmediate);
  t.mock.timers.tick(100);
  assert.deepEqual(updates, [{ width: 800, height: 520 }, { width: 1000, height: 720 }]);
  updater.dispose();
});

test('disposing a window cancels pending viewport work and rejects later reports', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const updates = [];
  const updater = new ViewportUpdater(async (viewport) => { updates.push(viewport); });
  updater.push({ width: 800, height: 600 });
  updater.dispose();
  updater.push({ width: 900, height: 700 });
  t.mock.timers.tick(1000);
  assert.deepEqual(updates, []);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('../server');

async function withServer(t) {
  const server = await start(0);
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const runDemo = (url, body) =>
  fetch(`${url}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

test('serves the page and a health check', async (t) => {
  const url = await withServer(t);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /deadline-relay/);
  assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true });
});

test('with deadline-relay, the slow service stops when the client gives up', async (t) => {
  const url = await withServer(t);
  const r = await runDemo(url, { mode: 'relay', budget: 400, latency: 1500 });
  assert.equal(r.outcome.ok, false);
  const inventory = r.events.filter((e) => e.service === 'inventory');
  assert.ok(inventory.some((e) => e.kind === 'stop'), 'inventory should be stopped');
  assert.ok(!inventory.some((e) => e.kind === 'waste'));
  assert.ok(r.wastedMs < 200, `wasted ${r.wastedMs}ms`);
});

test('without it, the slow service keeps working for nobody', async (t) => {
  const url = await withServer(t);
  const r = await runDemo(url, { mode: 'plain', budget: 400, latency: 1200 });
  assert.equal(r.outcome.ok, false);
  assert.ok(r.events.some((e) => e.service === 'inventory' && e.kind === 'waste'));
  assert.ok(r.wastedMs > 500, `wasted only ${r.wastedMs}ms`);
});

test('when the budget is big enough, both modes succeed', async (t) => {
  const url = await withServer(t);
  for (const mode of ['relay', 'plain']) {
    const r = await runDemo(url, { mode, budget: 2000, latency: 100 });
    assert.equal(r.outcome.ok, true, mode);
    assert.equal(r.wastedMs, 0, mode);
  }
});

test('clamps out-of-range input', async (t) => {
  const url = await withServer(t);
  const r = await runDemo(url, { mode: 'relay', budget: 999999, latency: -5 });
  assert.equal(r.budget, 5000);
  assert.equal(r.latency, 0);
});

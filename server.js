'use strict';

// A demo of the deadline-relay npm package.
//
// Three "services" (gateway -> orders -> inventory) run in this one process so
// the demo starts with a single command, but they talk to each other over real HTTP
// exactly as separate deployments would. Each request is tagged with a run id
// so the page can show a timeline of what every service did.

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { deadline, DeadlineExceededError, CancelledError } = require('deadline-relay');

const RUN_HEADER = 'x-demo-run';
const LIMITS = { budget: [50, 5000], latency: [0, 4000] };

/** In-flight demo runs: id -> { t0, latency, events, inventoryDone, clientDoneAt } */
const runs = new Map();

const clamp = (value, [min, max], fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

function record(runId, service, message, kind = 'info') {
  const run = runs.get(runId);
  if (!run) return;
  run.events.push({ t: Math.round(performance.now() - run.t0), service, message, kind });
}

/** Simulated work (a DB query, an API call...) that stops if `signal` aborts. */
function work(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(signal.reason);
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

function describeStop(err) {
  if (err instanceof DeadlineExceededError) return 'stopped: its deadline ran out';
  if (err instanceof CancelledError) return 'stopped: its caller hung up';
  return `failed: ${err.message}`;
}

function createApp() {
  const app = express();
  const base = () => `http://127.0.0.1:${app.locals.port}`;

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/health', (req, res) => res.json({ ok: true }));

  // ---------------------------------------------------------------------------
  // WITH deadline-relay: every service gets req.deadline and forwards the
  // remaining budget with req.deadline.fetch().
  // ---------------------------------------------------------------------------
  const relay = express.Router();
  relay.use(deadline({ timeout: 5000, max: 5000, reserve: 25 }));

  relay.get('/gateway', async (req, res) => {
    const id = req.get(RUN_HEADER);
    record(id, 'gateway', `received request with a ${req.deadline.budget}ms budget`);
    try {
      await work(30, req.deadline.signal); // e.g. check auth
      const r = await req.deadline.fetch(`${base()}/relay/orders`, { headers: { [RUN_HEADER]: id } });
      record(id, 'gateway', `orders replied ${r.status}`);
      res.status(r.status).send(await r.text());
    } catch (err) {
      record(id, 'gateway', describeStop(err), 'stop');
    }
  });

  relay.get('/orders', async (req, res) => {
    const id = req.get(RUN_HEADER);
    record(id, 'orders', `received ${req.deadline.budget}ms (forwarded by gateway)`);
    try {
      await work(60, req.deadline.signal); // e.g. load the order
      const r = await req.deadline.fetch(`${base()}/relay/inventory`, { headers: { [RUN_HEADER]: id } });
      record(id, 'orders', `inventory replied ${r.status}`);
      res.status(r.status).send(await r.text());
    } catch (err) {
      record(id, 'orders', describeStop(err), 'stop');
    }
  });

  relay.get('/inventory', async (req, res) => {
    const id = req.get(RUN_HEADER);
    const run = runs.get(id);
    const latency = run ? run.latency : 0;
    record(id, 'inventory', `received ${req.deadline.budget}ms, query needs ${latency}ms`);
    try {
      await work(latency, req.deadline.signal); // the slow query, cancellable
      record(id, 'inventory', 'query finished', 'done');
      res.send('in stock');
    } catch (err) {
      record(id, 'inventory', `${describeStop(err)}, query cancelled`, 'stop');
    } finally {
      if (run) run.inventoryDone = true;
    }
  });

  app.use('/relay', relay);

  // ---------------------------------------------------------------------------
  // WITHOUT deadline-relay: the usual setup. Each hop has its own fixed 10s
  // timeout and nobody knows when the client has given up.
  // ---------------------------------------------------------------------------
  const plain = express.Router();
  const FIXED_TIMEOUT = 10_000;

  plain.get('/gateway', async (req, res) => {
    const id = req.get(RUN_HEADER);
    record(id, 'gateway', `received request (fixed ${FIXED_TIMEOUT / 1000}s timeout)`);
    await work(30);
    const r = await fetch(`${base()}/plain/orders`, {
      headers: { [RUN_HEADER]: id },
      signal: AbortSignal.timeout(FIXED_TIMEOUT),
    });
    record(id, 'gateway', `orders replied ${r.status}`);
    if (!res.writableEnded && !req.socket.destroyed) res.status(r.status).send(await r.text());
  });

  plain.get('/orders', async (req, res) => {
    const id = req.get(RUN_HEADER);
    record(id, 'orders', `received request (fixed ${FIXED_TIMEOUT / 1000}s timeout)`);
    await work(60);
    const r = await fetch(`${base()}/plain/inventory`, {
      headers: { [RUN_HEADER]: id },
      signal: AbortSignal.timeout(FIXED_TIMEOUT),
    });
    record(id, 'orders', `inventory replied ${r.status}`);
    res.status(r.status).send(await r.text());
  });

  plain.get('/inventory', async (req, res) => {
    const id = req.get(RUN_HEADER);
    const run = runs.get(id);
    const latency = run ? run.latency : 0;
    record(id, 'inventory', `query needs ${latency}ms`);
    await work(latency); // not cancellable: nothing tells it to stop
    const late = run && run.clientDoneAt !== undefined;
    record(
      id,
      'inventory',
      late ? 'query finished, but the client already gave up: wasted work' : 'query finished',
      late ? 'waste' : 'done'
    );
    if (run) run.inventoryDone = true;
    res.send('in stock');
  });

  app.use('/plain', plain);

  // ---------------------------------------------------------------------------
  // The page calls this. It plays the client: call the gateway, give up after
  // `budget` ms, then wait until inventory has stopped and return the timeline.
  // ---------------------------------------------------------------------------
  app.post('/api/run', async (req, res) => {
    const body = req.body || {};
    const budget = clamp(body.budget, LIMITS.budget, 500);
    const latency = clamp(body.latency, LIMITS.latency, 2000);
    const mode = body.mode === 'plain' ? 'plain' : 'relay';

    const id = randomUUID();
    const run = { t0: performance.now(), latency, events: [], inventoryDone: false };
    runs.set(id, run);

    record(id, 'client', `calls gateway, will wait at most ${budget}ms`);
    const headers = { [RUN_HEADER]: id };
    if (mode === 'relay') headers['x-request-timeout-ms'] = String(budget);

    let outcome;
    try {
      const r = await fetch(`${base()}/${mode}/gateway`, {
        headers,
        signal: AbortSignal.timeout(budget),
      });
      const text = await r.text();
      outcome = { status: r.status, ok: r.ok };
      record(id, 'client', `got HTTP ${r.status}: ${text.slice(0, 80)}`, r.ok ? 'done' : 'stop');
    } catch {
      outcome = { status: null, ok: false };
      record(id, 'client', `gave up after ${budget}ms`, 'stop');
    }
    const clientDoneAt = Math.round(performance.now() - run.t0);
    run.clientDoneAt = clientDoneAt;

    // Wait until inventory has finished or stopped (or was never reached).
    const waitLimit = performance.now() + latency + 1500;
    while (!run.inventoryDone && performance.now() < waitLimit) {
      await work(20);
    }
    await work(30); // let the last log lines arrive

    const events = run.events.slice().sort((a, b) => a.t - b.t);
    const inventoryEnd = events.filter((e) => e.service === 'inventory').map((e) => e.t).pop();
    const wastedMs = inventoryEnd !== undefined ? Math.max(0, inventoryEnd - clientDoneAt) : 0;
    runs.delete(id);

    res.json({ mode, budget, latency, outcome, clientDoneAt, inventoryEnd, wastedMs, events });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return;
    res.status(500).json({ error: err.message });
  });

  return app;
}

/** Start the server; resolves with the http.Server once listening. */
function start(port = Number(process.env.PORT) || 3000) {
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      app.locals.port = server.address().port;
      resolve(server);
    });
  });
}

if (require.main === module) {
  start().then((server) => {
    console.log(`deadline-relay demo running on http://localhost:${server.address().port}`);
  });
}

module.exports = { createApp, start };

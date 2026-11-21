# deadline-relay demo

[![CI](https://github.com/anshikaahuja19/deadline-relay-demo/actions/workflows/ci.yml/badge.svg)](https://github.com/anshikaahuja19/deadline-relay-demo/actions/workflows/ci.yml)

A live demo of the [**deadline-relay**](https://www.npmjs.com/package/deadline-relay) npm package.

**▶ Live demo:** <LIVE_URL>
**▶ Pre-loaded comparison:** <LIVE_URL>/?run=compare&budget=500&latency=2000

**Package:** [npmjs.com/package/deadline-relay](https://www.npmjs.com/package/deadline-relay) ·
[source on GitHub](https://github.com/anshikaahuja19/deadline-relay)

## What it shows

A client calls three services in a chain: **gateway → orders → inventory**. The client will only wait for a fixed time (its *budget*), and the inventory query is slow. The page runs the same request two ways and shows a timeline for each:

| | Without deadline-relay | With deadline-relay |
| --- | --- | --- |
| Each service's timeout | A fixed 10 s, regardless of the caller | The caller's **remaining** budget, forwarded at every hop |
| When the client gives up | Inventory keeps running its query to the end | Every service's `AbortSignal` fires and the query is cancelled |
| What the client gets | A client-side timeout | A clean `504 Gateway Timeout` before its own timer fires |
| Example (500 ms budget, 2000 ms query) | **~1600 ms of wasted work** | **0 ms wasted** |

Use the sliders to try other combinations. Give the client more time than the query needs, and both versions succeed.

## How it uses the package

The package is installed from npm like any other dependency (see [`package.json`](./package.json)):

```bash
npm install deadline-relay
```

All the relevant code is in [`server.js`](./server.js):

```js
const { deadline, DeadlineExceededError, CancelledError } = require('deadline-relay');

const relay = express.Router();
relay.use(deadline({ timeout: 5000, max: 5000, reserve: 25 })); // 1. every request gets req.deadline

relay.get('/orders', async (req, res) => {
  // 2. forward the *remaining* budget to the next service
  const r = await req.deadline.fetch(`${base}/relay/inventory`);
  res.status(r.status).send(await r.text());
});

relay.get('/inventory', async (req, res) => {
  // 3. slow work that stops as soon as the budget runs out
  await work(latency, req.deadline.signal);
  res.send('in stock');
});
```

The "without" version (`/plain/*` routes in the same file) uses plain `fetch` with a fixed `AbortSignal.timeout(10000)` at each hop, which is how most services are written today.

## Run it locally

```bash
git clone https://github.com/anshikaahuja19/deadline-relay-demo.git
cd deadline-relay-demo
npm install
npm start          # http://localhost:3000
npm test           # 5 end-to-end tests
```

Requires Node.js 18 or newer.

## Project structure

```
server.js           Express app: the 3 services (with and without deadline-relay) + /api/run
public/index.html   the demo page
public/app.js       runs the comparison and draws the timelines
public/style.css    styles (light and dark mode)
test/demo.test.js   end-to-end tests against a real server
render.yaml         deployment config for Render
```

## API

| Endpoint | Description |
| --- | --- |
| `GET /` | The demo page. Add `?run=compare&budget=500&latency=2000` to run a comparison on load (`run` can also be `relay` or `plain`). |
| `POST /api/run` | Body: `{ "mode": "relay" \| "plain", "budget": 50–5000, "latency": 0–4000 }`. Returns the outcome, the wasted milliseconds, and a timeline of events. |
| `GET /health` | Health check: `{ "ok": true }`. |

## Deployment

It's deployed on [Render](https://render.com) using [`render.yaml`](./render.yaml): `npm install`, then `npm start`. The server listens on `$PORT`.

> On Render's free plan the app sleeps when idle, so the first visit can take up to a minute to wake it.

## Notes

The three services run in **one process** so the demo can be hosted for free. They still call each other over **real HTTP** (`127.0.0.1`), so the headers, timeouts and cancellation behave exactly as they would between separate deployments.

## License

MIT

'use strict';

const $ = (id) => document.getElementById(id);
const SERVICES = ['client', 'gateway', 'orders', 'inventory'];

for (const [input, output] of [['budget', 'budgetOut'], ['latency', 'latencyOut']]) {
  $(input).addEventListener('input', () => {
    $(output).textContent = $(input).value;
  });
}

async function run(mode) {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, budget: Number($('budget').value), latency: Number($('latency').value) }),
  });
  if (!res.ok) throw new Error(`Server replied ${res.status}`);
  return res.json();
}

function verdict(r) {
  if (r.outcome.ok) {
    return { cls: 'good', text: `Inventory answered within the budget (${r.clientDoneAt}ms). Nothing wasted.` };
  }
  if (r.wastedMs > 0) {
    return {
      cls: 'bad',
      text: `Client gave up at ${r.clientDoneAt}ms, but inventory kept working until ${r.inventoryEnd}ms: ${r.wastedMs}ms of wasted work.`,
    };
  }
  const how = r.outcome.status ? `got a clean HTTP ${r.outcome.status}` : 'gave up';
  return {
    cls: 'good',
    text: `Client ${how} at ${r.clientDoneAt}ms, and inventory stopped at ${r.inventoryEnd ?? '-'}ms. No wasted work.`,
  };
}

function markerLabel(r) {
  if (r.outcome.ok) return 'client got answer';
  return r.outcome.status ? `client got ${r.outcome.status}` : 'client gave up';
}

/** One lane per service, a bar from its first to its last event. */
function renderTimeline(container, r, scaleMax) {
  const pct = (t) => `${Math.min(100, (t / scaleMax) * 100)}%`;
  container.innerHTML = '';

  for (const service of SERVICES) {
    const events = r.events.filter((e) => e.service === service);
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.innerHTML = `<div class="lane-name">${service}</div><div class="lane-track"></div>`;
    const track = lane.querySelector('.lane-track');

    if (events.length) {
      const start = events[0].t;
      const last = events[events.length - 1];
      const bar = document.createElement('div');
      bar.className = `bar ${last.kind}`;
      bar.style.left = pct(start);
      bar.style.width = `max(3px, calc(${pct(last.t)} - ${pct(start)}))`;
      bar.title = `${service}: ${start}ms → ${last.t}ms\n${last.message}`;
      track.appendChild(bar);
    }

    const line = document.createElement('div');
    line.className = 'giveup';
    line.style.left = pct(r.clientDoneAt);
    track.appendChild(line);
    if (service === 'client') {
      const label = document.createElement('span');
      label.className = 'giveup-label';
      label.style.left = pct(r.clientDoneAt);
      label.textContent = markerLabel(r);
      // Keep the label inside the track when the marker is near either edge.
      const ratio = r.clientDoneAt / scaleMax;
      if (ratio > 0.8) label.style.transform = 'translateX(-100%)';
      if (ratio < 0.2) label.style.transform = 'none';
      track.appendChild(label);
    }
    container.appendChild(lane);
  }

  const axis = document.createElement('div');
  axis.className = 'axis';
  axis.innerHTML = `<div></div><div><span>0ms</span><span>${Math.round(scaleMax / 2)}ms</span><span>${scaleMax}ms</span></div>`;
  container.appendChild(axis);
}

function renderRun(r, scaleMax, single) {
  const node = $('runTemplate').content.firstElementChild.cloneNode(true);
  if (single) node.classList.add('single');
  node.querySelector('h3').textContent =
    r.mode === 'relay' ? 'With deadline-relay' : 'Without (fixed timeouts per service)';
  const v = verdict(r);
  const p = node.querySelector('.verdict');
  p.textContent = v.text;
  p.classList.add(v.cls);
  renderTimeline(node.querySelector('.timeline'), r, scaleMax);

  const log = node.querySelector('.log');
  for (const e of r.events) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="t"></span><span class="svc"></span><span class="msg"></span>`;
    li.querySelector('.t').textContent = `${e.t}ms`;
    li.querySelector('.svc').textContent = e.service;
    const msg = li.querySelector('.msg');
    msg.textContent = e.message;
    if (e.kind !== 'info') msg.classList.add(e.kind);
    log.appendChild(li);
  }
  return node;
}

async function go(modes) {
  const buttons = document.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  $('results').innerHTML = '<p class="empty">Running… (this takes as long as the slow service)</p>';
  try {
    const results = await Promise.all(modes.map(run));
    const maxT = Math.max(...results.flatMap((r) => r.events.map((e) => e.t)), 100);
    const scaleMax = Math.ceil(maxT / 100) * 100;
    $('results').innerHTML = '';
    for (const r of results) $('results').appendChild(renderRun(r, scaleMax, results.length === 1));
  } catch (err) {
    $('results').innerHTML = `<p class="empty">Something went wrong: ${err.message}</p>`;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

$('compare').addEventListener('click', () => go(['relay', 'plain']));
$('runRelay').addEventListener('click', () => go(['relay']));
$('runPlain').addEventListener('click', () => go(['plain']));

// Shareable links: ?run=compare&budget=500&latency=2000 runs on page load.
(() => {
  const params = new URLSearchParams(location.search);
  for (const key of ['budget', 'latency']) {
    if (params.has(key)) {
      $(key).value = params.get(key);
      $(`${key}Out`).textContent = $(key).value;
    }
  }
  const auto = { compare: ['relay', 'plain'], relay: ['relay'], plain: ['plain'] }[params.get('run')];
  if (auto) go(auto);
})();

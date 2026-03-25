// src/index.js
// Runner that calls scanner.scanRootTf and scanner.publishSignalsAlways to ensure each evaluated symbol is pushed when configured.

const fs = require('fs');
const path = require('path');
const express = require('express');
const client = require('prom-client');

function localRequire(name) {
  try { return require('./' + name); } catch (e) {
    try { return require('./src/' + name); } catch (e2) {
      return require(name);
    }
  }
}

const cfg = localRequire('config');
const scanner = localRequire('scanner');
const bybit = localRequire('bybit');
const storage = localRequire('storage');
const telegram = localRequire('telegram');

const scanRootTf = scanner.scanRootTf;
const publishSignalsAlways = scanner.publishSignalsAlways;
const BybitWS = bybit.BybitWS || bybit;
const listOpenTrades = (storage && storage.listOpenTrades) || (async () => []);
const sendTelegram = (telegram && telegram.sendTelegram) || (async () => {});

const app = express();
app.use(express.json());

console.log(`Config: TESTNET=${cfg.TESTNET} MARKET=${cfg.BYBIT_MARKET} BYBIT_WS=${cfg.BYBIT_WS} BYBIT_BASE_API=${cfg.BYBIT_BASE_API}`);

const wsClient = new BybitWS();

let stats = { lastScans: {}, scanned: 0, signals: 0, errors: 0 };
let lastScanResults = {};

const mScans = new client.Counter({ name: 'scanner_runs_total', help: 'Total scanner runs' });
const mSignals = new client.Counter({ name: 'signals_total', help: 'Signals found' });
const mOpenTrades = new client.Gauge({ name: 'open_trades_gauge', help: 'Open trades count' });
const register = client.register;

function scheduleAligned(rootTf, runner) {
  const now = new Date();
  if (rootTf === '1h') {
    const next = new Date(now);
    next.setUTCMinutes(0,0,0);
    next.setUTCHours(next.getUTCHours() + 1);
    const wait = next - now;
    const period = 60 * 60 * 1000;
    setTimeout(() => { runner({ aligned: true }); setInterval(() => runner({ aligned: true }), period); }, wait);
  } else if (rootTf === '4h') {
    const next = new Date(now);
    const h = now.getUTCHours();
    const nextH = Math.floor(h / 4) * 4 + 4;
    next.setUTCHours(nextH, 0, 0, 0);
    const wait = next - now;
    const period = 4 * 60 * 60 * 1000;
    setTimeout(() => { runner({ aligned: true }); setInterval(() => runner({ aligned: true }), period); }, wait);
  } else if (rootTf === '1d') {
    const next = new Date(now);
    next.setUTCHours(24,0,0,0);
    const wait = next - now;
    const period = 24 * 60 * 60 * 1000;
    setTimeout(() => { runner({ aligned: true }); setInterval(() => runner({ aligned: true }), period); }, wait);
  }
}

async function runnerFor(rootTf, opts = { aligned: false }) {
  try {
    mScans.inc();
    stats.scanned++;
    const signals = await scanRootTf(rootTf);
    lastScanResults[rootTf] = signals;
    stats.lastScans[rootTf] = { when: new Date().toISOString(), count: signals.length };
    mSignals.inc(signals.length);
    stats.signals += signals.length;
    // publish to telegram if enabled or PUSH_ALL_SIGNALS_ON_STARTUP
    const always = (process.env.TELEGRAM_ALWAYS_PUSH_SIGNALS || 'false') === 'true';
    const pushAllStartup = (process.env.PUSH_ALL_SIGNALS_ON_STARTUP || 'false') === 'true';
    if (always || (!opts.aligned && pushAllStartup)) {
      try { await publishSignalsAlways(signals); } catch (e) { console.warn('publishSignalsAlways failed', e && e.message); }
    }
    // existing handling: process top candidates for trade opening (aligned only)
    // (we intentionally do not open trades on not-aligned runs)
    const toProcess = signals.slice(0, Math.max(1, (cfg.MAX_OPEN_TRADES || 1) * 5));
    for (const sig of toProcess) {
      try {
        // require handleRootSignal from legacy modules if present
        const legacy = localRequire('scanner');
        if (legacy && typeof legacy.handleRootSignal === 'function') {
          await legacy.handleRootSignal(sig, wsClient, { aligned: !!opts.aligned });
        }
      } catch (e) {
        console.warn('handleRootSignal invocation error', e && e.message);
      }
    }
  } catch (err) {
    stats.errors++;
    console.error('runner error', err && (err.stack || err.message || err));
  }
}

// schedule and startup immediate scans
scheduleAligned('1h', () => runnerFor('1h'));
scheduleAligned('4h', () => runnerFor('4h'));
scheduleAligned('1d', () => runnerFor('1d'));

(async function runImmediateScans() {
  const runImmediate = (process.env.RUN_IMMEDIATE_SCANS || 'true').toLowerCase() !== 'false';
  if (!runImmediate) return;
  try {
    console.log('Initial scan: starting immediate root-TF scans (1h, 4h, 1d)');
    await runnerFor('1h', { aligned: false });
    await new Promise(r => setTimeout(r, 2000));
    await runnerFor('4h', { aligned: false });
    await new Promise(r => setTimeout(r, 2000));
    await runnerFor('1d', { aligned: false });
    console.log('Initial scan: completed immediate runs.');
  } catch (e) {
    console.error('Initial scan error', e && (e.stack || e.message || e));
  }
})();

app.get('/debug/last-scan', async (req, res) => {
  const interval = req.query.interval || '1h';
  const data = lastScanResults[interval] || [];
  const out = data.map(s => ({
    symbol: s.symbol,
    interval: s.interval,
    macdValue: s.macdValue,
    pass: s.filter && s.filter.pass,
    reasons: s.filter && s.filter.reasons,
    details: s.filter && s.filter.details
  }));
  res.json({ interval, count: out.length, results: out });
});

app.get('/health', async (req, res) => {
  try {
    const wsState = (wsClient && wsClient.ws && typeof wsClient.ws.readyState !== 'undefined') ? wsClient.ws.readyState : null;
    let cached = [];
    try {
      if (wsClient && wsClient.prices && typeof wsClient.prices.entries === 'function') cached = Array.from(wsClient.prices.entries()).slice(0,10);
    } catch (e) { cached = []; }
    res.json({
      ok: true, testnet: cfg.TESTNET, market: cfg.BYBIT_MARKET,
      bybit_ws: cfg.BYBIT_WS, bybit_api: cfg.BYBIT_BASE_API,
      wsReadyState: wsState, cachedPricesSample: cached, uptime: process.uptime()
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message });
  }
});

const PORT = cfg.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));
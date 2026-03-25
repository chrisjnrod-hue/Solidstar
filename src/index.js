// src/index.js — lazy init to avoid circular-require warnings
// This version delays loading scanner/bybit until after bootstrap so we don't access
// module properties while they are still initializing. That removes the circular-dependency warnings.

const fs = require('fs');
const path = require('path');
const express = require('express');
const client = require('prom-client');

// localRequire helper (keeps previous behavior)
function localRequire(name) {
  try { return require('./' + name); } catch (e) {
    try { return require('./src/' + name); } catch (e2) {
      try { return require(name); } catch (e3) { return null; }
    }
  }
}

// Load config early (safe; config doesn't require app modules)
const cfg = localRequire('config');

const app = express();
app.use(express.json());

// Minimal startup diagnostics (non-sensitive)
console.log(`Config: TESTNET=${cfg && cfg.TESTNET} MARKET=${cfg && cfg.BYBIT_MARKET}`);
console.log('Startup diag (env presence): TELEGRAM configured?', !!process.env.TELEGRAM_BOT_TOKEN, 'CHAT_ID present?', !!process.env.TELEGRAM_CHAT_ID);
console.log('Startup diag: FILTER_MTF=', process.env.FILTER_MTF || '(unset)', 'DEBUG_FILTERS=', process.env.DEBUG_FILTERS || (cfg && cfg.DEBUG_FILTERS));

// Metrics and state
let stats = { lastScans: {}, scanned: 0, signals: 0, errors: 0 };
let lastScanResults = {};
const mScans = new client.Counter({ name: 'scanner_runs_total', help: 'Total scanner runs' });
const mSignals = new client.Counter({ name: 'signals_total', help: 'Signals found' });
const mOpenTrades = new client.Gauge({ name: 'open_trades_gauge', help: 'Open trades count' });
const register = client.register;

// Holders for modules that we'll initialize lazily
let scanner = null;
let scanRootTf = null;
let publishSignalsAlways = null;
let bybit = null;
let BybitWS = null;
let wsClient = null;
let storage = null;
let telegram = null;
let sendTelegram = async () => {};

// Helper: initialize runtime modules once (lazy)
function initRuntimeModules() {
  if (scanner) return; // already initialized

  // Load modules (do minimal probing — avoid deep .default access that triggers warnings)
  scanner = localRequire('scanner') || localRequire('src/scanner') || null;
  bybit = localRequire('bybit') || localRequire('src/bybit') || null;
  storage = localRequire('storage') || localRequire('src/storage') || null;
  telegram = localRequire('telegram') || localRequire('src/telegram') || null;

  // Normalize scanner exports (prefer scanRootTf property, otherwise module function)
  if (scanner && typeof scanner.scanRootTf === 'function') {
    scanRootTf = scanner.scanRootTf;
    publishSignalsAlways = typeof scanner.publishSignalsAlways === 'function' ? scanner.publishSignalsAlways : (async () => {});
    console.log('Using scanner.scanRootTf and scanner.publishSignalsAlways');
  } else if (typeof scanner === 'function') {
    scanRootTf = scanner;
    publishSignalsAlways = async () => {};
    console.log('Using scanner module function as scanRootTf');
  } else {
    console.warn('scanner module not found or missing scanRootTf — using fallback that returns empty signals.');
    scanRootTf = async (rootTf) => [];
    publishSignalsAlways = async () => {};
  }

  // Normalize bybit exports and instantiate BybitWS if available
  if (bybit && typeof bybit.BybitWS === 'function') {
    BybitWS = bybit.BybitWS;
    try {
      wsClient = new BybitWS();
      console.log('BybitWS instance created successfully');
    } catch (e) {
      console.warn('BybitWS constructor threw; falling back to stub:', e && e.message);
      BybitWS = null;
      wsClient = null;
    }
  } else if (bybit && typeof bybit === 'function') {
    // module itself might be a constructor
    try {
      wsClient = new bybit();
      console.log('Bybit module used as constructor and instance created');
    } catch (e) {
      wsClient = null;
    }
  } else {
    wsClient = null;
  }

  if (!wsClient) {
    // safe stub
    wsClient = { prices: new Map(), subscribeKline: () => () => {}, subscribeTopic: () => () => {}, getPrice: () => undefined, close: () => {} };
    console.warn('Using fallback BybitWS stub (reduced functionality).');
  }

  // set sendTelegram helper
  sendTelegram = (telegram && typeof telegram.sendTelegram === 'function') ? telegram.sendTelegram : async () => {
    if (process.env.DEBUG_FILTERS === 'true') console.log('sendTelegram called but no telegram.sendTelegram present.');
  };

  // Log shapes for diagnostics
  try {
    console.log('Scanner module typeof:', typeof scanner, 'keys:', (scanner && typeof scanner === 'object') ? Object.keys(scanner) : '');
    console.log('Bybit module typeof:', typeof bybit, 'keys:', (bybit && typeof bybit === 'object') ? Object.keys(bybit) : '');
  } catch (e) {}
}

// schedule helpers remain unchanged
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

// runner uses scanRootTf which will be set by initRuntimeModules()
async function runnerFor(rootTf, opts = { aligned: false }) {
  try {
    // ensure runtime modules are loaded (lazy)
    initRuntimeModules();

    mScans.inc();
    stats.scanned++;
    const signals = await scanRootTf(rootTf);
    lastScanResults[rootTf] = signals;
    stats.lastScans[rootTf] = { when: new Date().toISOString(), count: signals.length };
    mSignals.inc(signals.length);
    stats.signals += signals.length;

    const always = (process.env.TELEGRAM_ALWAYS_PUSH_SIGNALS || 'false') === 'true';
    const pushAllStartup = (process.env.PUSH_ALL_SIGNALS_ON_STARTUP || 'false') === 'true';
    if (always || (!opts.aligned && pushAllStartup)) {
      try { await publishSignalsAlways(signals); } catch (e) { console.warn('publishSignalsAlways failed', e && e.message); }
    }

    // optional legacy handler invocation (safe lazy load)
    const legacy = localRequire('scanner');
    if (legacy && typeof legacy.handleRootSignal === 'function') {
      const toProcess = signals.slice(0, Math.max(1, (cfg.MAX_OPEN_TRADES || 1) * 5));
      for (const sig of toProcess) {
        try { await legacy.handleRootSignal(sig, wsClient, { aligned: !!opts.aligned }); } catch (e) { console.warn('handleRootSignal error', e && e.message); }
      }
    }
  } catch (err) {
    stats.errors++;
    console.error('runner error', err && (err.stack || err.message || err));
  }
}

// schedule scans (these call runnerFor which does lazy init)
scheduleAligned('1h', () => runnerFor('1h'));
scheduleAligned('4h', () => runnerFor('4h'));
scheduleAligned('1d', () => runnerFor('1d'));

// run immediate scans
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

// endpoints to inspect results
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
    // ensure runtime modules loaded for this diagnostic
    initRuntimeModules();
    const wsState = (wsClient && wsClient.ws && typeof wsClient.ws.readyState !== 'undefined') ? wsClient.ws.readyState : null;
    let cached = [];
    try { if (wsClient && wsClient.prices && typeof wsClient.prices.entries === 'function') cached = Array.from(wsClient.prices.entries()).slice(0,10); } catch (e) { cached = []; }
    res.json({
      ok: true, testnet: cfg.TESTNET, market: cfg.BYBIT_MARKET,
      bybit_ws: cfg.BYBIT_WS, bybit_api: cfg.BYBIT_BASE_API,
      wsReadyState: wsState, cachedPricesSample: cached, uptime: process.uptime()
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message });
  }
});

const PORT = (cfg && cfg.PORT) || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));

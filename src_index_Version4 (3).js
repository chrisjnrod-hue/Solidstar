// src/index.js
// Runner with robust BybitWS and scanner detection + diagnostics to avoid crashes.

// localRequire helper MUST be defined before it's used
function localRequire(name) {
  try { return require('./' + name); } catch (e) {
    try { return require('./src/' + name); } catch (e2) {
      try { return require(name); } catch (e3) { return null; }
    }
  }
}

const fs = require('fs');
const path = require('path');
const express = require('express');
const client = require('prom-client');

const cfg = localRequire('config');
const scanner = localRequire('scanner');
const bybit = localRequire('bybit');
const storage = localRequire('storage');
const telegram = localRequire('telegram');

// --- Robust scanner detection / fallbacks ---
let scanRootTf = null;
let publishSignalsAlways = null;

try {
  console.log('Scanner module typeof:', typeof scanner, 'keys:', (scanner && typeof scanner === 'object') ? Object.keys(scanner) : '');

  // 1) module exports the functions directly: module.exports = { scanRootTf, publishSignalsAlways }
  if (scanner && typeof scanner.scanRootTf === 'function') {
    scanRootTf = scanner.scanRootTf;
    publishSignalsAlways = typeof scanner.publishSignalsAlways === 'function' ? scanner.publishSignalsAlways : (async () => {});
    console.log('Using scanner.scanRootTf and scanner.publishSignalsAlways');
  }
  // 2) module is a function (exports default function) => treat as scanRootTf
  else if (typeof scanner === 'function') {
    scanRootTf = scanner;
    publishSignalsAlways = async () => {};
    console.log('Scanner module exported a function; using it as scanRootTf');
  }
  // 3) module uses default export object (e.g. transpiled modules)
  else if (scanner && scanner.default) {
    console.log('Scanner module has default export. default typeof:', typeof scanner.default, 'keys:', (scanner.default && typeof scanner.default === 'object') ? Object.keys(scanner.default) : '');
    if (typeof scanner.default === 'function') {
      scanRootTf = scanner.default;
      publishSignalsAlways = async () => {};
      console.log('Using scanner.default as scanRootTf');
    } else if (scanner.default && typeof scanner.default.scanRootTf === 'function') {
      scanRootTf = scanner.default.scanRootTf;
      publishSignalsAlways = typeof scanner.default.publishSignalsAlways === 'function' ? scanner.default.publishSignalsAlways : (async () => {});
      console.log('Using scanner.default.scanRootTf and scanner.default.publishSignalsAlways');
    }
  }

  // 4) safety: check nested export key variants
  if (!scanRootTf && scanner && typeof scanner === 'object') {
    for (const k of ['scanRootTf', 'scanrootTf', 'scanRootTF', 'scan_root_tf', 'scan']) {
      if (scanner[k] && typeof scanner[k] === 'function') {
        scanRootTf = scanner[k];
        console.log(`Found scanner function via key "${k}"`);
        break;
      }
    }
  }
} catch (e) {
  console.error('Scanner detection error', e && e.stack);
}

// Final fallback: don't crash, return empty signals so runner proceeds
if (!scanRootTf) {
  console.warn('WARNING: scanner.scanRootTf not found — installing fallback stub that returns empty signals. Scans will produce no results until fixed.');
  scanRootTf = async (rootTf) => { return []; };
}
if (!publishSignalsAlways) {
  publishSignalsAlways = async (signals) => { /* no-op fallback */ };
}

// --- Robust BybitWS detection/instantiation (diagnostic + fallback) ---
let BybitWSImpl = null;
let wsClient = null;

try {
  // Log shape of the imported bybit module to help debug mismatches
  try {
    console.log('Bybit module typeof:', typeof bybit, 'keys:', (bybit && typeof bybit === 'object') ? Object.keys(bybit) : '');
  } catch (e) {
    console.log('Bybit module logging failed', e && e.message);
  }

  if (bybit && typeof bybit.BybitWS === 'function') {
    BybitWSImpl = bybit.BybitWS;
    console.log('Using bybit.BybitWS constructor');
  } else if (bybit && typeof bybit === 'function') {
    // module itself is a constructor function/class
    BybitWSImpl = bybit;
    console.log('Using bybit as constructor (module exported constructor directly)');
  } else if (bybit && typeof bybit === 'object' && bybit.BybitWS && typeof bybit.BybitWS === 'object') {
    // The module exported an instance rather than a class
    wsClient = bybit.BybitWS;
    console.log('bybit.BybitWS appears to be an object instance; using as wsClient instance');
  } else if (bybit && typeof bybit === 'object' && bybit.default) {
    // sometimes transpiled modules expose default; try that
    if (typeof bybit.default === 'function') {
      BybitWSImpl = bybit.default;
      console.log('Using bybit.default as constructor');
    } else if (bybit.default && typeof bybit.default.BybitWS === 'function') {
      BybitWSImpl = bybit.default.BybitWS;
      console.log('Using bybit.default.BybitWS as constructor');
    }
  }

  if (!wsClient && BybitWSImpl) {
    try {
      wsClient = new BybitWSImpl();
      console.log('BybitWS instance created successfully');
    } catch (err) {
      console.error('BybitWS constructor invocation failed', err && (err.stack || err.message));
      wsClient = null;
    }
  }
} catch (e) {
  console.error('BybitWS detection failed', e && e.stack);
}

if (!wsClient) {
  // final safe fallback: minimal stub that satisfies usage (close/getPrice)
  console.warn('WARNING: BybitWS not available as constructor/instance. Using fallback stub. Scanner may have reduced functionality.');
  wsClient = {
    prices: new Map(),
    subscribeKline: () => () => {},
    subscribeTopic: () => () => {},
    getPrice: (s) => undefined,
    close: () => {}
  };
}

// continue normal wiring
const listOpenTrades = (storage && storage.listOpenTrades) || (async () => []);
const sendTelegram = (telegram && telegram.sendTelegram) || (async () => {});

const app = express();
app.use(express.json());

console.log(`Config: TESTNET=${cfg && cfg.TESTNET} MARKET=${cfg && cfg.BYBIT_MARKET} BYBIT_WS=${cfg && cfg.BYBIT_WS} BYBIT_BASE_API=${cfg && cfg.BYBIT_BASE_API}`);

// Startup diagnostics (non-sensitive): show presence/values that help debug env wiring
console.log('Startup diag: TELEGRAM configured?', !!(process.env.TELEGRAM_BOT_TOKEN || (cfg && cfg.TELEGRAM_BOT_TOKEN)), 'CHAT_ID present?', !!(process.env.TELEGRAM_CHAT_ID || (cfg && cfg.TELEGRAM_CHAT_ID)));
console.log('Startup diag: FILTER_MTF=', process.env.FILTER_MTF || '(unset)', 'DEBUG_FILTERS=', process.env.DEBUG_FILTERS || (cfg && cfg.DEBUG_FILTERS));
console.log('Startup diag: VOL_MULTIPLIER_1H=', process.env.VOL_MULTIPLIER_1H || '(unset)', 'HIST_Z_THRESHOLD_1H=', process.env.HIST_Z_THRESHOLD_1H || '(unset)', 'MIN_AVG_VOLUME_1H=', process.env.MIN_AVG_VOLUME_1H || '(unset)');

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
    const toProcess = signals.slice(0, Math.max(1, (cfg && cfg.MAX_OPEN_TRADES || 1) * 5));
    for (const sig of toProcess) {
      try {
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
      ok: true, testnet: cfg && cfg.TESTNET, market: cfg && cfg.BYBIT_MARKET,
      bybit_ws: cfg && cfg.BYBIT_WS, bybit_api: cfg && cfg.BYBIT_BASE_API,
      wsReadyState: wsState, cachedPricesSample: cached, uptime: process.uptime()
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message });
  }
});

const PORT = (cfg && cfg.PORT) || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));
// src/index.js
// Updates: store lastScanResults per interval and publishSignals during immediate scans if PUSH_ALL_SIGNALS_ON_STARTUP=true
// Exposes: GET /debug/last-scan?interval=1h

const fs = require('fs');
const path = require('path');
const express = require('express');
const client = require('prom-client');

function tryRequireLocalSingle(name) {
  try { return require('./' + name); } catch (e) {
    try { return require('./src/' + name); } catch (e2) {
      try { return require(name); } catch (e3) { throw e3; }
    }
  }
}

const cfg = tryRequireLocalSingle('config');
const scannerMod = tryRequireLocalSingle('scanner');
const bybitMod = tryRequireLocalSingle('bybit');
const tradeManagerMod = tryRequireLocalSingle('tradeManager');
const storageMod = tryRequireLocalSingle('storage');
const telegramMod = tryRequireLocalSingle('telegram');

const scanRootTf = scannerMod.scanRootTf;
const handleRootSignal = scannerMod.handleRootSignal;
const publishSignals = scannerMod.publishSignals;
const BybitWS = bybitMod.BybitWS || bybitMod;
const listOpenTrades = storageMod.listOpenTrades || (async ()=>[]);
const setKillSwitch = storageMod.setKillSwitch || (async ()=>{});
const getKillSwitch = storageMod.getKillSwitch || (async ()=>false);
const sendTelegram = telegramMod.sendTelegram || (async ()=>{});

const app = express();
app.use(express.json());

console.log(`Config: TESTNET=${cfg.TESTNET} MARKET=${cfg.BYBIT_MARKET} BYBIT_WS=${cfg.BYBIT_WS} BYBIT_BASE_API=${cfg.BYBIT_BASE_API}`);

const wsClient = new BybitWS();

let stats = { lastScans: {}, scanned: 0, signals: 0, errors: 0 };
let lastScanResults = {}; // store last scan signals per interval

const mScans = new client.Counter({ name: 'scanner_runs_total', help: 'Total scanner runs' });
const mSignals = new client.Counter({ name: 'signals_total', help: 'Signals found' });
const mOpenTrades = new client.Gauge({ name: 'open_trades_gauge', help: 'Open trades count' });
const register = client.register;

function pctChange(from, to, side) {
  if (!from || !to) return 0;
  const change = (to - from) / from * 100.0;
  return side === 'buy' ? change : -change;
}

async function runnerFor(rootTf, opts = { aligned: false }) {
  try {
    mScans.inc();
    stats.scanned++;
    const signals = await scanRootTf(rootTf);
    // store for debug endpoint
    lastScanResults[rootTf] = signals;
    stats.lastScans[rootTf] = { when: new Date().toISOString(), count: signals.length };
    mSignals.inc(signals.length);
    stats.signals += signals.length;
    signals.sort((a,b) => b.macdValue - a.macdValue);
    const toProcess = signals.slice(0, Math.max(1, (cfg.MAX_OPEN_TRADES || 1) * 5));
    // if this is an immediate run (aligned=false) and PUSH_ALL_SIGNALS_ON_STARTUP is true, publish all signals
    const pushAllStartup = (process.env.PUSH_ALL_SIGNALS_ON_STARTUP || 'false') === 'true';
    if (!opts.aligned && pushAllStartup) {
      try {
        await publishSignals(signals, { limit: Number(process.env.NOTIFY_ROOT_SIGNALS_LIMIT || 200) });
      } catch (e) { console.warn('publishSignals failed on startup', e && e.message); }
    }
    for (const sig of toProcess) {
      await handleRootSignal(sig, wsClient, { aligned: !!opts.aligned });
    }
  } catch (err) {
    stats.errors++;
    console.error('runner error', err && (err.stack || err.message || err));
  }
}

// scheduleAligned copied from your existing logic (top-of-hour scheduling)
function scheduleAligned(rootTf, runner) {
  const now = new Date();
  if (rootTf === '1h') {
    const next = new Date(now);
    next.setUTCMinutes(0,0,0);
    next.setUTCHours(next.getUTCHours() + 1);
    const wait = next - now;
    const period = 60 * 60 * 1000;
    setTimeout(() => {
      runner({ aligned: true });
      setInterval(() => runner({ aligned: true }), period);
    }, wait);
  } else if (rootTf === '4h') {
    const next = new Date(now);
    const h = now.getUTCHours();
    const nextH = Math.floor(h / 4) * 4 + 4;
    next.setUTCHours(nextH, 0, 0, 0);
    const wait = next - now;
    const period = 4 * 60 * 60 * 1000;
    setTimeout(() => {
      runner({ aligned: true });
      setInterval(() => runner({ aligned: true }), period);
    }, wait);
  } else if (rootTf === '1d') {
    const next = new Date(now);
    next.setUTCHours(24,0,0,0);
    const wait = next - now;
    const period = 24 * 60 * 60 * 1000;
    setTimeout(() => {
      runner({ aligned: true });
      setInterval(() => runner({ aligned: true }), period);
    }, wait);
  }
}

// schedule aligned runs
scheduleAligned('1h', () => runnerFor('1h'));
scheduleAligned('4h', () => runnerFor('4h'));
scheduleAligned('1d', () => runnerFor('1d'));

// run immediate scans on startup unless disabled
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

// debug endpoint for last scan results
app.get('/debug/last-scan', async (req, res) => {
  const interval = req.query.interval || '1h';
  const data = lastScanResults[interval] || [];
  // Don't include full klines to keep payload small; map down
  const out = data.map(s => ({
    symbol: s.symbol,
    interval: s.interval,
    macdValue: s.macdValue,
    pass: s.filter && s.filter.pass,
    reasons: s.filter && s.filter.reasons,
    dailyHist: s.dailyHist,
    prevDailyHist: s.prevDailyHist
  }));
  res.json({ interval, count: out.length, results: out });
});

app.get('/', async (req, res) => {
  const open = await listOpenTrades();
  res.json({
    status: 'ok',
    env: { OPEN_TRADES: cfg.OPEN_TRADES, TESTNET: cfg.TESTNET },
    stats,
    openTradesCount: open ? open.length : 0
  });
});

app.get('/health', async (req, res) => {
  try {
    const wsState = (wsClient && wsClient.ws && typeof wsClient.ws.readyState !== 'undefined') ? wsClient.ws.readyState : null;
    let cached = [];
    try {
      if (wsClient && wsClient.prices && typeof wsClient.prices.entries === 'function') {
        cached = Array.from(wsClient.prices.entries()).slice(0, 10);
      }
    } catch (e) { cached = []; }
    res.json({
      ok: true,
      testnet: cfg.TESTNET,
      market: cfg.BYBIT_MARKET,
      bybit_ws: cfg.BYBIT_WS,
      bybit_api: cfg.BYBIT_BASE_API,
      wsReadyState: wsState,
      cachedPricesSample: cached,
      uptime: process.uptime()
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e && e.message });
  }
});

const PORT = cfg.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));

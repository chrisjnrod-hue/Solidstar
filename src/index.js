// src/index.js
// Lazy init runner + debug endpoints + runtime warning tracer
// Replace the file that start-wrapper uses (check Render logs for the exact path).

// localRequire helper (tries a few common paths)
function localRequire(name) {
  try { return require('./' + name); } catch (e) {
    try { return require('./src/' + name); } catch (e2) {
      try { return require(name); } catch (e3) { return null; }
    }
  }
}

// Basic modules
const express = require('express');
const client = require('prom-client');
const axios = require('axios');

// Load config early (safe)
const cfg = localRequire('config') || { TESTNET: process.env.TESTNET || false };

// Attach a runtime warning handler so Node warnings (including circular-dependency warnings)
// will have their stack printed here even if NODE_OPTIONS wasn't set before process start.
process.on('warning', (warning) => {
  // warning.name, warning.message, warning.stack
  try {
    console.warn('=== NODE WARNING ===');
    console.warn('name:', warning.name);
    console.warn('message:', warning.message);
    console.warn('stack:', warning.stack);
    console.warn('====================');
  } catch (e) {
    console.warn('warning handler error', e && e.message);
  }
});

// Log the NODE_OPTIONS presence for debugging
console.log('NODE_OPTIONS:', process.env.NODE_OPTIONS || '(unset)');

// App + metrics
const app = express();
app.use(express.json());

let lastScanResults = {};
let stats = { scanned: 0, signals: 0, errors: 0 };

// Prom-client metrics (safe to register even if not scraped)
const mScans = new client.Counter({ name: 'scanner_runs_total', help: 'Total scanner runs' });
const mSignals = new client.Counter({ name: 'signals_total', help: 'Signals found' });
const mOpenTrades = new client.Gauge({ name: 'open_trades_gauge', help: 'Open trades count' });

// Lazy runtime modules (will be initialized on first use)
let scannerModule = null;
let bybitModule = null;
let telegramModule = null;
let storageModule = null;
let wsClient = null;
let sendTelegram = async () => { console.log('sendTelegram not configured'); };

// Minimal safe init - avoid probing `.default` deeply to reduce circular warnings
function initRuntimeModules() {
  if (scannerModule || bybitModule) return; // already initialized

  // Try to load canonical modules
  scannerModule = localRequire('scanner') || localRequire('src/scanner') || null;
  bybitModule = localRequire('bybit') || localRequire('src/bybit') || null;
  telegramModule = localRequire('telegram') || localRequire('src/telegram') || null;
  storageModule = localRequire('storage') || localRequire('src/storage') || null;

  // Normalize scanner
  if (scannerModule && typeof scannerModule.scanRootTf === 'function') {
    console.log('Using scanner.scanRootTf and scanner.publishSignalsAlways (if present).');
  } else if (typeof scannerModule === 'function') {
    console.log('Scanner module is a function (used as scanRootTf).');
  } else {
    console.warn('Scanner module not found or missing scanRootTf - runner will use fallback that returns empty results.');
  }

  // Normalize bybit & instantiate WS client if constructor present
  try {
    if (bybitModule && typeof bybitModule.BybitWS === 'function') {
      try {
        wsClient = new bybitModule.BybitWS();
        console.log('BybitWS instance created successfully.');
      } catch (e) {
        console.warn('BybitWS constructor threw, fallback stub will be used:', e && e.message);
        wsClient = null;
      }
    } else if (bybitModule && typeof bybitModule === 'function') {
      try {
        wsClient = new bybitModule();
        console.log('Bybit module used as constructor; instance created.');
      } catch (e) {
        wsClient = null;
      }
    } else {
      wsClient = null;
    }
  } catch (e) {
    wsClient = null;
  }

  if (!wsClient) {
    wsClient = { prices: new Map(), subscribeKline: () => () => {}, subscribeTopic: () => () => {}, getPrice: () => undefined, close: () => {} };
    console.warn('Using fallback BybitWS stub (reduced functionality).');
  }

  if (telegramModule && typeof telegramModule.sendTelegram === 'function') {
    sendTelegram = telegramModule.sendTelegram;
  } else {
    sendTelegram = async (msg) => { console.log('sendTelegram fallback: ', msg); };
  }

  // Log shapes for diagnostics
  try {
    console.log('Scanner module typeof:', typeof scannerModule, 'keys:', (scannerModule && typeof scannerModule === 'object') ? Object.keys(scannerModule) : '');
    console.log('Bybit module typeof:', typeof bybitModule, 'keys:', (bybitModule && typeof bybitModule === 'object') ? Object.keys(bybitModule) : '');
    console.log('Telegram module typeof:', typeof telegramModule, (telegramModule && typeof telegramModule === 'object') ? Object.keys(telegramModule) : '');
  } catch (e) {}
}

// Helpers to get scanner functions safely
function getScanRootTf() {
  initRuntimeModules();
  if (scannerModule && typeof scannerModule.scanRootTf === 'function') return scannerModule.scanRootTf;
  if (typeof scannerModule === 'function') return scannerModule;
  return async (rootTf) => { return []; }; // fallback stub
}
function getPublishSignalsAlways() {
  initRuntimeModules();
  if (scannerModule && typeof scannerModule.publishSignalsAlways === 'function') return scannerModule.publishSignalsAlways;
  return async (signals) => {};
}

// Simple EMA / MACD helpers (used by debug endpoints)
function computeEMA(series, period) {
  if (!Array.isArray(series) || series.length === 0) return [];
  const k = 2 / (period + 1);
  const out = new Array(series.length).fill(0);
  let prev = series[0];
  out[0] = prev;
  for (let i = 1; i < series.length; i++) {
    prev = (series[i] - prev) * k + prev;
    out[i] = prev;
  }
  return out;
}
function computeMACD(closeSeries, fast = 12, slow = 26, signal = 9) {
  if (!Array.isArray(closeSeries) || closeSeries.length === 0) return { macdLine: [], signalLine: [], hist: [] };
  const emaFast = computeEMA(closeSeries, fast);
  const emaSlow = computeEMA(closeSeries, slow);
  const macdLine = closeSeries.map((_, i) => (emaFast[i] || 0) - (emaSlow[i] || 0));
  const signalLine = computeEMA(macdLine, signal);
  const hist = macdLine.map((v, i) => v - (signalLine[i] || 0));
  return { macdLine, signalLine, hist };
}

// ===== Debug endpoints (safe, lazy) =====

// ensure runtime is loaded before debug calls
function ensureRuntime() { try { initRuntimeModules(); } catch (e) {} }

// /debug/klines -> returns raw klines from bybit.fetchKlines
app.get('/debug/klines', async (req, res) => {
  try {
    ensureRuntime();
    const bybit = bybitModule || localRequire('bybit') || require('./bybit');
    if (!bybit || typeof bybit.fetchKlines !== 'function') return res.status(500).json({ ok:false, error:'bybit.fetchKlines not available' });
    const symbol = (req.query.symbol || 'BTCUSDT').toString().toUpperCase();
    const interval = req.query.interval || '60';
    const limit = Number(req.query.limit || 200);
    const klines = await bybit.fetchKlines(symbol, interval, limit);
    return res.json({ ok:true, symbol, interval, count: Array.isArray(klines) ? klines.length : 0, sample: Array.isArray(klines) ? klines.slice(-10) : klines });
  } catch (e) { return res.status(500).json({ ok:false, error: e && e.message }); }
});

// /debug/macd -> returns MACD histogram for recent closes
app.get('/debug/macd', async (req, res) => {
  try {
    ensureRuntime();
    const bybit = bybitModule || localRequire('bybit') || require('./bybit');
    if (!bybit || typeof bybit.fetchKlines !== 'function') return res.status(500).json({ ok:false, error:'bybit.fetchKlines not available' });
    const symbol = (req.query.symbol || 'BTCUSDT').toString().toUpperCase();
    const interval = req.query.interval || '60';
    const limit = Number(req.query.limit || 200);
    const klines = await bybit.fetchKlines(symbol, interval, limit);
    if (!Array.isArray(klines) || klines.length === 0) return res.json({ ok:true, symbol, interval, count:0, hist:[] });
    const closes = klines.map(k => parseFloat(k.close) || 0);
    const macd = computeMACD(closes, 12, 26, 9);
    const hist = macd.hist || [];
    return res.json({ ok:true, symbol, interval, count: closes.length, lastClose: closes[closes.length-1], histSample: hist.slice(-10), latestHist: hist.length ? hist[hist.length-1] : null });
  } catch (e) { return res.status(500).json({ ok:false, error: e && e.message }); }
});

// /debug/filter -> runs your passesFiltersDetailed (if available) and returns full details
app.get('/debug/filter', async (req, res) => {
  try {
    ensureRuntime();
    const bybit = bybitModule || localRequire('bybit') || require('./bybit');
    const filters = localRequire('filters') || localRequire('src/filters') || require('./filters');
    if (!filters || typeof filters.passesFiltersDetailed !== 'function') return res.status(500).json({ ok:false, error:'filters.passesFiltersDetailed not available' });
    const symbol = (req.query.symbol || 'BTCUSDT').toString().toUpperCase();
    const interval = req.query.interval || '1h';
    const intervalApi = (interval === '1h' || interval === '60') ? '60' : (interval === '4h' ? '240' : (interval === '1d' ? 'D' : interval));
    const klines = (bybit && typeof bybit.fetchKlines === 'function') ? await bybit.fetchKlines(symbol, intervalApi, 200) : null;
    if (!klines || !Array.isArray(klines) || klines.length === 0) return res.json({ ok:true, symbol, interval, klinesCount:0, filter:null });
    const closes = klines.map(k => parseFloat(k.close) || 0);
    const macd = computeMACD(closes, 12, 26, 9);
    const hist = macd.hist || [];
    const latestHist = hist.length ? hist[hist.length-1] : 0;
    // try daily hist
    let dailyHist = null, prevDailyHist = null;
    try {
      const dailykl = await bybit.fetchKlines(symbol, 'D', 5);
      if (dailykl && dailykl.length >= 2) {
        const closeD = dailykl.map(k => parseFloat(k.close) || 0);
        const macdD = computeMACD(closeD, 12, 26, 9);
        const histD = macdD.hist || [];
        if (histD.length >= 2) { dailyHist = histD[histD.length-1]; prevDailyHist = histD[histD.length-2]; }
      }
    } catch (e) {}
    const filterResult = filters.passesFiltersDetailed ? filters.passesFiltersDetailed(symbol, interval, klines, latestHist, hist.slice(0,-1), null, dailyHist, prevDailyHist) : { ok:false, reason:'passesFiltersDetailed not present' };
    return res.json({ ok:true, symbol, interval, klinesCount: klines.length, latestHist, dailyHist, prevDailyHist, filter: filterResult });
  } catch (e) { return res.status(500).json({ ok:false, error: e && e.message }); }
});

// /debug/send-test -> server-side telegram send (uses server env token)
app.get('/debug/send-test', async (req, res) => {
  try {
    ensureRuntime();
    const message = req.query.message || 'bybit scanner test message';
    if (typeof sendTelegram !== 'function') return res.status(500).json({ ok:false, error:'sendTelegram not available' });
    await sendTelegram(message);
    return res.json({ ok:true, message:'send attempted' });
  } catch (e) { return res.status(500).json({ ok:false, error: e && e.message }); }
});

// /debug/last-scan -> show last run results if scanner writes them
app.get('/debug/last-scan', (req, res) => {
  const interval = req.query.interval || '1h';
  const data = lastScanResults[interval] || [];
  res.json({ interval, count: data.length, results: data });
});

// health endpoint
app.get('/health', (req, res) => {
  try {
    ensureRuntime();
    const wsState = (wsClient && wsClient.ws && typeof wsClient.ws.readyState !== 'undefined') ? wsClient.ws.readyState : null;
    let cached = [];
    try { if (wsClient && wsClient.prices && typeof wsClient.prices.entries === 'function') cached = Array.from(wsClient.prices.entries()).slice(0,10); } catch (e) { cached = []; }
    res.json({ ok:true, testnet: cfg.TESTNET, market: (cfg && cfg.BYBIT_MARKET) || process.env.BYBIT_MARKET, bybit_ws: (cfg && cfg.BYBIT_WS) || process.env.BYBIT_WS, bybit_api: (cfg && cfg.BYBIT_BASE_API) || process.env.BYBIT_BASE_API, wsReadyState: wsState, cachedPricesSample: cached, uptime: process.uptime() });
  } catch (e) { res.status(500).json({ ok:false, error: e && e.message }); }
});

// Start server
const PORT = (cfg && cfg.PORT) || process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));

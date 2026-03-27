// src/index.js  (replace the file Render actually launches)
//
// Minimal lazy-init server + debug endpoints + run-scan endpoints for manual triggering.
// Make sure this is the exact file start-wrapper launched (see Render logs).

// Early diagnostics
console.log('=== STARTUP: index.js loaded ===');
console.log('process.env.NODE_OPTIONS=', process.env.NODE_OPTIONS);
console.log('process.execArgv=', process.execArgv);

// localRequire helper (tries a few paths)
function localRequire(name) {
  try { return require('./' + name); } catch (e) {
    try { return require('./src/' + name); } catch (e2) {
      try { return require(name); } catch (e3) { return null; }
    }
  }
}

const express = require('express');
const client = require('prom-client');
const app = express();
app.use(express.json());

// Print basic config presence
const cfg = localRequire('config') || { TESTNET: process.env.TESTNET || false };
console.log('Config: TESTNET=', cfg.TESTNET, 'BYBIT_BASE_API=', process.env.BYBIT_BASE_API || '(unset)');

// simple runtime holders
let scannerModule = null;
let bybitModule = null;
let telegramModule = null;
let wsClient = null;
let sendTelegram = async () => { console.log('sendTelegram not configured'); };
let lastScanResults = {};

// simple init (safe, avoids heavy probing)
function initRuntimeModules() {
  if (scannerModule || bybitModule) return;
  scannerModule = localRequire('scanner') || localRequire('src/scanner') || null;
  bybitModule = localRequire('bybit') || localRequire('src/bybit') || null;
  telegramModule = localRequire('telegram') || localRequire('src/telegram') || null;

  if (telegramModule && typeof telegramModule.sendTelegram === 'function') sendTelegram = telegramModule.sendTelegram;

  try {
    if (bybitModule && typeof bybitModule.BybitWS === 'function') {
      wsClient = new bybitModule.BybitWS();
      console.log('BybitWS instance created');
    } else {
      wsClient = { prices: new Map() };
    }
  } catch (e) {
    wsClient = { prices: new Map() };
    console.warn('BybitWS init error:', e && e.message);
  }

  console.log('Loaded module keys: scanner=', scannerModule && Object.keys(scannerModule || {}), 'bybit=', bybitModule && Object.keys(bybitModule || {}));
}

// simple MACD helpers used by debug endpoints
function computeEMA(series, period) {
  if (!Array.isArray(series) || !series.length) return [];
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
function computeMACD(closes, fast = 12, slow = 26, sig = 9) {
  const emaF = computeEMA(closes, fast);
  const emaS = computeEMA(closes, slow);
  const macd = closes.map((_, i) => (emaF[i] || 0) - (emaS[i] || 0));
  const signal = computeEMA(macd, sig);
  const hist = macd.map((v, i) => v - (signal[i] || 0));
  return { macd, signal, hist };
}

// Debug endpoints (explicit)
function ensureRuntime() { try { initRuntimeModules(); } catch(e){ console.warn('initRuntimeModules failed', e && e.message); } }

app.get('/debug/klines', async (req, res) => {
  try {
    ensureRuntime();
    const by = bybitModule || localRequire('bybit') || require('./bybit');
    if (!by || typeof by.fetchKlines !== 'function') return res.status(500).json({ ok:false, error:'bybit.fetchKlines not available' });
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const interval = req.query.interval || '60';
    const limit = Number(req.query.limit || 200);
    const klines = await by.fetchKlines(symbol, interval, limit);
    return res.json({ ok:true, symbol, interval, count: Array.isArray(klines) ? klines.length : 0, sample: Array.isArray(klines) ? klines.slice(-10) : klines });
  } catch (e) { return res.status(500).json({ ok:false, error: e && e.message }); }
});

app.get('/debug/macd', async (req, res) => {
  try {
    ensureRuntime();
    const by = bybitModule || localRequire('bybit') || require('./bybit');
    if (!by || typeof by.fetchKlines !== 'function') return res.status(500).json({ ok:false, error:'bybit.fetchKlines not available' });
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const interval = req.query.interval || '60';
    const limit = Number(req.query.limit || 200);
    const klines = await by.fetchKlines(symbol, interval, limit);
    if (!Array.isArray(klines) || klines.length === 0) return res.json({ ok:true, symbol, interval, count:0, hist:[] });
    const closes = klines.map(k => parseFloat(k.close) || 0);
    const macd = computeMACD(closes);
    return res.json({ ok:true, symbol, interval, count: closes.length, latestHist: macd.hist.slice(-1)[0] || 0, histSample: macd.hist.slice(-10) });
  } catch (e) { return res.status(500).json({ ok:false, error: e && e.message }); }
});

app.get('/debug/filter', async (req, res) => {
  try {
    ensureRuntime();
    const filters = localRequire('filters') || require('./filters');
    if (!filters) return res.status(500).json({ ok:false, error:'filters module not found' });
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const interval = req.query.interval || '1h';
    const by = bybitModule || localRequire('bybit') || require('./bybit');
    const klines = (by && typeof by.fetchKlines === 'function') ? await by.fetchKlines(symbol, interval === '1h' ? '60' : (interval === '4h' ? '240' : interval), 200) : [];
    if (!klines || klines.length === 0) return res.json({ ok:true, symbol, interval, klinesCount:0 });
    const closes = klines.map(k => parseFloat(k.close) || 0);
    const macd = computeMACD(closes);
    const latestHist = macd.hist.slice(-1)[0] || 0;
    const result = (typeof filters.passesFiltersDetailed === 'function') ? filters.passesFiltersDetailed(symbol, interval, klines, latestHist, macd.hist.slice(0,-1), null, null, null) : { ok:false, reason:'passesFiltersDetailed missing' };
    return res.json({ ok:true, symbol, interval, klinesCount: klines.length, latestHist, filter: result });
  } catch (e) { return res.status(500).json({ ok:false, error: e && e.message }); }
});

// --- New: run-scan-root endpoint (invoke scanner.scanRootTf) ---
app.post('/debug/run-scan-root', async (req, res) => {
  try {
    ensureRuntime();
    const rootTf = req.query.rootTf || req.body.rootTf || '1h';
    if (!scannerModule || typeof scannerModule.scanRootTf !== 'function') {
      console.warn('RUN SCAN: scannerModule.scanRootTf not available');
      return res.status(500).json({ ok:false, error:'scanner.scanRootTf not available' });
    }
    console.log(`RUN SCAN: start rootTf=${rootTf}`);
    const signals = await scannerModule.scanRootTf(rootTf);
    console.log(`RUN SCAN: finished rootTf=${rootTf} -> signals=${Array.isArray(signals) ? signals.length : 'nil'}`);
    lastScanResults[rootTf] = signals || [];
    return res.json({ ok:true, rootTf, signalsCount: Array.isArray(signals) ? signals.length : 0, sample: Array.isArray(signals) ? signals.slice(0,10) : signals });
  } catch (e) {
    console.error('RUN SCAN error', e && e.stack);
    return res.status(500).json({ ok:false, error: e && e.message });
  }
});

// --- New: scan a single symbol on-demand (fetch klines, compute MACD, run filters) ---
app.get('/debug/scan-symbol', async (req, res) => {
  try {
    ensureRuntime();
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const interval = req.query.interval || '60';
    const limit = Number(req.query.limit || 200);
    const by = bybitModule || localRequire('bybit') || require('./bybit');
    if (!by || typeof by.fetchKlines !== 'function') return res.status(500).json({ ok:false, error:'bybit.fetchKlines not available' });
    const klines = await by.fetchKlines(symbol, interval, limit);
    if (!Array.isArray(klines) || klines.length === 0) {
      console.warn('SCAN SYMBOL: no klines for', symbol, interval);
      return res.json({ ok:true, symbol, interval, count:0, hist:[] });
    }
    const closes = klines.map(k => parseFloat(k.close) || 0);
    const macd = computeMACD(closes);
    const latestHist = macd.hist.slice(-1)[0] || 0;
    const filters = localRequire('filters') || require('./filters');
    const filterRes = (filters && typeof filters.passesFiltersDetailed === 'function') ?
      filters.passesFiltersDetailed(symbol, interval, klines, latestHist, macd.hist.slice(0,-1), null, null, null) : { ok:false, reason:'passesFiltersDetailed missing' };

    console.log(`SCAN SYMBOL: ${symbol} ${interval} latestHist=${latestHist} filter.pass=${filterRes.pass}`);
    return res.json({ ok:true, symbol, interval, count: klines.length, latestHist, filter: filterRes, macdSample: macd.hist.slice(-20) });
  } catch (e) {
    console.error('SCAN SYMBOL error', e && e.stack);
    return res.status(500).json({ ok:false, error: e && e.message });
  }
});

app.get('/debug/send-test', async (req, res) => {
  try {
    ensureRuntime();
    if (typeof sendTelegram !== 'function') return res.status(500).json({ ok:false, error:'sendTelegram not available' });
    await sendTelegram(req.query.message || 'test message');
    return res.json({ ok:true, attempted:true });
  } catch (e) { return res.status(500).json({ ok:false, error: e && e.message }); }
});

app.get('/debug/last-scan', (req, res) => {
  const interval = req.query.interval || '1h';
  const results = lastScanResults[interval] || [];
  res.json({ interval, count: results.length, results });
});

app.get('/health', (req, res) => {
  try {
    ensureRuntime();
    res.json({ ok:true, testnet: cfg.TESTNET, bybit_ws: process.env.BYBIT_WS || '', bybit_api: process.env.BYBIT_BASE_API || '', uptime: process.uptime() });
  } catch (e) { res.status(500).json({ ok:false, error: e && e.message }); }
});

// Start listening (bottom of file)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));
console.log('=== READY ===');
// src/index.js  (replace the file Render actually launches)
// Adds GET/POST /debug/run-scan-root with fallback scanning when scanner.scanRootTf is not available.
// NOTE: This performs many REST calls if fallback is used — run manually and sparingly.

console.log('=== STARTUP: index.js loaded ===');
console.log('process.env.NODE_OPTIONS=', process.env.NODE_OPTIONS);
console.log('process.execArgv=', process.execArgv);

function localRequire(name) {
  try { return require('./' + name); } catch (e) {
    try { return require('./src/' + name); } catch (e2) {
      try { return require(name); } catch (e3) { return null; }
    }
  }
}

const express = require('express');
const app = express();
app.use(express.json());

const cfg = localRequire('config') || { TESTNET: process.env.TESTNET || false };
console.log('Config: TESTNET=', cfg.TESTNET, 'BYBIT_BASE_API=', process.env.BYBIT_BASE_API || '(unset)');

let scannerModule = null;
let bybitModule = null;
let filtersModule = null;
let telegramModule = null;
let lastScanResults = {};

function initRuntimeModules() {
  if (scannerModule || bybitModule) return;
  scannerModule = localRequire('scanner') || localRequire('src/scanner') || null;
  bybitModule = localRequire('bybit') || localRequire('src/bybit') || null;
  filtersModule = localRequire('filters') || localRequire('src/filters') || null;
  telegramModule = localRequire('telegram') || localRequire('src/telegram') || null;
  console.log('Loaded module keys: scanner=', scannerModule && Object.keys(scannerModule || {}), 'bybit=', bybitModule && Object.keys(bybitModule || {}), 'filters=', filtersModule && Object.keys(filtersModule || {}));
}

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

function ensureRuntime() { try { initRuntimeModules(); } catch (e) { console.warn('initRuntime failed', e && e.message); } }

// existing debug endpoints (klines, macd, filter, etc.)
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
    const filters = filtersModule || localRequire('filters') || require('./filters');
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

// --- run-scan-root: both GET and POST so browser can call it easily ---
// Behavior: if scanner.scanRootTf exists, call it; otherwise fallback to fetching symbols and scanning each.
async function fallbackRootScan(rootTf='1h', symbolLimit=500) {
  ensureRuntime();
  const by = bybitModule || localRequire('bybit') || require('./bybit');
  const filters = filtersModule || localRequire('filters') || require('./filters');
  const results = [];
  if (!by || typeof by.fetchUsdtPerpetualSymbols !== 'function') {
    console.warn('fallbackRootScan: by.fetchUsdtPerpetualSymbols not available');
    return results;
  }
  // fetch symbols (e.g., many)
  const syms = await by.fetchUsdtPerpetualSymbols();
  if (!Array.isArray(syms) || syms.length === 0) return results;
  // Normalize to symbol strings; syms may be objects or strings
  const symbols = syms.map(s => (typeof s === 'string' ? s : (s.symbol || s.name || s.code || '') )).filter(Boolean).slice(0, symbolLimit);
  console.log('fallbackRootScan: will scan symbol count=', symbols.length);
  for (const symbol of symbols) {
    try {
      // polite delay to avoid hammering (100ms)
      await new Promise(r => setTimeout(r, 100));
      const klines = await by.fetchKlines(symbol, rootTf === '1h' ? '60' : (rootTf === '4h' ? '240' : rootTf), 200);
      if (!Array.isArray(klines) || klines.length < 30) continue;
      const closes = klines.map(k => parseFloat(k.close) || 0);
      const macd = computeMACD(closes);
      const latestHist = macd.hist.slice(-1)[0] || 0;
      const filterRes = (filters && typeof filters.passesFiltersDetailed === 'function') ? filters.passesFiltersDetailed(symbol, rootTf, klines, latestHist, macd.hist.slice(0,-1), null, null, null) : { pass:false, reasons:['no-filters'] };
      if (filterRes && filterRes.pass) {
        results.push({ symbol, rootTf, latestHist, filter: filterRes });
        console.log(`fallbackRootScan: SIGNAL ${symbol} ${rootTf} hist=${latestHist} pass=true`);
      }
    } catch (e) {
      console.warn('fallbackRootScan: symbol error', symbol, e && e.message);
    }
  }
  return results;
}

async function runScanRootHandler(req, res) {
  try {
    ensureRuntime();
    const rootTf = (req.query.rootTf || req.body && req.body.rootTf) || '1h';
    console.log(`RUN SCAN: start rootTf=${rootTf}`);
    if (scannerModule && typeof scannerModule.scanRootTf === 'function') {
      const signals = await scannerModule.scanRootTf(rootTf);
      lastScanResults[rootTf] = signals || [];
      console.log(`RUN SCAN: finished (scanner.scanRootTf) rootTf=${rootTf} -> ${Array.isArray(signals)?signals.length:0} signals`);
      return res.json({ ok:true, interval: rootTf, count: Array.isArray(signals)?signals.length:0, results: Array.isArray(signals)?signals.slice(0,100):signals });
    }
    // fallback
    const fallbackSignals = await fallbackRootScan(rootTf, 500);
    lastScanResults[rootTf] = fallbackSignals || [];
    console.log(`RUN SCAN: finished (fallback) rootTf=${rootTf} -> ${fallbackSignals.length} signals`);
    return res.json({ ok:true, interval: rootTf, count: fallbackSignals.length, results: fallbackSignals });
  } catch (e) {
    console.error('RUN SCAN error', e && e.stack);
    return res.status(500).json({ ok:false, error: e && e.message });
  }
}

app.post('/debug/run-scan-root', runScanRootHandler);
// Also provide GET for browser ease
app.get('/debug/run-scan-root', runScanRootHandler);

app.get('/debug/last-scan', (req, res) => {
  const interval = req.query.interval || '1h';
  const results = lastScanResults[interval] || [];
  res.json({ interval, count: results.length, results });
});

app.get('/debug/scan-symbol', async (req, res) => {
  try {
    ensureRuntime();
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const interval = req.query.interval || '60';
    const limit = Number(req.query.limit || 200);
    const by = bybitModule || localRequire('bybit') || require('./bybit');
    if (!by || typeof by.fetchKlines !== 'function') return res.status(500).json({ ok:false, error:'bybit.fetchKlines not available' });
    const klines = await by.fetchKlines(symbol, interval, limit);
    if (!Array.isArray(klines) || klines.length === 0) return res.json({ ok:true, symbol, interval, count:0, hist:[] });
    const closes = klines.map(k => parseFloat(k.close) || 0);
    const macd = computeMACD(closes);
    const latestHist = macd.hist.slice(-1)[0] || 0;
    const filters = filtersModule || localRequire('filters') || require('./filters');
    const filterRes = (filters && typeof filters.passesFiltersDetailed === 'function') ?
      filters.passesFiltersDetailed(symbol, interval, klines, latestHist, macd.hist.slice(0,-1), null, null, null) : { ok:false, reason:'passesFiltersDetailed missing' };
    console.log(`SCAN SYMBOL: ${symbol} ${interval} latestHist=${latestHist} filter.pass=${filterRes.pass}`);
    return res.json({ ok:true, symbol, interval, count: klines.length, latestHist, filter: filterRes, macdSample: macd.hist.slice(-20) });
  } catch (e) {
    console.error('SCAN SYMBOL error', e && e.stack);
    return res.status(500).json({ ok:false, error: e && e.message });
  }
});

app.get('/health', (req, res) => {
  try { ensureRuntime(); res.json({ ok:true, testnet: cfg.TESTNET, bybit_ws: process.env.BYBIT_WS || '', bybit_api: process.env.BYBIT_BASE_API || '', uptime: process.uptime() }); }
  catch (e) { res.status(500).json({ ok:false, error: e && e.message }); }
});

// New: masked config endpoint for diagnostics (does not reveal secrets)
app.get('/debug/config', (req, res) => {
  try {
    ensureRuntime();
    const conf = localRequire('config') || require('./config');
    const masked = Object.assign({}, conf);

    // mask token/url strings if present
    if (masked.TELEGRAM_BOT_TOKEN) masked.TELEGRAM_BOT_TOKEN = '****';
    if (masked.REDIS_URL) masked.REDIS_URL = '****';
    // expose presence flags for sensitive envs (true/false)
    const sensitiveKeys = ['BYBIT_API_KEY','BYBIT_API_SECRET','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','REDIS_URL'];
    const envPresence = {};
    sensitiveKeys.forEach(k => envPresence[k] = !!process.env[k]);
    masked._envPresence = envPresence;

    res.json({ ok:true, config: masked });
  } catch (e) {
    res.status(500).json({ ok:false, error: e && e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));
console.log('=== READY ===');
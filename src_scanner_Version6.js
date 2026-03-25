// src/scanner.js
// Scanner with kline fallback + aggregation and mandatory Telegram push option.
// - Aggregates smaller-interval klines into target interval when insufficient candles.
// - Exports: scanRootTf, publishSignalsAlways

const cfg = require('./config');
const bybit = require('./bybit');
const axios = require('axios');
const { passesFiltersDetailed } = require('./filters');
const { sendTelegram } = require('./telegram');

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

function intervalKeyToApi(intervalKey) {
  const ik = String(intervalKey).toLowerCase();
  if (ik === '1h' || ik === '60' || ik === '60m') return '60';
  if (ik === '4h' || ik === '240') return '240';
  if (ik === '1d' || ik === 'd' || ik === '1440') return 'D';
  if (ik === '15m' || ik === '15') return '15';
  if (ik === '5m' || ik === '5') return '5';
  if (ik === '1m' || ik === '1') return '1';
  return intervalKey;
}

// grouping helper: aggregate raw klines (smaller interval) into target interval
function aggregateKlines(raw, groupSize) {
  // raw is array oldest->newest; groupSize integer >=1
  if (!Array.isArray(raw) || raw.length < groupSize) return [];
  const out = [];
  const groups = Math.floor(raw.length / groupSize);
  for (let g = 0; g < groups; g++) {
    const slice = raw.slice(g * groupSize, g * groupSize + groupSize);
    const first = slice[0];
    const last = slice[slice.length - 1];
    const high = Math.max(...slice.map(x => Number(x.high || x[2] || 0)));
    const low = Math.min(...slice.map(x => Number(x.low || x[3] || 0)));
    const open = Number(first.open || first[1] || 0);
    const close = Number(last.close || last[4] || 0);
    const vol = slice.reduce((s, x) => s + Number(x.volume || x[5] || x[6] || 0), 0);
    const t = Number(first.t || first[0] || first.openTime || 0);
    out.push({ t, open: String(open), high: String(high), low: String(low), close: String(close), volume: vol });
  }
  return out;
}

// symbol selection: strict USDT pairs and respect BYBIT_MARKET
async function fetchSymbolsFallback() {
  try {
    // helper in bybit module if present
    if (bybit && typeof bybit.fetchUsdtPerpetualSymbols === 'function' && (cfg.BYBIT_MARKET === 'linear')) {
      const s = await bybit.fetchUsdtPerpetualSymbols();
      if (Array.isArray(s) && s.length) return s;
    }
  } catch (e) {}

  try {
    const base = (cfg.BYBIT_BASE_API || 'https://api-testnet.bybit.com').replace(/\/$/, '');
    const category = (cfg.BYBIT_MARKET === 'spot') ? 'spot' : 'linear';
    const url = `${base}/v5/market/instruments-info?category=${encodeURIComponent(category)}`;
    const res = await axios.get(url, { timeout: 10000 });
    const data = res && res.data;
    if (!data) return [];
    const list = (data.result && data.result.list) ? data.result.list : (data.result || []);
    const symbols = [];
    for (const it of list) {
      const sym = it.symbol || it.name;
      if (!sym) continue;
      const quote = (it.quoteCoin || it.quote_coin || it.quote || it.quoteAsset || it.quote_asset || '').toString().toUpperCase();
      // exclude expiry/dated futures
      const hasExpiry = !!(it.expiry || it.expireTime || it.expire_time || sym.includes('-'));
      if (hasExpiry) continue;
      if (quote !== 'USDT') continue;
      // if spot requested, keep spot-like; if linear requested, keep perpetual-like
      if (cfg.BYBIT_MARKET === 'spot') {
        symbols.push(sym);
      } else {
        // linear/perpetual: accept if symbol ends with USDT and not dated
        if (sym.toUpperCase().endsWith('USDT')) symbols.push(sym);
      }
    }
    return [...new Set(symbols)];
  } catch (e) {
    // fallback v2
    try {
      const base = (cfg.BYBIT_BASE_API || 'https://api-testnet.bybit.com').replace(/\/$/, '');
      const url = `${base}/v2/public/symbols`;
      const res = await axios.get(url, { timeout: 8000 });
      const data = res && res.data;
      const list = data && data.result ? data.result : data;
      const syms = [];
      for (const it of (list || [])) {
        const sym = it.name || it.symbol;
        const quote = (it.quote_currency || it.quoteCurrency || '').toString().toUpperCase();
        if (!sym || quote !== 'USDT') continue;
        if (sym.includes('-') || /[A-Z]+[0-9]{2,}/i.test(sym)) continue;
        syms.push(sym);
      }
      return [...new Set(syms)];
    } catch (e2) {
      console.warn('fetchSymbolsFallback failed', e && (e.message || e));
      return [];
    }
  }
}

// map with concurrency helper
async function mapWithConcurrency(arr, concurrency, fn) {
  const results = [];
  const executing = new Set();
  let i = 0;
  async function enqueue() {
    if (i >= arr.length) return;
    const idx = i++;
    const p = Promise.resolve().then(() => fn(arr[idx], idx));
    results[idx] = p;
    executing.add(p);
    const done = () => executing.delete(p);
    p.then(done, done);
    if (executing.size >= concurrency) await Promise.race(executing);
    return enqueue();
  }
  await enqueue();
  return Promise.all(results);
}

// cadence: minimum candles required at target interval
const MIN_CANDLES = 30;

function fallbackIntervalsFor(targetIntervalApi) {
  // returns list of smaller intervals to try (string API intervals)
  if (targetIntervalApi === '60') return ['15', '5', '1'];
  if (targetIntervalApi === '240') return ['60', '15'];
  if (targetIntervalApi === 'D') return ['240', '60'];
  return ['15', '5', '1'];
}

async function fetchAndEnsureKlines(symbol, targetIntervalApi, minCandles = MIN_CANDLES) {
  // try direct first
  let klines = await bybit.fetchKlines(symbol, targetIntervalApi, Math.max(200, minCandles)).catch(e => null);
  if (Array.isArray(klines) && klines.length >= minCandles) return klines;
  // try fallback smaller intervals and aggregate
  const fallbacks = fallbackIntervalsFor(String(targetIntervalApi));
  for (const rawI of fallbacks) {
    // grouping factor: how many raw candles per target
    let groupSize = 1;
    if (targetIntervalApi === '60' && rawI === '15') groupSize = 4;
    if (targetIntervalApi === '60' && rawI === '5') groupSize = 12;
    if (targetIntervalApi === '60' && rawI === '1') groupSize = 60;
    if (targetIntervalApi === '240' && rawI === '60') groupSize = 4;
    if (targetIntervalApi === '240' && rawI === '15') groupSize = 16;
    if (targetIntervalApi === 'D' && rawI === '240') groupSize = 6;
    // request enough raw candles
    const neededRaw = groupSize * minCandles;
    const limit = Math.min(200, Math.max(100, neededRaw));
    const raw = await bybit.fetchKlines(symbol, rawI, limit).catch(e => null);
    if (!Array.isArray(raw) || raw.length < neededRaw) continue;
    // aggregate oldest->newest; keep last minCandles groups
    const agg = aggregateKlines(raw.slice(-neededRaw), groupSize);
    if (agg && agg.length >= minCandles) return agg.slice(-minCandles);
  }
  // last resort: return whatever direct fetch gave (maybe partial) or null
  return Array.isArray(klines) && klines.length ? klines : null;
}

async function scanRootTf(rootTf) {
  const intervalApi = intervalKeyToApi(rootTf);
  const higherTf = (rootTf === '1h') ? '240' : (rootTf === '4h' ? 'D' : null);

  let symbols = [];
  try {
    symbols = await fetchSymbolsFallback();
  } catch (e) {
    console.error('scanRootTf: fetchSymbols failed', e && e.message);
    symbols = [];
  }

  if (!Array.isArray(symbols) || symbols.length === 0) {
    console.warn('scanRootTf: no symbols fetched');
    return [];
  }

  try { console.log(`scanRootTf: fetched ${symbols.length} symbols. First 10: ${symbols.slice(0, 10).join(', ')}`); } catch (e) {}

  if (cfg.MAX_SCAN_SYMBOLS && Number.isInteger(cfg.MAX_SCAN_SYMBOLS) && cfg.MAX_SCAN_SYMBOLS > 0) {
    symbols = symbols.slice(0, cfg.MAX_SCAN_SYMBOLS);
  }

  const concurrency = Math.max(1, parseInt(process.env.REST_CONCURRENCY || '8', 10));
  const signals = [];

  await mapWithConcurrency(symbols, concurrency, async (symbol) => {
    try {
      const klines = await fetchAndEnsureKlines(symbol, intervalApi, MIN_CANDLES);
      if (!klines || klines.length < MIN_CANDLES) {
        // produce insufficient klines signal for transparency
        signals.push({
          symbol,
          interval: rootTf,
          macdValue: null,
          klines,
          histHistory: [],
          higherTfHist: null,
          dailyHist: null,
          prevDailyHist: null,
          filter: { pass: false, reasons: ['insufficient_klines'], details: { sufficientKlines: false } }
        });
        return;
      }
      const closes = klines.map(k => parseFloat(k.close));
      const { hist } = computeMACD(closes, 12, 26, 9);
      if (!hist || hist.length === 0) return;
      const latestHist = hist[hist.length - 1];
      const histHistory = hist.slice(0, Math.max(0, hist.length - 1));

      let dailyHist = null, prevDailyHist = null;
      if ((rootTf === '1h' || rootTf === '4h') && (process.env.FILTER_MTF || 'true') === 'true') {
        try {
          const klDaily = await bybit.fetchKlines(symbol, 'D', 5).catch(e => null);
          if (klDaily && klDaily.length >= 2) {
            const closesD = klDaily.map(k => parseFloat(k.close));
            const macdD = computeMACD(closesD, 12, 26, 9);
            const histD = macdD.hist || [];
            if (histD.length >= 2) {
              dailyHist = histD[histD.length - 1];
              prevDailyHist = histD[histD.length - 2];
            }
          }
        } catch (e) {}
      }

      let higherTfHist = null;
      if ((process.env.FILTER_MTF || 'true') === 'true' && higherTf) {
        try {
          const klHigh = await fetchAndEnsureKlines(symbol, higherTf, MIN_CANDLES);
          if (klHigh && klHigh.length >= MIN_CANDLES) {
            const closesHigh = klHigh.map(k => parseFloat(k.close));
            const macHigh = computeMACD(closesHigh, 12, 26, 9);
            const histHigh = macHigh.hist || [];
            higherTfHist = histHigh.length ? histHigh[histHigh.length - 1] : null;
          }
        } catch (e) {}
      }

      const detailed = passesFiltersDetailed(symbol, rootTf, klines, latestHist, histHistory, higherTfHist, dailyHist, prevDailyHist);

      signals.push({
        symbol,
        interval: rootTf,
        macdValue: latestHist,
        klines,
        histHistory,
        higherTfHist,
        dailyHist,
        prevDailyHist,
        filter: detailed
      });
    } catch (err) {
      if (process.env.DEBUG_FILTERS === 'true') console.error('scanRootTf symbol error', err && err.message, 'symbol:', symbol);
    }
  });

  signals.sort((a, b) => Math.abs((b.macdValue || 0)) - Math.abs((a.macdValue || 0)));
  return signals;
}

async function publishSignalsAlways(signals) {
  const telegramAlways = (process.env.TELEGRAM_ALWAYS_PUSH_SIGNALS || 'false') === 'true';
  const limit = Number(process.env.NOTIFY_ROOT_SIGNALS_LIMIT || 200);
  if (!telegramAlways && (process.env.NOTIFY_ON_ROOT_SIGNALS || 'false') !== 'true') {
    let c = 0;
    for (const s of signals) {
      if (c >= limit) break;
      console.log(`bybit: ${s.symbol} ${s.interval} pass=${s.filter && s.filter.pass} reasons=${(s.filter && s.filter.reasons || []).slice(0,4).join('|')}`);
      c++;
    }
    return;
  }
  let c = 0;
  for (const s of signals) {
    if (c >= limit) break;
    const pass = s.filter && s.filter.pass;
    const details = (s.filter && s.filter.details) || {};
    const reasons = (s.filter && s.filter.reasons) || [];
    const msg = `bybit: ${s.symbol} ${s.interval} PASS=${pass} VOL=${!!details.volumePass} HIST=${!!details.histPass} MTF=${!!details.mtfPass} reasons=${reasons.slice(0,4).join('|')} macd=${(s.macdValue!==null && s.macdValue!==undefined)?Number(s.macdValue).toFixed(6):'n/a'}`;
    console.log(msg);
    try { await sendTelegram(msg); } catch (e) { console.warn('publishSignalsAlways: sendTelegram failed', e && e.message); }
    c++;
  }
}

module.exports = {
  scanRootTf,
  publishSignalsAlways
};
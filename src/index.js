// src/index.js — updated: immediate startup scans, per-root aggregated pushes, and signal dedupe

console.log('=== STARTUP: index.js loaded ===');

const express = require('express');
const app = express();
app.use(express.json());

const { createLimiter, sleep, retryWithBackoff } = require('./utils'); // src/utils.js (must exist)
const { computeMACD } = require('./macd'); // centralized, SMA-seeded MACD impl

function localRequire(name) {
  try { return require('./' + name); } catch (e) { try { return require(name); } catch (e2) { return null; } }
}

let bybitModule = localRequire('bybit') || null;
let tradeModule = localRequire('trade') || null;
let telegramModule = localRequire('telegram') || null;

let wsClient = null; // BybitWS instance (real if available, otherwise null)

function initRuntimeModules() {
  bybitModule = bybitModule || localRequire('bybit') || localRequire('src/bybit') || null;
  tradeModule = tradeModule || localRequire('trade') || localRequire('src/trade') || null;
  telegramModule = telegramModule || localRequire('telegram') || localRequire('src/telegram') || null;

  // initialize websocket client if available via bybit wrapper
  try {
    const BybitWS = bybitModule && bybitModule.BybitWS;
    if (!wsClient && typeof BybitWS === 'function') {
      try {
        wsClient = new BybitWS();
        // treat stub instances (that don't implement subscribeKline) as unavailable
        if (!wsClient || typeof wsClient.subscribeKline !== 'function') {
          console.warn('BybitWS provided but subscribeKline not implemented — disabling wsClient');
          wsClient = null;
        } else {
          console.log('BybitWS client initialized — websocket mode enabled for confirmations');
        }
      } catch (we) {
        console.warn('BybitWS constructor failed, falling back to REST-only', we && we.message);
        wsClient = null;
      }
    }
  } catch (e) {
    console.warn('initRuntimeModules: ws init error', e && e.message);
    wsClient = null;
  }
}
function ensureRuntime() { try { initRuntimeModules(); } catch (e) { console.warn('initRuntime error', e && e.message); } }

// ---------------- stats & buffers ----------------
const scanStats = { lastRun: {}, lastCount: {}, lastSignals: {} };
let lastScanResults = {}; // keyed by rootTf
const notifications = []; // in-memory circular buffer
const MAX_NOTIFICATIONS = 200;

// ---------------- dedupe store ----------------
// key: `${rootTf}:${symbol}` => timestamp ms of last notification
const seenSignals = new Map();
// seconds to keep dedupe (env). Default 3600 (1 hour). Set to 0 to disable dedupe.
const SIGNAL_DEDUP_SECONDS = Math.max(0, Number(process.env.SIGNAL_DEDUP_SECONDS || 3600));

// ---------------- env & defaults ----------------
const DEFAULT_MTF_CHECK_MAP = {
  "1h": ["5m","15m","4h","1d"],
  "4h": ["5m","15m","1h","1d"],
  "1d": ["5m","15m","1h","4h"]
};
function loadMtfCheckMap() {
  const raw = process.env.MTF_CHECK_MAP;
  if (!raw) return DEFAULT_MTF_CHECK_MAP;
  try {
    const parsed = JSON.parse(raw);
    const out = {};
    for (const k of Object.keys(parsed)) {
      out[String(k).toLowerCase()] = (parsed[k] || []).map(x => String(x).toLowerCase());
    }
    return Object.assign({}, DEFAULT_MTF_CHECK_MAP, out);
  } catch (e) {
    console.warn('MTF_CHECK_MAP parse failed, using default', e && e.message);
    return DEFAULT_MTF_CHECK_MAP;
  }
}
const MTF_CHECK_MAP = loadMtfCheckMap();

const AUTO_SCAN_ROOT_TFS = (process.env.AUTO_SCAN_ROOT_TFS || '1h,4h,1d').split(',').map(s => s.trim()).filter(Boolean);

// Tuneable controlling how often we poll watchlist entries (faster to avoid misses)
const POLL_INTERVAL_MS = Math.max(1000, Number(process.env.POLL_INTERVAL_MS || 2000));

// Increase watchlist default so we don't drop many candidates during polling
const MAX_WATCHLIST = Math.max(1, Number(process.env.MAX_WATCHLIST || 200));

const SCAN_INTERVAL_SECONDS = Number(process.env.SCAN_INTERVAL_SECONDS || 300);
const REST_CONCURRENCY = Math.max(1, Number(process.env.REST_CONCURRENCY || 4));
const REST_THROTTLE_MS = Number(process.env.REST_THROTTLE_MS || process.env.REST_THROTTLE || 25);
const MAX_SCAN_SYMBOLS = Number(process.env.MAX_SCAN_SYMBOLS || 500);
const FILTER_SIGNALS = (process.env.FILTER_SIGNALS || 'true').toLowerCase() === 'true';

// MACD_EPSILON: if >0, use strict epsilon; if 0, use dynamic epsilon logic
const MACD_EPSILON = Number(process.env.MACD_EPSILON || 0);

// dynamic epsilon multiplier (configurable)
const MACD_DYNAMIC_EPS_MULT = Number(process.env.MACD_DYNAMIC_EPS_MULT || 0.05);

// -- New envs added --
const MACD_THRESHOLD = Number(process.env.MACD_THRESHOLD || 0); // only take signals with latestHist > this
const NEG_ALLOWED_IN_MTF = Math.max(0, Number(process.env.NEG_ALLOWED_IN_MTF || 2)); // allow up to N negative MTFs that must flip-on-current-candle
const TRADE_ON_CONFIRM_NOW = (process.env.TRADE_ON_CONFIRM_NOW || 'false').toLowerCase() === 'true'; // if false, do not open trades immediately; send dry-run

const MAX_OPEN_TRADES = Math.max(1, Number(process.env.MAX_OPEN_TRADES || 3));
const OPEN_TRADES = (process.env.OPEN_TRADES || 'false').toLowerCase() === 'true';

// Watchlist & polling envs
const ENABLE_ROOT_POLLING = (process.env.ENABLE_ROOT_POLLING || 'true').toLowerCase() === 'true';

// Confirmation concurrency
const CONFIRM_CONCURRENCY = Math.max(1, Number(process.env.CONFIRM_CONCURRENCY || 4));

// HIST_LOOKBACK: how many recent hist points to scan for negative->positive crossing (0 = disabled)
const HIST_LOOKBACK = Math.max(0, Number(process.env.HIST_LOOKBACK || 6));

// On startup optionally push all signals (perform a scan for each rootTf and send mtf notices)
const PUSH_ALL_SIGNALS_ON_STARTUP = (process.env.PUSH_ALL_SIGNALS_ON_STARTUP || 'false').toLowerCase() === 'true';

// Breakeven envs (unchanged)
const ENABLE_BREAKEVEN_SIGNAL = (process.env.ENABLE_BREAKEVEN_SIGNAL || 'false').toLowerCase() === 'true';
const BREAKEVEN_TF = process.env.BREAKEVEN_TF || '15m';
const BREAKEVEN_MODE = (process.env.BREAKEVEN_MODE || 'higher_low');
const BREAKEVEN_BUFFER_PCT = Number(process.env.BREAKEVEN_BUFFER_PCT || 0.1);
const BREAKEVEN_CONFIRM_COUNT = Math.max(1, Number(process.env.BREAKEVEN_CONFIRM_COUNT || 1));
const BREAKEVEN_CHECK_AT_CLOSE_ONLY = (process.env.BREAKEVEN_CHECK_AT_CLOSE_ONLY || 'true').toLowerCase() === 'true';
const BREAKEVEN_PERSIST = (process.env.BREAKEVEN_PERSIST || 'false').toLowerCase() === 'false';

console.log('CONFIG', { AUTO_SCAN_ROOT_TFS, REST_CONCURRENCY, REST_THROTTLE_MS, MAX_SCAN_SYMBOLS, ENABLE_ROOT_POLLING, POLL_INTERVAL_MS, MAX_WATCHLIST, MACD_EPSILON, MACD_DYNAMIC_EPS_MULT, CONFIRM_CONCURRENCY, HIST_LOOKBACK, PUSH_ALL_SIGNALS_ON_STARTUP, MACD_THRESHOLD, NEG_ALLOWED_IN_MTF, TRADE_ON_CONFIRM_NOW, SIGNAL_DEDUP_SECONDS });

// ---------------- helpers: kline normalization ----------------
function klineTime(k) {
  return Number(k && (k[0] || k.openTime || k.time || k.timestamp || 0)) || 0;
}
function klineClose(k) {
  return Number(k && (k.close || k[4])) || 0;
}
function sortKlinesOldestFirst(klines) {
  if (!Array.isArray(klines)) return [];
  return klines.slice().sort((a,b) => klineTime(a) - klineTime(b));
}

// timeframe -> exchange interval key helper (replaces nested ternaries)
function tfToIntervalKey(tf) {
  const k = String(tf || '').toLowerCase();
  if (k === '1h' || k === '60') return '60';
  if (k === '4h' || k === '240') return '240';
  if (k === '1d' || k === 'd' || k === '24h') return 'D';
  if (k === '15m' || k === '15') return '15';
  if (k === '5m' || k === '5') return '5';
  return tf;
}

// --- dynamic epsilon helper -------------------------------------------------
function dynamicEpsilonFromHist(histArray, envEps = MACD_EPSILON) {
  if (typeof envEps === 'number' && envEps > 0) return envEps;
  if (!Array.isArray(histArray) || histArray.length < 6) return 1e-8;
  const mags = histArray.map(v => Math.abs(Number(v) || 0)).filter(v => v > 0);
  if (!mags.length) return 1e-8;
  mags.sort((a,b)=>a-b);
  const med = mags[Math.floor(mags.length / 2)];
  const mult = (Number.isFinite(MACD_DYNAMIC_EPS_MULT) && MACD_DYNAMIC_EPS_MULT > 0) ? MACD_DYNAMIC_EPS_MULT : 0.05;
  return Math.max(1e-8, med * mult);
}

/**
 * isMtfPass(mtf, prev, cur)
 * - tiny helper to standardize multi-timeframe acceptance
 * - rules: if mtf === '1d' allow if cur>0 OR cur > prev, else require cur > 0
 */
function isMtfPass(mtf, prev, cur) {
  try {
    const m = String(mtf).toLowerCase();
    const p = Number(prev || 0);
    const c = Number(cur || 0);
    if (m === '1d' || m === 'd') {
      if (c > 0) return true;
      if (!isNaN(p) && c > p) return true;
      return false;
    }
    // default: require positive current hist
    return c > 0;
  } catch (e) {
    return false;
  }
}

/**
 * isNegToPosFlexible(prev, cur, histSample, opts)
 * - histSample: array of recent histogram numeric values (for dynamic eps derivation)
 * - opts: { envEpsOverride: number|null } optional
 *
 * Behavior:
 * - honors MACD_EPSILON if set (>0)
 * - else uses dynamic eps and checks prev/cur and recent series crossings controlled by HIST_LOOKBACK
 */
function isNegToPosFlexible(prev, cur, histSample, opts = {}) {
  const p = Number(prev || 0);
  const c = Number(cur || 0);
  const envEps = (typeof opts.envEpsOverride === 'number' && !isNaN(opts.envEpsOverride))
    ? opts.envEpsOverride
    : MACD_EPSILON;
  if (typeof envEps === 'number' && envEps > 0) {
    const ok = (p < -envEps) && (c > envEps);
    if (process.env.DEBUG_DETECTION === 'true') {
      console.debug('isNegToPosFlexible (strict)', { prev: p, cur: c, envEps, ok });
    }
    return ok;
  }

  const rawHist = Array.isArray(histSample) ? histSample.map(h => (typeof h === 'object' ? Number(h.hist || 0) : Number(h || 0))) : [];
  const eps = dynamicEpsilonFromHist(rawHist);
  const minDelta = Math.max(1e-8, eps * 0.5);
  const cond1 = (p < -eps) && (c > eps);
  const cond2 = (p < 0) && (c > 0) && ((c - p) >= minDelta);
  if (process.env.DEBUG_DETECTION === 'true') {
    console.debug('isNegToPosFlexible', { prev: p, cur: c, eps, minDelta, cond1, cond2 });
  }
  if (cond1 || cond2) return true;

  // series-scan controlled by HIST_LOOKBACK; if 0, disabled.
  if (HIST_LOOKBACK && HIST_LOOKBACK > 0 && rawHist.length >= 2) {
    const tail = rawHist.slice(- (HIST_LOOKBACK + 1));
    for (let i = 0; i < tail.length - 1; i++) {
      const a = tail[i], b = tail[i+1];
      if (Number(a) < 0 && Number(b) > 0 && (b - a) >= minDelta) {
        if (process.env.DEBUG_DETECTION === 'true') {
          console.debug('isNegToPosFlexible: detected crossing in recent series', { idx: i, a, b, minDelta, lookback: HIST_LOOKBACK });
        }
        return true;
      }
    }
  }
  return false;
}

// helper: scan recent histSample for a negative->positive crossing (HIST_LOOKBACK controlled)
function histHasNegToPosCrossing(histSample, lookback = HIST_LOOKBACK, minDelta = 1e-8) {
  if (!Array.isArray(histSample) || histSample.length < 2) return false;
  if (!lookback || lookback <= 0) return false;
  const raw = histSample.map(h => (typeof h === 'object' ? Number(h.hist || 0) : Number(h || 0)));
  const tail = raw.slice(- (lookback + 1));
  for (let i = 0; i < tail.length - 1; i++) {
    const a = tail[i], b = tail[i+1];
    if (a < 0 && b > 0 && ((b - a) >= minDelta)) {
      if (process.env.DEBUG_DETECTION === 'true') {
        console.debug('histHasNegToPosCrossing: detected crossing', { idx: i, a, b, minDelta, lookback });
      }
      return true;
    }
  }
  return false;
}

// New helper: check last N histogram values are consecutively higher highs and positive
function isConsecutiveHigher(histSample, lookback = 3) {
  if (!Array.isArray(histSample) || histSample.length < lookback) return false;
  // extract last `lookback` numeric hist values
  const raw = histSample.slice(-lookback).map(h => (typeof h === 'object' ? Number(h.hist || 0) : Number(h || 0)));
  for (let i = 0; i < raw.length; i++) {
    if (!(Number.isFinite(raw[i]) && raw[i] > 0)) return false;
    if (i > 0 && raw[i] <= raw[i-1]) return false;
  }
  return true;
}

// ---------------- messaging helper (telegram or fallback) ----------------
async function sendNotice(type, title, lines) {
  const header = `[${type.toUpperCase()}] ${title}`;
  const body = [header, ...lines].join('\n');

  // append to buffer first
  try {
    const entry = { ts: Date.now(), type, title, lines, text: body };
    notifications.push(entry);
    if (notifications.length > MAX_NOTIFICATIONS) notifications.shift();
  } catch (e) {}

  ensureRuntime();
  if (!telegramModule) {
    console.log('sendNotice: telegram module not loaded — notification stored in buffer only');
  }
  if (telegramModule) {
    const fn = telegramModule.sendMessage || telegramModule.sendTelegram || telegramModule.send;
    if (typeof fn === 'function') {
      try {
        await fn(body);
        return;
      } catch (e) {
        console.warn('telegram send failed', e && (e.status || e.respData || e.message || e));
      }
    } else {
      console.log('sendNotice: telegram send function missing');
    }
  }

  // fallback to console
  console.log(body);
}

// ---------------- small helper: 24h vol change (best-effort) ----------------
async function compute24hVolumeChangePercent(symbol) {
  ensureRuntime();
  const by = bybitModule;
  if (!by || typeof by.fetchKlines !== 'function') return 0;
  try {
    const kl = await by.fetchKlines(symbol, '60', 48);
    if (!Array.isArray(kl) || kl.length < 48) return 0;
    const vols = kl.map(k => Number(k.volume || k.v || 0));
    const last24 = vols.slice(-24).reduce((a,b)=>a+b,0);
    const prev24 = vols.slice(-48,-24).reduce((a,b)=>a+b,0);
    if (!prev24 || prev24 === 0) return last24 > 0 ? 100 : 0;
    return ((last24 - prev24) / prev24) * 100;
  } catch (e) {
    console.warn('compute24hVolumeChangePercent error', symbol, e && e.message);
    return 0;
  }
}

// ---------------- fetch prev/current hist (robust) ----------------
async function fetchHistPrevAndCur(symbol, tfIntervalKey, klinesLimit = 500) {
  ensureRuntime();
  const by = bybitModule;
  if (!by || typeof by.fetchKlines !== 'function') return null;

  const want = Math.max(200, Math.min(2000, Number(klinesLimit || 800)));
  if (REST_THROTTLE_MS > 0) await sleep(REST_THROTTLE_MS);

  let raw;
  try {
    const fetchFn = by.fetchKlines.bind(by);
    raw = (typeof retryWithBackoff === 'function') ? await retryWithBackoff(() => fetchFn(symbol, tfIntervalKey, want)) : await fetchFn(symbol, tfIntervalKey, want);
  } catch (e) {
    console.warn('fetchHistPrevAndCur: fetchKlines failed (symbol)', symbol, e && e.message);
    return null;
  }
  if (!Array.isArray(raw) || raw.length < 3) return null;

  const klines = sortKlinesOldestFirst(raw);
  const closes = klines.map(k => klineClose(k));
  const macdObj = computeMACD(closes);
  const hist = Array.isArray(macdObj.hist) ? macdObj.hist : [];
  const len = hist.length;
  if (len < 2) return null;

  const N = 120;
  const outSample = [];
  const startIdx = Math.max(0, len - N);
  for (let i = startIdx; i < len; i++) {
    const ts = klineTime(klines[i]) || 0;
    outSample.push({
      ts_ms: ts,
      ts_s: Math.floor(ts / 1000),
      hist: Number(hist[i] || 0)
    });
  }

  const prevClosedHist = Number(hist[len - 2] || 0);
  const currentHist = Number(hist[len - 1] || 0);
  const lastK = klines[len - 1];

  return { prevClosedHist, currentHist, lastK, rawKlines: klines, closes, macd: macdObj, histSample: outSample };
}

// ---------------- fallbackRootScan (unchanged) ----------------
async function fallbackRootScan(rootTf='1h', symbolLimit=MAX_SCAN_SYMBOLS) {
  ensureRuntime();
  const by = bybitModule;
  if (!by || typeof by.fetchUsdtPerpetualSymbols !== 'function') {
    console.warn('fallbackRootScan: by.fetchUsdtPerpetualSymbols missing');
    return [];
  }

  const syms = await by.fetchUsdtPerpetualSymbols();
  if (!Array.isArray(syms) || syms.length === 0) return [];

  const symbols = syms
    .map(s => (typeof s === 'string' ? s : (s.symbol || s.name || s.code || '')))
    .filter(Boolean)
    .slice(0, Number(symbolLimit || MAX_SCAN_SYMBOLS));

  console.log('fallbackRootScan: scanning symbol count=', symbols.length, 'rootTf=', rootTf);

  const limiter = createLimiter(REST_CONCURRENCY);
  const intervalKey = tfToIntervalKey(rootTf);

  const tasks = symbols.map(sym => limiter(async () => {
    try {
      const histObj = await fetchHistPrevAndCur(sym, intervalKey, 500);
      if (!histObj) return null;
      return {
        symbol: sym,
        rootTf,
        prevClosedHist: histObj.prevClosedHist,
        currentHist: histObj.currentHist,
        histSample: histObj.histSample,
        lastVolume: Number(histObj.lastK && (histObj.lastK.volume || histObj.lastK.v || 0) || 0),
        closes: histObj.closes
      };
    } catch (e) {
      console.warn('fallbackRootScan symbol error', sym, e && e.message);
      return null;
    }
  }));

  const resolved = await Promise.all(tasks);
  const results = resolved.filter(Boolean);

  const negatives = results.filter(r => typeof r.prevClosedHist === 'number' && r.prevClosedHist < 0);
  const immediateFlips = results.filter(r => {
    if (!r) return false;
    if (isNegToPosFlexible(r.prevClosedHist, r.currentHist, r.histSample)) return true;
    if (histHasNegToPosCrossing(r.histSample)) return true;
    return false;
  });
  console.log(`fallbackRootScan: scanned=${results.length} negatives=${negatives.length} immediateFlips=${immediateFlips.length}`);

  const sample = negatives
    .sort((a,b) => Math.abs(b.prevClosedHist) - Math.abs(a.prevClosedHist))
    .slice(0, 10)
    .map(s => ({ symbol: s.symbol, prev: s.prevClosedHist, cur: s.currentHist, vol: s.lastVolume }));
  if (sample.length) console.log('fallbackRootScan: negative sample=', sample);

  return results;
}

// ---------------- websocket helper for waiting a kline event ----------------
function waitForKlineEvent(symbol, interval, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    if (!wsClient || typeof wsClient.subscribeKline !== 'function') {
      return reject(new Error('ws-unavailable'));
    }
    let settled = false;
    let unsub = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { if (typeof unsub === 'function') unsub(); } catch (e) {}
      reject(new Error('kline-wait-timeout'));
    }, timeoutMs);

    try {
      // subscribeKline expected to call handler on kline updates; we accept first callback invocation
      unsub = wsClient.subscribeKline(symbol, interval, (kline) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (typeof unsub === 'function') unsub(); } catch (e) {}
        resolve(kline);
      });
      // subscribeKline may return an unsubscribe function or nothing
      if (typeof unsub !== 'function') {
        // safety: if subscribe returns a subscription object, attempt to extract unsubscribe
        if (unsub && typeof unsub.unsubscribe === 'function') {
          const fn = () => unsub.unsubscribe();
          unsub = fn;
        }
      }
    } catch (e) {
      clearTimeout(timer);
      try { if (typeof unsub === 'function') unsub(); } catch (ex) {}
      reject(e);
    }
  });
}

// ---------------- per-MTF confirmation (updated to prefer websocket for mtf checks) ----------------
async function waitUntilNextTfOpen(tf) {
  const sec = tfToSeconds(tf);
  const waitSec = secondsToNextAligned(sec);
  if (waitSec > 0) {
    console.log(`waitUntilNextTfOpen: waiting ${waitSec}s for tf=${tf}`);
    await new Promise(r => setTimeout(r, waitSec * 1000));
  }
}

async function checkSingleMtfAtOpen(symbol, mtf) {
  ensureRuntime();
  const by = bybitModule;
  if (!by) return { pass:false, error:'no-bybit' };
  await waitUntilNextTfOpen(mtf);
  try {
    const interval = tfToIntervalKey(mtf);
    const histObj = await fetchHistPrevAndCur(symbol, interval, 120);
    if (!histObj) return { pass:false, reason:'no-hist' };
    const prev = histObj.prevClosedHist;
    const cur = histObj.currentHist;
    const lastKTime = klineTime(histObj.lastK);
    const passes = isMtfPass(mtf, prev, cur);
    return { pass: !!passes, mtf, cur, prev, lastKTime, histSample: histObj.histSample };
  } catch (e) {
    console.warn('checkSingleMtfAtOpen error', symbol, mtf, e && e.message);
    return { pass:false, error: e && e.message };
  }
}

async function confirmCandidateMtf(symbol, rootTf, maxWaitSeconds) {
  const mtfs = (MTF_CHECK_MAP[String(rootTf).toLowerCase()] || []).slice();
  const startTsMs = Date.now();
  const deadline = startTsMs + (Number(maxWaitSeconds || 0) * 1000);

  async function checkMtfState(sym, mtf) {
    try {
      const interval = tfToIntervalKey(mtf);

      // Prefer websocket-driven quick check if we have a ws client:
      let h = null;
      if (wsClient) {
        try {
          // wait for a kline event (short timeout so we don't block too long)
          await waitForKlineEvent(sym, interval, Math.min(20000, (deadline - Date.now())));
          // after receiving a kline event, fetch histogram via REST to normalize shape (reuse existing logic)
          h = await fetchHistPrevAndCur(sym, interval, 200);
        } catch (we) {
          // websocket path failed or timed out; fallback to REST single fetch
          h = await fetchHistPrevAndCur(sym, interval, 200);
        }
      } else {
        h = await fetchHistPrevAndCur(sym, interval, 200);
      }

      if (!h) return { mtf, pass: false, reason: 'no-hist', prev: null, cur: null, lastKTime: 0, histSample: [] };
      const prev = Number(h.prevClosedHist || 0);
      const cur = Number(h.currentHist || 0);
      // lastKTime: use centralized klineTime() helper for consistency (ms)
      const lastKTime = (h && h.lastK) ? klineTime(h.lastK) : 0;
      const flipped = isNegToPosFlexible(prev, cur, h.histSample);

      // derive a small dynamic epsilon from the recent hist sample to avoid floating-noise misses
      const rawHist = Array.isArray(h.histSample) ? h.histSample.map(x => Number((x && x.hist) || 0)) : [];
      const eps = dynamicEpsilonFromHist(rawHist);
      const positiveAny = rawHist.some(v => Number(v) > Math.max(1e-8, eps * 0.1));

      const rising1d = (String(mtf).toLowerCase().startsWith('1d') || String(mtf).toLowerCase() === 'd') ? (cur > prev) : false;
      const passBasic = positiveAny || rising1d || (cur > 0); // cur>0 is fallback

      // New additional check: require ascending/consecutive higher hist values for this mtf (unless 1d rules apply)
      const ascendingOk = (String(mtf).toLowerCase().startsWith('1d') || String(mtf).toLowerCase() === 'd')
        ? (rawHist.length >= 2 ? (rawHist[rawHist.length-1] > rawHist[rawHist.length-2]) : true)
        : isConsecutiveHigher(rawHist, Math.min(3, rawHist.length));

      const finalPass = passBasic && ascendingOk;

      return { mtf, pass: !!finalPass, prev, cur, lastKTime, histSample: h.histSample, flipped, positiveAny, rising1d, ascendingOk };
    } catch (e) {
      return { mtf, pass: false, reason: e && e.message, prev: null, cur: null, lastKTime: 0, histSample: [] };
    }
  }

  // Quick immediate check — confirm instantly if all mtfs already pass with positiveAny/rising1d + ascending
  try {
    const quickChecks = await Promise.all(mtfs.map(mtf => checkMtfState(symbol, mtf)));
    const allQuickPass = quickChecks.length > 0 && quickChecks.every(c => !!c && (c.positiveAny || c.rising1d || (c.cur > 0)) && c.ascendingOk);
    if (allQuickPass) return { confirmed: true, details: quickChecks, lastToFlip: null };
  } catch (e) {}

  let lastDetails = [];
  const pollIntervalMs = Math.max(1000, Math.min(5000, POLL_INTERVAL_MS || 3000));
  while (Date.now() < deadline) {
    const limiter = createLimiter(Math.max(1, Math.min(REST_CONCURRENCY || 4, 8)));
    const checks = await Promise.all(mtfs.map(mtf => limiter(() => checkMtfState(symbol, mtf))));
    lastDetails = checks;

    // Determine acceptance according to rules:
    // - If every mtf has positiveAny or rising1d or cur>0 AND ascendingOk -> confirm
    // - Else, allow up to NEG_ALLOWED_IN_MTF mtfs to be still-negative but require those frames to have flipped === true (current-candle flip) and ascendingOk
    const failing = checks.filter(c => !(c.positiveAny || c.rising1d || (c.cur > 0)) || !c.ascendingOk);
    if (failing.length === 0) {
      // all good
      // compute lastToFlip: among those that flipped==true pick latest lastKTime
      const flippedFrames = checks.filter(c => c.flipped);
      let lastToFlip = null;
      if (flippedFrames.length) {
        flippedFrames.sort((a,b)=> (b.lastKTime||0) - (a.lastKTime||0));
        lastToFlip = flippedFrames[0].mtf;
      }
      return { confirmed: true, details: checks, lastToFlip };
    }

    if (failing.length <= NEG_ALLOWED_IN_MTF) {
      const allFailingFlipped = failing.every(c => !!c.flipped && c.ascendingOk);
      if (allFailingFlipped) {
        // confirm
        const flippedFrames = checks.filter(c => c.flipped);
        let lastToFlip = null;
        if (flippedFrames.length) {
          flippedFrames.sort((a,b)=> (b.lastKTime||0) - (a.lastKTime||0));
          lastToFlip = flippedFrames[0].mtf;
        }
        return { confirmed: true, details: checks, lastToFlip };
      }
    }

    // Not confirmed yet.
    const now = Date.now();
    const remaining = Math.max(0, deadline - now);
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  return { confirmed: false, details: lastDetails, lastToFlip: null };
}

// ---------------- watchlist polling (unchanged, but still leverages isNegToPosFlexible) ----------------
async function pollWatchlistForFlips(watchlist, rootTf, rootWindowSeconds) {
  if (!ENABLE_ROOT_POLLING || !watchlist || !watchlist.length) return [];
  ensureRuntime();
  console.log(`Starting watchlist polling for ${watchlist.length} symbols for rootTf=${rootTf}, window=${rootWindowSeconds}s`);
  const intervalKey = tfToIntervalKey(rootTf);
  const limiter = createLimiter(Math.max(1, Math.min(REST_CONCURRENCY, 8)));
  const startTs = Date.now();
  const endTs = startTs + (rootWindowSeconds * 1000);

  const flipped = [];
  const polledSet = new Set(watchlist.map(w => w.symbol));

  while (Date.now() < endTs && polledSet.size > 0) {
    const tasks = Array.from(polledSet).map(sym => limiter(async () => {
      try {
        const histObj = await fetchHistPrevAndCur(sym, intervalKey, 120);
        if (!histObj) return null;
        const { prevClosedHist, currentHist, histSample } = histObj;
        if (isNegToPosFlexible(prevClosedHist, currentHist, histSample)) {
          return { symbol: sym, prevClosedHist, currentHist };
        }
        return null;
      } catch (e) {
        return null;
      }
    }));

    const results = await Promise.all(tasks);
    for (const r of results) {
      if (r) {
        flipped.push(r);
        polledSet.delete(r.symbol);
        console.log('Watchlist flip detected:', r.symbol, 'prev=', r.prevClosedHist, 'cur=', r.currentHist);
      }
    }

    if (polledSet.size === 0) break;
    const remaining = Math.max(0, endTs - Date.now());
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }

  return flipped;
}

// ---------------- breakevenManager (unchanged) ----------------
const breakevenManager = (function() {
  const state = {};
  function keyForTrade(t) { return t.tradeId ? String(t.tradeId) : String(t.symbol); }
  async function registerTrade(t) {
    const k = keyForTrade(t);
    state[k] = Object.assign({}, state[k] || {}, {
      tradeId: t.tradeId || null,
      symbol: t.symbol,
      side: t.side || 'long',
      entryPrice: Number(t.entryPrice || t.price || 0),
      referenceLow: Number(t.entryPrice || t.price || 0),
      confirmations: 0,
      lastStopPrice: Number(t.stopPrice || 0),
      lastUpdated: Date.now()
    });
    console.log('breakeven.registerTrade', k, state[k]);
  }
  function unregisterTradeByKey(k) { delete state[k]; }
  function unregisterTrade(tradeId) {
    const k = Object.keys(state).find(x => state[x].tradeId === tradeId);
    if (k) delete state[k];
  }
  function listManaged() { return Object.values(state); }

  async function modifyStopForState(s) {
    ensureRuntime();
    if (!s || !s.symbol) return;
    if (s.side !== 'long') return;
    const reference = s.referenceLow || s.entryPrice;
    const buffer = (BREAKEVEN_BUFFER_PCT || 0) / 100;
    let newStop;
    if (BREAKEVEN_MODE === 'entry') newStop = s.entryPrice * (1 + buffer);
    else newStop = reference * (1 + buffer);
    if (!s.lastStopPrice || newStop > s.lastStopPrice + (s.lastStopPrice * 0.0001)) {
      if (tradeModule && typeof tradeModule.modifyStop === 'function' && OPEN_TRADES) {
        try {
          await tradeModule.modifyStop(s.tradeId || s.symbol, newStop);
          s.lastStopPrice = newStop;
          s.lastUpdated = Date.now();
          await sendNotice('breakeven', `Stop moved for ${s.symbol}`, [`new=${newStop}`, `reason=higher-low`]);
          return true;
        } catch (e) {
          console.warn('breakeven modifyStop failed', s.symbol, e && e.message);
          await sendNotice('breakeven', `Stop modify failed for ${s.symbol}`, [`err: ${e && e.message}`]);
          return false;
        }
      } else {
        const old = s.lastStopPrice || 0;
        s.lastStopPrice = newStop;
        s.lastUpdated = Date.now();
        await sendNotice('breakeven', `DRY-RUN stop move for ${s.symbol}`, [`old=${old}`, `new=${newStop}`, `note=not executed (OPEN_TRADES=${OPEN_TRADES})`]);
        return true;
      }
    }
    return false;
  }

  async function evaluateAll() {
    ensureRuntime();
    const by = bybitModule;
    if (!by || typeof by.fetchKlines !== 'function') {
      console.warn('breakeven.evaluateAll: no bybit client available');
      return;
    }
    const managed = listManaged();
    if (!managed.length) {
      if (tradeModule && typeof tradeModule.getOpenTrades === 'function') {
        try {
          const open = await tradeModule.getOpenTrades();
          if (Array.isArray(open)) {
            for (const t of open) await registerTrade(t);
          }
        } catch (e) { console.warn('breakeven discover open trades failed', e && e.message); }
      }
      return;
    }
    for (const s of managed) {
      try {
        const interval = tfToIntervalKey(BREAKEVEN_TF || '15m');
        if (REST_THROTTLE_MS > 0) await sleep(REST_THROTTLE_MS);
        const klines = await by.fetchKlines(s.symbol, interval, 3);
        if (!Array.isArray(klines) || klines.length === 0) continue;
        const latest = sortKlinesOldestFirst(klines)[klines.length - 1];
        const latestLow = Number(latest.low || latest[3] || 0);
        if (latestLow > (s.referenceLow || 0)) {
          s.confirmations = (s.confirmations || 0) + 1;
          s.referenceLow = latestLow;
          s.lastUpdated = Date.now();
          console.log(`breakeven: ${s.symbol} new higher-low ${latestLow} confirmations=${s.confirmations}`);
        } else {
          s.confirmations = 0;
        }
        if (s.confirmations >= BREAKEVEN_CONFIRM_COUNT) {
          await modifyStopForState(s);
          s.confirmations = 0;
        }
      } catch (e) {
        console.warn('breakeven evaluate error for', s.symbol, e && e.message);
      }
    }
  }

  let schedulerStarted = false;
  function startScheduler() {
    if (schedulerStarted) return;
    schedulerStarted = true;
    const sec = tfToSeconds(BREAKEVEN_TF || '15m');
    const delay = secondsToNextAligned(sec);
    console.log('breakeven scheduler will start in', delay, 'seconds (tf=', BREAKEVEN_TF, ')');
    setTimeout(function first() {
      (async () => {
        await evaluateAll();
        setInterval(async () => { await evaluateAll(); }, sec * 1000);
      })().catch(e => console.warn('breakeven initial run failed', e && e.message));
    }, Math.max(0, delay) * 1000);
  }

  return { registerTrade, unregisterTrade, unregisterTradeByKey, listManaged, evaluateAll, startScheduler };
})();

if (ENABLE_BREAKEVEN_SIGNAL) {
  console.log('Breakeven manager enabled (in-memory). TF=', BREAKEVEN_TF, 'mode=', BREAKEVEN_MODE);
  breakevenManager.startScheduler();
}

// ---------------- helper: mark / check dedupe ----------------
function seenKey(rootTf, symbol) { return `${String(rootTf)}:${String(symbol)}`; }
function wasSeenRecently(rootTf, symbol) {
  if (!SIGNAL_DEDUP_SECONDS) return false;
  const k = seenKey(rootTf, symbol);
  const v = seenSignals.get(k);
  if (!v) return false;
  const ageSec = (Date.now() - v) / 1000;
  return ageSec < SIGNAL_DEDUP_SECONDS;
}
function markSeen(rootTf, symbol) {
  if (!SIGNAL_DEDUP_SECONDS) return;
  const k = seenKey(rootTf, symbol);
  seenSignals.set(k, Date.now());
}

// ---------------- performRootScan (modified to dedupe and aggregate per-root pushes) ----------------
async function performRootScan(rootTf='1h', symbolLimit=MAX_SCAN_SYMBOLS) {
  ensureRuntime();

  // initialize lastScanResults entry so debug endpoint always shows keys
  if (!lastScanResults[rootTf]) lastScanResults[rootTf] = [];

  const scanResults = await fallbackRootScan(rootTf, symbolLimit).catch(e => {
    console.warn('performRootScan: fallbackRootScan failed', e && e.message);
    return [];
  });

  scanStats.lastRun[rootTf] = Date.now();
  scanStats.lastCount[rootTf] = symbolLimit;
  scanStats.lastSignals[rootTf] = scanResults.length;

  const immediateFlips = [];
  const watchCandidates = [];
  for (const r of scanResults) {
    if (typeof r.prevClosedHist !== 'number' || typeof r.currentHist !== 'number') continue;
    if (isNegToPosFlexible(r.prevClosedHist, r.currentHist, r.histSample)) immediateFlips.push(r);
    else if (r.prevClosedHist < 0) watchCandidates.push(r);
  }

  console.log(`performRootScan: rootTf=${rootTf} immediateFlips=${immediateFlips.length} watchCandidates=${watchCandidates.length}`);

  if (immediateFlips.length) {
    const lines = immediateFlips.map((c,i) => `${i+1}. ${c.symbol} prev=${c.prevClosedHist.toFixed(8)} cur=${c.currentHist.toFixed(8)} vol=${c.lastVolume}`);
    // still record this summary to console and telegram (if enabled)
    await sendNotice('root', `Immediate root flips (${rootTf}) count=${immediateFlips.length}`, lines).catch(() => {});
  }

  if (ENABLE_ROOT_POLLING && watchCandidates.length) {
    watchCandidates.sort((a,b) => Math.abs(b.prevClosedHist) - Math.abs(a.prevClosedHist));
    const watchlist = watchCandidates.slice(0, MAX_WATCHLIST);
    console.log(`Watchlist built (${watchlist.length}) for rootTf=${rootTf}`);
    const rootSec = tfToSeconds(rootTf);
    const flips = (await pollWatchlistForFlips(watchlist, rootTf, rootSec)) || [];
    if (flips.length) {
      const lines = flips.map((f,i) => `${i+1}. ${f.symbol} prev=${f.prevClosedHist.toFixed(8)} cur=${f.currentHist.toFixed(8)}`);
      await sendNotice('root', `Polled root flips (${rootTf}) count=${flips.length}`, lines).catch(() => {});
    }
    for (const f of flips) immediateFlips.push({ symbol: f.symbol, rootTf, prevClosedHist: f.prevClosedHist, currentHist: f.currentHist, lastVolume: 0 });
  }

  if (!immediateFlips.length) { lastScanResults[rootTf] = []; return []; }

  const rootSec = tfToSeconds(rootTf);
  const secsUntilNextRoot = secondsToNextAligned(rootSec);
  // Wait until the next aligned root candle (if aligned now, wait a full interval)
  const defaultConfirmWait = (secsUntilNextRoot === 0) ? rootSec : secsUntilNextRoot;

  const confirmLimiter = createLimiter(CONFIRM_CONCURRENCY);
  const confirmations = immediateFlips.map(c => confirmLimiter(async () => {
    const res = await confirmCandidateMtf(c.symbol, rootTf, defaultConfirmWait);
    if (!res.confirmed) return Object.assign({}, c, { mtfConfirmed:false, confirmDetails: res.details });
    const volChange = await compute24hVolumeChangePercent(c.symbol);
    return Object.assign({}, c, { mtfConfirmed:true, confirmDetails: res.details, volChangePct: volChange, latestHist: c.currentHist, volume: c.lastVolume, lastToFlip: res.lastToFlip });
  }));

  let confirmedCandidates = (await Promise.all(confirmations)).filter(x => x && x.mtfConfirmed);

  // Enforce user's rule: only accept positive 24h volume change and macd threshold
  // Add explicit reject reasons for easier debugging (and add flags on candidate objects)
  for (const c of confirmedCandidates) {
    c.rejectReasons = [];
    c.volOk = Number(c.volChangePct || 0) > 0;
    c.macdOk = Number(c.latestHist || 0) > Number(MACD_THRESHOLD || 0);
    if (!c.volOk) c.rejectReasons.push(`volChangePct=${Number(c.volChangePct||0)}`);
    if (!c.macdOk) c.rejectReasons.push(`latestHist=${Number(c.latestHist||0)} <= MACD_THRESHOLD=${MACD_THRESHOLD}`);
    if (process.env.DEBUG_DETECTION === 'true') {
      console.debug('candidate pre-filter', c.symbol, { volChangePct: c.volChangePct, latestHist: c.latestHist, MACD_THRESHOLD, rejectReasons: c.rejectReasons });
    }
  }

  // Now actually filter
  confirmedCandidates = confirmedCandidates.filter(c => {
    const ok = c.volOk && c.macdOk;
    if (!ok) {
      console.log('REJECT candidate after MTF confirm:', c.symbol, 'reasons=', c.rejectReasons && c.rejectReasons.join('; '));
    }
    return ok;
  });

  // Deduplicate: filter out previously-seen symbol+rootTf within dedupe window
  const newCandidates = [];
  for (const c of confirmedCandidates) {
    if (wasSeenRecently(rootTf, c.symbol)) {
      if (process.env.DEBUG_DETECTION === 'true') console.debug('dedupe: skipping recently seen', c.symbol, rootTf);
      continue;
    }
    newCandidates.push(c);
  }

  // Update lastScanResults to reflect current confirmed (even if deduped)
  lastScanResults[rootTf] = confirmedCandidates.slice();

  // If there are newCandidates to notify / plan
  if (newCandidates.length) {
    // Strength is simply MACD histogram value (higher is better)
    for (const c of newCandidates) {
      c.strengthScore = Number(c.latestHist || 0);
      c.filterLabel = null;
      if (FILTER_SIGNALS) {
        const s = c.strengthScore;
        if (s >= (MACD_THRESHOLD * 4 || 4)) c.filterLabel = 'Very Strong';
        else if (s >= (MACD_THRESHOLD * 2 || 2)) c.filterLabel = 'Strong';
        else if (s >= MACD_THRESHOLD) c.filterLabel = 'Medium';
        else c.filterLabel = 'Weak';
      }
    }

    newCandidates.sort((a,b) => (b.strengthScore||0)-(a.strengthScore||0));

    // Notify aggregated mtf notice for this rootTf (single push containing all new candidates)
    const lines = newCandidates.map((c,i) => `${i+1}. ${c.symbol} ${c.filterLabel ? '['+c.filterLabel+'] ' : ''}score=${(c.strengthScore||0).toFixed(8)} macd=${(c.latestHist||0).toFixed(8)} vol24%=${(c.volChangePct||0).toFixed(2)} lastToFlip=${c.lastToFlip||''}`);
    await sendNotice('mtf', `MTF confirmed (${rootTf}) new count=${newCandidates.length}`, lines).catch(() => {});

    // Plan / open trades (respect flags); we only process newCandidates here
    const toOpen = newCandidates.slice(0, MAX_OPEN_TRADES);
    const planLines = [];
    for (const c of toOpen) {
      let suggested = 'N/A';
      try {
        if (tradeModule && typeof tradeModule.suggestSize === 'function') {
          suggested = await tradeModule.suggestSize(c.symbol, { score: c.strengthScore });
        }
      } catch (e) { suggested = 'err'; }
      planLines.push(`${c.symbol} score=${(c.strengthScore||0).toFixed(8)} suggestedSize=${suggested} label=${c.filterLabel||''}`);
    }
    await sendNotice('trade-plan', `Planned opens (max ${MAX_OPEN_TRADES}) for ${rootTf}`, planLines).catch(() => {});

    for (const c of toOpen) {
      try {
        // Enter trade only if TRADE_ON_CONFIRM_NOW is true and OPEN_TRADES enabled.
        if (TRADE_ON_CONFIRM_NOW && tradeModule && typeof tradeModule.openTrade === 'function' && OPEN_TRADES) {
          const result = await tradeModule.openTrade(c.symbol, { rootTf: c.rootTf, score: c.strengthScore, suggestedLabel: c.filterLabel });
          await sendNotice('trade-opened', `Trade opened ${c.symbol}`, [`result: ${JSON.stringify(result)}`, `score=${(c.strengthScore||0).toFixed(8)}`]).catch(() => {});
          if (ENABLE_BREAKEVEN_SIGNAL) {
            const tradeInfo = {
              tradeId: result && result.tradeId ? result.tradeId : null,
              symbol: c.symbol,
              entryPrice: result && result.entryPrice ? result.entryPrice : (c.entryPrice || c.latestPrice || null),
              side: result && result.side ? result.side : 'long',
              stopPrice: result && result.stopPrice ? result.stopPrice : null
            };
            await breakevenManager.registerTrade(tradeInfo);
          }
        } else {
          await sendNotice('trade-dryrun', `DRY-RUN trade for ${c.symbol}`, [`score=${(c.strengthScore||0).toFixed(8)} label=${c.filterLabel||''}`, `note=TRADE_ON_CONFIRM_NOW=${TRADE_ON_CONFIRM_NOW}`]).catch(() => {});
        }
      } catch (e) {
        await sendNotice('trade-error', `Trade open failed ${c.symbol}`, [`error: ${e && e.message}`]).catch(() => {});
      }
    }

    // mark new candidates as seen
    for (const c of newCandidates) markSeen(rootTf, c.symbol);
  } else {
    // No new candidates after dedupe; still notify that none planned for this root
    await sendNotice('mtf', `MTF confirmed (${rootTf}) none-new`, ['No new MTF-confirmed signals this cycle or all signals were recently notified']).catch(() => {});
    await sendNotice('trade-plan', `No trades planned (${rootTf})`, ['No MTF-confirmed signals this cycle or all signals were recently notified']).catch(() => {});
  }

  return confirmedCandidates;
}

// ---------------- scheduler helpers (run scans on every 5m candle open, immediate startup scans) ----------------
function tfToSeconds(tf) {
  const k = String(tf).toLowerCase();
  if (k === '5m' || k === '5') return 300;
  if (k === '15m' || k === '15') return 900;
  if (k === '1h' || k === '60') return 3600;
  if (k === '4h' || k === '240') return 4 * 3600;
  if (k === '1d' || k === 'd' || k === '24h') return 24 * 3600;
  if (/^\d+$/.test(k)) return Number(k);
  return 300;
}
function secondsToNextAligned(intervalSec) {
  const nowS = Math.floor(Date.now() / 1000);
  const rem = nowS % intervalSec;
  return rem === 0 ? 0 : (intervalSec - rem);
}
function parseIntervalForTf(rootTf) {
  const key = String(rootTf).toLowerCase();
  if (key === '1h' || key === '60') return 3600;
  if (key === '4h' || key === '240') return 4 * 3600;
  if (key === '1d' || key.startsWith('d')) return 24 * 3600;
  return 3600;
}

// New scheduler: run performRootScan for all configured root Tfs on every aligned 5-minute candle open
// Immediate startup scans are performed so /debug/current_roots is populated quickly.
function startFiveMinScheduler() {
  const intervalSec = 300; // 5 minutes
  const delaySec = secondsToNextAligned(intervalSec);
  console.log(`5min Scheduler: will start in ${delaySec}s and run scans for root Tfs: ${AUTO_SCAN_ROOT_TFS.join(',')}`);

  // ensure lastScanResults has keys for debug initially
  for (const tf of AUTO_SCAN_ROOT_TFS) if (!lastScanResults[tf]) lastScanResults[tf] = [];

  // Immediate initial scan on startup (so /debug/current_roots and initial pushes populate quickly)
  (async () => {
    try {
      console.log('5min Scheduler: performing immediate startup scans for all configured root Tfs');
      for (const tf of AUTO_SCAN_ROOT_TFS) {
        try { await performRootScan(tf, MAX_SCAN_SYMBOLS); } catch (e) { console.warn('5min Scheduler: immediate performRootScan error', tf, e && e.message); }
      }
    } catch (e) {
      console.warn('5min Scheduler immediate run failed', e && e.message);
    }
  })().catch(e => console.warn('5min Scheduler immediate run outer catch', e && e.message));

  // Schedule aligned runs starting at next aligned boundary
  setTimeout(async function first() {
    try {
      console.log('5min Scheduler: first aligned run — performing root scans for all configured root Tfs');
      for (const tf of AUTO_SCAN_ROOT_TFS) {
        try { await performRootScan(tf, MAX_SCAN_SYMBOLS); } catch (e) { console.warn('5min Scheduler: performRootScan error', tf, e && e.message); }
      }
    } catch (e) { console.warn('5min Scheduler initial aligned run failed', e && e.message); }

    // Continue periodic repeats
    setInterval(async () => {
      try {
        for (const tf of AUTO_SCAN_ROOT_TFS) {
          try { await performRootScan(tf, MAX_SCAN_SYMBOLS); } catch (e) { console.warn('5min Scheduler: performRootScan error', tf, e && e.message); }
        }
      } catch (e) { console.error('5min Scheduler periodic run error', e && e.message); }
    }, intervalSec * 1000);
  }, Math.max(0, delaySec) * 1000);
}

// Start the scheduler
startFiveMinScheduler();

// Optional startup push (kept for backward compat)
if (PUSH_ALL_SIGNALS_ON_STARTUP) {
  (async () => {
    console.log('PUSH_ALL_SIGNALS_ON_STARTUP: running initial scans for', AUTO_SCAN_ROOT_TFS);
    for (const tf of AUTO_SCAN_ROOT_TFS) {
      try {
        const results = await performRootScan(tf, MAX_SCAN_SYMBOLS);
        console.log(`PUSH_ALL_SIGNALS_ON_STARTUP: completed ${tf}, confirmed=${results.length}`);
      } catch (e) {
        console.warn('PUSH_ALL_SIGNALS_ON_STARTUP: scan failed for', tf, e && e.message);
      }
      await sleep(500); // small pause
    }
  })().catch(e => console.warn('PUSH_ALL_SIGNALS_ON_STARTUP: initial run error', e && e.message));
}

// ---------------- added debug endpoints ----------------

// return selected env / runtime configuration for quick inspection
app.get('/debug/env', (req, res) => {
  const envSnapshot = {
    MACD_THRESHOLD,
    MACD_EPSILON,
    MACD_DYNAMIC_EPS_MULT,
    NEG_ALLOWED_IN_MTF,
    FILTER_SIGNALS,
    PUSH_ALL_SIGNALS_ON_STARTUP,
    TRADE_ON_CONFIRM_NOW,
    OPEN_TRADES,
    MAX_OPEN_TRADES,
    ENABLE_ROOT_POLLING,
    REST_CONCURRENCY,
    REST_THROTTLE_MS,
    MAX_SCAN_SYMBOLS,
    HIST_LOOKBACK,
    CONFIRM_CONCURRENCY,
    POLL_INTERVAL_MS,
    MAX_WATCHLIST,
    SCAN_INTERVAL_SECONDS,
    DEBUG_DETECTION: process.env.DEBUG_DETECTION === 'true',
    WEBSOCKET_MODE: !!wsClient,
    SIGNAL_DEDUP_SECONDS
  };
  res.json({ ok: true, config: envSnapshot });
});

// Run confirmCandidateMtf for a single symbol/rootTf and return raw details
app.post('/debug/confirm-mtf', async (req, res) => {
  try {
    const symbol = (req.query.symbol || req.body && req.body.symbol || '').toString().trim();
    const rootTf = (req.query.rootTf || req.body && req.body.rootTf || '4h').toString().trim();
    const wait = Math.max(1, Number(req.query.wait || req.body && req.body.wait || 20));
    if (!symbol) return res.status(400).json({ ok:false, error:'symbol required' });

    ensureRuntime();
    const result = await confirmCandidateMtf(symbol, rootTf, wait);
    return res.json({ ok:true, symbol, rootTf, waitSeconds: wait, result });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e && e.message });
  }
});

// Inspect single symbol pipeline: root hist, flip, per-mtf state, volChange, macd threshold pass
app.get('/debug/inspect', async (req, res) => {
  try {
    const symbol = (req.query.symbol || req.body && req.body.symbol || '').toString().trim();
    const rootTf = (req.query.rootTf || req.body && req.body.rootTf || '4h').toString().trim();
    const wait = Math.max(1, Number(req.query.wait || req.body && req.body.wait || 10));
    if (!symbol) return res.status(400).json({ ok:false, error:'symbol required' });

    ensureRuntime();
    const interval = tfToIntervalKey(rootTf);
    const rootHist = await fetchHistPrevAndCur(symbol, interval, 500);
    if (!rootHist) {
      return res.json({ ok:false, error:'no-root-hist', symbol, rootTf });
    }

    const isRootFlip = isNegToPosFlexible(rootHist.prevClosedHist, rootHist.currentHist, rootHist.histSample);
    const mtfs = (MTF_CHECK_MAP[String(rootTf).toLowerCase()] || []).slice();
    const mtfDetails = [];
    for (const mtf of mtfs) {
      try {
        const intKey = tfToIntervalKey(mtf);
        const h = await fetchHistPrevAndCur(symbol, intKey, 200);
        if (!h) {
          mtfDetails.push({ mtf, ok:false, reason:'no-data' });
          continue;
        }
        const prev = Number(h.prevClosedHist || 0);
        const cur = Number(h.currentHist || 0);
        const flipped = isNegToPosFlexible(prev, cur, h.histSample);
        const rawHist = Array.isArray(h.histSample) ? h.histSample.map(x => Number((x && x.hist) || 0)) : [];
        const eps = dynamicEpsilonFromHist(rawHist);
        const positiveAny = rawHist.some(v => Number(v) > Math.max(1e-8, eps * 0.1));
        const rising1d = (String(mtf).toLowerCase().startsWith('1d') || String(mtf).toLowerCase() === 'd') ? (cur > prev) : false;
        const ascendingOk = (String(mtf).toLowerCase().startsWith('1d') || String(mtf).toLowerCase() === 'd')
          ? (rawHist.length >= 2 ? (rawHist[rawHist.length-1] > rawHist[rawHist.length-2]) : true)
          : isConsecutiveHigher(rawHist, Math.min(3, rawHist.length));
        mtfDetails.push({ mtf, prev, cur, flipped, positiveAny, rising1d, ascendingOk, sampleLen: (h.histSample && h.histSample.length) || 0 });
      } catch (e) {
        mtfDetails.push({ mtf, ok:false, reason: e && e.message });
      }
    }

    const confirmResult = await confirmCandidateMtf(symbol, rootTf, wait);
    const volChange = await compute24hVolumeChangePercent(symbol);
    const macdOk = Number(rootHist.currentHist || 0) > Number(MACD_THRESHOLD || 0);

    return res.json({
      ok:true,
      symbol,
      rootTf,
      rootPrevClosedHist: rootHist.prevClosedHist,
      rootCurrentHist: rootHist.currentHist,
      isRootFlip,
      mtfDetails,
      confirmResult,
      volChangePct: volChange,
      macdOk,
      env: { MACD_THRESHOLD, NEG_ALLOWED_IN_MTF, HIST_LOOKBACK, FILTER_SIGNALS, WEBSOCKET_MODE: !!wsClient }
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e && e.message });
  }
});

// hist-series debug endpoint: returns last N hist values + timestamps for detailed comparison
app.get('/debug/hist', async (req, res) => {
  const symbol = (req.query.symbol || req.body && req.body.symbol || '').toString().trim();
  const tf = (req.query.tf || req.body && req.body.tf || '1h').toString().trim();
  const len = Math.max(50, Number(req.query.len || 200));
  if (!symbol) return res.status(400).json({ ok:false, error:'symbol required' });
  const key = tfToIntervalKey(tf);
  try {
    const h = await fetchHistPrevAndCur(symbol, key, len);
    if (!h) return res.json({ ok:false, error:'no-data' });
    return res.json({ ok:true, symbol, tf, prevClosedHist: h.prevClosedHist, currentHist: h.currentHist, lastK: h.lastK, sampleKlinesLen: h.rawKlines.length, histSample: h.histSample });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e && e.message });
  }
});

app.get('/debug/hist-series', async (req, res) => {
  const symbol = (req.query.symbol || req.body && req.body.symbol || '').toString().trim();
  const tf = (req.query.tf || req.body && req.body.tf || '1h').toString().trim();
  if (!symbol) return res.status(400).json({ ok:false, error:'symbol required' });
  const key = tfToIntervalKey(tf);
  try {
    const h = await fetchHistPrevAndCur(symbol, key, 1000);
    if (!h) return res.json({ ok:false, error:'no-data' });
    return res.json({
      ok:true,
      symbol,
      tf,
      prevClosedHist: h.prevClosedHist,
      currentHist: h.currentHist,
      histSample: h.histSample,
      lastK: h.lastK,
      rawKlinesLen: h.rawKlines.length
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e && e.message });
  }
});

// small helper: debug compare endpoint that yields hist series with both ms and s timestamps
app.get('/debug/compare', async (req, res) => {
  const symbol = (req.query.symbol || req.body && req.body.symbol || '').toString().trim();
  const tf = (req.query.tf || req.body && req.body.tf || '1h').toString().trim();
  if (!symbol) return res.status(400).json({ ok:false, error:'symbol required' });
  const key = tfToIntervalKey(tf);
  try {
    const h = await fetchHistPrevAndCur(symbol, key, Number(req.query.len || 500));
    if (!h) return res.json({ ok:false, error:'no-data' });
    return res.json({
      ok:true,
      symbol,
      tf,
      histSeries: h.histSample.map(p => ({ ts_ms: p.ts_ms, ts_s: p.ts_s, hist: p.hist }))
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e && e.message });
  }
});

// debug current roots: supports ?tf=4h or path param /debug/current_roots/4h or odd /debug/current_roots=4h
app.get(['/debug/current_roots', '/debug/current_roots/:tf', '/debug/current_roots=:tf'], (req, res) => {
  const tf = (req.query.tf || req.params && req.params.tf || '').toString().trim();
  if (tf) {
    const key = tf;
    const r = lastScanResults[key] || [];
    return res.json({ ok:true, tf: key, count: r.length, items: r.slice(0, 200) });
  }
  // return all
  const all = {};
  for (const k of Object.keys(lastScanResults)) all[k] = lastScanResults[k].slice(0,200);
  return res.json({ ok:true, roots: Object.keys(all), lastScanSamples: all });
});

// Combined handler accepts GET/POST (app.all)
app.all('/debug/test-telegram', async (req, res) => {
  try {
    ensureRuntime();
    const message = (req.body && req.body.message) || req.query.message || `Scanner test message ${new Date().toISOString()}`;
    if (!telegramModule) return res.status(500).json({ ok:false, error:'telegram module not loaded' });
    const fn = telegramModule.sendMessage || telegramModule.sendTelegram || telegramModule.send;
    if (typeof fn !== 'function') return res.status(500).json({ ok:false, error:'telegram send function missing' });
    const result = await fn(message, { parse_mode: 'Markdown' });
    try { notifications.push({ ts: Date.now(), type: 'test-telegram', title: 'test', lines: [String(message)], result }); if (notifications.length > MAX_NOTIFICATIONS) notifications.shift(); } catch (e) {}
    return res.json({ ok:true, result });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e && e.message });
  }
});

app.get('/debug/notifications', (req, res) => {
  const lastN = Number(req.query.n || 50);
  const items = notifications.slice(-Math.min(MAX_NOTIFICATIONS, lastN)).map(n => ({ ts: n.ts, type: n.type, title: n.title, lines: n.lines, result: n.result }));
  res.json({ ok:true, count: items.length, items });
});

app.get('/debug/scan-stats', (req, res) => res.json({ ok:true, config: { REST_CONCURRENCY, REST_THROTTLE_MS, MAX_SCAN_SYMBOLS, SCAN_INTERVAL_SECONDS, FILTER_SIGNALS, ENABLE_ROOT_POLLING, POLL_INTERVAL_MS, MAX_WATCHLIST, MACD_EPSILON, MACD_DYNAMIC_EPS_MULT, CONFIRM_CONCURRENCY, HIST_LOOKBACK, PUSH_ALL_SIGNALS_ON_STARTUP, MACD_THRESHOLD, NEG_ALLOWED_IN_MTF, TRADE_ON_CONFIRM_NOW }, scanStats }));
app.get('/debug/last-scan', (req, res) => { const tf = req.query.tf || '1h'; const r = lastScanResults[tf] || []; res.json({ ok:true, tf, count: r.length, items: r.slice(0, 200) }); });

app.post('/debug/run-scan-root', async (req, res) => {
  const rootTf = req.query.rootTf || (req.body && req.body.rootTf) || '1h';
  try {
    const v = await performRootScan(rootTf, MAX_SCAN_SYMBOLS);
    res.json({ ok:true, rootTf, signals: v.length, sample: v.slice(0, 30) });
  } catch (e) {
    res.status(500).json({ ok:false, error: e && e.message });
  }
});

app.get('/', (req, res) => res.redirect('/health'));
app.get('/health', (req, res) => res.json({ ok:true, uptime: process.uptime() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));
console.log('=== READY ===');

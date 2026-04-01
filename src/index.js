// src/index.js — full file with robust fetchHistPrevAndCur, dynamic epsilon detection,
// centralized MACD usage (imports computeMACD), and hist-series debug support.

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

function initRuntimeModules() {
  bybitModule = bybitModule || localRequire('bybit') || localRequire('src/bybit') || null;
  tradeModule = tradeModule || localRequire('trade') || localRequire('src/trade') || null;
  telegramModule = telegramModule || localRequire('telegram') || localRequire('src/telegram') || null;
}
function ensureRuntime() { try { initRuntimeModules(); } catch (e) { console.warn('initRuntime error', e && e.message); } }

// ---------------- stats & buffers ----------------
const scanStats = { lastRun: {}, lastCount: {}, lastSignals: {} };
let lastScanResults = {}; // keyed by rootTf
const notifications = []; // in-memory circular buffer
const MAX_NOTIFICATIONS = 200;

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

// default scan roots
const AUTO_SCAN_ROOT_TFS = (process.env.AUTO_SCAN_ROOT_TFS || '1h,4h,1d').split(',').map(s => s.trim()).filter(Boolean);

// Tuneable controlling how often we poll watchlist entries (faster to avoid misses)
// Default lowered to 2000ms for quicker reaction windows during testing
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

const MAX_OPEN_TRADES = Math.max(1, Number(process.env.MAX_OPEN_TRADES || 3));
const OPEN_TRADES = (process.env.OPEN_TRADES || 'false').toLowerCase() === 'true';

// Watchlist & polling envs
const ENABLE_ROOT_POLLING = (process.env.ENABLE_ROOT_POLLING || 'true').toLowerCase() === 'true';

// Confirmation concurrency
const CONFIRM_CONCURRENCY = Math.max(1, Number(process.env.CONFIRM_CONCURRENCY || 4));

// Breakeven envs (unchanged)
const ENABLE_BREAKEVEN_SIGNAL = (process.env.ENABLE_BREAKEVEN_SIGNAL || 'false').toLowerCase() === 'true';
const BREAKEVEN_TF = process.env.BREAKEVEN_TF || '15m';
const BREAKEVEN_MODE = (process.env.BREAKEVEN_MODE || 'higher_low');
const BREAKEVEN_BUFFER_PCT = Number(process.env.BREAKEVEN_BUFFER_PCT || 0.1);
const BREAKEVEN_CONFIRM_COUNT = Math.max(1, Number(process.env.BREAKEVEN_CONFIRM_COUNT || 1));
const BREAKEVEN_CHECK_AT_CLOSE_ONLY = (process.env.BREAKEVEN_CHECK_AT_CLOSE_ONLY || 'true').toLowerCase() === 'true';
const BREAKEVEN_PERSIST = (process.env.BREAKEVEN_PERSIST || 'false').toLowerCase() === 'false';

console.log('CONFIG', { AUTO_SCAN_ROOT_TFS, REST_CONCURRENCY, REST_THROTTLE_MS, MAX_SCAN_SYMBOLS, ENABLE_ROOT_POLLING, POLL_INTERVAL_MS, MAX_WATCHLIST, MACD_EPSILON, MACD_DYNAMIC_EPS_MULT, CONFIRM_CONCURRENCY });

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

// --- dynamic epsilon helper -------------------------------------------------
function dynamicEpsilonFromHist(histArray, envEps = MACD_EPSILON) {
  // If user set MACD_EPSILON > 0, respect it
  if (typeof envEps === 'number' && envEps > 0) return envEps;

  // fallback dynamic epsilon from recent hist magnitudes
  if (!Array.isArray(histArray) || histArray.length < 6) return 1e-8;
  const mags = histArray.map(v => Math.abs(Number(v) || 0)).filter(v => v > 0);
  if (!mags.length) return 1e-8;
  mags.sort((a,b)=>a-b);
  const med = mags[Math.floor(mags.length / 2)];
  const mult = (Number.isFinite(MACD_DYNAMIC_EPS_MULT) && MACD_DYNAMIC_EPS_MULT > 0) ? MACD_DYNAMIC_EPS_MULT : 0.05;
  // choose relative fraction; ensure not too tiny
  return Math.max(1e-8, med * mult);
}

/**
 * isNegToPosFlexible(prev, cur, histSample, opts)
 * - histSample: array of recent histogram numeric values (for dynamic epsilon derivation)
 * - opts: { envEpsOverride: number|null } optional
 *
 * Behavior:
 * - If envEpsOverride > 0 (or MACD_EPSILON > 0) use strict threshold prev < -eps && cur > +eps
 * - Else use dynamic eps from histSample and:
 *     return true if prev < -eps && cur > +eps
 *     OR (prev < 0 && cur > 0 && (cur - prev) >= minDelta) where minDelta = max(1e-8, eps*0.5)
 * - Also checks recent histSample series for any negative->positive crossing to catch earlier flips
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

  // Additional: scan the last few hist values to detect crossing inside series
  const LOOKBACK = 6; // check last up to 6 points
  if (rawHist.length >= 2) {
    const tail = rawHist.slice(- (LOOKBACK + 1));
    for (let i = 0; i < tail.length - 1; i++) {
      const a = tail[i], b = tail[i+1];
      if (Number(a) < 0 && Number(b) > 0 && (b - a) >= minDelta) {
        if (process.env.DEBUG_DETECTION === 'true') {
          console.debug('isNegToPosFlexible: detected crossing in recent series', { idx: i, a, b, minDelta });
        }
        return true;
      }
    }
  }
  return false;
}

// helper: scan recent histSample for a negative->positive crossing
function histHasNegToPosCrossing(histSample, lookback = 6, minDelta = 1e-8) {
  if (!Array.isArray(histSample) || histSample.length < 2) return false;
  const raw = histSample.map(h => (typeof h === 'object' ? Number(h.hist || 0) : Number(h || 0)));
  const tail = raw.slice(- (lookback + 1));
  for (let i = 0; i < tail.length - 1; i++) {
    const a = tail[i], b = tail[i+1];
    if (a < 0 && b > 0 && ((b - a) >= minDelta)) {
      if (process.env.DEBUG_DETECTION === 'true') {
        console.debug('histHasNegToPosCrossing: detected crossing', { idx: i, a, b, minDelta });
      }
      return true;
    }
  }
  return false;
}

// ---------------- messaging helper (telegram or fallback) ----------------
async function sendNotice(type, title, lines) {
  const header = `[${type.toUpperCase()}] ${title}`;
  const body = [header, ...lines].join('\n');

  // append to buffer
  try {
    const entry = { ts: Date.now(), type, title, lines, text: body };
    notifications.push(entry);
    if (notifications.length > MAX_NOTIFICATIONS) notifications.shift();
  } catch (e) {}

  ensureRuntime();
  if (telegramModule) {
    const fn = telegramModule.sendMessage || telegramModule.sendTelegram || telegramModule.send;
    if (typeof fn === 'function') {
      try {
        await fn(body);
        return;
      } catch (e) {
        console.warn('telegram send failed', e && (e.status || e.respData || e.message || e));
      }
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
/**
 * fetchHistPrevAndCur(symbol, tfIntervalKey, klinesLimit = 200)
 * - ensures we fetch a generous number of klines to avoid seeding artifacts
 * - returns numeric prevClosedHist and currentHist, last kline, raw klines,
 *   closes, macd object, and histSample (array of { ts_ms, ts_s, hist } for lastN)
 */
async function fetchHistPrevAndCur(symbol, tfIntervalKey, klinesLimit = 500) {
  ensureRuntime();
  const by = bybitModule;
  if (!by || typeof by.fetchKlines !== 'function') return null;

  // make sure we request at least a moderate number of bars; prefer larger for stable EMA seeding
  const want = Math.max(200, Math.min(2000, Number(klinesLimit || 800)));

  if (REST_THROTTLE_MS > 0) await sleep(REST_THROTTLE_MS);

  // use retryWithBackoff if provided by utils to be resilient to transient API errors
  let raw;
  try {
    const fetchFn = by.fetchKlines.bind(by);
    raw = (typeof retryWithBackoff === 'function')
      ? await retryWithBackoff(() => fetchFn(symbol, tfIntervalKey, want))
      : await fetchFn(symbol, tfIntervalKey, want);
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

  // Build histSample: last N hist values with timestamps aligned to klines
  const N = 120; // return last 120 hist points by default for better context
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

// ---------------- fallbackRootScan ----------------
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
  const intervalKey = (rootTf === '1h') ? '60' : (rootTf === '4h' ? '240' : (rootTf === '1d' ? 'D' : rootTf));

  const tasks = symbols.map(sym => limiter(async () => {
    try {
      const histObj = await fetchHistPrevAndCur(sym, intervalKey, 500);
      if (!histObj) return null;
      return {
        symbol: sym,
        rootTf,
        prevClosedHist: histObj.prevClosedHist,
        currentHist: histObj.currentHist,
        histSample: histObj.histSample, // include sample for local inspection
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
    if (histHasNegToPosCrossing(r.histSample, 6)) return true; // catch crossings inside series
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

// ---------------- per-MTF confirmation ----------------
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
    const interval = (mtf === '5m' ? '5' : (mtf === '15m' ? '15' : (mtf === '1h' ? '60' : (mtf === '4h' ? '240' : (mtf === '1d' ? 'D' : mtf)))));
    const histObj = await fetchHistPrevAndCur(symbol, interval, 120);
    if (!histObj) return { pass:false, reason:'no-hist' };
    const prev = histObj.prevClosedHist;
    const cur = histObj.currentHist;
    const lastKTime = klineTime(histObj.lastK);
    // use MTF acceptance rules: 1d rising allowed, other mtfs require cur > 0
    const passes = isMtfPass(mtf, prev, cur);
    return { pass: !!passes, mtf, cur, prev, lastKTime, histSample: histObj.histSample };
  } catch (e) {
    console.warn('checkSingleMtfAtOpen error', symbol, mtf, e && e.message);
    return { pass:false, error: e && e.message };
  }
}

async function confirmCandidateMtf(symbol, rootTf, maxWaitSeconds) {
  // Behavior:
  // - For each MTF: accept if isMtfPass(mtf, prev, cur)
  // - If lower mtfs (5m/15m) are negative we poll until timeout for flips using isNegToPosFlexible
  const mtfs = MTF_CHECK_MAP[String(rootTf).toLowerCase()] || [];
  const startTsMs = Date.now();
  const deadline = startTsMs + (Number(maxWaitSeconds || 0) * 1000);

  async function checkMtfState(sym, mtf) {
    try {
      const interval = (mtf === '5m' ? '5' : (mtf === '15m' ? '15' : (mtf === '1h' ? '60' : (mtf === '4h' ? '240' : (mtf === '1d' ? 'D' : mtf)))));
      const h = await fetchHistPrevAndCur(sym, interval, 200);
      if (!h) return { mtf, pass: false, reason: 'no-hist', prev: null, cur: null, lastKTime: 0, histSample: [] };
      const prev = Number(h.prevClosedHist || 0);
      const cur = Number(h.currentHist || 0);
      const lastKTime = Number(h.lastK && (h.lastK.timestamp || h.lastK.openTime || h.lastK.time || 0)) || 0;
      const pass = isMtfPass(mtf, prev, cur);
      const flipped = isNegToPosFlexible(prev, cur, h.histSample);
      return { mtf, pass: !!pass, prev, cur, lastKTime, histSample: h.histSample, flipped };
    } catch (e) {
      return { mtf, pass: false, reason: e && e.message, prev: null, cur: null, lastKTime: 0, histSample: [] };
    }
  }

  // Quick immediate check — if all mtfs already pass, confirm immediately (helps on startup)
  try {
    const quickChecks = await Promise.all(mtfs.map(mtf => checkMtfState(symbol, mtf)));
    const allQuickPass = quickChecks.length > 0 && quickChecks.every(c => !!c && c.pass);
    if (allQuickPass) return { confirmed: true, details: quickChecks };
  } catch (e) {}

  let lastDetails = [];
  const pollIntervalMs = Math.max(1000, Math.min(5000, POLL_INTERVAL_MS || 3000));
  while (Date.now() < deadline) {
    const limiter = createLimiter(Math.max(1, Math.min(REST_CONCURRENCY || 4, 8)));
    const checks = await Promise.all(mtfs.map(mtf => limiter(() => checkMtfState(symbol, mtf))));
    lastDetails = checks;

    // immediate acceptance when all mtfs satisfy rules
    const allPass = checks.length > 0 && checks.every(c => !!c && c.pass);
    if (allPass) return { confirmed: true, details: checks };

    // if any timeframe flipped (using flexible detection), re-check rules
    const anyFlipped = checks.some(c => !!c && !!c.flipped);
    if (anyFlipped) {
      const reAllPass = checks.every(c => !!c && c.pass);
      if (reAllPass) return { confirmed: true, details: checks };
      // otherwise keep polling until deadline (some mtfs may still be negative)
    }

    const now = Date.now();
    const remaining = Math.max(0, deadline - now);
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  return { confirmed: false, details: lastDetails };
}

// ---------------- watchlist polling ----------------
async function pollWatchlistForFlips(watchlist, rootTf, rootWindowSeconds) {
  if (!ENABLE_ROOT_POLLING || !watchlist || !watchlist.length) return [];
  ensureRuntime();
  console.log(`Starting watchlist polling for ${watchlist.length} symbols for rootTf=${rootTf}, window=${rootWindowSeconds}s`);
  const intervalKey = (rootTf === '1h') ? '60' : (rootTf === '4h' ? '240' : (rootTf === '1d' ? 'D' : rootTf));
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
        const interval = (BREAKEVEN_TF === '15m' ? '15' : (BREAKEVEN_TF === '5m' ? '5' : (BREAKEVEN_TF === '1h' ? '60' : BREAKEVEN_TF)));
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

// ---------------- performRootScan ----------------
async function performRootScan(rootTf='1h', symbolLimit=MAX_SCAN_SYMBOLS) {
  ensureRuntime();
  const scanResults = await fallbackRootScan(rootTf, symbolLimit);
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
    await sendNotice('root', `Immediate root flips (${rootTf}) count=${immediateFlips.length}`, lines);
  }

  if (ENABLE_ROOT_POLLING && watchCandidates.length) {
    watchCandidates.sort((a,b) => Math.abs(b.prevClosedHist) - Math.abs(a.prevClosedHist));
    const watchlist = watchCandidates.slice(0, MAX_WATCHLIST);
    console.log(`Watchlist built (${watchlist.length}) for rootTf=${rootTf}`);
    const rootSec = tfToSeconds(rootTf);
    const flips = (await pollWatchlistForFlips(watchlist, rootTf, rootSec)) || [];
    if (flips.length) {
      const lines = flips.map((f,i) => `${i+1}. ${f.symbol} prev=${f.prevClosedHist.toFixed(8)} cur=${f.currentHist.toFixed(8)}`);
      await sendNotice('root', `Polled root flips (${rootTf}) count=${flips.length}`, lines);
    }
    for (const f of flips) immediateFlips.push({ symbol: f.symbol, rootTf, prevClosedHist: f.prevClosedHist, currentHist: f.currentHist, lastVolume: 0 });
  }

  if (!immediateFlips.length) { lastScanResults[rootTf] = []; return []; }

  const rootSec = tfToSeconds(rootTf);
  const secsUntilNextRoot = secondsToNextAligned(rootSec);
  // ensure we provide at least one full root interval for confirmations
  const defaultConfirmWait = Math.max(secsUntilNextRoot === 0 ? rootSec : secsUntilNextRoot, rootSec);

  // Streaming confirmations: start confirmations promptly but limit concurrency
  const confirmLimiter = createLimiter(CONFIRM_CONCURRENCY);
  const confirmations = immediateFlips.map(c => confirmLimiter(async () => {
    const res = await confirmCandidateMtf(c.symbol, rootTf, defaultConfirmWait);
    if (!res.confirmed) return Object.assign({}, c, { mtfConfirmed:false, confirmDetails: res.details });
    const volChange = await compute24hVolumeChangePercent(c.symbol);
    return Object.assign({}, c, { mtfConfirmed:true, confirmDetails: res.details, volChangePct: volChange, latestHist: c.currentHist, volume: c.lastVolume });
  }));

  const confirmedCandidates = (await Promise.all(confirmations)).filter(x => x && x.mtfConfirmed);

  if (confirmedCandidates.length) {
    const macdVals = confirmedCandidates.map(x => x.latestHist || 0);
    const volVals = confirmedCandidates.map(x => x.volChangePct || 0);
    const macdMin = Math.min(...macdVals), macdMax = Math.max(...macdVals);
    const volMin = Math.min(...volVals), volMax = Math.max(...volVals);
    function normalize(v,min,max){ if (!isFinite(v)) return 0; if (max===min) return 0.5; return (v-min)/(max-min); }

    for (const c of confirmedCandidates) {
      const macdNorm = normalize(c.latestHist || 0, macdMin, macdMax);
      const volNorm = normalize(c.volChangePct || 0, volMin, volMax);
      const strength = Math.max(macdNorm, volNorm);
      c.strengthScore = strength;
      if (FILTER_SIGNALS) {
        if (strength >= 0.9) c.filterLabel = 'Very Strong';
        else if (strength >= 0.7) c.filterLabel = 'Strong';
        else if (strength >= 0.5) c.filterLabel = 'Medium';
        else c.filterLabel = 'Weak';
      } else {
        c.filterLabel = null;
      }
    }

    confirmedCandidates.sort((a,b) => (b.strengthScore||0)-(a.strengthScore||0));
  }

  if (confirmedCandidates.length) {
    const lines = confirmedCandidates.map((c,i) => `${i+1}. ${c.symbol} ${c.filterLabel ? '['+c.filterLabel+'] ' : ''}score=${(c.strengthScore||0).toFixed(3)} macd=${(c.latestHist||0).toFixed(8)} vol24%=${(c.volChangePct||0).toFixed(2)}`);
    await sendNotice('mtf', `MTF confirmed (${rootTf}) count=${confirmedCandidates.length}`, lines);
  } else {
    await sendNotice('mtf', `MTF confirmed (${rootTf}) none`, ['No candidates passed MTF within root window']);
  }

  lastScanResults[rootTf] = confirmedCandidates;

  if (confirmedCandidates.length) {
    const toOpen = confirmedCandidates.slice(0, MAX_OPEN_TRADES);
    const planLines = [];
    for (const c of toOpen) {
      let suggested = 'N/A';
      try {
        if (tradeModule && typeof tradeModule.suggestSize === 'function') {
          suggested = await tradeModule.suggestSize(c.symbol, { score: c.strengthScore });
        }
      } catch (e) { suggested = 'err'; }
      planLines.push(`${c.symbol} score=${(c.strengthScore||0).toFixed(3)} suggestedSize=${suggested} label=${c.filterLabel||''}`);
    }
    await sendNotice('trade-plan', `Planned opens (max ${MAX_OPEN_TRADES})`, planLines);

    for (const c of toOpen) {
      try {
        if (tradeModule && typeof tradeModule.openTrade === 'function' && OPEN_TRADES) {
          const result = await tradeModule.openTrade(c.symbol, { rootTf: c.rootTf, score: c.strengthScore, suggestedLabel: c.filterLabel });
          await sendNotice('trade-opened', `Trade opened ${c.symbol}`, [`result: ${JSON.stringify(result)}`, `score=${(c.strengthScore||0).toFixed(3)}`]);
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
          await sendNotice('trade-dryrun', `DRY-RUN trade for ${c.symbol}`, [`score=${(c.strengthScore||0).toFixed(3)} label=${c.filterLabel||''}`]);
        }
      } catch (e) {
        await sendNotice('trade-error', `Trade open failed ${c.symbol}`, [`error: ${e && e.message}`]);
      }
    }
  } else {
    await sendNotice('trade-plan', `No trades planned (${rootTf})`, ['No MTF-confirmed signals this cycle']);
  }

  return confirmedCandidates;
}

// ---------------- scheduler helpers ----------------
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

function startAutoScan(rootTf='1h') {
  const intervalSec = parseIntervalForTf(rootTf);
  const symbolLimit = MAX_SCAN_SYMBOLS;

  (async () => {
    console.log(`AUTO SCAN: initial run for ${rootTf}`);
    await performRootScan(rootTf, symbolLimit);
  })().catch(e => console.warn('initial auto-scan failed', e && e.message));

  const delaySec = secondsToNextAligned(intervalSec);
  console.log(`AUTO SCAN: ${rootTf} intervalSec=${intervalSec} delayUntilFirstAlignedRun=${delaySec}s`);
  setTimeout(async function firstAligned() {
    try {
      console.log(`AUTO SCAN aligned run for ${rootTf} starting now`);
      await performRootScan(rootTf, symbolLimit);
    } catch (e) { console.error('AUTO SCAN aligned run error', e && e.message); }
    setInterval(async () => {
      try { await performRootScan(rootTf, symbolLimit); }
      catch (e) { console.error('AUTO SCAN periodic error', e && e.message); }
    }, intervalSec * 1000);
  }, Math.max(0, delaySec) * 1000);
}

for (const tf of AUTO_SCAN_ROOT_TFS) startAutoScan(tf);

// ---------------- debug endpoints ----------------
app.get('/debug/macd', async (req, res) => {
  const symbol = (req.query.symbol || req.body && req.body.symbol || '').toString().trim();
  const tf = (req.query.tf || req.body && req.body.tf || '1h').toString().trim();
  const len = Math.max(50, Number(req.query.len || 200));
  if (!symbol) return res.status(400).json({ ok:false, error:'symbol required' });
  try {
    ensureRuntime();
    const by = bybitModule;
    if (!by || typeof by.fetchKlines !== 'function') return res.status(500).json({ ok:false, error: 'no bybit client' });
    const interval = (tf === '1h' ? '60' : (tf === '4h' ? '240' : (tf === '15m' ? '15' : (tf === '5m' ? '5' : (tf === '1d' ? 'D' : tf)))));
    const raw = await by.fetchKlines(symbol, interval, len);
    if (!Array.isArray(raw) || raw.length < 3) return res.json({ ok:false, error:'not-enough-klines', klinesLength: (raw && raw.length) || 0 });
    const klines = sortKlinesOldestFirst(raw);
    const closes = klines.map(k => klineClose(k));
    const macd = computeMACD(closes);
    return res.json({
      ok:true,
      symbol,
      tf,
      lastK: klines[klines.length-1],
      closesSample: closes.slice(-40),
      macdSample: { macd: macd.macd.slice(-40), signal: macd.signal.slice(-40), hist: macd.hist.slice(-40) }
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e && e.message });
  }
});

app.get('/debug/hist', async (req, res) => {
  const symbol = (req.query.symbol || req.body && req.body.symbol || '').toString().trim();
  const tf = (req.query.tf || req.body && req.body.tf || '1h').toString().trim();
  if (!symbol) return res.status(400).json({ ok:false, error:'symbol required' });
  const key = (tf === '1h') ? '60' : (tf === '4h' ? '240' : (tf === '1d' ? 'D' : tf));
  try {
    const h = await fetchHistPrevAndCur(symbol, key, 500);
    if (!h) return res.json({ ok:false, error:'no-data' });
    return res.json({ ok:true, symbol, tf, prevClosedHist: h.prevClosedHist, currentHist: h.currentHist, lastK: h.lastK, sampleKlinesLen: h.rawKlines.length, histSample: h.histSample });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e && e.message });
  }
});

// hist-series debug endpoint: returns last N hist values + timestamps for detailed comparison
app.get('/debug/hist-series', async (req, res) => {
  const symbol = (req.query.symbol || req.body && req.body.symbol || '').toString().trim();
  const tf = (req.query.tf || req.body && req.body.tf || '1h').toString().trim();
  if (!symbol) return res.status(400).json({ ok:false, error:'symbol required' });
  // Fixed nested ternary: balanced and readable
  const key = (tf === '1h') ? '60' :
              (tf === '4h') ? '240' :
              (tf === '1d') ? 'D' :
              (tf === '15m') ? '15' :
              (tf === '5m') ? '5' :
              tf;
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
  const key = (tf === '1h') ? '60' :
              (tf === '4h') ? '240' :
              (tf === '1d') ? 'D' :
              (tf === '15m') ? '15' :
              (tf === '5m') ? '5' :
              tf;
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

app.get('/debug/scan-stats', (req, res) => res.json({ ok:true, config: { REST_CONCURRENCY, REST_THROTTLE_MS, MAX_SCAN_SYMBOLS, SCAN_INTERVAL_SECONDS, FILTER_SIGNALS, ENABLE_ROOT_POLLING, POLL_INTERVAL_MS, MAX_WATCHLIST, MACD_EPSILON, MACD_DYNAMIC_EPS_MULT, CONFIRM_CONCURRENCY }, scanStats }));
app.get('/debug/last-scan', (req, res) => { const tf = req.query.tf || '1h'; const r = lastScanResults[tf] || []; res.json({ ok:true, tf, count: r.length, items: r.slice(0, 50) }); });

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

// src/index.js — updated: normalized TF keys, configurable ascending MTF check, immediate startup scans

console.log('=== STARTUP: index.js loaded ===');

const express = require('express');
const app = express();
app.use(express.json());

const { createLimiter, sleep, retryWithBackoff } = require('./utils');
const { computeMACD } = require('./macd');

function localRequire(name) {
  try { return require('./' + name); } catch (e) { try { return require(name); } catch (e2) { return null; } }
}

let bybitModule = localRequire('bybit') || null;
let tradeModule = localRequire('trade') || null;
let telegramModule = localRequire('telegram') || null;
let wsClient = null;

function initRuntimeModules() {
  bybitModule = bybitModule || localRequire('bybit') || localRequire('src/bybit') || null;
  tradeModule = tradeModule || localRequire('trade') || localRequire('src/trade') || null;
  telegramModule = telegramModule || localRequire('telegram') || localRequire('src/telegram') || null;

  // instantiate BybitWS if available from wrapper
  try {
    const BybitWS = bybitModule && bybitModule.BybitWS;
    if (!wsClient && typeof BybitWS === 'function') {
      try {
        wsClient = new BybitWS();
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

// ------------- state and defaults ----------------
const scanStats = { lastRun: {}, lastCount: {}, lastSignals: {} };
let lastScanResults = {}; // keyed by normalized rootTf (lowercase)
const notifications = [];
const MAX_NOTIFICATIONS = 200;

// dedupe map: key = `${rootTf}:${symbol}` -> timestamp ms
const seenSignals = new Map();
const SIGNAL_DEDUP_SECONDS = Math.max(0, Number(process.env.SIGNAL_DEDUP_SECONDS || 3600));

// Env toggles & normalization
function parseBoolEnv(name, def = false) {
  const v = process.env[name];
  if (v === undefined) return def;
  return String(v).toLowerCase() === 'true';
}

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

// Ensure AUTO_SCAN_ROOT_TFS normalized
const AUTO_SCAN_ROOT_TFS = (process.env.AUTO_SCAN_ROOT_TFS || '1h,4h,1d')
  .split(',').map(s => s.trim()).filter(Boolean).map(s => s.toLowerCase());

const POLL_INTERVAL_MS = Math.max(1000, Number(process.env.POLL_INTERVAL_MS || 2000));
const MAX_WATCHLIST = Math.max(1, Number(process.env.MAX_WATCHLIST || 200));
const SCAN_INTERVAL_SECONDS = Number(process.env.SCAN_INTERVAL_SECONDS || 300);
const REST_CONCURRENCY = Math.max(1, Number(process.env.REST_CONCURRENCY || 4));
const REST_THROTTLE_MS = Number(process.env.REST_THROTTLE_MS || process.env.REST_THROTTLE || 25);
const MAX_SCAN_SYMBOLS = Number(process.env.MAX_SCAN_SYMBOLS || 500);
const FILTER_SIGNALS = (process.env.FILTER_SIGNALS || 'true').toLowerCase() === 'true';

const MACD_EPSILON = Number(process.env.MACD_EPSILON || 0);
const MACD_DYNAMIC_EPS_MULT = Number(process.env.MACD_DYNAMIC_EPS_MULT || 0.05);
const MACD_THRESHOLD = Number(process.env.MACD_THRESHOLD || 0);
const NEG_ALLOWED_IN_MTF = Math.max(0, Number(process.env.NEG_ALLOWED_IN_MTF || 2));
const TRADE_ON_CONFIRM_NOW = (process.env.TRADE_ON_CONFIRM_NOW || 'false').toLowerCase() === 'true';
const MAX_OPEN_TRADES = Math.max(1, Number(process.env.MAX_OPEN_TRADES || 3));
const OPEN_TRADES = (process.env.OPEN_TRADES || 'false').toLowerCase() === 'true';
const ENABLE_ROOT_POLLING = (process.env.ENABLE_ROOT_POLLING || 'true').toLowerCase() === 'true';
const CONFIRM_CONCURRENCY = Math.max(1, Number(process.env.CONFIRM_CONCURRENCY || 4));
const HIST_LOOKBACK = Math.max(0, Number(process.env.HIST_LOOKBACK || 6));
const PUSH_ALL_SIGNALS_ON_STARTUP = (process.env.PUSH_ALL_SIGNALS_ON_STARTUP || 'false').toLowerCase() === 'true';

// New toggle: require ascending consecutive hist values for MTF confirmation?
// Default: false (keeps previous looser behavior). Set MTF_REQUIRE_ASCENDING=true to enable stricter check.
const MTF_REQUIRE_ASCENDING = parseBoolEnv('MTF_REQUIRE_ASCENDING', false);

console.log('CONFIG', { AUTO_SCAN_ROOT_TFS, REST_CONCURRENCY, REST_THROTTLE_MS, MAX_SCAN_SYMBOLS, ENABLE_ROOT_POLLING, POLL_INTERVAL_MS, MAX_WATCHLIST, MACD_EPSILON, MACD_DYNAMIC_EPS_MULT, CONFIRM_CONCURRENCY, HIST_LOOKBACK, PUSH_ALL_SIGNALS_ON_STARTUP, MACD_THRESHOLD, NEG_ALLOWED_IN_MTF, TRADE_ON_CONFIRM_NOW, SIGNAL_DEDUP_SECONDS, MTF_REQUIRE_ASCENDING });

// ---------------- helpers ----------------
function klineTime(k) { return Number(k && (k[0] || k.openTime || k.time || k.timestamp || 0)) || 0; }
function klineClose(k) { return Number(k && (k.close || k[4])) || 0; }
function sortKlinesOldestFirst(klines) { if (!Array.isArray(klines)) return []; return klines.slice().sort((a,b) => klineTime(a) - klineTime(b)); }

function tfToIntervalKey(tf) {
  const k = String(tf || '').toLowerCase();
  if (k === '1h' || k === '60') return '60';
  if (k === '4h' || k === '240') return '240';
  if (k === '1d' || k === 'd' || k === '24h') return 'D';
  if (k === '15m' || k === '15') return '15';
  if (k === '5m' || k === '5') return '5';
  return tf;
}

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
    return c > 0;
  } catch (e) { return false; }
}

function isNegToPosFlexible(prev, cur, histSample, opts = {}) {
  const p = Number(prev || 0);
  const c = Number(cur || 0);
  const envEps = (typeof opts.envEpsOverride === 'number' && !isNaN(opts.envEpsOverride))
    ? opts.envEpsOverride
    : MACD_EPSILON;
  if (typeof envEps === 'number' && envEps > 0) {
    const ok = (p < -envEps) && (c > envEps);
    if (process.env.DEBUG_DETECTION === 'true') console.debug('isNegToPosFlexible (strict)', { prev: p, cur: c, envEps, ok });
    return ok;
  }

  const rawHist = Array.isArray(histSample) ? histSample.map(h => (typeof h === 'object' ? Number(h.hist || 0) : Number(h || 0))) : [];
  const eps = dynamicEpsilonFromHist(rawHist);
  const minDelta = Math.max(1e-8, eps * 0.5);
  const cond1 = (p < -eps) && (c > eps);
  const cond2 = (p < 0) && (c > 0) && ((c - p) >= minDelta);
  if (process.env.DEBUG_DETECTION === 'true') console.debug('isNegToPosFlexible', { prev: p, cur: c, eps, minDelta, cond1, cond2 });
  if (cond1 || cond2) return true;

  if (HIST_LOOKBACK && HIST_LOOKBACK > 0 && rawHist.length >= 2) {
    const tail = rawHist.slice(- (HIST_LOOKBACK + 1));
    for (let i = 0; i < tail.length - 1; i++) {
      const a = tail[i], b = tail[i+1];
      if (Number(a) < 0 && Number(b) > 0 && (b - a) >= minDelta) {
        if (process.env.DEBUG_DETECTION === 'true') console.debug('isNegToPosFlexible: detected crossing', { idx: i, a, b, minDelta });
        return true;
      }
    }
  }
  return false;
}

function histHasNegToPosCrossing(histSample, lookback = HIST_LOOKBACK, minDelta = 1e-8) {
  if (!Array.isArray(histSample) || histSample.length < 2) return false;
  if (!lookback || lookback <= 0) return false;
  const raw = histSample.map(h => (typeof h === 'object' ? Number(h.hist || 0) : Number(h || 0)));
  const tail = raw.slice(- (lookback + 1));
  for (let i = 0; i < tail.length - 1; i++) {
    const a = tail[i], b = tail[i+1];
    if (a < 0 && b > 0 && ((b - a) >= minDelta)) {
      if (process.env.DEBUG_DETECTION === 'true') console.debug('histHasNegToPosCrossing: detected crossing', { idx: i, a, b });
      return true;
    }
  }
  return false;
}

function isConsecutiveHigher(histSample, lookback = 3) {
  if (!Array.isArray(histSample) || histSample.length < lookback) return false;
  const raw = histSample.slice(-lookback).map(h => (typeof h === 'object' ? Number(h.hist || 0) : Number(h || 0)));
  for (let i = 0; i < raw.length; i++) {
    if (!(Number.isFinite(raw[i]) && raw[i] > 0)) return false;
    if (i > 0 && raw[i] <= raw[i-1]) return false;
  }
  return true;
}

// ---------------- messaging ----------------
async function sendNotice(type, title, lines) {
  const header = `[${type.toUpperCase()}] ${title}`;
  const body = [header, ...lines].join('\n');
  try {
    notifications.push({ ts: Date.now(), type, title, lines, text: body });
    if (notifications.length > MAX_NOTIFICATIONS) notifications.shift();
  } catch (e) {}
  ensureRuntime();
  if (!telegramModule) {
    console.log('sendNotice: telegram module not loaded — stored in buffer only');
    console.log(body);
    return;
  }
  const fn = telegramModule.sendMessage || telegramModule.sendTelegram || telegramModule.send;
  if (typeof fn !== 'function') {
    console.warn('sendNotice: telegram send function missing; fallback to console');
    console.log(body);
    return;
  }
  try {
    await fn(body);
  } catch (e) {
    console.warn('telegram send failed', e && (e.status || e.respData || e.message || e));
  }
}

// ---------------- helpers: compute24hVolumeChangePercent, fetchHistPrevAndCur ----------------
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
    outSample.push({ ts_ms: ts, ts_s: Math.floor(ts / 1000), hist: Number(hist[i] || 0) });
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
  const symbols = syms.map(s => (typeof s === 'string' ? s : (s.symbol || s.name || s.code || ''))).filter(Boolean).slice(0, Number(symbolLimit || MAX_SCAN_SYMBOLS));
  console.log('fallbackRootScan: scanning symbol count=', symbols.length, 'rootTf=', rootTf);
  const limiter = createLimiter(REST_CONCURRENCY);
  const intervalKey = tfToIntervalKey(rootTf);
  const tasks = symbols.map(sym => limiter(async () => {
    try {
      const histObj = await fetchHistPrevAndCur(sym, intervalKey, 500);
      if (!histObj) return null;
      return { symbol: sym, rootTf, prevClosedHist: histObj.prevClosedHist, currentHist: histObj.currentHist, histSample: histObj.histSample, lastVolume: Number(histObj.lastK && (histObj.lastK.volume || histObj.lastK.v || 0) || 0), closes: histObj.closes };
    } catch (e) { console.warn('fallbackRootScan symbol error', sym, e && e.message); return null; }
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
  const sample = negatives.sort((a,b) => Math.abs(b.prevClosedHist) - Math.abs(a.prevClosedHist)).slice(0, 10).map(s => ({ symbol: s.symbol, prev: s.prevClosedHist, cur: s.currentHist, vol: s.lastVolume }));
  if (sample.length) console.log('fallbackRootScan: negative sample=', sample);
  return results;
}

// --------------- WS helper for kline wait (used by confirmCandidateMtf) --------------
function waitForKlineEvent(symbol, interval, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    if (!wsClient || typeof wsClient.subscribeKline !== 'function') return reject(new Error('ws-unavailable'));
    let settled = false;
    let unsub = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { if (typeof unsub === 'function') unsub(); } catch (e) {}
      reject(new Error('kline-wait-timeout'));
    }, timeoutMs);
    try {
      unsub = wsClient.subscribeKline(symbol, interval, (kline) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (typeof unsub === 'function') unsub(); } catch (e) {}
        resolve(kline);
      });
      if (typeof unsub !== 'function' && unsub && typeof unsub.unsubscribe === 'function') {
        const fn = () => unsub.unsubscribe();
        unsub = fn;
      }
    } catch (e) {
      clearTimeout(timer);
      try { if (typeof unsub === 'function') unsub(); } catch (ex) {}
      reject(e);
    }
  });
}

// ---------------- per-MTF confirmation (uses normalized TFs and optional ascending requirement) ----------------
async function waitUntilNextTfOpen(tf) {
  const sec = tfToSeconds(tf);
  const waitSec = secondsToNextAligned(sec);
  if (waitSec > 0) {
    console.log(`waitUntilNextTfOpen: waiting ${waitSec}s for tf=${tf}`);
    await new Promise(r => setTimeout(r, waitSec * 1000));
  }
}

async function confirmCandidateMtf(symbol, rootTf, maxWaitSeconds) {
  const mtfs = (MTF_CHECK_MAP[String(rootTf).toLowerCase()] || []).slice();
  const startTsMs = Date.now();
  const deadline = startTsMs + (Number(maxWaitSeconds || 0) * 1000);

  async function checkMtfState(sym, mtf) {
    try {
      const interval = tfToIntervalKey(mtf);
      let h = null;
      if (wsClient) {
        try {
          await waitForKlineEvent(sym, interval, Math.min(20000, (deadline - Date.now())));
          h = await fetchHistPrevAndCur(sym, interval, 200);
        } catch (we) {
          h = await fetchHistPrevAndCur(sym, interval, 200);
        }
      } else {
        h = await fetchHistPrevAndCur(sym, interval, 200);
      }
      if (!h) return { mtf, pass: false, reason: 'no-hist', prev: null, cur: null, lastKTime: 0, histSample: [] };
      const prev = Number(h.prevClosedHist || 0);
      const cur = Number(h.currentHist || 0);
      const lastKTime = (h && h.lastK) ? klineTime(h.lastK) : 0;
      const flipped = isNegToPosFlexible(prev, cur, h.histSample);
      const rawHist = Array.isArray(h.histSample) ? h.histSample.map(x => Number((x && x.hist) || 0)) : [];
      const eps = dynamicEpsilonFromHist(rawHist);
      const positiveAny = rawHist.some(v => Number(v) > Math.max(1e-8, eps * 0.1));
      const rising1d = (String(mtf).toLowerCase().startsWith('1d') || String(mtf).toLowerCase() === 'd') ? (cur > prev) : false;
      const passBasic = positiveAny || rising1d || (cur > 0);
      const ascendingOk = MTF_REQUIRE_ASCENDING ? (String(mtf).toLowerCase().startsWith('1d') || String(mtf).toLowerCase() === 'd' ? (rawHist.length >= 2 ? (rawHist[rawHist.length-1] > rawHist[rawHist.length-2]) : true) : isConsecutiveHigher(rawHist, Math.min(3, rawHist.length))) : true;
      const finalPass = passBasic && ascendingOk;
      return { mtf, pass: !!finalPass, prev, cur, lastKTime, histSample: h.histSample, flipped, positiveAny, rising1d, ascendingOk };
    } catch (e) {
      return { mtf, pass: false, reason: e && e.message, prev: null, cur: null, lastKTime: 0, histSample: [] };
    }
  }

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
    const failing = checks.filter(c => !(c.positiveAny || c.rising1d || (c.cur > 0)) || !c.ascendingOk);
    if (failing.length === 0) {
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
        const flippedFrames = checks.filter(c => c.flipped);
        let lastToFlip = null;
        if (flippedFrames.length) {
          flippedFrames.sort((a,b)=> (b.lastKTime||0) - (a.lastKTime||0));
          lastToFlip = flippedFrames[0].mtf;
        }
        return { confirmed: true, details: checks, lastToFlip };
      }
    }
    const now = Date.now();
    const remaining = Math.max(0, deadline - now);
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
  return { confirmed: false, details: lastDetails, lastToFlip: null };
}

// -------------- dedupe helpers --------------
function seenKey(rootTf, symbol) { return `${String(rootTf).toLowerCase()}:${String(symbol)}`; }
function wasSeenRecently(rootTf, symbol) { if (!SIGNAL_DEDUP_SECONDS) return false; const k = seenKey(rootTf, symbol); const v = seenSignals.get(k); if (!v) return false; const ageSec = (Date.now() - v) / 1000; return ageSec < SIGNAL_DEDUP_SECONDS; }
function markSeen(rootTf, symbol) { if (!SIGNAL_DEDUP_SECONDS) return; const k = seenKey(rootTf, symbol); seenSignals.set(k, Date.now()); }

// ---------------- performRootScan (normalized keys, aggregated push, dedupe) ----------------
async function performRootScan(rootTf='1h', symbolLimit=MAX_SCAN_SYMBOLS) {
  ensureRuntime();
  const canonicalTf = String(rootTf).toLowerCase();
  if (!lastScanResults[canonicalTf]) lastScanResults[canonicalTf] = [];
  const scanResults = await fallbackRootScan(canonicalTf, symbolLimit).catch(e => { console.warn('performRootScan: fallbackRootScan failed', e && e.message); return []; });
  scanStats.lastRun[canonicalTf] = Date.now();
  scanStats.lastCount[canonicalTf] = symbolLimit;
  scanStats.lastSignals[canonicalTf] = scanResults.length;
  const immediateFlips = [];
  const watchCandidates = [];
  for (const r of scanResults) {
    if (typeof r.prevClosedHist !== 'number' || typeof r.currentHist !== 'number') continue;
    if (isNegToPosFlexible(r.prevClosedHist, r.currentHist, r.histSample)) immediateFlips.push(r);
    else if (r.prevClosedHist < 0) watchCandidates.push(r);
  }
  console.log(`performRootScan: rootTf=${canonicalTf} immediateFlips=${immediateFlips.length} watchCandidates=${watchCandidates.length}`);
  if (immediateFlips.length) {
    const lines = immediateFlips.map((c,i) => `${i+1}. ${c.symbol} prev=${c.prevClosedHist.toFixed(8)} cur=${c.currentHist.toFixed(8)} vol=${c.lastVolume}`);
    await sendNotice('root', `Immediate root flips (${canonicalTf}) count=${immediateFlips.length}`, lines).catch(() => {});
  }
  if (ENABLE_ROOT_POLLING && watchCandidates.length) {
    watchCandidates.sort((a,b) => Math.abs(b.prevClosedHist) - Math.abs(a.prevClosedHist));
    const watchlist = watchCandidates.slice(0, MAX_WATCHLIST);
    console.log(`Watchlist built (${watchlist.length}) for rootTf=${canonicalTf}`);
    const rootSec = tfToSeconds(canonicalTf);
    const flips = (await pollWatchlistForFlips(watchlist, canonicalTf, rootSec)) || [];
    if (flips.length) {
      const lines = flips.map((f,i) => `${i+1}. ${f.symbol} prev=${f.prevClosedHist.toFixed(8)} cur=${f.currentHist.toFixed(8)}`);
      await sendNotice('root', `Polled root flips (${canonicalTf}) count=${flips.length}`, lines).catch(() => {});
    }
    for (const f of flips) immediateFlips.push({ symbol: f.symbol, rootTf: canonicalTf, prevClosedHist: f.prevClosedHist, currentHist: f.currentHist, lastVolume: 0 });
  }
  if (!immediateFlips.length) { lastScanResults[canonicalTf] = []; return []; }
  const rootSec = tfToSeconds(canonicalTf);
  const secsUntilNextRoot = secondsToNextAligned(rootSec);
  const defaultConfirmWait = (secsUntilNextRoot === 0) ? rootSec : secsUntilNextRoot;
  const confirmLimiter = createLimiter(CONFIRM_CONCURRENCY);
  const confirmations = immediateFlips.map(c => confirmLimiter(async () => {
    const res = await confirmCandidateMtf(c.symbol, canonicalTf, defaultConfirmWait);
    if (!res.confirmed) return Object.assign({}, c, { mtfConfirmed:false, confirmDetails: res.details });
    const volChange = await compute24hVolumeChangePercent(c.symbol);
    return Object.assign({}, c, { mtfConfirmed:true, confirmDetails: res.details, volChangePct: volChange, latestHist: c.currentHist, volume: c.lastVolume, lastToFlip: res.lastToFlip });
  }));
  let confirmedCandidates = (await Promise.all(confirmations)).filter(x => x && x.mtfConfirmed);
  for (const c of confirmedCandidates) {
    c.rejectReasons = [];
    c.volOk = Number(c.volChangePct || 0) > 0;
    c.macdOk = Number(c.latestHist || 0) > Number(MACD_THRESHOLD || 0);
    if (!c.volOk) c.rejectReasons.push(`volChangePct=${Number(c.volChangePct||0)}`);
    if (!c.macdOk) c.rejectReasons.push(`latestHist=${Number(c.latestHist||0)} <= MACD_THRESHOLD=${MACD_THRESHOLD}`);
    if (process.env.DEBUG_DETECTION === 'true') console.debug('candidate pre-filter', c.symbol, { volChangePct: c.volChangePct, latestHist: c.latestHist, MACD_THRESHOLD, rejectReasons: c.rejectReasons });
  }
  confirmedCandidates = confirmedCandidates.filter(c => {
    const ok = c.volOk && c.macdOk;
    if (!ok) console.log('REJECT candidate after MTF confirm:', c.symbol, 'reasons=', c.rejectReasons && c.rejectReasons.join('; '));
    return ok;
  });
  // dedupe
  const newCandidates = [];
  for (const c of confirmedCandidates) {
    if (wasSeenRecently(canonicalTf, c.symbol)) {
      if (process.env.DEBUG_DETECTION === 'true') console.debug('dedupe: skipping recently seen', c.symbol, canonicalTf);
      continue;
    }
    newCandidates.push(c);
  }
  lastScanResults[canonicalTf] = confirmedCandidates.slice();
  if (newCandidates.length) {
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
    const lines = newCandidates.map((c,i) => `${i+1}. ${c.symbol} ${c.filterLabel ? '['+c.filterLabel+'] ' : ''}score=${(c.strengthScore||0).toFixed(8)} macd=${(c.latestHist||0).toFixed(8)} vol24%=${(c.volChangePct||0).toFixed(2)} lastToFlip=${c.lastToFlip||''}`);
    await sendNotice('mtf', `MTF confirmed (${canonicalTf}) new count=${newCandidates.length}`, lines).catch(() => {});
    const toOpen = newCandidates.slice(0, MAX_OPEN_TRADES);
    const planLines = [];
    for (const c of toOpen) {
      let suggested = 'N/A';
      try { if (tradeModule && typeof tradeModule.suggestSize === 'function') suggested = await tradeModule.suggestSize(c.symbol, { score: c.strengthScore }); } catch (e) { suggested = 'err'; }
      planLines.push(`${c.symbol} score=${(c.strengthScore||0).toFixed(8)} suggestedSize=${suggested} label=${c.filterLabel||''}`);
    }
    await sendNotice('trade-plan', `Planned opens (max ${MAX_OPEN_TRADES}) for ${canonicalTf}`, planLines).catch(() => {});
    for (const c of toOpen) {
      try {
        if (TRADE_ON_CONFIRM_NOW && tradeModule && typeof tradeModule.openTrade === 'function' && OPEN_TRADES) {
          const result = await tradeModule.openTrade(c.symbol, { rootTf: c.rootTf, score: c.strengthScore, suggestedLabel: c.filterLabel });
          await sendNotice('trade-opened', `Trade opened ${c.symbol}`, [`result: ${JSON.stringify(result)}`, `score=${(c.strengthScore||0).toFixed(8)}`]).catch(() => {});
          if (ENABLE_BREAKEVEN_SIGNAL) {
            const tradeInfo = { tradeId: result && result.tradeId ? result.tradeId : null, symbol: c.symbol, entryPrice: result && result.entryPrice ? result.entryPrice : (c.entryPrice || c.latestPrice || null), side: result && result.side ? result.side : 'long', stopPrice: result && result.stopPrice ? result.stopPrice : null };
            const breakeven = require('./index').breakevenManager; // not strictly necessary; kept for compatibility
            // register if function exists
            if (breakeven && typeof breakeven.registerTrade === 'function') await breakeven.registerTrade(tradeInfo);
          }
        } else {
          await sendNotice('trade-dryrun', `DRY-RUN trade for ${c.symbol}`, [`score=${(c.strengthScore||0).toFixed(8)} label=${c.filterLabel||''}`, `note=TRADE_ON_CONFIRM_NOW=${TRADE_ON_CONFIRM_NOW}`]).catch(() => {});
        }
      } catch (e) { await sendNotice('trade-error', `Trade open failed ${c.symbol}`, [`error: ${e && e.message}`]).catch(() => {}); }
    }
    for (const c of newCandidates) markSeen(canonicalTf, c.symbol);
  } else {
    await sendNotice('mtf', `MTF confirmed (${canonicalTf}) none-new`, ['No new MTF-confirmed signals this cycle or all signals were recently notified']).catch(() => {});
    await sendNotice('trade-plan', `No trades planned (${canonicalTf})`, ['No MTF-confirmed signals this cycle or all signals were recently notified']).catch(() => {});
  }
  return confirmedCandidates;
}

// ---------------- scheduler helpers & start ---------------
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

function startFiveMinScheduler() {
  const intervalSec = 300;
  const delaySec = secondsToNextAligned(intervalSec);
  console.log(`5min Scheduler: will start in ${delaySec}s and run scans for root Tfs: ${AUTO_SCAN_ROOT_TFS.join(',')}`);
  for (const tf of AUTO_SCAN_ROOT_TFS) if (!lastScanResults[tf]) lastScanResults[tf] = [];
  (async () => {
    try {
      console.log('5min Scheduler: performing immediate startup scans for all configured root Tfs');
      for (const tf of AUTO_SCAN_ROOT_TFS) {
        try { await performRootScan(tf, MAX_SCAN_SYMBOLS); } catch (e) { console.warn('5min Scheduler: immediate performRootScan error', tf, e && e.message); }
      }
    } catch (e) { console.warn('5min Scheduler immediate run failed', e && e.message); }
  })().catch(e => console.warn('5min Scheduler immediate run outer catch', e && e.message));
  setTimeout(async function first() {
    try {
      console.log('5min Scheduler: first aligned run — performing root scans for all configured root Tfs');
      for (const tf of AUTO_SCAN_ROOT_TFS) { try { await performRootScan(tf, MAX_SCAN_SYMBOLS); } catch (e) { console.warn('5min Scheduler: performRootScan error', tf, e && e.message); } }
    } catch (e) { console.warn('5min Scheduler initial aligned run failed', e && e.message); }
    setInterval(async () => { try { for (const tf of AUTO_SCAN_ROOT_TFS) { try { await performRootScan(tf, MAX_SCAN_SYMBOLS); } catch (e) { console.warn('5min Scheduler: performRootScan error', tf, e && e.message); } } } catch (e) { console.error('5min Scheduler periodic run error', e && e.message); } }, intervalSec * 1000);
  }, Math.max(0, delaySec) * 1000);
}

startFiveMinScheduler();

if (PUSH_ALL_SIGNALS_ON_STARTUP) {
  (async () => {
    console.log('PUSH_ALL_SIGNALS_ON_STARTUP: running initial scans for', AUTO_SCAN_ROOT_TFS);
    for (const tf of AUTO_SCAN_ROOT_TFS) {
      try { const results = await performRootScan(tf, MAX_SCAN_SYMBOLS); console.log(`PUSH_ALL_SIGNALS_ON_STARTUP: completed ${tf}, confirmed=${results.length}`); } catch (e) { console.warn('PUSH_ALL_SIGNALS_ON_STARTUP: scan failed for', tf, e && e.message); }
      await sleep(500);
    }
  })().catch(e => console.warn('PUSH_ALL_SIGNALS_ON_STARTUP: initial run error', e && e.message));
}

// ---------------- debug endpoints (current_roots uses normalized keys) ---------------
app.get('/debug/env', (req, res) => {
  const envSnapshot = { MACD_THRESHOLD, MACD_EPSILON, MACD_DYNAMIC_EPS_MULT, NEG_ALLOWED_IN_MTF, FILTER_SIGNALS, PUSH_ALL_SIGNALS_ON_STARTUP, TRADE_ON_CONFIRM_NOW, OPEN_TRADES, MAX_OPEN_TRADES, ENABLE_ROOT_POLLING, REST_CONCURRENCY, REST_THROTTLE_MS, MAX_SCAN_SYMBOLS, HIST_LOOKBACK, CONFIRM_CONCURRENCY, POLL_INTERVAL_MS, MAX_WATCHLIST, SCAN_INTERVAL_SECONDS, DEBUG_DETECTION: process.env.DEBUG_DETECTION === 'true', WEBSOCKET_MODE: !!wsClient, SIGNAL_DEDUP_SECONDS, MTF_REQUIRE_ASCENDING };
  res.json({ ok: true, config: envSnapshot });
});

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

app.get('/debug/inspect', async (req, res) => {
  try {
    const symbol = (req.query.symbol || req.body && req.body.symbol || '').toString().trim();
    const rootTf = (req.query.rootTf || req.body && req.body.rootTf || '4h').toString().trim();
    const wait = Math.max(1, Number(req.query.wait || req.body && req.body.wait || 10));
    if (!symbol) return res.status(400).json({ ok:false, error:'symbol required' });
    ensureRuntime();
    const interval = tfToIntervalKey(rootTf);
    const rootHist = await fetchHistPrevAndCur(symbol, interval, 500);
    if (!rootHist) return res.json({ ok:false, error:'no-root-hist', symbol, rootTf });
    const isRootFlip = isNegToPosFlexible(rootHist.prevClosedHist, rootHist.currentHist, rootHist.histSample);
    const mtfs = (MTF_CHECK_MAP[String(rootTf).toLowerCase()] || []).slice();
    const mtfDetails = [];
    for (const mtf of mtfs) {
      try {
        const intKey = tfToIntervalKey(mtf);
        const h = await fetchHistPrevAndCur(symbol, intKey, 200);
        if (!h) { mtfDetails.push({ mtf, ok:false, reason:'no-data' }); continue; }
        const prev = Number(h.prevClosedHist || 0);
        const cur = Number(h.currentHist || 0);
        const flipped = isNegToPosFlexible(prev, cur, h.histSample);
        const rawHist = Array.isArray(h.histSample) ? h.histSample.map(x => Number((x && x.hist) || 0)) : [];
        const eps = dynamicEpsilonFromHist(rawHist);
        const positiveAny = rawHist.some(v => Number(v) > Math.max(1e-8, eps * 0.1));
        const rising1d = (String(mtf).toLowerCase().startsWith('1d') || String(mtf).toLowerCase() === 'd') ? (cur > prev) : false;
        const ascendingOk = MTF_REQUIRE_ASCENDING ? (String(mtf).toLowerCase().startsWith('1d') || String(mtf).toLowerCase() === 'd' ? (rawHist.length >= 2 ? (rawHist[rawHist.length-1] > rawHist[rawHist.length-2]) : true) : isConsecutiveHigher(rawHist, Math.min(3, rawHist.length))) : true;
        mtfDetails.push({ mtf, prev, cur, flipped, positiveAny, rising1d, ascendingOk, sampleLen: (h.histSample && h.histSample.length) || 0 });
      } catch (e) { mtfDetails.push({ mtf, ok:false, reason: e && e.message }); }
    }
    const confirmResult = await confirmCandidateMtf(symbol, rootTf, wait);
    const volChange = await compute24hVolumeChangePercent(symbol);
    const macdOk = Number(rootHist.currentHist || 0) > Number(MACD_THRESHOLD || 0);
    return res.json({ ok:true, symbol, rootTf, rootPrevClosedHist: rootHist.prevClosedHist, rootCurrentHist: rootHist.currentHist, isRootFlip, mtfDetails, confirmResult, volChangePct: volChange, macdOk, env: { MACD_THRESHOLD, NEG_ALLOWED_IN_MTF, HIST_LOOKBACK, FILTER_SIGNALS, WEBSOCKET_MODE: !!wsClient } });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e && e.message });
  }
});

app.get(['/debug/current_roots', '/debug/current_roots/:tf', '/debug/current_roots=:tf'], (req, res) => {
  const tfParam = (req.query.tf || (req.params && req.params.tf) || '').toString().trim();
  if (tfParam) {
    const key = String(tfParam).toLowerCase();
    const r = lastScanResults[key] || [];
    return res.json({ ok:true, tf: key, count: r.length, items: r.slice(0, 200) });
  }
  const all = {};
  for (const k of Object.keys(lastScanResults)) all[k] = lastScanResults[k].slice(0,200);
  return res.json({ ok:true, roots: Object.keys(all), lastScanSamples: all });
});

app.post('/debug/run-scan-root', async (req, res) => {
  const rootTf = (req.query.rootTf || (req.body && req.body.rootTf) || '1h').toString().trim();
  try {
    const v = await performRootScan(rootTf, MAX_SCAN_SYMBOLS);
    res.json({ ok:true, rootTf, signals: v.length, sample: v.slice(0, 30) });
  } catch (e) { res.status(500).json({ ok:false, error: e && e.message }); }
});

app.get('/debug/notifications', (req, res) => {
  const lastN = Number(req.query.n || 50);
  const items = notifications.slice(-Math.min(MAX_NOTIFICATIONS, lastN)).map(n => ({ ts: n.ts, type: n.type, title: n.title, lines: n.lines, result: n.result }));
  res.json({ ok:true, count: items.length, items });
});

app.get('/debug/scan-stats', (req, res) => res.json({ ok:true, config: { REST_CONCURRENCY, REST_THROTTLE_MS, MAX_SCAN_SYMBOLS, SCAN_INTERVAL_SECONDS, FILTER_SIGNALS, ENABLE_ROOT_POLLING, POLL_INTERVAL_MS, MAX_WATCHLIST, MACD_EPSILON, MACD_DYNAMIC_EPS_MULT, CONFIRM_CONCURRENCY, HIST_LOOKBACK, PUSH_ALL_SIGNALS_ON_STARTUP, MACD_THRESHOLD, NEG_ALLOWED_IN_MTF, TRADE_ON_CONFIRM_NOW }, scanStats }));

app.get('/', (req, res) => res.redirect('/health'));
app.get('/health', (req, res) => res.json({ ok:true, uptime: process.uptime() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));
console.log('=== READY ===');
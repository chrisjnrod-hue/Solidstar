// src/index.js — updated to use raw MACD histogram for ranking + vol>0-only opens,
// strict root flip + flexible MTF rules, send-all-on-startup (dry-run), open-on-next-MTF,
// removed unused helpers and normalization logic.

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
let telegramModule = localRequire('telegram') || localRequire('src/telegram') || null;

function initRuntimeModules() {
  bybitModule = bybitModule || localRequire('bybit') || localRequire('src/bybit') || null;
  tradeModule = tradeModule || localRequire('trade') || localRequire('src/trade') || null;
  telegramModule = telegramModule || localRequire('telegram') || localRequire('src/telegram') || null;
}
function ensureRuntime() { try { initRuntimeModules(); } catch (e) { console.warn('initRuntime error', e && e.message); } }

// ---------------- state & config ----------------
const scanStats = { lastRun: {}, lastCount: {}, lastSignals: {} };
let lastScanResults = {}; // keyed by rootTf
const notifications = [];
const MAX_NOTIFICATIONS = 200;

const DEFAULT_MTF_CHECK_MAP = { "1h": ["5m","15m","4h","1d"], "4h": ["5m","15m","1h","1d"], "1d": ["5m","15m","1h","4h"] };
function loadMtfCheckMap() {
  const raw = process.env.MTF_CHECK_MAP;
  if (!raw) return DEFAULT_MTF_CHECK_MAP;
  try {
    const parsed = JSON.parse(raw);
    const out = {};
    for (const k of Object.keys(parsed)) out[String(k).toLowerCase()] = (parsed[k] || []).map(x => String(x).toLowerCase());
    return Object.assign({}, DEFAULT_MTF_CHECK_MAP, out);
  } catch (e) { console.warn('MTF_CHECK_MAP parse failed', e && e.message); return DEFAULT_MTF_CHECK_MAP; }
}
const MTF_CHECK_MAP = loadMtfCheckMap();

const AUTO_SCAN_ROOT_TFS = (process.env.AUTO_SCAN_ROOT_TFS || '1h,4h,1d').split(',').map(s => s.trim()).filter(Boolean);
const POLL_INTERVAL_MS = Math.max(1000, Number(process.env.POLL_INTERVAL_MS || 2000));
const MAX_WATCHLIST = Math.max(1, Number(process.env.MAX_WATCHLIST || 200));
const REST_CONCURRENCY = Math.max(1, Number(process.env.REST_CONCURRENCY || 4));
const REST_THROTTLE_MS = Number(process.env.REST_THROTTLE_MS || process.env.REST_THROTTLE || 25);
const MAX_SCAN_SYMBOLS = Number(process.env.MAX_SCAN_SYMBOLS || 500);

// MACD epsilon controls (still available if you want strict thresholds)
const MACD_EPSILON = Number(process.env.MACD_EPSILON || 0);
const MACD_DYNAMIC_EPS_MULT = Number(process.env.MACD_DYNAMIC_EPS_MULT || 0.05);

// Trade controls
const MAX_OPEN_TRADES = Math.max(1, Number(process.env.MAX_OPEN_TRADES || 3));
const OPEN_TRADES = (process.env.OPEN_TRADES || 'false').toLowerCase() === 'true';

// Poll / confirm
const CONFIRM_CONCURRENCY = Math.max(1, Number(process.env.CONFIRM_CONCURRENCY || 4));
const HIST_LOOKBACK = Math.max(0, Number(process.env.HIST_LOOKBACK || 6));

// Startup push behavior
const PUSH_ALL_SIGNALS_ON_STARTUP = (process.env.PUSH_ALL_SIGNALS_ON_STARTUP || 'false').toLowerCase() === 'true';
// skip openings until initial push completes when PUSH_ALL_SIGNALS_ON_STARTUP=true
let skipOpenUntilStartupComplete = !!PUSH_ALL_SIGNALS_ON_STARTUP;

console.log('CONFIG', { AUTO_SCAN_ROOT_TFS, REST_CONCURRENCY, REST_THROTTLE_MS, MAX_SCAN_SYMBOLS, POLL_INTERVAL_MS, MAX_WATCHLIST, MACD_EPSILON, MACD_DYNAMIC_EPS_MULT, CONFIRM_CONCURRENCY, HIST_LOOKBACK, PUSH_ALL_SIGNALS_ON_STARTUP });

// ---------------- helpers ----------------
function klineTime(k) { return Number(k && (k[0] || k.openTime || k.time || k.timestamp || 0)) || 0; }
function klineClose(k) { return Number(k && (k.close || k[4])) || 0; }
function sortKlinesOldestFirst(klines) { if (!Array.isArray(klines)) return []; return klines.slice().sort((a,b) => klineTime(a) - klineTime(b)); }

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

// Strict flip-on-current-candle test (root requirement)
function isFlipOnCurrent(prev, cur, histSample, opts = {}) {
  const p = Number(prev || 0), c = Number(cur || 0);
  const envEps = (typeof opts.envEpsOverride === 'number' && !isNaN(opts.envEpsOverride)) ? opts.envEpsOverride : MACD_EPSILON;
  if (typeof envEps === 'number' && envEps > 0) return (p < -envEps) && (c > envEps);
  const rawHist = Array.isArray(histSample) ? histSample.map(h => (typeof h === 'object' ? Number(h.hist || 0) : Number(h || 0))) : [];
  const eps = dynamicEpsilonFromHist(rawHist);
  const minDelta = Math.max(1e-8, eps * 0.5);
  if ((p < -eps) && (c > eps)) return true;
  if ((p < 0) && (c > 0) && ((c - p) >= minDelta)) return true;
  return false;
}

// Flexible negative->positive detection (series lookback optional)
function isNegToPosFlexible(prev, cur, histSample, opts = {}) {
  const p = Number(prev || 0), c = Number(cur || 0);
  const envEps = (typeof opts.envEpsOverride === 'number' && !isNaN(opts.envEpsOverride)) ? opts.envEpsOverride : MACD_EPSILON;
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
  if (cond1 || cond2) return true;
  if (HIST_LOOKBACK && HIST_LOOKBACK > 0 && rawHist.length >= 2) {
    const tail = rawHist.slice(- (HIST_LOOKBACK + 1));
    for (let i = 0; i < tail.length - 1; i++) {
      const a = tail[i], b = tail[i+1];
      if (Number(a) < 0 && Number(b) > 0 && (b - a) >= minDelta) return true;
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
    if (a < 0 && b > 0 && ((b - a) >= minDelta)) return true;
  }
  return false;
}

// ---------------- notifications ----------------
async function sendNotice(type, title, lines) {
  const header = `[${type.toUpperCase()}] ${title}`;
  const body = [header, ...lines].join('\n');
  try { notifications.push({ ts: Date.now(), type, title, lines, text: body }); if (notifications.length > MAX_NOTIFICATIONS) notifications.shift(); } catch (e) {}
  ensureRuntime();
  if (!telegramModule) console.log('sendNotice: telegram module not loaded — buffered');
  if (telegramModule) {
    const fn = telegramModule.sendMessage || telegramModule.sendTelegram || telegramModule.send;
    if (typeof fn === 'function') {
      try { await fn(body); return; } catch (e) { console.warn('telegram send failed', e && (e.status || e.respData || e.message || e)); }
    }
  }
  console.log(body);
}

// ---------------- 24h vol change ----------------
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
  } catch (e) { console.warn('compute24hVolumeChangePercent error', symbol, e && e.message); return 0; }
}

// ---------------- fetch hist ----------------
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
  } catch (e) { console.warn('fetchHistPrevAndCur: fetchKlines failed', symbol, e && e.message); return null; }
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
    outSample.push({ ts_ms: ts, ts_s: Math.floor(ts/1000), hist: Number(hist[i] || 0) });
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
  if (!by || typeof by.fetchUsdtPerpetualSymbols !== 'function') { console.warn('fallbackRootScan: by.fetchUsdtPerpetualSymbols missing'); return []; }
  const syms = await by.fetchUsdtPerpetualSymbols();
  if (!Array.isArray(syms) || syms.length === 0) return [];
  const symbols = syms.map(s => (typeof s === 'string' ? s : (s.symbol || s.name || s.code || ''))).filter(Boolean).slice(0, Number(symbolLimit || MAX_SCAN_SYMBOLS));
  console.log('fallbackRootScan: scanning', symbols.length, 'rootTf=', rootTf);
  const limiter = createLimiter(REST_CONCURRENCY);
  const intervalKey = (rootTf === '1h') ? '60' : (rootTf === '4h' ? '240' : (rootTf === '1d' ? 'D' : rootTf));
  const tasks = symbols.map(sym => limiter(async () => {
    try {
      const histObj = await fetchHistPrevAndCur(sym, intervalKey, 500);
      if (!histObj) return null;
      return { symbol: sym, rootTf, prevClosedHist: histObj.prevClosedHist, currentHist: histObj.currentHist, histSample: histObj.histSample, lastVolume: Number(histObj.lastK && (histObj.lastK.volume || histObj.lastK.v || 0) || 0), closes: histObj.closes };
    } catch (e) { console.warn('fallbackRootScan symbol error', sym, e && e.message); return null; }
  }));
  const resolved = await Promise.all(tasks);
  const results = resolved.filter(Boolean);
  const immediateFlips = results.filter(r => {
    if (!r) return false;
    if (isFlipOnCurrent(r.prevClosedHist, r.currentHist, r.histSample)) return true;
    if (HIST_LOOKBACK > 0 && histHasNegToPosCrossing(r.histSample)) return true;
    return false;
  });
  console.log(`fallbackRootScan: scanned=${results.length} immediateFlips=${immediateFlips.length}`);
  return results;
}

// ---------------- confirmCandidateMtf ----------------
async function confirmCandidateMtf(symbol, rootTf, maxWaitSeconds) {
  const mtfs = MTF_CHECK_MAP[String(rootTf).toLowerCase()] || [];
  const startTsMs = Date.now();
  const deadline = startTsMs + (Number(maxWaitSeconds || 0) * 1000);

  async function checkStateForMtf(sym, mtf) {
    try {
      const interval = (mtf === '5m' ? '5' : (mtf === '15m' ? '15' : (mtf === '1h' ? '60' : (mtf === '4h' ? '240' : (mtf === '1d' ? 'D' : mtf)))));
      const h = await fetchHistPrevAndCur(sym, interval, 200);
      if (!h) return { mtf, prev:null, cur:null, lastKTime:0, histSample:[] };
      const prev = Number(h.prevClosedHist || 0), cur = Number(h.currentHist || 0);
      const passPositive = cur > 0;
      const passDailyRising = (String(mtf).toLowerCase().startsWith('1d') || String(mtf).toLowerCase() === 'd') ? (cur > prev) : false;
      const flipCurrent = isFlipOnCurrent(prev, cur, h.histSample);
      return { mtf, prev, cur, lastKTime: klineTime(h.lastK), histSample: h.histSample, passPositive, passDailyRising, flipCurrent };
    } catch (e) { return { mtf, prev:null, cur:null, lastKTime:0, histSample:[] }; }
  }

  // quick immediate check
  try {
    const quick = await Promise.all(mtfs.map(m => checkStateForMtf(symbol, m)));
    const rootStatus = quick.find(q => String(q.mtf).toLowerCase() === String(rootTf).toLowerCase());
    if (!rootStatus || !rootStatus.flipCurrent) return { confirmed:false, details: quick, reason:'root-not-current-flip' };
    const othersOk = quick.every(q => {
      if (String(q.mtf).toLowerCase() === String(rootTf).toLowerCase()) return true;
      if (q.passPositive === true) return true;
      if (q.passDailyRising === true) return true;
      return false;
    });
    if (othersOk) return { confirmed:true, details: quick };
  } catch (e) {}

  const pollIntervalMs = Math.max(1000, Math.min(5000, POLL_INTERVAL_MS || 3000));
  while (Date.now() < deadline) {
    const checks = await Promise.all(mtfs.map(m => checkStateForMtf(symbol, m)));
    const root = checks.find(q => String(q.mtf).toLowerCase() === String(rootTf).toLowerCase());
    if (!root || !root.flipCurrent) return { confirmed:false, details: checks, reason:'root-not-current-flip-on-recheck' };
    const allOk = checks.every(q => {
      if (String(q.mtf).toLowerCase() === String(rootTf).toLowerCase()) return true;
      if (q.passPositive === true) return true;
      if (q.passDailyRising === true) return true;
      if (q.flipCurrent === true) return true;
      return false;
    });
    if (allOk) return { confirmed:true, details: checks };
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  return { confirmed:false, details: [] };
}

// ---------------- pollWatchlistForFlips ----------------
async function pollWatchlistForFlips(watchlist, rootTf, rootWindowSeconds) {
  if (!watchlist || !watchlist.length) return [];
  ensureRuntime();
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
        if (isNegToPosFlexible(histObj.prevClosedHist, histObj.currentHist, histObj.histSample)) return { symbol: sym, prevClosedHist: histObj.prevClosedHist, currentHist: histObj.currentHist };
        return null;
      } catch (e) { return null; }
    }));
    const results = await Promise.all(tasks);
    for (const r of results) {
      if (r) {
        flipped.push(r);
        polledSet.delete(r.symbol);
      }
    }
    if (polledSet.size === 0) break;
    const remaining = Math.max(0, endTs - Date.now());
    if (remaining <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
  return flipped;
}

// ---------------- performRootScan (core) ----------------
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

  if (immediateFlips.length) {
    const lines = immediateFlips.map((c,i) => `${i+1}. ${c.symbol} prev=${c.prevClosedHist.toFixed(8)} cur=${c.currentHist.toFixed(8)} vol=${c.lastVolume}`);
    await sendNotice('root', `Immediate root flips (${rootTf}) count=${immediateFlips.length}`, lines);
  }

  if (ENABLE_ROOT_POLLING && watchCandidates.length) {
    watchCandidates.sort((a,b) => Math.abs(b.prevClosedHist) - Math.abs(a.prevClosedHist));
    const watchlist = watchCandidates.slice(0, MAX_WATCHLIST);
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
  const defaultConfirmWait = Math.max(secsUntilNextRoot === 0 ? rootSec : secsUntilNextRoot, rootSec);

  const confirmLimiter = createLimiter(CONFIRM_CONCURRENCY);
  const confirmations = immediateFlips.map(c => confirmLimiter(async () => {
    const res = await confirmCandidateMtf(c.symbol, rootTf, defaultConfirmWait);
    if (!res.confirmed) return Object.assign({}, c, { mtfConfirmed:false, confirmDetails: res.details });
    const volChange = await compute24hVolumeChangePercent(c.symbol);
    return Object.assign({}, c, { mtfConfirmed:true, confirmDetails: res.details, volChangePct: volChange, latestHist: c.currentHist, volume: c.lastVolume });
  }));

  const confirmedCandidates = (await Promise.all(confirmations)).filter(x => x && x.mtfConfirmed);

  // Use raw latestHist as the ranking metric; ensure numbers
  for (const c of confirmedCandidates) {
    c.latestHist = Number(c.latestHist || 0);
    c.volChangePct = Number(c.volChangePct || 0);
  }

  if (confirmedCandidates.length) {
    const lines = confirmedCandidates.map((c,i) => `${i+1}. ${c.symbol} macd=${(c.latestHist||0).toFixed(8)} vol24%=${(c.volChangePct||0).toFixed(2)}`);
    await sendNotice('mtf', `MTF confirmed (${rootTf}) count=${confirmedCandidates.length}`, lines);
  } else {
    await sendNotice('mtf', `MTF confirmed (${rootTf}) none`, ['No candidates passed MTF within root window']);
  }

  lastScanResults[rootTf] = confirmedCandidates;

  // === Enforce rule: only volChangePct > 0 paired with strongest latestHist are eligible ===
  const eligible = confirmedCandidates
    .filter(c => Number(c.latestHist || 0) > 0 && Number(c.volChangePct || 0) > 0);

  eligible.sort((a,b) => (Number(b.latestHist || 0) - Number(a.latestHist || 0)));

  const excluded = confirmedCandidates.filter(c => !(Number(c.latestHist || 0) > 0 && Number(c.volChangePct || 0) > 0));

  const toOpen = eligible.slice(0, MAX_OPEN_TRADES);

  if (toOpen.length) {
    const planLines = toOpen.map(c => `${c.symbol} macd=${(c.latestHist||0).toFixed(8)} vol24%=${(c.volChangePct||0).toFixed(2)}`);
    await sendNotice('trade-plan', `Planned opens (max ${MAX_OPEN_TRADES})`, planLines);
  } else {
    await sendNotice('trade-plan', `Planned opens (max ${MAX_OPEN_TRADES})`, ['No eligible candidates with positive 24h vol and positive MACD hist']);
  }

  if (excluded.length) {
    const exclLines = excluded.map(c => `${c.symbol} macd=${(c.latestHist||0).toFixed(8)} vol24%=${(c.volChangePct||0).toFixed(2)}`);
    await sendNotice('trade-excluded', `Excluded candidates (${excluded.length})`, exclLines);
  }

  // Opening rules:
  // - If skipOpenUntilStartupComplete is true (we are in initial push), do not open trades; send DRY-RUN notices.
  // - Otherwise perform opens if OPEN_TRADES=true and tradeModule available.
  for (const c of toOpen) {
    try {
      if (skipOpenUntilStartupComplete) {
        await sendNotice('trade-dryrun', `STARTUP DRY-RUN (open skipped) for ${c.symbol}`, [`macd=${(c.latestHist||0).toFixed(8)}`, `vol24%=${(c.volChangePct||0).toFixed(2)}`]);
        continue;
      }
      if (tradeModule && typeof tradeModule.openTrade === 'function' && OPEN_TRADES) {
        const result = await tradeModule.openTrade(c.symbol, { rootTf: rootTf, score: c.latestHist });
        await sendNotice('trade-opened', `Trade opened ${c.symbol}`, [`result: ${JSON.stringify(result)}`, `macd=${(c.latestHist||0).toFixed(8)}`]);
      } else {
        await sendNotice('trade-dryrun', `DRY-RUN trade for ${c.symbol}`, [`macd=${(c.latestHist||0).toFixed(8)}`, `vol24%=${(c.volChangePct||0).toFixed(2)}`]);
      }
    } catch (e) {
      await sendNotice('trade-error', `Trade open failed ${c.symbol}`, [`error: ${e && e.message}`]);
    }
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

// ---------------- auto-scan startup orchestration ----------------
function startAutoScan(rootTf='1h') {
  const intervalSec = tfToSeconds(rootTf);
  const symbolLimit = MAX_SCAN_SYMBOLS;

  // aligned repeated runs
  const delaySec = secondsToNextAligned(intervalSec);
  setTimeout(async function alignedFirst() {
    try { await performRootScan(rootTf, symbolLimit); } catch (e) { console.warn('AUTO SCAN aligned run error', e && e.message); }
    setInterval(async () => {
      try { await performRootScan(rootTf, symbolLimit); } catch (e) { console.error('AUTO SCAN periodic error', e && e.message); }
    }, intervalSec * 1000);
  }, Math.max(0, delaySec) * 1000);
}

// Run startup push (if configured), then start scheduled scans.
// If PUSH_ALL_SIGNALS_ON_STARTUP=true we run an immediate scan cycle for each TF and keep skipOpenUntilStartupComplete=true until done.
// After initial push done we set skipOpenUntilStartupComplete=false so subsequent MTF confirmations may open trades.
(async function bootstrap() {
  try {
    if (PUSH_ALL_SIGNALS_ON_STARTUP) {
      console.log('PUSH_ALL_SIGNALS_ON_STARTUP: performing initial scan pass (dry-run opens)...');
      for (const tf of AUTO_SCAN_ROOT_TFS) {
        try { await performRootScan(tf, MAX_SCAN_SYMBOLS); } catch (e) { console.warn('startup scan failed', tf, e && e.message); }
        await sleep(300);
      }
      console.log('PUSH_ALL_SIGNALS_ON_STARTUP: initial scans complete — now enabling trade opens on subsequent signals');
      skipOpenUntilStartupComplete = false;
    } else {
      skipOpenUntilStartupComplete = false;
      // run a quick initial scan so lastScanResults has data (optional)
      for (const tf of AUTO_SCAN_ROOT_TFS) {
        try { await performRootScan(tf, MAX_SCAN_SYMBOLS); } catch (e) { /* ignore */ }
      }
    }
  } catch (e) {
    console.warn('bootstrap scans failed', e && e.message);
    skipOpenUntilStartupComplete = false;
  } finally {
    // Start the regular auto-scan scheduling after initial push / initial immediate run
    for (const tf of AUTO_SCAN_ROOT_TFS) startAutoScan(tf);
  }
})().catch(e => console.warn('bootstrap error', e && e.message));

// ---------------- debug endpoints ----------------
app.get('/debug/macd', async (req, res) => {
  const symbol = (req.query.symbol || '').toString().trim();
  const tf = (req.query.tf || '1h').toString().trim();
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
    return res.json({ ok:true, symbol, tf, lastK: klines[klines.length-1], closesSample: closes.slice(-40), macdSample: { macd: macd.macd.slice(-40), signal: macd.signal.slice(-40), hist: macd.hist.slice(-40) } });
  } catch (e) { return res.status(500).json({ ok:false, error: e && e.message }); }
});

app.get('/debug/hist', async (req, res) => {
  const symbol = (req.query.symbol || '').toString().trim();
  const tf = (req.query.tf || '1h').toString().trim();
  if (!symbol) return res.status(400).json({ ok:false, error:'symbol required' });
  const key = (tf === '1h') ? '60' : (tf === '4h' ? '240' : (tf === '1d' ? 'D' : tf));
  try {
    const h = await fetchHistPrevAndCur(symbol, key, 500);
    if (!h) return res.json({ ok:false, error:'no-data' });
    return res.json({ ok:true, symbol, tf, prevClosedHist: h.prevClosedHist, currentHist: h.currentHist, lastK: h.lastK, sampleKlinesLen: h.rawKlines.length, histSample: h.histSample });
  } catch (e) { return res.status(500).json({ ok:false, error: e && e.message }); }
});

app.get('/debug/hist-series', async (req, res) => {
  const symbol = (req.query.symbol || '').toString().trim();
  const tf = (req.query.tf || '1h').toString().trim();
  if (!symbol) return res.status(400).json({ ok:false, error:'symbol required' });
  const key = (tf === '1h') ? '60' : (tf === '4h' ? '240' : (tf === '1d' ? 'D' : (tf === '15m' ? '15' : (tf === '5m' ? '5' : tf)))));
  try {
    const h = await fetchHistPrevAndCur(symbol, key, 1000);
    if (!h) return res.json({ ok:false, error:'no-data' });
    return res.json({ ok:true, symbol, tf, prevClosedHist: h.prevClosedHist, currentHist: h.currentHist, histSample: h.histSample, lastK: h.lastK, rawKlinesLen: h.rawKlines.length });
  } catch (e) { return res.status(500).json({ ok:false, error: e && e.message }); }
});

app.get('/debug/compare', async (req, res) => {
  const symbol = (req.query.symbol || '').toString().trim();
  const tf = (req.query.tf || '1h').toString().trim();
  if (!symbol) return res.status(400).json({ ok:false, error:'symbol required' });
  const key = (tf === '1h') ? '60' : (tf === '4h' ? '240' : (tf === '1d' ? 'D' : (tf === '15m' ? '15' : (tf === '5m' ? '5' : tf)))));
  try {
    const h = await fetchHistPrevAndCur(symbol, key, Number(req.query.len || 500));
    if (!h) return res.json({ ok:false, error:'no-data' });
    return res.json({ ok:true, symbol, tf, histSeries: h.histSample.map(p => ({ ts_ms: p.ts_ms, ts_s: p.ts_s, hist: p.hist })) });
  } catch (e) { return res.status(500).json({ ok:false, error: e && e.message }); }
});

app.get(['/debug/current_roots', '/debug/current_roots/:tf', '/debug/current_roots=:tf'], (req, res) => {
  const tf = (req.query.tf || (req.params && req.params.tf) || '').toString().trim();
  if (tf) {
    const r = lastScanResults[tf] || [];
    return res.json({ ok:true, tf, count: r.length, items: r.slice(0,200) });
  }
  const all = {};
  for (const k of Object.keys(lastScanResults)) all[k] = lastScanResults[k].slice(0,200);
  return res.json({ ok:true, roots: Object.keys(all), lastScanSamples: all });
});

app.post('/debug/run-scan-root', async (req, res) => {
  const rootTf = req.query.rootTf || (req.body && req.body.rootTf) || '1h';
  try {
    const v = await performRootScan(rootTf, MAX_SCAN_SYMBOLS);
    res.json({ ok:true, rootTf, signals: v.length, sample: v.slice(0, 30) });
  } catch (e) { res.status(500).json({ ok:false, error: e && e.message }); }
});

app.get('/debug/last-scan', (req, res) => {
  const tf = req.query.tf || '1h';
  const r = lastScanResults[tf] || [];
  res.json({ ok:true, tf, count: r.length, items: r.slice(0, 200) });
});

app.get('/debug/notifications', (req, res) => {
  const lastN = Number(req.query.n || 50);
  const items = notifications.slice(-Math.min(MAX_NOTIFICATIONS, lastN)).map(n => ({ ts: n.ts, type: n.type, title: n.title, lines: n.lines, result: n.result }));
  res.json({ ok:true, count: items.length, items });
});

app.get('/debug/scan-stats', (req, res) => res.json({ ok:true, config: { REST_CONCURRENCY, REST_THROTTLE_MS, MAX_SCAN_SYMBOLS, POLL_INTERVAL_MS, MAX_WATCHLIST, MACD_EPSILON, MACD_DYNAMIC_EPS_MULT, CONFIRM_CONCURRENCY, HIST_LOOKBACK, PUSH_ALL_SIGNALS_ON_STARTUP }, scanStats }));

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
  } catch (e) { return res.status(500).json({ ok:false, error: e && e.message }); }
});

app.get('/health', (req, res) => res.json({ ok:true, uptime: process.uptime() }));
app.get('/', (req, res) => res.redirect('/health'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));
console.log('=== READY ===');

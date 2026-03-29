// src/index.js — added diagnostics: /debug/hist, /debug/notifications, verbose scan logging
// Keep the rest of your existing logic (MTF confirmations, watchlist, breakeven).

console.log('=== STARTUP: index.js loaded ===');

const express = require('express');
const app = express();
app.use(express.json());

const { createLimiter, sleep } = require('./utils'); // utils in src
function localRequire(name) { try { return require('./' + name); } catch (e) { try { return require(name); } catch (e2) { return null; } } }

let bybitModule = localRequire('bybit') || null;
let tradeModule = localRequire('trade') || null;
let telegramModule = localRequire('telegram') || null;

function initRuntimeModules() {
  bybitModule = bybitModule || localRequire('bybit') || localRequire('src/bybit') || null;
  tradeModule = tradeModule || localRequire('trade') || localRequire('src/trade') || null;
  telegramModule = telegramModule || localRequire('telegram') || localRequire('src/telegram') || null;
}
function ensureRuntime() { try { initRuntimeModules(); } catch (e) { console.warn('initRuntime error', e && e.message); } }

// MACD helpers
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
function computeMACD(closes, fast = 12, slow = 26, sig = 9) {
  const emaF = computeEMA(closes, fast);
  const emaS = computeEMA(closes, slow);
  const macd = closes.map((_, i) => (emaF[i] || 0) - (emaS[i] || 0));
  const signal = computeEMA(macd, sig);
  const hist = macd.map((v, i) => v - (signal[i] || 0));
  return { macd, signal, hist };
}

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
const SCAN_INTERVAL_SECONDS = Number(process.env.SCAN_INTERVAL_SECONDS || 300);
const REST_CONCURRENCY = Math.max(1, Number(process.env.REST_CONCURRENCY || 4));
const REST_THROTTLE_MS = Number(process.env.REST_THROTTLE_MS || process.env.REST_THROTTLE || 25);
const MAX_SCAN_SYMBOLS = Number(process.env.MAX_SCAN_SYMBOLS || 500);
const FILTER_SIGNALS = (process.env.FILTER_SIGNALS || 'true').toLowerCase() === 'true';

const MAX_OPEN_TRADES = Math.max(1, Number(process.env.MAX_OPEN_TRADES || 3));
const OPEN_TRADES = (process.env.OPEN_TRADES || 'false').toLowerCase() === 'true';

// Watchlist & polling envs
const ENABLE_ROOT_POLLING = (process.env.ENABLE_ROOT_POLLING || 'true').toLowerCase() === 'true';
const POLL_INTERVAL_MS = Math.max(1000, Number(process.env.POLL_INTERVAL_MS || 10000));
const MAX_WATCHLIST = Math.max(1, Number(process.env.MAX_WATCHLIST || 50));
const MACD_EPSILON = Number(process.env.MACD_EPSILON || 0);

// Breakeven envs (unchanged)
const ENABLE_BREAKEVEN_SIGNAL = (process.env.ENABLE_BREAKEVEN_SIGNAL || 'false').toLowerCase() === 'true';
const BREAKEVEN_TF = process.env.BREAKEVEN_TF || '15m';
const BREAKEVEN_MODE = (process.env.BREAKEVEN_MODE || 'higher_low'); // 'entry' | 'higher_low'
const BREAKEVEN_BUFFER_PCT = Number(process.env.BREAKEVEN_BUFFER_PCT || 0.1); // percent
const BREAKEVEN_CONFIRM_COUNT = Math.max(1, Number(process.env.BREAKEVEN_CONFIRM_COUNT || 1));
const BREAKEVEN_CHECK_AT_CLOSE_ONLY = (process.env.BREAKEVEN_CHECK_AT_CLOSE_ONLY || 'true').toLowerCase() === 'true';
const BREAKEVEN_PERSIST = (process.env.BREAKEVEN_PERSIST || 'false').toLowerCase() === 'true';

console.log('CONFIG', { AUTO_SCAN_ROOT_TFS, REST_CONCURRENCY, REST_THROTTLE_MS, MAX_SCAN_SYMBOLS, ENABLE_ROOT_POLLING, POLL_INTERVAL_MS, MAX_WATCHLIST, MACD_EPSILON });

// scan stats & notifications buffer
const scanStats = { lastRun: {}, lastCount: {}, lastSignals: {} };
let lastScanResults = {}; // keyed by rootTf
const notifications = []; // in-memory circular buffer
const MAX_NOTIFICATIONS = 200;

// ---------------- TF helpers ----------------
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

// ---------------- messaging helper (ensures buffer) ----------------
async function sendNotice(type, title, lines) {
  const header = `[${type.toUpperCase()}] ${title}`;
  const body = [header, ...lines].join('\n');
  // append to in-memory buffer
  try {
    const entry = { ts: Date.now(), type, title, lines, text: body };
    notifications.push(entry);
    if (notifications.length > MAX_NOTIFICATIONS) notifications.shift();
  } catch (e) { /* ignore */ }

  if (telegramModule && typeof telegramModule.sendMessage === 'function') {
    try { await telegramModule.sendMessage(body); return; } catch (e) { console.warn('telegram send failed', e && e.message); }
  }
  // fallback: log to console
  console.log(body);
}

// ---------------- helper: fetch prev+current hist for TF ----------------
async function fetchHistPrevAndCur(symbol, tfIntervalKey, klinesLimit = 100) {
  ensureRuntime();
  const by = bybitModule;
  if (!by || typeof by.fetchKlines !== 'function') return null;
  if (REST_THROTTLE_MS > 0) await sleep(REST_THROTTLE_MS);
  const klines = await by.fetchKlines(symbol, tfIntervalKey, Math.max(3, klinesLimit));
  if (!Array.isArray(klines) || klines.length < 2) return null;
  const closes = klines.map(k => parseFloat(k.close) || 0);
  const macd = computeMACD(closes);
  const hist = macd.hist || [];
  const len = hist.length;
  if (len < 2) return null;
  const prevClosedHist = Number(hist[len - 2] || 0);
  const currentHist = Number(hist[len - 1] || 0);
  return { prevClosedHist, currentHist, lastK: klines[len - 1], rawKlines: klines };
}

// ---------------- fallbackRootScan (now logs samples & negative counts) ----------------
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
      const histObj = await fetchHistPrevAndCur(sym, intervalKey, 200);
      if (!histObj) return null;
      return {
        symbol: sym,
        rootTf,
        prevClosedHist: histObj.prevClosedHist,
        currentHist: histObj.currentHist,
        lastVolume: Number(histObj.lastK && (histObj.lastK.volume || histObj.lastK.v || 0) || 0)
      };
    } catch (e) {
      console.warn('fallbackRootScan symbol error', sym, e && e.message);
      return null;
    }
  }));

  const resolved = await Promise.all(tasks);
  const results = resolved.filter(Boolean);

  // diagnostic summary
  const negatives = results.filter(r => typeof r.prevClosedHist === 'number' && r.prevClosedHist < 0);
  const negativesCount = negatives.length;
  const immediateFlips = results.filter(r => (r.prevClosedHist < 0) && (r.currentHist > MACD_EPSILON));
  const immediateCount = immediateFlips.length;
  console.log(`fallbackRootScan: scanned=${results.length} negatives=${negativesCount} immediateFlips=${immediateCount}`);

  // log a small sample of top negative hist values for debugging (top 8)
  const sample = negatives
    .sort((a,b) => Math.abs(b.prevClosedHist) - Math.abs(a.prevClosedHist))
    .slice(0, 8)
    .map(s => ({ symbol: s.symbol, prev: s.prevClosedHist.toFixed(8), cur: s.currentHist.toFixed(8), vol: s.lastVolume }));
  if (sample.length) console.log('fallbackRootScan: negative sample=', sample);

  return results;
}

// ---------------- per-MTF confirmation (strict flip at open) ----------------
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
    const histObj = await fetchHistPrevAndCur(symbol, interval, 30);
    if (!histObj) return { pass:false, reason:'no-hist' };
    const prev = histObj.prevClosedHist;
    const cur = histObj.currentHist;
    const passes = (prev < 0) && (cur > MACD_EPSILON);
    return { pass: !!passes, mtf, cur, prev };
  } catch (e) {
    console.warn('checkSingleMtfAtOpen error', symbol, mtf, e && e.message);
    return { pass:false, error: e && e.message };
  }
}
async function confirmCandidateMtf(symbol, rootTf, maxWaitSeconds) {
  const mtfs = MTF_CHECK_MAP[String(rootTf).toLowerCase()] || [];
  const startTs = Math.floor(Date.now() / 1000);
  const checkPromises = mtfs.map(mtf => (async () => {
    const elapsed = Math.floor(Date.now() / 1000) - startTs;
    if (elapsed >= maxWaitSeconds) return { pass:false, mtf, reason:'root-boundary' };
    const timeout = Math.max(1, maxWaitSeconds - elapsed);
    const p = checkSingleMtfAtOpen(symbol, mtf);
    const timed = Promise.race([
      p,
      new Promise(resolve => setTimeout(() => resolve({ pass:false, mtf, reason:'timeout' }), timeout * 1000))
    ]);
    const r = await timed;
    return r;
  })());
  const settled = await Promise.all(checkPromises);
  const allPass = settled.every(s => !!s && s.pass);
  return { confirmed: allPass, details: settled };
}

// ---------------- watchlist polling (unchanged logic) ----------------
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
        const histObj = await fetchHistPrevAndCur(sym, intervalKey, 30);
        if (!histObj) return null;
        const { prevClosedHist, currentHist } = histObj;
        if ((prevClosedHist < 0) && (currentHist > MACD_EPSILON)) {
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

// ---------------- breakevenManager (kept same as before) ----------------
// (omitted here for brevity; keep your current breakevenManager implementation above)
// For continuity, ensure breakevenManager exists (same code as earlier).

// ---------------- performRootScan: verbose logging + watchlist polling ----------------
async function performRootScan(rootTf='1h', symbolLimit=MAX_SCAN_SYMBOLS) {
  ensureRuntime();
  const scanResults = await fallbackRootScan(rootTf, symbolLimit);
  scanStats.lastRun[rootTf] = Date.now();
  scanStats.lastCount[rootTf] = symbolLimit;
  scanStats.lastSignals[rootTf] = scanResults.length;

  // diagnostic logs already emitted in fallbackRootScan
  // build immediate flips and watchlist candidates from scanResults
  const immediateFlips = [];
  const watchCandidates = [];
  for (const r of scanResults) {
    if (typeof r.prevClosedHist !== 'number' || typeof r.currentHist !== 'number') continue;
    if ((r.prevClosedHist < 0) && (r.currentHist > MACD_EPSILON)) immediateFlips.push(r);
    else if (r.prevClosedHist < 0) watchCandidates.push(r);
  }

  console.log(`performRootScan: rootTf=${rootTf} immediateFlips=${immediateFlips.length} watchCandidates=${watchCandidates.length}`);

  if (immediateFlips.length) {
    const lines = immediateFlips.map((c,i) => `${i+1}. ${c.symbol} prev=${c.prevClosedHist.toFixed(6)} cur=${c.currentHist.toFixed(6)} vol=${c.lastVolume}`);
    await sendNotice('root', `Immediate root flips (${rootTf}) count=${immediateFlips.length}`, lines);
  }

  // poll watchlist
  let watchlist = [];
  if (ENABLE_ROOT_POLLING && watchCandidates.length) {
    watchCandidates.sort((a,b) => Math.abs(b.prevClosedHist) - Math.abs(a.prevClosedHist));
    watchlist = watchCandidates.slice(0, MAX_WATCHLIST);
    console.log(`Watchlist built (${watchlist.length}) for rootTf=${rootTf}`);
    const rootSec = tfToSeconds(rootTf);
    const flips = (await pollWatchlistForFlips(watchlist, rootTf, rootSec)) || [];
    if (flips.length) {
      const lines = flips.map((f,i) => `${i+1}. ${f.symbol} prev=${f.prevClosedHist.toFixed(6)} cur=${f.currentHist.toFixed(6)}`);
      await sendNotice('root', `Polled root flips (${rootTf}) count=${flips.length}`, lines);
    }
    for (const f of flips) {
      immediateFlips.push({ symbol: f.symbol, rootTf, prevClosedHist: f.prevClosedHist, currentHist: f.currentHist, lastVolume: 0 });
    }
  }

  if (!immediateFlips.length && !watchlist.length) {
    await sendNotice('root', `Root scan (${rootTf}) — no immediate flips`, [`scanned=${scanResults.length}`]);
  }

  if (!immediateFlips.length) { lastScanResults[rootTf] = []; return []; }

  // MTF confirm, trade plan and opens (unchanged from prior implementation)
  const rootSec = tfToSeconds(rootTf);
  const secsUntilNextRoot = secondsToNextAligned(rootSec);
  const maxWait = secsUntilNextRoot === 0 ? rootSec : secsUntilNextRoot;

  const limiter = createLimiter(REST_CONCURRENCY);
  const confirmTasks = immediateFlips.map(c => limiter(async () => {
    const res = await confirmCandidateMtf(c.symbol, rootTf, maxWait);
    if (!res.confirmed) return Object.assign({}, c, { mtfConfirmed:false, confirmDetails: res.details });
    const volChange = await (typeof compute24hVolumeChangePercent === 'function' ? compute24hVolumeChangePercent(c.symbol) : 0);
    return Object.assign({}, c, { mtfConfirmed:true, confirmDetails: res.details, volChangePct: volChange, latestHist: c.currentHist, volume: c.lastVolume });
  }));

  const confirmedCandidates = (await Promise.all(confirmTasks)).filter(x => x && x.mtfConfirmed);

  // strength/labels unchanged (keeps previous behavior)
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
    const lines = confirmedCandidates.map((c,i) => `${i+1}. ${c.symbol} ${c.filterLabel ? '['+c.filterLabel+'] ' : ''}score=${(c.strengthScore||0).toFixed(3)} macd=${(c.latestHist||0).toFixed(6)} vol24%=${(c.volChangePct||0).toFixed(2)}`);
    await sendNotice('mtf', `MTF confirmed (${rootTf}) count=${confirmedCandidates.length}`, lines);
  } else {
    await sendNotice('mtf', `MTF confirmed (${rootTf}) none`, ['No candidates passed MTF within root window']);
  }

  lastScanResults[rootTf] = confirmedCandidates;

  // trade-plan/open logic unchanged; keep sending notices and registering for breakeven
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

// ---------------- scheduler ----------------
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
app.get('/debug/hist', async (req, res) => {
  const symbol = (req.query.symbol || req.body && req.body.symbol || '').toString().trim();
  const tf = (req.query.tf || req.body && req.body.tf || '1h').toString().trim();
  if (!symbol) return res.status(400).json({ ok:false, error:'symbol required' });
  const key = (tf === '1h') ? '60' : (tf === '4h' ? '240' : (tf === '1d' ? 'D' : tf));
  try {
    const h = await fetchHistPrevAndCur(symbol, key, 200);
    if (!h) return res.json({ ok:false, error:'no-data' });
    return res.json({ ok:true, symbol, tf, prevClosedHist: h.prevClosedHist, currentHist: h.currentHist, lastK: h.lastK, sampleKlinesLen: h.rawKlines.length });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e && e.message });
  }
});

app.get('/debug/notifications', (req, res) => {
  const lastN = Number(req.query.n || 50);
  const items = notifications.slice(-Math.min(MAX_NOTIFICATIONS, lastN)).map(n => ({ ts: n.ts, type: n.type, title: n.title, lines: n.lines }));
  res.json({ ok:true, count: items.length, items });
});

app.get('/', (req, res) => res.redirect('/health'));
app.get('/health', (req, res) => res.json({ ok:true, uptime: process.uptime() }));
app.get('/debug/scan-stats', (req, res) => res.json({ ok:true, config: { REST_CONCURRENCY, REST_THROTTLE_MS, MAX_SCAN_SYMBOLS, SCAN_INTERVAL_SECONDS, FILTER_SIGNALS, ENABLE_ROOT_POLLING, POLL_INTERVAL_MS, MAX_WATCHLIST, MACD_EPSILON }, scanStats }));
app.get('/debug/last-scan', (req, res) => {
  const tf = req.query.tf || '1h';
  const r = lastScanResults[tf] || [];
  res.json({ ok:true, tf, count: r.length, items: r.slice(0, 50) });
});
app.post('/debug/run-scan-root', async (req, res) => {
  const rootTf = req.query.rootTf || (req.body && req.body.rootTf) || '1h';
  try {
    const v = await performRootScan(rootTf, MAX_SCAN_SYMBOLS);
    res.json({ ok:true, rootTf, signals: v.length, sample: v.slice(0, 30) });
  } catch (e) {
    res.status(500).json({ ok:false, error: e && e.message });
  }
});

// start express
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));
console.log('=== READY ===');

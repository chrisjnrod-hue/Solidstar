// src/index.js
// Robust entrypoint: resolves local modules safely, schedules aligned scans (1h/4h/1d),
// runs immediate scans on startup (configurable), breakeven runner, pre-close (hh:55) auto-close hook,
// and exposes simple HTTP endpoints for health and metrics.

const fs = require('fs');
const path = require('path');
const express = require('express');
const client = require('prom-client');

// ---- robust local require helpers ----
function fileExistsAny(basePath) {
  if (!basePath) return null;
  const candidates = [basePath, basePath + '.js', basePath + '.cjs', basePath + '.mjs', path.join(basePath, 'index.js')];
  const uniq = [...new Set(candidates)];
  for (const c of uniq) {
    try {
      const resolved = path.isAbsolute(c) ? c : path.resolve(c);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    } catch (e) {}
  }
  return null;
}

function tryRequireLocalSingle(moduleName) {
  const cwd = process.cwd();
  const dirname = __dirname || cwd;
  const relCandidates = [
    path.join(dirname, moduleName),
    path.join(dirname, moduleName + '.js'),
    path.join(dirname, moduleName + '.cjs'),
    path.join(dirname, 'src', moduleName),
    path.join(dirname, 'src', moduleName + '.js'),
    path.join(dirname, '..', moduleName),
    path.join(dirname, '..', 'src', moduleName),
    path.join(cwd, moduleName),
    path.join(cwd, 'src', moduleName),
    path.join(cwd, moduleName + '.js'),
    path.join(cwd, 'src', moduleName + '.js')
  ];
  const tried = [];
  for (const p of relCandidates) {
    tried.push(p);
    const found = fileExistsAny(p);
    if (found) {
      try { return require(found); } catch (e) { throw e; }
    }
  }
  // fallback to node resolution
  tried.push(moduleName);
  try { return require(moduleName); } catch (e) {
    const err = new Error(`tryRequireLocalSingle: module '${moduleName}' not found. Tried paths:\n${tried.join('\n')}\nNode error: ${e && e.message}`);
    err.code = 'MODULE_NOT_FOUND_CUSTOM';
    throw err;
  }
}

function tryRequireLocalMultiple(names) {
  let lastErr = null;
  for (const n of names) {
    try {
      return tryRequireLocalSingle(n);
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

// ---- require core modules with robust loader ----
const cfg = tryRequireLocalSingle('config');

const scannerMod = tryRequireLocalSingle('scanner');
const scanRootTf = scannerMod && scannerMod.scanRootTf;
const handleRootSignal = scannerMod && scannerMod.handleRootSignal;

const bybitMod = tryRequireLocalSingle('bybit');
const BybitWS = (bybitMod && (bybitMod.BybitWS || bybitMod)) || null;

// try both 'tradeManager' names in case of small filename differences
const tradeManagerMod = tryRequireLocalMultiple(['tradeManager', 'tradeManage']);
const atomicBreakeven = (tradeManagerMod && tradeManagerMod.atomicBreakeven) || null;
const closePosition = (tradeManagerMod && tradeManagerMod.closePosition) || null;

const storageMod = tryRequireLocalSingle('storage');
const listOpenTrades = (storageMod && storageMod.listOpenTrades) || (async () => []);
const setKillSwitch = (storageMod && storageMod.setKillSwitch) || (async () => {});
const getKillSwitch = (storageMod && storageMod.getKillSwitch) || (async () => false);

const telegramMod = tryRequireLocalSingle('telegram');
const sendTelegram = (telegramMod && telegramMod.sendTelegram) || (async () => {});

// sanity checks
if (!scanRootTf || !handleRootSignal) {
  console.error('scanner module not loaded correctly. Aborting.');
  process.exit(1);
}
if (!BybitWS) {
  console.error('bybit module not loaded correctly. Aborting.');
  process.exit(1);
}

// ---- app & metrics ----
const app = express();
app.use(express.json());

console.log(`Config: TESTNET=${cfg.TESTNET} MARKET=${cfg.BYBIT_MARKET} BYBIT_WS=${cfg.BYBIT_WS} BYBIT_BASE_API=${cfg.BYBIT_BASE_API}`);

// create WebSocket client
const wsClient = new BybitWS();

let stats = { lastScans: {}, scanned: 0, signals: 0, errors: 0 };

const mScans = new client.Counter({ name: 'scanner_runs_total', help: 'Total scanner runs' });
const mSignals = new client.Counter({ name: 'signals_total', help: 'Signals found' });
const mOpenTrades = new client.Gauge({ name: 'open_trades_gauge', help: 'Open trades count' });
const register = client.register;

// ---- helpers ----
function intervalKeyToApi(intervalKey) {
  const ik = String(intervalKey).toLowerCase();
  if (ik === '1h' || ik === '60' || ik === '60m') return '60';
  if (ik === '4h' || ik === '240') return '240';
  if (ik === '1d' || ik === 'd' || ik === '1440') return 'D';
  return intervalKey;
}

function pctChange(from, to, side) {
  if (!from || !to) return 0;
  const change = (to - from) / from * 100.0;
  return side === 'buy' ? change : -change;
}

async function getCurrentPrice(symbol) {
  try {
    if (bybitMod && typeof bybitMod.fetchTicker === 'function') {
      const t = await bybitMod.fetchTicker(symbol);
      if (t) {
        if (t.lastPrice) return parseFloat(t.lastPrice);
        if (t.last_price) return parseFloat(t.last_price);
        if (t.price) return parseFloat(t.price);
        if (t.last) return parseFloat(t.last);
      }
    }
  } catch (e) {}
  try {
    if (wsClient && typeof wsClient.getPrice === 'function') {
      const p = wsClient.getPrice(symbol);
      if (p) return parseFloat(p);
    }
  } catch (e) {}
  return null;
}

// ---- runner / scheduling ----
async function runnerFor(rootTf, opts = { aligned: false }) {
  try {
    mScans.inc();
    stats.scanned++;
    const signals = await scanRootTf(rootTf);
    stats.lastScans[rootTf] = { when: new Date().toISOString(), count: signals.length };
    mSignals.inc(signals.length);
    stats.signals += signals.length;
    signals.sort((a,b) => b.macdValue - a.macdValue);
    const toProcess = signals.slice(0, Math.max(1, (cfg.MAX_OPEN_TRADES || 1) * 5));
    for (const sig of toProcess) {
      try {
        await handleRootSignal(sig, wsClient, { aligned: !!opts.aligned });
      } catch (e) {
        console.error('handleRootSignal error', e && (e.stack || e.message || e));
      }
    }
  } catch (err) {
    stats.errors++;
    console.error('runner error', err && (err.stack || err.message || err));
  }
}

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

// ---- breakeven runner (hourly) ----
async function breakevenRunner() {
  try {
    const open = await listOpenTrades();
    mOpenTrades.set(open.length);
    const now = new Date();
    for (const t of open) {
      if (t.breakevenActivatedAt) continue;
      const triggerPct = cfg.BREAKEVEN_TRIGGER_PERCENT || cfg.BREAKEVEN_PERCENT || 1.0;
      const alignToHour = cfg.BREAKEVEN_ALIGN_TO_ROUND_HOUR !== false;
      const minSecs = cfg.BREAKEVEN_MIN_SECONDS_AFTER_ENTRY || 0;
      if (minSecs > 0 && t.filledAt) {
        const elapsed = (now - new Date(t.filledAt)) / 1000;
        if (elapsed < minSecs) continue;
      }
      const currentPrice = await getCurrentPrice(t.symbol);
      if (!currentPrice) continue;
      const pnlPct = pctChange(t.entryPrice, currentPrice, t.side);
      if (pnlPct >= triggerPct) {
        const bufferPct = cfg.BREAKEVEN_BUFFER_PCT || 0.0;
        let newSl = t.entryPrice;
        if (bufferPct > 0) {
          if (t.side === 'buy') newSl = t.entryPrice * (1 + bufferPct/100.0);
          else newSl = t.entryPrice * (1 - bufferPct/100.0);
        }
        try {
          if (typeof atomicBreakeven === 'function') await atomicBreakeven(t, newSl);
          try { t.breakevenActivatedAt = new Date().toISOString(); } catch (e) {}
          console.log(`breakeven applied(pnl) ${t.symbol} ${t.id} pnl=${pnlPct.toFixed(3)}% newSL=${newSl}`);
          if (process.env.BREAKEVEN_NOTIFY === 'true') {
            try { await sendTelegram(`bybit: Breakeven applied (pnl) ${t.symbol} ${t.id} pnl=${pnlPct.toFixed(2)}%`); } catch (e) {}
          }
        } catch (e) {
          console.error(`breakeven apply failed for ${t.symbol} ${t.id}`, e && e.message);
        }
        continue;
      }
      if (alignToHour) {
        let scheduled = t.breakevenScheduledAt ? new Date(t.breakevenScheduledAt) : null;
        if (!scheduled) {
          const base = t.filledAt ? new Date(t.filledAt) : new Date();
          const next = new Date(base);
          next.setUTCMinutes(0,0,0);
          next.setUTCHours(next.getUTCHours() + 1);
          scheduled = next;
        }
        if (new Date() >= scheduled) {
          const bufferPct = cfg.BREAKEVEN_BUFFER_PCT || 0.0;
          let newSl = t.entryPrice;
          if (bufferPct > 0) {
            if (t.side === 'buy') newSl = t.entryPrice * (1 + bufferPct/100.0);
            else newSl = t.entryPrice * (1 - bufferPct/100.0);
          }
          try {
            if (typeof atomicBreakeven === 'function') await atomicBreakeven(t, newSl);
            try { t.breakevenActivatedAt = new Date().toISOString(); } catch (e) {}
            console.log(`breakeven applied(scheduled) ${t.symbol} ${t.id} scheduled=${scheduled.toISOString()}`);
            if (process.env.BREAKEVEN_NOTIFY === 'true') {
              try { await sendTelegram(`bybit: Breakeven applied (scheduled) ${t.symbol} ${t.id} scheduled=${scheduled.toISOString()}`); } catch (e) {}
            }
          } catch (e) {
            console.error(`breakeven (scheduled) failed for ${t.symbol} ${t.id}`, e && e.message);
          }
        }
      }
    }
  } catch (e) {
    console.error('breakevenRunner error', e && e.message);
  }
}

// schedule hourly breakeven
(function scheduleBreakevenHourly() {
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setUTCMinutes(0,0,0); nextHour.setUTCHours(nextHour.getUTCHours() + 1);
  const initialWait = nextHour - now;
  setTimeout(() => {
    breakevenRunner().catch(e => console.error('breakeven run error', e && e.message));
    setInterval(() => breakevenRunner().catch(e => console.error('breakeven run error', e && e.message)), 60*60*1000);
  }, initialWait);
})();

// ---- pre-close: close least profitable trade 5 min before hour (hh:55) ----
async function preCloseLeastProfitable() {
  try {
    const maxOpen = Number(cfg.MAX_OPEN_TRADES || 0);
    if (!maxOpen || maxOpen <= 1) return;
    const openTrades = await listOpenTrades();
    if (!Array.isArray(openTrades) || openTrades.length < maxOpen) return;
    const pns = [];
    for (const t of openTrades) {
      const currentPrice = await getCurrentPrice(t.symbol);
      if (!currentPrice) {
        pns.push({ trade: t, pnl: Number.POSITIVE_INFINITY });
        continue;
      }
      const pnlPct = pctChange(t.entryPrice, currentPrice, t.side);
      pns.push({ trade: t, pnl: pnlPct });
    }
    pns.sort((a,b) => a.pnl - b.pnl);
    const candidate = pns[0].trade;
    if (!candidate) return;
    console.log(`preClose: candidate to close: ${candidate.id} ${candidate.symbol} pnl=${pns[0].pnl}`);
    try {
      if (typeof closePosition === 'function') {
        await closePosition(candidate);
        try { await sendTelegram(`bybit: preClose executed: closed ${candidate.symbol} trade ${candidate.id}`); } catch (e) {}
        return;
      } else {
        await sendTelegram(`bybit: preClose candidate (no close API): ${candidate.symbol} trade ${candidate.id} pnl=${pns[0].pnl}`);
        return;
      }
    } catch (e) {
      console.error('preClose: close attempt failed', e && e.message);
      try { await sendTelegram(`bybit: preClose close attempt failed for ${candidate.symbol} ${candidate.id}: ${e && e.message}`); } catch (ex) {}
    }
  } catch (e) {
    console.error('preCloseLeastProfitable error', e && e.message);
  }
}

// schedule preClose at every hour:55
(function schedulePreClose() {
  function next55Delay() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCMinutes(55, 0, 0);
    if (next <= now) next.setUTCHours(next.getUTCHours() + 1);
    return next - now;
  }
  const initial = next55Delay();
  setTimeout(() => {
    preCloseLeastProfitable().catch(e => console.error('preClose run error', e && e.message));
    setInterval(() => preCloseLeastProfitable().catch(e => console.error('preClose run error', e && e.message)), 60*60*1000);
  }, initial);
})();

// ---- schedule aligned scans ----
scheduleAligned('1h', () => runnerFor('1h'));
scheduleAligned('4h', () => runnerFor('4h'));
scheduleAligned('1d', () => runnerFor('1d'));

// ---- immediate scans on startup (only notify if not aligned) ----
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

// ---- HTTP endpoints ----
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

app.post('/kill', async (req, res) => {
  await setKillSwitch(true);
  try { await sendTelegram('bybit: Kill-switch ENABLED: trading disabled'); } catch (e) {}
  res.json({ ok: true, kill: true });
});
app.post('/revive', async (req, res) => {
  await setKillSwitch(false);
  try { await sendTelegram('bybit: Kill-switch DISABLED: trading enabled'); } catch (e) {}
  res.json({ ok: true, kill: false });
});
app.get('/kill', async (req, res) => {
  const k = await getKillSwitch();
  res.json({ kill: !!k });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

const PORT = cfg.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));
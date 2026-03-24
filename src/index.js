// src/index.js
// Robust entrypoint with a file-existence-based loader for local modules.
// Tries multiple candidate filesystem paths and only calls require() on paths that exist,
// avoiding MODULE_NOT_FOUND caused by different working directories (Render's nested src/src).

const fs = require('fs');
const path = require('path');

function fileExistsAny(basePath) {
  if (!basePath) return null;
  const candidates = [];
  // if basePath already looks like an absolute or relative file, preserve it
  candidates.push(basePath);
  // try with common extensions
  candidates.push(basePath + '.js');
  candidates.push(basePath + '.cjs');
  candidates.push(basePath + '.mjs');
  // if basePath is a directory, try index.js
  candidates.push(path.join(basePath, 'index.js'));
  // always ensure uniqueness
  const uniq = [...new Set(candidates)];
  for (const c of uniq) {
    try {
      if (!c) continue;
      const resolved = path.isAbsolute(c) ? c : path.resolve(c);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        return resolved;
      }
    } catch (e) {
      // ignore
    }
  }
  return null;
}

function tryRequireLocal(moduleName) {
  // Build a list of candidate filesystem paths to try, based on common repo layouts.
  // moduleName is a simple name like 'tradeManager' or 'scanner'.
  const cwd = process.cwd();
  const dirname = __dirname || path.resolve('.');
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
    const found = fileExistsAny(p);
    tried.push(p);
    if (found) {
      try {
        // Use require on the resolved existing file
        return require(found);
      } catch (e) {
        // If require fails for other reasons, rethrow
        throw e;
      }
    }
  }
  // As a last resort try Node resolution (package or bare require)
  tried.push(moduleName);
  try {
    return require(moduleName);
  } catch (e) {
    const err = new Error(`tryRequireLocal: module '${moduleName}' not found. Tried paths:\n${tried.join('\n')}\nNode error: ${e && e.message}`);
    err.code = 'MODULE_NOT_FOUND_CUSTOM';
    throw err;
  }
}

// Now require modules using the robust loader
const cfg = tryRequireLocal('config');

const scannerMod = tryRequireLocal('scanner');
const scanRootTf = scannerMod && scannerMod.scanRootTf;
const handleRootSignal = scannerMod && scannerMod.handleRootSignal;

const bybitMod = tryRequireLocal('bybit');
const BybitWS = (bybitMod && (bybitMod.BybitWS || bybitMod)) || null;

const tradeManagerMod = tryRequireLocal('tradeManager');
const atomicBreakeven = (tradeManagerMod && tradeManagerMod.atomicBreakeven) || null;
const closePosition = (tradeManagerMod && tradeManagerMod.closePosition) || null;

const storageMod = tryRequireLocal('storage');
const listOpenTrades = (storageMod && storageMod.listOpenTrades) || (async () => []);
const setKillSwitch = (storageMod && storageMod.setKillSwitch) || (async () => {});
const getKillSwitch = (storageMod && storageMod.getKillSwitch) || (async () => false);

const telegramMod = tryRequireLocal('telegram');
const sendTelegram = (telegramMod && telegramMod.sendTelegram) || (async () => {});

const express = require('express');
const client = require('prom-client');

const app = express();
app.use(express.json());

// sanity check: ensure BybitWS is present
if (!BybitWS) {
  console.error('BybitWS class not found via tryRequireLocal. Aborting startup.');
  throw new Error('BybitWS not available');
}

// Log selected Bybit endpoint choices up-front for easier debugging
try {
  console.log(`Config: TESTNET=${cfg.TESTNET} MARKET=${cfg.BYBIT_MARKET} BYBIT_WS=${cfg.BYBIT_WS} BYBIT_BASE_API=${cfg.BYBIT_BASE_API}`);
} catch (e) {
  console.warn('Config not fully loaded', e && e.message);
}

const wsClient = new BybitWS();

let stats = { lastScans: {}, scanned: 0, signals: 0, errors: 0 };

// Prometheus metrics
const mScans = new client.Counter({ name: 'scanner_runs_total', help: 'Total scanner runs' });
const mSignals = new client.Counter({ name: 'signals_total', help: 'Signals found' });
const mOpenTrades = new client.Gauge({ name: 'open_trades_gauge', help: 'Open trades count' });
const register = client.register;

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

// Helper to get current price
async function getCurrentPrice(symbol) {
  try {
    const bybitLocal = tryRequireLocal('bybit');
    if (bybitLocal && typeof bybitLocal.fetchTicker === 'function') {
      const t = await bybitLocal.fetchTicker(symbol);
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

function pctChange(from, to, side) {
  if (!from || !to) return 0;
  const change = (to - from) / from * 100.0;
  return side === 'buy' ? change : -change;
}

/* breakevenRunner, preClose and scheduling logic are unchanged (kept concise) */

// ... Breakeven logic, preCloseLeastProfitable (calls closePosition if available), schedulePreClose, immediate scans etc.
// For brevity the functions are the same as previously implemented in the repo; ensure they exist in your local file.

scheduleAligned('1h', () => runnerFor('1h'));
scheduleAligned('4h', () => runnerFor('4h'));
scheduleAligned('1d', () => runnerFor('1d'));

// Run immediate scans on startup (unless RUN_IMMEDIATE_SCANS=false)
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

app.get('/', async (req, res) => {
  const open = await listOpenTrades();
  res.json({
    status: 'ok',
    env: { OPEN_TRADES: cfg.OPEN_TRADES, TESTNET: cfg.TESTNET },
    stats,
    openTradesCount: open.length
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

app.listen(cfg.PORT, () => console.log(`App running on port ${cfg.PORT}`));

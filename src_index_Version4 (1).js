/* src/index.js
   Entrypoint: schedules scans, runs immediate scans at startup (optional), exposes health/kill endpoints.
   Contains breakeven runner and scheduleAligned helper.
*/

const express = require('express');
const cfg = require('./config');
const { scanRootTf } = require('./scanner');
const { BybitWS } = require('./bybit');
const { atomicBreakeven } = require('./tradeManager');
const { listOpenTrades, setKillSwitch, getKillSwitch } = require('./storage');
const { sendTelegram } = require('./telegram');
const client = require('prom-client');

const app = express();
app.use(express.json());

// Log selected Bybit endpoint choices up-front for easier debugging
console.log(`Config: TESTNET=${cfg.TESTNET} MARKET=${cfg.BYBIT_MARKET} BYBIT_WS=${cfg.BYBIT_WS} BYBIT_BASE_API=${cfg.BYBIT_BASE_API}`);

// create WebSocket client (connects in constructor)
const wsClient = new BybitWS();

let stats = { lastScans: {}, scanned: 0, signals: 0, errors: 0 };

// Prometheus metrics
const mScans = new client.Counter({ name: 'scanner_runs_total', help: 'Total scanner runs' });
const mSignals = new client.Counter({ name: 'signals_total', help: 'Signals found' });
const mOpenTrades = new client.Gauge({ name: 'open_trades_gauge', help: 'Open trades count' });
const register = client.register;

function scheduleAligned(rootTf, runner) {
  const now = new Date();
  let wait = 0;
  if (rootTf === '1h') {
    const next = new Date(now);
    next.setUTCMinutes(0,0,0);
    next.setUTCHours(next.getUTCHours() + 1);
    wait = next - now;
    const period = 60 * 60 * 1000;
    setTimeout(() => {
      runner();
      setInterval(runner, period);
    }, wait);
  } else if (rootTf === '4h') {
    const next = new Date(now);
    const h = now.getUTCHours();
    const nextH = Math.floor(h / 4) * 4 + 4;
    next.setUTCHours(nextH, 0, 0, 0);
    wait = next - now;
    const period = 4 * 60 * 60 * 1000;
    setTimeout(() => {
      runner();
      setInterval(runner, period);
    }, wait);
  } else if (rootTf === '1d') {
    const next = new Date(now);
    next.setUTCHours(24,0,0,0);
    wait = next - now;
    const period = 24 * 60 * 60 * 1000;
    setTimeout(() => {
      runner();
      setInterval(runner, period);
    }, wait);
  }
}

async function runnerFor(rootTf) {
  try {
    mScans.inc();
    stats.scanned++;
    const signals = await scanRootTf(rootTf);
    stats.lastScans[rootTf] = { when: new Date().toISOString(), count: signals.length };
    mSignals.inc(signals.length);
    stats.signals += signals.length;
    signals.sort((a,b) => b.macdValue - a.macdValue);
    const toProcess = signals.slice(0, Math.max(1, cfg.MAX_OPEN_TRADES * 5));
    for (const sig of toProcess) {
      await require('./scanner').handleRootSignal(sig, wsClient);
    }
  } catch (err) {
    stats.errors++;
    console.error('runner error', err.message || err);
  }
}

// Helper: get current market price for a symbol
async function getCurrentPrice(symbol) {
  try {
    const bybitModule = require('./bybit');
    if (typeof bybitModule.fetchTicker === 'function') {
      const t = await bybitModule.fetchTicker(symbol);
      if (t) {
        if (t.lastPrice) return parseFloat(t.lastPrice);
        if (t.last_price) return parseFloat(t.last_price);
        if (t.price) return parseFloat(t.price);
        if (t.last) return parseFloat(t.last);
      }
    }
  } catch (e) {
    // ignore - fallback to wsClient cache
  }
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

// Breakeven runner: at each hour check open trades and apply breakeven based on trigger percent or schedule
async function breakevenRunner() {
  try {
    const open = await listOpenTrades();
    mOpenTrades.set(open.length);
    const now = new Date();
    for (const t of open) {
      if (t.breakevenActivatedAt) continue;
      const triggerPct = cfg.BREAKEVEN_TRIGGER_PERCENT || 1.0;
      const alignToHour = cfg.BREAKEVEN_ALIGN_TO_ROUND_HOUR !== false;
      const minSecs = cfg.BREAKEVEN_MIN_SECONDS_AFTER_ENTRY || 0;
      if (minSecs > 0 && t.filledAt) {
        const elapsed = (now - new Date(t.filledAt)) / 1000;
        if (elapsed < minSecs) {
          console.debug(`breakeven: skipping ${t.symbol} ${t.id} too soon after entry ${elapsed.toFixed(0)}s<${minSecs}s`);
          continue;
        }
      }

      const currentPrice = await getCurrentPrice(t.symbol);
      if (!currentPrice) {
        console.debug(`breakeven: no current price for ${t.symbol}, skipping this check`);
        continue;
      }

      const pnlPct = pctChange(t.entryPrice, currentPrice, t.side);
      if (pnlPct >= triggerPct) {
        const bufferPct = cfg.BREAKEVEN_BUFFER_PCT || 0.0;
        let newSl = t.entryPrice;
        if (bufferPct > 0) {
          if (t.side === 'buy') newSl = t.entryPrice * (1 + bufferPct/100.0);
          else newSl = t.entryPrice * (1 - bufferPct/100.0);
        }
        try {
          await atomicBreakeven(t, newSl);
          try { t.breakevenActivatedAt = new Date().toISOString(); } catch (e) {}
          console.log(`breakeven applied(pnl) ${t.symbol} ${t.id} pnl=${pnlPct.toFixed(3)}% newSL=${newSl}`);
          if (process.env.BREAKEVEN_NOTIFY === 'true') {
            await sendTelegram(`Breakeven applied (pnl) ${t.symbol} ${t.id} pnl=${pnlPct.toFixed(2)}%`);
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
        if (now >= scheduled) {
          const bufferPct = cfg.BREAKEVEN_BUFFER_PCT || 0.0;
          let newSl = t.entryPrice;
          if (bufferPct > 0) {
            if (t.side === 'buy') newSl = t.entryPrice * (1 + bufferPct/100.0);
            else newSl = t.entryPrice * (1 - bufferPct/100.0);
          }
          try {
            await atomicBreakeven(t, newSl);
            try { t.breakevenActivatedAt = new Date().toISOString(); } catch (e) {}
            console.log(`breakeven applied(scheduled) ${t.symbol} ${t.id} scheduled=${scheduled.toISOString()}`);
            if (process.env.BREAKEVEN_NOTIFY === 'true') {
              await sendTelegram(`Breakeven applied (scheduled) ${t.symbol} ${t.id} scheduled=${scheduled.toISOString()}`);
            }
          } catch (e) {
            console.error(`breakeven (scheduled) failed for ${t.symbol} ${t.id}`, e && e.message);
          }
        } else {
          console.debug(`breakeven scheduled not reached for ${t.symbol} ${t.id}: now=${now.toISOString()} scheduled=${scheduled.toISOString()}`);
        }
      }
    }
  } catch (e) {
    console.error('breakevenRunner error', e && e.message);
  }
}

// scheduleAligned usage
scheduleAligned('1h', () => runnerFor('1h'));
scheduleAligned('4h', () => runnerFor('4h'));
scheduleAligned('1d', () => runnerFor('1d'));

// schedule hourly breakeven alignment: align to next hour and run breakevenRunner every hour
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

// Run an initial scan on startup (once) unless explicitly disabled.
// Controlled by env RUN_IMMEDIATE_SCANS (set to 'false' to disable).
(async function runImmediateScans() {
  const runImmediate = (process.env.RUN_IMMEDIATE_SCANS || 'true').toLowerCase() !== 'false';
  if (!runImmediate) return;
  try {
    console.log('Initial scan: starting immediate root-TF scans (1h, 4h, 1d)');
    await runnerFor('1h');
    await new Promise(r => setTimeout(r, 2000));
    await runnerFor('4h');
    await new Promise(r => setTimeout(r, 2000));
    await runnerFor('1d');
    console.log('Initial scan: completed immediate runs.');
  } catch (e) {
    console.error('Initial scan error', e && e.message);
  }
})();

// HTTP endpoints & rest
app.get('/', async (req, res) => {
  const open = await listOpenTrades();
  res.json({
    status: 'ok',
    env: { OPEN_TRADES: cfg.OPEN_TRADES, TESTNET: cfg.TESTNET },
    stats,
    openTradesCount: open.length
  });
});

// New health endpoint
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
  await sendTelegram('Kill-switch ENABLED: trading disabled');
  res.json({ ok: true, kill: true });
});
app.post('/revive', async (req, res) => {
  await setKillSwitch(false);
  await sendTelegram('Kill-switch DISABLED: trading enabled');
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
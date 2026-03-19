/* Entrypoint:
   - schedules 1h/4h/1d scans as before (aligned)
   - adds endpoints:
       GET /           health + open trades
       POST /kill      enable kill-switch (disable OPEN_TRADES at runtime)
       POST /revive    disable kill-switch
       GET /metrics    Prometheus metrics
   - runs breakeven scan at next hour and every hour thereafter
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

const wsClient = new BybitWS();
let stats = { lastScans: {}, scanned: 0, signals: 0, errors: 0 };

// Prometheus metrics
const mScans = new client.Counter({ name: 'scanner_runs_total', help: 'Total scanner runs' });
const mSignals = new client.Counter({ name: 'signals_total', help: 'Signals found' });
const mOpenTrades = new client.Gauge({ name: 'open_trades_gauge', help: 'Open trades count' });
const register = client.register;

// schedule helpers
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

// Breakeven runner: at each hour check open trades and call atomicBreakeven when scheduled
async function breakevenRunner() {
  try {
    const open = await listOpenTrades();
    mOpenTrades.set(open.length);
    const now = new Date();
    for (const t of open) {
      if (t.breakevenScheduledAt) {
        const scheduled = new Date(t.breakevenScheduledAt);
        if (scheduled <= now && !t.breakevenActivatedAt) {
          // compute new SL
          const bePct = cfg.BREAKEVEN_PERCENT / 100.0;
          let newSl = null;
          if (t.side.toLowerCase() === 'buy') newSl = t.entryPrice * (1 + bePct);
          else newSl = t.entryPrice * (1 - bePct);
          try {
            await atomicBreakeven(t, newSl);
          } catch (e) {
            console.error('breakeven apply error', e.message);
            await sendTelegram(`Breakeven apply failed for ${t.symbol} ${t.id}: ${e.message}`);
          }
        }
      }
    }
  } catch (e) {
    console.error('breakeven runner error', e.message);
  }
}

async function start() {
  scheduleAligned('1h', () => runnerFor('1h'));
  scheduleAligned('4h', () => runnerFor('4h'));
  scheduleAligned('1d', () => runnerFor('1d'));

  // schedule hourly breakeven: align to next hour then setInterval
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setUTCMinutes(0,0,0); nextHour.setUTCHours(nextHour.getUTCHours() + 1);
  const initialWait = nextHour - now;
  setTimeout(() => {
    breakevenRunner().catch(e => console.error('breakeven run error', e.message));
    setInterval(() => breakevenRunner().catch(e => console.error('breakeven run error', e.message)), 60*60*1000);
  }, initialWait);

  // HTTP endpoints
  app.get('/', async (req, res) => {
    const open = await listOpenTrades();
    res.json({
      status: 'ok',
      env: { OPEN_TRADES: cfg.OPEN_TRADES, TESTNET: cfg.TESTNET },
      stats,
      openTradesCount: open.length
    });
  });

  // kill-switch: set persistent kill-switch to disable trading; does NOT stop scans
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

  // metrics for Prometheus
  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  app.listen(cfg.PORT, () => console.log(`App running on port ${cfg.PORT}`));
}

start().catch(err => {
  console.error('Fatal start error', err);
  process.exit(1);
});
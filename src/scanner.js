// Scanner unchanged in logic; uses new bybit functions and tradeManager.openPosition

const cfg = require('./config');
const { fetchUsdtPerpetualSymbols, fetchKlines, BybitWS } = require('./bybit');
const { macdHistogram } = require('./macd');
const { sendTelegram } = require('./telegram');
const { openPosition } = require('./tradeManager');

const tfIntervals = {
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1d': 'D'
};

function lastTwoHist(closes) {
  const hist = macdHistogram(closes);
  if (!hist) return null;
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i] !== null) {
      let j = i - 1;
      while (j >= 0 && hist[j] === null) j--;
      if (j < 0) return null;
      return { prev: hist[j], cur: hist[i] };
    }
  }
  return null;
}

async function checkRootForSymbol(symbol, rootTf) {
  try {
    const interval = tfIntervals[rootTf];
    const klines = await fetchKlines(symbol, interval, 200);
    if (!klines || klines.length < 40) return null;
    const closes = klines.map(k => k.close);
    const two = lastTwoHist(closes);
    if (!two) return null;
    if (two.prev < 0 && two.cur > 0) {
      return { symbol, rootTf, timestamp: klines[klines.length - 1].t, macdValue: two.cur };
    }
  } catch (e) {
    console.warn('checkRootForSymbol error', symbol, e.message);
  }
  return null;
}

async function checkMtfPositive(symbol, tfs) {
  const out = {};
  for (const tf of tfs) {
    const interval = tfIntervals[tf];
    try {
      const klines = await fetchKlines(symbol, interval, 200);
      if (!klines || klines.length < 40) { out[tf] = false; continue; }
      const closes = klines.map(k => k.close);
      const hist = macdHistogram(closes);
      if (!hist) { out[tf] = false; continue; }
      let last = null;
      for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i] !== null) { last = hist[i]; break; }
      }
      out[tf] = (last > 0);
    } catch (e) {
      out[tf] = false;
    }
  }
  return out;
}

async function scanRootTf(rootTf) {
  console.log('Scan start for root', rootTf);
  const symbols = await fetchUsdtPerpetualSymbols();
  const rootSignals = [];
  const concurrency = Math.max(4, cfg.REST_CONCURRENCY);
  for (let i = 0; i < symbols.length; i += concurrency) {
    const slice = symbols.slice(i, i + concurrency);
    await Promise.all(slice.map(async (s) => {
      const res = await checkRootForSymbol(s, rootTf);
      if (res) rootSignals.push(res);
    }));
  }
  console.log(`Scan complete for ${rootTf}. Signals found: ${rootSignals.length}`);
  return rootSignals;
}

function computeRootExpiryMs(rootTf) {
  const now = new Date();
  if (rootTf === '1h') {
    const next = new Date(now);
    next.setUTCMinutes(0,0,0); next.setUTCHours(next.getUTCHours() + 1);
    return next - now;
  } else if (rootTf === '4h') {
    const next = new Date(now);
    const h = now.getUTCHours();
    const nextH = Math.floor(h / 4) * 4 + 4;
    next.setUTCHours(nextH, 0, 0, 0);
    return next - now;
  } else if (rootTf === '1d') {
    const next = new Date(now);
    next.setUTCHours(24,0,0,0);
    return next - now;
  }
  return 60*60*1000;
}

async function handleRootSignal(signal, wsClient) {
  const { symbol, rootTf } = signal;
  const subscribeSet = (() => {
    if (rootTf === '1h') return ['5m', '15m', '4h', '1d'];
    if (rootTf === '4h') return ['5m', '15m', '1h', '1d'];
    if (rootTf === '1d') return ['5m', '15m', '1h', '4h'];
    return ['5m','15m','1h','4h','1d'];
  })();
  const mtf = await checkMtfPositive(symbol, subscribeSet);
  const allPositive = subscribeSet.every(tf => mtf[tf]);
  if (allPositive) {
    await notifyAndTrade(symbol, rootTf, mtf, signal.macdValue);
    return;
  }
  const negativeTfs = subscribeSet.filter(tf => !mtf[tf]);
  if (negativeTfs.length === 0) {
    await notifyAndTrade(symbol, rootTf, mtf, signal.macdValue);
    return;
  }
  negativeTfs.sort((a,b) => {
    const order = { '5m':5,'15m':15,'1h':60,'4h':240,'1d':1440 };
    return order[a] - order[b];
  });
  const waitTf = negativeTfs[0];
  const interval = tfIntervals[waitTf];
  console.log(`Root ${symbol} ${rootTf}: waiting on ${waitTf} to turn positive`);
  let unsub = null;
  const expireMs = computeRootExpiryMs(rootTf);
  return new Promise((resolve) => {
    const cb = async (msg) => {
      try {
        const mtfNew = await checkMtfPositive(symbol, subscribeSet);
        const nowAllPositive = subscribeSet.every(tf => mtfNew[tf]);
        if (nowAllPositive) {
          if (unsub) unsub();
          await notifyAndTrade(symbol, rootTf, mtfNew, signal.macdValue);
          resolve(true);
        } else if (mtfNew[waitTf]) {
          const othersPositive = subscribeSet.filter(t => t !== waitTf).every(t => mtfNew[t]);
          if (othersPositive) {
            if (unsub) unsub();
            await notifyAndTrade(symbol, rootTf, mtfNew, signal.macdValue);
            resolve(true);
          }
        }
      } catch (e) {
        console.error('ws cb error', e.message);
      }
    };
    unsub = wsClient.subscribeKline(symbol, interval, cb);
    setTimeout(() => {
      try { if (unsub) unsub(); } catch {}
      resolve(false);
    }, expireMs + 5000);
  });
}

async function notifyAndTrade(symbol, rootTf, mtf, rootMacdValue) {
  const message = `Signal *${symbol}* root=${rootTf}\nmtf=${JSON.stringify(mtf)}\nmacd=${rootMacdValue.toFixed(6)}\nTP=${cfg.TP_PERCENT}% SL=${cfg.SL_PERCENT}%`;
  console.log('Signal:', message);
  await sendTelegram(message);

  // approximate latest price via 1m/5m candle
  const klines = await fetchKlines(symbol, tfIntervals['5m'], 1);
  const lastPrice = klines && klines.length ? klines[klines.length - 1].close : null;
  const side = 'Buy'; // same as before to keep behavior identical
  await openPosition({ symbol, side, entryPrice: lastPrice, rootTf, rootMacd: rootMacdValue });
}

module.exports = {
  scanRootTf,
  handleRootSignal
};

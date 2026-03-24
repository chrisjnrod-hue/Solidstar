// src/scanner.js
// Scanner with publishSignals helper: logs and optionally Telegram-pushes all evaluated symbols/signals.
// Exports: scanRootTf, handleRootSignal, publishSignals

const cfg = require('./config');
const bybit = require('./bybit');
const axios = require('axios');
const { passesFilters } = require('./filters');
const { sendTelegram } = require('./telegram');

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
function computeMACD(closeSeries, fast = 12, slow = 26, signal = 9) {
  if (!Array.isArray(closeSeries) || closeSeries.length === 0) return { macdLine: [], signalLine: [], hist: [] };
  const emaFast = computeEMA(closeSeries, fast);
  const emaSlow = computeEMA(closeSeries, slow);
  const macdLine = closeSeries.map((_, i) => (emaFast[i] || 0) - (emaSlow[i] || 0));
  const signalLine = computeEMA(macdLine, signal);
  const hist = macdLine.map((v, i) => v - (signalLine[i] || 0));
  return { macdLine, signalLine, hist };
}

function intervalKeyToApi(intervalKey) {
  const ik = String(intervalKey).toLowerCase();
  if (ik === '1h' || ik === '60' || ik === '60m') return '60';
  if (ik === '4h' || ik === '240') return '240';
  if (ik === '1d' || ik === 'd' || ik === '1440') return 'D';
  return intervalKey;
}

function higherTfFor(rootKey) {
  const k = String(rootKey).toLowerCase();
  if (k === '1h' || k === '60') return '240';
  if (k === '4h' || k === '240') return 'D';
  if (k === 'd' || k === '1d' || k === '1440') return 'W';
  return null;
}

async function fetchSymbolsFallback() {
  try {
    if (bybit && typeof bybit.fetchUsdtPerpetualSymbols === 'function') {
      const s = await bybit.fetchUsdtPerpetualSymbols();
      if (Array.isArray(s) && s.length) return s;
    }
  } catch (e) {
    console.warn('fetchSymbolsFallback: bybit.fetchUsdtPerpetualSymbols failed', e && e.message);
  }

  try {
    const base = cfg.BYBIT_BASE_API || 'https://api-testnet.bybit.com';
    const category = (cfg.BYBIT_MARKET === 'spot') ? 'spot' : 'linear';
    const url = `${base.replace(/\/$/, '')}/v5/market/instruments-info?category=${category}`;
    if (process.env.DEBUG_FILTERS === 'true') console.debug('fetchSymbolsFallback: trying v5 instruments:', url);
    const res = await axios.get(url, { timeout: 10000 });
    const data = res && res.data;
    if (data) {
      const resultList = (data.result && data.result.list) ? data.result.list : (data.result || []);
      if (Array.isArray(resultList) && resultList.length) {
        const symbols = [];
        for (const it of resultList) {
          const sym = it.symbol || it.name;
          const quote = (it.quoteCoin || it.quote_coin || it.quote || it.quoteAsset || it.quote_asset);
          const status = (it.status || it.state || '').toString().toLowerCase();
          if (!sym) continue;
          if (quote && String(quote).toUpperCase() === 'USDT' && (status === '' || status === 'tradable' || status === 'listed' || status === 'online' || status === 'normal')) {
            symbols.push(sym);
          }
        }
        if (symbols.length) return symbols;
        const raw = resultList.map(r => r.symbol || r.name).filter(Boolean);
        if (raw.length) return raw;
      }
    }
  } catch (e) {
    console.warn('fetchSymbolsFallback: v5 instruments-info failed', e && (e.response ? `${e.message} status=${e.response.status}` : e.message));
  }

  try {
    const base = cfg.BYBIT_BASE_API || 'https://api-testnet.bybit.com';
    const url = `${base.replace(/\/$/, '')}/v2/public/symbols`;
    if (process.env.DEBUG_FILTERS === 'true') console.debug('fetchSymbolsFallback: trying legacy v2 symbols:', url);
    const res = await axios.get(url, { timeout: 8000 });
    const data = res && res.data;
    if (!data) return [];
    const result = data.result || data;
    if (Array.isArray(result) && result.length) {
      const symbols = [];
      for (const it of result) {
        const sym = it.name || it.symbol || it.pair || it.code;
        const quote = it.quote_currency || it.quoteCurrency || it.quote || it.quoteAsset || it.quote_asset;
        const status = (it.status || it.state || '').toString().toLowerCase();
        if (!sym) continue;
        if (quote && String(quote).toUpperCase() === 'USDT' && (status === '' || status === 'trading' || status === 'listed' || status === 'active' || status === 'online')) {
          symbols.push(sym);
        }
      }
      if (symbols.length) return symbols;
      return result.map(r => r.name || r.symbol).filter(Boolean);
    }
  } catch (e) {
    console.error('fetchSymbolsFallback: legacy v2 call failed', e && e.message);
  }

  return [];
}

async function scanRootTf(rootTf) {
  const intervalApi = intervalKeyToApi(rootTf);
  const higherTf = higherTfFor(rootTf);

  let symbols = [];
  try {
    symbols = await fetchSymbolsFallback();
  } catch (e) {
    console.error('scanRootTf: fetchSymbols failed', e && e.message);
    symbols = [];
  }

  if (!Array.isArray(symbols) || symbols.length === 0) {
    console.warn('scanRootTf: no symbols fetched');
    return [];
  }

  try { console.log(`scanRootTf: fetched ${symbols.length} symbols. First 10: ${symbols.slice(0, 10).join(', ')}`); } catch (e) {}

  if (cfg.MAX_SCAN_SYMBOLS && Number.isInteger(cfg.MAX_SCAN_SYMBOLS) && cfg.MAX_SCAN_SYMBOLS > 0) {
    symbols = symbols.slice(0, cfg.MAX_SCAN_SYMBOLS);
  }

  const concurrency = Math.max(1, parseInt(process.env.REST_CONCURRENCY || '8', 10));
  const signals = [];

  // limited concurrency map
  const mapWithConcurrency = async (arr, concurrency, fn) => {
    const results = [];
    const executing = new Set();
    let i = 0;
    const enqueue = async () => {
      if (i >= arr.length) return;
      const idx = i++;
      const p = Promise.resolve().then(() => fn(arr[idx], idx));
      results[idx] = p;
      executing.add(p);
      const done = () => executing.delete(p);
      p.then(done, done);
      if (executing.size >= concurrency) await Promise.race(executing);
      return enqueue();
    };
    await enqueue();
    return Promise.all(results);
  };

  await mapWithConcurrency(symbols, concurrency, async (symbol) => {
    try {
      const limit = 200;
      const klines = await bybit.fetchKlines(symbol, intervalApi, limit).catch(e => null);
      if (!klines || klines.length < 30) {
        // log small sample if debugging
        if (process.env.DEBUG_FILTERS === 'true') console.debug(`scanRootTf: insufficient klines for ${symbol} ${intervalApi}`);
        return;
      }
      const closes = klines.map(k => parseFloat(k.close));
      const { hist } = computeMACD(closes, 12, 26, 9);
      if (!hist || hist.length === 0) return;
      const latestHist = hist[hist.length - 1];
      const histHistory = hist.slice(0, Math.max(0, hist.length - 1));

      // compute higher tf hist if configured
      let higherTfHist = null;
      if ((process.env.FILTER_MTF || 'true') === 'true' && higherTf) {
        try {
          const higherApi = intervalKeyToApi(higherTf);
          const klHigh = await bybit.fetchKlines(symbol, higherApi, 200).catch(e => null);
          if (klHigh && klHigh.length >= 30) {
            const closesHigh = klHigh.map(k => parseFloat(k.close));
            const macHigh = computeMACD(closesHigh, 12, 26, 9);
            const histHigh = macHigh.hist || [];
            higherTfHist = histHigh.length ? histHigh[histHigh.length - 1] : null;
          }
        } catch (e) {
          higherTfHist = null;
        }
      }

      // fetch daily hist for MTF acceptance on 1h & 4h
      let dailyHist = null;
      let prevDailyHist = null;
      if ((rootTf === '1h' || rootTf === '4h') && ((process.env.FILTER_MTF || 'true') === 'true')) {
        try {
          const klDaily = await bybit.fetchKlines(symbol, 'D', 5).catch(e => null);
          if (klDaily && klDaily.length >= 2) {
            const closesD = klDaily.map(k => parseFloat(k.close));
            const macdD = computeMACD(closesD, 12, 26, 9);
            const histD = macdD.hist || [];
            if (histD.length >= 2) {
              dailyHist = histD[histD.length - 1];
              prevDailyHist = histD[histD.length - 2];
            }
          }
        } catch (e) {
          dailyHist = null;
          prevDailyHist = null;
        }
      }

      // run filter evaluation
      let filterResult;
      try {
        filterResult = passesFilters(symbol, rootTf, klines, latestHist, histHistory, higherTfHist);
      } catch (e) {
        filterResult = { pass: false, reasons: ['filter_eval_error:' + (e && e.message)] };
      }

      // Apply MTF acceptance modification for 1h/4h
      if ((rootTf === '1h' || rootTf === '4h') && (process.env.FILTER_MTF || 'true') === 'true') {
        if (dailyHist !== null && dailyHist !== undefined) {
          let mtfOk = false;
          if (Number(dailyHist) > 0) mtfOk = true;
          else if (prevDailyHist !== null && Number(dailyHist) > Number(prevDailyHist)) mtfOk = true;
          if (!mtfOk) {
            filterResult.pass = false;
            filterResult.reasons = (filterResult.reasons || []).concat([`mtf_daily_fail:daily=${dailyHist}${prevDailyHist!==null?` prev=${prevDailyHist}`:''}`]);
          } else {
            filterResult.reasons = (filterResult.reasons || []).concat([`mtf_daily_ok:${dailyHist}${prevDailyHist!==null?` prev=${prevDailyHist}`:''}`]);
          }
        }
      }

      const signal = {
        symbol,
        interval: rootTf,
        macdValue: latestHist,
        klines,
        histHistory,
        higherTfHist,
        dailyHist,
        prevDailyHist,
        filter: filterResult
      };
      signals.push(signal);
    } catch (err) {
      if (process.env.DEBUG_FILTERS === 'true') console.error('scanRootTf symbol error', err && err.message, 'symbol:', symbol);
    }
  });

  // sort strongest hist magnitude first
  signals.sort((a, b) => Math.abs(b.macdValue) - Math.abs(a.macdValue));
  return signals;
}

/**
 * publishSignals(signals, opts)
 * - opts:
 *    - telegramOnly (boolean) — if true, only send telegram (if configured)
 *    - limit (number) — max signals to push
 *    - prefix (string) — prefix to include in each message
 * Behavior:
 * - For each signal prints a detailed line to console and optionally sends Telegram containing:
 *    bybit: SYMBOL INTERVAL PASS/FAIL reasons=[...]
 */
async function publishSignals(signals, opts = {}) {
  const notifyRoot = (process.env.NOTIFY_ON_ROOT_SIGNALS || 'false') === 'true';
  const pushAllStartup = (process.env.PUSH_ALL_SIGNALS_ON_STARTUP || 'false') === 'true';
  const telegramSymbolsOnly = (process.env.TELEGRAM_PUSH_SYMBOLS_ONLY || 'true') === 'true';
  const limit = Number(opts.limit || process.env.NOTIFY_ROOT_SIGNALS_LIMIT || 50);

  let toPush = signals;
  if (!pushAllStartup && !notifyRoot) {
    // neither configured to push all nor notify; only log to console
    for (const s of toPush.slice(0, limit)) {
      console.log(`bybit: ${s.symbol} ${s.interval} ${s.filter && s.filter.pass ? 'PASS' : 'FAIL'} reasons=${(s.filter && s.filter.reasons || []).slice(0,5).join('|')}`);
    }
    return;
  }

  // if notifyRoot true OR pushAllStartup true, send messages (subject to limit)
  let count = 0;
  for (const s of toPush) {
    if (count >= limit) break;
    const pass = s.filter && s.filter.pass;
    const reasons = (s.filter && s.filter.reasons) ? s.filter.reasons : [];
    const msg = `bybit: ${s.symbol} ${s.interval} ${pass ? 'PASS' : 'FAIL'} reasons=${reasons.slice(0,5).join('|')} macd=${Number(s.macdValue).toFixed(6)}`;
    // console always
    console.log(msg);
    // telegram if configured and notification allowed
    if (notifyRoot || pushAllStartup) {
      try {
        // obey telegramSymbolsOnly if true (we only send this symbol-level message)
        if (telegramSymbolsOnly) {
          await sendTelegram(msg);
        } else {
          await sendTelegram(msg);
        }
      } catch (e) {
        console.warn('publishSignals: sendTelegram failed', e && e.message);
      }
    }
    count++;
  }
  if (count === 0) console.log('publishSignals: no signals pushed due to limit or config.');
}

async function handleRootSignal(signal, wsClient, opts = { aligned: false }) {
  // This function preserves the existing trade-opening gating logic while also returning useful info.
  const notifyRoot = (process.env.NOTIFY_ON_ROOT_SIGNALS || 'false') === 'true';

  // Always console log symbol-level info
  try {
    console.log(`handleRootSignal: ${signal.symbol} ${signal.interval} macd=${Number(signal.macdValue).toFixed(6)} pass=${signal.filter && signal.filter.pass} reasons=${(signal.filter && signal.filter.reasons || []).slice(0,5).join('|')}`);
  } catch (e) {}

  // If filter failed, do not open trades
  const passed = signal.filter && signal.filter.pass;
  if (!passed) return { opened: false, reason: 'filter_failed', reasons: signal.filter && signal.filter.reasons };

  // If not aligned we only notify (no trade open)
  if (!opts.aligned) {
    return { opened: false, reason: 'not_aligned_only_notify' };
  }

  // If trades disabled
  if ((process.env.OPEN_TRADES || 'false') !== 'true') {
    return { opened: false, reason: 'open_trades_disabled' };
  }

  // Attempt to open trade via tradeManager if available
  try {
    const tm = require('./tradeManager');
    if (tm && typeof tm.openPosition === 'function') {
      const result = await tm.openPosition(signal);
      if (process.env.NOTIFY_ON_TRADE_OPEN === 'true') {
        try { await sendTelegram(`bybit: Trade opened: ${signal.symbol} ${signal.interval} result=${JSON.stringify(result).slice(0,200)}`); } catch (e) {}
      }
      return { opened: true, result };
    } else {
      return { opened: false, reason: 'no_trade_open_impl' };
    }
  } catch (e) {
    console.warn('handleRootSignal trade open error', e && e.message);
    return { opened: false, reason: 'trade_open_error', error: e && e.message };
  }
}

module.exports = {
  scanRootTf,
  handleRootSignal,
  publishSignals
};
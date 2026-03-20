/**
 * src/scanner.js
 *
 * Updated REST fallback:
 *  - First try v5 /market/instruments-info?category={spot|linear}
 *  - If no symbols returned, fall back to /v2/public/symbols for compatibility
 *
 * Other scanner logic unchanged.
 */

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
async function mapWithConcurrency(arr, concurrency, fn) {
  const results = [];
  const executing = new Set();
  let i = 0;
  async function enqueue() {
    if (i >= arr.length) return;
    const idx = i++;
    const p = Promise.resolve().then(() => fn(arr[idx], idx));
    results[idx] = p;
    executing.add(p);
    const done = () => executing.delete(p);
    p.then(done, done);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
    return enqueue();
  }
  await enqueue();
  return Promise.all(results);
}

/**
 * Try to fetch USDT-perpetual (or spot) symbols:
 * 1) use bybit.fetchUsdtPerpetualSymbols() if available
 * 2) REST fallback using Bybit V5 /market/instruments-info?category={spot|linear}
 * 3) final fallback: Bybit V2 /v2/public/symbols (legacy)
 */
async function fetchSymbolsFallback() {
  // 1) try helper from bybit module
  try {
    if (bybit && typeof bybit.fetchUsdtPerpetualSymbols === 'function') {
      const s = await bybit.fetchUsdtPerpetualSymbols();
      if (Array.isArray(s) && s.length) return s;
    }
  } catch (e) {
    console.warn('fetchSymbolsFallback: bybit.fetchUsdtPerpetualSymbols failed', e && e.message);
  }

  // 2) Try v5 instruments-info
  try {
    const base = cfg.BYBIT_BASE_API || 'https://api-testnet.bybit.com';
    const category = (cfg.BYBIT_MARKET === 'spot') ? 'spot' : 'linear';
    const url = `${base.replace(/\/$/, '')}/v5/market/instruments-info?category=${category}`;
    if (process.env.DEBUG_FILTERS === 'true') console.debug('fetchSymbolsFallback: trying v5 instruments:', url);
    const res = await axios.get(url, { timeout: 10000 });
    const data = res && res.data;
    if (data) {
      // v5 typically returns data.result.list
      const resultList = (data.result && data.result.list) ? data.result.list : (data.result || []);
      if (Array.isArray(resultList) && resultList.length) {
        const symbols = [];
        for (const it of resultList) {
          const sym = it.symbol || it.name;
          const quote = (it.quoteCoin || it.quote_coin || it.quoteCoinName || it.quote || it.quoteAsset || it.quote_asset);
          const status = (it.status || it.state || '').toString().toLowerCase();
          if (!sym) continue;
          if (quote && String(quote).toUpperCase() === 'USDT' && (status === '' || status === 'tradable' || status === 'listed' || status === 'online' || status === 'normal')) {
            symbols.push(sym);
          }
        }
        if (symbols.length) return symbols;
        // fallback to raw symbol names
        const raw = resultList.map(r => r.symbol || r.name).filter(Boolean);
        if (raw.length) return raw;
      }
    }
  } catch (e) {
    console.warn('fetchSymbolsFallback: v5 instruments-info failed', e && e.message);
  }

  // 3) Final fallback: v2 public symbols (legacy)
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

/**
 * scanRootTf(rootTf)
 * returns array of signals. Each signal includes .filter: { pass, reasons }
 * Signals are NOT filtered out here.
 */
async function scanRootTf(rootTf) {
  const intervalApi = intervalKeyToApi(rootTf);
  const higherTf = higherTfFor(rootTf);

  // 1) fetch symbols
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

  // log basic info
  try {
    console.log(`scanRootTf: fetched ${symbols.length} symbols. First 10: ${symbols.slice(0, 10).join(', ')}`);
  } catch (e) {}

  // limit symbols optionally
  if (cfg.MAX_SCAN_SYMBOLS && Number.isInteger(cfg.MAX_SCAN_SYMBOLS) && cfg.MAX_SCAN_SYMBOLS > 0) {
    symbols = symbols.slice(0, cfg.MAX_SCAN_SYMBOLS);
  }

  const concurrency = Math.max(1, parseInt(process.env.REST_CONCURRENCY || '8', 10));
  const signals = [];

  await mapWithConcurrency(symbols, concurrency, async (symbol) => {
    try {
      const limit = 200;
      const klines = await bybit.fetchKlines(symbol, intervalApi, limit).catch(e => {
        // fetchKlines failed — log and skip
        if (process.env.DEBUG_FILTERS === 'true') console.debug(`fetchKlines failed for ${symbol} ${intervalApi}: ${e && e.message}`);
        return null;
      });
      if (!klines || klines.length < 30) {
        // insufficient history -> still we don't fail early; just skip this symbol
        return;
      }
      const closes = klines.map(k => parseFloat(k.close));
      const { hist } = computeMACD(closes, 12, 26, 9);
      if (!hist || hist.length === 0) return;
      const latestHist = hist[hist.length - 1];
      const histHistory = hist.slice(0, Math.max(0, hist.length - 1));

      // fetch higher TF hist only if FILTER_MTF is enabled (so we can evaluate filter)
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

      // evaluate filter (does NOT stop the signal from being returned)
      const filterResult = (() => {
        try {
          return passesFilters(symbol, rootTf, klines, latestHist, histHistory, higherTfHist);
        } catch (e) {
          return { pass: false, reasons: ['filter_eval_error:' + (e && e.message)] };
        }
      })();

      const signal = {
        symbol,
        interval: rootTf,
        macdValue: latestHist,
        klines,
        histHistory,
        higherTfHist,
        filter: filterResult
      };
      signals.push(signal);
    } catch (err) {
      if (process.env.DEBUG_FILTERS === 'true') console.error('scanRootTf symbol error', err && err.message, 'symbol:', symbol);
    }
  });

  // sort signals by absolute macd strength (strongest first)
  signals.sort((a, b) => Math.abs(b.macdValue) - Math.abs(a.macdValue));
  return signals;
}

/**
 * handleRootSignal(signal, wsClient)
 * - Always sends a push/telegram for root signals when enabled.
 * - Only attempts to open a trade if signal.filter.pass === true and OPEN_TRADES=true.
 * - To open trades, tries legacy handler (./oldScanner.handleRootSignal) OR tradeManager.openTrade(signal).
 */
async function handleRootSignal(signal, wsClient) {
  // 1) Send push for every root signal if enabled
  const notifyRoot = (process.env.NOTIFY_ON_ROOT_SIGNALS || 'false') === 'true';
  const notifyLimit = parseInt(process.env.NOTIFY_ROOT_SIGNALS_LIMIT || '20', 10);
  // We can't know global position in scan here, so send per-signal if notifyRoot true and NOTIFY_ROOT_SIGNALS_LIMIT > 0
  if (notifyRoot && notifyLimit > 0) {
    try {
      const label = signal.filter && signal.filter.pass ? 'FILTER_PASS' : 'FILTER_FAIL';
      const msg = `ROOT SIGNAL: ${signal.symbol} ${signal.interval} macd=${Number(signal.macdValue).toFixed(6)} ${label} reasons=${(signal.filter && signal.filter.reasons || []).slice(0,3).join('|')}`;
      // Respect NOTIFY_ROOT_SIGNALS_LIMIT by decrementing a simple in-memory counter (per-process)
      if (!global._notifyRootCount) global._notifyRootCount = notifyLimit;
      if (global._notifyRootCount > 0) {
        global._notifyRootCount--;
        if (typeof sendTelegram === 'function') {
          try { await sendTelegram(msg); } catch (e) { console.warn('sendTelegram root signal failed', e && e.message); }
        } else {
          console.log('notify (telegram not configured):', msg);
        }
      } else {
        // reached limit, skip further notifications this process run
      }
    } catch (e) {
      console.warn('handleRootSignal notify error', e && e.message);
    }
  }

  // 2) If filter did not pass, do NOT open trade; just log and return.
  const passed = signal.filter && signal.filter.pass;
  if (!passed) {
    // Optionally call legacy handler for non-opening behavior (do nothing by default)
    if (process.env.DEBUG_FILTERS === 'true') {
      console.debug(`handleRootSignal: ${signal.symbol} ${signal.interval} skipped open (filter failed): ${signal.filter && signal.filter.reasons ? signal.filter.reasons.join(';') : 'no-reasons'}`);
    }
    return { opened: false, reason: 'filter_failed', reasons: signal.filter && signal.filter.reasons };
  }

  // 3) If passed, check OPEN_TRADES flag
  if ((process.env.OPEN_TRADES || 'false') !== 'true') {
    console.log(`handleRootSignal: PASS but OPEN_TRADES not enabled. Candidate: ${signal.symbol} ${signal.interval}`);
    return { opened: false, reason: 'open_trades_disabled' };
  }

  // 4) Attempt to open trade by calling legacy handler or trade manager
  try {
    // Try legacy scanner handler first
    try {
      const legacy = require('./oldScanner'); // optional module
      if (legacy && typeof legacy.handleRootSignal === 'function') {
        return await legacy.handleRootSignal(signal, wsClient);
      }
    } catch (e) {
      // ignore missing legacy handler
    }

    // Try tradeManager.openTrade if available
    try {
      const tradeManager = require('./tradeManager');
      if (tradeManager && typeof tradeManager.openTrade === 'function') {
        const result = await tradeManager.openTrade(signal); // assume signature tradeManager.openTrade(signal)
        console.log(`handleRootSignal: attempted openTrade for ${signal.symbol} result=`, result && (result.id || result.status || 'ok'));
        if (process.env.NOTIFY_ON_TRADE_OPEN === 'true') {
          try { await sendTelegram(`Trade opened: ${signal.symbol} ${signal.interval} info=${JSON.stringify(result).slice(0,200)}`); } catch (e) {}
        }
        return { opened: true, result };
      }
    } catch (e) {
      console.warn('handleRootSignal tradeManager.openTrade error', e && e.message);
    }

    // If no trade open function available, log and notify (safe behavior)
    console.log('handleRootSignal: PASS but no trade open implementation found. Signal:', signal.symbol);
    return { opened: false, reason: 'no_trade_open_impl' };
  } catch (e) {
    console.error('handleRootSignal: unexpected error', e && e.message);
    return { opened: false, reason: 'error', error: e && e.message };
  }
}

module.exports = {
  scanRootTf,
  handleRootSignal
};
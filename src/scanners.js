/**
 * scanner.js
 *
 * Exports:
 *  - async function scanRootTf(rootTf) -> returns array of candidate signals
 *  - async function handleRootSignal(signal, wsClient) -> existing hook for processing a single signal
 *
 * What this file does:
 *  - Scans the USDT-perpetual symbol universe and computes MACD histograms for the root timeframe.
 *  - For each symbol it computes a MACD histogram time series (from klines), obtains the latest histogram,
 *    optionally fetches a higher-timeframe histogram for MTF confirmation, and applies the filters implemented
 *    in src/filters.js via passesFilters(...).
 *  - Returns a list of signals (objects) for caller to evaluate/process further.
 *
 * Compatibility notes:
 *  - This implementation is written to avoid changing call signatures used by src/index.js:
 *      index.js calls scanRootTf(rootTf) and later handleRootSignal(signal, wsClient)
 *  - It will not place orders itself; handleRootSignal is left as a thin wrapper that calls the existing
 *    scanner handler if present (so your existing trade flow continues).
 *
 * Performance notes:
 *  - To limit API pressure we fetch only one klines set per symbol per root scan. For MTF checks we fetch a
 *    second (coarser) kline set only when FILTER_MTF is enabled for that symbol/interval.
 *  - The code uses the existing fetchKlines function (which implements the hybrid cache) to minimize REST usage.
 *
 * Tuning:
 *  - The filters are controlled by environment variables (see environment variables list below).
 *
 * IMPORTANT:
 *  - Place this file at src/scanner.js (replace your existing scanner.js). Ensure src/filters.js and src/bybit.js
 *    are present as implemented earlier.
 */

const cfg = require('./config');
const bybit = require('./bybit'); // expects fetchKlines, fetchUsdtPerpetualSymbols, etc.
const { passesFilters } = require('./filters');
const { sendTelegram } = require('./telegram');

// Helper: simple EMA implementation and MACD calculation
function computeEMA(series, period) {
  if (!Array.isArray(series) || series.length === 0) return [];
  const k = 2 / (period + 1);
  const out = new Array(series.length).fill(0);
  // seed with SMA of first period elements (or first element if not enough)
  let seedCount = Math.min(period, series.length);
  let seedSum = 0;
  for (let i = 0; i < seedCount; i++) seedSum += series[i];
  let prev = seedSum / seedCount;
  // place prev at index seedCount-1
  for (let i = 0; i < series.length; i++) {
    const val = series[i];
    if (i === 0) {
      prev = val; // fallback seed
    } else {
      prev = (val - prev) * k + prev;
    }
    out[i] = prev;
  }
  return out;
}

// Compute MACD histogram series from close prices.
// Returns: { macdLine: [], signalLine: [], hist: [] } aligned with input series length.
function computeMACD(closeSeries, fast = 12, slow = 26, signal = 9) {
  if (!Array.isArray(closeSeries) || closeSeries.length === 0) {
    return { macdLine: [], signalLine: [], hist: [] };
  }
  const emaFast = computeEMA(closeSeries, fast);
  const emaSlow = computeEMA(closeSeries, slow);
  const macdLine = closeSeries.map((_, i) => (emaFast[i] || 0) - (emaSlow[i] || 0));
  const signalLine = computeEMA(macdLine, signal);
  const hist = macdLine.map((v, i) => v - (signalLine[i] || 0));
  return { macdLine, signalLine, hist };
}

// Map logical root TF to Bybit interval format used in fetchKlines
function intervalKeyToApi(intervalKey) {
  // Accept '1h', '4h', '1d' or numeric-like strings already used in bybit topics
  const ik = String(intervalKey).toLowerCase();
  if (ik === '1h' || ik === '60' || ik === '60m' || ik === '60min') return '60';
  if (ik === '4h' || ik === '240') return '240';
  if (ik === '1d' || ik === 'd' || ik === '1440') return 'D';
  // fallback: return as-is
  return intervalKey;
}

// Determine higher timeframe for MTF confirmation:
// if root is 60 -> higher = 240 (4h), root 240 -> higher = 'D', root 'D' -> higher = 'W' (optional)
function higherTfFor(rootKey) {
  const k = String(rootKey).toLowerCase();
  if (k === '1h' || k === '60') return '240'; // 4h
  if (k === '4h' || k === '240') return 'D';  // 1d
  if (k === 'd' || k === '1d' || k === '1440') return 'W'; // weekly
  // fallback: return next coarser by heuristics
  return null;
}

// Utility to limit concurrency for scanning many symbols (simple pool)
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
 * scanRootTf(rootTf)
 * rootTf: string like '1h', '4h', '1d'
 * returns: array of signal objects: { symbol, interval, macdValue, reasons, klines, histHistory, higherTfHist (if used) }
 */
async function scanRootTf(rootTf) {
  const intervalApi = intervalKeyToApi(rootTf);
  const higherTf = higherTfFor(rootTf);

  // fetch symbol universe (USDT perpetuals)
  let symbols = [];
  try {
    symbols = await bybit.fetchUsdtPerpetualSymbols();
    if (!Array.isArray(symbols)) symbols = [];
  } catch (e) {
    console.error('scanRootTf: fetchUsdtPerpetualSymbols failed', e && e.message);
    symbols = [];
  }

  // limit symbols optionally by config.MAX_SCAN_SYMBOLS (not to overload)
  if (cfg.MAX_SCAN_SYMBOLS && Number.isInteger(cfg.MAX_SCAN_SYMBOLS) && cfg.MAX_SCAN_SYMBOLS > 0) {
    symbols = symbols.slice(0, cfg.MAX_SCAN_SYMBOLS);
  }

  // concurrency tuning
  const concurrency = Math.max(1, parseInt(process.env.REST_CONCURRENCY || cfg.REST_CONCURRENCY || '8', 10));

  // For each symbol, fetch klines, compute MACD hist, possibly fetch higherTF hist and run filters
  const signals = [];

  await mapWithConcurrency(symbols, concurrency, async (symbol) => {
    try {
      // fetch klines for root timeframe (we need enough history for MACD calculation)
      const limit = 200;
      const klines = await bybit.fetchKlines(symbol, intervalApi, limit);
      if (!klines || klines.length < 30) {
        // insufficient history
        // console.debug(`scanRootTf: insufficient klines for ${symbol} ${intervalApi}`);
        return;
      }
      // extract close prices
      const closes = klines.map(k => parseFloat(k.close));
      // compute macd
      const { hist } = computeMACD(closes, 12, 26, 9);
      if (!hist || hist.length === 0) return;
      const latestHist = hist[hist.length - 1];
      const histHistory = hist.slice(0, Math.max(0, hist.length - 1)); // everything except latest

      // optionally compute higher TF histogram for MTF confirmation
      let higherTfHist = null;
      if (process.env.FILTER_MTF === 'true' || (process.env.FILTER_MTF == null && true)) {
        // FILTER_MTF default true in filters.js; we only fetch if filters require it.
        if (higherTf) {
          try {
            const higherApi = intervalKeyToApi(higherTf);
            const klHigh = await bybit.fetchKlines(symbol, higherApi, 200);
            if (klHigh && klHigh.length >= 30) {
              const closesHigh = klHigh.map(k => parseFloat(k.close));
              const macHigh = computeMACD(closesHigh, 12, 26, 9);
              const histHigh = macHigh.hist || [];
              higherTfHist = histHigh.length ? histHigh[histHigh.length - 1] : null;
            }
          } catch (e) {
            // don't fail whole scan if higherTF fetch fails; we will pass null into passesFilters which will
            // let the filter respond with 'mtf_missing_higher_tf' if FILTER_MTF is enabled.
            console.warn(`scanRootTf: higher TF fetch failed for ${symbol} ${higherTf}`, e && e.message);
            higherTfHist = null;
          }
        } else {
          // no known higher TF mapping
          higherTfHist = null;
        }
      }

      // Run filters; passesFilters returns reasons array and pass flag
      const { pass, reasons } = passesFilters(symbol, rootTf, klines, latestHist, histHistory, higherTfHist);
      if (!pass) {
        // For debugging, log the primary reason at debug level
        // Keep logs moderate to avoid spamming when scanning many symbols
        if (process.env.DEBUG_FILTERS === 'true') {
          console.debug(`Filter rejected ${symbol} ${rootTf}: ${reasons.join(';')}`);
        }
        return;
      }

      // If passed, push to signals with some useful fields
      signals.push({
        symbol,
        interval: rootTf,
        macdValue: latestHist,
        reasons,
        klines,
        histHistory,
        higherTfHist
      });
    } catch (err) {
      console.error('scanRootTf symbol scan error', err && err.message, 'symbol:', symbol);
      // continue scanning other symbols
    }
  });

  // Sort signals by macdValue descending (strongest first)
  signals.sort((a, b) => Math.abs(b.macdValue) - Math.abs(a.macdValue));
  return signals;
}

/**
 * handleRootSignal(signal, wsClient)
 * - This function is expected to be the existing hook used by index.js.
 * - To avoid breaking your existing trade flow, this function will try to require and call the
 *   previous handler implementation if present (e.g., if you have a handleRootSignal elsewhere).
 * - If not present, it will log the candidate and stop (safe no-op).
 *
 * signal: object produced by scanRootTf
 * wsClient: BybitWS instance (optional) passed by caller for subscriptions, etc.
 */
async function handleRootSignal(signal, wsClient) {
  // If there is an existing implementation in another module, call it to preserve behavior.
  try {
    // Try to call an existing exported handler from './oldScanner' (if present)
    // This is defensive: if you previously had a separate handler we will defer to that.
    const legacy = require('./oldScanner'); // optional module - if not present, require will throw
    if (legacy && typeof legacy.handleRootSignal === 'function') {
      return legacy.handleRootSignal(signal, wsClient);
    }
  } catch (e) {
    // ignore module-not-found; proceed to local handling
  }

  // Default safe behavior: log candidate and send a debug telegram (if configured) but do not place trades.
  console.log('handleRootSignal: candidate', {
    symbol: signal.symbol,
    interval: signal.interval,
    macd: signal.macdValue,
    reasons: (signal.reasons || []).join(';')
  });

  if (process.env.NOTIFY_ON_CANDIDATE === 'true' && typeof sendTelegram === 'function') {
    try {
      const msg = `Candidate signal: ${signal.symbol} ${signal.interval} macd=${signal.macdValue.toFixed(6)} reasons=${(signal.reasons || []).join(',')}`;
      await sendTelegram(msg);
    } catch (e) {
      console.warn('handleRootSignal: sendTelegram failed', e && e.message);
    }
  }
  // Do not open trades here by default. Your existing trade manager will handle execution.
  return;
}

module.exports = {
  scanRootTf,
  handleRootSignal
};

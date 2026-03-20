// Filters module - provides 4 filters and env toggles.
// - Liquidity (avg volume)
// - Volume spike (latest vs MA)
// - MACD strength (z-score of abs(hist))
// - MTF confirmation (higher timeframe histogram > 0)
// - Excludes stable-stable pairs (e.g., USDTUSDC)
// Export: passesFilters(symbol, interval, klines, latestHist, histHistory, higherTfHist)
// Returns: { pass: boolean, reasons: string[] }
//
// Environment toggles (set to "true" or "false"):
// FILTER_EXCLUDE_STABLES=true
// FILTER_LIQUIDITY=true
// FILTER_VOLUME=true
// FILTER_MACD_STRENGTH=true
// FILTER_MTF=true
//
// Optional tuning env vars (numbers, strings parsed below):
// VOL_LOOKBACK (default 20)
// VOL_MULTIPLIER_{interval} e.g. VOL_MULTIPLIER_1h (default per interval below)
// HIST_LOOKBACK (default 50)
// HIST_Z_THRESHOLD_{interval} e.g. HIST_Z_THRESHOLD_1h
// MIN_AVG_VOLUME_{interval} e.g. MIN_AVG_VOLUME_1h
//
// Example usage:
// const { passesFilters } = require('./filters');
// const { pass, reasons } = passesFilters('BTCUSDT', '1h', klines, latestHist, histHistory, higherTfHist);
// if (!pass) console.debug('Rejected', symbol, reasons);

const cfg = require('./config');

const ENV = process.env || {};

// Helper to parse boolean envs
function envBool(name, def = false) {
  const v = (ENV[name] || '').toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return def;
}
function envInt(name, def) {
  const v = parseInt(ENV[name], 10);
  return Number.isFinite(v) ? v : def;
}
function envFloat(name, def) {
  const v = parseFloat(ENV[name]);
  return Number.isFinite(v) ? v : def;
}

// Toggles
const TOGGLE = {
  EXCLUDE_STABLES: envBool('FILTER_EXCLUDE_STABLES', true),
  LIQUIDITY: envBool('FILTER_LIQUIDITY', true),
  VOLUME: envBool('FILTER_VOLUME', true),
  MACD_STRENGTH: envBool('FILTER_MACD_STRENGTH', true),
  MTF: envBool('FILTER_MTF', true)
};

// Defaults and per-timeframe tuning
const VOL_LOOKBACK = envInt('VOL_LOOKBACK', 20);
const HIST_LOOKBACK = envInt('HIST_LOOKBACK', 50);

// Per-interval defaults (keys used as string e.g. "1h", "4h", "1d")
const DEFAULTS = {
  '1m': { volMultiplier: 2.2, histZ: 2.2, minAvgVol: 2000 },
  '3m': { volMultiplier: 2.0, histZ: 2.0, minAvgVol: 1500 },
  '5m': { volMultiplier: 1.9, histZ: 1.9, minAvgVol: 1200 },
  '15': { volMultiplier: 1.8, histZ: 1.8, minAvgVol: 800 },
  '30': { volMultiplier: 1.7, histZ: 1.7, minAvgVol: 700 },
  '60': { volMultiplier: envFloat('VOL_MULTIPLIER_1h', 1.7), histZ: envFloat('HIST_Z_THRESHOLD_1h', 2.0), minAvgVol: envInt('MIN_AVG_VOLUME_1h', 5000) }, // 1h
  '120': { volMultiplier: 1.5, histZ: 1.6, minAvgVol: 3000 },
  '240': { volMultiplier: 1.4, histZ: 1.5, minAvgVol: 2500 }, // 4h
  'D': { volMultiplier: envFloat('VOL_MULTIPLIER_1d', 1.2), histZ: envFloat('HIST_Z_THRESHOLD_1d', 1.2), minAvgVol: envInt('MIN_AVG_VOLUME_1d', 1000) },
  'W': { volMultiplier: 1.1, histZ: 1.0, minAvgVol: 500 },
  'M': { volMultiplier: 1.0, histZ: 1.0, minAvgVol: 100 }
};

// Stablecoins list (extend if desired)
const STABLES = ['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USD'];

// Utility helpers
function mean(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
function std(arr, avg) {
  if (!arr || !arr.length) return 0;
  const m = avg != null ? avg : mean(arr);
  const v = Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
  return v || 0;
}

// parse symbol into base/quote by matching known quote suffixes (safe approach)
function splitSymbol(symbol) {
  // Try to match known quote suffixes (longest first)
  const quotes = STABLES.concat(['BTC', 'ETH', 'FIL', 'SOL', 'DOGE', 'ADA', 'DOT', 'XRP', 'LTC', 'LINK']); // include common assets to improve matching
  // sort by length descending so USDC matches before DC...
  quotes.sort((a,b) => b.length - a.length);
  for (const q of quotes) {
    if (symbol.endsWith(q)) {
      const base = symbol.slice(0, symbol.length - q.length);
      return { base, quote: q };
    }
  }
  // fallback: try split half-half
  const mid = Math.floor(symbol.length / 2);
  return { base: symbol.slice(0, mid), quote: symbol.slice(mid) };
}

function isStableToken(token) {
  if (!token) return false;
  return STABLES.includes(token.toUpperCase());
}

// Exclude trading stable-stable pairs (both base & quote are stablecoins)
function isStableStablePair(symbol) {
  const s = splitSymbol(symbol);
  return isStableToken(s.base) && isStableToken(s.quote);
}

// Compute volume MA over lookback bars (klines is array of {volume,...})
function volumeMA(klines, lookback) {
  const slice = klines.slice(-lookback).map(k => (k && k.volume) || 0);
  return mean(slice);
}

// compute meanAbsHist and stdAbsHist from histHistory (array of numbers)
function macdAbsStats(histHistory, lookback) {
  const arr = (histHistory || []).slice(-lookback).map(v => Math.abs(v || 0));
  if (!arr.length) return { meanAbs: 0, stdAbs: 0 };
  const meanAbs = mean(arr);
  const stdAbs = std(arr, meanAbs);
  return { meanAbs, stdAbs };
}

/*
 Main exported function
 Inputs:
  - symbol (string)
  - interval (string or number e.g. '60' or '1h' dependent on your app) : we accept '60' or '1h' or '240' etc.
  - klines: array of candles (oldest->newest). Each candle: { t, open, high, low, close, volume }
  - latestHist: latest MACD histogram number (for newest closed bar)
  - histHistory: array of previous histogram values (abs values allowed) oldest->newest excluding latestHist ideally
  - higherTfHist: optional histogram value from higher timeframe for MTF confirmation (number)
 Returns:
  { pass: boolean, reasons: string[] }
*/
function passesFilters(symbol, interval, klines, latestHist, histHistory = [], higherTfHist = null) {
  const reasons = [];

  // normalize interval key to match DEFAULTS: accept '1h' or '60'
  let key = String(interval);
  if (key === '60' || key === '1h' || key.toLowerCase() === '60m') key = '60';
  if (key === '240' || key === '4h') key = '240';
  if (key === '1440' || key.toLowerCase() === '1d') key = 'D';

  const def = DEFAULTS[key] || DEFAULTS['60'];

  // 0) basic sanity
  if (!klines || klines.length < 2) {
    reasons.push('insufficient_klines');
    return { pass: false, reasons };
  }

  // 0.5) stable-stable exclusion
  if (TOGGLE.EXCLUDE_STABLES) {
    if (isStableStablePair(symbol)) {
      reasons.push('excluded_stable_stable_pair');
      return { pass: false, reasons };
    }
  }

  // 1) Liquidity filter
  if (TOGGLE.LIQUIDITY) {
    const maVol = volumeMA(klines, Math.min(VOL_LOOKBACK, klines.length));
    const minAvg = envInt(`MIN_AVG_VOLUME_${key}`, def.minAvgVol || 1000);
    if (maVol < minAvg) {
      reasons.push(`low_avg_volume:${Math.round(maVol)}<${minAvg}`);
      return { pass: false, reasons }; // reject early
    }
  }

  // 2) Volume spike
  if (TOGGLE.VOLUME) {
    const volMA = volumeMA(klines, Math.min(VOL_LOOKBACK, klines.length));
    const latestVol = klines[klines.length - 1].volume || 0;
    const volMultiplier = envFloat(`VOL_MULTIPLIER_${key}`, def.volMultiplier || 1.5);
    const volRatio = volMA > 0 ? latestVol / volMA : 0;
    if (volRatio < volMultiplier) {
      reasons.push(`low_volume_spike:ratio=${volRatio.toFixed(2)}<${volMultiplier}`);
      return { pass: false, reasons };
    }
  }

  // 3) MACD basic sign
  if (latestHist == null) {
    reasons.push('missing_macd_hist');
    return { pass: false, reasons };
  }
  if (latestHist <= 0) {
    reasons.push('macd_hist_not_positive');
    return { pass: false, reasons };
  }

  // 4) MACD strength (z-score)
  if (TOGGLE.MACD_STRENGTH) {
    const histLook = envInt('HIST_LOOKBACK', HIST_LOOKBACK);
    const { meanAbs, stdAbs } = macdAbsStats(histHistory, histLook);
    const histZThreshold = envFloat(`HIST_Z_THRESHOLD_${key}`, def.histZ || 1.5);
    const histAbs = Math.abs(latestHist || 0);
    let histZ = 0;
    if (stdAbs > 0) histZ = (histAbs - meanAbs) / stdAbs;
    else histZ = histAbs >= meanAbs ? 1 : 0;
    if (histZ < histZThreshold) {
      reasons.push(`macd_strength_low:z=${histZ.toFixed(2)}<${histZThreshold}`);
      return { pass: false, reasons };
    }
  }

  // 5) MTF confirmation
  if (TOGGLE.MTF) {
    // If higherTfHist provided, require > 0
    if (higherTfHist == null) {
      // if MTF required but not provided, fail with reason to indicate caller should fetch higherTF
      reasons.push('mtf_missing_higher_tf');
      return { pass: false, reasons };
    } else {
      if (higherTfHist <= 0) {
        reasons.push(`mtf_higher_tf_not_positive:${higherTfHist}`);
        return { pass: false, reasons };
      }
    }
  }

  // All passed
  return { pass: true, reasons: ['passed_all_filters'] };
}

module.exports = {
  passesFilters,
  // helpers exported for tests or custom integrations
  isStableStablePair,
  splitSymbol,
  STABLES,
  TOGGLE
};
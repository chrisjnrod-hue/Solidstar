// src/filters.js
// Filter helpers returning detailed results so scanner can include per-filter booleans in notifications.

const cfg = require('./config');

// default thresholds (tune as needed)
const DEFAULTS = {
  VOL_LOOKBACK: 20,
  HIST_LOOKBACK: 50,
  MIN_AVG_VOLUME_1H: 5000,
  MIN_AVG_VOLUME_4H: 2500,
  MIN_AVG_VOLUME_1D: 1000,
  HIST_Z_THRESHOLD_1H: 2.0,
  HIST_Z_THRESHOLD_4H: 1.5,
  HIST_Z_THRESHOLD_1D: 1.2,
  VOL_MULTIPLIER_1H: 1.7,
  VOL_MULTIPLIER_4H: 1.4,
  VOL_MULTIPLIER_1D: 1.2
};

function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
function std(arr) {
  if (!arr || arr.length === 0) return 0;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + Math.pow(x - m, 2), 0) / arr.length;
  return Math.sqrt(v);
}
function zscore(arr, value) {
  const s = std(arr);
  if (s === 0) return 0;
  const m = mean(arr);
  return (value - m) / s;
}

// Basic MACD histogram zscore calc from hist array: return zscore of latest value vs previous window
function histZscore(histArray) {
  if (!Array.isArray(histArray) || histArray.length < 2) return 0;
  const history = histArray.slice(0, histArray.length - 1);
  const latest = histArray[histArray.length - 1];
  return zscore(history, latest);
}

// Convert timeframe key to multiplier/threshold lookups
function intervalKeyToSettings(rootTf) {
  if (rootTf === '1h' || String(rootTf) === '60') {
    return { volMultiplier: Number(process.env.VOL_MULTIPLIER_1H || DEFAULTS.VOL_MULTIPLIER_1H), histZ: Number(process.env.HIST_Z_THRESHOLD_1H || DEFAULTS.HIST_Z_THRESHOLD_1H), minAvgVol: Number(process.env.MIN_AVG_VOLUME_1H || DEFAULTS.MIN_AVG_VOLUME_1H) };
  }
  if (rootTf === '4h' || String(rootTf) === '240') {
    return { volMultiplier: Number(process.env.VOL_MULTIPLIER_4H || DEFAULTS.VOL_MULTIPLIER_4H), histZ: Number(process.env.HIST_Z_THRESHOLD_4H || DEFAULTS.HIST_Z_THRESHOLD_4H), minAvgVol: Number(process.env.MIN_AVG_VOLUME_4H || DEFAULTS.MIN_AVG_VOLUME_4H) };
  }
  if (rootTf === '1d' || String(rootTf).toLowerCase().startsWith('d')) {
    return { volMultiplier: Number(process.env.VOL_MULTIPLIER_1D || DEFAULTS.VOL_MULTIPLIER_1D), histZ: Number(process.env.HIST_Z_THRESHOLD_1D || DEFAULTS.HIST_Z_THRESHOLD_1D), minAvgVol: Number(process.env.MIN_AVG_VOLUME_1D || DEFAULTS.MIN_AVG_VOLUME_1D) };
  }
  // default fallback
  return { volMultiplier: 1.5, histZ: 1.5, minAvgVol: 1000 };
}

/**
 * passesFiltersDetailed(symbol, rootTf, klines, latestHist, histHistory, higherTfHist)
 * - Returns {
 *     pass: boolean,
 *     reasons: string[],
 *     details: { volumePass: bool, histPass: bool, mtfPass: bool, sufficientKlines: bool }
 *   }
 */
function passesFiltersDetailed(symbol, rootTf, klines, latestHist, histHistory, higherTfHist, dailyHist = null, prevDailyHist = null) {
  const res = { pass: false, reasons: [], details: { sufficientKlines: false, volumePass: false, histPass: false, mtfPass: false } };

  // klines sufficient check
  if (!Array.isArray(klines) || klines.length < 30) {
    res.reasons.push('insufficient_klines');
    res.details.sufficientKlines = false;
    return res;
  }
  res.details.sufficientKlines = true;

  // volume check: compare last candle volume vs avg of lookback
  const lookback = Math.min(20, klines.length - 1);
  const vols = klines.slice(Math.max(0, klines.length - 1 - lookback), klines.length - 1).map(k => Number(k.volume || 0));
  const avgVol = mean(vols);
  const lastVol = Number(klines[klines.length - 1].volume || 0);
  const s = intervalKeyToSettings(rootTf);
  const volPass = (avgVol > 0 && lastVol >= avgVol * s.volMultiplier && avgVol >= s.minAvgVol);
  res.details.volumePass = volPass;
  if (!volPass) res.reasons.push(`low_avg_volume:${Math.round(avgVol)}<${s.minAvgVol}? lastVol=${Math.round(lastVol)} mult=${s.volMultiplier}`);

  // histogram strength (z-score)
  const z = histZscore([].concat(histHistory || [] , [latestHist]));
  const histPass = Math.abs(z) >= s.histZ && Math.sign(latestHist) > 0; // we want positive hist and strong
  res.details.histPass = histPass;
  if (!histPass) res.reasons.push(`hist_z=${z.toFixed(3)} thresh=${s.histZ}`);

  // MTF check: higherTfHist must be ~=positive OR daily ascending negative allowed (handled outside - pass in dailyHist/prevDailyHist if available)
  let mtfPass = true;
  if ((rootTf === '1h' || rootTf === '4h') && (process.env.FILTER_MTF || 'true') === 'true') {
    if (dailyHist !== null && typeof dailyHist !== 'undefined') {
      if (Number(dailyHist) > 0) mtfPass = true;
      else if (typeof prevDailyHist !== 'undefined' && prevDailyHist !== null && Number(dailyHist) > Number(prevDailyHist)) mtfPass = true;
      else mtfPass = false;
      if (!mtfPass) res.reasons.push(`mtf_daily_fail:${dailyHist}${typeof prevDailyHist!=='undefined' && prevDailyHist!==null?` prev=${prevDailyHist}`:''}`);
    } else if (typeof higherTfHist !== 'undefined' && higherTfHist !== null) {
      // fallback: require higher tf positive trend or at least same sign
      mtfPass = Number(higherTfHist) >= 0;
      if (!mtfPass) res.reasons.push(`mtf_higher_neg:${higherTfHist}`);
    }
  }
  res.details.mtfPass = mtfPass;

  // final pass: all details true
  res.pass = res.details.sufficientKlines && res.details.volumePass && res.details.histPass && res.details.mtfPass;
  if (res.pass) res.reasons.unshift('all_filters_pass');

  return res;
}

module.exports = {
  passesFiltersDetailed
};

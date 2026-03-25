// src/filters.js
// Filter helpers with relaxed defaults and debug logging for signal detection

const cfg = require('./config');

const DEFAULTS = {
  VOL_LOOKBACK: 20,
  HIST_LOOKBACK: 50,
  MIN_AVG_VOLUME_1H: 500,
  MIN_AVG_VOLUME_4H: 300,
  MIN_AVG_VOLUME_1D: 100,
  HIST_Z_THRESHOLD_1H: 1.0,
  HIST_Z_THRESHOLD_4H: 0.8,
  HIST_Z_THRESHOLD_1D: 0.6,
  VOL_MULTIPLIER_1H: 1.2,
  VOL_MULTIPLIER_4H: 1.1,
  VOL_MULTIPLIER_1D: 1.0
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

function histZscore(histArray) {
  if (!Array.isArray(histArray) || histArray.length < 2) return 0;
  const history = histArray.slice(0, histArray.length - 1);
  const latest = histArray[histArray.length - 1];
  return zscore(history, latest);
}

function intervalKeyToSettings(rootTf) {
  if (rootTf === '1h' || String(rootTf) === '60') {
    return {
      volMultiplier: Number(process.env.VOL_MULTIPLIER_1H || DEFAULTS.VOL_MULTIPLIER_1H),
      histZ: Number(process.env.HIST_Z_THRESHOLD_1H || DEFAULTS.HIST_Z_THRESHOLD_1H),
      minAvgVol: Number(process.env.MIN_AVG_VOLUME_1H || DEFAULTS.MIN_AVG_VOLUME_1H)
    };
  }
  if (rootTf === '4h' || String(rootTf) === '240') {
    return {
      volMultiplier: Number(process.env.VOL_MULTIPLIER_4H || DEFAULTS.VOL_MULTIPLIER_4H),
      histZ: Number(process.env.HIST_Z_THRESHOLD_4H || DEFAULTS.HIST_Z_THRESHOLD_4H),
      minAvgVol: Number(process.env.MIN_AVG_VOLUME_4H || DEFAULTS.MIN_AVG_VOLUME_4H)
    };
  }
  if (rootTf === '1d' || String(rootTf).toLowerCase().startsWith('d')) {
    return {
      volMultiplier: Number(process.env.VOL_MULTIPLIER_1D || DEFAULTS.VOL_MULTIPLIER_1D),
      histZ: Number(process.env.HIST_Z_THRESHOLD_1D || DEFAULTS.HIST_Z_THRESHOLD_1D),
      minAvgVol: Number(process.env.MIN_AVG_VOLUME_1D || DEFAULTS.MIN_AVG_VOLUME_1D)
    };
  }
  return { volMultiplier: 1.2, histZ: 1.0, minAvgVol: 500 };
}

/**
 * passesFiltersDetailed(symbol, rootTf, klines, latestHist, histHistory, higherTfHist, dailyHist, prevDailyHist)
 * Returns: { pass: boolean, reasons: string[], details: { volumePass, histPass, mtfPass, sufficientKlines } }
 */
function passesFiltersDetailed(symbol, rootTf, klines, latestHist, histHistory, higherTfHist, dailyHist = null, prevDailyHist = null) {
  const res = {
    pass: false,
    reasons: [],
    details: { sufficientKlines: false, volumePass: false, histPass: false, mtfPass: false }
  };

  // klines sufficient check
  if (!Array.isArray(klines) || klines.length < 30) {
    res.reasons.push('insufficient_klines');
    res.details.sufficientKlines = false;
    if (process.env.DEBUG_FILTERS === 'true') {
      console.log(`[${symbol}/${rootTf}] FAIL: insufficient_klines (${klines?.length || 0})`);
    }
    return res;
  }
  res.details.sufficientKlines = true;

  // volume check
  const lookback = Math.min(20, klines.length - 1);
  const vols = klines
    .slice(Math.max(0, klines.length - 1 - lookback), klines.length - 1)
    .map(k => Number(k.volume || 0));
  const avgVol = mean(vols);
  const lastVol = Number(klines[klines.length - 1].volume || 0);
  const s = intervalKeyToSettings(rootTf);
  const volPass = (avgVol > 0 && lastVol >= avgVol * s.volMultiplier && avgVol >= s.minAvgVol);
  res.details.volumePass = volPass;

  if (!volPass) {
    const reason = `low_vol: lastVol=${Math.round(lastVol)} < avgVol(${lookback})*${s.volMultiplier}=${Math.round(avgVol * s.volMultiplier)} OR avgVol=${Math.round(avgVol)}<minAvgVol=${s.minAvgVol}`;
    res.reasons.push(reason);
    if (process.env.DEBUG_FILTERS === 'true') {
      console.log(`[${symbol}/${rootTf}] FAIL: ${reason}`);
    }
  }

  // histogram strength (z-score)
  const z = histZscore([].concat(histHistory || [], [latestHist]));
  const histPass = Math.abs(z) >= s.histZ && Math.sign(latestHist) > 0;
  res.details.histPass = histPass;

  if (!histPass) {
    const reason = `hist_fail: z=${z.toFixed(3)}<${s.histZ} OR hist=${latestHist.toFixed(6)}<0 (sign=${Math.sign(latestHist)})`;
    res.reasons.push(reason);
    if (process.env.DEBUG_FILTERS === 'true') {
      console.log(`[${symbol}/${rootTf}] FAIL: ${reason}`);
    }
  }

  // MTF check
  let mtfPass = true;
  if ((rootTf === '1h' || rootTf === '4h') && (process.env.FILTER_MTF || 'true') === 'true') {
    if (dailyHist !== null && typeof dailyHist !== 'undefined') {
      if (Number(dailyHist) > 0) {
        mtfPass = true;
      } else if (
        typeof prevDailyHist !== 'undefined' &&
        prevDailyHist !== null &&
        Number(dailyHist) > Number(prevDailyHist)
      ) {
        mtfPass = true;
      } else {
        mtfPass = false;
      }
      if (!mtfPass) {
        const reason = `mtf_daily_fail: dailyHist=${Number(dailyHist).toFixed(6)} prev=${Number(prevDailyHist).toFixed(6)}`;
        res.reasons.push(reason);
        if (process.env.DEBUG_FILTERS === 'true') {
          console.log(`[${symbol}/${rootTf}] FAIL: ${reason}`);
        }
      }
    } else if (typeof higherTfHist !== 'undefined' && higherTfHist !== null) {
      mtfPass = Number(higherTfHist) >= 0;
      if (!mtfPass) {
        res.reasons.push(`mtf_higher_neg: ${Number(higherTfHist).toFixed(6)}`);
        if (process.env.DEBUG_FILTERS === 'true') {
          console.log(`[${symbol}/${rootTf}] FAIL: mtf_higher_neg=${Number(higherTfHist).toFixed(6)}`);
        }
      }
    }
  }
  res.details.mtfPass = mtfPass;

  // final pass
  res.pass =
    res.details.sufficientKlines &&
    res.details.volumePass &&
    res.details.histPass &&
    res.details.mtfPass;

  if (res.pass) {
    res.reasons.unshift('all_filters_pass');
    console.log(`✓ [${symbol}/${rootTf}] PASS ✓ macd=${latestHist.toFixed(6)} vol=${Math.round(avgVol)} z=${z.toFixed(2)}`);
  }

  return res;
}

module.exports = { passesFiltersDetailed };

// Central MACD implementation with SMA seeding (compatible with the computeMACD used in index.js)

function computeEMA(series, period) {
  if (!Array.isArray(series) || series.length === 0) return [];
  const out = new Array(series.length).fill(0);
  const k = 2 / (period + 1);
  const s = series.map(v => Number(v) || 0);

  if (s.length >= period) {
    // SMA seed for first EMA value
    let sum = 0;
    for (let i = 0; i < period; i++) sum += s[i];
    let prev = sum / period;
    // preserve raw values before seed
    for (let i = 0; i < period - 1; i++) out[i] = s[i];
    out[period - 1] = prev;
    for (let i = period; i < s.length; i++) {
      prev = (s[i] - prev) * k + prev;
      out[i] = prev;
    }
    return out;
  } else {
    // fallback EMA seeding when not enough points
    let prev = s[0];
    out[0] = prev;
    for (let i = 1; i < s.length; i++) {
      prev = (s[i] - prev) * k + prev;
      out[i] = prev;
    }
    return out;
  }
}

/**
 * computeMACD(closes, fast = 12, slow = 26, sig = 9)
 * Returns { macd: [], signal: [], hist: [] }
 * - Uses computeEMA above with SMA seeding to match common indicators (TradingView-like).
 */
function computeMACD(closes, fast = 12, slow = 26, sig = 9) {
  if (!Array.isArray(closes) || closes.length === 0) return { macd: [], signal: [], hist: [] };
  const c = closes.map(v => Number(v) || 0);
  const emaF = computeEMA(c, fast);
  const emaS = computeEMA(c, slow);
  const macd = c.map((_, i) => {
    const f = (typeof emaF[i] === 'number' ? (emaF[i] || 0) : 0);
    const s = (typeof emaS[i] === 'number' ? (emaS[i] || 0) : 0);
    return f - s;
  });
  const signal = computeEMA(macd, sig);
  const hist = macd.map((v, i) => v - (signal[i] || 0));
  return { macd, signal, hist };
}

module.exports = { computeMACD };
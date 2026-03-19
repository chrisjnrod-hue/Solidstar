// Unchanged MACD implementation (EMA12/26 signal9)

function ema(values, period) {
  const k = 2 / (period + 1);
  let emaPrev = values[0];
  const out = [emaPrev];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    emaPrev = v * k + emaPrev * (1 - k);
    out.push(emaPrev);
  }
  return out;
}

function macdHistogram(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macd = [];
  for (let i = 0; i < closes.length; i++) macd.push(emaFast[i] - emaSlow[i]);
  const sliceStart = Math.max(0, slow - fast);
  const signalArr = ema(macd.slice(sliceStart), signal);
  const hist = new Array(sliceStart).fill(null).concat(macd.slice(sliceStart).map((m, idx) => m - signalArr[idx]));
  return hist;
}

module.exports = { macdHistogram };
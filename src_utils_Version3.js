// Utility helpers: retry/backoff, quantize functions and time helpers

const cfg = require('./config');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function retryWithBackoff(fn, tries = cfg.API_MAX_RETRIES, baseMs = cfg.API_RETRY_BASE_MS) {
  let attempt = 0;
  while (attempt < tries) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      // If 429 with Retry-After header, respect it
      const ra = err?.response?.headers?.['retry-after'];
      if (ra) {
        const wait = parseFloat(ra) * 1000;
        await sleep(wait + 100);
      } else {
        const wait = baseMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * baseMs);
        await sleep(wait);
      }
      if (attempt >= tries) throw err;
    }
  }
}

function quantizePrice(price, tick) {
  if (!tick || tick <= 0) return price;
  const q = Math.round(price / tick) * tick;
  // ensure decimal precision matches tick
  const decimals = Math.max(0, Math.ceil(-Math.log10(tick)));
  return Number(q.toFixed(decimals));
}

function quantizeQty(qty, step) {
  if (!step || step <= 0) return qty;
  const q = Math.floor(qty / step) * step;
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  return Number(q.toFixed(decimals));
}

function computeNextHourOpenISO() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes(0,0,0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next.toISOString();
}

module.exports = {
  retryWithBackoff,
  sleep,
  quantizePrice,
  quantizeQty,
  computeNextHourOpenISO
};
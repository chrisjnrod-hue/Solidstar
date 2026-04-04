// src/bybit.js — Lazy loader wrapper for Bybit implementation with a safe fallback fetchKlines
// Replace existing src/bybit.js with this file, commit & push, then redeploy on Render.

console.log('bybit wrapper loaded');

const axios = require('axios');
const cfg = require('./config');

const CANDIDATES = [
  './src/bybit_v1.js',
  './bybit_v5.js',
  './src_bybit_Version1.js',
  './src/bybit_v1.js',
  // Intentionally do NOT include './bybit.js' to avoid self-require recursion
];

let cachedModule = null;
function loadImpl() {
  if (cachedModule) return cachedModule;
  for (const p of CANDIDATES) {
    try {
      const resolved = require.resolve(p);
      if (resolved === __filename) continue;
      const m = require(p);
      if (m) {
        cachedModule = m;
        console.log('bybit wrapper: loaded candidate', p);
        return cachedModule;
      }
    } catch (e) {
      // ignore and continue
    }
  }
  return null;
}

function resolveExport(mod, name) {
  if (!mod) return null;
  if (typeof mod[name] === 'function') return mod[name];
  if (mod.default && typeof mod.default[name] === 'function') return mod.default[name];
  return null;
}

// helper: normalize interval keys (e.g. '1h' -> '60', '4h' -> '240', '1d' -> 'D', '15m' -> '15')
function normalizeIntervalForApi(interval) {
  const k = String(interval || '').toLowerCase();
  if (k === '1h' || k === '60') return '60';
  if (k === '4h' || k === '240') return '240';
  if (k === '1d' || k === 'd' || k === '24h' || k === '1day') return 'D';
  if (k === '15m' || k === '15') return '15';
  if (k === '5m' || k === '5') return '5';
  // numeric string already acceptable, default to interval as-is
  return interval;
}

function categoryForApi() {
  // BYBIT_MARKET from config (spot/linear/etc). Default to 'linear' to preserve old behavior.
  return (cfg && cfg.BYBIT_MARKET) ? String(cfg.BYBIT_MARKET).toLowerCase() : (process.env.BYBIT_MARKET || 'linear');
}

// --- Fallback fetchKlines with logging and normalization ---
async function fetchKlines(symbol, interval, limit = 200) {
  const mod = loadImpl();
  // If real implementation present and provides fetchKlines, call it first (prefer real)
  const realFn = resolveExport(mod, 'fetchKlines');
  if (realFn) {
    try {
      return await realFn(symbol, interval, limit);
    } catch (e) {
      console.warn('bybit wrapper: real fetchKlines failed, falling back. err=', e && e.message);
    }
  }

  // Fallback direct HTTP fetch + normalization
  const base = (process.env.BYBIT_BASE_API || cfg.BYBIT_BASE_API || 'https://api.bybit.com').replace(/\/$/, '');
  const category = categoryForApi();
  const intervalParam = normalizeIntervalForApi(interval);
  const url = `${base}/v5/market/kline?category=${encodeURIComponent(category)}&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(intervalParam)}&limit=${Number(limit)}`;
  console.log('fetchKlines: requesting', url);
  try {
    const r = await axios.get(url, { timeout: 10000 });
    console.log('fetchKlines: status', r.status, 'dataKeys:', Object.keys(r.data || {}));
    const payload = r.data;

    // Bybit v5 typical shape: payload.result.list
    if (payload && payload.result && Array.isArray(payload.result.list)) {
      const list = payload.result.list;
      console.log('fetchKlines: returned list length', list.length, 'first=', list[0]);
      return list.map(item => {
        if (Array.isArray(item)) {
          // [ts, open, high, low, close, volume]
          return { timestamp: item[0], open: item[1], high: item[2], low: item[3], close: item[4], volume: item[5] };
        } else {
          return {
            timestamp: item.t || item.ts || item.open_time || item.start_at,
            open: item.open || item.o,
            high: item.high || item.h,
            low: item.low || item.l,
            close: item.close || item.c,
            volume: item.volume || item.v
          };
        }
      });
    }

    // alternate shapes
    if (payload && payload.data && Array.isArray(payload.data)) {
      console.log('fetchKlines: used payload.data shape length', payload.data.length);
      return payload.data;
    }

    console.warn('fetchKlines: unexpected payload shape:', Object.keys(payload || {}));
    return null;
  } catch (err) {
    console.error('fetchKlines: error', err && (err.response ? `${err.response.status} ${JSON.stringify(err.response.data).slice(0,200)}` : err.message));
    return null;
  }
}
// --- end fallback fetchKlines ---

// Fallback to fetch USDT perpetual symbols if real module doesn't provide it
async function fetchUsdtPerpetualSymbols() {
  const mod = loadImpl();
  const fn = resolveExport(mod, 'fetchUsdtPerpetualSymbols');
  if (fn) {
    try {
      return await fn();
    } catch (e) {
      console.warn('bybit wrapper: real fetchUsdtPerpetualSymbols failed, falling back', e && e.message);
    }
  }

  // HTTP fallback: query instruments-info and extract trading symbols for chosen category
  const base = (process.env.BYBIT_BASE_API || cfg.BYBIT_BASE_API || 'https://api.bybit.com').replace(/\/$/, '');
  const category = categoryForApi();
  const url = `${base}/v5/market/instruments-info?category=${encodeURIComponent(category)}`;
  console.log('fetchUsdtPerpetualSymbols: requesting', url);
  try {
    const r = await axios.get(url, { timeout: 10000 });
    const payload = r.data;
    // Bybit v5 common shape: payload.result.list
    const list = (payload && payload.result && Array.isArray(payload.result.list)) ? payload.result.list
      : (payload && Array.isArray(payload.data) ? payload.data : null);
    if (!Array.isArray(list)) {
      console.warn('fetchUsdtPerpetualSymbols: unexpected instruments payload shape', Object.keys(payload || {}));
      return [];
    }
    // Normalize: find symbol property, filter to USDT perpetuals only (user requested)
    const syms = list
      .map(it => (it && (it.symbol || it.name || it.code)) || '')
      .filter(Boolean)
      .filter(s => /USDT$/i.test(s)); // keep only USDT tickers (perpetuals)
    console.log('fetchUsdtPerpetualSymbols: discovered', syms.length, 'symbols (sample=', syms.slice(0,10), ')');
    return syms;
  } catch (err) {
    console.error('fetchUsdtPerpetualSymbols: error', err && (err.response ? `${err.response.status} ${JSON.stringify(err.response.data).slice(0,200)}` : err.message));
    return [];
  }
}

// Fallback to fetch a single symbol spec (used for quantize/lot sizing)
async function fetchSymbolSpecs(symbol) {
  const mod = loadImpl();
  const fn = resolveExport(mod, 'fetchSymbolSpecs');
  if (fn) {
    try {
      return await fn(symbol);
    } catch (e) {
      console.warn('bybit wrapper: real fetchSymbolSpecs failed, falling back', e && e.message);
    }
  }

  if (!symbol) return null;
  const base = (process.env.BYBIT_BASE_API || cfg.BYBIT_BASE_API || 'https://api.bybit.com').replace(/\/$/, '');
  const category = categoryForApi();
  const url = `${base}/v5/market/instruments-info?category=${encodeURIComponent(category)}&symbol=${encodeURIComponent(symbol)}`;
  console.log('fetchSymbolSpecs: requesting', url);
  try {
    const r = await axios.get(url, { timeout: 10000 });
    const payload = r.data;
    const item = (payload && payload.result && Array.isArray(payload.result.list) && payload.result.list[0]) ||
                 (payload && Array.isArray(payload.data) && payload.data[0]) || null;
    if (!item) {
      console.warn('fetchSymbolSpecs: no spec found for', symbol);
      return null;
    }
    // Return a normalized spec object with useful fields if present
    const spec = {
      symbol: item.symbol || item.name || symbol,
      status: item.status || item.state,
      baseCoin: item.baseCoin || item.baseCurrency || item.baseAsset,
      quoteCoin: item.quoteCoin || item.quoteCurrency || item.quoteAsset,
      priceFilter: item.priceFilter || item.price_tick || item.priceTick || null,
      lotSizeFilter: item.lotSizeFilter || item.lot_size_filter || item.quantity_step || item.qty_step || null,
      tickSize: (item.priceFilter && (item.priceFilter.tickSize || item.priceFilter.tick)) || item.price_tick || null,
      lotSize: (item.lotSizeFilter && (item.lotSizeFilter.minQty || item.lotSizeFilter.qtyStep)) || item.quantity_step || item.qty_step || null,
      raw: item
    };
    return spec;
  } catch (err) {
    console.error('fetchSymbolSpecs: error', err && (err.response ? `${err.response.status} ${JSON.stringify(err.response.data).slice(0,200)}` : err.message));
    return null;
  }
}

// Wrapper constructor for BybitWS: instantiate real class when available, fallback otherwise
class BybitWS {
  constructor(...args) {
    const mod = loadImpl();
    const Real = (mod && (mod.BybitWS || (mod.default && mod.default.BybitWS))) || (typeof mod === 'function' ? mod : null);
    if (Real && typeof Real === 'function') {
      try { this._inner = new Real(...args); } catch (e) { this._inner = null; console.warn('BybitWS real constructor failed:', e && e.message); }
    } else {
      this._inner = {
        ws: null,
        subscribeKline: () => () => {},
        subscribeTopic: () => () => {},
        prices: new Map(),
        getPrice: () => undefined,
        close: () => {}
      };
      console.warn('BybitWS: using fallback stub instance');
    }
  }
  subscribeKline(...a) { return this._inner && this._inner.subscribeKline ? this._inner.subscribeKline(...a) : () => {}; }
  subscribeTopic(...a) { return this._inner && this._inner.subscribeTopic ? this._inner.subscribeTopic(...a) : () => {}; }
  getPrice(symbol) { return this._inner && this._inner.getPrice ? this._inner.getPrice(symbol) : undefined; }
  close() { return this._inner && this._inner.close ? this._inner.close() : undefined; }
}

// Other wrappers that prefer real implementation when present, otherwise safe defaults
async function fetchTicker(symbol) {
  const mod = loadImpl();
  const fn = resolveExport(mod, 'fetchTicker') || (mod && mod.fetchTicker) || (mod && mod.default && mod.default.fetchTicker);
  if (!fn) return null;
  return await fn(symbol);
}

function quantize(spec, qty) {
  const mod = loadImpl();
  const fn = resolveExport(mod, 'quantize');
  if (!fn) return { qty: Number(qty) || 0, isRounded: false, reason: 'no_spec' };
  return fn(spec, qty);
}

async function placeActiveOrder(...args) {
  const mod = loadImpl();
  const fn = resolveExport(mod, 'placeActiveOrder');
  if (!fn) throw new Error('placeActiveOrder not implemented in bybit module');
  return await fn(...args);
}

module.exports = {
  BybitWS,
  fetchKlines,
  fetchUsdtPerpetualSymbols,
  fetchTicker,
  fetchSymbolSpecs,
  quantize,
  placeActiveOrder
};

// src/bybit.js — Lazy loader wrapper for Bybit implementation (self-skip safe)

const CANDIDATES = [
  './src/bybit.js',
  './bybit (1).js',
  './bybit_v5.js',
  './src_bybit_Version1.js',
  './src/bybit_v1.js'
  // DO NOT include './bybit.js' if this file is src/bybit.js
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
        return cachedModule;
      }
    } catch (e) {
      // ignore
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

class BybitWS {
  constructor(...args) {
    const mod = loadImpl();
    const Real = (mod && (mod.BybitWS || (mod.default && mod.default.BybitWS))) || (typeof mod === 'function' ? mod : null);
    if (Real && typeof Real === 'function') {
      try { this._inner = new Real(...args); } catch (e) { this._inner = null; }
    } else {
      this._inner = {
        ws: null,
        subscribeKline: () => () => {},
        subscribeTopic: () => () => {},
        prices: new Map(),
        getPrice: () => undefined,
        close: () => {}
      };
    }
  }
  subscribeKline(...a) { return this._inner && this._inner.subscribeKline ? this._inner.subscribeKline(...a) : () => {}; }
  subscribeTopic(...a) { return this._inner && this._inner.subscribeTopic ? this._inner.subscribeTopic(...a) : () => {}; }
  getPrice(symbol) { return this._inner && this._inner.getPrice ? this._inner.getPrice(symbol) : undefined; }
  close() { return this._inner && this._inner.close ? this._inner.close() : undefined; }
}

async function fetchKlines(symbol, interval, limit) {
  const mod = loadImpl();
  const fn = resolveExport(mod, 'fetchKlines');
  if (!fn) return null;
  return await fn(symbol, interval, limit);
}
async function fetchUsdtPerpetualSymbols() {
  const mod = loadImpl();
  const fn = resolveExport(mod, 'fetchUsdtPerpetualSymbols');
  if (!fn) return [];
  return await fn();
}
async function fetchTicker(symbol) {
  const mod = loadImpl();
  const fn = resolveExport(mod, 'fetchTicker') || (mod && mod.fetchTicker) || (mod && mod.default && mod.default.fetchTicker);
  if (!fn) return null;
  return await fn(symbol);
}
async function fetchSymbolSpecs(symbol) {
  const mod = loadImpl();
  const fn = resolveExport(mod, 'fetchSymbolSpecs');
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

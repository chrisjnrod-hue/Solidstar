// shim: src/bybit.js
// Tries multiple bybit candidate filenames and normalizes exports so other modules can:
//   - new BybitWS()  OR provide BybitWS constructor on export
//   - fetchKlines, fetchUsdtPerpetualSymbols, fetchSymbolSpecs, quantize, placeActiveOrder
// If not found, exports a minimal fallback with safe stubs.

const candidates = [
  './bybit.js',
  './src/bybit.js',
  './bybit (1).js',
  './bybit_v5.js',
  './src_bybit_Version1.js',
  './src/bybit_v1.js'
];

let mod = null;
for (const p of candidates) {
  try {
    mod = require(p);
    if (mod) {
      console.log(`bybit shim: loaded candidate ${p}`);
      break;
    }
  } catch (e) {
    // ignore and continue
  }
}

function unwrap(m) {
  if (!m) return null;
  if (typeof m === 'function') return m;
  if (m.default && (typeof m.default === 'function' || typeof m.default === 'object')) return m.default;
  return m;
}

const exported = unwrap(mod) || mod || {};

let BybitWS = null;
let fetchKlines = null;
let fetchUsdtPerpetualSymbols = null;
let fetchSymbolSpecs = null;
let quantize = null;
let placeActiveOrder = null;

if (exported) {
  if (typeof exported.BybitWS === 'function') BybitWS = exported.BybitWS;
  if (typeof exported === 'function') { /* module itself might be a constructor */ }
  if (typeof exported.fetchKlines === 'function') fetchKlines = exported.fetchKlines;
  if (typeof exported.fetchUsdtPerpetualSymbols === 'function') fetchUsdtPerpetualSymbols = exported.fetchUsdtPerpetualSymbols;
  if (typeof exported.fetchSymbolSpecs === 'function') fetchSymbolSpecs = exported.fetchSymbolSpecs;
  if (typeof exported.quantize === 'function') quantize = exported.quantize;
  if (typeof exported.placeActiveOrder === 'function') placeActiveOrder = exported.placeActiveOrder;

  // try default nested shape
  if (!BybitWS && exported.default && typeof exported.default.BybitWS === 'function') BybitWS = exported.default.BybitWS;
  if (!fetchKlines && exported.default && typeof exported.default.fetchKlines === 'function') fetchKlines = exported.default.fetchKlines;
}

// fallback minimal implementations
if (!BybitWS) {
  // provide a minimal stub constructor so `new BybitWS()` works
  BybitWS = class {
    constructor() {
      this.ws = null;
      this.subscriptions = new Set();
      this.callbacks = new Map();
      this.prices = new Map();
    }
    subscribeKline() { return () => {}; }
    subscribeTopic() { return () => {}; }
    getPrice(symbol) { return this.prices.get(symbol); }
    close() {}
  };
  console.warn('bybit shim: BybitWS constructor not found in exports; using fallback stub.');
}
if (!fetchKlines) {
  fetchKlines = async () => null;
}
if (!fetchUsdtPerpetualSymbols) {
  fetchUsdtPerpetualSymbols = async () => [];
}
if (!fetchSymbolSpecs) {
  fetchSymbolSpecs = async () => null;
}
if (!quantize) {
  quantize = (spec, qty) => ({ qty: Number(qty) || 0, isRounded: false, reason: 'no_spec' });
}
if (!placeActiveOrder) {
  placeActiveOrder = async () => { throw new Error('placeActiveOrder not available'); };
}

module.exports = {
  BybitWS,
  fetchKlines,
  fetchUsdtPerpetualSymbols,
  fetchTicker: exported.fetchTicker || (async () => null),
  fetchSymbolSpecs,
  quantize,
  placeActiveOrder
};
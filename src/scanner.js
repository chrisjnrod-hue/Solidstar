// src/scanner.js — Lazy loader wrapper for the scanner implementation
// This avoids probing candidate modules at require-time (prevents circular require warnings).
const CANDIDATES = [
  './scanner.js',
  './src/scanner.js',
  './src_scanner_Version6.js',
  './scanner_Version6.js',
  './src/scanner_Version6.js',
  './src_scanner.js',
  './scanner/index.js'
];

let cachedModule = null;
function loadImpl() {
  if (cachedModule) return cachedModule;
  for (const p of CANDIDATES) {
    try {
      const m = require(p);
      if (m) {
        cachedModule = m;
        // found; stop searching
        return cachedModule;
      }
    } catch (e) {
      // ignore - candidate not found or failed to load
    }
  }
  // nothing found -> keep cachedModule null
  return null;
}

// Safe accessor to get function from loaded module without probing at require time
function resolveFnsFromModule(mod) {
  if (!mod) return {};
  // If module is a function, treat it as scanRootTf
  if (typeof mod === 'function') return { scanRootTf: mod };
  // prefer direct properties
  const scanRootTf = (typeof mod.scanRootTf === 'function') ? mod.scanRootTf
    : (mod.default && typeof mod.default.scanRootTf === 'function' ? mod.default.scanRootTf : null);
  const publishSignalsAlways = (typeof mod.publishSignalsAlways === 'function') ? mod.publishSignalsAlways
    : (mod.default && typeof mod.default.publishSignalsAlways === 'function' ? mod.default.publishSignalsAlways : null);
  return { scanRootTf, publishSignalsAlways };
}

// Exported wrapper functions (lazy)
async function scanRootTf(rootTf) {
  const mod = loadImpl();
  const { scanRootTf: fn } = resolveFnsFromModule(mod);
  if (!fn) {
    // fallback empty results
    return [];
  }
  return await fn(rootTf);
}

async function publishSignalsAlways(signals) {
  const mod = loadImpl();
  const { publishSignalsAlways: fn } = resolveFnsFromModule(mod);
  if (!fn) return;
  return await fn(signals);
}

module.exports = {
  scanRootTf,
  publishSignalsAlways
};

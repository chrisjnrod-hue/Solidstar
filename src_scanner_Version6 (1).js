// src/scanner.js — Lazy loader wrapper for the scanner implementation (self-skip safe)

const CANDIDATES = [
  './src_scanner_Version6.js',
  './scanner_Version6.js',
  './src/scanner_Version6.js',
  './src_scanner.js',
  './scanner/index.js',
  // intentionally DO NOT include './scanner.js' because this file is src/scanner.js
];

let cachedModule = null;
function loadImpl() {
  if (cachedModule) return cachedModule;
  for (const p of CANDIDATES) {
    try {
      // resolve first and skip if it resolves to this file (prevents self-require recursion)
      const resolved = require.resolve(p);
      if (resolved === __filename) continue;
      const m = require(p);
      if (m) {
        cachedModule = m;
        return cachedModule;
      }
    } catch (e) {
      // ignore and continue
    }
  }
  // nothing found
  return null;
}

function resolveFnsFromModule(mod) {
  if (!mod) return {};
  if (typeof mod === 'function') return { scanRootTf: mod };
  const scanRootTf = (typeof mod.scanRootTf === 'function') ? mod.scanRootTf
    : (mod.default && typeof mod.default.scanRootTf === 'function' ? mod.default.scanRootTf : null);
  const publishSignalsAlways = (typeof mod.publishSignalsAlways === 'function') ? mod.publishSignalsAlways
    : (mod.default && typeof mod.default.publishSignalsAlways === 'function' ? mod.default.publishSignalsAlways : null);
  return { scanRootTf, publishSignalsAlways };
}

async function scanRootTf(rootTf) {
  const mod = loadImpl();
  const { scanRootTf: fn } = resolveFnsFromModule(mod);
  if (!fn) return [];
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
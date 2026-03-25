// shim: src/scanner.js
// Tries multiple candidate module paths, normalizes exports to provide:
//   - async function scanRootTf(rootTf) -> Array signals
//   - async function publishSignalsAlways(signals)
// If it can't find a real scanner, exports fallback stubs.

const candidates = [
  './scanner.js',
  './src/scanner.js',
  './src_scanner_Version6.js',
  './scanner_Version6.js',
  './src/scanner_Version6.js',
  './src_scanner.js',
  './scanner/index.js'
];

let mod = null;
for (const p of candidates) {
  try {
    // require.resolve may throw; require inside try to catch runtime errors too
    mod = require(p);
    if (mod) {
      // found something
      // console.log only if running locally; comment out in prod if noisy
      console.log(`scanner shim: loaded candidate ${p}`);
      break;
    }
  } catch (e) {
    // ignore and continue
  }
}

// helper to safely unwrap default exports
function unwrap(m) {
  if (!m) return null;
  if (typeof m === 'function') return m;
  if (m.default && (typeof m.default === 'function' || typeof m.default === 'object')) return m.default;
  return m;
}

const exported = unwrap(mod) || mod || {};

let scanRootTf = null;
let publishSignalsAlways = null;

if (exported) {
  if (typeof exported.scanRootTf === 'function') scanRootTf = exported.scanRootTf;
  if (typeof exported.publishSignalsAlways === 'function') publishSignalsAlways = exported.publishSignalsAlways;

  // if module itself is a function, treat as scanRootTf
  if (!scanRootTf && typeof exported === 'function') scanRootTf = exported;

  // check nested default properties
  if (!scanRootTf && exported.default && typeof exported.default.scanRootTf === 'function') {
    scanRootTf = exported.default.scanRootTf;
    publishSignalsAlways = exported.default.publishSignalsAlways || publishSignalsAlways;
  }
}

// final fallback stubs (safe)
if (!scanRootTf) {
  console.warn('scanner shim: scanRootTf not found — installing fallback stub (returns empty array).');
  scanRootTf = async (rootTf) => {
    return [];
  };
}
if (!publishSignalsAlways) {
  publishSignalsAlways = async (signals) => { /* no-op */ };
}

module.exports = {
  scanRootTf,
  publishSignalsAlways
};

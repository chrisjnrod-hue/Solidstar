// src/config.js
// Central configuration. Chooses Bybit endpoints automatically based on TESTNET flag
// and BYBIT_MARKET (spot|linear). You can override endpoints by setting
// BYBIT_WS_USE_ENV=true and/or BYBIT_BASE_API_USE_ENV=true and providing BYBIT_WS / BYBIT_BASE_API.

const env = process.env;

function parseBool(v, def = false) {
  if (v === undefined || v === null) return def;
  const s = String(v).toLowerCase().trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return def;
}
function parseFloatEnv(name, def) {
  const v = env[name];
  if (v === undefined) return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}
function parseIntEnv(name, def) {
  const v = env[name];
  if (v === undefined) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

// Choose market: "linear" (perpetual/derivatives) or "spot"
// Default is linear as the codebase appears to target perpetual instruments.
// Set BYBIT_MARKET=spot in your Render env if you want spot streams.
const BYBIT_MARKET = (env.BYBIT_MARKET || 'linear').toLowerCase();

// DEFAULT REST bases (v5 base hostnames). These base URLs are the canonical hosts.
// Note: scanner.js contains a v2 fallback; consider updating that to a v5 instruments endpoint later.
const DEFAULT_API_TESTNET = 'https://api-testnet.bybit.com';
const DEFAULT_API_MAINNET = 'https://api.bybit.com';

// DEFAULT websocket paths per market (v5)
const WS_PATH_BY_MARKET = {
  spot: '/v5/public/spot',
  linear: '/v5/public/linear'
};
const wsPath = WS_PATH_BY_MARKET[BYBIT_MARKET] || WS_PATH_BY_MARKET['linear'];

// Default WS endpoints (constructed with market path)
const DEFAULT_WS_TESTNET = `wss://stream-testnet.bybit.com${wsPath}`;
const DEFAULT_WS_MAINNET = `wss://stream.bybit.com${wsPath}`;

// Core flags
const TESTNET = parseBool(env.TESTNET, true);

// Decide whether to accept explicit env values (override) or to auto-select from TESTNET.
// If BYBIT_WS_USE_ENV=true, BYBIT_WS env will be used verbatim. Likewise for BYBIT_BASE_API_USE_ENV.
const BYBIT_WS_USE_ENV = parseBool(env.BYBIT_WS_USE_ENV, false);
const BYBIT_BASE_API_USE_ENV = parseBool(env.BYBIT_BASE_API_USE_ENV, false);

// Compute final endpoints
const BYBIT_WS = (BYBIT_WS_USE_ENV && env.BYBIT_WS)
  ? env.BYBIT_WS
  : (TESTNET ? DEFAULT_WS_TESTNET : DEFAULT_WS_MAINNET);

const BYBIT_BASE_API = (BYBIT_BASE_API_USE_ENV && env.BYBIT_BASE_API)
  ? env.BYBIT_BASE_API
  : (TESTNET ? DEFAULT_API_TESTNET : DEFAULT_API_MAINNET);

// Other common configs (keep existing / previous values you used)
module.exports = {
  // basic
  PORT: parseIntEnv('PORT', 3000),
  NODE_ENV: env.NODE_ENV || 'production',

  // bybit endpoints & flags
  TESTNET,
  BYBIT_MARKET,
  BYBIT_WS,
  BYBIT_BASE_API,
  BYBIT_WS_USE_ENV,
  BYBIT_BASE_API_USE_ENV,

  // breakeven / other settings (preserve previous default reading)
  BREAKEVEN_TRIGGER_PERCENT: parseFloatEnv('BREAKEVEN_TRIGGER_PERCENT', parseFloatEnv('BREAKEVEN_PERCENT', 1.0)),
  BREAKEVEN_ALIGN_TO_ROUND_HOUR: parseBool(env.BREAKEVEN_ALIGN_TO_ROUND_HOUR, true),
  BREAKEVEN_BUFFER_PCT: parseFloatEnv('BREAKEVEN_BUFFER_PCT', 0.0),
  BREAKEVEN_MIN_SECONDS_AFTER_ENTRY: parseIntEnv('BREAKEVEN_MIN_SECONDS_AFTER_ENTRY', 0),

  // other defaults that your app may use (add or keep as needed)
  OPEN_TRADES: parseBool(env.OPEN_TRADES, false),
  REST_CONCURRENCY: parseIntEnv('REST_CONCURRENCY', 12),
  MAX_SCAN_SYMBOLS: parseIntEnv('MAX_SCAN_SYMBOLS', 0),

  // verbose WS debugging
  WS_VERBOSE: parseBool(env.WS_VERBOSE, false)
};
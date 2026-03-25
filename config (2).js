// src/config.js
// Central configuration. Choose Bybit endpoints based on TESTNET flag.
// BREAKEVEN_PERCENT: when triggered, SL moves to entry ± this percent

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

const BYBIT_MARKET = (env.BYBIT_MARKET || 'linear').toLowerCase();

const DEFAULT_API_TESTNET = 'https://api-testnet.bybit.com';
const DEFAULT_API_MAINNET = 'https://api.bybit.com';

const WS_PATH_BY_MARKET = {
  spot: '/v5/public/spot',
  linear: '/v5/public/linear'
};
const wsPath = WS_PATH_BY_MARKET[BYBIT_MARKET] || WS_PATH_BY_MARKET['linear'];

const DEFAULT_WS_TESTNET = `wss://stream-testnet.bybit.com${wsPath}`;
const DEFAULT_WS_MAINNET = `wss://stream.bybit.com${wsPath}`;

const TESTNET = parseBool(env.TESTNET, true);
const BYBIT_WS_USE_ENV = parseBool(env.BYBIT_WS_USE_ENV, false);
const BYBIT_BASE_API_USE_ENV = parseBool(env.BYBIT_BASE_API_USE_ENV, false);

const BYBIT_WS = BYBIT_WS_USE_ENV && env.BYBIT_WS
  ? env.BYBIT_WS
  : (TESTNET ? DEFAULT_WS_TESTNET : DEFAULT_WS_MAINNET);

const BYBIT_BASE_API = BYBIT_BASE_API_USE_ENV && env.BYBIT_BASE_API
  ? env.BYBIT_BASE_API
  : (TESTNET ? DEFAULT_API_TESTNET : DEFAULT_API_MAINNET);

module.exports = {
  PORT: parseIntEnv('PORT', 3000),
  NODE_ENV: env.NODE_ENV || 'production',

  TESTNET,
  BYBIT_MARKET,
  BYBIT_WS,
  BYBIT_BASE_API,
  BYBIT_WS_USE_ENV,
  BYBIT_BASE_API_USE_ENV,

  // BREAKEVEN: simple percentage (when triggered, SL moves to entry ± this percent)
  BREAKEVEN_PERCENT: parseFloatEnv('BREAKEVEN_PERCENT', 0.5),
  BREAKEVEN_TRIGGER_PERCENT: parseFloatEnv('BREAKEVEN_TRIGGER_PERCENT', parseFloatEnv('BREAKEVEN_PERCENT', 1.0)),
  BREAKEVEN_ALIGN_TO_ROUND_HOUR: parseBool(env.BREAKEVEN_ALIGN_TO_ROUND_HOUR, true),
  BREAKEVEN_MIN_SECONDS_AFTER_ENTRY: parseIntEnv('BREAKEVEN_MIN_SECONDS_AFTER_ENTRY', 0),

  OPEN_TRADES: parseBool(env.OPEN_TRADES, false),
  REST_CONCURRENCY: parseIntEnv('REST_CONCURRENCY', 12),
  MAX_SCAN_SYMBOLS: parseIntEnv('MAX_SCAN_SYMBOLS', 0),

  WS_VERBOSE: parseBool(env.WS_VERBOSE, false)
};
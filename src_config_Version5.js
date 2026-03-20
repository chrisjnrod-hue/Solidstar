// Central configuration read from environment variables with sensible defaults.
// Add any additional app config you already have here.

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

module.exports = {
  // Basic
  PORT: parseIntEnv('PORT', 3000),
  NODE_ENV: env.NODE_ENV || 'production',

  // Bybit endpoints and toggles (used elsewhere)
  TESTNET: parseBool(env.TESTNET, true),
  BYBIT_BASE_API: env.BYBIT_BASE_API || (parseBool(env.TESTNET, true) ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com'),
  BYBIT_WS: env.BYBIT_WS || (parseBool(env.TESTNET, true) ? 'wss://stream-testnet.bybit.com/realtime' : 'wss://stream.bybit.com/realtime'),

  // Breakeven controls
  // If the trade's unrealized PnL (percent) >= BREAKEVEN_TRIGGER_PERCENT => move SL to breakeven.
  BREAKEVEN_TRIGGER_PERCENT: parseFloatEnv('BREAKEVEN_TRIGGER_PERCENT', parseFloatEnv('BREAKEVEN_PERCENT', 1.0)),

  // If true, apply breakeven at the next top-of-hour if trigger percent hasn't been hit yet.
  BREAKEVEN_ALIGN_TO_ROUND_HOUR: parseBool(env.BREAKEVEN_ALIGN_TO_ROUND_HOUR, true),

  // Optional tiny price buffer (percent) applied to breakeven to avoid immediate stop-out due to spread.
  // Example: 0.02 means set SL to entryPrice + 0.02% for buys (small protective buffer).
  BREAKEVEN_BUFFER_PCT: parseFloatEnv('BREAKEVEN_BUFFER_PCT', 0.0),

  // Controls for breakeven runner frequency (index.js schedules hourly already, but keep values here)
  BREAKEVEN_MIN_SECONDS_AFTER_ENTRY: parseIntEnv('BREAKEVEN_MIN_SECONDS_AFTER_ENTRY', 0),

  // WS debug
  WS_VERBOSE: parseBool(env.WS_VERBOSE, false)
};
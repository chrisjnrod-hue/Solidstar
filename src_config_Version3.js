require('dotenv').config();

const cfg = {
  BYBIT_API_KEY: process.env.BYBIT_API_KEY || '',
  BYBIT_API_SECRET: process.env.BYBIT_API_SECRET || '',
  BYBIT_BASE_API: process.env.BYBIT_BASE_API || 'https://api-testnet.bybit.com',
  BYBIT_WS: process.env.BYBIT_WS || 'wss://stream-testnet.bybit.com/realtime',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  TESTNET: (process.env.TESTNET || 'false') === 'true',
  OPEN_TRADES: (process.env.OPEN_TRADES || 'false') === 'true',
  TP_PERCENT: parseFloat(process.env.TP_PERCENT || '1.5'),
  SL_PERCENT: parseFloat(process.env.SL_PERCENT || '1.0'),
  BREAKEVEN_PERCENT: parseFloat(process.env.BREAKEVEN_PERCENT || '0.5'),
  LEVERAGE: parseInt(process.env.LEVERAGE || '10'),
  MAX_OPEN_TRADES: parseInt(process.env.MAX_OPEN_TRADES || '3'),
  REST_CONCURRENCY: parseInt(process.env.REST_CONCURRENCY || '12'),
  SCAN_TIMEOUT_SECONDS: parseInt(process.env.SCAN_TIMEOUT_SECONDS || '55'),
  SCAN_INTERVAL_SECONDS: parseInt(process.env.SCAN_INTERVAL_SECONDS || '60'),
  REDIS_URL: process.env.REDIS_URL || '',
  API_MAX_RETRIES: parseInt(process.env.API_MAX_RETRIES || '5'),
  API_RETRY_BASE_MS: parseInt(process.env.API_RETRY_BASE_MS || '300'),
  PORT: parseInt(process.env.PORT || '3000')
};

module.exports = cfg;
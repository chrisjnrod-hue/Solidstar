// src/index.js (startup diagnostics snippet — add near the top after requires)

const cfg = localRequire('config');
// ... existing code ...

// Startup diagnostics (non-sensitive): show presence/values that help debug env wiring
console.log('Startup diag: TELEGRAM configured?', !!(process.env.TELEGRAM_BOT_TOKEN || cfg.TELEGRAM_BOT_TOKEN), 'CHAT_ID present?', !!(process.env.TELEGRAM_CHAT_ID || cfg.TELEGRAM_CHAT_ID));
console.log('Startup diag: FILTER_MTF=', process.env.FILTER_MTF, 'DEBUG_FILTERS=', process.env.DEBUG_FILTERS);
console.log('Startup diag: VOL_MULTIPLIER_1H=', process.env.VOL_MULTIPLIER_1H, 'HIST_Z_THRESHOLD_1H=', process.env.HIST_Z_THRESHOLD_1H, 'MIN_AVG_VOLUME_1H=', process.env.MIN_AVG_VOLUME_1H);

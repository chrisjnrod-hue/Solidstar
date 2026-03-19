const axios = require('axios');
const cfg = require('./config');

async function sendTelegram(message) {
  if (!cfg.TELEGRAM_BOT_TOKEN || !cfg.TELEGRAM_CHAT_ID) {
    console.warn('Telegram not configured; skipping message.');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: cfg.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
  } catch (err) {
    console.error('Telegram send failed', err?.response?.data || err.message);
  }
}

module.exports = { sendTelegram };
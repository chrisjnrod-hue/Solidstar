// src/telegram.js (small change: prefer env and log presence rather than silent skip)

const axios = require('axios');
const cfg = require('./config');

const TELEGRAM_BOT_TOKEN = cfg.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = cfg.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('Telegram not configured; skipping message.');
    // For diagnostics: log presence of envs (but DO NOT log token value)
    if (process.env.DEBUG_FILTERS === 'true') {
      console.log('Telegram env presence:', {
        hasBotToken: !!process.env.TELEGRAM_BOT_TOKEN,
        hasChatId: !!process.env.TELEGRAM_CHAT_ID,
        TELEGRAM_ALWAYS_PUSH_SIGNALS: process.env.TELEGRAM_ALWAYS_PUSH_SIGNALS
      });
    }
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
  } catch (err) {
    console.error('Telegram send failed', err?.response?.data || err.message);
  }
}

module.exports = { sendTelegram };
// src/telegram.js
// Robust Telegram helper: exports sendTelegram and sendMessage (alias).
// Returns a result object { ok: true, data } on success, or a structured error on failure.

const axios = require('axios');
const cfg = require('./config');

const TELEGRAM_BOT_TOKEN = (cfg && cfg.TELEGRAM_BOT_TOKEN) || process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = (cfg && cfg.TELEGRAM_CHAT_ID) || process.env.TELEGRAM_CHAT_ID || '';

// sendMessage: text is required. opts may contain { parse_mode: 'Markdown'|'HTML'|'MarkdownV2', disable_web_page_preview: true }
async function sendTelegram(text, opts = {}) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    const msg = 'Telegram not configured (missing token or chat id).';
    console.warn(msg);
    return { ok: false, error: msg };
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = Object.assign({
      chat_id: TELEGRAM_CHAT_ID,
      text: String(text || ''),
    }, opts);

    // Avoid sending empty messages
    if (!payload.text || payload.text.trim().length === 0) {
      return { ok: false, error: 'empty message' };
    }

    const res = await axios.post(url, payload, { timeout: 10000 });
    // Telegram returns { ok: true, result: {...} } on success
    if (res && res.data && res.data.ok) {
      return { ok: true, data: res.data };
    } else {
      // Unexpected structure
      console.error('Telegram unexpected response', res && res.data);
      return { ok: false, error: 'unexpected-response', data: res && res.data };
    }
  } catch (err) {
    // Log helpful details for debugging
    const respData = err?.response?.data;
    const status = err?.response?.status;
    console.error('Telegram send failed', { status, respData, message: err.message });
    // return structured error so callers can inspect and bubble to logs/notifications
    return { ok: false, error: err.message, status, respData };
  }
}

// Keep export names permissive so index.js can call sendMessage or sendTelegram
module.exports = {
  sendTelegram,
  sendMessage: sendTelegram,
};
// src/bybit.js
// Bybit helpers: BybitWS class + REST helpers (public) + authenticated signed REST helpers for v5
// Added: fetchSymbolSpecs(symbol) and quantize(spec, qty) for robust qty rounding.

const WebSocket = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const cfg = require('./config');

let reconnectAttempts = 0;
const baseReconnectMs = 1000;
const maxReconnectMs = 60000;

function backoffMs(attempts) {
  const jitter = Math.floor(Math.random() * 800);
  const ms = Math.min(maxReconnectMs, Math.round(baseReconnectMs * Math.pow(1.8, attempts))) + jitter;
  return ms;
}

/* ---------- BybitWS (heartbeat/pong, subscribe logging) ---------- */
class BybitWS {
  constructor() {
    this.ws = null;
    this.subscriptions = new Set();
    this.callbacks = new Map();
    this.prices = new Map();
    this._closedByUser = false;
    this._heartbeat = null;
    this.connect();
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this._heartbeat = setInterval(() => {
      try {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (cfg.WS_VERBOSE) console.log('BybitWS: heartbeat send (ws.ping)');
        try { this.ws.ping(); } catch (e) {}
      } catch (e) {
        if (cfg.WS_VERBOSE) console.warn('BybitWS heartbeat error', e && e.message);
      }
    }, 20 * 1000);
  }
  stopHeartbeat() {
    if (this._heartbeat) { clearInterval(this._heartbeat); this._heartbeat = null; }
  }

  connect() {
    const url = cfg.BYBIT_WS;
    console.log(`BybitWS: connecting to ${url}`);
    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        reconnectAttempts = 0;
        console.log('BybitWS: connected');
        try { this.startHeartbeat(); } catch (e) {}
        for (const s of this.subscriptions) {
          try {
            const msg = JSON.stringify({ op: 'subscribe', args: [s] });
            if (cfg.WS_VERBOSE) console.log('BybitWS: sending subscribe:', msg);
            this.ws.send(msg);
          } catch (e) {}
        }
      });

      this.ws.on('unexpected-response', (req, res) => {
        try {
          const status = res && res.statusCode;
          const statusMsg = res && res.statusMessage;
          console.error('BybitWS unexpected-response', { status, statusMsg });
          let body = '';
          res.on('data', (chunk) => { body += chunk.toString(); });
          res.on('end', () => {
            if (body && body.length) console.error('BybitWS unexpected-response body (trimmed):', body.slice(0,2000));
          });
        } catch (e) {
          console.error('BybitWS unexpected-response handler failed', e && e.stack);
        }
      });

      this.ws.on('message', (d) => {
        if (cfg.WS_VERBOSE) {
          try { console.log('BybitWS (verbose) raw message:', d.toString().slice(0,2000)); } catch (e) {}
        }
        let msg;
        try { msg = JSON.parse(d.toString()); } catch (e) {
          if (cfg.WS_VERBOSE) console.warn('BybitWS: received non-JSON message');
          return;
        }
        if (cfg.WS_VERBOSE) {
          const isSubResp = msg && (msg.request || msg.success === false || msg.retCode || msg.ret_code || msg.topic || msg.type);
          if (isSubResp) {
            try { console.log('BybitWS (verbose) parsed:', JSON.stringify(msg).slice(0,2000)); } catch (e) {}
          }
        }

        // maintain price cache if trade messages
        if (msg && msg.data && Array.isArray(msg.data) && msg.topic && (msg.topic.startsWith('trade') || msg.topic.includes('trade'))) {
          const entry = msg.data[0];
          if (entry && entry.symbol && (entry.price || entry.last_price || entry.p)) {
            const p = entry.price || entry.last_price || entry.p;
            this.prices.set(entry.symbol, parseFloat(p));
          }
        }

        // handle server ping -> respond with ws.pong() frame (low level)
        if (msg.op === 'ping' || msg.type === 'ping') {
          if (cfg.WS_VERBOSE) console.log('BybitWS: received server ping; sending ws.pong()');
          try { this.ws.pong(); } catch (e) { if (cfg.WS_VERBOSE) console.warn('BybitWS: ws.pong() failed', e && e.message); }
          return;
        }

        if (msg.topic && this.callbacks.has(msg.topic)) {
          try { this.callbacks.get(msg.topic)(msg); } catch (e) { if (cfg.WS_VERBOSE) console.warn('BybitWS: callback error', e && e.message); }
        }
      });

      this.ws.on('error', (err) => {
        try {
          console.error('BybitWS error', { message: err && err.message, stack: err && err.stack, code: err && err.code });
        } catch (e) { console.error('BybitWS error logging failed', e && e.message); }
      });

      this.ws.on('close', (code, reason) => {
        try { this.stopHeartbeat(); } catch (e) {}
        if (this._closedByUser) { console.log('BybitWS closed by user request', { code, reason: reason && reason.toString() }); return; }
        reconnectAttempts++;
        const ms = backoffMs(reconnectAttempts);
        const reasonStr = (reason && (reason.toString ? reason.toString() : String(reason))) || '';
        console.warn(`BybitWS closed (code=${code}) reason=${reasonStr} - reconnecting in ${ms}ms (attempt ${reconnectAttempts})`);
        setTimeout(() => this.connect(), ms);
      });
    } catch (e) {
      console.error('BybitWS connect exception', e && e.stack);
      reconnectAttempts++;
      const ms = backoffMs(reconnectAttempts);
      setTimeout(() => this.connect(), ms);
    }
  }

  subscribeKline(symbol, interval, cb) {
    const topic = `klineV2.${interval}.${symbol}`;
    this.subscriptions.add(topic);
    if (typeof cb === 'function') this.callbacks.set(topic, cb);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const msg = JSON.stringify({ op: 'subscribe', args: [topic] });
        if (cfg.WS_VERBOSE) console.log('BybitWS: subscribeKline send:', msg);
        this.ws.send(msg);
      } catch (e) { console.warn('subscribe send failed', e && e.message); }
    }
    return () => {
      this.subscriptions.delete(topic);
      this.callbacks.delete(topic);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) { try { this.ws.send(JSON.stringify({ op: 'unsubscribe', args: [topic] })); } catch (e) {} }
    };
  }

  subscribeTopic(topic, cb) {
    this.subscriptions.add(topic);
    if (typeof cb === 'function') this.callbacks.set(topic, cb);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const msg = JSON.stringify({ op: 'subscribe', args: [topic] });
        if (cfg.WS_VERBOSE) console.log('BybitWS: subscribeTopic send:', msg);
        this.ws.send(msg);
      } catch (e) { console.warn('subscribeTopic send failed', e && e.message); }
    }
    return () => {
      this.subscriptions.delete(topic);
      this.callbacks.delete(topic);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) { try { this.ws.send(JSON.stringify({ op: 'unsubscribe', args: [topic] })); } catch (e) {} }
    };
  }

  getPrice(symbol) { return this.prices.get(symbol); }
  close() { this._closedByUser = true; try { if (this.ws) this.ws.close(); } catch (e) {} }
}

/* ---------- REST helpers used by scanner (public) ---------- */

function v5IntervalFrom(intervalApi) {
  return String(intervalApi);
}

async function fetchKlines(symbol, intervalApi, limit = 200) {
  try {
    const base = (cfg.BYBIT_BASE_API || 'https://api-testnet.bybit.com').replace(/\/$/, '');
    const category = (cfg.BYBIT_MARKET === 'spot') ? 'spot' : 'linear';
    const interval = v5IntervalFrom(intervalApi);
    const url = `${base}/v5/market/kline?category=${encodeURIComponent(category)}&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`;
    const res = await axios.get(url, { timeout: 10000 });
    const data = res && res.data;
    if (!data) return null;
    const list = (data.result && data.result.list) ? data.result.list : (data.result || []);
    if (!Array.isArray(list)) return null;
    const out = list.map((it) => {
      if (Array.isArray(it)) {
        const t = Number(it[0]);
        return { t, open: String(it[1]), high: String(it[2]), low: String(it[3]), close: String(it[4]), volume: Number(it[5] || it[6] || 0) };
      } else if (it && (it.open || it.close || it.ts || it.volume)) {
        return {
          t: it.openTime || it.ts || it.start_at || it.start_at_ms || it.openTimestamp || it.id || 0,
          open: it.open !== undefined ? String(it.open) : String(it.o || ''),
          high: it.high !== undefined ? String(it.high) : String(it.h || ''),
          low: it.low !== undefined ? String(it.low) : String(it.l || ''),
          close: it.close !== undefined ? String(it.close) : String(it.c || ''),
          volume: Number(it.volume || it.v || 0)
        };
      } else {
        return null;
      }
    }).filter(Boolean);
    return out;
  } catch (e) {
    const status = (e && e.response && e.response.status) ? e.response.status : null;
    const msg = e && e.message;
    console.warn('bybit.fetchKlines error', msg, status ? `status=${status}` : '');
    return null;
  }
}

async function fetchUsdtPerpetualSymbols() {
  try {
    const base = (cfg.BYBIT_BASE_API || 'https://api-testnet.bybit.com').replace(/\/$/, '');
    const category = (cfg.BYBIT_MARKET === 'spot') ? 'spot' : 'linear';
    const url = `${base}/v5/market/instruments-info?category=${encodeURIComponent(category)}`;
    const res = await axios.get(url, { timeout: 10000 });
    const data = res && res.data;
    if (!data) return [];
    const list = (data.result && data.result.list) ? data.result.list : (data.result || []);
    if (!Array.isArray(list)) return [];
    const symbols = [];
    for (const it of list) {
      const sym = it.symbol || it.name;
      const quote = (it.quoteCoin || it.quote_coin || it.quote || it.quoteAsset || it.quote_asset);
      const status = (it.status || it.state || '').toString().toLowerCase();
      if (!sym) continue;
      if (quote && String(quote).toUpperCase() === 'USDT' && (status === '' || status === 'tradable' || status === 'listed' || status === 'online' || status === 'normal')) {
        symbols.push(sym);
      }
    }
    if (symbols.length) return symbols;
    return list.map(r => r.symbol || r.name).filter(Boolean);
  } catch (e) {
    const status = (e && e.response && e.response.status) ? e.response.status : null;
    console.warn('bybit.fetchUsdtPerpetualSymbols error', e && e.message, status ? `status=${status}` : '');
    return [];
  }
}

async function fetchTicker(symbol) {
  try {
    const base = (cfg.BYBIT_BASE_API || 'https://api-testnet.bybit.com').replace(/\/$/, '');
    const category = (cfg.BYBIT_MARKET === 'spot') ? 'spot' : 'linear';
    const url = `${base}/v5/market/ticker/24hr?category=${encodeURIComponent(category)}&symbol=${encodeURIComponent(symbol)}`;
    const res = await axios.get(url, { timeout: 8000 });
    const data = res && res.data;
    if (!data) return null;
    const r = data.result && data.result.list && data.result.list[0] ? data.result.list[0] : (data.result || {});
    const out = {};
    if (r) {
      out.lastPrice = r.lastPrice || r.last || r.last_price || r.price;
      out.price = out.lastPrice;
    }
    return out;
  } catch (e) {
    if (cfg.WS_VERBOSE) console.warn('bybit.fetchTicker error', e && e.message);
    return null;
  }
}

/* ---------- Instrument specs & quantize ---------- */

/**
 * fetchSymbolSpecs(symbol)
 * returns normalized spec object:
 * { symbol, baseCoin, quoteCoin, category, minQty, maxQty, qtyStep, tickSize, priceFilterMin, priceFilterMax }
 */
async function fetchSymbolSpecs(symbol) {
  try {
    const base = (cfg.BYBIT_BASE_API || 'https://api-testnet.bybit.com').replace(/\/$/, '');
    const category = (cfg.BYBIT_MARKET === 'spot') ? 'spot' : 'linear';
    const url = `${base}/v5/market/instruments-info?category=${encodeURIComponent(category)}&symbol=${encodeURIComponent(symbol)}`;
    const res = await axios.get(url, { timeout: 8000 });
    const data = res && res.data;
    if (!data) return null;
    const item = (data.result && data.result.list && data.result.list[0]) ? data.result.list[0] : (data.result || null);
    if (!item) return null;
    // normalize common fields across possible shapes
    const lot = item.lotSizeFilter || item.lotSize || item.lot_size_filter || item.lotSizeInfo || {};
    const price = item.priceFilter || item.price_filter || {};
    const spec = {
      symbol: item.symbol || item.name || symbol,
      baseCoin: item.baseCoin || item.base_coin || item.baseCurrency || item.base,
      quoteCoin: item.quoteCoin || item.quote_coin || item.quoteCurrency || item.quote,
      category: category,
      minQty: Number(lot.min_trading_qty || lot.minQty || lot.minQuantity || lot.min || lot.min_trade_qty || 0) || 0,
      maxQty: Number(lot.max_trading_qty || lot.maxQty || lot.maxQuantity || lot.max || 0) || Number.MAX_SAFE_INTEGER,
      qtyStep: Number(lot.qty_step || lot.stepSize || lot.qtyStep || lot.step || 1) || 1,
      tickSize: Number(price.tickSize || price.tick || price.priceFilter || price.minPrice || 0) || 0,
      priceFilterMin: Number(price.min_price || price.minPrice || price.min) || 0,
      priceFilterMax: Number(price.max_price || price.maxPrice || price.max) || Number.MAX_SAFE_INTEGER
    };
    return spec;
  } catch (e) {
    if (cfg.WS_VERBOSE) console.warn('fetchSymbolSpecs error', e && (e.response && e.response.status) || e && e.message);
    return null;
  }
}

/**
 * quantize(spec, qty)
 * - rounds qty down to the nearest qtyStep
 * - clamps to minQty..maxQty
 * - returns { qty, isRounded, reason }
 */
function quantize(spec, qtyRaw) {
  const result = { qty: null, isRounded: false, reason: '' };
  if (!spec) {
    result.qty = Number(qtyRaw);
    result.reason = 'no_spec';
    return result;
  }
  let qty = Number(qtyRaw);
  if (!Number.isFinite(qty) || qty <= 0) {
    result.qty = 0;
    result.reason = 'invalid_qty';
    return result;
  }
  const step = Number(spec.qtyStep || 1) || 1;
  const minQ = Number(spec.minQty || 0) || 0;
  const maxQ = Number(spec.maxQty || Number.MAX_SAFE_INTEGER) || Number.MAX_SAFE_INTEGER;

  // Round down to nearest step: qtyRounded = floor(qty / step) * step
  const factor = Math.round(1 / step) >= 1 ? Math.round(1 / step) : null;
  let qtyRounded;
  if (factor && Number.isFinite(factor) && factor > 0 && Math.abs(step - Math.round(step)) > 1e-12) {
    // fractional step like 0.001 -> use integer math
    qtyRounded = Math.floor(qty / step) * step;
    // fix floating rounding
    qtyRounded = Number(qtyRounded.toFixed(12));
  } else {
    qtyRounded = Math.floor(qty / step) * step;
  }

  // clamp
  if (qtyRounded < minQ) qtyRounded = minQ;
  if (qtyRounded > maxQ) qtyRounded = maxQ;

  // ensure not zero
  if (qtyRounded <= 0 && minQ > 0) qtyRounded = minQ;

  result.qty = qtyRounded;
  result.isRounded = Math.abs(result.qty - qty) > 1e-12;
  result.reason = 'ok';
  return result;
}

/* ---------- Authenticated helpers for Bybit V5 (signed REST) ---------- */

function getV5Timestamp() {
  return Date.now().toString();
}

function signV5Request(secret, timestamp, method, requestPath, bodyString) {
  const prehash = timestamp + method.toUpperCase() + requestPath + (bodyString || '');
  return crypto.createHmac('sha256', secret).update(prehash).digest('hex');
}

function authHeaders(apiKey, apiSecret, method, requestPath, body = {}) {
  const ts = getV5Timestamp();
  const bodyStr = (body && Object.keys(body).length) ? JSON.stringify(body) : '';
  const sign = signV5Request(apiSecret, ts, method, requestPath, bodyStr);
  return {
    'Content-Type': 'application/json',
    'X-BAPI-API-KEY': apiKey,
    'X-BAPI-TIMESTAMP': ts,
    'X-BAPI-SIGN': sign,
    'X-BAPI-RECV-WINDOW': '5000',
    'X-BAPI-SIGN-TYPE': '2'
  };
}

/**
 * placeActiveOrder(payload)
 */
async function placeActiveOrder(payload) {
  const apiKey = process.env.BYBIT_API_KEY || cfg.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET || cfg.BYBIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    const msg = 'placeActiveOrder: BYBIT_API_KEY or BYBIT_API_SECRET not set';
    console.warn(msg);
    throw new Error(msg);
  }
  try {
    const base = (cfg.BYBIT_BASE_API || 'https://api-testnet.bybit.com').replace(/\/$/, '');
    const requestPath = '/v5/order/create';
    const url = `${base}${requestPath}`;
    const method = 'POST';
    const body = Object.assign({}, payload);
    const headers = authHeaders(apiKey, apiSecret, method, requestPath, body);
    const res = await axios.post(url, body, { headers, timeout: 10000 });
    return res && res.data ? res.data : res;
  } catch (e) {
    const bodyErr = e && e.response && e.response.data ? e.response.data : null;
    console.error('placeActiveOrder error', e && e.message, bodyErr || '');
    throw e;
  }
}

module.exports = {
  BybitWS,
  fetchKlines,
  fetchUsdtPerpetualSymbols,
  fetchTicker,
  fetchSymbolSpecs,
  quantize,
  placeActiveOrder
};

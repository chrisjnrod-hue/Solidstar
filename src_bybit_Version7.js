/* Bybit API utilities with hybrid kline caching (closed-history cached, newest bars fetched fresh),
   per-timeframe freshCount tuning, and cache stampede protection (Redis-backed locks or in-memory fallback).
   This file preserves existing API helpers (v5 order endpoints, WS, etc.) and only augments fetchKlines behavior.
*/

const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');
const cfg = require('./config');
const { retryWithBackoff, quantizePrice, quantizeQty, sleep } = require('./utils');

// Optional Redis cache for hybrid kline caching + locks, fallback to in-memory
let cacheRedis = null;
let cacheFallback = new Map();
let lockFallback = new Map();

if (cfg.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    cacheRedis = new Redis(cfg.REDIS_URL);
    cacheRedis.on('error', (e) => console.error('Cache Redis error', e));
    console.log('Bybit: using Redis cache for klines and locks');
  } catch (e) {
    console.warn('Bybit: failed to init Redis cache, using in-memory fallback', e.message);
    cacheRedis = null;
  }
} else {
  console.log('Bybit: no REDIS_URL — using in-memory kline cache and lock fallback');
}

async function cacheGet(key) {
  if (cacheRedis) {
    const v = await cacheRedis.get(key);
    return v ? JSON.parse(v) : null;
  } else {
    const ent = cacheFallback.get(key);
    if (!ent) return null;
    if (Date.now() > ent.expireAt) {
      cacheFallback.delete(key);
      return null;
    }
    return ent.value;
  }
}

async function cacheSet(key, value, ttlSeconds = 3600) {
  if (cacheRedis) {
    await cacheRedis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } else {
    cacheFallback.set(key, { value, expireAt: Date.now() + ttlSeconds * 1000 });
  }
}

async function cacheDel(key) {
  if (cacheRedis) {
    await cacheRedis.del(key);
  } else {
    cacheFallback.delete(key);
  }
}

// Stampede-protection lock helpers
async function acquireLock(key, ttlMs = 15000) {
  if (cacheRedis) {
    const token = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const ok = await cacheRedis.set(`${key}:lock`, token, 'NX', 'PX', ttlMs);
    if (ok) return token;
    return null;
  } else {
    if (lockFallback.has(key)) return null;
    // create deferred
    let resolve;
    const p = new Promise(r => { resolve = r; });
    lockFallback.set(key, { promise: p, resolve, createdAt: Date.now() });
    return { mem: true }; // token placeholder
  }
}

async function releaseLock(key, token) {
  if (cacheRedis) {
    // safe release using Lua to avoid deleting others' locks
    const lua = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    try {
      await cacheRedis.eval(lua, 1, `${key}:lock`, token);
    } catch (e) {
      // best-effort
      await cacheRedis.del(`${key}:lock`).catch(() => {});
    }
  } else {
    const entry = lockFallback.get(key);
    if (entry) {
      // resolve waiting promises
      entry.resolve();
      lockFallback.delete(key);
    }
  }
}

async function waitForLockReleaseOrCache(key, cacheKey, waitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    // check cache first
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;
    // check lock existence
    if (cacheRedis) {
      const lockExists = await cacheRedis.get(`${cacheKey}:lock`);
      if (!lockExists) {
        // no lock and no cache -> likely fetch failed; return null to allow fallback fetch
        const nowCached = await cacheGet(cacheKey);
        if (nowCached) return nowCached;
        return null;
      }
    } else {
      if (!lockFallback.has(cacheKey)) {
        const nowCached = await cacheGet(cacheKey);
        if (nowCached) return nowCached;
        return null;
      } else {
        // wait for the in-memory promise to resolve (with timeout)
        const entry = lockFallback.get(cacheKey);
        if (entry) {
          try {
            await Promise.race([entry.promise, sleep(5000)]);
          } catch (e) {}
        } else {
          await sleep(200);
        }
      }
    }
    await sleep(200);
  }
  return null;
}

const BASE = cfg.BYBIT_BASE_API.replace(/\/$/, '');
const WS_BASE = cfg.BYBIT_WS;

// v5 signing helper
function signV5(timestamp, apiKey, secret, recvWindow, body = '') {
  const toSign = timestamp + apiKey + recvWindow + body;
  return crypto.createHmac('sha256', secret).update(toSign).digest('hex');
}

// Generic GET with retry
async function apiGet(path, params = {}, headers = {}) {
  return retryWithBackoff(async () => {
    const res = await axios.get(`${BASE}${path}`, { params, headers, timeout: 20000 });
    return res.data;
  });
}

// Generic POST with retry
async function apiPost(path, body = {}, headers = {}) {
  return retryWithBackoff(async () => {
    const res = await axios.post(`${BASE}${path}`, body, { headers, timeout: 20000 });
    return res.data;
  });
}

// Fetch USDT perpetual symbols (no caching here — upstream caller caches if desired)
async function fetchUsdtPerpetualSymbols() {
  try {
    const v2 = await apiGet('/v2/public/symbols');
    if (v2 && v2.result) return v2.result.filter(s => s.quote_currency === 'USDT' && s.status === 'Trading').map(s => s.symbol);
  } catch (e) { /* fallthrough */ }
  try {
    const v5 = await apiGet('/v5/market/tickers');
    if (v5 && v5.result && v5.result.list) return v5.result.list.filter(s => s.quoteCurrency === 'USDT' && s.status === 'Trading').map(s => s.symbol);
  } catch (e) {}
  return [];
}

/*
 Hybrid kline caching strategy with per-timeframe freshCount and stampede protection:
 - Per-timeframe freshCount determines how many newest bars are always fetched fresh.
 - closedCount = limit - freshCount is the portion cached and reused.
 - If closed cached portion exists and is long enough, only fetch the fresh newest bars and concat.
 - If missing, acquire lock (Redis or in-memory). The fetcher populates cache, others wait for cache or lock release.
 - TTL for closed portion is 3600s by default.
*/

// Per-timeframe freshCount tuning (interval values as used by API)
const freshCountMap = {
  // minute-based intervals
  '1': 1,      // 1m: keep 1 fresh
  '3': 1,
  '5': 3,      // 5m: fetch last 3 fresh bars to be safe for fast TFs
  '15': 2,     // 15m: 2 fresh
  '30': 2,
  '60': 2,     // 1h
  '120': 1,
  '240': 1,    // 4h
  'D': 1,      // 1d
  'W': 1,
  'M': 1
};

// Helper to normalize kline raw array to our shape (oldest first)
function normalize(rawArr) {
  return rawArr.map(k => ({
    t: k.open_time,
    open: parseFloat(k.open),
    high: parseFloat(k.high),
    low: parseFloat(k.low),
    close: parseFloat(k.close),
    volume: parseFloat(k.volume)
  })).sort((a, b) => a.t - b.t);
}

async function fetchKlines(symbol, interval, limit = 200) {
  // determine freshCount for this interval
  const freshCount = Math.min(limit, freshCountMap[String(interval)] || 2);
  const closedCount = Math.max(0, limit - freshCount);
  const cacheKey = `cache:klines:closed:${symbol}:${interval}:${closedCount}`;

  // If closedCount == 0, just fetch full dataset (nothing to cache)
  if (closedCount === 0) {
    try {
      const resp = await apiGet('/v2/public/kline/list', { symbol, interval: String(interval), limit });
      const raw = (resp && resp.result) ? resp.result : [];
      return normalize(raw);
    } catch (err) {
      console.error('fetchKlines full fetch failed', err.message);
      return [];
    }
  }

  // Try to get cached closed portion
  try {
    const cachedClosed = await cacheGet(cacheKey);
    if (cachedClosed && Array.isArray(cachedClosed) && cachedClosed.length >= closedCount) {
      // We have enough closed candles cached — fetch only the fresh newest bars
      try {
        const freshResp = await apiGet('/v2/public/kline/list', { symbol, interval: String(interval), limit: freshCount });
        const freshRaw = (freshResp && freshResp.result) ? freshResp.result : [];
        const freshNorm = normalize(freshRaw);
        // Use the last closedCount entries from cachedClosed (they're oldest-first)
        const lastClosedSlice = cachedClosed.slice(-closedCount);
        return lastClosedSlice.concat(freshNorm);
      } catch (e) {
        console.warn('fetchKlines: fetching fresh bars failed, will try fallback full fetch', e.message);
        // fallthrough to attempt fallback full fetch
      }
    }
  } catch (e) {
    console.warn('fetchKlines cache-get error', e.message);
    // fallthrough
  }

  // At this point we need to refresh closed cache (cache miss or insufficient). Use stampede protection.
  const lockKey = cacheKey; // use same base for lock
  const lockToken = await acquireLock(lockKey, 15000);
  if (lockToken) {
    // we acquired lock — we are responsible for doing the heavy full fetch and populating cache
    try {
      const resp = await apiGet('/v2/public/kline/list', { symbol, interval: String(interval), limit });
      const raw = (resp && resp.result) ? resp.result : [];
      const klines = normalize(raw);
      // closed portion: all except newest freshCount bars
      const closedPortion = klines.slice(0, Math.max(0, klines.length - freshCount));
      try {
        await cacheSet(cacheKey, closedPortion, 3600); // cache for 1 hour
      } catch (e) {
        console.warn('fetchKlines cache-set failed', e.message);
      }
      // release lock
      await releaseLock(lockKey, lockToken);
      return klines;
    } catch (err) {
      // ensure lock released on error
      try { await releaseLock(lockKey, lockToken); } catch (e) {}
      console.error('fetchKlines full fetch failed during lock-holder execution', err.message);
      return [];
    }
  } else {
    // Another process is populating cache — wait for cache or lock release for a short period
    try {
      const cachedAfterWait = await waitForLockReleaseOrCache(lockKey, cacheKey, 8000);
      if (cachedAfterWait && Array.isArray(cachedAfterWait) && cachedAfterWait.length >= closedCount) {
        // fetch fresh bars and concat
        try {
          const freshResp = await apiGet('/v2/public/kline/list', { symbol, interval: String(interval), limit: freshCount });
          const freshRaw = (freshResp && freshResp.result) ? freshResp.result : [];
          const freshNorm = normalize(freshRaw);
          const lastClosedSlice = cachedAfterWait.slice(-closedCount);
          return lastClosedSlice.concat(freshNorm);
        } catch (e) {
          console.warn('fetchKlines: fetching fresh bars after wait failed, doing full fetch', e.message);
        }
      }
    } catch (e) {
      console.warn('fetchKlines wait for cache failed', e.message);
    }
    // As last resort, fetch full klines without cache (to avoid indefinite wait)
    try {
      const resp = await apiGet('/v2/public/kline/list', { symbol, interval: String(interval), limit });
      const raw = (resp && resp.result) ? resp.result : [];
      const klines = normalize(raw);
      // attempt to set cache (best-effort)
      try {
        const closedPortion = klines.slice(0, Math.max(0, klines.length - freshCount));
        await cacheSet(cacheKey, closedPortion, 3600);
      } catch (e) {}
      return klines;
    } catch (err) {
      console.error('fetchKlines final fallback full fetch failed', err.message);
      return [];
    }
  }
}

// Fetch symbol metadata (v5 public contract info)
async function fetchSymbolSpecs(symbol) {
  try {
    const res = await apiGet('/v5/market/instrument/infos', { symbol });
    if (res && res.result && res.result.list && res.result.list.length) {
      const info = res.result.list[0];
      const tick = info.priceFilter ? parseFloat(info.priceFilter.tickSize) : 0.000001;
      const step = info.lotSizeFilter ? parseFloat(info.lotSizeFilter.minOrderQty) : 0.0001;
      return { tick, step, info };
    }
  } catch (e) {
    console.warn('fetchSymbolSpecs failed', e.message);
  }
  return { tick: 0.0001, step: 0.0001 };
}

// Quantize helper using fetched metadata
function quantize(symbolSpecs, price, qty) {
  const p = price != null && symbolSpecs.tick ? quantizePrice(price, symbolSpecs.tick) : price;
  const q = qty != null && symbolSpecs.step ? quantizeQty(qty, symbolSpecs.step) : qty;
  return { price: p, qty: q };
}

// v5 auth headers builder
function v5Headers(body = '') {
  const ts = Date.now().toString();
  const recvWindow = '5000';
  const sign = signV5(ts, cfg.BYBIT_API_KEY, cfg.BYBIT_API_SECRET, recvWindow, body);
  return {
    'Content-Type': 'application/json',
    'X-BAPI-API-KEY': cfg.BYBIT_API_KEY,
    'X-BAPI-TIMESTAMP': ts,
    'X-BAPI-RECV-WINDOW': recvWindow,
    'X-BAPI-SIGN': sign
  };
}

// ---------- v5 order / conditional order / wallet helpers (unchanged from prior implementation) ----------

// Place market order (v5)
async function placeMarketOrder(symbol, side, qty, orderLinkId = null) {
  if (!cfg.OPEN_TRADES) {
    console.log('[DRY RUN] Would place market order', { symbol, side, qty, orderLinkId });
    return { simulated: true, symbol, side, qty, orderLinkId };
  }
  const body = JSON.stringify({
    category: 'linear',
    symbol,
    side: side.toUpperCase(),
    orderType: 'Market',
    qty: qty.toString(),
    timeInForce: 'ImmediateOrCancel',
    reduceOnly: false,
    closeOnTrigger: false,
    orderLinkId: orderLinkId || undefined
  });
  const headers = v5Headers(body);
  const res = await apiPost('/v5/order/create', body, headers);
  return res;
}

// Create conditional order (TP/SL) v5
async function createConditionalOrder(symbol, side, qty, triggerPrice) {
  if (!cfg.OPEN_TRADES) {
    console.log('[DRY RUN] Would create conditional order', { symbol, side, qty, triggerPrice });
    return { simulated: true, symbol, side, qty, triggerPrice };
  }
  const body = JSON.stringify({
    category: 'linear',
    symbol,
    side: side.toUpperCase(),
    size: qty.toString(),
    orderType: 'Market',
    triggerPrice: triggerPrice.toString()
  });
  const headers = v5Headers(body);
  const res = await apiPost('/v5/conditional/order/create', body, headers);
  return res;
}

// Cancel conditional order (v5)
async function cancelConditionalOrder(symbol, conditionalOrderId = null, orderLinkId = null) {
  if (!cfg.OPEN_TRADES) {
    console.log('[DRY RUN] Would cancel conditional order', { symbol, conditionalOrderId, orderLinkId });
    return { simulated: true };
  }
  const bodyObj = { symbol };
  if (conditionalOrderId) bodyObj.conditionalOrderId = conditionalOrderId;
  if (orderLinkId) bodyObj.orderLinkId = orderLinkId;
  const body = JSON.stringify(bodyObj);
  const headers = v5Headers(body);
  const res = await apiPost('/v5/conditional/order/cancel', body, headers);
  return res;
}

// Cancel regular order (v5)
async function cancelOrder(symbol, orderId = null, orderLinkId = null) {
  if (!cfg.OPEN_TRADES) {
    console.log('[DRY RUN] Would cancel order', { symbol, orderId, orderLinkId });
    return { simulated: true };
  }
  const bodyObj = { symbol };
  if (orderId) bodyObj.orderId = orderId;
  if (orderLinkId) bodyObj.orderLinkId = orderLinkId;
  const body = JSON.stringify(bodyObj);
  const headers = v5Headers(body);
  const res = await apiPost('/v5/order/cancel', body, headers);
  return res;
}

// Get order by orderLinkId or orderId
async function getOrders(symbol, orderId = null, orderLinkId = null) {
  const params = { symbol };
  if (orderId) params.orderId = orderId;
  if (orderLinkId) params.orderLinkId = orderLinkId;
  try {
    const res = await apiGet('/v5/order/list', params);
    return res;
  } catch (e) {
    console.warn('getOrders failed', e.message);
    return null;
  }
}

// Get conditional orders for symbol
async function getConditionalOrders(symbol) {
  try {
    const res = await apiGet('/v5/conditional/order/list', { symbol });
    return res;
  } catch (e) {
    console.warn('getConditionalOrders failed', e.message);
    return null;
  }
}

async function getWalletBalance() {
  try {
    const ts = Date.now().toString();
    const recvWindow = '5000';
    const sign = signV5(ts, cfg.BYBIT_API_KEY, cfg.BYBIT_API_SECRET, recvWindow, '');
    const res = await axios.get(`${BASE}/v5/account/wallet-balance`, {
      headers: {
        'X-BAPI-API-KEY': cfg.BYBIT_API_KEY,
        'X-BAPI-TIMESTAMP': ts,
        'X-BAPI-RECV-WINDOW': recvWindow,
        'X-BAPI-SIGN': sign
      }, timeout: 20000
    });
    if (res.data && res.data.result && res.data.result.list) {
      const usdt = res.data.result.list.find(x => x.coin === 'USDT');
      if (usdt) return parseFloat(usdt.walletBalance || 0);
    }
  } catch (e) {
    console.warn('getWalletBalance v5 failed', e.message);
  }
  try {
    const resp = await apiGet('/v2/private/wallet/balance', { coin: 'USDT' });
    if (resp && resp.result && resp.result.USDT) return parseFloat(resp.result.USDT.available_balance || 0);
  } catch (e) {}
  return 0;
}

async function getOpenPositions() {
  try {
    const ts = Date.now().toString();
    const recvWindow = '5000';
    const sign = signV5(ts, cfg.BYBIT_API_KEY, cfg.BYBIT_API_SECRET, recvWindow, '');
    const res = await axios.get(`${BASE}/v5/position/list`, {
      headers: {
        'X-BAPI-API-KEY': cfg.BYBIT_API_KEY,
        'X-BAPI-TIMESTAMP': ts,
        'X-BAPI-RECV-WINDOW': recvWindow,
        'X-BAPI-SIGN': sign
      }, timeout: 20000
    });
    if (res.data && res.data.result && res.data.result.list) return res.data.result.list;
  } catch (e) {
    console.warn('getOpenPositions failed', e.message);
  }
  return [];
}

// Basic WS manager for public kline subscriptions; order lifecycle uses polling
class BybitWS {
  constructor() {
    this.ws = null;
    this.subscriptions = new Set();
    this.callbacks = new Map();
    this.connect();
  }
  connect() {
    this.ws = new WebSocket(WS_BASE);
    this.ws.on('open', () => {
      console.log('Bybit WS connected');
      for (const s of this.subscriptions) {
        this.ws.send(JSON.stringify({ op: 'subscribe', args: [s] }));
      }
    });
    this.ws.on('message', (d) => {
      try {
        const msg = JSON.parse(d.toString());
        if (msg.topic && this.callbacks.has(msg.topic)) {
          this.callbacks.get(msg.topic)(msg);
        } else if (msg.type === 'ping') {
          this.ws.send(JSON.stringify({ op: 'pong' }));
        }
      } catch (e) {}
    });
    this.ws.on('close', () => setTimeout(() => this.connect(), 5000));
    this.ws.on('error', (err) => console.error('WS error', err.message));
  }
  subscribeKline(symbol, interval, cb) {
    const topic = `klineV2.${interval}.${symbol}`;
    this.subscriptions.add(topic);
    this.callbacks.set(topic, cb);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
    }
    return () => {
      this.subscriptions.delete(topic);
      this.callbacks.delete(topic);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'unsubscribe', args: [topic] }));
      }
    };
  }
}

module.exports = {
  fetchUsdtPerpetualSymbols,
  fetchKlines,
  fetchSymbolSpecs,
  quantize,
  placeMarketOrder,
  createConditionalOrder,
  cancelConditionalOrder,
  cancelOrder,
  getOrders,
  getConditionalOrders,
  getWalletBalance,
  getOpenPositions,
  BybitWS
};
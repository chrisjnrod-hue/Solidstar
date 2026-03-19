// Persistence: Redis-backed (ioredis) or in-memory fallback

const cfg = require('./config');
const Redis = require('ioredis');

let redis = null;
let fallback = { trades: {}, openTrades: new Set(), killSwitch: false };

if (cfg.REDIS_URL) {
  redis = new Redis(cfg.REDIS_URL);
  redis.on('error', (e) => console.error('Redis error', e));
  console.log('Using Redis for persistence');
} else {
  console.warn('REDIS_URL not set: using in-memory store (not durable across restarts)');
}

async function saveTrade(trade) {
  if (redis) {
    const key = `trade:${trade.id}`;
    await redis.set(key, JSON.stringify(trade));
    if (trade.status === 'OPEN') await redis.sadd('open_trades', trade.id);
    else await redis.srem('open_trades', trade.id);
  } else {
    fallback.trades[trade.id] = trade;
    if (trade.status === 'OPEN') fallback.openTrades.add(trade.id);
    else fallback.openTrades.delete(trade.id);
  }
}

async function getTrade(id) {
  if (redis) {
    const raw = await redis.get(`trade:${id}`);
    return raw ? JSON.parse(raw) : null;
  } else {
    return fallback.trades[id] || null;
  }
}

async function listOpenTrades() {
  if (redis) {
    const ids = await redis.smembers('open_trades');
    if (!ids || ids.length === 0) return [];
    const vals = await Promise.all(ids.map(id => redis.get(`trade:${id}`)));
    return vals.map(v => JSON.parse(v));
  } else {
    return Array.from(fallback.openTrades).map(id => fallback.trades[id]);
  }
}

async function allTrades() {
  if (redis) {
    const keys = await redis.keys('trade:*');
    if (!keys.length) return [];
    const vals = await redis.mget(...keys);
    return vals.map(v => JSON.parse(v));
  } else {
    return Object.values(fallback.trades);
  }
}

// Kill switch persisted in Redis or memory
async function setKillSwitch(enabled) {
  if (redis) {
    if (enabled) await redis.set('kill_switch', '1');
    else await redis.del('kill_switch');
  } else {
    fallback.killSwitch = !!enabled;
  }
}

async function getKillSwitch() {
  if (redis) {
    const v = await redis.get('kill_switch');
    return !!v;
  } else {
    return !!fallback.killSwitch;
  }
}

module.exports = {
  saveTrade,
  getTrade,
  listOpenTrades,
  allTrades,
  setKillSwitch,
  getKillSwitch
};

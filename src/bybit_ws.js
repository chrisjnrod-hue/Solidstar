// src/bybit_ws.js - lightweight Bybit public WebSocket client (kline subscriptions)
const WebSocket = require('ws');
const cfg = require('./config');

const DEFAULT_PING_MS = 15000;
const RECONNECT_MS = 5000;

function normalizeInterval(interval) {
  const k = String(interval || '').toLowerCase();
  if (k === '1h' || k === '60') return '60';
  if (k === '4h' || k === '240') return '240';
  if (k === '1d' || k === 'd' || k === '24h') return 'D';
  if (k === '15m' || k === '15') return '15';
  if (k === '5m' || k === '5') return '5';
  return interval;
}

class BybitWS {
  constructor(opts = {}) {
    this.url = opts.url || cfg.BYBIT_WS || '';
    if (!this.url) throw new Error('BybitWS: no WS url configured (cfg.BYBIT_WS)');
    this.debug = !!opts.debug || !!process.env.WS_VERBOSE;
    this._ws = null;
    this._connected = false;
    this._subs = new Map(); // topic -> Set(handler)
    this._pingTimer = null;
    this._reconnectTimer = null;
    this._connect();
  }

  _log(...args) { if (this.debug) console.log('[BybitWS]', ...args); }

  _connect() {
    this._log('connecting to', this.url);
    this._ws = new WebSocket(this.url, { handshakeTimeout: 10000 });

    this._ws.on('open', () => {
      this._connected = true;
      this._log('open');
      for (const topic of this._subs.keys()) this._sendSubscribe(topic);
      this._startPing();
    });

    this._ws.on('message', (data) => this._handleMessage(data));
    this._ws.on('error', (err) => this._log('ws error', err && err.message));
    this._ws.on('close', (code, reason) => {
      this._connected = false;
      this._log('closed', code, reason && reason.toString && reason.toString());
      this._stopPing();
      if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
      this._reconnectTimer = setTimeout(() => this._connect(), RECONNECT_MS);
    });
  }

  _startPing() { if (this._pingTimer) clearInterval(this._pingTimer); this._pingTimer = setInterval(() => { try { if (this._connected && this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.ping(); } catch (e) {} }, DEFAULT_PING_MS); }
  _stopPing() { if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; } }

  _send(obj) {
    try {
      if (this._connected && this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.send(JSON.stringify(obj));
      else this._log('not connected; send skipped', obj);
    } catch (e) { this._log('send failed', e && e.message); }
  }

  _sendSubscribe(topic) { this._log('subscribing topic', topic); this._send({ op: 'subscribe', args: [topic] }); }
  _sendUnsubscribe(topic) { this._log('unsubscribing topic', topic); this._send({ op: 'unsubscribe', args: [topic] }); }

  _handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch (e) { if (this.debug) console.log('BybitWS: invalid JSON', e.message); return; }
    if (msg && msg.topic && String(msg.topic).startsWith('kline')) {
      const topic = msg.topic;
      const handlers = this._subs.get(topic);
      if (!handlers || !handlers.size) return;
      let payloadArray = Array.isArray(msg.data) ? msg.data : (Array.isArray(msg.body) ? msg.body : null);
      if (!Array.isArray(payloadArray) && msg.data && typeof msg.data === 'object') payloadArray = [msg.data];
      if (!Array.isArray(payloadArray)) return;
      const item = payloadArray[payloadArray.length - 1];
      const normalized = {
        timestamp: item.t || item.ts || item.start_at || item[0] || Date.now(),
        open: Number(item.o || item.open || item[1] || 0),
        high: Number(item.h || item.high || item[2] || 0),
        low: Number(item.l || item.low || item[3] || 0),
        close: Number(item.c || item.close || item[4] || 0),
        volume: Number(item.v || item.volume || item[5] || 0),
        raw: item
      };
      for (const h of handlers) try { h(normalized); } catch (e) { this._log('handler error', e && e.message); }
      return;
    }
    if (msg && msg.success !== undefined && msg.request && msg.request.args) { this._log('subscribe ack', msg.request && msg.request.args, 'success=', msg.success); return; }
    if (msg && msg.op === 'ping') { this._send({ op: 'pong' }); return; }
    if (this.debug) this._log('ws msg', msg && (msg.topic || msg.op || msg.request || JSON.stringify(msg).slice(0,200)));
  }

  subscribeKline(symbol, interval, handler) {
    if (!symbol || !interval || typeof handler !== 'function') throw new Error('subscribeKline requires symbol, interval, handler');
    const ii = normalizeInterval(interval);
    const topic = `kline.${ii}.${String(symbol)}`;
    let handlers = this._subs.get(topic);
    if (!handlers) {
      handlers = new Set();
      this._subs.set(topic, handlers);
      if (this._connected) this._sendSubscribe(topic);
    }
    handlers.add(handler);
    let unsubCalled = false;
    return () => {
      if (unsubCalled) return;
      unsubCalled = true;
      const hset = this._subs.get(topic);
      if (hset) {
        hset.delete(handler);
        if (!hset.size) {
          this._subs.delete(topic);
          if (this._connected) this._sendUnsubscribe(topic);
        }
      }
    };
  }

  subscribeTopic(topic, handler) {
    if (!topic || typeof handler !== 'function') throw new Error('subscribeTopic requires topic and handler');
    let handlers = this._subs.get(topic);
    if (!handlers) {
      handlers = new Set();
      this._subs.set(topic, handlers);
      if (this._connected) this._sendSubscribe(topic);
    }
    handlers.add(handler);
    let unsub = false;
    return () => {
      if (unsub) return;
      unsub = true;
      const hset = this._subs.get(topic);
      if (hset) {
        hset.delete(handler);
        if (!hset.size) {
          this._subs.delete(topic);
          if (this._connected) this._sendUnsubscribe(topic);
        }
      }
    };
  }

  getPrice(symbol) { return undefined; }
  close() { try { this._stopPing(); if (this._ws) this._ws.close(); } catch (e) {} }
}

module.exports = { BybitWS };

/* Bybit WS client with heartbeat (ws.ping) and verbose subscribe/response logging.
   Fix: do NOT respond to server 'ping' with JSON { "op": "pong" } — use ws.pong() low-level frame.
*/

const WebSocket = require('ws');
const cfg = require('./config');

let reconnectAttempts = 0;
const baseReconnectMs = 1000;
const maxReconnectMs = 60000;

function backoffMs(attempts) {
  const jitter = Math.floor(Math.random() * 800);
  const ms = Math.min(maxReconnectMs, Math.round(baseReconnectMs * Math.pow(1.8, attempts))) + jitter;
  return ms;
}

class BybitWS {
  constructor() {
    this.ws = null;
    this.subscriptions = new Set();
    this.callbacks = new Map();
    this.prices = new Map(); // optional price cache by symbol
    this._closedByUser = false;
    this._heartbeat = null; // interval id for periodic pings
    this.connect();
  }

  startHeartbeat() {
    // clear existing just in case
    this.stopHeartbeat();
    // send periodic WebSocket ping frames to keep connection alive
    this._heartbeat = setInterval(() => {
      try {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (cfg.WS_VERBOSE) console.log('BybitWS: heartbeat send (ws.ping)');
        try { this.ws.ping(); } catch (e) { /* ignore */ }
      } catch (e) {
        if (cfg.WS_VERBOSE) console.warn('BybitWS heartbeat error', e && e.message);
      }
    }, 20 * 1000); // 20s heartbeat
  }

  stopHeartbeat() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }

  connect() {
    const url = cfg.BYBIT_WS;
    console.log(`BybitWS: connecting to ${url}`);
    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        reconnectAttempts = 0;
        console.log('BybitWS: connected');
        // start heartbeat using ws.ping frames
        try { this.startHeartbeat(); } catch (e) {}
        // re-subscribe
        for (const s of this.subscriptions) {
          try {
            const msg = JSON.stringify({ op: 'subscribe', args: [s] });
            if (cfg.WS_VERBOSE) console.log('BybitWS: sending subscribe:', msg);
            this.ws.send(msg);
          } catch (e) {
            if (cfg.WS_VERBOSE) console.warn('BybitWS subscribe send failed', e && e.message);
          }
        }
      });

      // This event fires when the server responds during HTTP->WS upgrade with non-101 HTTP status
      this.ws.on('unexpected-response', (req, res) => {
        try {
          const status = res && res.statusCode;
          const statusMsg = res && res.statusMessage;
          console.error('BybitWS unexpected-response', { status, statusMsg });
          // attempt to read body if present for additional context
          let body = '';
          res.on('data', (chunk) => { body += chunk.toString(); });
          res.on('end', () => {
            if (body && body.length) {
              console.error('BybitWS unexpected-response body (trimmed):', body.slice(0, 2000));
            }
          });
        } catch (e) {
          console.error('BybitWS unexpected-response handler failed', e && e.stack);
        }
      });

      this.ws.on('message', (d) => {
        // verbose raw logging
        if (cfg.WS_VERBOSE) {
          try {
            const raw = d.toString();
            console.log('BybitWS (verbose) raw message:', raw.slice(0, 2000));
          } catch (e) {}
        }

        // Try to parse JSON; if it fails we ignore parsing
        let msg;
        try {
          msg = JSON.parse(d.toString());
        } catch (e) {
          // not JSON, keep running
          if (cfg.WS_VERBOSE) console.warn('BybitWS: received non-JSON message');
          return;
        }

        // verbose parsed logging for subscription/heartbeat related messages
        if (cfg.WS_VERBOSE) {
          const isSubResp = msg && (msg.request || msg.success === false || msg.retCode || msg.ret_code || msg.topic || msg.type);
          if (isSubResp) {
            try { console.log('BybitWS (verbose) parsed:', JSON.stringify(msg).slice(0, 2000)); } catch (e) {}
          }
        }

        // maintain a simple price cache if message contains trade data
        if (msg && msg.data && Array.isArray(msg.data) && msg.topic && (msg.topic.startsWith('trade') || msg.topic.includes('trade'))) {
          const entry = msg.data[0];
          if (entry && entry.symbol && (entry.price || entry.last_price || entry.p)) {
            const p = entry.price || entry.last_price || entry.p;
            this.prices.set(entry.symbol, parseFloat(p));
          }
        }

        // If server sends a ping (op === 'ping' or type === 'ping'), reply with a low-level WebSocket pong frame
        // DO NOT send JSON { "op": "pong" } — server rejects that as invalid op.
        if (msg.op === 'ping' || msg.type === 'ping') {
          if (cfg.WS_VERBOSE) console.log('BybitWS: received server ping; sending ws.pong() frame');
          try { this.ws.pong(); } catch (e) { if (cfg.WS_VERBOSE) console.warn('BybitWS: ws.pong() failed', e && e.message); }
          return;
        }

        // route to topic callback if registered
        if (msg.topic && this.callbacks.has(msg.topic)) {
          try {
            this.callbacks.get(msg.topic)(msg);
          } catch (e) {
            if (cfg.WS_VERBOSE) console.warn('BybitWS: callback error', e && e.message);
          }
        }
      });

      this.ws.on('error', (err) => {
        try {
          console.error('BybitWS error', {
            message: err && err.message,
            stack: err && err.stack,
            code: err && err.code
          });
        } catch (e) {
          console.error('BybitWS error logging failed', e && e.message);
        }
      });

      this.ws.on('close', (code, reason) => {
        // stop heartbeat
        try { this.stopHeartbeat(); } catch (e) {}
        if (this._closedByUser) {
          console.log('BybitWS closed by user request', { code, reason: reason && reason.toString() });
          return;
        }
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
    // Legacy topic construction
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
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ op: 'unsubscribe', args: [topic] })); } catch (e) {}
      }
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
      } catch (e) {
        console.warn('subscribeTopic send failed', e && e.message);
      }
    }
    return () => {
      this.subscriptions.delete(topic);
      this.callbacks.delete(topic);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ op: 'unsubscribe', args: [topic] })); } catch (e) {}
      }
    };
  }

  getPrice(symbol) {
    return this.prices.get(symbol);
  }

  close() {
    this._closedByUser = true;
    try { if (this.ws) this.ws.close(); } catch (e) {}
  }
}

module.exports = {
  BybitWS,
};

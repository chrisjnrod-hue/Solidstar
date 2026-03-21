/* Bybit WS client with heartbeat and verbose subscribe/response logging.
   - Adds periodic client-side ping (JSON op ping + ws.ping()) to keep v5 public sockets alive.
   - When cfg.WS_VERBOSE === true, logs subscribe sends and key incoming messages (trimmed).
   - Maintains previous subscribeKline helper as a legacy method; later we can add v5-specific helpers.
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
    // send periodic JSON ping and ws.ping to keep connection alive
    this._heartbeat = setInterval(() => {
      try {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const pingMsg = JSON.stringify({ op: 'ping' });
        if (cfg.WS_VERBOSE) console.log('BybitWS: heartbeat send (JSON ping)');
        try { this.ws.send(pingMsg); } catch (e) { /* ignore */ }
        // also send a low-level WebSocket ping frame (some servers expect it)
        try { this.ws.ping && this.ws.ping(); } catch (e) { /* ignore */ }
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
        // start heartbeat
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
        // keep raw for verbose logs, but then attempt JSON parse
        if (cfg.WS_VERBOSE) {
          try {
            const raw = d.toString();
            // avoid huge logs; trim to first 2000 chars
            console.log('BybitWS (verbose) raw message:', raw.slice(0, 2000));
          } catch (e) {}
        }

        try {
          const msg = JSON.parse(d.toString());
          // verbose printing for subscription-related responses or errors
          if (cfg.WS_VERBOSE) {
            const isSubResp = msg && (msg.request || msg.success === false || msg.retCode || msg.ret_code || msg.topic || msg.type);
            if (isSubResp) {
              try { console.log('BybitWS (verbose) parsed:', JSON.stringify(msg).slice(0, 2000)); } catch (e) {}
            }
          }

          // maintain a simple price cache for convenience (if messages include symbol/price)
          if (msg && msg.data && Array.isArray(msg.data) && msg.topic && (msg.topic.startsWith('trade') || msg.topic.includes('trade'))) {
            const entry = msg.data[0];
            if (entry && entry.symbol && (entry.price || entry.last_price || entry.p)) {
              const p = entry.price || entry.last_price || entry.p;
              this.prices.set(entry.symbol, parseFloat(p));
            }
          }

          if (msg.topic && this.callbacks.has(msg.topic)) {
            this.callbacks.get(msg.topic)(msg);
          } else if (msg.type === 'ping' || msg.op === 'ping') {
            // reply to server heartbeat
            try { this.ws.send(JSON.stringify({ op: 'pong' })); } catch (e) {}
          }
        } catch (e) {
          // message parse error but keep running
          console.warn('BybitWS message parse error', e && e.message);
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
        // reason might be a Buffer; convert safely
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
    // Legacy topic construction; v5 topics differ — we'll keep this as a convenience wrapper
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

  // generic subscribe to a v5-style topic string (you can use this to pass explicit v5 topics)
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
  // If you maintain fetchKlines/fetchTicker/etc in another bybit.js, keep them and merge the class above.
};

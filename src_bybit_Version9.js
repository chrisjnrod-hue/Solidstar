/* Bybit WS improvements: better diagnostics for unexpected-response (handshake) failures,
   more structured error logs, and exponential reconnect/backoff to reduce repeated 504 spam.

   This is safe to drop into your repo as a replacement or merge into your existing bybit.js.
   It exports BybitWS. If you have other bybit.js exports used elsewhere (fetchKlines, fetchTicker, fetchUsdtPerpetualSymbols),
   keep those in your current file and merge the WS parts below into it.
*/

const WebSocket = require('ws');
const cfg = require('./config');

let reconnectAttempts = 0;
const baseReconnectMs = 1000;
const maxReconnectMs = 60000;

function backoffMs(attempts) {
  const jitter = Math.floor(Math.random() * 500);
  const ms = Math.min(maxReconnectMs, Math.round(baseReconnectMs * Math.pow(1.8, attempts))) + jitter;
  return ms;
}

class BybitWS {
  constructor() {
    this.ws = null;
    this.subscriptions = new Set();
    this.callbacks = new Map();
    this.prices = new Map(); // optional price cache by symbol (if you populate it when messages arrive)
    this._closedByUser = false;
    this.connect();
  }

  connect() {
    const url = cfg.BYBIT_WS;
    console.log(`BybitWS: connecting to ${url}`);
    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        reconnectAttempts = 0;
        console.log('BybitWS: connected');
        // re-subscribe
        for (const s of this.subscriptions) {
          try { this.ws.send(JSON.stringify({ op: 'subscribe', args: [s] })); } catch (e) {}
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
        try {
          const msg = JSON.parse(d.toString());
          // maintain a simple price cache for convenience (if messages include symbol/price)
          if (msg && msg.data && Array.isArray(msg.data) && msg.topic && msg.topic.startsWith('trade')) {
            // example topic/trade format handling - adapt to the actual message schema you expect
            const entry = msg.data[0];
            if (entry && entry.symbol && (entry.price || entry.last_price || entry.p)) {
              const p = entry.price || entry.last_price || entry.p;
              this.prices.set(entry.symbol, parseFloat(p));
            }
          }
          if (msg.topic && this.callbacks.has(msg.topic)) {
            this.callbacks.get(msg.topic)(msg);
          } else if (msg.type === 'ping') {
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
        if (this._closedByUser) {
          console.log('BybitWS closed by user request', { code, reason: reason && reason.toString() });
          return;
        }
        reconnectAttempts++;
        const ms = backoffMs(reconnectAttempts);
        console.warn(`BybitWS closed (code=${code}) reason=${reason ? reason.toString() : ''} - reconnecting in ${ms}ms (attempt ${reconnectAttempts})`);
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
    // topic format: klineV2.<interval>.<symbol>
    const topic = `klineV2.${interval}.${symbol}`;
    this.subscriptions.add(topic);
    if (typeof cb === 'function') this.callbacks.set(topic, cb);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ op: 'subscribe', args: [topic] })); } catch (e) { console.warn('subscribe send failed', e && e.message); }
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
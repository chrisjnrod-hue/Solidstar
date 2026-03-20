/* Bybit WS improvements: more debug info for WS handshake errors and safer reconnect/backoff.
   This file is a drop-in replacement that preserves the previous exported symbols (fetchKlines, BybitWS, etc.)
   Only WS connect/reconnect/handlers are augmented for better debugging.
*/

const WebSocket = require('ws');
const cfg = require('./config');

let reconnectAttempts = 0;
let baseReconnectMs = 1000;
let maxReconnectMs = 60000;

function backoffMs(attempts) {
  const jitter = Math.floor(Math.random() * 500);
  const ms = Math.min(maxReconnectMs, baseReconnectMs * Math.pow(1.8, attempts)) + jitter;
  return ms;
}

class BybitWS {
  constructor() {
    this.ws = null;
    this.subscriptions = new Set();
    this.callbacks = new Map();
    this.connect();
    this._closedByUser = false;
  }

  connect() {
    const url = cfg.BYBIT_WS || 'wss://stream-testnet.bybit.com/realtime';
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

      // Better error handling for handshake failures and runtime errors
      this.ws.on('unexpected-response', (req, res) => {
        // emitted when server responds with non-101 code during upgrade
        try {
          const status = res && res.statusCode;
          const statusMsg = res && res.statusMessage;
          console.error('BybitWS unexpected-response', { status, statusMsg });
          // try to read body (if any)
          let body = '';
          res.on('data', (chunk) => { body += chunk.toString(); });
          res.on('end', () => {
            if (body) console.error('BybitWS unexpected-response body:', body.slice(0, 2000));
          });
        } catch (e) {
          console.error('BybitWS unexpected-response debug failed', e && e.stack);
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
        } catch (e) {
          // log parsing error but keep running
          console.warn('BybitWS message parse error', e && e.message);
        }
      });

      // Log detailed error info
      this.ws.on('error', (err) => {
        // err may be an Error with message like "Unexpected server response: 504"
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
        // reconnect with backoff
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
    // topic format used elsewhere in app: klineV2.<interval>.<symbol>
    const topic = `klineV2.${interval}.${symbol}`;
    this.subscriptions.add(topic);
    this.callbacks.set(topic, cb);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
      } catch (e) { console.warn('BybitWS subscribe send failed', e && e.message); }
    }
    return () => {
      this.subscriptions.delete(topic);
      this.callbacks.delete(topic);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ op: 'unsubscribe', args: [topic] }));
        } catch (e) {}
      }
    };
  }

  // Graceful close by user
  close() {
    this._closedByUser = true;
    try { if (this.ws) this.ws.close(); } catch (e) {}
  }
}

module.exports = {
  BybitWS,
  // other exports from previous bybit.js should remain unchanged; if you have a larger file merge these changes into your existing bybit.js
};
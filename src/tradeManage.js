// src/tradeManager.js
// Trade manager: provides closePosition(trade) using Bybit V5 signed REST placeActiveOrder.
// Uses bybit.fetchSymbolSpecs and bybit.quantize for robust qty rounding.

const cfg = require('./config');
const bybit = require('./bybit');
const { placeActiveOrder, fetchSymbolSpecs, quantize } = require('./bybit');
const { sendTelegram } = require('./telegram');

async function closePosition(trade) {
  if (!trade) throw new Error('closePosition requires a trade object');

  const symbol = trade.symbol;
  if (!symbol) throw new Error('trade.symbol is required for closePosition');

  // determine side to submit (opposite)
  const currentSide = (trade.side || '').toString().toLowerCase();
  const closeSide = currentSide === 'buy' ? 'Sell' : 'Buy';

  // Determine raw qty
  let qty = null;
  if (trade.qty) qty = trade.qty;
  if (!qty && trade.size) qty = trade.size;
  if (!qty && trade.positionQty) qty = trade.positionQty;
  if (!qty && trade.contractQty) qty = trade.contractQty;

  // Attempt to get precise position size via an optional bybit.getOpenPositions(symbol)
  if (!qty && typeof bybit.getOpenPositions === 'function') {
    try {
      const positions = await bybit.getOpenPositions(symbol);
      if (Array.isArray(positions) && positions.length) {
        const p = positions.find(x => (x.symbol === symbol) || (x[0] && x[0] === symbol)) || positions[0];
        if (p) qty = p.size || p.qty || p.positionQty || p.position_size;
      }
    } catch (e) { /* ignore */ }
  }

  // fallback: compute from notional/entryPrice
  if (!qty && trade.entryPrice && trade.notional) {
    try { qty = Number(trade.notional) / Number(trade.entryPrice); } catch (e) {}
  }

  // final fallback
  if (!qty) qty = trade.remainingQty || trade.remaining || 1;

  qty = Number(qty);
  if (!Number.isFinite(qty) || qty <= 0) qty = 1;

  // fetch symbol specs and quantize
  let spec = null;
  try {
    spec = await fetchSymbolSpecs(symbol);
  } catch (e) { spec = null; }
  const qResult = quantize(spec, qty);
  const qtyStr = String(qResult.qty);

  // Safety: DRY_RUN support
  const dry = (process.env.DRY_RUN_AUTO_CLOSE || 'false') === 'true';
  const payload = {
    category: cfg.BYBIT_MARKET || 'linear',
    symbol: symbol,
    side: closeSide,
    orderType: 'Market',
    qty: qtyStr,
    reduceOnly: true,
    orderLinkId: `auto-close-${Date.now()}-${Math.floor(Math.random()*100000)}`
  };

  if (dry) {
    console.log('DRY_RUN_AUTO_CLOSE enabled — would place:', payload, 'quantizeInfo:', qResult, 'spec:', spec);
    try {
      await sendTelegram(`bybit: DRY_RUN Auto-close candidate for ${symbol} qty=${qtyStr} rounded=${qResult.qty} reason=${qResult.reason}`);
    } catch (e) {}
    return { dry: true, payload, quantize: qResult, spec };
  }

  try {
    console.log(`tradeManager.closePosition: placing reduce-only market order to close ${symbol} qty=${qtyStr} side=${closeSide}`);
    const res = await placeActiveOrder(payload);
    try {
      await sendTelegram(`bybit: Auto-close placed for ${symbol} side=${closeSide} qty=${qtyStr} result=${res && (res.ret_msg || JSON.stringify(res)).toString().slice(0,200)}`);
    } catch (e) {
      console.warn('tradeManager.closePosition: sendTelegram failed', e && e.message);
    }
    // attempt to persist closure if storage.saveTrade exists
    try {
      const storage = require('./storage');
      if (storage && typeof storage.saveTrade === 'function') {
        const updated = Object.assign({}, trade, { closedAt: new Date().toISOString(), closeMeta: res });
        try { await storage.saveTrade(updated); } catch (e) { console.warn('tradeManager.closePosition: saveTrade failed', e && e.message); }
      }
    } catch (e) {}
    return res;
  } catch (e) {
    console.error('tradeManager.closePosition: placeActiveOrder failed', e && e.message);
    try { await sendTelegram(`bybit: Auto-close failed for ${symbol}: ${e && e.message}`); } catch (ex) {}
    throw e;
  }
}

module.exports = {
  closePosition
};

/* Trade manager with kill-switch enforcement added.
   - If persistent kill-switch is enabled (set via POST /kill), openPosition will abort before placing any real orders.
   - All other behavior (qty calculation, leverage, TP/SL creation, reconciliation, atomic breakeven) is unchanged.
*/

const cfg = require('./config');
const { v4: uuidv4 } = require('uuid');
const { saveTrade, listOpenTrades, getTrade, getKillSwitch } = require('./storage');
const { getWalletBalance, setLeverage, placeMarketOrder, createConditionalOrder, cancelConditionalOrder, cancelOrder, getOrders, getConditionalOrders, fetchSymbolSpecs, quantize, getOpenPositions } = require('./bybit');
const { sendTelegram } = require('./telegram');
const { computeNextHourOpenISO } = require('./utils');

const ORDER_POLL_INTERVAL = 2000; // ms
const ORDER_POLL_TIMEOUT = 30 * 1000; // wait up to 30s for fills

function roundQtySimple(qty) {
  return Math.max(0.0001, Math.floor(qty * 10000) / 10000);
}

// compute effective qty given notional and price; handle symbol specifics
async function computeQty(symbol, entryPrice) {
  const spec = await fetchSymbolSpecs(symbol);
  const bal = await getWalletBalance();
  const perTrade = (bal / Math.max(1, cfg.MAX_OPEN_TRADES)) * 0.9;
  const notional = perTrade * cfg.LEVERAGE;
  if (!entryPrice || entryPrice <= 0) {
    const qty = Math.max(0.0001, notional);
    const q = quantize(spec, null, qty).qty;
    return q || roundQtySimple(qty);
  }
  let rawQty = notional / entryPrice;
  const q = quantize(spec, null, rawQty).qty;
  return q || roundQtySimple(rawQty);
}

// poll orders by orderLinkId and wait for fill or final state
async function waitForFill(symbol, orderLinkId, timeout = ORDER_POLL_TIMEOUT) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await getOrders(symbol, null, orderLinkId);
      if (res && res.result && res.result.list && res.result.list.length) {
        const o = res.result.list[0];
        const status = (o.orderStatus || o.status || '').toLowerCase();
        if (status === 'filled' || status === 'partiallyfilled') {
          return o;
        } else if (['cancelled','rejected','failed'].includes(status)) {
          return o;
        }
      }
    } catch (e) {
      // continue
    }
    await new Promise(r => setTimeout(r, ORDER_POLL_INTERVAL));
  }
  return null;
}

// ensure TP/SL cancellation on fills
async function cancelLinkedStops(trade) {
  try {
    if (trade.tpOrder && trade.tpOrder.result && trade.tpOrder.result.conditionalOrderId) {
      await cancelConditionalOrder(trade.symbol, trade.tpOrder.result.conditionalOrderId, null);
    }
  } catch (e) {
    console.warn('cancelLinkedStops TP cancel error', e.message);
  }
  try {
    if (trade.slOrder && trade.slOrder.result && trade.slOrder.result.conditionalOrderId) {
      await cancelConditionalOrder(trade.symbol, trade.slOrder.result.conditionalOrderId, null);
    }
  } catch (e) {
    console.warn('cancelLinkedStops SL cancel error', e.message);
  }
}

// Open a position end-to-end with reconciliation and safe linking
async function openPosition({ symbol, side, desiredQty = null, entryPrice = null, rootTf = null, rootMacd = 0 }) {
  // Enforce persistent kill-switch: if enabled, do not place real orders
  try {
    const kill = await getKillSwitch();
    if (kill) {
      const msg = `Kill-switch ENABLED — skipping order for ${symbol}.`;
      console.warn(msg);
      await sendTelegram(msg);
      return null;
    }
  } catch (e) {
    console.warn('Failed to read kill-switch; proceeding with caution', e.message);
  }

  // Enforce persisted + actual open positions
  const persistedOpen = await listOpenTrades();
  const openPositions = await getOpenPositions();
  const openCount = (persistedOpen ? persistedOpen.length : 0) + (openPositions ? openPositions.length : 0);
  if (openCount >= cfg.MAX_OPEN_TRADES) {
    const msg = `Max open trades reached (${openCount}/${cfg.MAX_OPEN_TRADES}); skipping ${symbol}`;
    console.warn(msg);
    await sendTelegram(msg);
    return null;
  }

  // set leverage best-effort
  try { await setLeverage(symbol, cfg.LEVERAGE); } catch (e) { console.warn('setLeverage err', e.message); }

  // compute qty
  let qty = desiredQty;
  if (!qty) qty = await computeQty(symbol, entryPrice);
  if (!qty || qty <= 0) qty = 0.0001;
  const orderLinkId = `scanner-${Date.now()}-${Math.floor(Math.random()*100000)}`;

  // place market order
  let entryResp;
  try {
    entryResp = await placeMarketOrder(symbol, side, qty, orderLinkId);
  } catch (e) {
    const msg = `Order placement failed for ${symbol}: ${e.message || e}`;
    console.error(msg);
    await sendTelegram(msg);
    return null;
  }

  // wait for fill or partial fill
  const filledOrder = await waitForFill(symbol, orderLinkId, ORDER_POLL_TIMEOUT);
  let executedPrice = entryPrice;
  if (filledOrder) {
    if (filledOrder.lastExecPrice) executedPrice = parseFloat(filledOrder.lastExecPrice);
    else if (filledOrder.price) executedPrice = parseFloat(filledOrder.price);
    else if (entryResp && entryResp.result && entryResp.result.trades && entryResp.result.trades.length) executedPrice = parseFloat(entryResp.result.trades[0].price);
  } else if (entryResp && entryResp.simulated) {
    executedPrice = entryPrice || 1;
  }

  // Compute TP/SL
  const tpPct = cfg.TP_PERCENT / 100.0;
  const slPct = cfg.SL_PERCENT / 100.0;
  let tpPrice = null, slPrice = null;
  if (executedPrice) {
    if (side.toLowerCase() === 'buy') {
      tpPrice = executedPrice * (1 + tpPct);
      slPrice = executedPrice * (1 - slPct);
    } else {
      tpPrice = executedPrice * (1 - tpPct);
      slPrice = executedPrice * (1 + slPct);
    }
  }

  // fetch symbol specs and quantize TP/SL and qty
  const specs = await fetchSymbolSpecs(symbol);
  const q = quantize(specs, null, qty);
  const quantQty = q.qty || qty;
  const quantTp = tpPrice ? quantize(specs, tpPrice, null).price : null;
  const quantSl = slPrice ? quantize(specs, slPrice, null).price : null;

  // create TP and SL conditional orders (best-effort)
  let tpOrder = null, slOrder = null;
  try {
    if (quantTp) tpOrder = await createConditionalOrder(symbol, side === 'Buy' ? 'Sell' : 'Buy', quantQty, quantTp);
  } catch (e) { console.warn('tp create err', e.message); }
  try {
    if (quantSl) slOrder = await createConditionalOrder(symbol, side === 'Buy' ? 'Sell' : 'Buy', quantQty, quantSl);
  } catch (e) { console.warn('sl create err', e.message); }

  // Persist trade
  const id = uuidv4();
  const trade = {
    id,
    symbol,
    side,
    qty: quantQty,
    entryPrice: executedPrice,
    entryResp,
    entryTime: new Date().toISOString(),
    rootTf,
    rootMacd,
    tpPercent: cfg.TP_PERCENT,
    slPercent: cfg.SL_PERCENT,
    tpPrice: quantTp,
    slPrice: quantSl,
    tpOrder,
    slOrder,
    status: 'OPEN',
    breakevenScheduledAt: computeNextHourOpenISO()
  };
  await saveTrade(trade);

  // Start a background reconciliation to cancel linked stops when entry filled (ensures OCO-like behavior)
  reconcileEntryAndLinked(trade).catch(e => console.error('reconcile error', e.message));

  await sendTelegram(`Opened ${side} ${symbol} qty=${quantQty} entry=${executedPrice}. TP=${quantTp} SL=${quantSl}. tradeId=${id}.`);
  return trade;
}

// Reconcile entry fills and ensure TP/SL cancellation on fills (to avoid opposite leftover)
async function reconcileEntryAndLinked(trade) {
  const ol = trade.entryResp && trade.entryResp.result && trade.entryResp.result.orderLinkId ? trade.entryResp.result.orderLinkId : null;
  const linkId = ol || null;
  const filled = await waitForFill(trade.symbol, linkId, 60 * 1000);
  if (!filled) {
    console.warn('No final fill seen; verifying orders');
  }
  try {
    await cancelLinkedStops(trade);
    trade.filledAt = new Date().toISOString();
    trade.status = 'OPEN';
    await saveTrade(trade);
  } catch (e) {
    console.warn('reconcile cancel error', e.message);
  }
}

// atomicBreakeven: cancel existing SL then create new SL at breakeven price; ensure cancel completed before creating new SL
async function atomicBreakeven(trade, newSlPrice) {
  try {
    if (trade.slOrder && trade.slOrder.result && trade.slOrder.result.conditionalOrderId) {
      await cancelConditionalOrder(trade.symbol, trade.slOrder.result.conditionalOrderId, null);
    }
  } catch (e) {
    console.warn('atomicBreakeven: cancel old sl error', e.message);
    throw e;
  }
  await new Promise(r => setTimeout(r, 1000));
  let newSlOrder = null;
  try {
    newSlOrder = await createConditionalOrder(trade.symbol, trade.side === 'Buy' ? 'Sell' : 'Buy', trade.qty, newSlPrice);
    trade.slPrice = newSlPrice;
    trade.slOrder = newSlOrder;
    trade.breakevenActivatedAt = new Date().toISOString();
    await saveTrade(trade);
    await sendTelegram(`Breakeven moved for ${trade.symbol} trade ${trade.id} to ${newSlPrice.toFixed(6)}`);
    return newSlOrder;
  } catch (e) {
    console.error('atomicBreakeven create failed', e.message);
    throw e;
  }
}

module.exports = {
  openPosition,
  atomicBreakeven
};
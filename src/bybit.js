// Replace the fetchUsdtPerpetualSymbols function in src/bybit.js with this version

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
      const sym = (it.symbol || it.name || '').toString();
      if (!sym) continue;
      const up = sym.toUpperCase();
      const quote = (it.quoteCoin || it.quote_coin || it.quote || it.quoteAsset || it.quote_asset || '').toString().toUpperCase();
      const status = (it.status || it.state || '').toString().toLowerCase();
      // require USDT quote or symbol ending with USDT
      if (quote && quote !== 'USDT' && !up.endsWith('USDT')) continue;
      // require not-dated & not anomalous
      if (up.includes('-')) continue;
      if (/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/i.test(up)) continue;
      if (/\d{4}/.test(up)) continue;
      // filter by status if present (prefer tradable/listed)
      if (status && !['tradable', 'listed', 'online', 'normal', ''].includes(status)) continue;
      // finally, ensure it looks like a USDT perpetual: endsWith USDT
      if (!up.endsWith('USDT')) continue;
      // allow symbols starting with digits (do not filter them)
      symbols.push(sym);
    }
    if (symbols.length) return symbols;
    // fallback: return naive list if nothing survived
    return list.map(r => (r.symbol || r.name)).filter(Boolean);
  } catch (e) {
    const status = (e && e.response && e.response.status) ? e.response.status : null;
    console.warn('bybit.fetchUsdtPerpetualSymbols error', e && e.message, status ? `status=${status}` : '');
    return [];
  }
}

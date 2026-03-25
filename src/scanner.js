// Replace only the fetchSymbolsFallback function in src/scanner.js with this version

async function fetchSymbolsFallback() {
  try {
    // Use bybit helper if present and requested market is linear
    if (bybit && typeof bybit.fetchUsdtPerpetualSymbols === 'function' && (cfg.BYBIT_MARKET === 'linear')) {
      const s = await bybit.fetchUsdtPerpetualSymbols();
      if (Array.isArray(s) && s.length) {
        // apply filter that only removes dated/expiry symbols
        return s.filter(sym => {
          if (!sym || typeof sym !== 'string') return false;
          const up = sym.toUpperCase();
          // must be USDT pair (for linear) and not contain '-' or date-like fragments
          if (cfg.BYBIT_MARKET === 'linear' && !up.endsWith('USDT')) return false;
          if (up.includes('-')) return false;           // skip dated contracts like "SOLUSDT-10APR26"
          if (/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/i.test(up)) return false;
          if (/\d{4}/.test(up)) return false;           // skip any that include a 4-digit year
          // allow leading digits (e.g., 1000000BABYDOGEUSDT)
          return true;
        });
      }
    }
  } catch (e) {}

  try {
    const base = (cfg.BYBIT_BASE_API || 'https://api-testnet.bybit.com').replace(/\/$/, '');
    const category = (cfg.BYBIT_MARKET === 'spot') ? 'spot' : 'linear';
    const url = `${base}/v5/market/instruments-info?category=${encodeURIComponent(category)}`;
    const res = await axios.get(url, { timeout: 10000 });
    const data = res && res.data;
    if (!data) return [];
    const list = (data.result && data.result.list) ? data.result.list : (data.result || []);
    const symbols = [];
    for (const it of list) {
      const sym = (it.symbol || it.name || '').toString();
      if (!sym) continue;
      const up = sym.toUpperCase();
      const quote = (it.quoteCoin || it.quote_coin || it.quote || it.quoteAsset || it.quote_asset || '').toString().toUpperCase();
      // skip non-USDT quotes unless symbol ends with USDT
      if (quote !== 'USDT' && !up.endsWith('USDT')) continue;
      // exclude dated / expiry / token-name anomalies:
      if (up.includes('-')) continue;                // "SOLUSDT-10APR26"
      if (/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/i.test(up)) continue;
      if (/\d{4}/.test(up)) continue;                // contains a 4-digit year
      // final check: for linear, ensure ends with USDT
      if (cfg.BYBIT_MARKET === 'linear' && !up.endsWith('USDT')) continue;
      // allow leading-digit symbols (do not filter them out)
      symbols.push(sym);
    }
    return [...new Set(symbols)];
  } catch (e) {
    // fallback v2
    try {
      const base = (cfg.BYBIT_BASE_API || 'https://api-testnet.bybit.com').replace(/\/$/, '');
      const url = `${base}/v2/public/symbols`;
      const res = await axios.get(url, { timeout: 8000 });
      const data = res && res.data;
      const list = data && data.result ? data.result : data;
      const syms = [];
      for (const it of (list || [])) {
        const sym = (it.name || it.symbol || '').toString();
        if (!sym) continue;
        const up = sym.toUpperCase();
        const quote = (it.quote_currency || it.quoteCurrency || '').toString().toUpperCase();
        if (quote !== 'USDT' && !up.endsWith('USDT')) continue;
        if (up.includes('-')) continue;
        if (/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/i.test(up)) continue;
        if (/\d{4}/.test(up)) continue;
        syms.push(sym);
      }
      return [...new Set(syms)];
    } catch (e2) {
      console.warn('fetchSymbolsFallback failed', e && (e.message || e));
      return [];
    }
  }
}

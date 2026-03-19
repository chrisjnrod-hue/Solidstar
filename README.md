# Bybit MTF MACD Scanner — Safe Trading Implementation

This repository implements a Render-compatible Node.js app that scans USDT perpetual symbols on Bybit for root MACD signals (1h, 4h, 1d), checks MTF alignment, and — when enabled — opens positions with conservative sizing, TP/SL, breakeven activation, and persisted trade lifecycle.

What's implemented (compared to the original draft):
- Persistent storage of trades using Redis (if REDIS_URL set) or in-memory fallback.
- Wallet balance retrieval (attempts v2 and v5 endpoints), used to compute position sizing.
- Position sizing: divides available balance across MAX_OPEN_TRADES and applies LEVERAGE to compute notional exposure; quantity computed from entryPrice.
- Leverage set per-symbol before entry (best-effort).
- Idempotent market order placement (orderLinkId) via Bybit v5 order endpoint; dry-run if OPEN_TRADES=false.
- Creation of TP and SL conditional orders (best-effort via v5 conditional order endpoint); dry-run safe mode supported.
- Breakeven logic: schedule breakeven activation for each new trade at the open of the next 1h candle; when triggered, attempts to move SL to entry +/- BREAKEVEN_PERCENT.
- MAX_OPEN_TRADES enforcement by checking persisted open trades.
- Trade lifecycle persistence and basic notifications via Telegram.
- Improved dry-run safety: when OPEN_TRADES=false the app will simulate orders and still compute sizing and schedule breakeven.

Important safety notes:
- Test thoroughly on Bybit testnet (set TESTNET=true and BYBIT_BASE_API/BYBIT_WS accordingly) before enabling live trading.
- Provide REDIS_URL in production to persist trades across restarts.
- Bybit API differences: endpoint paths and signing semantics vary between API versions; verify the endpoints and signatures for your Bybit account and adjust if necessary.
- Precise qty rounding and contract specs: this code uses a simple rounding function; for production you must adapt to each symbol's lot size/tick size rules.

How to run safely:
1. Fill .env with credentials; set TESTNET=true and OPEN_TRADES=false initially.
2. Start the app: npm ci && npm start
3. Observe Telegram alerts and / health endpoint.
4. When comfortable, set OPEN_TRADES=true and test on testnet. Only then switch to mainnet.

Next recommended improvements (I can implement):
- Exact contract sizing using symbol-specific lot/tick size rules (query exchange info).
- Robust order lifecycle: track fills/partial-fills, cancellations and replace TP/SL with linked bracket orders.
- Stronger Bybit API client with retries/backoff and improved v5 signing where required.
- Better queue and priority handling for signals, and rate-limit-aware scheduling.

If you'd like, I will:
- Add Redis instructions and sample Render Redis add-on configuration.
- Harden Bybit v5 signing and add unit tests for MACD and sizing.
- Implement symbol-specific rounding and fetch contract metadata automatically.

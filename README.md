# kukora — Multi-Exchange Crypto Arbitrage Platform

Real-time Bitcoin arbitrage detection, execution simulation, and risk management across 5 exchanges with live WebSocket order books, VWAP slippage modeling, and a composite opportunity scoring system.

---

## Challenge Requirements — Compliance Matrix

| Requirement | Status | Code Location |
|---|---|---|
| Arbitrage detection | ✅ | `server/arbitrageEngine.js` → `detectOpportunities()` |
| Multi-exchange (≥ 3) | ✅ 5 exchanges | Binance, Kraken, Bybit, OKX, Coinbase |
| Real-time order books | ✅ WebSocket | `server/exchangeService.js` — 4× WS + HTTP fallback |
| L2 depth / slippage | ✅ VWAP walk | `calcVwapSlippage()` in exchangeService |
| Trading fees | ✅ Per-exchange taker rates | `server/feeConfig.js` |
| Withdrawal fees | ✅ BTC + USDT per trade | `feeConfig.js` `WITHDRAWAL_FEES` |
| Latency modeling | ✅ Per-exchange | exchange timestamp → server receive; displayed in UI |
| Execution simulation | ✅ With partial fill | `executeSimulated()` in arbitrageEngine |
| Wallet simulation | ✅ With rollback | `server/walletManager.js` |
| P&L tracking | ✅ Realized + unrealized | `getPnL()` with drawdown, win rate, streak |
| Equity curve | ✅ Persisted | MongoDB + in-memory fallback |
| Circuit breakers | ✅ 4 levels | spread bounds + liquidity + daily loss stop |
| Risk controls | ✅ | `server/riskEngine.js` — VaR, Sharpe, arbRiskSummary |
| Real-time UI | ✅ SSE 800ms | `arbitrage.routes.js` + `useArbitrageStream.js` |
| Opportunity ranking | ✅ Score 0-100 | Profitability + Speed + Liquidity + Confidence + Slippage quality |
| Trade history | ✅ | Table + MongoDB `ArbitrageOp` model |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser  (React + Vite)                                        │
│  ArbitragePage ←── SSE /api/arbitrage/stream (800ms)           │
│       └── fallback polling /api/arbitrage/live every 2s         │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP + SSE
┌────────────────────────────▼────────────────────────────────────┐
│  Express (Node.js · server/index.js)                            │
│                                                                 │
│  ┌──────────────────────┐    ┌─────────────────────────────┐   │
│  │  arbitrageEngine.js  │    │   exchangeService.js         │   │
│  │  detectOpportunities │    │   WebSocket × 4              │   │
│  │  executeSimulated    │    │   HTTP fallback × 5          │   │
│  │  triangularSignal    │    │   VWAP walk (L2 depth)       │   │
│  │  daily P&L stop      │    │   snapshot/delta merge       │   │
│  └──────────────────────┘    └─────────────────────────────┘   │
│  ┌──────────────────────┐    ┌─────────────────────────────┐   │
│  │  walletManager.js    │    │   feeConfig.js               │   │
│  │  equity curve        │    │   single source of truth     │   │
│  │  realized P&L        │    │   taker + withdrawal fees    │   │
│  │  rollback on fail    │    └─────────────────────────────┘   │
│  └──────────────────────┘                                       │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  riskEngine.js — VaR, Sharpe, drawdown, arbRiskSummary  │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │ optional
┌────────────────────────────▼────────────────────────────────────┐
│  MongoDB Atlas — trade history + equity curve persistence       │
│  Graceful degradation: all features work without MongoDB        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Exchange Connections

| Exchange  | Method    | Depth levels | Latency     | Notes |
|-----------|-----------|--------------|-------------|-------|
| Binance   | WebSocket | L2-5         | ~5–15ms     | bookTicker + depth5@100ms |
| Kraken    | WebSocket | L2-10        | ~10–30ms    | book-10, snapshot + delta merge |
| Bybit     | WebSocket | L2-50        | ~5–20ms     | orderbook.50, snapshot + delta merge |
| OKX       | WebSocket | L2-5         | ~5–20ms     | books5 + tickers |
| Coinbase  | HTTP poll | None         | ~100–400ms  | No public L2 API — fixed slippage fallback |

**Coinbase note:** Coinbase's public API does not expose L2 order book data. All Coinbase legs use the 0.05% fixed slippage fallback, labeled `est.` in the UI. This is a known limitation, not a bug.

All WS connections auto-reconnect with exponential backoff (max 12 retries, capped at 30s delay).

---

## P&L Formula

Every opportunity computed in `detectOpportunities()`:

```
grossProfit      = (bidSell − askBuy) × amount
buyFee           = askBuy × amount × takerRate_buy
sellFee          = bidSell × amount × takerRate_sell
slippageCost     = VWAP_walk_buy + VWAP_walk_sell   (L2 depth when available, else 0.05% fixed)
withdrawalFeeUSD = btcFee_USD + usdtFee             (fixed per transaction, NOT scaled by amount)
─────────────────────────────────────────────────────
netProfit = grossProfit − buyFee − sellFee − slippageCost − withdrawalFeeUSD
```

`withdrawalFeeUSD` is deducted **once** in `detectOpportunities()`. `walletManager.applyTrade()` does not subtract it again (explicitly guarded against double-counting).

---

## VWAP Slippage Model

For exchanges with L2 data (Binance, Kraken, Bybit, OKX):

```
Walk order book levels until order is filled:
  avgFillPrice = Σ(qty_i × price_i) / totalQty
  slippageUSD  = |avgFillPrice − bestPrice| × amount
  slippagePct  = |avgFillPrice − bestPrice| / bestPrice × 100
```

Labeled `slippageMethod: 'real'` in UI → badge shows `VWAP L2`.  
Fallback to 0.05% fixed when depth unavailable → badge shows `est.`

---

## Composite Opportunity Score (0–100)

| Factor | Weight | Formula |
|---|---|---|
| Profitability | 50% | `min(50, netProfitPct / 0.1 × 20)` |
| Speed | 20% | `max(0, 20 − floor(totalLatencyMs / 50))` |
| Liquidity | 15% | `max(0, 15 − slippagePct / 0.01 × 3)` |
| Confidence | 10% | bothWS=10, oneWS=7, HTTP-only=5 |
| Slippage Quality | 5% | realVWAP=5, fallback=0 |

`minScore` slider in the UI filters which opportunities are auto-executed (default: 10).

---

## Fee Reference

| Exchange | Taker | BTC Withdrawal | USDT Withdrawal |
|---|---|---|---|
| Binance | 0.10% | 0.0002 BTC | $5 |
| Kraken | 0.26% | 0.0005 BTC | $8 |
| Bybit | 0.10% | 0.0003 BTC | $6 |
| OKX | 0.10% | 0.0002 BTC | $5 |
| Coinbase | 0.60% | 0.0006 BTC | $10 |

All values in `server/feeConfig.js` — single source of truth for the entire system.

---

## Risk Controls

| Control | Value | Location |
|---|---|---|
| Min net profit | $0.50 per trade | `arbitrageEngine.js MIN_NET_PROFIT` |
| Min spread (thin market) | 0.08% | `arbitrageEngine.js MIN_SPREAD_PCT` |
| Max spread (stale data) | 3.0% | `arbitrageEngine.js MAX_SPREAD_PCT` |
| **Daily loss stop** | **-$500 cumulative** | **`arbitrageEngine.js MAX_DAILY_LOSS`** |
| Liquidity check | depth ≥ 50% of order | `checkLiquidity()` in arbitrageEngine |
| Anti-duplicate fingerprint | 10s TTL | `arbitrage.routes.js recentFingerprints` |
| Partial fill | adaptive to balance | `executeSimulated()` ratio scaling |
| Balance rollback | post-trade integrity | `walletManager.applyTrade()` |
| Admin-protected reset | X-Admin-Token header | `POST /api/arbitrage/reset` |

---

## Triangular Signal

The engine scans 3-exchange chains using the correct compound return formula:

```js
// CORRECT compound return (not s1 + s2)
grossPct = ((1 + s1) × (1 + s2) − 1) × 100
netPct   = grossPct − totalFeePct − 0.10%  // 0.10% conservative slippage fallback (2 legs × 0.05%)
```

This is a **cross-exchange 3-leg detection signal**, displayed as informational only — not auto-executed. It is not single-exchange triangular arbitrage (which would require 3 currency pairs on one exchange).

---

## Known Limitations

| Limitation | Impact | Status |
|---|---|---|
| Coinbase has no L2 depth | All Coinbase legs use 0.05% slippage fallback (`est.` badge) | By design — Coinbase doesn't expose public L2 API |
| Wallet state in memory | Server restart resets balances to initial values | Trade history + equity curve persist via MongoDB |
| Triangular signal is informational only | Not auto-executed | Correct — cross-exchange chaining, not true single-exchange triangular arb |
| OKX only 5 depth levels | VWAP less precise than Bybit (50 levels) for large orders | Acceptable for 0.1 BTC simulation |

---

## Running Locally

```bash
npm install

# Copy and configure environment
cp .env.example .env

# Start backend (port 5000)
node server/index.js

# Start frontend in a separate terminal (port 5173)
npm run dev
```

- Backend: http://localhost:5000
- UI: http://localhost:5173
- Health: http://localhost:5000/health

---

## Deploying to Railway

```bash
railway up
```

Set these variables in Railway (Settings → Variables):

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI` | Recommended | MongoDB Atlas URI — enables trade history + equity curve persistence across deploys |
| `ADMIN_TOKEN` | **Recommended** | Protects `POST /api/arbitrage/reset` — without this the endpoint is open |
| `FRONTEND_URL` | If separate domain | Added to CORS allowlist |
| `WALLET_BTC` | Optional | Initial BTC per exchange (default: `1`) |
| `WALLET_USDT` | Optional | Initial USDT per exchange (default: `70000`) |

Generate a secure admin token:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then call protected endpoints with:
```
POST /api/arbitrage/reset
Headers: X-Admin-Token: <your_token>
```

---

## Demo Notes

**Cold start:** WebSocket connections initialize on server start. The first 5–15s may show HTTP fallback badges on all exchanges while WS handshakes complete. This is expected behavior, not a failure.

**Empty equity curve after deploy:** If MongoDB is configured and a fresh deploy was made, the equity curve begins empty. This is correct — the previous session's history is there but requires the bot to run at least one trade to display.

**Simultaneous users:** Rate limit is 300 req/min across all endpoints. SSE connections do not count as repeated requests.

---

## Key Files

```
server/
  arbitrageEngine.js       core detection, scoring, triangular signal, daily P&L stop
  exchangeService.js       WS × 4 + HTTP fallback + VWAP slippage from L2 depth
  arbitrage.routes.js      SSE stream (800ms loop), REST endpoints, admin token on /reset
  walletManager.js         simulated wallets, P&L, equity curve, rollback
  feeConfig.js             single source of truth: taker rates, withdrawal fees
  riskEngine.js            VaR, Sharpe, drawdown, arbRiskSummary
  scoringService.js        asset-level scoring for Intelligence page (NOT arb scoring)
  index.js                 Express + helmet + CORS + rate limit + MongoDB

src/pages/
  ArbitragePage.jsx        main trading UI (SSE real-time, score slider, equity curve)

src/hooks/
  useArbitrageStream.js    SSE client with exponential backoff reconnect
  usePolling.js            REST fallback polling (2s interval)

src/components/layout/
  Layout.jsx               sidebar: Principal / Herramientas / Análisis Cuantitativo / 🔬 Investigación
```

---

## Research Modules

These modules are grouped under **🔬 Investigación** in the sidebar. They are independent quantitative research tools — not part of the core arbitrage pipeline:

| Module | Description |
|---|---|
| Forecast | Price projection with confidence intervals (GBM-based) |
| Market Regime | Trend / range / crisis regime detection |
| Correlation Galaxy | Animated live correlation network |
| Monte Carlo | GBM price path simulation (thousands of trajectories) |
| Backtest | Strategy testing on historical OHLCV data |

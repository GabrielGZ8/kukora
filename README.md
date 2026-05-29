# kukora — Multi-Exchange Crypto Arbitrage Bot

Real-time arbitrage detection across Binance, Kraken, Bybit and Coinbase.
WebSocket connections, composite scoring, persistent equity curve.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend (React + Vite)                                    │
│  ArbitragePage ← SSE stream ← arbitrage.routes.js          │
│       └─ fallback polling every 2s (read-only)             │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP + SSE
┌───────────────────────────▼─────────────────────────────────┐
│  Express Server (Node.js)                                   │
│  ┌──────────────────┐  ┌───────────────────┐               │
│  │ arbitrageEngine  │  │  exchangeService  │               │
│  │ detectOps()      │  │  WebSocket × 3    │               │
│  │ executeSimulated │  │  HTTP fallback    │               │
│  │ triangularSignal │  │  order book depth │               │
│  └──────────────────┘  └───────────────────┘               │
│  ┌──────────────────┐  ┌───────────────────┐               │
│  │  walletManager   │  │  scoringService   │               │
│  │  equity curve    │  │  0-100 composite  │               │
│  │  realized P&L    │  │  + fee efficiency │               │
│  └──────────────────┘  └───────────────────┘               │
└─────────────────────────────────────────────────────────────┘
                            │ optional
┌───────────────────────────▼─────────────────────────────────┐
│  MongoDB Atlas (trade history, equity curve persistence)    │
└─────────────────────────────────────────────────────────────┘
```

---

## Exchange Connections

| Exchange  | Method       | Latency         | Depth data |
|-----------|--------------|-----------------|------------|
| Binance   | WebSocket    | ~5–15ms real    | Yes (L2-5) |
| Kraken    | WebSocket    | ~10–30ms real   | No         |
| Bybit     | WebSocket    | ~5–20ms real    | No         |
| Coinbase  | HTTP poll    | ~100–400ms      | No         |

Latency shown in the UI is **real end-to-end** (exchange event timestamp → UI render), not a static value.

WS connections auto-reconnect with exponential backoff (max 12 retries, capped at 30s).

---

## Arbitrage Detection

Each tick (800ms) the engine:

1. Reads live order books from all 4 exchanges
2. Computes all N×(N-1) directional pairs
3. For each pair calculates:

```
grossProfit = (bidSell − askBuy) × amount
buyFee      = askBuy × amount × fee_rate_buy
sellFee     = bidSell × amount × fee_rate_sell
slippageCost = realSlippage_buy + realSlippage_sell  (from L2 order book when available)
netProfit   = grossProfit − buyFee − sellFee − slippageCost
```

4. Slippage is computed from Binance's live L2 order book (depth-5) using VWAP walk:

```
avgPrice = Σ(fill_i × price_i) / totalAmount
slippageUSD = |avgPrice − topPrice| × amount
```

5. A **composite score (0–100)** is assigned to viable opportunities:

| Factor         | Weight | Description                              |
|----------------|--------|------------------------------------------|
| Profitability  | 55%    | netProfitPct normalized (cap at 0.275%)  |
| Speed          | 20%    | Penalizes +1pt per 50ms combined latency |
| Liquidity      | 10%    | Lower slippage% = higher score           |
| Confidence     | 10%    | Both WS=10, one WS=7, HTTP-only=5        |
| Fee Efficiency |  5%    | Penalizes if fees > 40% of gross profit  |

6. Circuit breakers:
   - Spread < 0.1% of ask price → blocked (too thin)
   - Spread > 5% of ask price → blocked (likely stale/bad data)

---

## Fee Rates

| Exchange  | Maker/Taker |
|-----------|-------------|
| Binance   | 0.10%       |
| Kraken    | 0.26%       |
| Bybit     | 0.10%       |
| Coinbase  | 0.60%       |

---

## Triangular Signal Detection

The engine also scans for 3-leg chains (A→B→C) and surfaces the best one as an informational signal on the dashboard. This is a **detection-only** feature — execution is 2-leg only.

---

## Scoring Formula (complete)

```
score = min(55, netProfitPct/0.1 × 20)       // profitability
      + max(0, 20 − floor(totalLatencyMs/50)) // speed
      + max(0, 10 − slippagePct/0.01 × 2)    // liquidity
      + (bothWS=10, oneWS=7, HTTP=5)          // confidence
      + feeEfficiency(0|1|3|5)               // fee ratio
```

---

## Running Locally

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Fill MONGODB_URI (optional), set NODE_ENV=development

# Start backend
node server/index.js

# Start frontend (separate terminal)
npm run dev
```

Server: http://localhost:5000  
Vite UI: http://localhost:5173

---

## Deploying to Railway

```bash
# railway.toml is already configured
railway up
```

Set `MONGODB_URI` and `FRONTEND_URL` as Railway environment variables (not in .env).

---

## Key Files

```
server/
  arbitrageEngine.js   — core detection, scoring, triangular signal
  exchangeService.js   — WS connections + HTTP fallback + real slippage
  arbitrage.routes.js  — SSE stream, background loop (800ms), REST endpoints
  walletManager.js     — simulated wallets, P&L, equity curve
  index.js             — Express + helmet + CORS + MongoDB

src/
  pages/ArbitragePage.jsx   — main trading UI (real-time)
  hooks/useArbitrageStream.js — SSE client with reconnection
  components/layout/Layout.jsx — sidebar, topbar, market mood
```

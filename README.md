# kukora — Bitcoin Arbitrage Intelligence Platform

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Deploy](https://img.shields.io/badge/deploy-Railway-purple)
![Exchanges](https://img.shields.io/badge/exchanges-5-blue)
![Detection](https://img.shields.io/badge/detection-event--driven%20WS-orange)

> Real-time Bitcoin arbitrage across 5 exchanges.
> Event-driven detection <30ms · VWAP L2 slippage · 7-factor scoring · quantitative volatility engine.

## 🚀 Live Demo

**URL:** https://kukora.up.railway.app

## ✨ Features

- **5 exchanges** simultaneously: Binance, Kraken, Bybit, OKX, Coinbase
- **Event-driven WS detection** — arbitrage opportunities found in <30ms
- **Real L2 VWAP slippage** computed from live order book depth on 5 exchanges
- **7-factor composite scoring** with log-scale profitability curve
- **4-level circuit breaker**: spread bounds + liquidity check + daily stop + fingerprint dedup
- **Pre-funded bilateral model** — institutional-grade execution model
- **MongoDB-backed equity curve** with graceful in-memory fallback
- **SSE real-time UI** with permanent reconnect and silence detection

---

## Detection Architecture — Event-Driven

### Why event-driven matters

Most arbitrage systems use polling every N seconds. Kukora uses detection event-driven, triggered on every WS message:

```
Traditional (polling):
  WS message → wait loop (up to 800ms) → detect → execute
  Total latency: 800ms–1800ms

Kukora (event-driven):
  WS message → emit('priceUpdate') → detect → execute
  Total latency: < 30ms
```

### Components

- `exchangeService.js` emits `priceUpdate` on every WS message via EventEmitter
- `arbitrage.routes.js` listens to the event and immediately triggers detection
- SSE loop (150ms) only updates the UI — does not block detection
- Cache TTL reduced to 150ms for always-fresh data

---

## Execution Model — Pre-funded Bilateral

Kukora implements pre-funded bilateral arbitrage — the standard model in professional institutional systems:

- Wallets pre-funded with BTC and USDT on all 5 exchanges simultaneously
- Each trade: buy BTC on exchange A + sell BTC on exchange B simultaneously, without inter-exchange asset transfers
- **Withdrawal fees** = periodic rebalancing cost (~every 24h), not deducted per-trade
- Matches the official challenge example model (only trading fees deducted per operation)

### P&L Formula

```
netProfit = grossProfit − buyFee − sellFee − slippageCost
```

*[Informational]* withdrawalCostPeriodic ≈ $25–56 per rebalancing round (amortized across ~50 trades)

### Official Challenge Example (matched exactly)

```
Exchange A (Kraken): Buy Ask $70,000 + fee $70   = cost $70,070
Exchange B (Binance): Sell Bid $70,250 − fee $70.25 = income $70,179.75
Net profit: $109.75 USD
```

Only trading fees deducted → pre-funded bilateral model.

---

## Composite Opportunity Score (0–100)

| Factor        | Max pts | Formula                                         |
|---------------|---------|------------------------------------------------ |
| Rentabilidad  | 35      | `log1p(netProfitPct×500)×5.5`, capped at 35     |
| Liquidez      | 20      | `max(0, 20×(1−slipRatio×1.5))`                  |
| Persistencia  | 15      | Optimal zone 0.10%–0.80% spread                 |
| Latencia      | 15      | 15 if both WS, degrades with HTTP ms            |
| Confianza     | 10      | WS source (6pts) + VWAP method (4pts)           |
| Penalización  | −3 pts  | Feed age > 3s                                   |

---

## Risk Controls

| Control               | Value        | Description                                   |
|-----------------------|--------------|-----------------------------------------------|
| MIN_NET_PROFIT        | $0.10        | Minimum net profit per trade                  |
| MIN_SPREAD_PCT        | 0.02%        | Circuit breaker lower bound                   |
| MAX_SPREAD_PCT        | 3.0%         | Circuit breaker upper bound (stale data guard)|
| MAX_DAILY_LOSS        | −$500        | Daily stop-loss — bot halts automatically     |
| FINGERPRINT_TTL       | 5,000ms      | Dedup window — same price level               |
| MIN_EXEC_INTERVAL     | 300ms        | Min time between loop executions             |
| EVENT_EXEC_COOLDOWN   | 300ms        | Min time between event-driven executions      |
| Balance validation    | pre-check    | Balances verified before execution, rollback  |

---

## Stack

| Layer     | Tech                                              |
|-----------|---------------------------------------------------|
| Frontend  | React + Vite + Recharts                           |
| Backend   | Node.js + Express                                 |
| Realtime  | SSE (client) + EventEmitter (server)              |
| WS feeds  | Binance, Kraken, Bybit, OKX (4× concurrent)       |
| HTTP feed | Coinbase (dual /buy + /sell for real spread)      |
| Database  | MongoDB Atlas (optional, in-memory fallback)      |
| Deploy    | Railway                                           |

---

## Setup

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Set MONGODB_URI (optional), PORT, ADMIN_TOKEN

# Run development
npm run dev

# Run smoke tests
node tests/smoke.test.js
```

---

## Tests

```bash
node tests/smoke.test.js
# → ✅ All 8 tests passed — Kukora smoke test OK
```

Tests cover: fee config values, VWAP slippage calculation, opportunity detection with viable spread, circuit breaker activation, trade execution, score range validation, and pre-funded bilateral model correctness.

---

## API Endpoints

| Endpoint                       | Description                            |
|--------------------------------|----------------------------------------|
| `GET /api/arbitrage/stream`    | SSE real-time stream (primary)         |
| `GET /api/arbitrage/live`      | REST snapshot (fallback)               |
| `GET /api/arbitrage/stats`     | Detailed system stats + counters       |
| `GET /api/arbitrage/history`   | Trade history                          |
| `GET /api/arbitrage/wallets`   | Current wallet balances                |
| `POST /api/arbitrage/bot`      | Toggle bot on/off, set min score       |
| `POST /api/arbitrage/reset`    | Reset wallets + equity curve           |

---

## Why Kukora Wins

1. **Event-driven WS detection** — < 30ms latency (vs 800ms–5s polling in typical systems)
2. **Real L2 VWAP slippage** computed from 4 simultaneous live order books
3. **7-factor composite scoring** with log-scale profitability curve — avoids identical scores
4. **4-level circuit breaker**: spread bounds + liquidity + daily stop + fingerprint dedup
5. **Institutional pre-funded model** matching real professional arbitrage (Jump, Cumberland, DRW)
6. **MongoDB-backed equity curve** with graceful in-memory fallback + synthetic baseline on cold start
7. **5-exchange coverage**: Binance, Kraken, Bybit, OKX, Coinbase
8. **Permanent SSE reconnect** with proactive silence detection (10s timeout)

---

## Deployment

Railway is the recommended platform (included `railway.toml` + `Procfile`).

```toml
# railway.toml already configured
[build]
builder = "nixpacks"

[deploy]
startCommand = "node server/index.js"
```

Environment variables:
- `MONGODB_URI` — MongoDB Atlas connection string (optional)
- `PORT` — Server port (Railway sets automatically)
- `ADMIN_TOKEN` — Protects `/reset` endpoint
- `WALLET_BTC` — Initial BTC per exchange (default: 1)
- `WALLET_USDT` — Initial USDT per exchange (default: 70000)

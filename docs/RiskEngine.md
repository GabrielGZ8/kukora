# Kukora — Risk Engine

## Overview

The risk engine is a two-layer system:

| Layer | Module | Purpose |
|---|---|---|
| Portfolio / Asset Risk | `riskEngine.js` | Asset volatility scores, concentration risk, exchange reliability scores used for *opportunity scoring* |
| Operational Risk | `advancedRiskEngine.js` | Live circuit breakers, drawdown monitoring, exposure limits, pre-trade checks that *halt execution* |

Both layers are hot-configurable via `liveConfig.js` with no restart required.

---

## Operational Risk Engine (`advancedRiskEngine.js`)

### Drawdown Protection

Real-time drawdown tracking from the session's equity peak.

```
drawdownPct = (peakEquity - currentEquity) / peakEquity × 100
```

On every pre-trade check, `checkDrawdown(currentEquityUSD)` compares against `maxDrawdownPct`
(default: 10%). Breach activates the circuit breaker automatically.

**Design decision**: drawdown is measured from the session peak (high-water mark), not from
initial capital. This means a strategy that earns 5% then loses 6% from peak triggers at 6%
drawdown, not 1% net loss. This is industry-standard for fund drawdown measurement.

### Exposure Limits

Two dimensions of exposure are tracked:

1. **Per-exchange**: `maxExposurePerExchange` (default: 40%) — no single exchange should hold
   more than this fraction of total capital. Protects against exchange insolvency / hack.

2. **Per-asset**: `maxExposurePerAsset` (default: 60%) — prevents over-concentration in BTC
   or USDT across all exchanges.

Both are checked after every trade via `checkExposureLimits()`. Violations emit a structured
warning event but do not halt trading unless they exceed the circuit breaker threshold.

### Circuit Breakers

Four independent circuit breaker triggers:

| Trigger | Parameter | Default |
|---|---|---|
| Consecutive failures | `maxConsecutiveFailures` | 5 |
| Session drawdown | `maxDrawdownPct` | 10% |
| Daily loss | `maxDailyLossUSD` | -$500 |
| Emergency stop | `emergencyStopThreshold` | -$1,000 |

**Auto-reset**: Circuit breakers triggered by consecutive failures auto-reset after 5 minutes.
Drawdown and daily loss circuit breakers require manual reset (POST `/api/arbitrage/risk/circuit-breaker/reset`).

**Design decision**: Separate auto-reset for transient failures vs. manual reset for structural
losses. Transient failures (API hiccups) should not permanently halt trading; large losses should
require human review.

### Slippage Circuit Breaker

`recordSlippage(slippagePct)` maintains a rolling window of the last 50 slippage observations.
If 3 of the last 5 exceed `maxSlippagePct`, a circuit breaker activates. This detects
deteriorating market conditions before they cause meaningful losses.

### Pre-Trade Risk Check

`preTradeRiskCheck(opportunity, wallets, currentEquityUSD, sessionPnl)` runs all checks in order:

1. Circuit breaker active?
2. Daily loss exceeded?
3. Emergency stop threshold exceeded?
4. Drawdown exceeded?
5. Position size within limits?
6. Slippage estimate within limits?

Returns `{ ok, checks[], blockedBy }`. A `false` result halts the trade with a structured
RCA entry explaining which rule blocked it.

---

## Recovery Engine (`tradeStateMachine.js`)

The recovery engine handles post-execution failure scenarios. `executeRecovery(tradeId, scenario, context)`
routes each scenario to the appropriate action:

| Scenario | Action (< maxRetries) | Action (≥ maxRetries) |
|---|---|---|
| `buy_succeeded_sell_failed` | retry | hedge |
| `sell_succeeded_buy_failed` | emergency_liquidation | emergency_liquidation |
| `exchange_timeout` | retry (exponential backoff) | cancel |
| `api_outage` + exposure | emergency_liquidation | emergency_liquidation |
| `api_outage` + no exposure | cancel | cancel |
| `insufficient_liquidity` | cancel | cancel |
| `insufficient_balance` | cancel (+ trigger rebalance) | cancel |
| `price_moved_against` | cancel | cancel |

**Design decision**: `sell_succeeded_buy_failed` always triggers emergency liquidation because
we have created a synthetic short position. The risk of holding this exceeds any retry benefit.

---

## Hedge Engine (`tradeStateMachine.planHedge`)

When a trade leaves residual exposure after a failure, the hedge planner proposes three strategies
in priority order:

1. **Spot hedge**: Sell/buy the residual on the same exchange (fastest, lowest cost)
2. **Cross-exchange hedge**: Transfer then sell on a different exchange (slower, more liquid)
3. **Synthetic hedge**: Short via perpetual futures (requires separate API integration)

The recommendation always prefers the spot hedge unless liquidity is insufficient.

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/arbitrage/risk/status` | Full risk engine state |
| `POST /api/arbitrage/risk/circuit-breaker/reset` | Manual circuit breaker reset |

---

## Configuration Reference

All values are hot-reloadable via `POST /api/arbitrage/config`.

| Parameter | Default | Range | Description |
|---|---|---|---|
| `maxDrawdownPct` | 10 | 0.1–100 | Halt if drawdown > this % |
| `maxExposurePerExchange` | 0.40 | 0.05–1 | Max capital fraction per exchange |
| `maxExposurePerAsset` | 0.60 | 0.05–1 | Max capital fraction per asset |
| `maxPositionValueUSD` | 10,000 | 100–1M | Max position size in USD |
| `maxConsecutiveFailures` | 5 | 1–50 | Circuit breaker threshold |
| `emergencyStopThreshold` | -1,000 | ≤0 | Emergency stop P&L level |
| `maxDailyLossUSD` | -500 | ≤0 | Daily loss limit |
| `maxSlippagePct` | 0.15 | 0–5 | Maximum acceptable slippage |

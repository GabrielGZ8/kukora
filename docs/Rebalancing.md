# Kukora — Rebalancing System

## Overview

Rebalancing moves capital between exchanges to ensure the system can always fill arbitrage
opportunities on both legs. v17 adds predictive rebalancing that fires *before* imbalance
occurs, replacing the previous purely reactive model.

---

## Two-Mode Rebalancing

### Reactive (existing, enhanced)

Triggers when a wallet metric breaches a configured threshold:

- `rebalanceThresholdPct` (default: 70%) — if any exchange holds > 70% of total USDT
- BTC shortage — if any exchange holds < 50% of its target BTC allocation

`rebalanceEngine.suggestRebalance(btcPrice)` returns a ranked list of suggested transfers
with cost/benefit analysis. Only suggestions with `viable: true` are executed.

**Viability criteria**:
1. Transfer cost ≤ `rebalanceCostLimit` (default: $50)
2. Transfer amount ≥ `minimumTransferAmount` (default: $100)
3. Sufficient source balance

### Predictive (new in v17)

Uses rolling historical trade data to forecast when each exchange's balance will be depleted.

```
depletionHours = currentBalance / consumptionRatePerHour
```

If `depletionHours < rebalancePredictionWindow / 3600`, a rebalance recommendation is generated
*before* the shortage occurs.

**Urgency levels**:
- `critical`: depletion < 30 minutes
- `high`: depletion < 2 hours
- `medium`: depletion < prediction window

---

## Capital Efficiency Engine (Section 10)

`predictiveRebalance.computeCapitalEfficiency(wallets, btcPrice, sessionPnl, tradeCount, uptimeMs)` returns:

| Metric | Description |
|---|---|
| `utilizationRatio` | Fraction of capital actively used in recent trades |
| `utilizationScore` | Utilization as 0–100 score |
| `capitalEfficiencyScore` | Utilization × annualized ROI / 100 |
| `opportunityCoverageScore` | Fraction of opportunities coverable with current balances |
| `roiAnnualizedPct` | Projected annual return at current P&L rate |
| `idleExchanges` | Exchanges with capital but low trade activity |
| `optimalDistribution` | Recommended balance per exchange based on activity history |

**Design decision**: Utilization is measured over a 1-hour rolling window. Cold-start
(first hour of session) will show low utilization — this is expected and not a bug.

---

## Optimal Distribution Algorithm

Based on historical buy/sell activity per exchange:

```
optimalUSDT[exchange] = totalUSDT × max(0.1, buyActivityShare[exchange])
optimalBTC[exchange]  = totalBTC  × max(0.1, sellActivityShare[exchange])
```

Buy-heavy exchanges (frequently the buy leg) need more USDT.
Sell-heavy exchanges (frequently the sell leg) need more BTC.
The 0.1 floor ensures no exchange is starved below 10% of total.

---

## Transfer Cost Model

Withdrawal fees are loaded from `feeConfig.js` (WITHDRAWAL_FEES map). When feeConfig data
is unavailable, conservative fallbacks are used:
- BTC: 0.0003 BTC (≈ $15 at $50k)
- USDT: $6 flat (ERC-20 gas estimate)

Costs are always computed in USD for apples-to-apples comparison with `rebalanceCostLimit`.

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/arbitrage/rebalance/analyze` | Current balance distribution and imbalances |
| `GET /api/arbitrage/rebalance/suggest` | Suggested rebalance actions with cost/benefit |
| `GET /api/arbitrage/rebalance/predict` | Predictive recommendations (v17) |
| `GET /api/arbitrage/rebalance/consumption` | Balance consumption rates and depletion forecast |
| `POST /api/arbitrage/rebalance/execute` | Execute a suggested rebalance |
| `GET /api/arbitrage/rebalance/history` | Rebalance action history |
| `GET /api/arbitrage/capital-efficiency-v2` | Capital efficiency metrics (v17) |

---

## Configuration Reference

| Parameter | Default | Description |
|---|---|---|
| `rebalanceThresholdPct` | 0.70 | USDT concentration trigger (reactive) |
| `rebalancePredictionWindow` | 3600s | Look-ahead for predictive rebalancing |
| `rebalanceCostLimit` | $50 | Max rebalance cost before skipping |
| `minimumTransferAmount` | $100 | Minimum transfer amount |
| `capitalAllocationMode` | 'equal' | How capital is split: equal / weighted / dynamic |
| `reserveCapitalPct` | 0.10 | Fraction of capital not deployed |

---

## Live Inventory Reconciliation — a second, distinct rebalancing system

Everything above (`rebalanceEngine.js` + `predictiveRebalance.js`) operates on the **simulated**
wallet model (`walletManager.js`) used by the paper-trading engine. There is a second, separate
module — `server/application/liveInventoryReconciliation.js`, exposed at
`GET /api/trading/reconciliation` — that reconciles the **real** balances held on the live
exchange accounts `liveExecution.executeCrossExchangeLive()` trades against, fetched via each
exchange's authenticated account/balance endpoint. It never initiates a transfer itself; it
returns the numbers an operator (or a future automated transfer step) needs to act on.

This module implements the exact mechanism described to the judging committee in the Phase 1
response to Question 3 — *"if the system observes that over the last N executions one exchange
has consistently been the buyer and another the seller, it can anticipate future inventory
imbalances and rebalance before critical thresholds are reached"* — via a dedicated pure domain
module, `server/domain/directionalBiasTracker.js`:

1. **Reactive check** (existing): flags an exchange once it already holds more than
   `QUOTE_MAX_CONCENTRATION` (65%) of total quote-currency balance across configured exchanges.
2. **Predictive check** (directional bias): independently of the reactive check, looks at the
   last `N=20` live `CROSS_EXECUTE_SUCCESS` trades (from `liveExecution.getAuditLog()`) and
   computes a per-exchange bias score `(buys − sells) / N`. An exchange that has been
   consistently the **sell side** — and therefore is *accumulating* quote currency — gets a
   predictive suggestion once its bias is strong (`|biasScore| ≥ 0.7`, minimum 8-trade sample)
   **and** its concentration has already crossed a lower, informational threshold
   (`PREDICTIVE_MIN_CONCENTRATION`, 45%) — i.e. before it reaches the 65% reactive trigger.
   Buy-biased exchanges are not flagged this way, since buying *drains* quote currency rather
   than accumulating it; that side is instead covered by the reactive check running low.

Every entry in `checkInventory()`'s `suggestions` array carries a `trigger: 'reactive' |
'predictive'` field so the operator (and, in the response payload, the committee) can see which
mechanism fired. An exchange already flagged reactively is never double-flagged predictively.

```
GET /api/trading/reconciliation
{
  "ok": true,
  "data": {
    "balances": [...],
    "suggestions": [
      { "trigger": "predictive", "from": "binance", "to": "kraken",
        "biasScore": -0.85, "sampleSize": 20, "reason": "..." }
    ],
    ...
  }
}
```

See `tests/directionalBiasTracker.test.js` (pure bias-scoring logic) and
`tests/liveInventoryReconciliation.test.js` (integration, including the predictive suggestions)
for the full behavioral spec.

## Wallets/rebalancing robustness fixes (kukora audit session)

Three bugs found and fixed together in `rebalanceEngine.js` / `walletManager.ts`
— see `MIGRATION_CLEANUP_LOG.md` ("Sesión 3") for the full writeup:

1. `rebalanceEngine.js`'s exchange list is now derived from
   `exchangeRegistry.getEnabledExchangeNames()` instead of a hardcoded
   literal, matching `liveConfig.js` / `walletManager.js` /
   `arbitrageOrchestrator.js`.
2. `executeRebalance(suggestion, btcPrice)` — the real 2-argument call made
   by `POST /api/arbitrage/rebalance/execute` — previously could never
   succeed, because the function's old 3-argument signature meant `wallets`
   silently received the BTC price (a number) instead of a balances object.
   `walletManager.applyRebalanceTransfer()` is the fix: it validates and
   mutates the module's real wallet state (mirroring `_applyTradeInternal`'s
   validate-then-mutate-then-integrity-check pattern), and `executeRebalance`
   now calls it and returns `walletsAfter` from that real state.
3. Because `executeRebalance` is reachable with a client-supplied
   `suggestion` object (see `config.routes.js`'s `req.body.suggestion`
   fallback), `suggestion.viable` is not treated as a trustworthy
   authorization signal by itself anymore — `asset`/`from`/`to`/`amount` are
   independently validated against the known exchange list before any
   balance is touched, and the withdrawal fee is recomputed server-side.

Regression coverage: `tests/rebalance.test.js`.

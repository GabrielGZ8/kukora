# Kukora — Analytics & Observability

## Observability Architecture (Section 14)

All events flow through `observabilityService.emit(category, event, data, level, traceId)`.

**No `console.log` in production code paths.** Every meaningful event is structured and
categorized. This enables future log aggregation (Datadog, Splunk, CloudWatch) with zero
code changes — just pipe `stdout` to the collector.

### Event Categories

| Category | Events |
|---|---|
| `OPPORTUNITY` | detected, scored, rejected, expired |
| `EXECUTION` | order lifecycle, fills, settlements, quality |
| `RISK` | circuit breaker activated/reset, exposure violations, drawdown alerts |
| `REBALANCE` | triggered, planned, executed, predictive critical |
| `CONFIG` | parameter changes, resets |
| `SYSTEM` | startup, shutdown, health, errors |
| `EXCHANGE` | connectivity, latency, failures |

### Event Schema

```json
{
  "ts":       "2025-01-15T14:23:01.234Z",
  "category": "EXECUTION",
  "event":    "execution.trade_completed",
  "level":    "info",
  "data": {
    "pair":       "Binance→OKX",
    "netProfit":  8.50,
    "size":       0.05,
    "score":      72.3,
    "timing":     { "totalLatencyMs": 8 }
  },
  "traceId": null
}
```

---

## Root Cause Analysis (Section 15)

Every rejected opportunity generates a machine-readable RCA entry:

```json
{
  "ts":         "2025-01-15T14:23:01.234Z",
  "pair":       "Binance→OKX",
  "category":   "score_too_low",
  "reason":     "Score 42 below minimum 65",
  "humanReadable": "Trade on Binance→OKX rejected: composite score 42.0 is below minimum 65 threshold...",
  "machineReadable": {
    "category":       "score_too_low",
    "ruleViolated":   "minScore",
    "parameterValues": { "minScore": 65 },
    "severity":       "low",
    "recoverable":    true
  },
  "diagnostics": { "opportunitySnapshot": { ... } }
}
```

**RCA Categories:**
- `score_too_low` — composite score below `minScore`
- `spread_too_small` — spread below `minSpreadPct`
- `spread_too_large` — spread above `maxSpreadPct` (likely stale data)
- `liquidity_insufficient` — order book too thin
- `balance_insufficient` — wallet balance too low
- `daily_loss_exceeded` — session loss limit hit
- `drawdown_exceeded` — drawdown limit hit
- `circuit_breaker_active` — circuit breaker is on
- `slippage_too_high` — estimated slippage exceeds limit
- `fees_exceed_profit` — fees > gross spread
- `cooldown_active` — inter-trade cooldown

`GET /api/arbitrage/observability/rca?category=score_too_low&limit=50` — filtered RCA log.

---

## Execution Quality Analytics (Section 6)

`recordExecutionQuality()` computes profit capture for every completed trade:

```
profitCapture = realizedProfit / expectedProfit
```

A `profitCapture` of 1.0 means the trade performed exactly as modeled.
Values < 0.75 indicate systematic slippage estimation error.

**Aggregate dashboard** (`GET /api/arbitrage/observability/dashboard`):
- `avgProfitCapture` — rolling average across all trades
- `avgFillQuality` — rolling average fill ratio
- `totalMissedProfit` — cumulative profit lost to slippage
- `byVerdict` — count of excellent/good/acceptable/poor executions
- `byPair` — per-exchange-pair breakdown

---

## ML Scoring Pipeline (Section 13)

`mlScoringPipeline.scoreOpportunity(opportunity, context)` returns:

| Output | Description |
|---|---|
| `mlScore` | Composite score 0–100 |
| `executionProbability` | P(trade executes successfully), 0–1 |
| `fillProbability` | P(full fill vs partial), 0–1 |
| `profitQuality` | Risk-adjusted expected profit score |
| `features` | Normalized feature vector (explainability) |
| `topFeature` | Highest contributing feature name |

**Plugging in a new model:**
```javascript
const { registerModel, setActiveModel } = require('./mlScoringPipeline');

class MyONNXModel {
  predict(features, opportunity) {
    // ... run ONNX inference ...
    return { executionProbability, fillProbability, profitQuality, mlScore, confidence };
  }
}

registerModel('onnx_v1', new MyONNXModel());
setActiveModel('onnx_v1');
```

No other changes required. The existing route `POST /api/arbitrage/ml/score` will
automatically use the new model.

---

## Institutional Backtest Metrics (Section 16)

`GET /api/arbitrage/arb-backtest/institutional` computes:

| Metric | Formula | Good Value |
|---|---|---|
| Sharpe Ratio | `(mean_return - rf) / stddev_return × √252` | > 1.5 |
| Sortino Ratio | Like Sharpe but only downside vol | > 2.0 |
| Calmar Ratio | `annualized_return / max_drawdown` | > 1.0 |
| Profit Factor | `gross_wins / gross_losses` | > 2.0 |
| Expectancy | `winRate × avgWin - lossRate × avgLoss` | > 0 |
| Kelly Criterion | `(p×b - q) / b` | Use half-Kelly |
| VaR 95% | 5th percentile of trade P&L distribution | — |
| Omega Ratio | `E[gains above 0] / E[losses below 0]` | > 1.0 |
| Recovery Factor | `totalReturn / maxDrawdown` | > 1.0 |
| Time in Drawdown | `periodsInDrawdown / totalPeriods × 100` | < 30% |

A performance grade (A+/A/B/C/D) is computed from Sharpe, Profit Factor, and Win Rate combined.

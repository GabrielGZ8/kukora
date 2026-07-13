# Kukora v17 — Execution Engine

## Architecture

The execution engine consists of three tightly coupled components:

```
detectOpportunities()   →   mlScoringPipeline   →   preTradeRiskCheck
        ↓                                                   ↓
  tradeStateMachine.createTrade()              ← BLOCKED (RCA recorded)
        ↓
  executeSimulated()
        ↓
  applyTrade()
        ↓
  [post-execution hooks]
```

---

## Opportunity Detection

`detectOpportunities(orderBooks)` in `domain/engines/opportunityDetection.js` (renamed from `arbitrageEngine.js`, see ADR-011) scans all exchange pairs:

- **Cross-exchange**: For each of the 20 ordered pairs (5 exchanges × 4 others), computes
  `spreadPct = (sellBid - buyAsk) / buyAsk × 100`
- **Triangular**: Detects 3-leg cycles within a single exchange
- **Statistical**: Reads Z-score signals from `statArbEngine.js`

Each opportunity is scored, enriched with fill probability, and returned ranked by composite score.

---

## Trade State Machine (Section 2)

Every trade progresses through a defined state sequence:

```
OPPORTUNITY_DETECTED
    ↓ (score >= minScore, risk check passes)
SCORING
    ↓
APPROVED
    ↓
ORDER_CREATED
    ↓
ORDER_SUBMITTED
    ↓ (fill ratio >= minimumFillRatio)          ↓ (fill ratio < minimumFillRatio)
  FILLED                                   PARTIALLY_FILLED
    ↓                                           ↓ (hedge/unwind/continue)
SETTLING
    ↓
COMPLETED ← terminal
```

**Error paths**:
- Any state → `FAILED` → `ROLLED_BACK` or `EMERGENCY_EXIT` (terminal)
- `PARTIALLY_FILLED` → `ROLLED_BACK` or `EMERGENCY_EXIT` (terminal)

Every transition is persisted with: timestamp, actor, reason, and arbitrary data payload.
This enables full reconstruction of any trade's execution path.

---

## Partial Fill Management (Section 3)

When a simulated order fills at less than the requested quantity:

```
fillRatio = filledAmount / requestedAmount

if !allowPartialFills          → cancel
if fillRatio >= minimumFillRatio → continue (acceptable partial fill)
if residualUSD < minimumTransferAmount → cancel (too small to hedge)
else                           → hedge residual exposure
```

The decision is recorded in `record.execution.partialFills[]` with full diagnostics.

**Configuration**:
- `allowPartialFills` (default: true)
- `minimumFillRatio` (default: 0.50) — must fill at least 50%
- `minimumTransferAmount` (default: $100) — minimum residual to warrant hedging

---

## Execution Quality Analytics (Section 6)

`observabilityService.recordExecutionQuality(opportunity, trade)` computes:

| Metric | Formula |
|---|---|
| Expected spread | `opportunity.spreadPct` (at detection) |
| Realized spread | `trade.netProfitPct + trade.slippagePct` |
| Profit capture | `realizedProfit / expectedProfit` |
| Fill quality | `filledAmount / requestedAmount` |
| Missed profit | `max(0, expectedProfit - realizedProfit)` |
| Verdict | excellent (≥90%), good (≥75%), acceptable (≥50%), poor (<50%) |

Aggregate stats available at `GET /api/arbitrage/observability/dashboard`.

---

## Slippage Estimation

Three methods, applied in priority order based on data availability:

| Method | Accuracy | When Used |
|---|---|---|
| `vwap_l2` | Highest | L2 order book available (WS connected) |
| `l1_spread` | Medium | Only L1 bid/ask available |
| `fixed` | Lowest | Fallback (0.1% for taker, 0.02% for maker) |

The slippage method is recorded on every opportunity and included in execution quality reports.

---

## Retry Logic

Failed orders are retried with exponential backoff:

```
backoffMs = retryBackoffMs × 2^retryCount
```

With defaults (`retryBackoffMs=500`, `maxOrderRetries=3`):
- Attempt 1: immediate
- Attempt 2: 500ms delay
- Attempt 3: 1,000ms delay
- Attempt 4: 2,000ms delay → give up, trigger recovery

Per-exchange cooldowns (`exchangeCooldownMs`, default: 1,000ms) prevent thundering herd on
reconnection. Each exchange has its own independent cooldown timer.

---

## Execution Latency Budget

Target latency breakdown (event-driven path):
- WS book received → detect: < 1ms
- detect → score: < 1ms
- score → risk check: < 1ms
- risk check → execute: < 5ms
- **Total target**: < 10ms

`e2eLatencyTracker` measures actual end-to-end latency and emits structured events when
p95 exceeds `maxExecutionLatencyMs`.

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/arbitrage/trades/active` | Active trade state machine records |
| `GET /api/arbitrage/trades/history` | Completed/failed trade history |
| `GET /api/arbitrage/trades/:id` | Single trade record with full event log |
| `GET /api/arbitrage/observability/dashboard` | Execution quality, latency, errors |
| `POST /api/arbitrage/ml/score` | Score a hypothetical opportunity |

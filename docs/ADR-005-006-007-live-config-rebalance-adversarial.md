# ADR-005 — Hot-reloadable configuration vs environment variables

**Status:** Accepted  
**Version:** Kukora v2.0  
**Author:** Engineering  

---

## Context

In v1.0, all arbitrage engine parameters (`minScore`, `tradeAmountBTC`, `feeMode`,
`minSpreadPct`, `maxDailyLossUSD`, `cooldownMs`, `minTriangularNetPct`,
`activeExchanges`) were constants defined at process startup from environment variables.

Changing any parameter required:
1. Editing the environment on Railway
2. Restarting the process (≈30 second cold start)
3. Losing the active session context (in-memory wallets, equity curve, session statistics)

This made live parameter adjustment — a common requirement in quantitative system
operation — impractical.

## Decision

Create `liveConfig.js` — a singleton module that centralises all mutable parameters
and exposes a hot-read/write API.

**Design:**
- All parameters have typed defaults defined at module load
- `liveConfig.get(key)` — O(1) hash lookup, called on every detection cycle
- `liveConfig.set(key, value)` — validates type and range before accepting changes
- Frontend panel (`/arbitrage` → Live Config) exposes a UI for operators to adjust parameters in real time
- Changes take effect on the next detection cycle (≤ 150ms propagation)

The arbitrage engine calls `liveConfig.get()` on each 150ms cycle. Cost: O(1) lookup
on a JavaScript object — negligible compared to the VWAP L2 walk that dominates
per-opportunity evaluation.

## Consequences

**Positive:**
- Parameter changes are instantaneous and non-destructive to session state
- Operators can experiment with scoring thresholds without restarting
- Risk limits (daily stop, max drawdown) can be tightened/relaxed in response to live conditions

**Negative:**
- Changes are not persisted across process restarts (intentional: avoids I/O on the hot path)
- Production systems should persist config changes to MongoDB before restarting

---

# ADR-006 — Predictive vs reactive rebalancing

**Status:** Accepted  
**Version:** Kukora v2.0  

## Context

The pre-funded bilateral model requires balanced capital on both legs of every arbitrage
opportunity. When one leg depletes faster than the other, the engine starts rejecting
valid opportunities for insufficient balance rather than inadequate spread.

Reactive rebalancing (triggering only when imbalance is detected) introduces a gap
between signal detection and capital availability. During high-frequency periods this
gap results in missed opportunities.

## Decision

Implement a dual-mode rebalancer:
1. **Reactive** (`rebalanceEngine.js`) — triggers when any wallet balance falls below a
   configurable threshold. Handles unexpected depletion events.
2. **Predictive** (`predictiveRebalance.js`) — forecasts depletion based on rolling
   trade velocity and initiates rebalancing before a threshold is breached.

The predictive layer uses an exponential moving average of capital consumption per
trade to estimate time-to-depletion. It fires a rebalance recommendation when projected
depletion is within 2× the average rebalance duration.

## Consequences

**Positive:**
- Near-zero capital idle time during active arbitrage windows
- Rebalance events are surfaced as structured alerts (observable, auditable)

**Negative:**
- Predictive model requires a minimum trade history (≥10 trades) before activating
- May trigger premature rebalances during atypically high-velocity windows

---

# ADR-007 — Adversarial scenario suite for resilience testing

**Status:** Accepted  
**Version:** Kukora v2.0  

## Context

Unit tests validate individual component behaviour under normal conditions.
They cannot verify how the system behaves when multiple components interact
under degraded conditions (partial fills, feed latency spikes, balance depletion).

## Decision

Implement an adversarial scenario suite (`adversarialScenarios.js`) with parameterised
failure injection:

- **Mid-flight failure**: simulates order submission timeout after leg-1 executes
- **Slippage circuit breaker**: actual slippage exceeds estimated slippage by configurable multiplier
- **Liquidity crunch**: order book depth collapses between detection and execution
- **Feed staleness**: exchange feed becomes stale during an active cycle
- **Balance depletion**: one wallet reaches zero mid-session

Each scenario is deterministic (seeded), produces a full execution journal, and verifies
that the state machine reaches a valid terminal state (ROLLED_BACK or EMERGENCY_EXIT)
rather than a corrupted intermediate state.

## Consequences

**Positive:**
- Failure modes are documented as executable specifications
- New edge cases can be added as named scenarios without modifying engine code
- Audit trail integrity is verified as part of each scenario run

**Negative:**
- Scenarios run synchronously and add ≈200ms to the test suite

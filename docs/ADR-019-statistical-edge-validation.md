# ADR-019 — Statistical Edge Validation: bootstrap CI + significance test

**Status:** Accepted
**Date:** 2026-07-12
**Deciders:** Engineering Lead, Quantitative Trading Lead

---

## Context

`institutionalBacktest.js` (Sharpe, Sortino, Calmar, Profit Factor, Kelly Criterion, VaR, Omega Ratio) is exposed at `GET /api/arbitrage/arb-backtest/institutional` and consumed by `ArbBacktestPage.jsx`. All of those metrics are descriptive statistics of a single run: they characterize the sample of trades we happened to execute, but none of them answer the question a skeptical reviewer asks next — is the net P&L per trade actually distinguishable from zero after costs, or could this sample of trades just as easily have come from a strategy with no real edge?

Without an answer to that question, a strong Sharpe ratio on a small sample is not evidence of anything beyond "this particular run went well." Competing entries in the same challenge (reviewed externally) close exactly this gap with bootstrap confidence intervals and out-of-sample significance testing over independent market windows.

## Decision

Add `server/domain/engines/statisticalValidation.js`, consuming the same `executions[]` shape (`simResult` contract, `server/domain/engines/simResult.js`) that `arbBacktestEngine.simulateRun()` already produces — no parallel data pipeline.

1. `bootstrapConfidenceInterval(profits, opts)` — percentile bootstrap (Efron 1979) over the per-trade net P&L. No normality assumption, appropriate for fat-tailed P&L distributions. Optional deterministic seed (`mulberry32`) for reproducibility.
2. `edgeSignificanceTest(profits, opts)` — bootstrap two-sided p-value + CI-based significance decision. Explicitly refuses to conclude anything below `MIN_SAMPLE_SIZE` (30) trades, and reports a plain-language honest verdict in all three cases: real positive edge, real negative edge (losing consistently, not noise), and "not distinguishable from zero."
3. `validateEdge(opLog, opts)` — splits the opportunity log into N independent time-based windows (same spirit as `arbBacktestEngine.walkForward()`'s train/validate split, applied here to statistical inference instead of parameter selection), runs the significance test per window and on the aggregate, and reports how many windows independently show a significant positive edge.

Exposed at `GET /api/arbitrage/arb-backtest/validation`, same auth/versioning pattern as the existing `/arb-backtest/institutional` endpoint (ADR-015).

## Consequences

**Positive:**

- Kukora can now state, with a number attached, whether its arbitrage edge survives real costs — not just "the backtest went well."
- The honesty requirement is enforced in code, not just in the README: insufficient samples, a non-significant edge, or a significant negative edge are all reported as such, in plain language, never silently upgraded to a positive-sounding metric.
- Reproducible: a seeded run can be repeated bit-for-bit by a reviewer.

**Negative / deferred:**

- The window-split in `validateEdge()` is time-based and does not account for autocorrelation between adjacent trades within a window (e.g. a single persistent market dislocation could dominate several trades in the same window). A block-bootstrap that respects trade-to-trade dependence is a possible future refinement; the current percentile bootstrap treats trades as exchangeable, which is a simplification worth stating explicitly here rather than discovering later.
- Does not yet integrate with a real historical market tape (no tape recorder exists yet in this codebase) — it validates whatever the live opportunity log has accumulated during the running session, not a controlled historical replay. **Deferred to the next session — see NEXT_SESSION_PROMPT.md.**

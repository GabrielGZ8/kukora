# ADR-009 — SlippageValidator: Phase 1 Production Gate

**Status:** Accepted  
**Date:** 2026-06-28  
**Deciders:** Engineering Lead, Quantitative Trading Lead

---

## Context

The RoadmapToProduction Phase 1 criterion states:

> "Modeled slippage within 25% of realized in > 80% of opportunities"

This is the quantitative bar Kukora must clear before any live capital is deployed. Prior to this ADR, no module existed to measure this — the criterion was documented but unmeasured.

## Decision

Introduce `slippageValidator.js` — a single module responsible for:

1. Recording `(modeledNet, realizedNet)` pairs for every executed opportunity
2. Computing `slippageAccuracyRate` (fraction of trades within the 25% divergence threshold)
3. Emitting `phase1GateMet: true/false` to the `/api/arbitrage/calibration` endpoint
4. Auto-adjusting `minNetProfitUSD` upward when systematic overestimation is detected

## Consequences

**Positive:**
- Phase 1 go/no-go decision becomes data-driven rather than intuitive
- Systematic model bias is detected and corrected automatically
- The pair breakdown exposes which exchange pairs have the worst calibration

**Negative:**
- In paper trading, "realized" spread is approximated by observing spread 50–150ms post-signal (simulating order placement latency). This is not as accurate as a real fill price. Phase 2 (shadow mode with real API fills) will provide ground truth.

## Alternatives Considered

- **Measure nothing, validate manually**: rejected — not suitable for institutional-grade deployment decisions.
- **External ML calibration library**: rejected — overkill. The calibration problem is a simple bias-detection problem, not an ML problem.

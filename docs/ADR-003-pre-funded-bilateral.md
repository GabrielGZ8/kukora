# ADR-003: Pre-funded bilateral settlement model

**Status:** Accepted  
**Date:** 2024-Q1  
**Author:** Engineering  

---

## Context

Cryptocurrency arbitrage between exchanges faces a fundamental settlement challenge:
if you buy on Exchange A and sell on Exchange B simultaneously, you need:
- USD (or USDT) on Exchange A to fund the buy
- BTC on Exchange B to fund the sell

The alternative — sending funds between exchanges mid-trade — introduces 10-30 minute
blockchain confirmation delays, which eliminates the arbitrage window entirely.

## Decision

Implement a **pre-funded bilateral model**:
- Maintain a balance of both BTC and USDT on every exchange simultaneously
- Both legs of every trade are funded from existing on-exchange balances
- No cross-exchange transfers are required during execution

**Capital allocation (paper trading defaults):**
```
Per exchange: $10,000 USDT + 0.2 BTC (~$12,000 total at $30k BTC)
Total deployed: ~$110,000 across 5 exchanges
```

The `walletManager.js` module maintains a real-time ledger of these balances and
applies debit/credit entries atomically with each trade.

## Consequences

**Positive:**
- Zero settlement latency — both legs can execute within milliseconds
- No blockchain confirmation risk
- Simple deterministic balance tracking

**Negative:**
- Capital efficiency is constrained — significant capital is idle on exchanges
  waiting for opportunities
- Rebalancing is required when one leg depletes (see ADR-006)
- Counter-party risk: capital is exposed to exchange insolvency on all 5 venues

**Mitigation for counter-party risk (paper trading scope):**
In production, per-exchange exposure limits in `advancedRiskEngine.js` cap the
maximum capital deployed on any single exchange.

# ADR-002: Log-spread for stationarity in StatArb

**Status:** Accepted  
**Date:** 2024-Q3  
**Author:** Engineering  

---

## Context

The StatArb module detects when the spread between two exchanges deviates from
its historical mean — the signal being that it will revert (mean reversion).
The key question: how to measure that spread?

## Two options

**Option A — Absolute USD difference:**
```
spread_t = price_A_t - price_B_t
```

**Option B — Log-spread:**
```
log_spread_t = log(price_A_t) - log(price_B_t)
```

## Analysis

Bitcoin's absolute USD price has increased from ~$1,000 (2017) to ~$60,000 (2024).
A spread of $50 at $1,000 price is 5%. The same $50 spread at $60,000 is 0.08%.
These are categorically different signals — the absolute series is not stationary.

Log-spread is equivalent to the percentage difference:
```
log_spread ≈ (price_A - price_B) / avg_price
```

This is stationary because it removes the absolute price level, making historical
Z-score calculations valid across different market price regimes.

The Augmented Dickey-Fuller test on our historical data confirms log-spread is
stationary (p < 0.05) while absolute spread is not.

## Decision

Use log-spread for:
- Z-score calculation: `z = (log_spread - μ) / σ`
- AR(1) half-life estimation (Ornstein-Uhlenbeck parameter estimation)
- Mean reversion signal generation

Use absolute spread for:
- P&L calculation (actual dollars at stake)
- Risk limit checks (dollar exposure)

## Consequences

**Positive:**
- Valid Z-score signals across different absolute price levels
- Half-life estimates are comparable across time periods

**Negative:**
- Requires additional explanation for users unfamiliar with log-returns
- Log-spread cannot be directly compared to fee thresholds (must convert back)

# ADR-001: VWAP L2 walk instead of mid-price for arbitrage spread calculation

**Status:** Accepted  
**Date:** 2024-Q1  
**Author:** Engineering  

---

## Context

The simplest arbitrage spread calculation between two exchanges is:

```
spread = bidB - askA
```

where `bidB` and `askA` are the best bid and ask from each order book.
This is the **mid-price approach** used by most basic arbitrage systems.

## Problem with mid-price

Mid-price assumes you can execute at exactly the best available price regardless
of order size. In practice, if you want to buy 0.05 BTC and the best ask level
only has 0.01 BTC available, you will consume multiple order book levels and your
average execution price will be worse than the best ask.

This phenomenon is called **market impact** or book slippage. With mid-price,
the system would detect opportunities that are not profitable at actual execution.

## Decision

Kukora implements **VWAP walk (Volume-Weighted Average Price)** over the real L2
order book:

```javascript
function calcVwapSlippage(levels, amount) {
  let remaining = amount;
  let totalCost = 0;
  for (const [price, size] of levels) {
    const fill = Math.min(remaining, size);
    totalCost += fill * price;
    remaining -= fill;
    if (remaining <= 0) break;
  }
  return totalCost / amount; // effective average execution price
}
```

**Concrete impact:** On a 0.05 BTC order, mid-price might show a 0.12% spread.
VWAP walk on real book depth shows 0.07% after slippage — a 42% difference that
determines whether the trade is actually viable.

## Consequences

**Positive:**
- Detected opportunities are net-profitable after realistic execution costs
- Rejection reasons are meaningful: "insufficient spread after slippage" vs "no spread"

**Negative:**
- Requires real-time L2 order book data (WebSocket feeds, not REST snapshots)
- Walk computation adds ≈0.3ms per pair — acceptable given the 30ms detection budget

**Related:** ADR-003 (pre-funded bilateral settlement, which enables the accurate
fill size needed for this calculation).

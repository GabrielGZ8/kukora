# ADR-004: Dual-path detection — event-driven WebSocket + polling fallback

**Status:** Accepted  
**Date:** 2024-Q1  
**Author:** Engineering  

---

## Context

Arbitrage opportunity windows are short: a spread that exists at t=0 may be
arbitraged away by another participant by t=100ms. Detection latency directly
determines capture rate.

Two detection approaches were considered:
1. **Event-driven**: trigger detection immediately on each WebSocket price update
2. **Polling**: scan all pairs on a fixed interval (e.g. 150ms)

## Analysis

**Event-driven (per WebSocket message):**
- Minimum latency: detection fires within milliseconds of the price change
- Risk: very high CPU load during volatile periods (thousands of events/second)
- Risk: if one exchange's WebSocket stream is delayed, detection for pairs
  involving that exchange is also delayed

**Polling (fixed interval):**
- Consistent CPU usage regardless of market volatility
- Detection latency: up to 1 full polling interval (150ms worst case)
- Simpler to reason about: every detection cycle sees a consistent snapshot

## Decision

Implement **both paths** with the event-driven path as primary:

1. **Event-driven path** (primary): each WebSocket `orderbook` event triggers a
   targeted scan of the pairs affected by that exchange's price change. Detection
   latency: typically 2-5ms from price update to opportunity classification.

2. **Polling path** (150ms fallback): a `setInterval` scans all pairs unconditionally.
   This catches opportunities missed by the event-driven path (e.g. a price update
   on Exchange A that creates a spread against a stale Exchange B price).

The two paths share the same `executeBestOpportunity()` function — all execution
side effects are identical regardless of which path triggered detection.

## Consequences

**Positive:**
- Event-driven path captures < 10ms opportunities that polling would miss
- Polling path provides resilience against WebSocket delivery irregularities
- Deduplication via fingerprinting prevents double-execution on the same opportunity

**Negative:**
- Both paths must be maintained — a bug in the shared execution function affects both
- Fingerprint expiry logic must be tuned to prevent both duplicates and misses

**Observed:** Benchmarking (`speedBenchmark.js`) shows event-driven path detects
opportunities 4-7× faster than polling, but polling captures ≈8% of opportunities
that the event-driven path misses due to feed timing.

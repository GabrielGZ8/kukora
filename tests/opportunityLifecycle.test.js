import { describe, it, expect, beforeEach, vi } from 'vitest';

async function freshModule() {
  vi.resetModules();
  return import('../server/domain/analytics/opportunityLifecycle.js?t=' + Math.random());
}

function op(overrides = {}) {
  return {
    buyExchange: 'Binance',
    sellExchange: 'OKX',
    spreadPct: 0.5,
    netProfit: 1.0,
    breakEvenPct: 0.1,
    viable: true,
    ts: new Date().toISOString(),
    ...overrides,
  };
}

describe('opportunityLifecycle', () => {
  let lifecycle;
  beforeEach(async () => { lifecycle = await freshModule(); });

  describe('trackOpportunity', () => {
    it('creates a new active entry on first sighting', () => {
      const result = lifecycle.trackOpportunity(op());
      expect(result.lifecycle).toMatchObject({ seenCount: 1, status: 'active', durationMs: 0 });
      expect(lifecycle.getActiveLifecycles().length).toBe(1);
    });

    it('updates seenCount and duration on repeated sightings of the same pair', () => {
      lifecycle.trackOpportunity(op());
      const second = lifecycle.trackOpportunity(op());
      expect(second.lifecycle.seenCount).toBe(2);
      expect(lifecycle.getActiveLifecycles().length).toBe(1); // still just one pair tracked
    });

    it('tracks maxSpread / maxProfit as running maxima, not last-seen values', () => {
      lifecycle.trackOpportunity(op({ spreadPct: 0.5, netProfit: 1.0 }));
      lifecycle.trackOpportunity(op({ spreadPct: 0.3, netProfit: 0.2 })); // lower — should not overwrite max
      const third = lifecycle.trackOpportunity(op({ spreadPct: 0.8, netProfit: 2.0 })); // higher — should overwrite
      expect(third.lifecycle.maxSpread).toBeCloseTo(0.8, 4);
      expect(third.lifecycle.maxProfit).toBeCloseTo(2.0, 4);
    });

    it('treats different exchange pairs as independent lifecycles', () => {
      lifecycle.trackOpportunity(op({ buyExchange: 'Binance', sellExchange: 'OKX' }));
      lifecycle.trackOpportunity(op({ buyExchange: 'Kraken', sellExchange: 'Bybit' }));
      expect(lifecycle.getActiveLifecycles().length).toBe(2);
    });
  });

  describe('trackAll', () => {
    it('tracks every opportunity in the array and returns enriched copies', () => {
      const results = lifecycle.trackAll([
        op({ buyExchange: 'Binance', sellExchange: 'OKX' }),
        op({ buyExchange: 'Kraken', sellExchange: 'Bybit' }),
      ]);
      expect(results.length).toBe(2);
      expect(results[0].lifecycle).toBeDefined();
      expect(results[1].lifecycle).toBeDefined();
    });
  });

  describe('expireStale', () => {
    it('does not expire entries seen recently', () => {
      lifecycle.trackOpportunity(op());
      expect(lifecycle.expireStale()).toEqual([]);
      expect(lifecycle.getActiveLifecycles().length).toBe(1);
    });

    it('expires entries whose lastSeenTs is older than the 2000ms TTL', () => {
      vi.useFakeTimers();
      try {
        lifecycle.trackOpportunity(op());
        vi.advanceTimersByTime(2500);
        const expired = lifecycle.expireStale();
        expect(expired.length).toBe(1);
        expect(expired[0].status).toBe('expired');
        expect(lifecycle.getActiveLifecycles().length).toBe(0);
        expect(lifecycle.getLifecycleHistory(10).length).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('getLifecycleSummary', () => {
    it('returns a zeroed summary when there is no history yet', () => {
      const summary = lifecycle.getLifecycleSummary();
      expect(summary).toEqual({ count: 0, avgDurationMs: 0, avgSeenCount: 0, avgMaxSpread: 0, avgMaxProfit: 0, longestMs: 0 });
    });

    it('aggregates stats across expired entries', () => {
      vi.useFakeTimers();
      try {
        lifecycle.trackOpportunity(op({ buyExchange: 'Binance', sellExchange: 'OKX', spreadPct: 0.5, netProfit: 1, viable: true }));
        vi.advanceTimersByTime(2500);
        lifecycle.expireStale();

        lifecycle.trackOpportunity(op({ buyExchange: 'Kraken', sellExchange: 'Bybit', spreadPct: 0.3, netProfit: 0.5, viable: false }));
        vi.advanceTimersByTime(2500);
        lifecycle.expireStale();

        const summary = lifecycle.getLifecycleSummary();
        expect(summary.count).toBe(2);
        expect(summary.avgMaxSpread).toBeCloseTo(0.4, 4);
        expect(summary.avgMaxProfit).toBeCloseTo(0.75, 4);
        expect(summary.viableRatio).toBeCloseTo(0.5, 4);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('getDecayCurveByPair', () => {
    it('excludes pairs with fewer samples than minSamples', () => {
      vi.useFakeTimers();
      try {
        lifecycle.trackOpportunity(op({ buyExchange: 'Binance', sellExchange: 'OKX' }));
        vi.advanceTimersByTime(2500);
        lifecycle.expireStale(); // only 1 sample for this pair

        expect(lifecycle.getDecayCurveByPair(2)).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('computes mean/p50/p90/max/min duration per pair once enough samples exist', () => {
      vi.useFakeTimers();
      try {
        // Two separate lifecycles for the same pair, with different durations
        lifecycle.trackOpportunity(op({ buyExchange: 'Binance', sellExchange: 'OKX' }));
        vi.advanceTimersByTime(2500);
        lifecycle.expireStale();

        lifecycle.trackOpportunity(op({ buyExchange: 'Binance', sellExchange: 'OKX' }));
        vi.advanceTimersByTime(100); // re-seen, extends duration before expiring
        lifecycle.trackOpportunity(op({ buyExchange: 'Binance', sellExchange: 'OKX' }));
        vi.advanceTimersByTime(2500);
        lifecycle.expireStale();

        const curve = lifecycle.getDecayCurveByPair(2);
        expect(curve.length).toBe(1);
        expect(curve[0].pair).toBe('Binance→OKX');
        expect(curve[0].sampleCount).toBe(2);
        expect(curve[0].maxMs).toBeGreaterThanOrEqual(curve[0].minMs);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

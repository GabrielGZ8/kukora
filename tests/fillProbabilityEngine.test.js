import { describe, it, expect, vi } from 'vitest';
import { computeFillProbability, enrichWithFillProbability } from '../server/domain/engines/fillProbabilityEngine.js';

const observability = require('../server/infrastructure/observabilityService.js');

// Same fixture shape as tests/opportunity.test.js — real order books so
// detectOpportunities() produces a real Opportunity to run through the
// contract check added in this session (audit committee, sección 12, punto 1).
const makeOrderBooks = (overrides = {}) => {
  const base = {
    Binance:  { exchange: 'Binance',  ask: 30000, bid: 29990, ts: Date.now(), feedAgeMs: 0 },
    Kraken:   { exchange: 'Kraken',   ask: 30160, bid: 30150, ts: Date.now(), feedAgeMs: 0 },
    Bybit:    { exchange: 'Bybit',    ask: 29950, bid: 29940, ts: Date.now(), feedAgeMs: 0 },
    OKX:      { exchange: 'OKX',      ask: 30050, bid: 30040, ts: Date.now(), feedAgeMs: 0 },
    Coinbase: { exchange: 'Coinbase', ask: 30000, bid: 29990, ts: Date.now(), feedAgeMs: 0 },
  };
  Object.assign(base, overrides);
  return Object.values(base);
};

describe('computeFillProbability', () => {
  it('is deterministic — same inputs always produce the same output (no randomness)', () => {
    const op = { buyFillPct: 90, sellFillPct: 85, spreadPct: 0.3, breakEvenPct: 0.1, buySource: 'ws', sellSource: 'ws', buyLatency: 10, sellLatency: 15, slippageMethod: 'real', viable: true };
    const a = computeFillProbability(op, { volatilityScore: 10 });
    const b = computeFillProbability(op, { volatilityScore: 10 });
    expect(a).toEqual(b);
  });

  it('defaults buy/sellFillPct to 80 when absent', () => {
    const r = computeFillProbability({ spreadPct: 0, breakEvenPct: 0, viable: false });
    expect(r.fillProbabilityBreakdown.avgFillPct).toBe(80);
  });

  it('caps depth contribution at 100 even if fill pct inputs exceed 100', () => {
    const r = computeFillProbability({ buyFillPct: 150, sellFillPct: 150, viable: false });
    expect(r.fillProbabilityBreakdown.avgFillPct).toBe(100);
  });

  it('spreadScore rewards edge over break-even, capped at 100', () => {
    const noEdge = computeFillProbability({ spreadPct: 0.1, breakEvenPct: 0.1, viable: false });
    expect(noEdge.fillProbabilityBreakdown.spreadScore).toBe(0);

    const bigEdge = computeFillProbability({ spreadPct: 1.0, breakEvenPct: 0.1, viable: false });
    expect(bigEdge.fillProbabilityBreakdown.spreadScore).toBe(100);
  });

  it('rewards fast WS-sourced feeds on both legs with the highest latency score', () => {
    const fast = computeFillProbability({ buySource: 'ws', sellSource: 'ws', buyLatency: 5, sellLatency: 10, viable: false });
    expect(fast.fillProbabilityBreakdown.latencyScore).toBe(100);

    const slow = computeFillProbability({ buySource: 'ws', sellSource: 'ws', buyLatency: 500, sellLatency: 600, viable: false });
    expect(slow.fillProbabilityBreakdown.latencyScore).toBe(50);
  });

  it('penalizes mixed ws/rest sourcing relative to dual-ws', () => {
    const mixed = computeFillProbability({ buySource: 'ws', sellSource: 'rest', buyLatency: 10, sellLatency: 10, viable: false });
    expect(mixed.fillProbabilityBreakdown.latencyScore).toBe(50);
  });

  it('caps the latency score further when the feed is stale, regardless of source quality', () => {
    const stale = computeFillProbability({ buySource: 'ws', sellSource: 'ws', buyLatency: 5, sellLatency: 5, feedAgeMs: 5000, viable: false });
    expect(stale.fillProbabilityBreakdown.latencyScore).toBe(5);

    const mediumStale = computeFillProbability({ buySource: 'ws', sellSource: 'ws', buyLatency: 5, sellLatency: 5, feedAgeMs: 2500, viable: false });
    expect(mediumStale.fillProbabilityBreakdown.latencyScore).toBe(35);
  });

  it('rewards real (order-book derived) slippage method over fallback', () => {
    const real = computeFillProbability({ slippageMethod: 'real', viable: false });
    expect(real.fillProbabilityBreakdown.liquidityScore).toBe(95);
    const partial = computeFillProbability({ slippageMethod: 'partial', viable: false });
    expect(partial.fillProbabilityBreakdown.liquidityScore).toBe(70);
    const fallback = computeFillProbability({ slippageMethod: 'fixed', viable: false });
    expect(fallback.fillProbabilityBreakdown.liquidityScore).toBe(40);
  });

  it('volatility penalty reduces score as volatilityScore rises', () => {
    const calm  = computeFillProbability({ viable: false }, { volatilityScore: 0 });
    const noisy = computeFillProbability({ viable: false }, { volatilityScore: 80 });
    expect(calm.fillProbability).toBeGreaterThan(noisy.fillProbability);
  });

  it('applies a floor of 35 for viable opportunities even with poor sub-scores', () => {
    const r = computeFillProbability({ viable: true, buyFillPct: 0, sellFillPct: 0, spreadPct: 0, breakEvenPct: 1, slippageMethod: 'fixed', feedAgeMs: 9999 }, { volatilityScore: 100 });
    expect(r.fillProbability).toBe(35);
  });

  it('applies no floor for non-viable opportunities (score can drop below 35)', () => {
    const r = computeFillProbability({ viable: false, buyFillPct: 0, sellFillPct: 0, spreadPct: 0, breakEvenPct: 1, slippageMethod: 'fixed', feedAgeMs: 9999 }, { volatilityScore: 100 });
    expect(r.fillProbability).toBeLessThan(35);
  });

  it('never exceeds 100', () => {
    const r = computeFillProbability({ viable: true, buyFillPct: 100, sellFillPct: 100, spreadPct: 1, breakEvenPct: 0, buySource: 'ws', sellSource: 'ws', buyLatency: 1, sellLatency: 1, slippageMethod: 'real' }, { volatilityScore: 0 });
    expect(r.fillProbability).toBeLessThanOrEqual(100);
  });

  it('returns an integer score, never a float', () => {
    const r = computeFillProbability({ buyFillPct: 73, sellFillPct: 61, spreadPct: 0.22, breakEvenPct: 0.08, viable: true });
    expect(Number.isInteger(r.fillProbability)).toBe(true);
  });
});

describe('enrichWithFillProbability', () => {
  it('attaches fillProbability and breakdown to every opportunity without mutating the originals', () => {
    const original = [
      { id: 1, buyFillPct: 80, sellFillPct: 80, viable: true },
      { id: 2, buyFillPct: 90, sellFillPct: 90, viable: false },
    ];
    const snapshot = JSON.parse(JSON.stringify(original));
    const enriched = enrichWithFillProbability(original, 50000, 10);

    expect(enriched.length).toBe(2);
    for (const op of enriched) {
      expect(typeof op.fillProbability).toBe('number');
      expect(op.fillProbabilityBreakdown).toBeDefined();
    }
    expect(original).toEqual(snapshot); // originals untouched
  });

  it('returns an empty array for an empty input', () => {
    expect(enrichWithFillProbability([], 50000, 0)).toEqual([]);
  });

  it('does not flag a contract violation for a real Opportunity from detectOpportunities()', async () => {
    const { detectOpportunities } = await import('../server/domain/engines/opportunityDetection.js');
    const books = makeOrderBooks();
    const { opportunities } = detectOpportunities(books, 0.1);
    expect(opportunities.length).toBeGreaterThan(0);

    const emitSpy = vi.spyOn(observability, 'emit');
    const enriched = enrichWithFillProbability(opportunities, 50000, 0);
    const contractViolations = emitSpy.mock.calls.filter(
      call => call[1] === 'contract.opportunity_shape_invalid',
    );
    expect(contractViolations).toEqual([]);
    expect(enriched.every(op => typeof op.fillProbability === 'number')).toBe(true);
    emitSpy.mockRestore();
  });
});

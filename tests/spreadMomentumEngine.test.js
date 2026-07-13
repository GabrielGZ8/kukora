import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  record, getMomentum, enrichOpportunity, enrichOpportunities,
  getAllMomentums, recordFromOrderBooks, reset,
} from '../server/domain/engines/spreadMomentumEngine.js';

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

describe('spreadMomentumEngine', () => {
  beforeEach(() => reset());

  it('getMomentum returns null when there are fewer than MIN_SAMPLES (5) points', () => {
    record('Binance', 'OKX', 0.1, 1000);
    record('Binance', 'OKX', 0.1, 1150);
    expect(getMomentum('Binance', 'OKX')).toBeNull();
  });

  it('getMomentum returns null for a pair that was never recorded', () => {
    expect(getMomentum('Binance', 'Kraken')).toBeNull();
  });

  it('detects an "opening" trend when spread is increasing over time', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) {
      record('Binance', 'OKX', 0.1 + i * 0.05, t0 + i * 150); // spread climbs
    }
    const m = getMomentum('Binance', 'OKX');
    expect(m.trend).toBe('opening');
    expect(m.velocityPctPerSec).toBeGreaterThan(0);
  });

  it('detects a "closing" trend when spread is decreasing over time', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) {
      record('Binance', 'OKX', 0.5 - i * 0.05, t0 + i * 150); // spread shrinks
    }
    const m = getMomentum('Binance', 'OKX');
    expect(m.trend).toBe('closing');
    expect(m.velocityPctPerSec).toBeLessThan(0);
  });

  it('detects a "stable" trend when spread barely moves', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) {
      record('Binance', 'OKX', 0.2, t0 + i * 150); // flat
    }
    const m = getMomentum('Binance', 'OKX');
    expect(m.trend).toBe('stable');
  });

  it('urgency is higher for a fast-closing spread than a slow-closing one', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) record('Binance', 'OKX', 0.5 - i * 0.2, t0 + i * 150); // fast close
    const fast = getMomentum('Binance', 'OKX');

    reset();
    for (let i = 0; i < 6; i++) record('Binance', 'OKX', 0.5 - i * 0.001, t0 + i * 150); // near-flat -> closing but tiny
    const slowish = getMomentum('Binance', 'OKX');

    expect(fast.urgency).toBeGreaterThan(slowish.urgency);
  });

  it('urgency is lower for an opening spread than the neutral midpoint baseline', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) record('Binance', 'OKX', 0.1 + i * 0.1, t0 + i * 150);
    const m = getMomentum('Binance', 'OKX');
    expect(m.urgency).toBeLessThan(50);
  });

  it('caps the buffer at 20 samples per pair (oldest evicted)', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 25; i++) record('Binance', 'OKX', 0.1, t0 + i * 150);
    const m = getMomentum('Binance', 'OKX');
    expect(m.samples).toBe(20);
  });

  it('tracks independent state per buyExchange→sellExchange pair', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) record('Binance', 'OKX', 0.1 + i * 0.1, t0 + i * 150);
    for (let i = 0; i < 6; i++) record('Kraken', 'Bybit', 0.3, t0 + i * 150);
    const m1 = getMomentum('Binance', 'OKX');
    const m2 = getMomentum('Kraken', 'Bybit');
    expect(m1.trend).toBe('opening');
    expect(m2.trend).toBe('stable');
  });

  it('enrichOpportunity adds spreadMomentum without mutating the original object', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) record('Binance', 'OKX', 0.1 + i * 0.1, t0 + i * 150);
    const opp = { buyExchange: 'Binance', sellExchange: 'OKX', id: 'x' };
    const enriched = enrichOpportunity(opp);
    expect(enriched.spreadMomentum).toBeDefined();
    expect(opp.spreadMomentum).toBeUndefined();
  });

  it('enrichOpportunity is a no-op (returns same shape) when there is no momentum data yet', () => {
    const opp = { buyExchange: 'Binance', sellExchange: 'Kraken', id: 'y' };
    const enriched = enrichOpportunity(opp);
    expect(enriched).toEqual(opp);
    expect(enriched.spreadMomentum).toBeUndefined();
  });

  it('enrichOpportunities maps over an array of opportunities', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) record('Binance', 'OKX', 0.1 + i * 0.1, t0 + i * 150);
    const opps = [
      { buyExchange: 'Binance', sellExchange: 'OKX' },
      { buyExchange: 'Binance', sellExchange: 'Kraken' },
    ];
    const enriched = enrichOpportunities(opps);
    expect(enriched[0].spreadMomentum).toBeDefined();
    expect(enriched[1].spreadMomentum).toBeUndefined();
  });

  it('getAllMomentums returns tracked pairs sorted by |velocity| descending', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) record('Binance', 'OKX', 0.1 + i * 0.01, t0 + i * 150); // slow
    for (let i = 0; i < 6; i++) record('Kraken', 'Bybit', 0.1 + i * 0.5, t0 + i * 150); // fast
    const all = getAllMomentums();
    expect(all.length).toBe(2);
    expect(all[0].pair).toBe('Kraken→Bybit');
    expect(Math.abs(all[0].velocityPctPerSec)).toBeGreaterThan(Math.abs(all[1].velocityPctPerSec));
  });

  it('getAllMomentums excludes pairs without enough samples yet', () => {
    record('Binance', 'OKX', 0.1, 1000); // only 1 sample
    expect(getAllMomentums()).toEqual([]);
  });

  it('recordFromOrderBooks records spreads for every directed exchange pair, skipping invalid books', () => {
    const books = [
      { exchange: 'Binance', bid: 100, ask: 101 },
      { exchange: 'OKX', bid: 102, ask: 103 },
      { exchange: 'Broken', bid: 0, ask: 0, error: true },
    ];
    recordFromOrderBooks(books, 1000);
    // Binance->OKX and OKX->Binance should each have exactly 1 sample now
    record('Binance', 'OKX', 0.1, 1150);
    record('Binance', 'OKX', 0.1, 1300);
    record('Binance', 'OKX', 0.1, 1450);
    record('Binance', 'OKX', 0.1, 1600);
    const m = getMomentum('Binance', 'OKX');
    expect(m.samples).toBe(5);
  });

  it('reset clears all tracked pairs', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) record('Binance', 'OKX', 0.1 + i * 0.1, t0 + i * 150);
    reset();
    expect(getMomentum('Binance', 'OKX')).toBeNull();
    expect(getAllMomentums()).toEqual([]);
  });

  it('does not flag a contract violation for a real Opportunity from detectOpportunities()', async () => {
    const { detectOpportunities } = await import('../server/domain/engines/opportunityDetection.js');
    const books = makeOrderBooks();
    const { opportunities } = detectOpportunities(books, 0.1);
    expect(opportunities.length).toBeGreaterThan(0);

    const emitSpy = vi.spyOn(observability, 'emit');
    const enriched = enrichOpportunities(opportunities);
    const contractViolations = emitSpy.mock.calls.filter(
      call => call[1] === 'contract.opportunity_shape_invalid',
    );
    expect(contractViolations).toEqual([]);
    expect(enriched.length).toBe(opportunities.length);
    emitSpy.mockRestore();
  });
});

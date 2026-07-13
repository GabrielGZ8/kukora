import { describe, it, expect, beforeEach } from 'vitest';
import { record, getStats, getRecentSamples, reset } from '../server/infrastructure/e2eLatencyTracker.js';

describe('e2eLatencyTracker', () => {
  beforeEach(() => reset());

  it('getStats returns all-null shape when there are no samples', () => {
    const stats = getStats();
    expect(stats.sampleCount).toBe(0);
    expect(stats.e2e).toEqual({ p50: null, p95: null, p99: null, min: null, max: null, avg: null });
    expect(stats.byExchange).toEqual({});
    expect(stats.recentMs).toBeNull();
  });

  it('ignores invalid samples (negative, non-number, or absurdly large e2eMs)', () => {
    record(-1, 10, 5, 'Binance');
    record('not-a-number', 10, 5, 'Binance');
    record(50000, 10, 5, 'Binance'); // > 30000ms sanity ceiling
    expect(getStats().sampleCount).toBe(0);
  });

  it('records valid samples and increments sampleCount', () => {
    record(100, 60, 40, 'Binance');
    record(150, 90, 60, 'Kraken');
    expect(getStats().sampleCount).toBe(2);
  });

  it('defaults exchange to "unknown" when not provided', () => {
    record(100, 60, 40);
    expect(getStats().byExchange.unknown).toBeDefined();
  });

  it('computes min/max/avg correctly for e2e latency', () => {
    record(100, 10, 10, 'Binance');
    record(200, 10, 10, 'Binance');
    record(300, 10, 10, 'Binance');
    const { e2e } = getStats();
    expect(e2e.min).toBe(100);
    expect(e2e.max).toBe(300);
    expect(e2e.avg).toBe(200);
    expect(e2e.p50).toBe(200);
  });

  it('computes percentiles with linear interpolation (numpy-style)', () => {
    // 4 samples: 10, 20, 30, 40 -> p50 interpolates between idx 1 and 2
    for (const v of [10, 20, 30, 40]) record(v, v, v, 'Binance');
    const { e2e } = getStats();
    // idx = 0.5 * 3 = 1.5 -> interpolate between sorted[1]=20 and sorted[2]=30 -> 25
    expect(e2e.p50).toBe(25);
  });

  it('breaks down stats per exchange independently', () => {
    record(100, 10, 10, 'Binance');
    record(100, 10, 10, 'Binance');
    record(500, 10, 10, 'Kraken');
    const { byExchange } = getStats();
    expect(byExchange.Binance.count).toBe(2);
    expect(byExchange.Binance.avg).toBe(100);
    expect(byExchange.Kraken.count).toBe(1);
    expect(byExchange.Kraken.avg).toBe(500);
  });

  it('recentMs reflects the most recently recorded sample', () => {
    record(100, 10, 10, 'Binance');
    record(250, 10, 10, 'Binance');
    expect(getStats().recentMs).toBe(250);
  });

  it('caps the circular buffer at 500 samples (oldest evicted first)', () => {
    for (let i = 0; i < 510; i++) record(i + 1, 1, 1, 'Binance');
    const stats = getStats();
    expect(stats.sampleCount).toBe(500);
    // oldest 10 samples (1..10) should have been evicted; min should reflect that
    expect(stats.e2e.min).toBeGreaterThan(10);
  });

  it('getRecentSamples returns the last N samples in chronological order', () => {
    record(1, 1, 1, 'Binance');
    record(2, 2, 2, 'Binance');
    record(3, 3, 3, 'Binance');
    const recent = getRecentSamples(2);
    expect(recent.length).toBe(2);
    expect(recent[0].e2eMs).toBe(2);
    expect(recent[1].e2eMs).toBe(3);
  });

  it('reset clears all samples', () => {
    record(100, 10, 10, 'Binance');
    reset();
    expect(getStats().sampleCount).toBe(0);
    expect(getRecentSamples(10).length).toBe(0);
  });
});

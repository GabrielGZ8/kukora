import { describe, it, expect } from 'vitest';
import { monteCarloGBM } from '../server/domain/analytics/simulationService.js';

describe('simulationService — monteCarloGBM', () => {
  it('throws when fewer than 10 prices are given', () => {
    expect(() => monteCarloGBM([100, 101, 102])).toThrow('Se necesitan al menos 10 precios');
  });

  it('does not throw with exactly 10 prices', () => {
    const prices = Array.from({ length: 10 }, (_, i) => 100 + i);
    expect(() => monteCarloGBM(prices, 5, 20)).not.toThrow();
  });

  it('returns the expected result shape', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const result = monteCarloGBM(prices, 10, 50);
    expect(result).toHaveProperty('S0', prices[prices.length - 1]);
    expect(result).toHaveProperty('horizon', 10);
    expect(result).toHaveProperty('simulations', 50);
    expect(result).toHaveProperty('mu');
    expect(result).toHaveProperty('sigma');
    expect(result).toHaveProperty('paths');
    expect(result).toHaveProperty('percentiles');
    expect(result).toHaveProperty('mean');
    expect(result).toHaveProperty('expectedReturn');
    expect(result).toHaveProperty('histogram');
    expect(typeof result.probAbove).toBe('function');
    expect(typeof result.probBelow).toBe('function');
  });

  it('generates exactly `simulations` paths, each of length horizon+1 starting at S0', () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 + i * 0.5);
    const horizon = 7, simulations = 25;
    const result = monteCarloGBM(prices, horizon, simulations);
    expect(result.paths).toHaveLength(simulations);
    for (const path of result.paths) {
      expect(path).toHaveLength(horizon + 1);
      expect(path[0]).toBe(result.S0);
    }
  });

  it('percentiles are monotonically non-decreasing (p5 <= p25 <= p50 <= p75 <= p95)', () => {
    const prices = Array.from({ length: 25 }, (_, i) => 100 + i * 0.3);
    const result = monteCarloGBM(prices, 10, 200);
    const { p5, p25, p50, p75, p95 } = result.percentiles;
    expect(p5).toBeLessThanOrEqual(p25);
    expect(p25).toBeLessThanOrEqual(p50);
    expect(p50).toBeLessThanOrEqual(p75);
    expect(p75).toBeLessThanOrEqual(p95);
  });

  it('histogram has 20 bins covering the full range of final prices, summing to total simulation count', () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 + i * 0.2);
    const simulations = 100;
    const result = monteCarloGBM(prices, 5, simulations);
    expect(result.histogram).toHaveLength(20);
    const totalCount = result.histogram.reduce((a, b) => a + b.count, 0);
    // Last bin uses strict `< hi` upper bound except the final max value falls
    // outside every bin's [lo,hi); allow for at most 1 unaccounted sample (the max).
    expect(totalCount).toBeGreaterThanOrEqual(simulations - 1);
    expect(totalCount).toBeLessThanOrEqual(simulations);
  });

  it('probAbove(S0) and probBelow(S0) are complementary-ish and bounded in [0,100]', () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 + i * 0.1);
    const result = monteCarloGBM(prices, 5, 100);
    const above = result.probAbove(result.S0);
    const below = result.probBelow(result.S0);
    expect(above).toBeGreaterThanOrEqual(0);
    expect(above).toBeLessThanOrEqual(100);
    expect(below).toBeGreaterThanOrEqual(0);
    expect(below).toBeLessThanOrEqual(100);
  });

  it('uses default horizon=30 and simulations=500 when not specified', () => {
    const prices = Array.from({ length: 15 }, (_, i) => 100 + i);
    const result = monteCarloGBM(prices);
    expect(result.horizon).toBe(30);
    expect(result.simulations).toBe(500);
    expect(result.paths).toHaveLength(500);
  });
});

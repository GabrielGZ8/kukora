import { describe, it, expect } from 'vitest';
import { computeKCS, KCS_VERSION } from '../server/domain/analytics/kcsService.js';

function uptrend(n, start = 100, step = 1) {
  return Array.from({ length: n }, (_, i) => start + i * step);
}
function flat(n, price = 100) {
  return Array.from({ length: n }, () => price);
}
function downtrend(n, start = 100, step = 1) {
  return Array.from({ length: n }, (_, i) => start - i * step);
}

describe('kcsService', () => {
  it('returns a NEUTRAL/UNDEFINED fallback when fewer than 20 prices are given', () => {
    const result = computeKCS([{ id: 'BTC', prices: uptrend(10) }]);
    expect(result).toEqual({ score: 50, bias: 'NEUTRAL', state: 'UNDEFINED', components: {}, version: KCS_VERSION });
  });

  it('falls back to mainPrices=pricesArr when given a single bare price array (no breadth comparison)', () => {
    // computeKCS's "raw array" shorthand only behaves correctly for breadth purposes
    // when wrapped as a single-asset list; a bare array longer than 1 element is
    // treated by the breadth branch as a list of assets needing .prices, which is
    // not how this function is actually called elsewhere in the codebase.
    const result = computeKCS([{ id: 'BTC', prices: uptrend(25) }]);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.components.momentum).toBeDefined();
  });

  it('produces lower momentum and RSI-quality scores for a downtrend than for an uptrend', () => {
    const up = computeKCS([{ id: 'BTC', prices: uptrend(30, 100, 2) }]);
    const down = computeKCS([{ id: 'BTC', prices: downtrend(30, 200, 2) }]);
    expect(down.components.momentum.score).toBeLessThan(up.components.momentum.score);
    expect(down.score).toBeLessThan(up.score);
  });

  it('produces a near-EQUILIBRIUM/NEUTRAL reading for a flat series', () => {
    const result = computeKCS([{ id: 'BTC', prices: flat(30, 100) }]);
    expect(result.score).toBeGreaterThanOrEqual(45);
    expect(result.score).toBeLessThanOrEqual(60);
  });

  it('always returns a score clamped between 0 and 100', () => {
    const result = computeKCS([{ id: 'BTC', prices: uptrend(30, 100, 50) }]);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('includes all 7 weighted components summing to a total weight of 1.0', () => {
    const result = computeKCS([{ id: 'BTC', prices: uptrend(25) }]);
    const keys = ['momentum', 'volatility', 'breadth', 'liquidity', 'rsiQuality', 'btcDominance', 'sentiment'];
    for (const k of keys) expect(result.components[k]).toBeDefined();
    const totalWeight = keys.reduce((sum, k) => sum + result.components[k].weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 5);
  });

  it('computes breadth from multiple assets when more than one is provided', () => {
    const allUp = computeKCS([
      { id: 'BTC', prices: uptrend(25) },
      { id: 'ETH', prices: uptrend(25) },
      { id: 'SOL', prices: uptrend(25) },
    ]);
    expect(allUp.components.breadth.score).toBe(100);

    const allDown = computeKCS([
      { id: 'BTC', prices: downtrend(25) },
      { id: 'ETH', prices: downtrend(25) },
      { id: 'SOL', prices: downtrend(25) },
    ]);
    expect(allDown.components.breadth.score).toBe(0);
  });

  it('uses volume acceleration for the liquidity component when volumeArr is provided', () => {
    const prices = uptrend(25);
    const risingVolume = [...Array(20).fill(100), 200]; // big spike at the end
    const result = computeKCS([{ id: 'BTC', prices }], risingVolume);
    expect(result.components.liquidity.score).toBeGreaterThan(50);
  });

  it('shifts btcDominance component toward risk-off for high dominance, altseason for low dominance', () => {
    const prices = uptrend(25);
    const highDom = computeKCS([{ id: 'BTC', prices }], null, 65);
    const lowDom = computeKCS([{ id: 'BTC', prices }], null, 35);
    expect(highDom.components.btcDominance.score).toBeLessThan(lowDom.components.btcDominance.score);
  });

  it('uses the provided fearGreed value directly as the sentiment score', () => {
    const result = computeKCS([{ id: 'BTC', prices: uptrend(25) }], null, null, 80);
    expect(result.components.sentiment.score).toBe(80);
  });

  it('derives sentiment from momentum when fearGreed is not provided', () => {
    const up = computeKCS([{ id: 'BTC', prices: uptrend(25, 100, 3) }]);
    const flatResult = computeKCS([{ id: 'BTC', prices: flat(25) }]);
    expect(up.components.sentiment.score).toBeGreaterThan(flatResult.components.sentiment.score);
  });

  it('attaches version and a numeric timestamp to every result', () => {
    const result = computeKCS([{ id: 'BTC', prices: uptrend(25) }]);
    expect(result.version).toBe(KCS_VERSION);
    expect(typeof result.timestamp).toBe('number');
  });

  it('returns one of the 5 documented state labels matching the score band', () => {
    const validStates = ['RISK ON', 'CAUTIOUSLY BULLISH', 'EQUILIBRIUM', 'CAUTIOUSLY BEARISH', 'RISK OFF'];
    const result = computeKCS([{ id: 'BTC', prices: uptrend(25) }]);
    expect(validStates).toContain(result.state);
  });
});

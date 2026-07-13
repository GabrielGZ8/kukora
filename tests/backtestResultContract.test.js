import { describe, it, expect } from 'vitest';
import { runBacktest, runAllStrategies } from '../server/domain/engines/backtestEngine.js';
import { isBacktestStrategyResult, isBacktestRunResult } from '../server/domain/engines/backtestResult.js';

// Same fixture used in tests/backtestEngine.test.js — a synthetic uptrend
// series long enough to satisfy the 35-price minimum and reliably produce
// a non-trivial strategy result.
function buildTrendSeries(n = 60) {
  const prices = [];
  for (let i = 0; i < n; i++) {
    if (i < 15) prices.push(100 + Math.sin(i) * 0.1);
    else if (i < 45) prices.push(100 + (i - 15) * 2);
    else prices.push(prices[prices.length - 1]);
  }
  return prices;
}

describe('backtestResult contract (BacktestStrategyResult / BacktestRunResult)', () => {
  describe('isBacktestStrategyResult', () => {
    it('accepts the real shape produced by runBacktest().strategy', () => {
      const { strategy } = runBacktest(buildTrendSeries(), 'sma_crossover');
      expect(isBacktestStrategyResult(strategy)).toBe(true);
    });

    it('accepts the real shape produced by runBacktest().benchmark (buyAndHold)', () => {
      const { benchmark } = runBacktest(buildTrendSeries(), 'sma_crossover');
      expect(isBacktestStrategyResult(benchmark)).toBe(true);
    });

    it('rejects null/undefined', () => {
      expect(isBacktestStrategyResult(null)).toBe(false);
      expect(isBacktestStrategyResult(undefined)).toBe(false);
    });

    it('rejects a shape missing equity (array)', () => {
      expect(isBacktestStrategyResult({
        strategy: 'SMA Crossover', maxDrawdown: 0, totalTrades: 0,
      })).toBe(false);
    });

    it('rejects a shape with the wrong types (drift simulation)', () => {
      expect(isBacktestStrategyResult({
        strategy: 123, equity: 'not-an-array', maxDrawdown: '0', totalTrades: '0',
      })).toBe(false);
    });
  });

  describe('isBacktestRunResult', () => {
    it('accepts the real combined shape from runBacktest()', () => {
      const result = runBacktest(buildTrendSeries(), 'sma_crossover');
      expect(isBacktestRunResult(result)).toBe(true);
    });

    it('accepts each entry produced by runAllStrategies() paired with itself', () => {
      const results = runAllStrategies(buildTrendSeries());
      for (const r of Object.values(results)) {
        expect(isBacktestRunResult({ strategy: r, benchmark: r })).toBe(true);
      }
    });

    it('rejects a shape with only one valid side', () => {
      const { strategy } = runBacktest(buildTrendSeries(), 'sma_crossover');
      expect(isBacktestRunResult({ strategy, benchmark: null })).toBe(false);
    });

    it('rejects a completely broken shape', () => {
      expect(isBacktestRunResult({})).toBe(false);
      expect(isBacktestRunResult(null)).toBe(false);
    });
  });
});

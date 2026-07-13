import { describe, it, expect } from 'vitest';
import { runBacktest, runAllStrategies, smaCrossover, rsiMeanReversion, bollingerBreakout, buyAndHold } from '../server/domain/engines/backtestEngine.js';

// Build a synthetic price series with a clear single uptrend so a SMA
// crossover (short crosses above long) reliably fires at least once.
function buildTrendSeries(n = 60) {
  const prices = [];
  for (let i = 0; i < n; i++) {
    // flat for the first third, then a sustained ramp up, then flat again
    if (i < 15) prices.push(100 + Math.sin(i) * 0.1);
    else if (i < 45) prices.push(100 + (i - 15) * 2);
    else prices.push(prices[prices.length - 1]);
  }
  return prices;
}

// Oscillating series designed to push RSI into oversold/overbought territory.
function buildOscillatingSeries(n = 60) {
  const prices = [];
  for (let i = 0; i < n; i++) {
    prices.push(100 + Math.sin(i / 2) * 15);
  }
  return prices;
}

describe('backtestEngine', () => {
  describe('runBacktest / runAllStrategies — minimum data guard', () => {
    it('runBacktest throws when fewer than 35 prices are given', () => {
      const prices = Array.from({ length: 34 }, (_, i) => 100 + i);
      expect(() => runBacktest(prices, 'sma_crossover')).toThrow('Se necesitan al menos 35 precios para el backtest');
    });

    it('runAllStrategies throws when fewer than 35 prices are given', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
      expect(() => runAllStrategies(prices)).toThrow('Se necesitan al menos 35 precios');
    });

    it('runBacktest succeeds with exactly 35 prices', () => {
      const prices = buildTrendSeries(35);
      expect(() => runBacktest(prices, 'sma_crossover')).not.toThrow();
    });
  });

  describe('runBacktest', () => {
    it('returns a strategy result plus a buy-and-hold benchmark', () => {
      const prices = buildTrendSeries();
      const result = runBacktest(prices, 'sma_crossover');
      expect(result.strategy.strategy).toBe('SMA Crossover');
      expect(result.benchmark.strategy).toBe('Buy & Hold');
    });

    it('defaults to SMA Crossover for an unknown strategyKey', () => {
      const prices = buildTrendSeries();
      const result = runBacktest(prices, 'unknown_strategy');
      expect(result.strategy.strategy).toBe('SMA Crossover');
    });

    it('dispatches to RSI Mean Reversion for "rsi_reversion"', () => {
      const prices = buildOscillatingSeries();
      const result = runBacktest(prices, 'rsi_reversion');
      expect(result.strategy.strategy).toBe('RSI Mean Reversion');
    });

    it('dispatches to Bollinger Breakout for "bollinger_breakout"', () => {
      const prices = buildTrendSeries();
      const result = runBacktest(prices, 'bollinger_breakout');
      expect(result.strategy.strategy).toBe('Bollinger Breakout');
    });
  });

  describe('runAllStrategies', () => {
    it('returns all four strategies keyed correctly', () => {
      const prices = buildTrendSeries();
      const result = runAllStrategies(prices);
      expect(Object.keys(result).sort()).toEqual(['bollinger_breakout', 'buy_and_hold', 'rsi_reversion', 'sma_crossover']);
    });
  });

  describe('smaCrossover', () => {
    it('opens and closes at least one trade on a clear uptrend', () => {
      const prices = buildTrendSeries();
      const result = smaCrossover(prices, 5, 15);
      expect(result.trades.length).toBeGreaterThan(0);
      expect(result.equity).toHaveLength(prices.length);
    });

    it('produces no trades on a perfectly flat series (no crossovers)', () => {
      const prices = Array(40).fill(100);
      const result = smaCrossover(prices);
      expect(result.trades).toEqual([]);
      expect(result.totalTrades).toBe(0);
      expect(result.totalReturn).toBe(0);
      expect(result.winRate).toBe(0);
    });

    it('closes an open position at the final price if still in a trade at the end', () => {
      const prices = buildTrendSeries(50).slice(0, 40); // cut off mid-trend so a position is likely open
      const result = smaCrossover(prices, 5, 15);
      if (result.trades.length > 0) {
        const last = result.trades[result.trades.length - 1];
        if (last.open) {
          expect(last.exit).toBe(prices[prices.length - 1]);
        }
      }
      // equity curve always matches price series length regardless
      expect(result.equity).toHaveLength(prices.length);
    });
  });

  describe('rsiMeanReversion', () => {
    it('returns a well-formed result on an oscillating series', () => {
      const prices = buildOscillatingSeries();
      const result = rsiMeanReversion(prices);
      expect(result.strategy).toBe('RSI Mean Reversion');
      expect(result.equity).toHaveLength(prices.length);
      expect(Array.isArray(result.trades)).toBe(true);
    });

    it('produces no trades on a perfectly flat series (RSI never crosses thresholds)', () => {
      const prices = Array(40).fill(100);
      const result = rsiMeanReversion(prices);
      expect(result.trades).toEqual([]);
    });
  });

  describe('bollingerBreakout', () => {
    it('returns a well-formed result on a trending series', () => {
      const prices = buildTrendSeries();
      const result = bollingerBreakout(prices);
      expect(result.strategy).toBe('Bollinger Breakout');
      expect(result.equity.length).toBeGreaterThan(0);
      expect(result.equity.length).toBeLessThanOrEqual(prices.length);
      expect(Array.isArray(result.trades)).toBe(true);
    });

    it('produces no trades on a perfectly flat series (price never breaks the bands)', () => {
      const prices = Array(40).fill(100);
      const result = bollingerBreakout(prices);
      expect(result.trades).toEqual([]);
    });
  });

  describe('buyAndHold', () => {
    it('computes totalReturn matching (last-first)/first*100', () => {
      const prices = [100, 105, 110, 95, 120];
      const result = buyAndHold(prices);
      expect(result.strategy).toBe('Buy & Hold');
      expect(result.totalReturn).toBeCloseTo(((120 - 100) / 100) * 100, 5);
      expect(result.equity).toHaveLength(prices.length);
      expect(result.equity[0]).toBeCloseTo(10000, 2);
    });

    it('computes maxDrawdown correctly for a simple peak-then-drop series', () => {
      const prices = [100, 200, 100]; // peak at 200 (equity 20000), drop to 100 (equity 10000) = 50% DD
      const result = buyAndHold(prices);
      expect(result.maxDrawdown).toBeCloseTo(50, 1);
    });

    it('reports null winRate/sharpeRatio and totalTrades of 1 (it is a single passive position)', () => {
      const prices = [100, 110, 120];
      const result = buyAndHold(prices);
      expect(result.winRate).toBeNull();
      expect(result.sharpeRatio).toBeNull();
      expect(result.totalTrades).toBe(1);
    });
  });
});

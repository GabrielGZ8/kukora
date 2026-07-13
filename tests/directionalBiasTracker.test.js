'use strict';
import { describe, it, expect } from 'vitest';

const {
  computeBias,
  getBiasSignals,
  DEFAULT_WINDOW,
  DEFAULT_MIN_SAMPLE,
} = require('../server/domain/analytics/directionalBiasTracker');
const liveConfig = require('../server/infrastructure/liveConfig');

function trade(buyExchange, sellExchange) {
  return { buyExchange, sellExchange };
}

describe('directionalBiasTracker', () => {
  it('returns an empty object for no trades', () => {
    expect(computeBias([])).toEqual({});
    expect(computeBias(undefined)).toEqual({});
  });

  it('is case-insensitive on exchange names', () => {
    const trades = [trade('Binance', 'Kraken'), trade('BINANCE', 'kraken')];
    const bias = computeBias(trades);
    expect(bias.binance).toBeDefined();
    expect(bias.kraken).toBeDefined();
    expect(bias.Binance).toBeUndefined();
  });

  it('counts an exchange as a buyer or seller correctly per trade', () => {
    const trades = [trade('binance', 'kraken'), trade('binance', 'bybit')];
    const bias = computeBias(trades);
    expect(bias.binance).toMatchObject({ buys: 2, sells: 0 });
    expect(bias.kraken).toMatchObject({ buys: 0, sells: 1 });
    expect(bias.bybit).toMatchObject({ buys: 0, sells: 1 });
  });

  it('computes biasScore as (buys - sells) / sampleSize', () => {
    const trades = [
      trade('binance', 'kraken'),
      trade('binance', 'kraken'),
      trade('kraken', 'binance'),
    ];
    const bias = computeBias(trades);
    // binance: 2 buys, 1 sell, sample 3 -> (2-1)/3
    expect(bias.binance.biasScore).toBeCloseTo(1 / 3, 3);
    // kraken: 1 buy, 2 sells, sample 3 -> (1-2)/3
    expect(bias.kraken.biasScore).toBeCloseTo(-1 / 3, 3);
  });

  it('labels direction "neutral" below minSample even with a perfect bias', () => {
    const trades = [trade('binance', 'kraken'), trade('binance', 'okx')];
    const bias = computeBias(trades, { minSample: 8 });
    expect(bias.binance.biasScore).toBe(1);
    expect(bias.binance.direction).toBe('neutral');
  });

  it('labels direction "buyer" once sample and threshold are both met', () => {
    const trades = Array.from({ length: 10 }, () => trade('binance', 'kraken'));
    const bias = computeBias(trades, { minSample: 8, window: 20 });
    expect(bias.binance.sampleSize).toBe(10);
    expect(bias.binance.biasScore).toBe(1);
    expect(bias.binance.direction).toBe('buyer');
  });

  it('labels direction "seller" once sample and threshold are both met', () => {
    const trades = Array.from({ length: 10 }, () => trade('kraken', 'binance'));
    const bias = computeBias(trades, { minSample: 8, window: 20 });
    expect(bias.binance.direction).toBe('seller');
    expect(bias.binance.biasScore).toBe(-1);
  });

  it('only considers the most recent `window` trades per exchange', () => {
    // 15 buys followed by 10 sells for binance; window=10 should see only sells.
    const trades = [
      ...Array.from({ length: 15 }, () => trade('binance', 'kraken')),
      ...Array.from({ length: 10 }, () => trade('kraken', 'binance')),
    ];
    const bias = computeBias(trades, { window: 10, minSample: 8 });
    expect(bias.binance.sampleSize).toBe(10);
    expect(bias.binance.direction).toBe('seller');
  });

  it('a balanced 50/50 exchange is neutral regardless of sample size', () => {
    const trades = [
      ...Array.from({ length: 10 }, () => trade('binance', 'kraken')),
      ...Array.from({ length: 10 }, () => trade('kraken', 'binance')),
    ];
    const bias = computeBias(trades, { window: 20, minSample: 8 });
    expect(bias.binance.biasScore).toBe(0);
    expect(bias.binance.direction).toBe('neutral');
  });

  it('ignores malformed trade entries missing buy/sell exchange', () => {
    const trades = [{ buyExchange: 'binance' }, { sellExchange: 'kraken' }, {}, null];
    expect(() => computeBias(trades)).not.toThrow();
    expect(computeBias(trades)).toEqual({});
  });

  it('exports sane defaults', () => {
    expect(DEFAULT_WINDOW).toBeGreaterThan(0);
    expect(DEFAULT_MIN_SAMPLE).toBeGreaterThan(0);
    expect(liveConfig.get('directionalBiasThreshold')).toBeGreaterThan(0);
    expect(liveConfig.get('directionalBiasThreshold')).toBeLessThanOrEqual(1);
  });

  describe('getBiasSignals', () => {
    it('excludes exchanges below minSample even with strong bias', () => {
      const trades = [trade('binance', 'kraken'), trade('binance', 'okx')];
      expect(getBiasSignals(trades)).toEqual([]);
    });

    it('excludes exchanges with sufficient sample but weak/neutral bias', () => {
      const trades = [
        ...Array.from({ length: 5 }, () => trade('binance', 'kraken')),
        ...Array.from({ length: 5 }, () => trade('kraken', 'binance')),
      ];
      expect(getBiasSignals(trades, { minSample: 8 })).toEqual([]);
    });

    it('includes exchanges with sufficient sample and strong consistent bias', () => {
      const trades = Array.from({ length: 10 }, () => trade('kraken', 'binance'));
      const signals = getBiasSignals(trades, { minSample: 8 });
      expect(signals).toHaveLength(2);
      const binanceSignal = signals.find(s => s.exchange === 'binance');
      expect(binanceSignal).toMatchObject({ exchange: 'binance', direction: 'seller', sells: 10, buys: 0 });
    });

    it('respects a custom threshold', () => {
      // biasScore 0.6 for binance (buys 8, sells 2 out of 10)
      const trades = [
        ...Array.from({ length: 8 }, () => trade('binance', 'kraken')),
        ...Array.from({ length: 2 }, () => trade('kraken', 'binance')),
      ];
      expect(getBiasSignals(trades, { minSample: 8, threshold: 0.7 })
        .find(s => s.exchange === 'binance')).toBeUndefined();
      expect(getBiasSignals(trades, { minSample: 8, threshold: 0.5 })
        .find(s => s.exchange === 'binance')).toBeDefined();
    });
  });
});

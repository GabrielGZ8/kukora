'use strict';

import { describe, it, expect, beforeEach } from 'vitest';

const {
  recordSlippageBias,
  getSlippagePenalty,
  resetSlippagePenalty,
  getDynamicPenalty,
  resetReliability,
} = require('../server/infrastructure/exchangeReliabilityDynamic');
const liveConfig = require('../server/infrastructure/liveConfig');

describe('exchangeReliabilityDynamic — ADR-019 §5 slippage penalty', () => {
  beforeEach(() => {
    resetSlippagePenalty();
    resetReliability();
    liveConfig.reset('test');
  });

  it('returns 0 when slippagePenaltyEnabled is false', () => {
    liveConfig.setMany({ slippagePenaltyEnabled: false, minExecutionSamples: 1 }, 'test');
    recordSlippageBias('Binance', 2.0);
    expect(getSlippagePenalty('Binance')).toBe(0);
  });

  it('returns 0 when there are fewer samples than minExecutionSamples', () => {
    liveConfig.setMany({ slippagePenaltyEnabled: true, minExecutionSamples: 5 }, 'test');
    recordSlippageBias('Binance', 2.0);
    recordSlippageBias('Binance', 2.0);
    expect(getSlippagePenalty('Binance')).toBe(0);
  });

  it('returns 0 when average bias is at or below 0 (fills as good as or better than modeled)', () => {
    liveConfig.setMany({ slippagePenaltyEnabled: true, minExecutionSamples: 2 }, 'test');
    recordSlippageBias('Binance', 0);
    recordSlippageBias('Binance', -0.5);
    expect(getSlippagePenalty('Binance')).toBe(0);
  });

  it('scales linearly with average bias, capped at 25', () => {
    liveConfig.setMany({ slippagePenaltyEnabled: true, minExecutionSamples: 2 }, 'test');
    recordSlippageBias('Kraken', 0.5);
    recordSlippageBias('Kraken', 0.5);
    // avg bias 0.5 → 0.5 * 25 = 12.5
    expect(getSlippagePenalty('Kraken')).toBeCloseTo(12.5, 5);
  });

  it('caps the penalty at 25 even for very large average bias', () => {
    liveConfig.setMany({ slippagePenaltyEnabled: true, minExecutionSamples: 2 }, 'test');
    recordSlippageBias('OKX', 5.0);
    recordSlippageBias('OKX', 5.0);
    expect(getSlippagePenalty('OKX')).toBe(25);
  });

  it('tracks exchanges independently', () => {
    liveConfig.setMany({ slippagePenaltyEnabled: true, minExecutionSamples: 1 }, 'test');
    recordSlippageBias('Binance', 1.0);
    expect(getSlippagePenalty('Binance')).toBeGreaterThan(0);
    expect(getSlippagePenalty('Kraken')).toBe(0);
  });

  it('resetSlippagePenalty() clears all recorded samples', () => {
    liveConfig.setMany({ slippagePenaltyEnabled: true, minExecutionSamples: 1 }, 'test');
    recordSlippageBias('Binance', 1.0);
    expect(getSlippagePenalty('Binance')).toBeGreaterThan(0);
    resetSlippagePenalty();
    expect(getSlippagePenalty('Binance')).toBe(0);
  });

  it('ignores unknown exchange names without throwing', () => {
    expect(() => recordSlippageBias('NotAnExchange', 1.0)).not.toThrow();
    expect(getSlippagePenalty('NotAnExchange')).toBe(0);
  });

  it('remains on the same [0,25] scale as getDynamicPenalty for consistent Math.max combination', () => {
    liveConfig.setMany({ slippagePenaltyEnabled: true, minExecutionSamples: 1 }, 'test');
    recordSlippageBias('Bybit', 10); // extreme bias
    const slipPenalty = getSlippagePenalty('Bybit');
    const dynPenalty  = getDynamicPenalty('Bybit'); // healthy exchange, no feed events => 0
    expect(slipPenalty).toBeGreaterThan(0);
    expect(slipPenalty).toBeLessThanOrEqual(25);
    expect(dynPenalty).toBeLessThanOrEqual(25);
  });
});

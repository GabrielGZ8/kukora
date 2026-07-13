'use strict';

/**
 * marketRegimeEngine.test.js — unit tests for server/marketRegimeEngine.js
 *
 * Audit v2, section 9.1: one of the 34 untested server modules. This one is
 * a pure, deterministic function (no DB, no network), which makes it cheap
 * to cover thoroughly — there's no excuse for 0 tests on logic this testable.
 */

import { describe, it, expect } from 'vitest';
const { detectMarketRegime, detectMarketRegimeBatch, REGIMES } = require('../server/domain/engines/marketRegimeEngine');

function flatPrices(n = 30, base = 100) {
  return Array.from({ length: n }, () => base);
}

function risingPrices(n = 30, start = 100, dailyPct = 0.02) {
  const arr = [start];
  for (let i = 1; i < n; i++) arr.push(arr[i - 1] * (1 + dailyPct));
  return arr;
}

function fallingPrices(n = 30, start = 100, dailyPct = 0.02) {
  const arr = [start];
  for (let i = 1; i < n; i++) arr.push(arr[i - 1] * (1 - dailyPct));
  return arr;
}

function volatilePrices(n = 30, base = 100) {
  // Alternate sharply up/down to simulate high, contradictory volatility
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(base * (1 + (i % 2 === 0 ? 0.08 : -0.08)));
  return arr;
}

describe('marketRegimeEngine — REGIMES catalog', () => {
  it('exposes all 6 documented regimes with required display fields', () => {
    const ids = Object.keys(REGIMES);
    expect(ids).toEqual([
      'LIQUIDITY_COMPRESSION', 'BULLISH_EXPANSION', 'BEARISH_CONTRACTION',
      'DISTRIBUTION', 'ACCUMULATION', 'VOLATILE_UNCERTAINTY',
    ]);
    for (const r of Object.values(REGIMES)) {
      expect(r).toHaveProperty('label');
      expect(r).toHaveProperty('color');
      expect(r).toHaveProperty('description');
    }
  });
});

describe('marketRegimeEngine — detectMarketRegime', () => {
  it('returns VOLATILE_UNCERTAINTY with insufficient data (< 15 points)', () => {
    const result = detectMarketRegime([100, 101, 102]);
    expect(result.id).toBe('VOLATILE_UNCERTAINTY');
    expect(result.confidence).toBe(50);
    expect(result.signals).toEqual([]);
  });

  it('detects a bullish expansion on a steadily rising series', () => {
    const result = detectMarketRegime(risingPrices(40, 100, 0.03));
    expect(result.id).toBe('BULLISH_EXPANSION');
    expect(result.confidence).toBeGreaterThanOrEqual(45);
    expect(result.confidence).toBeLessThanOrEqual(95);
  });

  it('detects a bearish contraction on a steadily falling series', () => {
    const result = detectMarketRegime(fallingPrices(40, 100, 0.03));
    expect(result.id).toBe('BEARISH_CONTRACTION');
  });

  it('returns a full result shape: signals, interpretation, metrics, scores', () => {
    const result = detectMarketRegime(risingPrices(40, 100, 0.02));
    expect(result.signals.length).toBe(4);
    expect(typeof result.interpretation).toBe('string');
    expect(result.interpretation.length).toBeGreaterThan(0);
    expect(result.metrics).toHaveProperty('normalizedVol');
    expect(result.metrics).toHaveProperty('trend');
    expect(result.metrics).toHaveProperty('momentum');
    expect(result.metrics).toHaveProperty('recentReturn');
    expect(result.breakoutProbability).toBeGreaterThanOrEqual(0);
    expect(result.breakoutProbability).toBeLessThanOrEqual(90);
    // scores object should contain every regime, sorted descending
    const scoreValues = Object.values(result.scores);
    expect(Object.keys(result.scores).sort()).toEqual(Object.keys(REGIMES).sort());
    for (let i = 1; i < scoreValues.length; i++) {
      expect(scoreValues[i]).toBeLessThanOrEqual(scoreValues[i - 1]);
    }
  });

  it('a flat/sideways series with low volatility leans toward compression or accumulation', () => {
    const result = detectMarketRegime(flatPrices(40, 100));
    expect(['LIQUIDITY_COMPRESSION', 'ACCUMULATION']).toContain(result.id);
  });

  it('confidence is always clamped to [45, 95]', () => {
    for (const series of [risingPrices(40), fallingPrices(40), flatPrices(40), volatilePrices(40)]) {
      const result = detectMarketRegime(series);
      expect(result.confidence).toBeGreaterThanOrEqual(45);
      expect(result.confidence).toBeLessThanOrEqual(95);
    }
  });
});

describe('marketRegimeEngine — detectMarketRegimeBatch', () => {
  it('aggregates a per-asset regime result with a confidence-weighted consensus', async () => {
    const assetsData = [
      { id: 'bitcoin', name: 'Bitcoin', prices: risingPrices(40, 100, 0.03) },
      { id: 'ethereum', name: 'Ethereum', prices: risingPrices(40, 50, 0.03) },
      { id: 'solana', name: 'Solana', prices: fallingPrices(40, 20, 0.03) },
    ];
    const batch = await detectMarketRegimeBatch(assetsData);
    expect(batch.assets.length).toBe(3);
    expect(batch.assets[0].id).toBe('bitcoin');
    expect(batch.consensus).toHaveProperty('id');
    expect(batch.consensus.confidence).toBeLessThanOrEqual(92);
    expect(typeof batch.timestamp).toBe('number');
  });

  it('handles a single asset without throwing', async () => {
    const batch = await detectMarketRegimeBatch([
      { id: 'bitcoin', name: 'Bitcoin', prices: flatPrices(20, 100) },
    ]);
    expect(batch.assets.length).toBe(1);
    expect(batch.consensus.id).toBe(batch.assets[0].regime.id);
  });

  it('handles an empty asset list without throwing (consensus falls back to VOLATILE_UNCERTAINTY)', async () => {
    const batch = await detectMarketRegimeBatch([]);
    expect(batch.assets).toEqual([]);
    expect(batch.consensus.id).toBe('VOLATILE_UNCERTAINTY');
  });
});

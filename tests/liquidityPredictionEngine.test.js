'use strict';

/**
 * liquidityPredictionEngine.test.js — unit tests for
 * server/domain/engines/liquidityPredictionEngine.js.
 *
 * Covers: cold-start behavior (no fabricated confidence), EWMA learning
 * from repeated observations, hour-of-day seasonality bucketing, size-bucket
 * conditioning, trend detection (crossover), and the
 * enrichWithLiquidityPrediction() convenience wrapper's online
 * train-and-predict behavior.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const engine = require('../server/domain/engines/liquidityPredictionEngine');
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

describe('liquidityPredictionEngine', () => {
  beforeEach(() => {
    engine.resetModels();
  });

  describe('cold start', () => {
    it('returns zero confidence and a neutral prediction when no observations exist', () => {
      const result = engine.predictLiquidity('Binance', 'BTC/USDT');
      expect(result.confidence).toBe(0);
      expect(result.sampleCount).toBe(0);
      expect(result.basis).toBe('cold_start_no_observations');
      expect(result.expectedFillPct).toBeGreaterThan(0);
      expect(result.expectedFillPct).toBeLessThanOrEqual(100);
    });

    it('does not fabricate hour-of-day or size-bucket data on cold start', () => {
      const result = engine.predictLiquidity('Binance', 'BTC/USDT');
      expect(result.hourOfDayAvgFillPct).toBeNull();
      expect(result.sizeBucketAvgFillPct).toBeNull();
      expect(result.recommendedMaxSizeUSD).toBeNull();
    });
  });

  describe('recordObservation + learning', () => {
    it('ignores malformed observations (missing/non-numeric fillPct)', () => {
      expect(engine.recordObservation('Binance', 'BTC/USDT', {})).toBeNull();
      expect(engine.recordObservation('Binance', 'BTC/USDT', { fillPct: 'not-a-number' })).toBeNull();
      expect(engine.getModelState('Binance', 'BTC/USDT')).toBeNull();
    });

    it('clamps out-of-range fillPct into [0, 100]', () => {
      engine.recordObservation('Binance', 'BTC/USDT', { fillPct: 150 });
      const state = engine.getModelState('Binance', 'BTC/USDT');
      expect(state.shortEwma).toBe(100);
    });

    it('increases confidence as more samples accumulate, saturating at 1.0', () => {
      for (let i = 0; i < 10; i++) engine.recordObservation('Binance', 'BTC/USDT', { fillPct: 90 });
      const low = engine.predictLiquidity('Binance', 'BTC/USDT');
      expect(low.confidence).toBeCloseTo(10 / 50, 2);

      for (let i = 0; i < 100; i++) engine.recordObservation('Binance', 'BTC/USDT', { fillPct: 90 });
      const high = engine.predictLiquidity('Binance', 'BTC/USDT');
      expect(high.confidence).toBe(1);
    });

    it('converges the short-term EWMA toward a consistently repeated fillPct', () => {
      for (let i = 0; i < 50; i++) engine.recordObservation('Kraken', 'ETH/USDT', { fillPct: 40 });
      const result = engine.predictLiquidity('Kraken', 'ETH/USDT');
      expect(result.expectedFillPct).toBeCloseTo(40, 0);
    });

    it('keeps separate models per exchange+pair key', () => {
      engine.recordObservation('Binance', 'BTC/USDT', { fillPct: 95 });
      engine.recordObservation('Bybit', 'BTC/USDT', { fillPct: 20 });
      expect(engine.getModelState('Binance', 'BTC/USDT').shortEwma).toBe(95);
      expect(engine.getModelState('Bybit', 'BTC/USDT').shortEwma).toBe(20);
    });

    it('is case-insensitive on exchange name and pair', () => {
      engine.recordObservation('BINANCE', 'btc/usdt', { fillPct: 88 });
      const result = engine.predictLiquidity('binance', 'BTC/USDT');
      expect(result.sampleCount).toBe(1);
    });
  });

  describe('trend detection', () => {
    it('detects an improving trend when recent fillPct is consistently higher than the long-term baseline', () => {
      // Establish a low long-term baseline first.
      for (let i = 0; i < 60; i++) engine.recordObservation('Binance', 'BTC/USDT', { fillPct: 30 });
      // Then a sustained recent improvement.
      for (let i = 0; i < 20; i++) engine.recordObservation('Binance', 'BTC/USDT', { fillPct: 95 });
      const result = engine.predictLiquidity('Binance', 'BTC/USDT');
      expect(result.trend).toBe('improving');
    });

    it('detects a deteriorating trend when recent fillPct is consistently lower than the long-term baseline', () => {
      for (let i = 0; i < 60; i++) engine.recordObservation('Binance', 'BTC/USDT', { fillPct: 95 });
      for (let i = 0; i < 20; i++) engine.recordObservation('Binance', 'BTC/USDT', { fillPct: 20 });
      const result = engine.predictLiquidity('Binance', 'BTC/USDT');
      expect(result.trend).toBe('deteriorating');
    });

    it('reports stable when short and long EWMA are close', () => {
      for (let i = 0; i < 60; i++) engine.recordObservation('Binance', 'BTC/USDT', { fillPct: 80 });
      const result = engine.predictLiquidity('Binance', 'BTC/USDT');
      expect(result.trend).toBe('stable');
    });
  });

  describe('size-bucket conditioning', () => {
    it('tracks fill quality separately for small vs large trade sizes and reflects it in predictions', () => {
      for (let i = 0; i < 30; i++) {
        engine.recordObservation('Binance', 'BTC/USDT', { fillPct: 95, sizeUSD: 500 });   // small
        engine.recordObservation('Binance', 'BTC/USDT', { fillPct: 30, sizeUSD: 50000 }); // large
      }
      const smallPrediction = engine.predictLiquidity('Binance', 'BTC/USDT', { sizeUSD: 500 });
      const largePrediction = engine.predictLiquidity('Binance', 'BTC/USDT', { sizeUSD: 50000 });

      expect(smallPrediction.sizeBucketAvgFillPct).toBeCloseTo(95, 0);
      expect(largePrediction.sizeBucketAvgFillPct).toBeCloseTo(30, 0);
      expect(smallPrediction.expectedFillPct).toBeGreaterThan(largePrediction.expectedFillPct);
    });

    it('recommends a smaller max size once larger buckets show degraded fill quality', () => {
      for (let i = 0; i < 30; i++) {
        engine.recordObservation('Binance', 'BTC/USDT', { fillPct: 95, sizeUSD: 500 });   // small: healthy
        engine.recordObservation('Binance', 'BTC/USDT', { fillPct: 80, sizeUSD: 5000 });  // medium: healthy
        engine.recordObservation('Binance', 'BTC/USDT', { fillPct: 20, sizeUSD: 50000 }); // large: degraded (<60)
      }
      const result = engine.predictLiquidity('Binance', 'BTC/USDT', { sizeUSD: 500 });
      // Small and medium clear the bar (95, 80 >= 60); large does not (20 < 60) —
      // recommendation should cap at the medium bucket ceiling, not "large".
      expect(result.recommendedMaxSizeUSD).toBe(10000);
    });
  });

  describe('hour-of-day seasonality', () => {
    it('buckets observations by UTC hour and surfaces the hour-specific average', () => {
      const hour3 = new Date('2026-01-01T03:00:00Z').getTime();
      const hour15 = new Date('2026-01-01T15:00:00Z').getTime();

      for (let i = 0; i < 10; i++) engine.recordObservation('Binance', 'BTC/USDT', { fillPct: 20, ts: hour3 });
      for (let i = 0; i < 10; i++) engine.recordObservation('Binance', 'BTC/USDT', { fillPct: 90, ts: hour15 });

      const predictionAt3  = engine.predictLiquidity('Binance', 'BTC/USDT', { ts: hour3 });
      const predictionAt15 = engine.predictLiquidity('Binance', 'BTC/USDT', { ts: hour15 });

      expect(predictionAt3.hourOfDayAvgFillPct).toBeCloseTo(20, 0);
      expect(predictionAt15.hourOfDayAvgFillPct).toBeCloseTo(90, 0);
    });
  });

  describe('enrichWithLiquidityPrediction', () => {
    it('attaches a liquidityPrediction field with buy/sell predictions to each opportunity', () => {
      const opportunities = [
        { id: 'o1', buyExchange: 'Binance', sellExchange: 'Bybit', pair: 'BTC/USDT', buyFillPct: 90, sellFillPct: 85, spreadPct: 0.3 },
      ];
      const enriched = engine.enrichWithLiquidityPrediction(opportunities);
      expect(enriched[0].liquidityPrediction).toBeDefined();
      expect(enriched[0].liquidityPrediction.buy).toBeDefined();
      expect(enriched[0].liquidityPrediction.sell).toBeDefined();
      // Original fields preserved (additive enrichment, not a replacement).
      expect(enriched[0].id).toBe('o1');
    });

    it('trains the model online — a later call for the same pair reflects earlier calls', () => {
      const mkOpp = () => [{ id: 'o', buyExchange: 'Binance', sellExchange: 'Bybit', pair: 'BTC/USDT', buyFillPct: 95, sellFillPct: 95 }];
      engine.enrichWithLiquidityPrediction(mkOpp());
      engine.enrichWithLiquidityPrediction(mkOpp());
      const third = engine.enrichWithLiquidityPrediction(mkOpp());
      expect(third[0].liquidityPrediction.buy.sampleCount).toBeGreaterThanOrEqual(2);
    });

    it('does not throw and returns opportunities unchanged when fillPct data is missing', () => {
      const opportunities = [{ id: 'o2', buyExchange: 'Binance', sellExchange: 'Bybit', pair: 'BTC/USDT' }];
      const enriched = engine.enrichWithLiquidityPrediction(opportunities);
      expect(enriched[0].id).toBe('o2');
      expect(enriched[0].liquidityPrediction.buy.sampleCount).toBe(0);
    });

    it('does not flag a contract violation for a real Opportunity from detectOpportunities()', async () => {
      const { detectOpportunities } = await import('../server/domain/engines/opportunityDetection.js');
      const books = makeOrderBooks();
      const { opportunities } = detectOpportunities(books, 0.1);
      expect(opportunities.length).toBeGreaterThan(0);

      const emitSpy = vi.spyOn(observability, 'emit');
      const enriched = engine.enrichWithLiquidityPrediction(opportunities, { sizeUSD: 5000 });
      const contractViolations = emitSpy.mock.calls.filter(
        call => call[1] === 'contract.opportunity_shape_invalid',
      );
      expect(contractViolations).toEqual([]);
      expect(enriched.every(op => op.liquidityPrediction !== undefined)).toBe(true);
      emitSpy.mockRestore();
    });
  });
});

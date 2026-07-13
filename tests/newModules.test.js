'use strict';
/**
 * newModules.test.js — tests para los 4 módulos nuevos integrados en v14:
 *   - slippageValidator
 *   - weeklyPnlTracker
 *   - metricsService (new histogram + prometheus APIs)
 *   - feeConfig (getFeeForVolume, getBreakEvenSpread)
 */
import { describe, it, expect, beforeEach } from 'vitest';

// ─── slippageValidator ────────────────────────────────────────────────────
import slippageValidator from '../server/domain/risk/slippageValidator.js';

describe('slippageValidator', () => {
  beforeEach(() => slippageValidator.reset());

  it('returns empty stats before any samples', () => {
    const stats = slippageValidator.getCalibrationStats();
    expect(stats.sampleCount).toBe(0);
    expect(stats.phase1GateMet).toBe(false);
    expect(stats.slippageAccuracyRate).toBeNull();
  });

  it('records an accurate sample and computes accuracy = 1', () => {
    slippageValidator.recordSample({
      pair: 'Binance→OKX',
      modeledNetUSD: 2.0,
      realizedNetUSD: 2.0,
      modeledSpreadPct: 0.3,
      realizedSpreadPct: 0.3,
      executionLatencyMs: 40,
      score: 75,
    });
    const stats = slippageValidator.getCalibrationStats();
    expect(stats.sampleCount).toBe(1);
    expect(stats.slippageAccuracyRate).toBe(1);
    expect(stats.phase1GateMet).toBe(true);
  });

  it('marks inaccurate sample when divergence > 25%', () => {
    slippageValidator.recordSample({
      pair: 'Binance→Kraken',
      modeledNetUSD: 2.0,
      realizedNetUSD: 1.0,  // 50% divergence — above 25% threshold
      modeledSpreadPct: 0.3,
      realizedSpreadPct: 0.15,
      executionLatencyMs: 80,
      score: 60,
    });
    const stats = slippageValidator.getCalibrationStats();
    expect(stats.slippageAccuracyRate).toBe(0);
    expect(stats.phase1GateMet).toBe(false);
    expect(stats.overestimationRate).toBe(1); // modeled > realized
  });

  it('ignores samples with missing netUSD fields', () => {
    slippageValidator.recordSample({ pair: 'Binance→OKX' }); // no netUSD
    expect(slippageValidator.getCalibrationStats().sampleCount).toBe(0);
  });

  it('computes pairBreakdown with worst pairs first', () => {
    slippageValidator.recordSample({ pair: 'A→B', modeledNetUSD: 2, realizedNetUSD: 2, modeledSpreadPct: 0, realizedSpreadPct: 0, executionLatencyMs: 0, score: 0 });
    slippageValidator.recordSample({ pair: 'C→D', modeledNetUSD: 2, realizedNetUSD: 1, modeledSpreadPct: 0, realizedSpreadPct: 0, executionLatencyMs: 0, score: 0 });
    const stats = slippageValidator.getCalibrationStats();
    expect(stats.pairBreakdown[0].pair).toBe('C→D'); // worst first
    expect(stats.pairBreakdown[1].pair).toBe('A→B');
  });
});

// ─── weeklyPnlTracker ─────────────────────────────────────────────────────
import weeklyPnlTracker from '../server/domain/wallet/weeklyPnlTracker.js';

describe('weeklyPnlTracker', () => {
  beforeEach(() => weeklyPnlTracker.resetWeekly());

  it('starts at zero', () => {
    expect(weeklyPnlTracker.getWeeklyPnl()).toBe(0);
  });

  it('accumulates P&L correctly', () => {
    weeklyPnlTracker.addWeeklyPnl(100.50);
    weeklyPnlTracker.addWeeklyPnl(-30.25);
    expect(weeklyPnlTracker.getWeeklyPnl()).toBeCloseTo(70.25, 2);
  });

  it('isWeeklyLossBreached returns false when above limit', () => {
    weeklyPnlTracker.addWeeklyPnl(-100); // -100, limit is -2000
    expect(weeklyPnlTracker.isWeeklyLossBreached()).toBe(false);
  });

  it('isWeeklyTargetHit returns false when target is null', () => {
    weeklyPnlTracker.addWeeklyPnl(99999);
    expect(weeklyPnlTracker.isWeeklyTargetHit()).toBe(false); // null target
  });

  it('isDailyTargetHit returns false when target is null', () => {
    expect(weeklyPnlTracker.isDailyTargetHit(9999)).toBe(false);
  });

  it('getWeeklyStats returns correct shape', () => {
    weeklyPnlTracker.addWeeklyPnl(50);
    const stats = weeklyPnlTracker.getWeeklyStats();
    expect(stats).toHaveProperty('weeklyPnl');
    expect(stats).toHaveProperty('weeklyTrades');
    expect(stats).toHaveProperty('weekStart');
    expect(stats).toHaveProperty('lossBreached');
    expect(stats).toHaveProperty('targetHit');
    expect(stats.weeklyTrades).toBe(1);
    expect(stats.weeklyPnl).toBeCloseTo(50, 2);
  });
});

// ─── metricsService (new APIs) ────────────────────────────────────────────
import metrics from '../server/infrastructure/metricsService.js';

describe('metricsService — histograms and prometheus', () => {
  it('observe() records a sample and computes stats', () => {
    metrics.observe('detection_latency_ms', 10);
    metrics.observe('detection_latency_ms', 20);
    const stats = metrics.histogramStats('detection_latency_ms');
    expect(stats).not.toBeNull();
    expect(stats.count).toBeGreaterThanOrEqual(2);
    expect(stats.p50).toBeLessThanOrEqual(20);
  });

  it('prometheusText() returns non-empty string with TYPE lines', () => {
    const text = metrics.prometheusText();
    expect(typeof text).toBe('string');
    expect(text).toContain('# TYPE kukora_');
    expect(text).toContain('kukora_uptime_seconds');
  });

  it('prometheusText() includes histogram buckets after observe()', () => {
    metrics.observe('execution_latency_ms', 50);
    const text = metrics.prometheusText();
    expect(text).toContain('kukora_execution_latency_ms_bucket');
    expect(text).toContain('kukora_execution_latency_ms_count');
  });

  it('increment() updates counter visible in snapshot()', () => {
    const before = metrics.snapshot().counters.trades_executed_total || 0;
    metrics.increment('trades_executed_total');
    const after = metrics.snapshot().counters.trades_executed_total;
    expect(after).toBe(before + 1);
  });

  it('setGauge() updates gauge visible in snapshot()', () => {
    metrics.setGauge('live_exchanges', 5);
    expect(metrics.snapshot().gauges.live_exchanges).toBe(5);
  });
});

// ─── feeConfig (new APIs) ─────────────────────────────────────────────────
import feeConfig from '../server/domain/wallet/feeConfig.js';

describe('feeConfig — getFeeForVolume and getBreakEvenSpread', () => {
  it('getFeeForVolume returns base taker fee at 0 volume', () => {
    expect(feeConfig.getFeeForVolume('Binance', 0, 'taker')).toBe(0.001);
    expect(feeConfig.getFeeForVolume('OKX', 0, 'taker')).toBe(0.001);
    expect(feeConfig.getFeeForVolume('Kraken', 0, 'taker')).toBe(0.0026);
  });

  it('getFeeForVolume returns lower fee at higher volume tier', () => {
    const base = feeConfig.getFeeForVolume('Binance', 0, 'taker');
    const vip3 = feeConfig.getFeeForVolume('Binance', 20_000_001, 'taker');
    expect(vip3).toBeLessThan(base);
  });

  it('getFeeForVolume applies BNB discount on Binance', () => {
    const noBnb = feeConfig.getFeeForVolume('Binance', 0, 'taker', false);
    const bnb   = feeConfig.getFeeForVolume('Binance', 0, 'taker', true);
    expect(bnb).toBeLessThan(noBnb);
    expect(bnb).toBeCloseTo(noBnb * 0.75, 5);
  });

  it('getFeeForVolume returns unknown exchange default', () => {
    const fee = feeConfig.getFeeForVolume('UnknownExchange', 0, 'taker');
    expect(typeof fee).toBe('number');
    expect(fee).toBe(0);
  });

  it('getBreakEvenSpread returns sum of both fees + 2x slippage', () => {
    const spread = feeConfig.getBreakEvenSpread('Binance', 'OKX', 'taker');
    // Binance taker 0.1% + OKX taker 0.1% + 2*0.05% slippage = 0.3%
    expect(spread).toBeCloseTo(0.3, 2);
  });

  it('getBreakEvenSpread is higher for Coinbase pairs', () => {
    const cheap    = feeConfig.getBreakEvenSpread('Binance', 'OKX', 'taker');
    const coinbase = feeConfig.getBreakEvenSpread('Binance', 'Coinbase', 'taker');
    expect(coinbase).toBeGreaterThan(cheap);
  });

  it('all TRADING_FEES and MAKER_FEES are numeric and reasonable', () => {
    for (const [ex, fee] of Object.entries(feeConfig.TRADING_FEES)) {
      expect(typeof fee).toBe('number');
      expect(fee).toBeGreaterThan(0);
      expect(fee).toBeLessThan(0.1); // sanity: no fee > 10%
    }
    for (const [ex, fee] of Object.entries(feeConfig.MAKER_FEES)) {
      expect(typeof fee).toBe('number');
      expect(fee).toBeGreaterThanOrEqual(0);
      expect(fee).toBeLessThan(0.1);
    }
  });
});

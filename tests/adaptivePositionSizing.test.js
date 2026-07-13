import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeSize,
  getPositionSizeForOpportunity,
  recordSize,
  getSummary,
  reset,
  MIN_SIZE,
  MAX_SIZE,
} from '../server/domain/risk/adaptivePositionSizing.js';

function baseParams(overrides = {}) {
  return {
    score: 80,
    spreadPct: 1,
    breakEvenPct: 0.5, // spread is exactly 2x break-even → spreadFactor 1.3
    spreadMomentum: null,
    sessionPnl: 0,
    defaultAmount: 0.05,
    ...overrides,
  };
}

describe('adaptivePositionSizing', () => {
  describe('computeSize — score factor boundaries', () => {
    const cases = [
      [40, 0.5], [59, 0.5],
      [60, 0.8], [74, 0.8],
      [75, 1.0], [84, 1.0],
      [85, 1.3], [94, 1.3],
      [95, 1.5], [130, 1.5],
    ];
    it.each(cases)('score=%i → scoreFactor=%f', (score, expected) => {
      const { factors } = computeSize(baseParams({ score, spreadMomentum: null, breakEvenPct: 0 }));
      expect(factors.scoreFactor).toBe(expected);
    });
  });

  describe('computeSize — momentum factor', () => {
    it('defaults to 1.0x with an honest reasoning message when there is no momentum data', () => {
      const { factors, reasoning } = computeSize(baseParams({ spreadMomentum: null }));
      expect(factors.momentumFactor).toBe(1.0);
      expect(reasoning.some(r => r.includes('sin momentum'))).toBe(true);
    });

    it('applies +20% for opening trend with confidence > 50', () => {
      const { factors, reasoning } = computeSize(baseParams({
        spreadMomentum: { trend: 'opening', confidence: 51, velocityPctPerSec: 0.02 },
      }));
      expect(factors.momentumFactor).toBe(1.2);
      expect(reasoning.some(r => r.includes('opening'))).toBe(true);
    });

    it('does NOT apply the opening boost at exactly confidence=50 (strict >)', () => {
      const { factors } = computeSize(baseParams({
        spreadMomentum: { trend: 'opening', confidence: 50, velocityPctPerSec: 0.02 },
      }));
      expect(factors.momentumFactor).toBe(1.0);
    });

    it('labels low-confidence opening honestly, not as "stable" (regression for the mislabeling bug)', () => {
      const { factors, reasoning } = computeSize(baseParams({
        spreadMomentum: { trend: 'opening', confidence: 20, velocityPctPerSec: 0.01 },
      }));
      expect(factors.momentumFactor).toBe(1.0);
      const text = reasoning.join(' | ');
      expect(text).toContain('opening');
      expect(text).not.toContain('momentum stable');
    });

    it('applies -30% for closing trend regardless of confidence', () => {
      const { factors, reasoning } = computeSize(baseParams({
        spreadMomentum: { trend: 'closing', confidence: 10, velocityPctPerSec: -0.015 },
      }));
      expect(factors.momentumFactor).toBe(0.7);
      expect(reasoning.some(r => r.includes('closing'))).toBe(true);
    });

    it('labels stable trend as stable, unaffected by confidence', () => {
      const { factors, reasoning } = computeSize(baseParams({
        spreadMomentum: { trend: 'stable', confidence: 5, velocityPctPerSec: 0.0001 },
      }));
      expect(factors.momentumFactor).toBe(1.0);
      expect(reasoning.some(r => r.includes('momentum stable'))).toBe(true);
    });

    it('handles an unexpected/unknown trend value defensively (no crash, honest label)', () => {
      const { factors, reasoning } = computeSize(baseParams({
        spreadMomentum: { trend: 'sideways', confidence: 30 },
      }));
      expect(factors.momentumFactor).toBe(1.0);
      expect(reasoning.some(r => r.includes('sideways'))).toBe(true);
    });
  });

  describe('computeSize — spread quality factor', () => {
    it('applies no adjustment (spreadFactor stays 1.0) when breakEvenPct is 0', () => {
      const { factors } = computeSize(baseParams({ breakEvenPct: 0, spreadPct: 5 }));
      expect(factors.spreadFactor).toBe(1.0);
    });

    it('applies -20% when spread is below 1.2x break-even', () => {
      const { factors } = computeSize(baseParams({ breakEvenPct: 1, spreadPct: 1.1 }));
      expect(factors.spreadFactor).toBe(0.8);
    });

    it('applies baseline at exactly 1.2x break-even', () => {
      const { factors } = computeSize(baseParams({ breakEvenPct: 1, spreadPct: 1.2 }));
      expect(factors.spreadFactor).toBe(1.0);
    });

    it('applies +10% at exactly 1.5x break-even', () => {
      const { factors } = computeSize(baseParams({ breakEvenPct: 1, spreadPct: 1.5 }));
      expect(factors.spreadFactor).toBe(1.1);
    });

    it('applies +30% at exactly 2.0x break-even and beyond', () => {
      const { factors } = computeSize(baseParams({ breakEvenPct: 1, spreadPct: 2.0 }));
      expect(factors.spreadFactor).toBe(1.3);
      const wide = computeSize(baseParams({ breakEvenPct: 1, spreadPct: 10 }));
      expect(wide.factors.spreadFactor).toBe(1.3);
    });
  });

  describe('computeSize — session P&L (drawdown protection) factor', () => {
    const cases = [
      [100, 1.0], [0, 1.0],
      [-1, 0.9], [-50, 0.9],
      [-50.01, 0.75], [-150, 0.75],
      [-150.01, 0.6], [-1000, 0.6],
    ];
    it.each(cases)('sessionPnl=%f → pnlFactor=%f', (sessionPnl, expected) => {
      const { factors } = computeSize(baseParams({ sessionPnl, spreadMomentum: null, breakEvenPct: 0 }));
      expect(factors.pnlFactor).toBe(expected);
    });

    it('adds a reasoning entry only when P&L is negative, not when it is flat/positive', () => {
      const flat = computeSize(baseParams({ sessionPnl: 0 }));
      expect(flat.reasoning.some(r => r.includes('Session P&L'))).toBe(false);
      const negative = computeSize(baseParams({ sessionPnl: -10 }));
      expect(negative.reasoning.some(r => r.includes('Session P&L'))).toBe(true);
    });
  });

  describe('computeSize — combined sizing, clamping, and rounding', () => {
    it('multiplies all four factors and rounds to the nearest SIZE_STEP (0.005 BTC)', () => {
      const { size, factors } = computeSize(baseParams({
        score: 75, breakEvenPct: 1, spreadPct: 1.2, sessionPnl: 0, spreadMomentum: null, defaultAmount: 0.05,
        // ADR-019 §4 adds a market-regime size multiplier read from a live
        // cache by default; pin it to neutral here so this test verifies
        // the original four factors in isolation, independent of regime
        // detection state (which depends on however much price history
        // has accumulated elsewhere in the suite).
        marketRegimeSizeMultiplier: 1.0,
      }));
      // All factors baseline (1.0) → size should equal defaultAmount exactly
      expect(factors.combined).toBe(1);
      expect(size).toBeCloseTo(0.05, 5);
    });

    it('never returns a size below MIN_SIZE even when every factor is at its floor', () => {
      const { size } = computeSize({
        score: 10, spreadPct: 0.1, breakEvenPct: 1, sessionPnl: -1000,
        spreadMomentum: { trend: 'closing', confidence: 90, velocityPctPerSec: -0.05 },
        defaultAmount: 0.05,
      });
      expect(size).toBeGreaterThanOrEqual(MIN_SIZE);
    });

    it('never returns a size above MAX_SIZE even when every factor is at its ceiling', () => {
      const { size } = computeSize({
        score: 99, spreadPct: 10, breakEvenPct: 1, sessionPnl: 100,
        spreadMomentum: { trend: 'opening', confidence: 99, velocityPctPerSec: 0.05 },
        defaultAmount: 0.1,
      });
      expect(size).toBeLessThanOrEqual(MAX_SIZE);
    });

    it('defaults defaultAmount to 0.05 BTC when not supplied', () => {
      const { factors } = computeSize({ score: 75, spreadPct: 0, breakEvenPct: 0, sessionPnl: 0 });
      expect(factors.base).toBe(0.05);
    });

    it('rounds the final size to a SIZE_STEP (0.005) multiple', () => {
      const { size } = computeSize(baseParams({ score: 85, breakEvenPct: 1, spreadPct: 1.6, sessionPnl: -60, spreadMomentum: null }));
      const stepsFromZero = size / 0.005;
      expect(Math.abs(stepsFromZero - Math.round(stepsFromZero))).toBeLessThan(1e-9);
    });
  });

  describe('getPositionSizeForOpportunity', () => {
    it('returns the input unchanged (not a crash) when opp is null/undefined', () => {
      expect(getPositionSizeForOpportunity(null)).toBeNull();
      expect(getPositionSizeForOpportunity(undefined)).toBeUndefined();
    });

    it('enriches the opportunity with positionSizing without mutating the original object', () => {
      const opp = Object.freeze({ score: 80, spreadPct: 1, breakEvenPct: 0.5 });
      const result = getPositionSizeForOpportunity(opp, 0, 0.05);
      expect(result.positionSizing).toBeDefined();
      expect(result.score).toBe(80);
    });

    it('falls back to sane defaults for missing score/spreadPct/breakEvenPct fields', () => {
      const result = getPositionSizeForOpportunity({}, 0, 0.05);
      // opp.score defaults to 50 inside getPositionSizeForOpportunity, which
      // falls in the <60 bucket → scoreFactor 0.5.
      expect(result.positionSizing.factors.scoreFactor).toBe(0.5);
    });

    it('passes through opp.spreadMomentum when present', () => {
      const opp = { score: 80, spreadPct: 1, breakEvenPct: 0.5, spreadMomentum: { trend: 'closing', confidence: 80, velocityPctPerSec: -0.01 } };
      const result = getPositionSizeForOpportunity(opp, 0, 0.05);
      expect(result.positionSizing.factors.momentumFactor).toBe(0.7);
    });
  });

  describe('recordSize / getSummary / reset', () => {
    beforeEach(() => reset());

    it('returns nulls and count 0 with no recorded sizes', () => {
      expect(getSummary()).toEqual({ avgSize: null, minSize: null, maxSize: null, count: 0 });
    });

    it('aggregates avg/min/max across recorded sizes', () => {
      recordSize(0.05, 80);
      recordSize(0.1, 90);
      recordSize(0.02, 40);
      const summary = getSummary();
      expect(summary.count).toBe(3);
      expect(summary.minSize).toBe(0.02);
      expect(summary.maxSize).toBe(0.1);
      expect(summary.avgSize).toBeCloseTo((0.05 + 0.1 + 0.02) / 3, 4);
      expect(summary.recent).toHaveLength(3);
    });

    it('caps history at 200 entries (rolling buffer, oldest evicted first)', () => {
      for (let i = 0; i < 205; i++) recordSize(0.05, 80);
      const summary = getSummary();
      expect(summary.count).toBe(200);
    });

    it('reset() clears the history back to empty', () => {
      recordSize(0.05, 80);
      reset();
      expect(getSummary().count).toBe(0);
    });
  });
});

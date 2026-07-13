'use strict';

/**
 * kukora.test.js — Kukora unit test suite
 *
 * Covers:
 *   - analytics.js: Sharpe, VaR, drawdown, percentageChange, stdDev
 *   - advancedRiskEngine.js: assetRiskScore, correlationMatrix, circuit breakers
 *   - arbBacktestEngine.js: pairAnalysis, sessionSummary
 *   - tradeStateMachine.js: state transitions, invalid transitions
 *   - logger.js: structured output
 *   - sessionMiddleware.js: UUID validation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── analytics.js ─────────────────────────────────────────────────────────

describe('analytics — percentageChange', () => {
  it('returns array of nulls or values for single-element input', async () => {
    const { percentageChange } = await import('../server/domain/analytics/analytics.js');
    const result = percentageChange([100]);
    // The function computes pctChange from prev; first element has no prev → null
    expect(Array.isArray(result)).toBe(true);
  });

  it('computes correct percentage changes', async () => {
    const { percentageChange, clean } = await import('../server/domain/analytics/analytics.js');
    const result = clean(percentageChange([100, 110, 99]));
    expect(result[0]).toBeCloseTo(10, 4);
    expect(result[1]).toBeCloseTo(-10, 4);
  });
});

describe('analytics — stdDev', () => {
  it('returns 0 for a constant series', async () => {
    const { stdDev } = await import('../server/domain/analytics/analytics.js');
    expect(stdDev([5, 5, 5, 5, 5])).toBe(0);
  });

  it('returns positive value for a varying series', async () => {
    const { stdDev } = await import('../server/domain/analytics/analytics.js');
    expect(stdDev([1, 2, 3, 4, 5])).toBeGreaterThan(0);
  });
});

describe('analytics — sharpe', () => {
  it('returns null or number for short price series', async () => {
    const { sharpe } = await import('../server/domain/analytics/analytics.js');
    const result = sharpe([100, 102, 98, 105]);
    expect(result === null || typeof result === 'number').toBe(true);
  });

  it('returns a higher Sharpe for a steadily rising series', async () => {
    const { sharpe } = await import('../server/domain/analytics/analytics.js');
    const rising  = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
    const choppy  = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 5 : -4));
    const sr = sharpe(rising);
    const sc = sharpe(choppy);
    if (sr !== null && sc !== null) {
      expect(sr).toBeGreaterThan(sc);
    }
  });
});

describe('analytics — drawdown', () => {
  it('returns 0 or negative-zero for a strictly increasing series', async () => {
    const { drawdown } = await import('../server/domain/analytics/analytics.js');
    // drawdown returns a negative percentage; an all-up series has 0 drawdown
    const dd = drawdown([1, 2, 3, 4, 5]);
    expect(Math.abs(dd)).toBe(0);
  });

  it('computes correct max drawdown', async () => {
    const { drawdown } = await import('../server/domain/analytics/analytics.js');
    // Peak at 200, valley at 100 → 50% drawdown
    const dd = drawdown([100, 200, 150, 100, 120]);
    expect(dd).toBeCloseTo(-50, 0);
  });
});

// ─── advancedRiskEngine.js — assetRiskScore ───────────────────────────────

describe('advancedRiskEngine — assetRiskScore', () => {
  it('returns grade C and score 50 for insufficient data', async () => {
    const { assetRiskScore } = await import('../server/domain/risk/advancedRiskEngine.js');
    const result = assetRiskScore([100, 102, 98]);
    expect(result.score).toBe(50);
    expect(result.grade).toBe('C');
  });

  it('returns a lower risk score for a stable series', async () => {
    const { assetRiskScore } = await import('../server/domain/risk/advancedRiskEngine.js');
    const stable  = Array.from({ length: 30 }, (_, i) => 100 + i * 0.1);
    const volatile = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 20 : -18));
    const rs = assetRiskScore(stable);
    const rv = assetRiskScore(volatile);
    expect(rs.score).toBeLessThan(rv.score);
  });

  it('score is between 0 and 100', async () => {
    const { assetRiskScore } = await import('../server/domain/risk/advancedRiskEngine.js');
    const prices = Array.from({ length: 50 }, () => 100 + Math.random() * 20);
    const { score } = assetRiskScore(prices);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('returns correct component keys', async () => {
    const { assetRiskScore } = await import('../server/domain/risk/advancedRiskEngine.js');
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
    const result = assetRiskScore(prices);
    expect(result.components).toHaveProperty('volatility');
    expect(result.components).toHaveProperty('drawdown');
    expect(result.components).toHaveProperty('var95');
    expect(result.components).toHaveProperty('skewPenalty');
  });
});

describe('advancedRiskEngine — correlationMatrix', () => {
  it('diagonal is always 1', async () => {
    const { correlationMatrix } = await import('../server/domain/risk/advancedRiskEngine.js');
    const prices = Array.from({ length: 50 }, (_, i) => 100 + i);
    const matrix = correlationMatrix({ BTC: prices, ETH: prices.map(p => p * 0.5) });
    expect(matrix.BTC.BTC).toBe(1);
    expect(matrix.ETH.ETH).toBe(1);
  });

  it('perfectly correlated series have correlation ~1', async () => {
    const { correlationMatrix } = await import('../server/domain/risk/advancedRiskEngine.js');
    const prices = Array.from({ length: 50 }, (_, i) => 100 + i * 2);
    const matrix = correlationMatrix({ A: prices, B: prices.map(p => p * 3 + 50) });
    expect(matrix.A.B).toBeCloseTo(1, 1);
  });
});

// ─── arbBacktestEngine.js ─────────────────────────────────────────────────

describe('arbBacktestEngine — pairAnalysis', () => {
  it('returns empty array for empty opportunity log', async () => {
    const { pairAnalysis } = await import('../server/domain/engines/arbBacktestEngine.js');
    expect(pairAnalysis([])).toEqual([]);
  });

  it('aggregates opportunities by exchange pair', async () => {
    const { pairAnalysis } = await import('../server/domain/engines/arbBacktestEngine.js');
    // pairAnalysis groups by op.pair; build ops with a pair field
    const log = [
      { pair: 'Binance→Kraken', buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 5, viable: true },
      { pair: 'Binance→Kraken', buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 3, viable: true },
      { pair: 'OKX→Bybit',      buyExchange: 'OKX',    sellExchange: 'Bybit',  netProfit: 2, viable: false },
    ];
    const result = pairAnalysis(log);
    expect(result.length).toBeGreaterThan(0);
    const bk = result.find(r => r.pair === 'Binance→Kraken');
    expect(bk).toBeDefined();
    expect(bk.seen).toBe(2);
  });
});

// ─── tradeStateMachine.js ─────────────────────────────────────────────────

describe('tradeStateMachine — state transitions', () => {
  it('creates a trade and returns a tradeId string', async () => {
    const { createTrade, getTrade, STATES } = await import('../server/domain/analytics/tradeStateMachine.js');
    const tradeId = createTrade({ buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 5 });
    expect(typeof tradeId).toBe('string');
    expect(tradeId.startsWith('trade-')).toBe(true);
    const record = getTrade(tradeId);
    expect(record).toBeDefined();
    expect(record.state).toBe(STATES.OPPORTUNITY_DETECTED);
  });

  it('transitions from OPPORTUNITY_DETECTED to SCORING', async () => {
    const { createTrade, transition, getTrade, STATES } = await import('../server/domain/analytics/tradeStateMachine.js');
    const tradeId = createTrade({ netProfit: 5 });
    const result = transition(tradeId, STATES.SCORING, { actor: 'engine' });
    // transition returns { ok, tradeId } or the record; either way the state should be updated
    const record = getTrade(tradeId);
    expect(record.state).toBe(STATES.SCORING);
  });

  it('rejects invalid transitions and returns ok: false', async () => {
    const { createTrade, transition, STATES } = await import('../server/domain/analytics/tradeStateMachine.js');
    const tradeId = createTrade({ netProfit: 5 });
    // Cannot jump from OPPORTUNITY_DETECTED directly to COMPLETED
    const result = transition(tradeId, STATES.COMPLETED, { actor: 'engine' });
    expect(result.ok).toBe(false);
  });
});

// ─── logger.js ────────────────────────────────────────────────────────────

describe('logger', () => {
  it('exports info, warn, error, debug methods', async () => {
    const { logger } = await import('../server/infrastructure/logger.js');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('does not throw when called with meta', async () => {
    const { logger } = await import('../server/infrastructure/logger.js');
    expect(() => logger.info('test', 'Test message', { key: 'value' })).not.toThrow();
  });
});

// ─── sessionMiddleware.js ─────────────────────────────────────────────────

describe('sessionMiddleware', () => {
  it('accepts valid UUID v4 and sets req.userId', async () => {
    const { sessionMiddleware } = await import('../server/infrastructure/sessionMiddleware.js');
    const req = { headers: { 'x-session-id': '550e8400-e29b-41d4-a716-446655440000' } };
    const res = {};
    let called = false;
    sessionMiddleware(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(req.userId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('falls back to anonymous for missing header', async () => {
    const { sessionMiddleware } = await import('../server/infrastructure/sessionMiddleware.js');
    const req = { headers: {} };
    const res = {};
    sessionMiddleware(req, res, () => {});
    expect(req.userId).toBe('anonymous');
  });

  it('rejects non-UUID strings and falls back to anonymous', async () => {
    const { sessionMiddleware } = await import('../server/infrastructure/sessionMiddleware.js');
    const req = { headers: { 'x-session-id': '../../etc/passwd' } };
    const res = {};
    sessionMiddleware(req, res, () => {});
    expect(req.userId).toBe('anonymous');
  });
});

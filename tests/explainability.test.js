'use strict';

/**
 * explainability.test.js — item 6 (refinamiento post-checkpoint-03).
 * Verifica que buildExplainability agrega, sin recalcular ni mutar
 * estado compartido, y que nunca lanza aunque falten campos.
 */

import { describe, it, expect } from 'vitest';

const { buildExplainability, attachExplainability } = require('../server/domain/analytics/explainability');

function makeOp(overrides = {}) {
  return {
    buyExchange: 'Binance', sellExchange: 'Kraken',
    buyPrice: 50000, sellPrice: 50100,
    score: 72,
    scoreBreakdown: { components: { profit: { value: 20, max: 35, label: 'Profit neto' } }, finalScore: 72 },
    fillProbability: 88,
    fillProbabilityBreakdown: { depthScore: 90, spreadScore: 80 },
    buyFee: 1.2, sellFee: 1.1, totalFees: 2.3, withdrawalFeeUSD: 0.5,
    slippagePct: 0.02, slippageMethod: 'real',
    liquidityPrediction: { buy: { expectedFillPct: 95 }, sell: { expectedFillPct: 90 } },
    ...overrides,
  };
}

describe('explainability', () => {
  it('aggregates score, fillProbability, fees, slippage and liquidity without recomputing them', () => {
    const op = makeOp();
    const explain = buildExplainability(op);

    expect(explain.score.value).toBe(72);
    expect(explain.score.breakdown).toBe(op.scoreBreakdown); // same reference — no recompute
    expect(explain.fillProbability.value).toBe(88);
    expect(explain.fillProbability.breakdown).toBe(op.fillProbabilityBreakdown);
    expect(explain.fees).toEqual({ buyFeeUSD: 1.2, sellFeeUSD: 1.1, totalFeesUSD: 2.3, withdrawalFeeUSD: 0.5 });
    expect(explain.slippage).toEqual({ pct: 0.02, method: 'real' });
    expect(explain.liquidity).toBe(op.liquidityPrediction);
  });

  it('includes a read-only risk snapshot without throwing', () => {
    const explain = buildExplainability(makeOp());
    expect(explain.risk).not.toBeNull();
    expect(explain.risk).toHaveProperty('circuitBreaker');
    expect(explain.risk).toHaveProperty('drawdown');
  });

  it('includes market volatility context without throwing', () => {
    const explain = buildExplainability(makeOp());
    expect(explain.marketContext).not.toBeNull();
    expect(explain.marketContext).toHaveProperty('score');
    expect(explain.marketContext).toHaveProperty('status');
  });

  it('includes the execution policy that would be used for each leg', () => {
    const explain = buildExplainability(makeOp());
    expect(explain.executionPolicy).not.toBeNull();
    expect(explain.executionPolicy.buy).toHaveProperty('type');
    expect(explain.executionPolicy.sell).toHaveProperty('type');
  });

  it('degrades gracefully to null sections when fields are missing, never throws', () => {
    expect(() => buildExplainability({})).not.toThrow();
    const explain = buildExplainability({});
    expect(explain.score.value).toBeNull();
    expect(explain.score.breakdown).toBeNull();
    expect(explain.fillProbability.value).toBeNull();
    expect(explain.liquidity).toBeNull();
  });

  it('attachExplainability sets op.explain on every opportunity in the array', () => {
    const ops = [makeOp(), makeOp({ buyExchange: 'OKX' })];
    const result = attachExplainability(ops);
    expect(result).toHaveLength(2);
    expect(result[0].explain).toBeDefined();
    expect(result[1].explain).toBeDefined();
  });
});

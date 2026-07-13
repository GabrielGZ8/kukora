'use strict';

/**
 * advancedRiskEngineContract.test.js — dedicated tests for the `TradeLike`/
 * `OpportunityLike` type guards added to advancedRiskEngine.ts (audit
 * pendiente #1: "tipos de dominio compartidos entre motores satélite").
 *
 * These are deliberately NOT the canonical Trade/Opportunity from
 * domain/opportunity.ts — see the header comments on isTradeLike()/
 * isOpportunityLike() in advancedRiskEngine.ts for why a reduced,
 * intentionally-loose contract is the correct one here (real callers pass
 * genuinely partial synthetic objects, e.g. liveExecution.js's
 * `{ buyPrice, tradeAmount, slippagePct }`). The guards only check "is this
 * a plain object at all", since every field on both interfaces is optional.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const riskEngine = require('../server/domain/risk/advancedRiskEngine');
const liveConfig = require('../server/infrastructure/liveConfig.js');
const observability = require('../server/infrastructure/observabilityService');

function freshState(equity = 100000) {
  liveConfig.reset('test');
  riskEngine.resetCircuitBreaker('test_setup');
  riskEngine.init(equity);
}

describe('advancedRiskEngine — isTradeLike / isOpportunityLike guards', () => {
  it('isTradeLike accepts plain objects (including empty ones)', () => {
    expect(riskEngine.isTradeLike({})).toBe(true);
    expect(riskEngine.isTradeLike({ type: 'cross_exchange', netProfit: 12.5 })).toBe(true);
  });

  it('isTradeLike rejects non-objects, null, and arrays', () => {
    expect(riskEngine.isTradeLike(null)).toBe(false);
    expect(riskEngine.isTradeLike(undefined)).toBe(false);
    expect(riskEngine.isTradeLike('trade')).toBe(false);
    expect(riskEngine.isTradeLike(42)).toBe(false);
    expect(riskEngine.isTradeLike([1, 2, 3])).toBe(false);
  });

  it('isOpportunityLike accepts plain objects, including partial synthetic ones', () => {
    expect(riskEngine.isOpportunityLike({})).toBe(true);
    expect(riskEngine.isOpportunityLike({ buyPrice: 50000, tradeAmount: 0.01, slippagePct: 0.01 })).toBe(true);
    // The exact reduced shape liveExecution.js builds — legitimate, not an error.
    expect(riskEngine.isOpportunityLike({ buyPrice: 50000, tradeAmount: 0.02, slippagePct: 0 })).toBe(true);
  });

  it('isOpportunityLike rejects non-objects, null, and arrays', () => {
    expect(riskEngine.isOpportunityLike(null)).toBe(false);
    expect(riskEngine.isOpportunityLike(undefined)).toBe(false);
    expect(riskEngine.isOpportunityLike('opportunity')).toBe(false);
    expect(riskEngine.isOpportunityLike([])).toBe(false);
  });
});

describe('advancedRiskEngine — contract wiring (non-blocking RISK emit)', () => {
  beforeEach(() => {
    freshState(100000);
    vi.restoreAllMocks();
  });

  it('preTradeRiskCheck does not emit contract.risk_opportunity_shape_invalid for a well-formed opportunity', () => {
    const emitSpy = vi.spyOn(observability, 'emit');
    const opp = { buyPrice: 50000, tradeAmount: 0.01, slippagePct: 0.01 };
    const result = riskEngine.preTradeRiskCheck(opp, {}, 100000, 0);
    expect(result.ok).toBe(true);
    expect(emitSpy).not.toHaveBeenCalledWith(
      'RISK', 'contract.risk_opportunity_shape_invalid', expect.anything()
    );
  });

  it('preTradeRiskCheck does not blow up and result stays usable even with a malformed opportunity (non-blocking)', () => {
    const emitSpy = vi.spyOn(observability, 'emit');
    // A string instead of an object — structurally wrong, but the function
    // must not throw; it should still return a well-formed result object
    // (falling back on undefined property reads) and flag the shape issue.
    const result = riskEngine.preTradeRiskCheck('not-an-opportunity', {}, 100000, 0);
    expect(typeof result).toBe('object');
    expect(result).toHaveProperty('ok');
    expect(result).toHaveProperty('checks');
    expect(emitSpy).toHaveBeenCalledWith(
      'RISK', 'contract.risk_opportunity_shape_invalid', { receivedType: 'string' }
    );
  });

  it('checkExposureLimits (trade=null path) never emits contract.trade_like_shape_invalid — null is legitimate', () => {
    const emitSpy = vi.spyOn(observability, 'emit');
    riskEngine.checkExposureLimits({ USDT: {}, BTC: {} }, 50000, 100000);
    expect(emitSpy).not.toHaveBeenCalledWith(
      'RISK', 'contract.trade_like_shape_invalid', expect.anything()
    );
  });
});

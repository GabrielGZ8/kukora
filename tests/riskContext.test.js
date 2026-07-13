'use strict';

/**
 * tests/riskContext.test.js — server/domain/risk/riskContext.js
 * (audit committee, sección 12, punto 1 — tercer tipo de dominio
 * compartido, junto a Opportunity/Trade en tests/opportunity.test.js).
 *
 * Verifica:
 *   1. isRiskContext()/createRiskContext() como contrato runtime standalone.
 *   2. fromAdvancedRiskStatus() adapta correctamente la forma real que
 *      produce advancedRiskEngine.getStatus() (el motor global existente,
 *      sin tocar su lógica) al RiskContext canónico.
 */

import { describe, it, expect, beforeEach } from 'vitest';

const { isRiskContext, createRiskContext, fromAdvancedRiskStatus } = require('../server/domain/risk/riskContext.js');
const advRisk = require('../server/domain/risk/advancedRiskEngine.js');

describe('riskContext.js — isRiskContext (type guard)', () => {
  it('accepts a minimal well-formed global risk context', () => {
    expect(isRiskContext({
      uid: null, source: 'global', circuitBreakerActive: false,
      circuitBreakerReason: null, drawdownPct: null, maxDrawdownPct: 15,
      sessionPnl: 0, dailyLossLimitUSD: null, maxPositionValueUSD: null,
      consecutiveLosses: 0, ts: new Date().toISOString(),
    })).toBe(true);
  });

  it('accepts a tenant-scoped risk context (uid set, source "tenant")', () => {
    expect(isRiskContext({
      uid: 'user-123', source: 'tenant', circuitBreakerActive: true,
      circuitBreakerReason: 'Drawdown exceeded', drawdownPct: 12.5,
      maxDrawdownPct: 10, sessionPnl: -50, dailyLossLimitUSD: -100,
      maxPositionValueUSD: 5000, consecutiveLosses: 3, ts: new Date().toISOString(),
    })).toBe(true);
  });

  it('rejects null, undefined, and non-object values', () => {
    expect(isRiskContext(null)).toBe(false);
    expect(isRiskContext(undefined)).toBe(false);
    expect(isRiskContext('risk')).toBe(false);
  });

  it('rejects an invalid "source" value', () => {
    expect(isRiskContext({
      uid: null, source: 'bot', circuitBreakerActive: false,
      sessionPnl: 0, consecutiveLosses: 0, ts: new Date().toISOString(),
    })).toBe(false);
  });

  it('rejects an object missing a required field', () => {
    expect(isRiskContext({
      uid: null, source: 'global', circuitBreakerActive: false,
      sessionPnl: 0, ts: new Date().toISOString(),
      // consecutiveLosses omitted
    })).toBe(false);
  });
});

describe('riskContext.js — createRiskContext (canonical constructor)', () => {
  it('defaults consecutiveLosses to 0 and fills ts when omitted', () => {
    const ctx = createRiskContext({
      uid: null, source: 'global', circuitBreakerActive: false,
      circuitBreakerReason: null, drawdownPct: null, maxDrawdownPct: 15,
      sessionPnl: 0, dailyLossLimitUSD: null, maxPositionValueUSD: null,
    });
    expect(ctx.consecutiveLosses).toBe(0);
    expect(ctx.ts).toEqual(expect.any(String));
    expect(isRiskContext(ctx)).toBe(true);
  });

  it('respects explicit overrides instead of defaulting', () => {
    const ctx = createRiskContext({
      uid: 'user-1', source: 'tenant', circuitBreakerActive: true,
      circuitBreakerReason: 'boom', drawdownPct: 5, maxDrawdownPct: 10,
      sessionPnl: -10, dailyLossLimitUSD: -20, maxPositionValueUSD: 100,
      consecutiveLosses: 4, ts: '2026-01-01T00:00:00.000Z',
    });
    expect(ctx.consecutiveLosses).toBe(4);
    expect(ctx.ts).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('riskContext.js — fromAdvancedRiskStatus (adapter over the real global engine)', () => {
  beforeEach(() => {
    // advancedRiskEngine keeps module-level singleton state; reset the
    // circuit breaker between tests so this test doesn't depend on
    // ordering vs. other suites that may have tripped it.
    if (advRisk.resetCircuitBreaker) {
      try { advRisk.resetCircuitBreaker('test-reset'); } catch { /* not tripped */ }
    }
  });

  it('adapts a real advRisk.getStatus() call into a valid RiskContext', () => {
    const status = advRisk.getStatus(100_000, 0);
    const ctx = fromAdvancedRiskStatus(status);

    expect(isRiskContext(ctx)).toBe(true);
    expect(ctx.uid).toBeNull();
    expect(ctx.source).toBe('global');
    expect(ctx.circuitBreakerActive).toBe(status.circuitBreaker.active);
    expect(ctx.circuitBreakerReason).toBe(status.circuitBreaker.reason);
    expect(ctx.sessionPnl).toBe(status.sessionPnl);
    expect(ctx.consecutiveLosses).toBe(status.consecutiveFailures);
  });
});

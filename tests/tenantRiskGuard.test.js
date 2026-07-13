'use strict';

/**
 * tenantRiskGuard.test.js — ADR-017, pendiente #3 (risk engine per-tenant).
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';

const { resetBalances, applyTrade, EXCHANGES } = require('../server/domain/wallet/walletManager');
const tenantConfig = require('../server/infrastructure/tenantConfig');
const tenantRiskGuard = require('../server/infrastructure/tenantRiskGuard');

const [EX_A, EX_B] = EXCHANGES;

function baseTrade(overrides = {}) {
  return {
    id: 'trade-1',
    buyExchange: EX_A,
    sellExchange: EX_B,
    buyPrice: 50000,
    sellPrice: 50100,
    amount: 0.01,
    buyFee: 1,
    sellFee: 1,
    grossProfit: 1,
    netProfit: 0.5,
    spreadPct: '0.2',
    slippage: 0,
    executionMs: 50,
    slippageMethod: 'real',
    ts: Date.now(),
    ...overrides,
  };
}

describe('tenantRiskGuard', () => {
  const UID_A = 'trg-uid-a';
  const UID_B = 'trg-uid-b';

  beforeEach(() => {
    resetBalances(UID_A);
    resetBalances(UID_B);
  });

  afterEach(() => {
    tenantConfig.resetAll(UID_A);
    tenantConfig.resetAll(UID_B);
    tenantRiskGuard.resetBreaker(UID_A);
    tenantRiskGuard.resetBreaker(UID_B);
  });

  it('allows a trade with no history and a reasonable position size', () => {
    const result = tenantRiskGuard.checkPreTrade(UID_A, 500);
    expect(result.ok).toBe(true);
  });

  it('rejects a trade whose position size exceeds maxPositionValueUSD', () => {
    tenantConfig.setMany(UID_A, { maxPositionValueUSD: 1000 });
    const result = tenantRiskGuard.checkPreTrade(UID_A, 5000);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exceeds maximum/);
    // Position-size rejection alone does not trip the breaker.
    expect(tenantRiskGuard.isTripped(UID_A)).toBe(false);
  });

  it('trips the breaker once drawdown exceeds maxDrawdownPct, and blocks further trades', async () => {
    tenantConfig.setMany(UID_A, { maxDrawdownPct: 5 });
    // Build a drawdown: one big win, then a loss that drags the cumulative
    // curve down more than 5% from its peak.
    await applyTrade(baseTrade({ id: 't1', netProfit: 100 }), UID_A);
    await applyTrade(baseTrade({ id: 't2', netProfit: -10 }), UID_A);

    const result = tenantRiskGuard.checkPreTrade(UID_A, 100);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Drawdown/);
    expect(tenantRiskGuard.isTripped(UID_A)).toBe(true);

    // Once tripped, even a tiny/safe trade is blocked until reset.
    const again = tenantRiskGuard.checkPreTrade(UID_A, 1);
    expect(again.ok).toBe(false);
  });

  it('trips the breaker after MAX_CONSECUTIVE_LOSSES losing trades in a row', async () => {
    for (let i = 0; i < tenantRiskGuard.MAX_CONSECUTIVE_LOSSES; i++) {
      await applyTrade(baseTrade({ id: `loss-${i}`, netProfit: -1 }), UID_A);
    }
    const result = tenantRiskGuard.checkPreTrade(UID_A, 10);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/consecutive losses/);
  });

  it('resetBreaker clears an active breaker and allows trading again', async () => {
    tenantConfig.setMany(UID_A, { maxDrawdownPct: 5 });
    await applyTrade(baseTrade({ id: 't1', netProfit: 100 }), UID_A);
    await applyTrade(baseTrade({ id: 't2', netProfit: -10 }), UID_A);
    expect(tenantRiskGuard.checkPreTrade(UID_A, 1).ok).toBe(false);

    const resetResult = tenantRiskGuard.resetBreaker(UID_A);
    expect(resetResult.ok).toBe(true);
    expect(tenantRiskGuard.isTripped(UID_A)).toBe(false);
  });

  it('resetBreaker on an already-inactive breaker returns ok:false without throwing', () => {
    const result = tenantRiskGuard.resetBreaker(UID_A);
    expect(result.ok).toBe(false);
  });

  it('two tenants are fully isolated: one tripping its breaker never affects the other', async () => {
    tenantConfig.setMany(UID_A, { maxDrawdownPct: 5 });
    await applyTrade(baseTrade({ id: 't1', netProfit: 100 }), UID_A);
    await applyTrade(baseTrade({ id: 't2', netProfit: -10 }), UID_A);
    tenantRiskGuard.checkPreTrade(UID_A, 1); // trips A's breaker

    expect(tenantRiskGuard.isTripped(UID_A)).toBe(true);
    expect(tenantRiskGuard.isTripped(UID_B)).toBe(false);
    expect(tenantRiskGuard.checkPreTrade(UID_B, 100).ok).toBe(true);
  });

  it('tripBreaker called twice does not overwrite the original reason', () => {
    tenantRiskGuard.tripBreaker(UID_A, 'first reason', 'manual');
    const second = tenantRiskGuard.tripBreaker(UID_A, 'second reason', 'manual');
    expect(second.alreadyActive).toBe(true);
    expect(tenantRiskGuard.getStatus(UID_A).reason).toBe('first reason');
  });

  // Regression tests for a due-diligence finding: maxDailyLossUSD was
  // already validated and storable as a tenant override (and surfaced in
  // TenantBotPanel.jsx as an editable control), but checkPreTrade never
  // actually read it — a user could configure a daily stop-loss that had
  // zero effect. See tenantRiskGuard.js header for the fix rationale.
  describe('maxDailyLossUSD enforcement', () => {
    it('trips the breaker once today\'s realized P&L breaches maxDailyLossUSD', async () => {
      tenantConfig.setMany(UID_A, { maxDailyLossUSD: -50 });
      await applyTrade(baseTrade({ id: 'dl-1', netProfit: -30, ts: Date.now() }), UID_A);
      await applyTrade(baseTrade({ id: 'dl-2', netProfit: -25, ts: Date.now() }), UID_A);

      const result = tenantRiskGuard.checkPreTrade(UID_A, 10);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/Daily P&L/);
      expect(tenantRiskGuard.isTripped(UID_A)).toBe(true);
    });

    it('does not trip when losses are within the configured daily limit', async () => {
      tenantConfig.setMany(UID_A, { maxDailyLossUSD: -1000 });
      await applyTrade(baseTrade({ id: 'dl-3', netProfit: -30, ts: Date.now() }), UID_A);

      const result = tenantRiskGuard.checkPreTrade(UID_A, 10);
      expect(result.ok).toBe(true);
    });

    it('ignores trades from before today (stale losses do not count against today\'s limit)', async () => {
      tenantConfig.setMany(UID_A, { maxDailyLossUSD: -50 });
      const yesterday = Date.now() - 25 * 60 * 60 * 1000;
      await applyTrade(baseTrade({ id: 'dl-old', netProfit: -500, ts: yesterday }), UID_A);

      const result = tenantRiskGuard.checkPreTrade(UID_A, 10);
      expect(result.ok).toBe(true);
    });

    it('two tenants are isolated for the daily-loss check too', async () => {
      tenantConfig.setMany(UID_A, { maxDailyLossUSD: -50 });
      tenantConfig.setMany(UID_B, { maxDailyLossUSD: -50 });
      await applyTrade(baseTrade({ id: 'dl-a', netProfit: -100, ts: Date.now() }), UID_A);

      expect(tenantRiskGuard.checkPreTrade(UID_A, 10).ok).toBe(false);
      expect(tenantRiskGuard.checkPreTrade(UID_B, 10).ok).toBe(true);
    });
  });
});

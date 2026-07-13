'use strict';

/**
 * rebalanceContract.test.js — dedicated tests for the shared rebalance
 * types (audit pendiente #1: "tipos de dominio compartidos entre motores
 * satélite" — tercero de los 5 motores nombrados explícitamente cerrado
 * esta ronda: `BalanceAnalysis`/`RebalanceSuggestionResult`/
 * `ExecuteRebalanceResult` in server-types/server/domain/engines/rebalance.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  isBalanceAnalysis,
  isRebalanceSuggestionResult,
  isExecuteRebalanceResult,
} = require('../server/domain/engines/rebalance');

const { resetBalances, getBalances } = require('../server/domain/wallet/walletManager');
const rebalanceEngine = require('../server/domain/engines/rebalanceEngine');
const observability = require('../server/infrastructure/observabilityService');

beforeEach(() => {
  resetBalances();
  vi.restoreAllMocks();
});

describe('rebalance.ts — isBalanceAnalysis', () => {
  it('accepts the real shape produced by analyzeBalance()', () => {
    const analysis = rebalanceEngine.analyzeBalance(50000);
    expect(isBalanceAnalysis(analysis)).toBe(true);
  });

  it('rejects null, non-objects, and shapes missing required fields', () => {
    expect(isBalanceAnalysis(null)).toBe(false);
    expect(isBalanceAnalysis('analysis')).toBe(false);
    expect(isBalanceAnalysis({})).toBe(false);
    expect(isBalanceAnalysis({ imbalances: [], healthy: true })).toBe(false); // missing highCount/summary
  });
});

describe('rebalance.ts — isRebalanceSuggestionResult', () => {
  it('accepts the real shape from suggestRebalance() in both needed:true/false branches', () => {
    const result = rebalanceEngine.suggestRebalance(50000);
    expect(isRebalanceSuggestionResult(result)).toBe(true);
  });

  it('rejects a needed:true result without a suggestions array', () => {
    const analysis = rebalanceEngine.analyzeBalance(50000);
    expect(isRebalanceSuggestionResult({ needed: true, analysis, reason: 'x' })).toBe(false);
  });

  it('rejects null and non-objects', () => {
    expect(isRebalanceSuggestionResult(null)).toBe(false);
    expect(isRebalanceSuggestionResult(42)).toBe(false);
  });
});

describe('rebalance.ts — isExecuteRebalanceResult', () => {
  it('accepts the real ok:false shape (non-viable suggestion)', () => {
    const result = rebalanceEngine.executeRebalance(null, 50000);
    expect(result.ok).toBe(false);
    expect(isExecuteRebalanceResult(result)).toBe(true);
  });

  it('accepts a real ok:true shape from a genuine executed transfer', () => {
    const wallets = getBalances();
    const exchanges = Object.keys(wallets.USDT);
    const [from, to] = exchanges;
    const suggestion = { asset: 'USDT', from, to, amount: 10, fee: 0, viable: true };
    const result = rebalanceEngine.executeRebalance(suggestion, 50000);
    expect(result.ok).toBe(true);
    expect(isExecuteRebalanceResult(result)).toBe(true);
  });

  it('rejects null, non-objects, and shapes with the wrong ok type', () => {
    expect(isExecuteRebalanceResult(null)).toBe(false);
    expect(isExecuteRebalanceResult({ ok: 'true' })).toBe(false);
  });
});

describe('rebalanceEngine — contract wiring (non-blocking RISK/REBALANCE emit)', () => {
  it('analyzeBalance never emits contract.balance_analysis_shape_invalid on real data', () => {
    const emitSpy = vi.spyOn(observability, 'emit');
    rebalanceEngine.analyzeBalance(50000);
    expect(emitSpy).not.toHaveBeenCalledWith(
      'REBALANCE', 'contract.balance_analysis_shape_invalid', expect.anything()
    );
  });

  it('suggestRebalance never emits contract.rebalance_suggestion_result_shape_invalid on real data', () => {
    const emitSpy = vi.spyOn(observability, 'emit');
    rebalanceEngine.suggestRebalance(50000);
    expect(emitSpy).not.toHaveBeenCalledWith(
      'REBALANCE', 'contract.rebalance_suggestion_result_shape_invalid', expect.anything()
    );
  });

  it('executeRebalance never emits contract.execute_rebalance_result_shape_invalid on a real successful transfer', () => {
    const emitSpy = vi.spyOn(observability, 'emit');
    const wallets = getBalances();
    const exchanges = Object.keys(wallets.USDT);
    const [from, to] = exchanges;
    const suggestion = { asset: 'USDT', from, to, amount: 10, fee: 0, viable: true };
    rebalanceEngine.executeRebalance(suggestion, 50000);
    expect(emitSpy).not.toHaveBeenCalledWith(
      'REBALANCE', 'contract.execute_rebalance_result_shape_invalid', expect.anything()
    );
  });
});

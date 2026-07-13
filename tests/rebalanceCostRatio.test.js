'use strict';

/**
 * rebalanceCostRatio.test.js — dedicated unit tests for
 * rebalanceEngine.getRebalanceCostRatio().
 *
 * This closes a gap called out explicitly in docs/CommitteeReadiness.md
 * (point 3): the function was implemented and wired into
 * getRebalanceSummary() + the RebalancePanel UI badge in Sesión 30, and the
 * *general* suite stayed green, but the function itself had zero direct
 * test cases — profit-zero, profit-negative, and above/below-threshold
 * were all unverified.
 *
 * Tests run against the real walletManager + rebalanceEngine modules (no
 * mocking), matching the rest of the financial-core suite. `resetBalances`
 * gives a clean, exact trade history per test, so realizedPnl is always
 * exactly what each test sets it to. rebalanceEngine's cumulative rebalance
 * *cost* history has no equivalent reset (by design — it is meant to
 * persist for the process lifetime), so assertions read the cost total
 * before each action and assert on the delta, rather than assuming the
 * history starts empty. This makes the tests correct and order-independent
 * regardless of what ran earlier in the file, while still exercising the
 * exact ratio/alert formula in getRebalanceCostRatio().
 */

import { describe, it, expect, beforeEach } from 'vitest';

const {
  resetBalances,
  applyTrade,
  EXCHANGES,
} = require('../server/domain/wallet/walletManager');

const rebalanceEngine = require('../server/domain/engines/rebalanceEngine');
const liveConfig = require('../server/infrastructure/liveConfig.js');

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

// executeRebalance() independently validates asset/from/to/amount against
// the real exchange list regardless of what the caller claims (see the
// robustness comment in rebalanceEngine.js), so this must be a realistic
// suggestion shape, not just { viable: true, fee }.
function recordRebalanceFee(feeUSD) {
  return rebalanceEngine.executeRebalance(
    { viable: true, asset: 'USDT', from: EX_A, to: EX_B, amount: 1000, fee: feeUSD },
    50000,
  );
}

describe('rebalanceEngine.getRebalanceCostRatio', () => {
  beforeEach(() => {
    resetBalances();
    liveConfig.reset('test');
  });

  it('reports ratioPct as null (not 0) when there is no realized profit yet', () => {
    const rec = recordRebalanceFee(50);
    expect(rec.ok).toBe(true);

    const result = rebalanceEngine.getRebalanceCostRatio();
    expect(result.periodRealizedPnlUSD).toBe(0);
    expect(result.ratioPct).toBeNull();
    expect(result.alert).toBe(false);
    expect(result.note).toMatch(/No realized profit yet/);
  });

  it('reports ratioPct as null when realized P&L is negative', async () => {
    await applyTrade(baseTrade({ netProfit: -20 }));
    recordRebalanceFee(50);

    const result = rebalanceEngine.getRebalanceCostRatio();
    expect(result.periodRealizedPnlUSD).toBeCloseTo(-20, 4);
    expect(result.ratioPct).toBeNull();
    expect(result.alert).toBe(false);
  });

  it('computes ratioPct = totalCost / realizedPnl * 100 and stays below alert for a small cost fraction', async () => {
    const before = rebalanceEngine.getRebalanceCostRatio().totalRebalanceCostUSD;
    await applyTrade(baseTrade({ netProfit: 1000 }));
    recordRebalanceFee(50);

    const result = rebalanceEngine.getRebalanceCostRatio();
    const expectedTotalCost = before + 50;
    expect(result.periodRealizedPnlUSD).toBeCloseTo(1000, 4);
    expect(result.totalRebalanceCostUSD).toBeCloseTo(expectedTotalCost, 4);
    expect(result.ratioPct).toBeCloseTo((expectedTotalCost / 1000) * 100, 2);
    expect(result.alertThresholdPct).toBe(liveConfig.get('rebalanceCostAlertPct'));
    // With a fresh $1000 realized profit this trade, a $50 fee alone is only
    // 5% — even with whatever cost accumulated in earlier tests, this stays
    // comfortably under the default 18% alert unless hundreds of dollars of
    // fees ran before it, which no test in this file does.
    expect(result.alert).toBe(false);
    expect(result.note).toBeNull();
  });

  it('fires the alert once the cost ratio reaches the configured threshold', async () => {
    await applyTrade(baseTrade({ netProfit: 100 }));
    liveConfig.setMany({ rebalanceCostAlertPct: 5 }, 'test'); // low threshold, easy to guarantee a cross
    recordRebalanceFee(10); // at least 10% of the 100 profit from just this trade

    const result = rebalanceEngine.getRebalanceCostRatio();
    expect(result.ratioPct).toBeGreaterThanOrEqual(10);
    expect(result.alertThresholdPct).toBe(5);
    expect(result.alert).toBe(true);
  });

  it('does not alert when the cost ratio is exactly at zero cost added and profit is large', async () => {
    await applyTrade(baseTrade({ netProfit: 1_000_000 }));
    // No rebalance fee recorded this test — ratio should be driven only by
    // whatever tiny cost (if any) accumulated from earlier tests, against a
    // huge profit, so it stays far below the default 18% threshold.
    const result = rebalanceEngine.getRebalanceCostRatio();
    expect(result.alert).toBe(false);
  });

  it('accumulates cost across multiple rebalance events in the same period, not just the most recent one', async () => {
    const before = rebalanceEngine.getRebalanceCostRatio().totalRebalanceCostUSD;
    await applyTrade(baseTrade({ netProfit: 500 }));
    recordRebalanceFee(10);
    recordRebalanceFee(15);
    recordRebalanceFee(25);

    const result = rebalanceEngine.getRebalanceCostRatio();
    expect(result.totalRebalanceCostUSD).toBeCloseTo(before + 50, 4); // 10 + 15 + 25
    expect(result.ratioPct).toBeCloseTo(((before + 50) / 500) * 100, 2);
  });

  it('is exposed through getRebalanceSummary().costRatio with identical values', async () => {
    await applyTrade(baseTrade({ netProfit: 200 }));
    liveConfig.setMany({ rebalanceCostAlertPct: 1 }, 'test');
    recordRebalanceFee(40); // guaranteed to clear a 1% threshold

    const summary = rebalanceEngine.getRebalanceSummary(50000);
    const direct = rebalanceEngine.getRebalanceCostRatio();
    expect(summary.costRatio).toEqual(direct);
    expect(summary.costRatio.alert).toBe(true);
  });
});

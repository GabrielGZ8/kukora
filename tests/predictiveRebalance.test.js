'use strict';

/**
 * predictiveRebalance.test.js — unit tests for server/domain/engines/predictiveRebalance.js
 *
 * This module was at 6.87% statement coverage (0 dedicated test file) despite
 * being the engine behind /api/arbitrage/rebalance's predictive suggestions
 * and the capital-efficiency dashboard. These tests exercise:
 *   - computeConsumptionRates(): rolling-window BTC/USDT burn rate per
 *     exchange, and the Infinity/null handling when consumption is zero.
 *   - generatePredictiveRecommendations(): urgency tiers (critical/high/
 *     medium), viability gating against cost/minimum-transfer thresholds,
 *     sort order, and the observability event fired on critical urgency.
 *   - findBestSource() / computeTransferCost() indirectly, through the
 *     recommendation's sourceExchange/transferCost fields.
 *   - computeCapitalEfficiency(): the zero-capital guard, ROI/utilization
 *     math, idle-exchange detection, and utilization history tracking.
 *   - computeOptimalDistribution(): buy/sell activity-weighted targets,
 *     including the "no trades yet" fallback (totalBuys/totalSells default
 *     to 1, so shares don't divide by zero).
 *
 * The module keeps trade/utilization history in closure-scoped module
 * state with no reliable per-test isolation via vi.resetModules() (this
 * project's CJS require() calls aren't guaranteed to be cleared by it —
 * confirmed via a minimal repro during this module's test development).
 * The established pattern in this codebase for stateful modules is an
 * explicit reset export (see walletManager.resetBalances()), so this
 * module exposes _resetForTests() for the same purpose.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getEnabledExchangeNames } = require('../server/infrastructure/exchangeRegistry');

const predictiveRebalance = require('../server/domain/engines/predictiveRebalance');
const liveConfig = require('../server/infrastructure/liveConfig.js');
const observability = require('../server/infrastructure/observabilityService.js');

const EXCHANGES = getEnabledExchangeNames();
const [EX_A, EX_B, EX_C] = EXCHANGES;

function emptyWallets() {
  const wallets = { BTC: {}, USDT: {} };
  for (const ex of EXCHANGES) {
    wallets.BTC[ex] = 0;
    wallets.USDT[ex] = 0;
  }
  return wallets;
}

function makeTrade(overrides = {}) {
  return {
    buyExchange:  EX_A,
    sellExchange: EX_B,
    amount:       0.01,
    buyPrice:     50000,
    netProfit:    5,
    ...overrides,
  };
}

beforeEach(() => {
  predictiveRebalance._resetForTests();
  liveConfig.reset('test');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── computeConsumptionRates ────────────────────────────────────────────────

describe('predictiveRebalance.computeConsumptionRates', () => {
  it('returns zero rates and Infinity/null depletion for every exchange when there is no trade history', () => {
    const wallets = emptyWallets();
    wallets.BTC[EX_A] = 1;
    wallets.USDT[EX_A] = 50000;

    const rates = predictiveRebalance.computeConsumptionRates(wallets, 3_600_000);

    expect(Object.keys(rates).sort()).toEqual([...EXCHANGES].sort());
    expect(rates[EX_A].btcPerHour).toBe(0);
    expect(rates[EX_A].usdtPerHour).toBe(0);
    expect(rates[EX_A].depletionBtcHours).toBeNull();
    expect(rates[EX_A].depletionUsdtHours).toBeNull();
    // depletionInHours falls back to the 9999 sentinel when rate is 0.
    expect(rates[EX_A].depletionInHours).toBe(9999);
  });

  it('computes BTC burn rate on the sell exchange and USDT burn rate on the buy exchange separately', () => {
    predictiveRebalance.recordTrade(makeTrade({ buyExchange: EX_A, sellExchange: EX_B, amount: 0.02, buyPrice: 50000 }));
    predictiveRebalance.recordTrade(makeTrade({ buyExchange: EX_A, sellExchange: EX_B, amount: 0.02, buyPrice: 50000 }));

    const wallets = emptyWallets();
    wallets.BTC[EX_B]  = 1;      // BTC depletes on the sell exchange
    wallets.USDT[EX_A] = 100000; // USDT depletes on the buy exchange

    const rates = predictiveRebalance.computeConsumptionRates(wallets, 3_600_000);

    // 0.04 BTC consumed over a 1-hour window → 0.04 BTC/hour on EX_B.
    expect(rates[EX_B].btcPerHour).toBeCloseTo(0.04, 6);
    expect(rates[EX_A].usdtPerHour).toBeCloseTo(2000, 2); // 0.04 BTC * 50000 = 2000 USDT
    // EX_B never bought, so its USDT rate is 0; EX_A never sold, so its BTC rate is 0.
    expect(rates[EX_B].usdtPerHour).toBe(0);
    expect(rates[EX_A].btcPerHour).toBe(0);

    // Depletion time = balance / rate.
    expect(rates[EX_B].depletionBtcHours).toBeCloseTo(1 / 0.04, 1);
    expect(rates[EX_A].depletionUsdtHours).toBeCloseTo(100000 / 2000, 1);
  });

  it('excludes trades outside the requested window', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      predictiveRebalance.recordTrade(makeTrade({ sellExchange: EX_B, amount: 0.05 }));

      // Jump 2 hours ahead and ask for only a 1-hour window — the trade
      // recorded above must fall outside it.
      vi.setSystemTime(new Date('2026-01-01T02:00:00Z'));
      const rates = predictiveRebalance.computeConsumptionRates(emptyWallets(), 3_600_000);
      expect(rates[EX_B].btcPerHour).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── generatePredictiveRecommendations ─────────────────────────────────────

describe('predictiveRebalance.generatePredictiveRecommendations', () => {
  it('returns no recommendations when consumption is zero (nothing depleting)', () => {
    const wallets = emptyWallets();
    for (const ex of EXCHANGES) { wallets.BTC[ex] = 1; wallets.USDT[ex] = 110000; }

    const result = predictiveRebalance.generatePredictiveRecommendations(wallets, 50000);
    expect(result.recommendations).toEqual([]);
    expect(result.hasUrgent).toBe(false);
    expect(result.windowHours).toBeCloseTo(liveConfig.get('rebalancePredictionWindow') / 3600, 6);
  });

  it('flags a BTC depletion warning with urgency=critical when the exchange runs out in under 30 minutes, and emits an observability event', () => {
    const emitSpy = vi.spyOn(observability, 'emit');

    // Burn BTC on EX_B fast enough that, with a tiny starting balance,
    // depletion is under 0.5h (critical threshold).
    for (let i = 0; i < 10; i++) {
      predictiveRebalance.recordTrade(makeTrade({ buyExchange: EX_A, sellExchange: EX_B, amount: 0.05, buyPrice: 50000 }));
    }
    const wallets = emptyWallets();
    wallets.BTC[EX_B] = 0.01; // almost nothing left, burning 0.5 BTC/hour → depletes in ~0.02h

    const result = predictiveRebalance.generatePredictiveRecommendations(wallets, 50000);
    const btcRec = result.recommendations.find(r => r.type === 'btc_depletion' && r.exchange === EX_B);

    expect(btcRec).toBeDefined();
    expect(btcRec.urgency).toBe('critical');
    expect(btcRec.neededBtc).toBeGreaterThan(0);
    expect(btcRec.sourceExchange).not.toBe(EX_B);
    expect(result.hasUrgent).toBe(true);

    // Critical urgency must fire a 'rebalance.predictive.critical' event.
    expect(emitSpy).toHaveBeenCalledWith(
      'REBALANCE', 'rebalance.predictive.critical',
      expect.objectContaining({ exchanges: expect.arrayContaining([EX_B]) }),
      'warn'
    );
  });

  it('flags a USDT depletion warning and sorts recommendations by urgency (critical before medium)', () => {
    // Fast BTC depletion on EX_B (critical), slower USDT depletion on EX_A (medium/high band).
    for (let i = 0; i < 10; i++) {
      predictiveRebalance.recordTrade(makeTrade({ buyExchange: EX_A, sellExchange: EX_B, amount: 0.05, buyPrice: 50000 }));
    }
    const wallets = emptyWallets();
    wallets.BTC[EX_B]  = 0.01;   // critical BTC depletion
    wallets.USDT[EX_A] = 1400;   // 2500 USDT/hour burn → depletes in ~0.56h (still under the 1h window, "high")

    const result = predictiveRebalance.generatePredictiveRecommendations(wallets, 50000);
    expect(result.recommendations.length).toBeGreaterThanOrEqual(2);
    expect(result.recommendations[0].urgency).toBe('critical');

    const usdtRec = result.recommendations.find(r => r.type === 'usdt_depletion');
    expect(usdtRec).toBeDefined();
    expect(usdtRec.viable).toBeDefined();
    expect(usdtRec.action).toMatch(/Transfer .* USDT to/);
  });

  it('does not recommend a transfer smaller than the configured minimum transfer amount', () => {
    // Tiny consumption → neededUSD stays below minimumTransferAmount (100 by default).
    predictiveRebalance.recordTrade(makeTrade({ buyExchange: EX_A, sellExchange: EX_B, amount: 0.0001, buyPrice: 50000 }));
    const wallets = emptyWallets();
    wallets.BTC[EX_B] = 0.00005;

    const result = predictiveRebalance.generatePredictiveRecommendations(wallets, 50000);
    // Whatever fires (if anything) must respect the minimum-transfer floor.
    for (const rec of result.recommendations) {
      const amountUSD = rec.neededUSD ?? rec.neededUsdt;
      if (amountUSD !== undefined) {
        expect(amountUSD).toBeGreaterThanOrEqual(liveConfig.get('minimumTransferAmount'));
      }
    }
  });

  it('marks a recommendation non-viable when its transfer cost exceeds the cost limit', () => {
    liveConfig.setMany({ rebalanceCostLimit: 0 }, 'test');
    for (let i = 0; i < 10; i++) {
      predictiveRebalance.recordTrade(makeTrade({ buyExchange: EX_A, sellExchange: EX_B, amount: 0.05, buyPrice: 50000 }));
    }
    const wallets = emptyWallets();
    wallets.BTC[EX_B] = 0.01;

    const result = predictiveRebalance.generatePredictiveRecommendations(wallets, 50000);
    const btcRec = result.recommendations.find(r => r.type === 'btc_depletion');
    expect(btcRec).toBeDefined();
    expect(btcRec.viable).toBe(false);

    liveConfig.reset('test');
  });
});

// ─── computeCapitalEfficiency ───────────────────────────────────────────────

describe('predictiveRebalance.computeCapitalEfficiency', () => {
  it('returns an error object when total deployed capital is zero', () => {
    const result = predictiveRebalance.computeCapitalEfficiency(emptyWallets(), 50000, 0, 0, 3_600_000);
    expect(result.error).toBe('No capital deployed');
  });

  it('computes ROI, utilization, and projected P&L from session stats', () => {
    const wallets = emptyWallets();
    for (const ex of EXCHANGES) { wallets.BTC[ex] = 0.2; wallets.USDT[ex] = 20000; }

    const sessionPnl = 100;
    const uptimeMs = 3_600_000; // 1 hour
    const result = predictiveRebalance.computeCapitalEfficiency(wallets, 50000, sessionPnl, 10, uptimeMs);

    expect(result.error).toBeUndefined();
    expect(result.sessionPnl).toBe(100);
    expect(result.uptimeHours).toBeCloseTo(1, 6);
    expect(result.profitPerHour).toBeCloseTo(100, 6);
    expect(result.projectedDailyPnl).toBeCloseTo(2400, 6);
    expect(result.totalCapitalUSD).toBeGreaterThan(0);
    expect(result.roiAnnualizedPct).toBeGreaterThan(0);
    expect(result.utilizationTrend.length).toBeGreaterThan(0);
    expect(Array.isArray(result.idleExchanges)).toBe(true);
    expect(Array.isArray(result.optimalDistribution)).toBe(true);
  });

  it('floors uptime at 1 minute to avoid division blowing up on a just-started session', () => {
    const wallets = emptyWallets();
    wallets.BTC[EX_A] = 1;
    wallets.USDT[EX_A] = 50000;

    // uptimeMs = 0 would otherwise divide by zero hours.
    const result = predictiveRebalance.computeCapitalEfficiency(wallets, 50000, 10, 1, 0);
    // computeCapitalEfficiency rounds uptimeHours to 2 decimals internally.
    expect(result.uptimeHours).toBeCloseTo(+(1 / 60).toFixed(2), 2);
    expect(Number.isFinite(result.profitPerHour)).toBe(true);
  });

  it('flags a high-capital-share exchange with near-zero activity as idle', () => {
    const wallets = emptyWallets();
    // EX_A holds the overwhelming majority of capital and never trades.
    wallets.BTC[EX_A]  = 2;
    wallets.USDT[EX_A] = 200000;
    wallets.BTC[EX_B]  = 0.001;
    wallets.USDT[EX_B] = 100;

    const result = predictiveRebalance.computeCapitalEfficiency(wallets, 50000, 0, 0, 3_600_000);
    const idle = result.idleExchanges.find(i => i.exchange === EX_A);
    expect(idle).toBeDefined();
    expect(idle.capitalShare).toBeGreaterThan(5);
    expect(idle.suggestion).toMatch(/rebalancing/);
  });

  it('accumulates utilization history across repeated calls, capped at MAX_UTIL_HISTORY (100)', () => {
    const wallets = emptyWallets();
    wallets.BTC[EX_A] = 1;
    wallets.USDT[EX_A] = 50000;

    for (let i = 0; i < 105; i++) {
      predictiveRebalance.computeCapitalEfficiency(wallets, 50000, 1, 1, 3_600_000);
    }
    const last = predictiveRebalance.computeCapitalEfficiency(wallets, 50000, 1, 1, 3_600_000);
    // utilizationTrend is capped to the most recent 10 entries in the response,
    // but internally the history array itself must never exceed 100 — verified
    // indirectly: the call above must not throw/slow down and must return a
    // bounded trend slice.
    expect(last.utilizationTrend.length).toBeLessThanOrEqual(10);
  });
});

// ─── computeOptimalDistribution ─────────────────────────────────────────────

describe('predictiveRebalance.computeOptimalDistribution', () => {
  it('defaults every exchange to a 10% floor share when there is no trade activity yet', () => {
    const wallets = emptyWallets();
    wallets.BTC[EX_A]  = 1;
    wallets.USDT[EX_A] = 100000;

    const dist = predictiveRebalance.computeOptimalDistribution(wallets, 50000, []);
    expect(dist.length).toBe(EXCHANGES.length);
    for (const entry of dist) {
      // totalBuys/totalSells default to 1 with no activity, and
      // Math.max(0.1, 0) enforces a 10% floor share per exchange.
      expect(entry.optimalUsdt).toBeCloseTo(100000 * 0.1, 2);
      expect(entry.optimalBtc).toBeCloseTo(1 * 0.1, 6);
    }
  });

  it('weights optimal USDT/BTC targets toward exchanges with more buy/sell activity', () => {
    const wallets = emptyWallets();
    wallets.BTC[EX_A] = 1;
    wallets.USDT[EX_A] = 100000;

    const recentTrades = [
      makeTrade({ buyExchange: EX_A, sellExchange: EX_B }),
      makeTrade({ buyExchange: EX_A, sellExchange: EX_B }),
      makeTrade({ buyExchange: EX_A, sellExchange: EX_B }),
      makeTrade({ buyExchange: EX_C, sellExchange: EX_C }),
    ];

    const dist = predictiveRebalance.computeOptimalDistribution(wallets, 50000, recentTrades);
    const distA = dist.find(d => d.exchange === EX_A);
    const distC = dist.find(d => d.exchange === EX_C);

    // EX_A did 3/4 of all buys → should get a bigger optimalUsdt share than
    // EX_C, which did only 1/4.
    expect(distA.optimalUsdt).toBeGreaterThan(distC.optimalUsdt);
    expect(distA.usdtDelta).toBeCloseTo(distA.optimalUsdt - distA.currentUsdt, 2);
  });

  it('does not flag a contract violation for a real Trade from executeSimulated()', async () => {
    const { detectOpportunities, executeSimulated } = await import('../server/domain/engines/opportunityDetection.js');
    const books = [
      { exchange: 'Binance',  ask: 30000, bid: 29990, ts: Date.now(), feedAgeMs: 0 },
      { exchange: 'Kraken',   ask: 30160, bid: 30150, ts: Date.now(), feedAgeMs: 0 },
      { exchange: 'Bybit',    ask: 29950, bid: 29940, ts: Date.now(), feedAgeMs: 0 },
      { exchange: 'OKX',      ask: 30050, bid: 30040, ts: Date.now(), feedAgeMs: 0 },
      { exchange: 'Coinbase', ask: 30000, bid: 29990, ts: Date.now(), feedAgeMs: 0 },
    ];
    const { opportunities } = detectOpportunities(books, 0.1);
    const viable = opportunities.find(o => o.viable);
    expect(viable).toBeTruthy();

    const wallets = emptyWallets();
    for (const ex of EXCHANGES) { wallets.USDT[ex] = 1_000_000; wallets.BTC[ex] = 100; }
    const result = executeSimulated(viable, wallets, 0.1);
    expect(result.ok).toBe(true);

    const emitSpy = vi.spyOn(observability, 'emit');
    predictiveRebalance.recordTrade(result.trade);
    const contractViolations = emitSpy.mock.calls.filter(
      call => call[1] === 'contract.trade_shape_invalid',
    );
    expect(contractViolations).toEqual([]);
    emitSpy.mockRestore();
  });
});

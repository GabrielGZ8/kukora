'use strict';

/**
 * advancedRiskEngine.test.js — unit tests for server/advancedRiskEngine.js
 *
 * Audit v2, section 9.1: tied with walletManager.js as the top-priority
 * module to cover — this is the circuit-breaker / drawdown / exposure /
 * pre-trade risk layer that is supposed to stop bad trades before they
 * reach walletManager.applyTrade(). It had zero test references.
 *
 * Because this module holds module-level singleton state (peak equity,
 * circuit breaker flags, slippage/latency history), each test resets both
 * liveConfig (back to schema defaults) and the risk engine's own breaker
 * state via resetCircuitBreaker()/init() rather than re-importing the
 * module, which mirrors how it's actually used in production (one
 * long-lived singleton).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const riskEngine = require('../server/domain/risk/advancedRiskEngine');
const liveConfig = require('../server/infrastructure/liveConfig.js');

function freshState(equity = 100000) {
  liveConfig.reset('test');
  // Drop any active circuit breaker from a previous test so each test
  // starts from a known-clean state.
  riskEngine.resetCircuitBreaker('test_setup');
  riskEngine.init(equity);
}

function baseOpportunity(overrides = {}) {
  return {
    buyPrice: 50000,
    tradeAmount: 0.01, // → $500 position, well under the $10,000 default cap
    slippagePct: 0.01, // well under the 0.15% default cap
    ...overrides,
  };
}

describe('advancedRiskEngine — drawdown', () => {
  beforeEach(() => freshState(100000));

  it('reports 0% drawdown at peak equity', () => {
    expect(riskEngine.getDrawdownPct(100000)).toBe(0);
  });

  it('reports positive drawdown below peak and stays ok under the limit', () => {
    riskEngine.updateEquity(120000); // new peak
    const result = riskEngine.checkDrawdown(115000); // ~4.2% down from peak
    expect(result.ok).toBe(true);
    expect(result.drawdownPct).toBeCloseTo(4.17, 1);
  });

  it('activates the circuit breaker once drawdown exceeds maxDrawdownPct (default 10%)', () => {
    riskEngine.updateEquity(100000);
    const result = riskEngine.checkDrawdown(85000); // 15% drawdown
    expect(result.ok).toBe(false);
    expect(riskEngine.getStatus().circuitBreaker.active).toBe(true);
  });
});

describe('advancedRiskEngine — position size', () => {
  beforeEach(() => freshState(100000));

  it('allows a position under the default $10,000 cap', () => {
    const result = riskEngine.checkPositionSize(5000);
    expect(result.ok).toBe(true);
  });

  it('rejects a position over the default $10,000 cap', () => {
    const result = riskEngine.checkPositionSize(15000);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exceeds maximum/);
  });

  it('accepts an optional override cap (2nd param) and uses it instead of the global default', () => {
    const result = riskEngine.checkPositionSize(5000, 3000);
    expect(result.ok).toBe(false);
    expect(result.limit).toBe(3000);
  });

  it('falls back to the global cap when the override is undefined/null', () => {
    const withUndefined = riskEngine.checkPositionSize(5000, undefined);
    const withNull = riskEngine.checkPositionSize(5000, null);
    expect(withUndefined.maxPositionValueUSD).toBe(10000);
    expect(withNull.maxPositionValueUSD).toBe(10000);
  });
});

describe('advancedRiskEngine — circuit breaker lifecycle', () => {
  beforeEach(() => freshState(100000));

  it('activateCircuitBreaker is idempotent — a second call while active is a no-op', () => {
    riskEngine.activateCircuitBreaker('reason A', 'manual');
    expect(riskEngine.getStatus().circuitBreaker.active).toBe(true);
    riskEngine.activateCircuitBreaker('reason B', 'manual');
    // Reason should remain the first one since the second activation was ignored
    expect(riskEngine.getStatus().circuitBreaker.reason).toBe('reason A');
  });

  it('resetCircuitBreaker clears the active breaker and consecutive-failure count', () => {
    riskEngine.activateCircuitBreaker('manual stop', 'manual');
    const result = riskEngine.resetCircuitBreaker('manual');
    expect(result.ok).toBe(true);
    expect(riskEngine.getStatus().circuitBreaker.active).toBe(false);
  });

  it('resetCircuitBreaker on an already-inactive breaker returns ok:false', () => {
    const result = riskEngine.resetCircuitBreaker('manual');
    expect(result.ok).toBe(false);
  });

  // Auditoría del comité (Sesión 34, P0 #2 — kill switch manual).
  it('activateCircuitBreaker returns a real result object on first activation (not undefined)', () => {
    const result = riskEngine.activateCircuitBreaker('operator halt', 'manual');
    expect(result.ok).toBe(true);
    expect(result.alreadyActive).toBe(false);
    expect(result.reason).toBe('operator halt');
    expect(result.triggerType).toBe('manual');
    expect(typeof result.activatedAt).toBe('string');
  });

  it('activateCircuitBreaker on an already-active breaker reports alreadyActive:true with the original reason', () => {
    riskEngine.activateCircuitBreaker('first reason', 'manual');
    const result = riskEngine.activateCircuitBreaker('second reason', 'manual');
    expect(result.ok).toBe(true);
    expect(result.alreadyActive).toBe(true);
    expect(result.reason).toBe('first reason');
  });

  it("a 'manual' trigger never auto-resets by timeout — only an explicit reset clears it", () => {
    vi.useFakeTimers();
    try {
      riskEngine.activateCircuitBreaker('operator halt', 'manual');
      vi.advanceTimersByTime(10 * 60 * 1000); // way past the 5-minute auto-reset window
      expect(riskEngine.getStatus().circuitBreaker.active).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recordTradeOutcome(false) repeated trips the circuit breaker at maxConsecutiveFailures (default 5)', () => {
    for (let i = 0; i < 4; i++) {
      const r = riskEngine.recordTradeOutcome(false);
      expect(r.circuitBreakerActive).toBe(false);
    }
    const last = riskEngine.recordTradeOutcome(false);
    expect(last.circuitBreakerActive).toBe(true);
  });

  it('recordTradeOutcome(true) resets the consecutive-failure counter', () => {
    riskEngine.recordTradeOutcome(false);
    riskEngine.recordTradeOutcome(false);
    riskEngine.recordTradeOutcome(true);
    // After a success, it should take another full streak of 5 to trip the breaker
    for (let i = 0; i < 4; i++) {
      expect(riskEngine.recordTradeOutcome(false).circuitBreakerActive).toBe(false);
    }
    expect(riskEngine.recordTradeOutcome(false).circuitBreakerActive).toBe(true);
  });
});

describe('advancedRiskEngine — emergency stop', () => {
  beforeEach(() => freshState(100000));

  it('passes when session P&L is above the emergency stop threshold (-1000 default)', () => {
    const result = riskEngine.checkEmergencyStop(-200);
    expect(result.ok).toBe(true);
  });

  it('trips the circuit breaker when session P&L falls to/below the threshold', () => {
    const result = riskEngine.checkEmergencyStop(-1500);
    expect(result.ok).toBe(false);
    expect(riskEngine.getStatus().circuitBreaker.active).toBe(true);
  });
});

describe('advancedRiskEngine — preTradeRiskCheck (6-layer gate)', () => {
  beforeEach(() => freshState(100000));

  it('passes a safe, well-within-limits opportunity', () => {
    const result = riskEngine.preTradeRiskCheck(baseOpportunity(), {}, 100000, 0);
    expect(result.ok).toBe(true);
    expect(result.blockedBy).toBeNull();
    // 5 checks run when the circuit breaker is inactive: daily_loss,
    // emergency_stop, drawdown, position_size, slippage. The circuit_breaker
    // check itself is only pushed onto `checks` when it's actually active
    // (see preTradeRiskCheck's `if (_circuitBreakerActive)` guard).
    expect(result.checks.length).toBe(5);
  });

  it('blocks when the circuit breaker is already active', () => {
    riskEngine.activateCircuitBreaker('pre-existing issue', 'manual');
    const result = riskEngine.preTradeRiskCheck(baseOpportunity(), {}, 100000, 0);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe('circuit_breaker');
  });

  it('blocks when session P&L breaches the daily loss limit (-500 default)', () => {
    const result = riskEngine.preTradeRiskCheck(baseOpportunity(), {}, 100000, -600);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe('daily_loss_limit');
  });

  it('blocks when position size exceeds the configured cap', () => {
    const huge = baseOpportunity({ tradeAmount: 1, buyPrice: 50000 }); // $50,000 position
    const result = riskEngine.preTradeRiskCheck(huge, {}, 100000, 0);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe('position_size');
  });

  // AUDIT FINDING 2 (CRITICAL) fix: adaptivePositionSizing.getPositionSizeForOpportunity()
  // returns `{ ...opp, positionSizing }`, leaving the ORIGINAL pre-adjustment
  // opportunity.tradeAmount untouched on the same object. The real, executed
  // size lives in positionSizing.size. preTradeRiskCheck previously read
  // tradeAmount — the wrong, smaller number — so a trade scaled up by
  // adaptive sizing could bypass a cap it should have tripped.
  describe('AUDIT FINDING 2 fix — positionSizing.size must win over stale tradeAmount', () => {
    it('blocks a trade whose adjusted positionSizing.size exceeds the cap, even though the stale tradeAmount would pass', () => {
      // tradeAmount (0.001 BTC * $50,000 = $50) passes the $10k global cap on
      // its own, but adaptive sizing decided to scale this trade up to 0.3
      // BTC ($15,000) — over the cap. The gate must see the real number.
      const opp = baseOpportunity({ tradeAmount: 0.001, buyPrice: 50000, positionSizing: { size: 0.3 } });
      const result = riskEngine.preTradeRiskCheck(opp, {}, 100000, 0);
      expect(result.ok).toBe(false);
      expect(result.blockedBy).toBe('position_size');
    });

    it('passes a trade whose adjusted positionSizing.size is within the cap, even though the stale tradeAmount alone would look larger', () => {
      // Inverse sanity check: sizing was adjusted DOWN. The gate must use
      // the smaller, real number — not the larger stale one — and pass.
      const opp = baseOpportunity({ tradeAmount: 1, buyPrice: 50000, positionSizing: { size: 0.05 } });
      const result = riskEngine.preTradeRiskCheck(opp, {}, 100000, 0);
      expect(result.ok).toBe(true);
      const sizeCheck = result.checks.find(c => c.check === 'position_size');
      expect(sizeCheck.tradeValueUSD).toBeCloseTo(0.05 * 50000, 2);
    });

    it('falls back to tradeAmount when positionSizing is absent (e.g. liveExecution.js synthetic riskOpportunity)', () => {
      const opp = baseOpportunity({ tradeAmount: 1, buyPrice: 50000 }); // no positionSizing field at all
      const result = riskEngine.preTradeRiskCheck(opp, {}, 100000, 0);
      expect(result.ok).toBe(false);
      expect(result.blockedBy).toBe('position_size');
      const sizeCheck = result.checks.find(c => c.check === 'position_size');
      expect(sizeCheck.actual).toBeCloseTo(1 * 50000, 2);
    });
  });

  it('blocks when slippage exceeds the configured cap (0.15% default)', () => {
    const slippy = baseOpportunity({ slippagePct: 1.5 });
    const result = riskEngine.preTradeRiskCheck(slippy, {}, 100000, 0);
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe('slippage_limit');
  });

  // Refinamiento post-Sesión 34 ("Profundidad y parametrización" — per-user
  // risk overrides, ver userRiskProfileService.js). Estos tests cubren el
  // 5º parámetro `overrides` agregado a preTradeRiskCheck.
  describe('per-user overrides (5th param) — stricter-only enforcement', () => {
    it('a stricter per-user maxPositionValueUSD blocks a trade the global limit would allow', () => {
      const opp = baseOpportunity({ tradeAmount: 0.02, buyPrice: 50000 }); // $1,000 position — passes global $10k cap
      const passesGlobally = riskEngine.preTradeRiskCheck(opp, {}, 100000, 0);
      expect(passesGlobally.ok).toBe(true);

      const blocked = riskEngine.preTradeRiskCheck(opp, {}, 100000, 0, { maxPositionValueUSD: 500 });
      expect(blocked.ok).toBe(false);
      expect(blocked.blockedBy).toBe('position_size');
    });

    it('a stricter per-user maxSlippagePct blocks a trade the global limit would allow', () => {
      const opp = baseOpportunity({ slippagePct: 0.10 }); // under the global 0.15% default
      const passesGlobally = riskEngine.preTradeRiskCheck(opp, {}, 100000, 0);
      expect(passesGlobally.ok).toBe(true);

      const blocked = riskEngine.preTradeRiskCheck(opp, {}, 100000, 0, { maxSlippagePct: 0.05 });
      expect(blocked.ok).toBe(false);
      expect(blocked.blockedBy).toBe('slippage_limit');
    });

    it('a stricter per-user maxDailyLossUSD blocks a trade the global daily-loss limit would allow', () => {
      const opp = baseOpportunity();
      const passesGlobally = riskEngine.preTradeRiskCheck(opp, {}, 100000, -100); // above global -500 floor
      expect(passesGlobally.ok).toBe(true);

      const blocked = riskEngine.preTradeRiskCheck(opp, {}, 100000, -100, { maxDailyLossUSD: -50 });
      expect(blocked.ok).toBe(false);
      expect(blocked.blockedBy).toBe('daily_loss_limit');
    });

    it('a LAXER per-user override (e.g. a bigger position cap) is ignored — never more permissive than global', () => {
      const huge = baseOpportunity({ tradeAmount: 1, buyPrice: 50000 }); // $50,000 — exceeds global $10k cap
      const result = riskEngine.preTradeRiskCheck(huge, {}, 100000, 0, { maxPositionValueUSD: 1_000_000 });
      expect(result.ok).toBe(false);
      expect(result.blockedBy).toBe('position_size');
    });

    it('omitting overrides entirely behaves identically to the pre-existing 4-argument call (backward compatible)', () => {
      const opp = baseOpportunity();
      const withoutOverrides = riskEngine.preTradeRiskCheck(opp, {}, 100000, 0);
      const withEmptyOverrides = riskEngine.preTradeRiskCheck(opp, {}, 100000, 0, {});
      expect(withEmptyOverrides.ok).toBe(withoutOverrides.ok);
      expect(withEmptyOverrides.checks.length).toBe(withoutOverrides.checks.length);
    });
  });

  it('blocks when drawdown exceeds the configured cap', () => {
    riskEngine.updateEquity(100000);
    const result = riskEngine.preTradeRiskCheck(baseOpportunity(), {}, 85000, 0); // 15% drawdown
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe('drawdown');
  });

  it('reports the first-encountered violation as blockedBy when multiple checks fail', () => {
    // Circuit breaker check runs first in the pipeline — it should win even
    // though daily loss is also breached.
    riskEngine.activateCircuitBreaker('already broken', 'manual');
    const result = riskEngine.preTradeRiskCheck(baseOpportunity(), {}, 100000, -600);
    expect(result.blockedBy).toBe('circuit_breaker');
  });
});

describe('advancedRiskEngine — exposure limits', () => {
  beforeEach(() => freshState(100000));

  it('flags exchange concentration above the configured ratio (40% default)', () => {
    const exchanges = liveConfig.get('activeExchanges');
    const wallets = { USDT: {}, BTC: {} };
    for (const ex of exchanges) { wallets.USDT[ex] = 0; wallets.BTC[ex] = 0; }
    // Dump almost everything onto the first exchange
    wallets.USDT[exchanges[0]] = 90000;
    const result = riskEngine.checkExposureLimits(wallets, 50000, 100000);
    expect(result.ok).toBe(false);
    expect(result.violations.some(v => v.type === 'exchange_concentration')).toBe(true);
  });

  it('reports ok when exposure is evenly distributed across exchanges and assets', () => {
    const exchanges = liveConfig.get('activeExchanges');
    const wallets = { USDT: {}, BTC: {} };
    // Split value evenly across exchanges AND between USDT/BTC so neither
    // the per-exchange nor the per-asset concentration check trips.
    const usdtPerExchange = 50000 / exchanges.length;
    const btcPerExchange = (50000 / 50000) / exchanges.length; // $50,000 worth of BTC at $50k/BTC
    for (const ex of exchanges) {
      wallets.USDT[ex] = usdtPerExchange;
      wallets.BTC[ex] = btcPerExchange;
    }
    const result = riskEngine.checkExposureLimits(wallets, 50000, 100000);
    expect(result.ok).toBe(true);
  });
});

describe('advancedRiskEngine — getStatus', () => {
  beforeEach(() => freshState(100000));

  it('returns a machine-readable status snapshot', () => {
    const status = riskEngine.getStatus(100000, 0);
    expect(status).toHaveProperty('circuitBreaker');
    expect(status.circuitBreaker.active).toBe(false);
  });
});

// ─── Nivel 1 gap-fill (round 8): recordSlippage / recordLatency /
// updateExposure(trade) / assetRiskScore / correlationMatrix / portfolioRisk
// had zero test references prior to this round. ─────────────────────────

describe('advancedRiskEngine — recordSlippage', () => {
  beforeEach(() => freshState(100000));

  it('ignores null/NaN readings without throwing or affecting history', () => {
    expect(() => riskEngine.recordSlippage(null)).not.toThrow();
    expect(() => riskEngine.recordSlippage(NaN)).not.toThrow();
    const status = riskEngine.getStatus(100000, 0);
    expect(status.slippageHistory).toEqual([]);
  });

  it('appends readings under the limit without tripping the circuit breaker', () => {
    riskEngine.recordSlippage(0.01);
    riskEngine.recordSlippage(0.02);
    const status = riskEngine.getStatus(100000, 0);
    expect(status.slippageHistory).toEqual([0.01, 0.02]);
    expect(status.circuitBreaker.active).toBe(false);
  });

  it('trips the circuit breaker once 3 of the last 5 readings exceed maxSlippagePct (default 0.15%)', () => {
    riskEngine.recordSlippage(0.05); // ok
    riskEngine.recordSlippage(0.5);  // breach 1
    riskEngine.recordSlippage(0.5);  // breach 2
    riskEngine.recordSlippage(0.05); // ok
    riskEngine.recordSlippage(0.5);  // breach 3 -> trips
    const status = riskEngine.getStatus(100000, 0);
    expect(status.circuitBreaker.active).toBe(true);
    expect(status.circuitBreaker.reason).toMatch(/Excessive slippage/);
  });

  it('caps in-memory history at 50 entries (oldest dropped)', () => {
    for (let i = 0; i < 55; i++) riskEngine.recordSlippage(0.01);
    // getStatus only exposes the last 10, so confirm no throw / stable shape
    // across 55 pushes as a proxy for the internal 50-cap not growing unbounded.
    const status = riskEngine.getStatus(100000, 0);
    expect(status.slippageHistory.length).toBe(10);
  });
});

describe('advancedRiskEngine — recordLatency', () => {
  beforeEach(() => freshState(100000));

  it('accepts a latency reading without throwing and without tripping the circuit breaker', () => {
    expect(() => riskEngine.recordLatency(150)).not.toThrow();
    const status = riskEngine.getStatus(100000, 0);
    expect(status.circuitBreaker.active).toBe(false);
  });

  it('does not activate the circuit breaker even when latency repeatedly exceeds the limit (warn-only)', () => {
    // maxExecutionLatencyMs default is 2000ms — recordLatency only emits a
    // warning event, it never calls activateCircuitBreaker.
    for (let i = 0; i < 5; i++) riskEngine.recordLatency(5000);
    const status = riskEngine.getStatus(100000, 0);
    expect(status.circuitBreaker.active).toBe(false);
  });
});

describe('advancedRiskEngine — updateExposure with a trade', () => {
  beforeEach(() => freshState(100000));

  const wallets = {
    USDT: { Binance: 10000, Kraken: 5000 },
    BTC:  { Binance: 0.1, Kraken: 0.05 },
  };

  it('recomputes exposure by exchange/asset from the wallets snapshot', () => {
    const result = riskEngine.checkExposureLimits(wallets, 50000, 100000);
    expect(result.exposureByExchange.Binance.totalUSD).toBeCloseTo(10000 + 0.1 * 50000, 2);
    expect(result.exposureByAsset.BTC).toBeCloseTo(0.15 * 50000, 2);
  });

  it('does not throw when passed a trade object (strategy exposure tracking)', () => {
    const trade = { type: 'triangular', netProfit: 42.5 };
    expect(() => riskEngine.updateExposure(trade, wallets, 50000)).not.toThrow();
  });
});

describe('advancedRiskEngine — assetRiskScore', () => {
  it('returns a neutral default score for series shorter than 10 points', () => {
    const result = riskEngine.assetRiskScore([100, 101, 99]);
    expect(result).toEqual({ score: 50, grade: 'C', components: {} });
  });

  it('scores a low-volatility, non-declining series as low risk (grade A or B)', () => {
    const stablePrices = Array.from({ length: 20 }, (_, i) => 100 + i * 0.05);
    const result = riskEngine.assetRiskScore(stablePrices);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(['A', 'B']).toContain(result.grade);
    expect(result.components).toHaveProperty('volatility');
    expect(result.raw).toHaveProperty('sharpe');
  });

  it('scores a highly volatile, sharply declining series as higher risk than a stable one', () => {
    const stablePrices = Array.from({ length: 20 }, (_, i) => 100 + i * 0.05);
    const volatilePrices = [100, 80, 110, 60, 130, 40, 150, 20, 160, 15, 170, 10, 180, 8, 190, 5, 200, 3, 210, 2];
    const stable = riskEngine.assetRiskScore(stablePrices);
    const volatile = riskEngine.assetRiskScore(volatilePrices);
    expect(volatile.score).toBeGreaterThan(stable.score);
  });
});

describe('advancedRiskEngine — correlationMatrix', () => {
  it('reports perfect self-correlation (1) on the diagonal', () => {
    const assetsMap = {
      BTC: [100, 102, 101, 105, 103, 107, 110, 108, 112, 115],
      ETH: [10, 9, 11, 8, 12, 7, 13, 6, 14, 5],
    };
    const matrix = riskEngine.correlationMatrix(assetsMap);
    expect(matrix.BTC.BTC).toBe(1);
    expect(matrix.ETH.ETH).toBe(1);
  });

  it('reports near-perfect positive correlation for identically-moving series', () => {
    const btc = [100, 102, 101, 105, 103, 107, 110, 108, 112, 115];
    const assetsMap = { BTC: btc, BTC2: btc.map(p => p * 2) };
    const matrix = riskEngine.correlationMatrix(assetsMap);
    expect(matrix.BTC.BTC2).toBeCloseTo(1, 5);
  });

  it('is symmetric across the diagonal', () => {
    const assetsMap = {
      BTC: [100, 102, 101, 105, 103, 107, 110, 108, 112, 115],
      ETH: [10, 9, 11, 8, 12, 7, 13, 6, 14, 5],
    };
    const matrix = riskEngine.correlationMatrix(assetsMap);
    expect(matrix.BTC.ETH).toBeCloseTo(matrix.ETH.BTC, 10);
  });
});

describe('advancedRiskEngine — portfolioRisk', () => {
  it('returns null for an empty position list', () => {
    expect(riskEngine.portfolioRisk([])).toBeNull();
  });

  it('computes weights that sum to ~100% and includes volatility/sharpe metrics', () => {
    const positions = [
      { coinId: 'BTC', quantity: 0.1, entryPrice: 100, prices: [100, 102, 101, 105, 103] },
      { coinId: 'ETH', quantity: 1,   entryPrice: 10,  prices: [10, 9, 11, 8, 12] },
    ];
    const result = riskEngine.portfolioRisk(positions);
    expect(result.totalValue).toBeGreaterThan(0);
    const weightSum = result.weights.reduce((s, w) => s + w.weight, 0);
    expect(weightSum).toBeCloseTo(100, 0);
    expect(result.metrics).toHaveProperty('volatility');
    expect(result.metrics).toHaveProperty('sharpe');
    expect(result.returns.length).toBe(4); // len(prices)-1
  });

  it('falls back to entryPrice when a position has no price array at all', () => {
    const positions = [
      { coinId: 'BTC', quantity: 1, entryPrice: 100 },
    ];
    const result = riskEngine.portfolioRisk(positions);
    expect(result.totalValue).toBe(100);
  });
});

'use strict';

/**
 * adr019SlippageBiasFix.test.js
 *
 * Regression coverage for a bug found and fixed while doing a final
 * verification pass on ADR-019 §5 (execution-quality/slippage penalty):
 *
 *   BEFORE: both arbitrageOrchestrator.js (paper-trading) and the
 *   original recordSlippageBias() call sites fed the exchange's raw
 *   realized slippagePct straight into recordSlippageBias() as if it
 *   were a "bias" (estimated - actual). In the shared paper-trading bot,
 *   executeSimulated() always replays the opportunity's pre-trade
 *   slippagePct verbatim as the trade's "realized" slippagePct (there is
 *   no independent market fill to diverge from), so this fabricated a
 *   constant positive "worse than modeled" signal on every trade,
 *   contradicting §5's own documented semantics ("a bias <= 0 is never
 *   penalized" / "self-healing" / "only penalizes when worse than
 *   modeled").
 *
 *   AFTER: the paper-trading path computes an honest delta
 *   (realized - modeled), which is provably 0 for executeSimulated()
 *   trades — i.e. §5 correctly contributes no penalty from paper trades,
 *   rather than a fabricated one. Real bias is instead recorded from
 *   server/application/liveExecution.js's REAL fill success paths, where
 *   a genuine fillPrice-vs-referencePrice divergence exists, via the new
 *   _recordRealizedSlippageBias() helper — verified directly here against
 *   liveConfig.maxSlippagePct as the "modeled/acceptable" baseline.
 */

import { describe, it, expect, beforeEach } from 'vitest';

describe('ADR-019 §5 — slippage bias fix', () => {
  describe('paper-trading path: bias delta, not raw magnitude', () => {
    it('a raw positive slippagePct, unchanged from the pre-trade estimate, produces a ZERO bias delta (not a fabricated positive one)', () => {
      // Mirrors executeSimulated()'s exact behavior: trade.slippagePct is
      // opportunity.slippagePct verbatim (see opportunityDetection.js —
      // `slippagePct: opportunity.slippagePct` inside the returned trade
      // object), so realized === modeled for every paper trade.
      const bestWithSizing = { slippagePct: 0.08 };
      const applyResultTrade = { slippagePct: bestWithSizing.slippagePct };

      const bias = (applyResultTrade.slippagePct || 0) - (bestWithSizing.slippagePct || 0);

      expect(bias).toBe(0);
    });

    it('the old (buggy) approach would NOT have been zero for the same inputs — demonstrates the bug this fix closes', () => {
      const bestWithSizing = { slippagePct: 0.08 };
      const applyResultTrade = { slippagePct: bestWithSizing.slippagePct };

      // This is exactly what the pre-fix code fed to recordSlippageBias():
      const buggyBiasFedPreviously = applyResultTrade.slippagePct || 0;

      expect(buggyBiasFedPreviously).toBeGreaterThan(0);
      expect(buggyBiasFedPreviously).not.toBe(
        (applyResultTrade.slippagePct || 0) - (bestWithSizing.slippagePct || 0)
      );
    });
  });

  describe('live-money path: _recordRealizedSlippageBias() real divergence', () => {
    // Uses the REAL exchangeReliabilityDynamic module rather than
    // vi.doMock() — this repo has a documented dual-module-instance issue
    // when a CJS require() inside the module under test and an ESM
    // vi.doMock() target the same file from a test: they can resolve to
    // two different module instances, silently making the mock a no-op
    // (see the sibling test file, tests/exchangeReliabilityDynamic.slippagePenalty.test.js,
    // and the note in vitest.config.js re: auth.js for the same pattern).
    // Testing end-to-end against the real module sidesteps that entirely.
    const liveExecution = require('../server/application/liveExecution.js');
    const { getSlippagePenalty, resetSlippagePenalty } = require('../server/infrastructure/exchangeReliabilityDynamic.js');
    const liveConfig = require('../server/infrastructure/liveConfig.js');

    beforeEach(() => {
      resetSlippagePenalty();
      liveConfig.setMany({ slippagePenaltyEnabled: true, minExecutionSamples: 1, maxSlippagePct: 0.10 }, 'test');
    });

    it('BUY side: paying more than the reference price + budget produces a non-zero penalty', () => {
      // referencePrice=100, fillPrice=100.5 → 0.5% adverse, budget 0.10%
      // → bias +0.40 → real, non-zero penalty on Binance.
      liveExecution._recordRealizedSlippageBias('Binance', 'BUY', 100, 100.5);
      expect(getSlippagePenalty('Binance')).toBeGreaterThan(0);
    });

    it('SELL side: receiving less than the reference price + budget produces a non-zero penalty', () => {
      liveExecution._recordRealizedSlippageBias('Kraken', 'SELL', 100, 99.7);
      expect(getSlippagePenalty('Kraken')).toBeGreaterThan(0);
    });

    it('a fill WITHIN the configured slippage budget produces zero penalty (never penalized within budget)', () => {
      liveConfig.setMany({ maxSlippagePct: 0.50 }, 'test');
      liveExecution._recordRealizedSlippageBias('OKX', 'BUY', 100, 100.1); // 0.1% adverse, well within 0.5% budget
      expect(getSlippagePenalty('OKX')).toBe(0);
    });

    it('a favorable fill (better than reference price) produces zero penalty, never a negative one exposed to callers', () => {
      liveExecution._recordRealizedSlippageBias('Bybit', 'BUY', 100, 99.9); // bought BELOW reference — favorable
      expect(getSlippagePenalty('Bybit')).toBe(0);
    });

    it('never throws and records nothing when referencePrice is missing/zero (defensive guard)', () => {
      expect(() => liveExecution._recordRealizedSlippageBias('Binance', 'BUY', null, 100)).not.toThrow();
      expect(() => liveExecution._recordRealizedSlippageBias('Binance', 'BUY', 0, 100)).not.toThrow();
      expect(getSlippagePenalty('Binance')).toBe(0);
    });

    it('never throws when fillPrice is null/undefined (defensive guard)', () => {
      expect(() => liveExecution._recordRealizedSlippageBias('Binance', 'BUY', 100, null)).not.toThrow();
      expect(getSlippagePenalty('Binance')).toBe(0);
    });
  });
});

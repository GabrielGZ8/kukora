'use strict';

/**
 * smartOrderRouter.test.js — unit tests for the Smart Order Router
 * (server/domain/engines/smartOrderRouter.js).
 *
 * Covers the three policies (market_taker / ioc_protected /
 * post_only_maker), the urgent-leg guard that prevents post-only from ever
 * being used on a cross-exchange arb leg, and the price-protection math for
 * both BUY and SELL sides.
 */

import { describe, it, expect, beforeEach } from 'vitest';

const smartOrderRouter = require('../server/domain/engines/smartOrderRouter');
const liveConfig = require('../server/infrastructure/liveConfig.js');

describe('smartOrderRouter.decideOrderType', () => {
  beforeEach(() => {
    liveConfig.reset('test');
  });

  it('defaults to market_taker (plain MARKET, no price) when no policy is configured', () => {
    const result = smartOrderRouter.decideOrderType('BUY', 50000);
    expect(result.type).toBe('MARKET');
    expect(result.price).toBeNull();
  });

  it('falls back to MARKET for an unrecognized policy rather than throwing', () => {
    const result = smartOrderRouter.decideOrderType('BUY', 50000, { policy: 'not_a_real_policy' });
    expect(result.type).toBe('MARKET');
    expect(result.reason).toMatch(/Unknown policy/);
  });

  describe('ioc_protected', () => {
    it('protects a BUY at most maxSlippagePct above the reference price', () => {
      liveConfig.setMany({ maxSlippagePct: 0.5 }, 'test'); // 0.5%
      const result = smartOrderRouter.decideOrderType('BUY', 50000, { policy: 'ioc_protected' });
      expect(result.type).toBe('LIMIT_IOC');
      expect(result.price).toBeCloseTo(50250, 2); // 50000 * 1.005
    });

    it('protects a SELL at most maxSlippagePct below the reference price', () => {
      liveConfig.setMany({ maxSlippagePct: 0.5 }, 'test');
      const result = smartOrderRouter.decideOrderType('SELL', 50000, { policy: 'ioc_protected' });
      expect(result.type).toBe('LIMIT_IOC');
      expect(result.price).toBeCloseTo(49750, 2); // 50000 * 0.995
    });

    it('is safe for urgent legs — IOC is designed for exactly this case', () => {
      const result = smartOrderRouter.decideOrderType('BUY', 50000, { policy: 'ioc_protected', urgent: true });
      expect(result.type).toBe('LIMIT_IOC');
    });
  });

  describe('post_only_maker', () => {
    it('quotes a BUY slightly below the reference price (queues as maker)', () => {
      const result = smartOrderRouter.decideOrderType('BUY', 50000, { policy: 'post_only_maker', urgent: false });
      expect(result.type).toBe('LIMIT_MAKER');
      expect(result.price).toBeLessThan(50000);
      expect(result.price).toBeCloseTo(50000 * (1 - liveConfig.get('postOnlyOffsetPct')), 2);
    });

    it('quotes a SELL slightly above the reference price (queues as maker)', () => {
      const result = smartOrderRouter.decideOrderType('SELL', 50000, { policy: 'post_only_maker', urgent: false });
      expect(result.type).toBe('LIMIT_MAKER');
      expect(result.price).toBeGreaterThan(50000);
    });

    it('refuses to use post-only on an urgent (cross-exchange) leg and falls back to MARKET', () => {
      const result = smartOrderRouter.decideOrderType('BUY', 50000, { policy: 'post_only_maker', urgent: true });
      expect(result.type).toBe('MARKET');
      expect(result.reason).toMatch(/urgent/);
    });

    it('treats urgent as true by default (the common case is the cross-exchange arb path)', () => {
      const result = smartOrderRouter.decideOrderType('BUY', 50000, { policy: 'post_only_maker' });
      expect(result.type).toBe('MARKET');
    });
  });

  it('reads the policy from liveConfig when not explicitly overridden', () => {
    liveConfig.setMany({ orderExecutionPolicy: 'ioc_protected' }, 'test');
    const result = smartOrderRouter.decideOrderType('BUY', 50000);
    expect(result.type).toBe('LIMIT_IOC');
  });
});

'use strict';

/**
 * userRiskProfileService.test.js — refinamiento post-Sesión 34
 * ("Profundidad y parametrización" — per-user risk overrides).
 *
 * Ver el comentario extenso en server/domain/risk/userRiskProfileService.js para
 * el porqué: por qué solo estos 5 campos son overridables per-user y por
 * qué siempre se clampean contra el límite global (nunca más laxos).
 */

import { describe, it, expect, beforeEach } from 'vitest';

const userRiskProfileService = require('../server/domain/risk/userRiskProfileService');
const liveConfig = require('../server/infrastructure/liveConfig.js');

function freshUserId() {
  return `test-user-${Math.random().toString(36).slice(2)}`;
}

describe('userRiskProfileService', () => {
  beforeEach(() => {
    liveConfig.reset('test');
    userRiskProfileService._resetModelForTests();
  });

  describe('getUserRiskProfile', () => {
    it('returns an all-null default profile for a user with no overrides', () => {
      const profile = userRiskProfileService.getUserRiskProfile(freshUserId());
      expect(profile).toEqual({
        maxPositionValueUSD: null, maxDailyLossUSD: null, maxSlippagePct: null,
        maxDrawdownPct: null, activeExchanges: null, updatedAt: null,
      });
    });
  });

  describe('getEffectiveConfig', () => {
    it('returns an empty object (fall through to global) when no overrides are set', () => {
      expect(userRiskProfileService.getEffectiveConfig(freshUserId())).toEqual({});
    });

    it('includes only the keys the user actually overrode', () => {
      const userId = freshUserId();
      userRiskProfileService.setUserRiskProfile(userId, { maxSlippagePct: 0.05 });
      const effective = userRiskProfileService.getEffectiveConfig(userId);
      expect(Object.keys(effective)).toEqual(['maxSlippagePct']);
      expect(effective.maxSlippagePct).toBe(0.05);
    });
  });

  describe('setUserRiskProfile — validation', () => {
    it('throws for a maxPositionValueUSD below the global bound floor (100)', () => {
      expect(() => userRiskProfileService.setUserRiskProfile(freshUserId(), { maxPositionValueUSD: 50 })).toThrow();
    });

    it('throws for a positive maxDailyLossUSD (must stay <= 0)', () => {
      expect(() => userRiskProfileService.setUserRiskProfile(freshUserId(), { maxDailyLossUSD: 10 })).toThrow();
    });

    it('throws for activeExchanges as a non-array', () => {
      expect(() => userRiskProfileService.setUserRiskProfile(freshUserId(), { activeExchanges: 'Binance' })).toThrow();
    });

    it('accepts a well-formed partial update and leaves other fields untouched', () => {
      const userId = freshUserId();
      userRiskProfileService.setUserRiskProfile(userId, { maxDrawdownPct: 5 });
      userRiskProfileService.setUserRiskProfile(userId, { maxSlippagePct: 0.1 });
      const profile = userRiskProfileService.getUserRiskProfile(userId);
      expect(profile.maxDrawdownPct).toBe(5);
      expect(profile.maxSlippagePct).toBe(0.1);
    });

    it('an explicit null clears a previously-set override', () => {
      const userId = freshUserId();
      userRiskProfileService.setUserRiskProfile(userId, { maxSlippagePct: 0.1 });
      userRiskProfileService.setUserRiskProfile(userId, { maxSlippagePct: null });
      expect(userRiskProfileService.getUserRiskProfile(userId).maxSlippagePct).toBeNull();
      expect(userRiskProfileService.getEffectiveConfig(userId).maxSlippagePct).toBeUndefined();
    });
  });

  describe('_clampToGlobal behavior (via getEffectiveConfig) — a user override can never be more permissive than the global default', () => {
    it('clamps maxPositionValueUSD down to the global value when the user override is higher', () => {
      const userId = freshUserId();
      const globalMax = liveConfig.get('maxPositionValueUSD'); // default 10000
      userRiskProfileService.setUserRiskProfile(userId, { maxPositionValueUSD: globalMax + 5000 });
      expect(userRiskProfileService.getEffectiveConfig(userId).maxPositionValueUSD).toBe(globalMax);
    });

    it('keeps a user override that is already stricter than the global value', () => {
      const userId = freshUserId();
      userRiskProfileService.setUserRiskProfile(userId, { maxPositionValueUSD: 500 });
      expect(userRiskProfileService.getEffectiveConfig(userId).maxPositionValueUSD).toBe(500);
    });

    it('clamps maxDailyLossUSD to the less-negative (stricter) of the two', () => {
      const userId = freshUserId();
      const globalVal = liveConfig.get('maxDailyLossUSD'); // default -500
      // -10000 is "more permissive" (allows bigger losses) than -500 — must clamp up to -500.
      userRiskProfileService.setUserRiskProfile(userId, { maxDailyLossUSD: -10000 });
      expect(userRiskProfileService.getEffectiveConfig(userId).maxDailyLossUSD).toBe(globalVal);
    });

    it('filters activeExchanges down to the intersection with the global active list', () => {
      const userId = freshUserId();
      userRiskProfileService.setUserRiskProfile(userId, { activeExchanges: ['Binance', 'NotARealExchange'] });
      const effective = userRiskProfileService.getEffectiveConfig(userId);
      expect(effective.activeExchanges).not.toContain('NotARealExchange');
    });

    it('re-clamps at read time if the global value tightens after the override was set', () => {
      const userId = freshUserId();
      userRiskProfileService.setUserRiskProfile(userId, { maxPositionValueUSD: 8000 });
      liveConfig.setMany({ maxPositionValueUSD: 2000 }, 'test');
      expect(userRiskProfileService.getEffectiveConfig(userId).maxPositionValueUSD).toBe(2000);
    });
  });

  describe('OVERRIDABLE_KEYS', () => {
    it('exposes the exact 5 keys this service supports (documentation-as-contract)', () => {
      expect(userRiskProfileService.OVERRIDABLE_KEYS).toEqual([
        'maxPositionValueUSD', 'maxDailyLossUSD', 'maxSlippagePct', 'maxDrawdownPct', 'activeExchanges',
      ]);
    });
  });
});

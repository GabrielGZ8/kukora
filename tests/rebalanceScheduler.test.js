'use strict';

/**
 * rebalanceScheduler.test.js — refinamiento post-Sesión 34, Área 3
 * ("Gestión de wallets y rebalanceo" — automatización del disparo).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const scheduler = require('../server/domain/engines/rebalanceScheduler');
const rebalanceEngine = require('../server/domain/engines/rebalanceEngine');
const alertWebhookService = require('../server/infrastructure/alertWebhookService.js');
const liveConfig = require('../server/infrastructure/liveConfig.js');

function suggestion(overrides = {}) {
  return {
    asset: 'BTC', from: 'Binance', to: 'Kraken', amount: 0.05, amountUSD: 2500,
    fee: 1.5, netBenefit: 1.0, viable: true, reason: 'test imbalance', severity: 'high', priority: 1,
    ...overrides,
  };
}

describe('rebalanceScheduler', () => {
  beforeEach(() => {
    liveConfig.reset('test');
    scheduler._resetForTests();
    vi.restoreAllMocks();
    vi.spyOn(alertWebhookService, 'alertAutoRebalanceExecuted').mockResolvedValue();
  });

  afterEach(() => { scheduler.stopAutoRebalanceLoop(); });

  describe('runAutoRebalanceCycle — gating', () => {
    it('does nothing when autoRebalanceEnabled is false (the default)', async () => {
      const spy = vi.spyOn(rebalanceEngine, 'suggestRebalance');
      const result = await scheduler.runAutoRebalanceCycle(50000);
      expect(result.acted).toBe(false);
      expect(result.reason).toBe('disabled');
      expect(spy).not.toHaveBeenCalled();
    });

    it('does nothing when the worst detected imbalance is below the configured severity floor', async () => {
      liveConfig.setMany({ autoRebalanceEnabled: true, autoRebalanceMinSeverity: 'high' }, 'test');
      vi.spyOn(rebalanceEngine, 'suggestRebalance').mockReturnValue({
        needed: true,
        suggestions: [suggestion({ severity: 'medium', priority: 2 })],
        analysis: { imbalances: [{ severity: 'medium' }] },
      });
      const executeSpy = vi.spyOn(rebalanceEngine, 'executeRebalance');
      const result = await scheduler.runAutoRebalanceCycle(50000);
      expect(result.acted).toBe(false);
      expect(result.reason).toBe('below_severity_threshold');
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('does nothing when no suggestion is viable, even at high severity', async () => {
      liveConfig.setMany({ autoRebalanceEnabled: true }, 'test');
      vi.spyOn(rebalanceEngine, 'suggestRebalance').mockReturnValue({
        needed: true,
        suggestions: [suggestion({ viable: false })],
        analysis: { imbalances: [{ severity: 'high' }] },
      });
      const executeSpy = vi.spyOn(rebalanceEngine, 'executeRebalance');
      const result = await scheduler.runAutoRebalanceCycle(50000);
      expect(result.acted).toBe(false);
      expect(result.reason).toBe('no_viable_suggestion');
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('respects the cooldown — will not act again before autoRebalanceCooldownMs has elapsed', async () => {
      liveConfig.setMany({ autoRebalanceEnabled: true, autoRebalanceCooldownMs: 60_000 }, 'test');
      vi.spyOn(rebalanceEngine, 'suggestRebalance').mockReturnValue({
        needed: true, suggestions: [suggestion()], analysis: { imbalances: [{ severity: 'high' }] },
      });
      vi.spyOn(rebalanceEngine, 'executeRebalance').mockReturnValue({ ok: true, id: 'r1', entry: {} });

      const first = await scheduler.runAutoRebalanceCycle(50000);
      expect(first.acted).toBe(true);

      const second = await scheduler.runAutoRebalanceCycle(50000);
      expect(second.acted).toBe(false);
      expect(second.reason).toBe('cooldown');
    });
  });

  describe('runAutoRebalanceCycle — successful execution', () => {
    beforeEach(() => {
      liveConfig.setMany({ autoRebalanceEnabled: true }, 'test');
    });

    it('calls executeRebalance with the top viable suggestion and reports acted:true', async () => {
      const sug = suggestion();
      vi.spyOn(rebalanceEngine, 'suggestRebalance').mockReturnValue({
        needed: true, suggestions: [sug], analysis: { imbalances: [{ severity: 'high' }] },
      });
      const executeSpy = vi.spyOn(rebalanceEngine, 'executeRebalance').mockReturnValue({ ok: true, id: 'r1', entry: {} });

      const result = await scheduler.runAutoRebalanceCycle(50000);
      expect(result.acted).toBe(true);
      expect(executeSpy).toHaveBeenCalledWith(sug, 50000);
    });

    it('sends an alertAutoRebalanceExecuted notification on success', async () => {
      vi.spyOn(rebalanceEngine, 'suggestRebalance').mockReturnValue({
        needed: true, suggestions: [suggestion()], analysis: { imbalances: [{ severity: 'high' }] },
      });
      vi.spyOn(rebalanceEngine, 'executeRebalance').mockReturnValue({ ok: true, id: 'r1', entry: {} });

      await scheduler.runAutoRebalanceCycle(50000);
      expect(alertWebhookService.alertAutoRebalanceExecuted).toHaveBeenCalledWith(
        expect.objectContaining({ asset: 'BTC', from: 'Binance', to: 'Kraken', severity: 'high' })
      );
    });

    it('does not update the cooldown timestamp when executeRebalance itself reports failure', async () => {
      vi.spyOn(rebalanceEngine, 'suggestRebalance').mockReturnValue({
        needed: true, suggestions: [suggestion()], analysis: { imbalances: [{ severity: 'high' }] },
      });
      vi.spyOn(rebalanceEngine, 'executeRebalance').mockReturnValue({ ok: false, reason: 'Insufficient balance' });

      const result = await scheduler.runAutoRebalanceCycle(50000);
      expect(result.acted).toBe(false);
      expect(result.reason).toBe('Insufficient balance');
      expect(scheduler._getLastAutoExecutionTsForTests()).toBe(0);
    });

    it('scans ALL imbalances for the worst severity, not just the first element', async () => {
      liveConfig.setMany({ autoRebalanceMinSeverity: 'high' }, 'test');
      vi.spyOn(rebalanceEngine, 'suggestRebalance').mockReturnValue({
        needed: true,
        suggestions: [suggestion()],
        // 'low' comes first in the array, but 'high' appears later — the
        // scheduler must not stop at index 0.
        analysis: { imbalances: [{ severity: 'low' }, { severity: 'high' }] },
      });
      vi.spyOn(rebalanceEngine, 'executeRebalance').mockReturnValue({ ok: true, id: 'r1', entry: {} });

      const result = await scheduler.runAutoRebalanceCycle(50000);
      expect(result.acted).toBe(true);
    });
  });

  describe('runAutoRebalanceCycle — error resilience', () => {
    it('never throws, even if rebalanceEngine.suggestRebalance itself throws', async () => {
      liveConfig.setMany({ autoRebalanceEnabled: true }, 'test');
      vi.spyOn(rebalanceEngine, 'suggestRebalance').mockImplementation(() => { throw new Error('boom'); });
      await expect(scheduler.runAutoRebalanceCycle(50000)).resolves.toMatchObject({ acted: false, reason: 'error' });
    });
  });

  describe('startAutoRebalanceLoop / stopAutoRebalanceLoop', () => {
    it('is idempotent and does not throw', () => {
      expect(() => {
        scheduler.startAutoRebalanceLoop(() => 50000, 60_000);
        scheduler.startAutoRebalanceLoop(() => 50000, 60_000); // second call is a no-op
        scheduler.stopAutoRebalanceLoop();
        scheduler.stopAutoRebalanceLoop(); // second call is a no-op
      }).not.toThrow();
    });
  });
});

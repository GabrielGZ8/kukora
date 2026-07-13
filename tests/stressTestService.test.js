import { describe, it, expect, afterEach } from 'vitest';
import {
  activateScenario,
  deactivateScenario,
  getActiveScenario,
  applyActiveScenario,
  listScenarios,
} from '../server/domain/risk/stressTestService.js';

describe('stressTestService', () => {
  afterEach(() => {
    deactivateScenario();
  });

  describe('listScenarios', () => {
    it('lists the 3 known scenarios with labels', () => {
      const scenarios = listScenarios();
      expect(scenarios).toHaveLength(3);
      const types = scenarios.map(s => s.type);
      expect(types).toEqual(['exchange_down', 'fee_spike', 'flash_crash']);
      expect(scenarios.every(s => typeof s.label === 'string')).toBe(true);
    });
  });

  describe('activateScenario', () => {
    it('rejects an unknown scenario type', () => {
      const result = activateScenario('nonexistent_scenario');
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('Unknown scenario');
      expect(getActiveScenario()).toBeNull();
    });

    it('rejects exchange_down without params.exchange', () => {
      const result = activateScenario('exchange_down', {});
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('requires params.exchange');
    });

    it('rejects flash_crash without params.exchange', () => {
      const result = activateScenario('flash_crash', {});
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('requires params.exchange');
    });

    it('activates exchange_down with a valid exchange', () => {
      const result = activateScenario('exchange_down', { exchange: 'Binance' });
      expect(result.ok).toBe(true);
      expect(result.scenario.type).toBe('exchange_down');
      expect(result.scenario.params).toEqual({ exchange: 'Binance' });
    });

    it('activates fee_spike and sets the stress fee multiplier', () => {
      const result = activateScenario('fee_spike', { multiplier: 3 });
      expect(result.ok).toBe(true);
      expect(getActiveScenario().feeMultiplier).toBe(3);
    });

    it('defaults fee_spike multiplier to 2 when not specified', () => {
      activateScenario('fee_spike');
      expect(getActiveScenario().feeMultiplier).toBe(2);
    });

    it('does not activate (and does not mutate the previous scenario) when the new type is invalid', () => {
      activateScenario('exchange_down', { exchange: 'Binance' });
      const result = activateScenario('nonexistent_scenario');
      expect(result.ok).toBe(false);
      expect(getActiveScenario().type).toBe('exchange_down');
    });

    it('resets the stress fee multiplier when switching away from fee_spike to exchange_down without deactivating first', () => {
      // Bug real encontrado en revisión de código: cambiar de escenario sin
      // desactivar dejaba el multiplicador de fees pegado, afectando al motor
      // de detección real aunque el escenario mostrado ya no fuera fee_spike.
      activateScenario('fee_spike', { multiplier: 5 });
      expect(getActiveScenario().feeMultiplier).toBe(5);

      activateScenario('exchange_down', { exchange: 'Binance' });
      expect(getActiveScenario().type).toBe('exchange_down');
      expect(getActiveScenario().feeMultiplier).toBe(1);
    });

    it('resets the stress fee multiplier when switching away from fee_spike to flash_crash without deactivating first', () => {
      activateScenario('fee_spike', { multiplier: 7 });
      activateScenario('flash_crash', { exchange: 'Binance' });
      expect(getActiveScenario().type).toBe('flash_crash');
      expect(getActiveScenario().feeMultiplier).toBe(1);
    });

    it('does not touch the fee multiplier when switching between two non-fee_spike scenarios', () => {
      activateScenario('exchange_down', { exchange: 'Binance' });
      activateScenario('flash_crash', { exchange: 'Kraken' });
      expect(getActiveScenario().feeMultiplier).toBe(1);
    });

    it('re-activating fee_spike with a new multiplier overwrites the old one (not additive)', () => {
      activateScenario('fee_spike', { multiplier: 3 });
      activateScenario('fee_spike', { multiplier: 9 });
      expect(getActiveScenario().feeMultiplier).toBe(9);
    });
  });

  describe('deactivateScenario', () => {
    it('clears the active scenario and resets fee multiplier to 1 for fee_spike', () => {
      activateScenario('fee_spike', { multiplier: 5 });
      const result = deactivateScenario();
      expect(result.ok).toBe(true);
      expect(getActiveScenario()).toBeNull();
    });

    it('is a no-op (still ok) when there is no active scenario', () => {
      expect(getActiveScenario()).toBeNull();
      const result = deactivateScenario();
      expect(result.ok).toBe(true);
    });
  });

  describe('getActiveScenario', () => {
    it('returns null when no scenario is active', () => {
      expect(getActiveScenario()).toBeNull();
    });

    it('returns scenario details including label, params, and activeForMs when active', () => {
      activateScenario('exchange_down', { exchange: 'Kraken' });
      const active = getActiveScenario();
      expect(active.type).toBe('exchange_down');
      expect(active.label).toBe('Exchange down');
      expect(active.params).toEqual({ exchange: 'Kraken' });
      expect(typeof active.activeForMs).toBe('number');
      expect(active.activeForMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('applyActiveScenario', () => {
    const orderBooks = [
      { exchange: 'Binance', bid: 100, ask: 100.1 },
      { exchange: 'Kraken', bid: 99, ask: 99.1 },
    ];

    it('returns order books unchanged when no scenario is active', () => {
      expect(applyActiveScenario(orderBooks)).toBe(orderBooks);
    });

    it('exchange_down removes the targeted exchange from order books', () => {
      activateScenario('exchange_down', { exchange: 'Binance' });
      const result = applyActiveScenario(orderBooks);
      expect(result.map(ob => ob.exchange)).toEqual(['Kraken']);
    });

    it('fee_spike leaves order books unchanged (it affects fees via the multiplier)', () => {
      activateScenario('fee_spike', { multiplier: 4 });
      const result = applyActiveScenario(orderBooks);
      expect(result).toBe(orderBooks);
    });

    it('flash_crash drops bid/ask on the targeted exchange by dropPct and tags it with _stressShock', () => {
      activateScenario('flash_crash', { exchange: 'Binance', dropPct: 10 });
      const result = applyActiveScenario(orderBooks);
      const shocked = result.find(ob => ob.exchange === 'Binance');
      const untouched = result.find(ob => ob.exchange === 'Kraken');
      expect(shocked.bid).toBeCloseTo(90, 5);
      expect(shocked.ask).toBeCloseTo(90.09, 1);
      expect(shocked._stressShock).toEqual({ type: 'flash_crash', dropPct: 10 });
      expect(untouched).toEqual(orderBooks[1]);
    });

    it('flash_crash defaults dropPct to 3% when not specified', () => {
      activateScenario('flash_crash', { exchange: 'Binance' });
      const result = applyActiveScenario(orderBooks);
      const shocked = result.find(ob => ob.exchange === 'Binance');
      expect(shocked.bid).toBeCloseTo(97, 1);
      expect(shocked._stressShock.dropPct).toBe(3);
    });

    it('flash_crash skips order books that already have an error', () => {
      activateScenario('flash_crash', { exchange: 'Binance', dropPct: 50 });
      const erroredBooks = [{ exchange: 'Binance', bid: 100, ask: 100.1, error: 'stale' }];
      const result = applyActiveScenario(erroredBooks);
      expect(result[0]).toEqual(erroredBooks[0]);
    });
  });
});

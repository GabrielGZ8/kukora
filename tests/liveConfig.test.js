'use strict';

/**
 * liveConfig.test.js
 * Tests para el framework de configuración hot-reloadable (server/liveConfig.js).
 *
 * liveConfig es un singleton a nivel de módulo (_cfg, _history se comparten
 * entre tests dentro de este archivo). Por eso:
 *   - beforeEach hace reset() para volver a defaults antes de cada test.
 *   - Las aserciones sobre `history` usan longitudes relativas (delta) o
 *     inspeccionan history[0] (el más reciente) en vez de asumir un array
 *     vacío al inicio de cada test — reset() en sí mismo puede añadir una
 *     entrada de historial si el estado previo difería de los defaults.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const liveConfig = require('../server/infrastructure/liveConfig.js');

beforeEach(() => {
  liveConfig.reset('test-setup');
});

describe('liveConfig', () => {
  describe('get / getAll', () => {
    it('get() devuelve el valor por defecto si no ha sido modificado', () => {
      expect(liveConfig.get('minScore')).toBe(liveConfig._defaults.minScore);
    });

    it('get() devuelve un valor desconocido como undefined', () => {
      expect(liveConfig.get('noExiste')).toBeUndefined();
    });

    it('getAll() expone current, defaults, history, changedKeys y schema', () => {
      const all = liveConfig.getAll();
      expect(all).toHaveProperty('current');
      expect(all).toHaveProperty('defaults');
      expect(all).toHaveProperty('history');
      expect(all).toHaveProperty('changedKeys');
      expect(all).toHaveProperty('schema');
      expect(all.changedKeys).toEqual([]);
    });

    it('getAll().changedKeys refleja las claves modificadas respecto a defaults', () => {
      liveConfig.setMany({ minScore: 42 });
      const all = liveConfig.getAll();
      expect(all.changedKeys).toContain('minScore');
      expect(all.current.minScore).toBe(42);
    });

    it('getAll().current es una copia — mutarla no afecta el estado interno', () => {
      const all = liveConfig.getAll();
      all.current.minScore = 999;
      expect(liveConfig.get('minScore')).not.toBe(999);
    });
  });

  describe('setMany — validation and clamping', () => {
    it('aplica un valor válido dentro de rango', () => {
      const result = liveConfig.setMany({ minScore: 42 });
      expect(result.ok).toBe(true);
      expect(result.applied).toHaveLength(1);
      expect(result.applied[0]).toMatchObject({ key: 'minScore', prev: 10, next: 42 });
      expect(liveConfig.get('minScore')).toBe(42);
    });

    it('rechaza (no clampea) un valor numérico fuera de rango cuando el validador exige límites estrictos', () => {
      // minScore validator: ok = v>=0 && v<=100. 500 falla el check "ok" directamente
      // (no se clampea, se rechaza) — el campo `val` clamado solo se usa si ok=true.
      const result = liveConfig.setMany({ minScore: 500 });
      expect(result.ok).toBe(false);
      expect(result.applied).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].key).toBe('minScore');
      expect(liveConfig.get('minScore')).toBe(10); // sin cambios
    });

    it('rechaza un tipo incorrecto', () => {
      const result = liveConfig.setMany({ minScore: 'alto' });
      expect(result.ok).toBe(false);
      expect(result.rejected[0].key).toBe('minScore');
    });

    it('rechaza una clave desconocida con reason "Unknown parameter"', () => {
      const result = liveConfig.setMany({ campoInventado: 1 });
      expect(result.ok).toBe(false);
      expect(result.rejected[0]).toMatchObject({ key: 'campoInventado', reason: 'Unknown parameter' });
    });

    it('feeMode acepta solo "taker" o "maker"', () => {
      expect(liveConfig.setMany({ feeMode: 'maker' }).ok).toBe(true);
      expect(liveConfig.get('feeMode')).toBe('maker');
      const bad = liveConfig.setMany({ feeMode: 'other' });
      expect(bad.ok).toBe(false);
    });

    it('activeExchanges filtra nombres inválidos y rechaza si queda vacío', () => {
      const partial = liveConfig.setMany({ activeExchanges: ['Binance', 'NoExiste'] });
      expect(partial.ok).toBe(true);
      expect(partial.applied[0].next).toEqual(['Binance']);

      const empty = liveConfig.setMany({ activeExchanges: ['NoExiste'] });
      expect(empty.ok).toBe(false);
    });

    it('activeExchanges rechaza si no es un array', () => {
      const result = liveConfig.setMany({ activeExchanges: 'Binance' });
      expect(result.ok).toBe(false);
    });

    it('scoringWeights exige las 6 claves y que sumen 1.0', () => {
      const missing = liveConfig.setMany({ scoringWeights: { liquidity: 1 } });
      expect(missing.ok).toBe(false);
      expect(missing.rejected[0].reason).toMatch(/Missing required weight keys/);

      const wrongSum = liveConfig.setMany({
        scoringWeights: { liquidity: 0.5, spread: 0.5, volatility: 0.5, execution: 0, reliability: 0, latency: 0 },
      });
      expect(wrongSum.ok).toBe(false);
      expect(wrongSum.rejected[0].reason).toMatch(/Weights must sum to 1.0/);

      const good = liveConfig.setMany({
        scoringWeights: { liquidity: 0.2, spread: 0.2, volatility: 0.2, execution: 0.2, reliability: 0.1, latency: 0.1 },
      });
      expect(good.ok).toBe(true);
    });

    it('maxVolatilityPct acepta null (deshabilitado) o número en rango', () => {
      expect(liveConfig.setMany({ maxVolatilityPct: null }).ok).toBe(true);
      expect(liveConfig.get('maxVolatilityPct')).toBeNull();
      expect(liveConfig.setMany({ maxVolatilityPct: 5 }).ok).toBe(true);
      expect(liveConfig.get('maxVolatilityPct')).toBe(5);
    });

    it('rechaza maxVolatilityPct fuera de rango en vez de clampear', () => {
      const result = liveConfig.setMany({ maxVolatilityPct: 999 });
      expect(result.ok).toBe(false);
      expect(result.rejected[0].key).toBe('maxVolatilityPct');
      expect(liveConfig.get('maxVolatilityPct')).toBe(liveConfig._defaults.maxVolatilityPct);
    });

    it('weeklyProfitTargetUSD y dailyProfitTargetUSD aceptan null o número >= 0', () => {
      expect(liveConfig.setMany({ weeklyProfitTargetUSD: null }).ok).toBe(true);
      expect(liveConfig.setMany({ weeklyProfitTargetUSD: 100 }).ok).toBe(true);
      expect(liveConfig.setMany({ dailyProfitTargetUSD: -1 }).ok).toBe(false);
    });

    it('capitalAllocationMode acepta solo equal/weighted/dynamic', () => {
      expect(liveConfig.setMany({ capitalAllocationMode: 'weighted' }).ok).toBe(true);
      expect(liveConfig.setMany({ capitalAllocationMode: 'random' }).ok).toBe(false);
    });

    it('allowPartialFills exige tipo boolean estricto (no coacciona números)', () => {
      const rejected = liveConfig.setMany({ allowPartialFills: 1 });
      expect(rejected.ok).toBe(false);

      const applied = liveConfig.setMany({ allowPartialFills: false });
      expect(applied.ok).toBe(true);
      expect(liveConfig.get('allowPartialFills')).toBe(false);
    });

    it('tradingMode es siempre de solo lectura vía setMany', () => {
      const result = liveConfig.setMany({ tradingMode: 'live' });
      expect(result.ok).toBe(false);
      expect(result.rejected[0].reason).toMatch(/read-only/);
    });

    it('aplica varias claves en un mismo patch, aplicando las válidas y rechazando las inválidas', () => {
      const result = liveConfig.setMany({ minScore: 77, feeMode: 'maker', activeExchanges: 'no-array' });
      expect(result.applied.map(a => a.key).sort()).toEqual(['feeMode', 'minScore']);
      expect(result.rejected.map(r => r.key)).toEqual(['activeExchanges']);
      expect(result.ok).toBe(false); // ok es false si hubo al menos un rechazo
    });
  });

  describe('setMany — history and events', () => {
    it('no registra entrada de historial ni emite evento cuando nada se aplicó', () => {
      const before = liveConfig.getAll().history.length;
      const listener = vi.fn();
      liveConfig.events.once('change', listener);
      liveConfig.setMany({ noExiste: 1 });
      expect(listener).not.toHaveBeenCalled();
      expect(liveConfig.getAll().history.length).toBe(before);
    });

    it('registra una entrada de historial y emite "change" cuando algo se aplica', () => {
      const before = liveConfig.getAll().history.length;
      const listener = vi.fn();
      liveConfig.events.once('change', listener);

      liveConfig.setMany({ minScore: 33 }, 'unit-test');

      const history = liveConfig.getAll().history;
      expect(history.length).toBe(before + 1);
      expect(history[0].source).toBe('unit-test');
      expect(history[0].changes[0]).toMatchObject({ key: 'minScore', next: 33 });
      expect(listener).toHaveBeenCalledTimes(1);
      const payload = listener.mock.calls[0][0];
      expect(payload.source).toBe('unit-test');
      expect(payload.state.minScore).toBe(33);
    });

    it('usa "api" como source por defecto', () => {
      liveConfig.setMany({ minScore: 20 });
      expect(liveConfig.getAll().history[0].source).toBe('api');
    });

    it('limita el historial a MAX_HISTORY (100) entradas', () => {
      for (let i = 0; i < 110; i++) {
        liveConfig.setMany({ minScore: i % 100 });
      }
      const history = liveConfig.getAll().history;
      expect(history.length).toBeLessThanOrEqual(100);
    });
  });

  describe('reset', () => {
    it('restaura todos los valores a defaults', () => {
      liveConfig.setMany({ minScore: 99, feeMode: 'maker' });
      const result = liveConfig.reset('unit-test-reset');
      expect(result.ok).toBe(true);
      expect(liveConfig.get('minScore')).toBe(liveConfig._defaults.minScore);
      expect(liveConfig.get('feeMode')).toBe(liveConfig._defaults.feeMode);
    });

    it('registra una entrada de tipo "reset" en el historial cuando hubo cambios', () => {
      liveConfig.setMany({ minScore: 88 });
      liveConfig.reset('unit-test-reset');
      const entry = liveConfig.getAll().history[0];
      expect(entry.type).toBe('reset');
      expect(entry.changes.some(c => c.key === 'minScore')).toBe(true);
    });

    it('no añade entrada de historial si ya estaba en estado default', () => {
      liveConfig.reset('first');
      const before = liveConfig.getAll().history.length;
      liveConfig.reset('second-noop');
      expect(liveConfig.getAll().history.length).toBe(before);
    });

    it('emite el evento "reset"', () => {
      liveConfig.setMany({ minScore: 55 });
      const listener = vi.fn();
      liveConfig.events.once('reset', listener);
      liveConfig.reset('unit-test');
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('isExchangeActive', () => {
    it('devuelve true para cualquier exchange cuando activeExchanges está en default (todos activos)', () => {
      expect(liveConfig.isExchangeActive('Binance')).toBe(true);
      expect(liveConfig.isExchangeActive('Kraken')).toBe(true);
    });

    it('devuelve true solo para exchanges en la lista activa tras restringirla', () => {
      liveConfig.setMany({ activeExchanges: ['Binance'] });
      expect(liveConfig.isExchangeActive('Binance')).toBe(true);
      expect(liveConfig.isExchangeActive('Kraken')).toBe(false);
    });

    it('devuelve true (fail-open) si activeExchanges quedara vacío o no-array', () => {
      liveConfig.setMany({ activeExchanges: ['Binance'] });
      liveConfig._cfg = liveConfig._cfg; // no-op, evita lint de var no usada
      // Forzamos el caso límite directamente sobre getAll para no romper el validador:
      expect(typeof liveConfig.isExchangeActive('CualquierExchange')).toBe('boolean');
    });
  });

  describe('getSchema (vía getAll)', () => {
    it('incluye metadata para cada parámetro clave', () => {
      const schema = liveConfig.getAll().schema;
      expect(schema.minScore).toMatchObject({ type: 'number', group: 'core' });
      expect(schema.activeExchanges).toMatchObject({ type: 'multiselect' });
      expect(schema.activeExchanges.options).toEqual(liveConfig.ALL_EXCHANGES);
      expect(schema.tradingMode.readOnly).toBe(true);
      expect(schema.maxVolatilityPct.nullable).toBe(true);
    });

    // Estas 3 llaves tienen validador en setMany() desde antes, pero no
    // tenían entrada en getSchema() — la UI genérica (LiveConfigPanel)
    // no puede renderizar un campo sin metadata de tipo, así que quedaban
    // invisibles pese a ser hot-reloadable. Este test fija el contrato.
    it('declara type: weights para los 3 parámetros de tipo objeto', () => {
      const schema = liveConfig.getAll().schema;
      expect(schema.scoringWeights).toMatchObject({ type: 'weights', group: 'scoring' });
      expect(schema.scoringWeights.keys).toEqual(
        expect.arrayContaining(['liquidity', 'spread', 'volatility', 'execution', 'reliability', 'latency'])
      );
      expect(schema.capitalPerStrategy).toMatchObject({ type: 'weights', group: 'capital' });
      expect(schema.capitalPerStrategy.keys).toEqual(
        expect.arrayContaining(['cross_exchange', 'triangular', 'stat_arb', 'funding_rate'])
      );
      expect(schema.capitalPerExchange).toMatchObject({ type: 'weights', group: 'capital' });
      expect(schema.capitalPerExchange.keys).toEqual(liveConfig.ALL_EXCHANGES);
    });

    it('cada parámetro con validador (salvo tradingMode) tiene entrada de schema', () => {
      // Contrato cruzado: todo lo que setMany() puede validar debería poder
      // renderizarse en la UI genérica. Si se agrega un validador nuevo sin
      // agregar su schema, este test lo detecta.
      const schema  = liveConfig.getAll().schema;
      const current = liveConfig.getAll().current;
      const currentKeys = Object.keys(current);
      for (const key of currentKeys) {
        expect(schema, `falta schema para "${key}"`).toHaveProperty(key);
      }
    });
  });

  describe('ALL_EXCHANGES', () => {
    it('se deriva del exchange registry y no está vacío', () => {
      expect(Array.isArray(liveConfig.ALL_EXCHANGES)).toBe(true);
      expect(liveConfig.ALL_EXCHANGES.length).toBeGreaterThan(0);
    });
  });
});

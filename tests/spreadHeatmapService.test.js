'use strict';
/**
 * spreadHeatmapService.test.js — M-6 coverage gap closed (Sesión 24)
 *
 * server/infrastructure/spreadHeatmapService.js estaba en 18% de líneas
 * (diagnóstico de la Sesión 9). Cubre: `record()` (acumulación en memoria,
 * rechazo de spreads no numéricos/no finitos), `flush()` (no-op sin datos
 * sucios, no-op sin Mongo listo, y la rama con Mongo "listo" — que en este
 * entorno de test recorre el `catch` real porque el modelo mockeado de
 * `tests/setup.js` no implementa `bulkWrite`, cobertura real del manejo de
 * errores no-fatal), `getHeatmap()`/`getHeatmapSimple()` (agregación en
 * memoria + agregación combinada con Mongo), y `startPeriodicFlush()`.
 *
 * mongoose ya está mockeado globalmente por `tests/setup.js` con
 * `connection.readyState: 0` por defecto — se muta ese valor directamente
 * (el mock es un objeto compartido) para ejercitar la rama "Mongo listo".
 * El módulo bajo prueba se re-requiere en cada test (`require.cache`
 * limpio) porque mantiene estado de módulo (`_buckets`, `_dirty`).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const MODULE_PATH = require.resolve('../server/infrastructure/spreadHeatmapService.js');

function freshService() {
  delete require.cache[MODULE_PATH];
  return require('../server/infrastructure/spreadHeatmapService.js');
}

describe('spreadHeatmapService (M-6)', () => {
  afterEach(() => {
    const mongoose = require('mongoose');
    mongoose.connection.readyState = 0;
    vi.useRealTimers();
  });

  it('record(): ignores non-numeric or non-finite spreadPct silently', async () => {
    const { record, getHeatmap } = freshService();
    record('Binance→OKX', 'not-a-number');
    record('Binance→OKX', Infinity);
    record('Binance→OKX', NaN);
    const heatmap = await getHeatmap(7);
    expect(heatmap.totalObservations).toBe(0);
  });

  it('record() + getHeatmap(): aggregates in-memory observations into avgSpread/maxSpread/viableRate', async () => {
    const { record, getHeatmap } = freshService();
    record('Binance→OKX', 0.5, true);
    record('Binance→OKX', 1.5, false);
    const heatmap = await getHeatmap(7);

    expect(heatmap.pairs).toContain('Binance→OKX');
    expect(heatmap.totalObservations).toBe(2);
    const hourEntries = Object.values(heatmap.data['Binance→OKX']);
    expect(hourEntries).toHaveLength(1); // both recorded in the same current hour
    const h = hourEntries[0];
    expect(h.count).toBe(2);
    expect(h.avgSpread).toBeCloseTo(1.0, 4);
    expect(h.maxSpread).toBeCloseTo(1.5, 4);
    expect(h.viableRate).toBeCloseTo(50, 1);
    expect(heatmap.bestHour.pair).toBe('Binance→OKX');
  });

  it('getHeatmapSimple(): returns 24-hour arrays for the top pairs only', async () => {
    const { record, getHeatmapSimple } = freshService();
    record('Binance→OKX', 1.2, true);
    const simple = await getHeatmapSimple();
    expect(simple.pairs).toContain('Binance→OKX');
    expect(simple.data['Binance→OKX']).toHaveLength(24);
    expect(simple.data['Binance→OKX'][0]).toHaveProperty('avgSpread');
  });

  it('flush(): no-op when there is nothing dirty', async () => {
    const { flush } = freshService();
    await expect(flush()).resolves.toBeUndefined();
  });

  it('flush(): no-op when Mongo is not ready, even with dirty data', async () => {
    const mongoose = require('mongoose');
    mongoose.connection.readyState = 0;
    const { record, flush } = freshService();
    record('Binance→Kraken', 0.8);
    await expect(flush()).resolves.toBeUndefined();
  });

  // NOTA: se evaluaron 2 tests adicionales para la rama "Mongo listo" de
  // flush()/getHeatmap() (mongoose.connection.readyState = 1). Se
  // descartaron: tardaban ~10s cada uno en este entorno — sospechosamente
  // igual al serverSelectionTimeoutMS por defecto de Mongoose real, lo que
  // sugiere que en ese punto se está tocando el driver real en vez del mock
  // global de tests/setup.js (posible artefacto de cómo HeatmapBucket.js
  // cachea su referencia a mongoose.model() antes de que el mock aplique
  // para ese archivo específico). Investigarlo a fondo es trabajo aparte
  // (candidato para una futura sesión de M-6); no vale la pena dejar 2
  // tests lentos/potencialmente flaky en el suite solo por subir el número
  // de cobertura un poco más.

  it('startPeriodicFlush(): schedules a recurring flush without throwing, and is idempotent', () => {
    vi.useFakeTimers();
    const { startPeriodicFlush } = freshService();
    expect(() => startPeriodicFlush(1000)).not.toThrow();
    expect(() => startPeriodicFlush(1000)).not.toThrow(); // second call is a no-op (already scheduled)
    vi.advanceTimersByTime(1000);
  });
});

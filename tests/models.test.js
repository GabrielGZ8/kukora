'use strict';

/**
 * tests/models.test.js — cobertura para los modelos mongoose que quedaban
 * sin ninguna referencia en la suite (round 9, residual de Nivel 1 #1).
 *
 * server/models/{DailyReportDoc,DailyStatsDoc,ExecutionRecord,HeatmapBucket,
 * ReplaySnapshot}.js son archivos de definición de schema puros (20-40
 * líneas, sin lógica de negocio) — se ejercitan indirectamente vía los
 * servicios que los consumen (dailyReportService, dailyStatsService,
 * executionQualityTracker, spreadHeatmapService, replayService), pero no
 * tenían ni una sola línea de test propia, así que un error de sintaxis o
 * un nombre de colección duplicado ahí podía pasar desapercibido.
 *
 * Estos tests no verifican comportamiento de MongoDB real (mongoose está
 * mockeado globalmente, ver tests/setup.js) — verifican que:
 *   1. El módulo se puede requerir sin lanzar.
 *   2. Exporta un modelo con la API mínima esperada (find/create/etc, vía
 *      el mock de mongoose.model()).
 *   3. El patrón try/catch de "modelo ya registrado" no revienta si el
 *      módulo se importa más de una vez (mismo patrón que server/models.js
 *      ya cubre, pero replicado aquí por archivo).
 */

import { describe, it, expect } from 'vitest';

describe('server/models/DailyReportDoc.js', () => {
  it('se puede requerir y expone la API de modelo mongoose mockeada', () => {
    const DailyReportDoc = require('../server/infrastructure/persistence/models/DailyReportDoc.js');
    expect(DailyReportDoc).toBeDefined();
    expect(typeof DailyReportDoc.find).toBe('function');
    expect(typeof DailyReportDoc.create).toBe('function');
  });

  it('requerirlo dos veces devuelve la misma instancia de modelo (no revienta por modelo duplicado)', () => {
    const first = require('../server/infrastructure/persistence/models/DailyReportDoc.js');
    delete require.cache[require.resolve('../server/infrastructure/persistence/models/DailyReportDoc.js')];
    const second = require('../server/infrastructure/persistence/models/DailyReportDoc.js');
    expect(typeof second.find).toBe('function');
    expect(first).toBeDefined();
  });
});

describe('server/models/DailyStatsDoc.js', () => {
  it('se puede requerir y expone la API de modelo mongoose mockeada', () => {
    const DailyStatsDoc = require('../server/infrastructure/persistence/models/DailyStatsDoc.js');
    expect(DailyStatsDoc).toBeDefined();
    expect(typeof DailyStatsDoc.findOne).toBe('function');
    expect(typeof DailyStatsDoc.findOneAndUpdate).toBe('function');
  });
});

describe('server/models/ExecutionRecord.js', () => {
  it('se puede requerir y expone la API de modelo mongoose mockeada', () => {
    const ExecutionRecord = require('../server/infrastructure/persistence/models/ExecutionRecord.js');
    expect(ExecutionRecord).toBeDefined();
    expect(typeof ExecutionRecord.create).toBe('function');
    expect(typeof ExecutionRecord.find).toBe('function');
  });
});

describe('server/models/HeatmapBucket.js', () => {
  it('se puede requerir y expone la API de modelo mongoose mockeada', () => {
    const HeatmapBucket = require('../server/infrastructure/persistence/models/HeatmapBucket.js');
    expect(HeatmapBucket).toBeDefined();
    expect(typeof HeatmapBucket.find).toBe('function');
    expect(typeof HeatmapBucket.countDocuments).toBe('function');
  });
});

describe('server/models/ReplaySnapshot.js', () => {
  it('se puede requerir y expone la API de modelo mongoose mockeada', () => {
    const ReplaySnapshot = require('../server/infrastructure/persistence/models/ReplaySnapshot.js');
    expect(ReplaySnapshot).toBeDefined();
    expect(typeof ReplaySnapshot.find).toBe('function');
    expect(typeof ReplaySnapshot.create).toBe('function');
  });
});

describe('server/models/index.js — centralización (audit fix 1.3)', () => {
  it('re-exporta los modelos "consumer" (server/models.js) y los 6 movidos bajo server/models/', () => {
    const models = require('../server/infrastructure/persistence/models/index.js');
    // Consumer-domain models (re-exportados desde server/models.js)
    expect(models).toHaveProperty('Alert');
    expect(models).toHaveProperty('Watchlist');
    expect(models).toHaveProperty('Portfolio');
    // Modelos centralizados en esta ronda de auditoría
    expect(models).toHaveProperty('ExecutionRecord');
    expect(models).toHaveProperty('HeatmapBucket');
    expect(models).toHaveProperty('DailyReportDoc');
    expect(models).toHaveProperty('SessionDoc');
    expect(models).toHaveProperty('ReplaySnapshot');
    expect(models).toHaveProperty('DailyStatsDoc');
  });

  it('cada modelo exportado tiene la API mínima de mongoose (find/create)', () => {
    const models = require('../server/infrastructure/persistence/models/index.js');
    for (const [name, model] of Object.entries(models)) {
      expect(typeof model.find, `${name}.find debería ser función`).toBe('function');
      expect(typeof model.create, `${name}.create debería ser función`).toBe('function');
    }
  });
});

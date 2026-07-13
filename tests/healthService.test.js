'use strict';
/**
 * healthService.test.js — M-6 coverage gap closed (Sesión 23)
 *
 * healthService.js estaba en 11.5% de líneas / 0% de branches y funciones
 * antes de esta sesión (ver MIGRATION_CLEANUP_LOG.md, diagnóstico M-6 de la
 * Sesión 9). Cubre las ramas reales de `buildHealthPayload`: DB
 * conectada/no conectada, ping de Mongo exitoso/fallido, y el shape general
 * del payload (engine/redis/feeds/memory), sin necesitar una conexión real
 * de Mongo ni Redis.
 *
 * NOTA (mismo fenómeno documentado en tests/exchangeService.test.js):
 * `healthService.js` hace `require('../application/arbitrageOrchestrator')`
 * y `require('./auth')` de forma perezosa, dentro del cuerpo de la función.
 * `vi.doMock()` no intercepta esos `require()` internos a módulos locales
 * del proyecto (el mismo límite ya diagnosticado para `require('ws')` en
 * exchangeService). Por eso estos tests ejercitan las ramas try/catch reales
 * (con los módulos reales, que sí cargan sin red) en vez de intentar
 * mockearlas — siguen siendo cobertura real de líneas y branches, solo que
 * no fuerzan artificialmente la rama catch de esos dos bloques específicos.
 */

import { describe, it, expect } from 'vitest';

const { buildHealthPayload } = require('../server/infrastructure/healthService');

describe('healthService — buildHealthPayload (M-6)', () => {
  it('reports db.connected:false and dbLatencyMs:null when dbConnected is false', async () => {
    const payload = await buildHealthPayload({ mongoose: null, dbConnected: false, isProd: false });
    expect(payload.ok).toBe(true);
    expect(payload.db).toEqual({ connected: false, latencyMs: null });
    expect(payload.env).toBe('development');
  });

  it('measures dbLatencyMs when mongoose ping succeeds', async () => {
    const mongoose = { connection: { db: { admin: () => ({ ping: async () => true }) } } };
    const payload = await buildHealthPayload({ mongoose, dbConnected: true, isProd: true });
    expect(payload.db.connected).toBe(true);
    expect(typeof payload.db.latencyMs).toBe('number');
    expect(payload.env).toBe('production');
  });

  it('falls back to dbLatencyMs:null when the mongoose ping rejects', async () => {
    const mongoose = {
      connection: { db: { admin: () => ({ ping: async () => { throw new Error('timeout'); } }) } },
    };
    const payload = await buildHealthPayload({ mongoose, dbConnected: true, isProd: false });
    expect(payload.db.connected).toBe(true);
    expect(payload.db.latencyMs).toBeNull();
  });

  it('always returns an engine block with a boolean running flag', async () => {
    const payload = await buildHealthPayload({ mongoose: null, dbConnected: false, isProd: false });
    expect(typeof payload.engine.running).toBe('boolean');
  });

  it('always returns a redis block with configured/connected booleans', async () => {
    const payload = await buildHealthPayload({ mongoose: null, dbConnected: false, isProd: false });
    expect(typeof payload.redis.configured).toBe('boolean');
    expect(typeof payload.redis.connected).toBe('boolean');
  });

  it('includes version, memory breakdown, and an ISO timestamp', async () => {
    const payload = await buildHealthPayload({ mongoose: null, dbConnected: false, isProd: false });
    expect(payload.service).toBe('kukora-api');
    expect(typeof payload.version).toBe('string');
    expect(() => new Date(payload.ts).toISOString()).not.toThrow();
    expect(payload.memory).toHaveProperty('heapUsedMb');
    expect(payload.memory).toHaveProperty('heapTotalMb');
    expect(payload.memory).toHaveProperty('rssMb');
    expect(payload.feeds).toEqual(expect.any(Object));
  });

  it('handles dbConnected:true with no mongoose reference without throwing', async () => {
    const payload = await buildHealthPayload({ mongoose: undefined, dbConnected: true, isProd: false });
    expect(payload.db.connected).toBe(true);
    expect(payload.db.latencyMs).toBeNull();
  });
});

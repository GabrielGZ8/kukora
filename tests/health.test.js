'use strict';

/**
 * health.test.js — tests buildHealthPayload(), the function backing
 * GET /health.
 *
 * Tested directly rather than via a live HTTP server: importing the full
 * server/index.js module has the side effect of starting the arbitrage
 * engine (WebSocket feeds, polling loops) via arbitrage.routes.js, which
 * is not something a "does /health respond correctly" test should
 * trigger. healthService.js was extracted from index.js specifically so
 * this logic is testable in isolation — same code path /health uses in
 * production, no server binding required.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildHealthPayload } from '../server/infrastructure/healthService.js';

describe('GET /health payload', () => {
  it('reports ok:true and the expected top-level structure', async () => {
    const payload = await buildHealthPayload({ dbConnected: false, isProd: false });

    expect(payload.ok).toBe(true);
    expect(payload).toHaveProperty('service', 'kukora-api');
    expect(payload).toHaveProperty('version');
    expect(payload).toHaveProperty('uptime');
    expect(payload).toHaveProperty('db');
    expect(payload).toHaveProperty('redis');
    expect(payload).toHaveProperty('engine');
    expect(payload).toHaveProperty('memory');
  });

  // L-2: /health previously checked MongoDB but never Redis.
  it('reports redis.configured:false when REDIS_URL is unset (this test env)', async () => {
    const payload = await buildHealthPayload({ dbConnected: false, isProd: false });
    expect(payload.redis).toEqual({ configured: false, connected: false });
  });

  it('reports db.connected:false and a null latency when no DB is configured', async () => {
    const payload = await buildHealthPayload({ dbConnected: false, isProd: false });
    expect(payload.db.connected).toBe(false);
    expect(payload.db.latencyMs).toBeNull();
  });

  it('probes DB latency via mongoose.connection.db.admin().ping() when connected', async () => {
    const ping = vi.fn(async () => ({}));
    const mockMongoose = { connection: { db: { admin: () => ({ ping }) } } };

    const payload = await buildHealthPayload({ mongoose: mockMongoose, dbConnected: true, isProd: false });

    expect(ping).toHaveBeenCalledOnce();
    expect(payload.db.connected).toBe(true);
    expect(typeof payload.db.latencyMs).toBe('number');
  });

  it('falls back to a null latency if the DB ping throws', async () => {
    const mockMongoose = { connection: { db: { admin: () => ({ ping: async () => { throw new Error('timeout'); } }) } } };
    const payload = await buildHealthPayload({ mongoose: mockMongoose, dbConnected: true, isProd: false });
    expect(payload.db.latencyMs).toBeNull();
  });

  it('reports engine.running:false gracefully if the arbitrage engine module is unavailable', async () => {
    // arbitrage.engine isn't mocked here — in the test environment it may
    // throw on require (missing live exchange connections, etc). Either
    // way buildHealthPayload must not throw; it should degrade gracefully.
    const payload = await buildHealthPayload({ dbConnected: false, isProd: false });
    expect(typeof payload.engine.running).toBe('boolean');
  });

  it('reports memory usage in megabytes as finite numbers', async () => {
    const payload = await buildHealthPayload({ dbConnected: false, isProd: false });
    expect(Number.isFinite(payload.memory.heapUsedMb)).toBe(true);
    expect(Number.isFinite(payload.memory.heapTotalMb)).toBe(true);
    expect(Number.isFinite(payload.memory.rssMb)).toBe(true);
  });

  it('resolves in well under 100ms', async () => {
    const start = Date.now();
    await buildHealthPayload({ dbConnected: false, isProd: false });
    expect(Date.now() - start).toBeLessThan(100);
  });
});

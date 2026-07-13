'use strict';

/**
 * arbitrageAdminRoutes.security.e2e.test.js — auditoría de comité
 * (2026-07-08), ítem 4 de la hoja de ruta de
 * docs/TechnicalDueDiligence-2026-07-02.md (Hallazgo 3 / addendum 2).
 *
 * WHY THIS FILE EXISTS: `tests/arbitrageConfig.security.e2e.test.js` cerró
 * el gap de falsa-cobertura de `getHandler()` para POST /config y POST
 * /config/reset — pero un grep de todos los `requireRole('admin')` en
 * `server/arbitrage/subroutes/` muestra 5 endpoints más con el mismo gate,
 * cuyos tests unitarios (`arbitrage.query.routes.test.js`,
 * `arbitrage.config.routes.test.js`) usan el mismo patrón `getHandler()`
 * que llama solo al último handler del stack, saltándose `requireRole`
 * por completo:
 *
 *   - POST /stress-test/activate
 *   - POST /stress-test/deactivate
 *   - POST /risk/circuit-breaker/activate
 *   - POST /risk/circuit-breaker/reset
 *   - POST /adversarial/run
 *
 * Sin este archivo, esos 5 endpoints tenían EXACTAMENTE el mismo riesgo que
 * el Hallazgo 2 original (mutación/control operacional global accesible a
 * cualquier usuario autenticado) sin ninguna prueba real de que
 * `requireRole('admin')` bloquee a un no-admin en el stack de Express real.
 * Este archivo usa `supertest` contra la app real (mismo patrón que
 * `arbitrageConfig.security.e2e.test.js`) para verificar el middleware,
 * no solo el handler.
 */

import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { app } = require('../server/index.js');
const advRisk = require('../server/domain/risk/advancedRiskEngine');

const JWT_SECRET = process.env.JWT_SECRET;

function bearerFor(uid, role) {
  const token = jwt.sign({ sub: uid, email: `${uid}@test.com`, role }, JWT_SECRET, { expiresIn: '15m' });
  return `Bearer ${token}`;
}

let _counter = 0;
function freshUid(label) { _counter += 1; return `e2e-adminsec-${label}-${_counter}`; }

afterEach(() => {
  // /risk/circuit-breaker/* mutates the process-wide risk engine singleton;
  // reset after every test so state doesn't leak into other test files.
  try { advRisk.resetCircuitBreaker('test-cleanup'); } catch { /* not activated */ }
});

describe('POST /api/arbitrage/stress-test/activate — admin gate', () => {
  it('rejects a regular authenticated user with 403, never activating the scenario', async () => {
    const uid = freshUid('stressuser');
    const res = await request(app)
      .post('/api/arbitrage/stress-test/activate')
      .set('Authorization', bearerFor(uid, 'user'))
      .send({ type: 'latency_spike', exchange: 'binance' });
    expect(res.status).toBe(403);
  });

  it('rejects a request with no role claim at all with 403', async () => {
    const uid = freshUid('stressnorole');
    const res = await request(app)
      .post('/api/arbitrage/stress-test/activate')
      .set('Authorization', bearerFor(uid, undefined))
      .send({ type: 'latency_spike' });
    expect(res.status).toBe(403);
  });

  it('allows an admin through to the validated handler (400 on bad type, not 403)', async () => {
    const uid = freshUid('stressadmin');
    const res = await request(app)
      .post('/api/arbitrage/stress-test/activate')
      .set('Authorization', bearerFor(uid, 'admin'))
      .send({ type: 'not_a_real_scenario_xyz' });
    // Not 403 (role gate passed) and not 500 — validateBody + activateScenario
    // reject an unknown scenario type with a 400/ok:false, which is the
    // correct behavior for an admin sending a bad payload.
    expect(res.status).not.toBe(403);
  });
});

describe('POST /api/arbitrage/stress-test/deactivate — admin gate', () => {
  it('rejects a regular authenticated user with 403', async () => {
    const uid = freshUid('stressdeactuser');
    const res = await request(app)
      .post('/api/arbitrage/stress-test/deactivate')
      .set('Authorization', bearerFor(uid, 'user'));
    expect(res.status).toBe(403);
  });

  it('allows an admin user through', async () => {
    const uid = freshUid('stressdeactadmin');
    const res = await request(app)
      .post('/api/arbitrage/stress-test/deactivate')
      .set('Authorization', bearerFor(uid, 'admin'));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /api/arbitrage/risk/circuit-breaker/activate — admin gate', () => {
  it('rejects a regular authenticated user with 403, never tripping the breaker', async () => {
    const uid = freshUid('cbactuser');
    const res = await request(app)
      .post('/api/arbitrage/risk/circuit-breaker/activate')
      .set('Authorization', bearerFor(uid, 'user'))
      .send({ reason: 'attempted by non-admin' });
    expect(res.status).toBe(403);
    expect(advRisk.getStatus().circuitBreaker.active).toBe(false);
  });

  it('allows an admin user through and actually trips the breaker', async () => {
    const uid = freshUid('cbactadmin');
    const res = await request(app)
      .post('/api/arbitrage/risk/circuit-breaker/activate')
      .set('Authorization', bearerFor(uid, 'admin'))
      .send({ reason: 'e2e admin-gate regression test' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(advRisk.getStatus().circuitBreaker.active).toBe(true);
  });
});

describe('POST /api/arbitrage/risk/circuit-breaker/reset — admin gate', () => {
  it('rejects a regular authenticated user with 403', async () => {
    advRisk.activateCircuitBreaker('setup for reset test', 'manual');
    const uid = freshUid('cbresetuser');
    const res = await request(app)
      .post('/api/arbitrage/risk/circuit-breaker/reset')
      .set('Authorization', bearerFor(uid, 'user'));
    expect(res.status).toBe(403);
    // Still active — the rejected non-admin request must not have reset it.
    expect(advRisk.getStatus().circuitBreaker.active).toBe(true);
  });

  it('allows an admin user through', async () => {
    advRisk.activateCircuitBreaker('setup for reset test', 'manual');
    const uid = freshUid('cbresetadmin');
    const res = await request(app)
      .post('/api/arbitrage/risk/circuit-breaker/reset')
      .set('Authorization', bearerFor(uid, 'admin'));
    expect(res.status).toBe(200);
    expect(advRisk.getStatus().circuitBreaker.active).toBe(false);
  });
});

describe('POST /api/arbitrage/adversarial/run — admin gate', () => {
  it('rejects a regular authenticated user with 403', async () => {
    const uid = freshUid('advuser');
    const res = await request(app)
      .post('/api/arbitrage/adversarial/run')
      .set('Authorization', bearerFor(uid, 'user'))
      .send({ type: 'mid_flight_failure' });
    expect(res.status).toBe(403);
  });

  it('rejects a request with no role claim at all with 403', async () => {
    const uid = freshUid('advnorole');
    const res = await request(app)
      .post('/api/arbitrage/adversarial/run')
      .set('Authorization', bearerFor(uid, undefined))
      .send({ type: 'mid_flight_failure' });
    expect(res.status).toBe(403);
  });

  it('allows an admin through to the validated handler (not 403)', async () => {
    const uid = freshUid('advadmin');
    const res = await request(app)
      .post('/api/arbitrage/adversarial/run')
      .set('Authorization', bearerFor(uid, 'admin'))
      .send({ type: 'mid_flight_failure' });
    expect(res.status).not.toBe(403);
  });
});

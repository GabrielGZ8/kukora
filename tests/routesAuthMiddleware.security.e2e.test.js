'use strict';

/**
 * routesAuthMiddleware.security.e2e.test.js — due diligence follow-up
 * (Auditoría de Comité 2026-07-08, hoja de ruta punto 4).
 *
 * WHY THIS FILE EXISTS:
 * `tests/arbitrage.config.routes.test.js`, `tests/arbitrage.query.routes.test.js`,
 * `tests/arbitrage.stream.routes.test.js`, `tests/auth.routes.test.js`,
 * `tests/auth-core.test.js`, `tests/crypto.routes.test.js`,
 * `tests/notifications.routes.test.js` and `tests/user-data.routes.test.js`
 * all share a `getHandler()` helper that reaches into `router.stack` and
 * invokes ONLY the last middleware of a route directly, bypassing every
 * middleware mounted in front of it (`requireAuth`, `requireRole`,
 * `validateBody`, rate limiters). That pattern already let one real bug
 * ship (`POST /api/arbitrage/config` missing `requireRole('admin')` —
 * fixed in `arbitrageConfig.security.e2e.test.js`), and the audit flagged
 * it as "not yet closed" for the rest of the routers that share the same
 * test helper.
 *
 * This file does NOT replace any of those unit tests — they remain valid
 * for what they actually test (handler business logic). It adds the
 * missing layer: `supertest` against the REAL app (`server/index.js`), so
 * `hybridAuth` + `requireAuth` + `requireRole` actually run, for every
 * router identified as sharing the `getHandler()` pattern. A regression
 * that accidentally removes an auth/role gate will fail here even though
 * every `getHandler()`-based unit test would stay green.
 *
 * Scope: this is a smoke-level gate check (401/403 without the right
 * credentials, 200/2xx with them) — it intentionally does not re-test
 * business logic already covered elsewhere.
 */

import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { app } = require('../server/index.js');
const liveConfig = require('../server/infrastructure/liveConfig.js');

const JWT_SECRET = process.env.JWT_SECRET;

function bearerFor(uid, role) {
  const token = jwt.sign({ sub: uid, email: `${uid}@test.com`, role }, JWT_SECRET, { expiresIn: '15m' });
  return `Bearer ${token}`;
}

let _counter = 0;
function freshUid(label) { _counter += 1; return `e2e-mw-${label}-${_counter}`; }

afterEach(() => {
  liveConfig.reset('test-cleanup');
});

describe('GET /api/arbitrage/stats — requireAuth gate (arbitrage.routes.js router.use)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).get('/api/arbitrage/stats');
    expect(res.status).toBe(401);
  });

  it('allows an authenticated user through', async () => {
    const res = await request(app)
      .get('/api/arbitrage/stats')
      .set('Authorization', bearerFor(freshUid('stats'), 'user'));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/arbitrage/risk/circuit-breaker/reset — requireRole(admin) gate', () => {
  it('rejects a regular authenticated user with 403', async () => {
    const res = await request(app)
      .post('/api/arbitrage/risk/circuit-breaker/reset')
      .set('Authorization', bearerFor(freshUid('cbreset-user'), 'user'));
    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated request with 401 (auth runs before the role check)', async () => {
    const res = await request(app).post('/api/arbitrage/risk/circuit-breaker/reset');
    expect(res.status).toBe(401);
  });

  it('allows an admin through', async () => {
    const res = await request(app)
      .post('/api/arbitrage/risk/circuit-breaker/reset')
      .set('Authorization', bearerFor(freshUid('cbreset-admin'), 'admin'));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/arbitrage/stream — ticket-based auth (not requireAuth, but must still gate)', () => {
  it('rejects a request with no bearer token and no ticket', async () => {
    const res = await request(app).get('/api/arbitrage/stream');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/notifications — requireAuth gate', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).get('/api/notifications');
    expect(res.status).toBe(401);
  });

  it('allows an authenticated user through', async () => {
    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', bearerFor(freshUid('notif'), 'user'));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/notifications/read-all — requireAuth gate', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).post('/api/notifications/read-all');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/alerts — requireAuth gate', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).get('/api/alerts');
    expect(res.status).toBe(401);
  });

  it('allows an authenticated user through', async () => {
    const res = await request(app)
      .get('/api/alerts')
      .set('Authorization', bearerFor(freshUid('alerts'), 'user'));
    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/auth/me — requireAuth gate', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).patch('/api/auth/me').send({ name: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/change-password — requireAuth gate', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: 'a', newPassword: 'b12345678' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/crypto/trending — intentionally public, no requireAuth expected', () => {
  // Note: crypto routes proxy live market data from an external API. We only
  // assert the absence of a 401 here (i.e. no auth gate was accidentally
  // added), not the shape of the market data itself — that's covered by
  // tests/cryptoService.test.js against a mocked provider. A slow/failed
  // upstream call (e.g. no network egress in a sandboxed CI) still returns
  // a non-401 status, which is all this smoke check verifies.
  it('is reachable without a token (public market data, by design)', async () => {
    const res = await request(app).get('/api/crypto/trending');
    expect(res.status).not.toBe(401);
  }, 15000);
});

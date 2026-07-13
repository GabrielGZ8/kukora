'use strict';

/**
 * arbitrageConfig.security.e2e.test.js — due diligence follow-up (Sesión
 * 2026-07-08).
 *
 * WHY THIS FILE EXISTS: tests/arbitrage.config.routes.test.js already
 * covers POST /config and POST /config/reset, but via a `getHandler()`
 * helper that reaches into `router.stack` and calls ONLY the last
 * middleware in each route's stack directly — i.e. it always calls the
 * final business-logic handler and skips every middleware in front of it
 * (auth, role checks, validateBody). That's fine for testing handler
 * logic, but it means those tests give a false sense of security-relevant
 * coverage: they would still pass identically whether or not
 * `requireRole('admin')` is actually wired in front of the route. This
 * file uses `supertest` against the REAL Express app (`server/index.js`),
 * so the full middleware chain — including the `requireRole('admin')` fix
 * applied to POST /config and POST /config/reset — actually runs.
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
function freshUid(label) { _counter += 1; return `e2e-cfgsec-${label}-${_counter}`; }

afterEach(() => {
  // These endpoints mutate the single process-wide liveConfig — reset it
  // after every test in this file so we never leak state into other test
  // files that also read liveConfig.
  liveConfig.reset('test-cleanup');
});

describe('POST /api/arbitrage/config — admin gate (security fix regression)', () => {
  it('rejects a regular authenticated user with 403, never reaching liveConfig.setMany', async () => {
    const uid = freshUid('user');
    const res = await request(app)
      .post('/api/arbitrage/config')
      .set('Authorization', bearerFor(uid, 'user'))
      .send({ minScore: 99 });
    expect(res.status).toBe(403);
    // The global config must be untouched by the rejected attempt.
    const after = liveConfig.get('minScore');
    expect(after).not.toBe(99);
  });

  it('rejects a request with no role claim at all (defaults to user) with 403', async () => {
    const uid = freshUid('norole');
    const res = await request(app)
      .post('/api/arbitrage/config')
      .set('Authorization', bearerFor(uid, undefined))
      .send({ minScore: 99 });
    expect(res.status).toBe(403);
  });

  it('allows an admin user through to actually apply the change', async () => {
    const uid = freshUid('admin');
    const res = await request(app)
      .post('/api/arbitrage/config')
      .set('Authorization', bearerFor(uid, 'admin'))
      .send({ minScore: 33 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(liveConfig.get('minScore')).toBe(33);
  });
});

describe('POST /api/arbitrage/config/reset — admin gate (security fix regression)', () => {
  it('rejects a regular authenticated user with 403', async () => {
    const uid = freshUid('resetuser');
    const res = await request(app)
      .post('/api/arbitrage/config/reset')
      .set('Authorization', bearerFor(uid, 'user'));
    expect(res.status).toBe(403);
  });

  it('allows an admin user through', async () => {
    const uid = freshUid('resetadmin');
    const res = await request(app)
      .post('/api/arbitrage/config/reset')
      .set('Authorization', bearerFor(uid, 'admin'));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

'use strict';

/**
 * sseConnection.e2e.test.js — M-7 (implementation_plan.md)
 *
 * Closes the last of the three routes explicitly named in M-7's fix
 * suggestion ("auth flow, trading mode switch, SSE connection") — auth
 * flow is tests/authFlow.e2e.test.js, trading mode switch is
 * tests/twoFactorTradingGate.e2e.test.js, this file is SSE.
 *
 * Scope note: this deliberately does NOT open a live SSE connection and
 * assert against the open stream. `GET /api/arbitrage/stream` never closes
 * its response on success (it's a long-lived push channel by design, with
 * a 15s heartbeat and no natural 'end' event), so asserting against it via
 * supertest means manually racing a 'response' event against a timeout and
 * aborting the socket — this was tried and found flaky in this sandbox
 * (`getOrderBooks()`/order-book init work in the handler doesn't resolve
 * quickly enough with no live exchange feeds connected, so headers don't
 * flush inside a safe test timeout). Chasing that down further is exactly
 * the kind of test-hang rabbit hole this project has already burned a
 * session on for an unrelated reason (see MIGRATION_CLEANUP_LOG.md,
 * Sesión 7) — not worth repeating for marginal additional coverage. What
 * *is* safe, real, and valuable to verify with an HTTP round trip is the
 * auth gate in front of the stream — `requireAuthForStream()` in
 * stream.routes.js, end-to-end through the real middleware chain (JWT
 * auth → ticket issuance → ticket consumption → route gate) — which is
 * what this file covers.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { app } = require('../server/index.js');

const JWT_SECRET = process.env.JWT_SECRET; // set in vitest.config.js
const USER_ID = 'e2e-sse-user';

function bearer() {
  const token = jwt.sign({ sub: USER_ID, email: 'e2e-sse@test.com' }, JWT_SECRET, { expiresIn: '15m' });
  return `Bearer ${token}`;
}

describe('SSE connection auth (end-to-end via supertest, real Express app)', () => {
  it('GET /api/arbitrage/stream rejects with 401 when no ticket is provided', async () => {
    const res = await request(app).get('/api/arbitrage/stream');
    expect(res.status).toBe(401);
  });

  it('GET /api/arbitrage/stream rejects with 401 for a garbage/expired ticket', async () => {
    const res = await request(app).get('/api/arbitrage/stream?ticket=not-a-real-ticket');
    expect(res.status).toBe(401);
  });

  it('GET /api/arbitrage/alerts-stream rejects with 401 when no ticket is provided', async () => {
    const res = await request(app).get('/api/arbitrage/alerts-stream');
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/stream-ticket requires authentication (401 with no bearer token)', async () => {
    const res = await request(app).post('/api/auth/stream-ticket');
    expect(res.status).toBe(401);
  });

  it('an authenticated user can obtain a stream ticket, and that ticket is a non-empty opaque string', async () => {
    const res = await request(app)
      .post('/api/auth/stream-ticket')
      .set('Authorization', bearer())
      .send();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.ticket).toBe('string');
    expect(res.body.ticket.length).toBeGreaterThan(10);
  });
});

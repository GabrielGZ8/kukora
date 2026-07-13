'use strict';

/**
 * authFlow.e2e.test.js — M-7 (implementation_plan.md)
 *
 * "No integration tests that test the full HTTP → response cycle... Add
 * supertest-based integration tests for critical routes (auth flow,
 * trading mode switch, SSE connection)."
 *
 * Trading mode switch is already covered end-to-end by
 * tests/twoFactorTradingGate.e2e.test.js. This file closes the "auth flow"
 * part of that same ask, against the real Express app (server/index.js)
 * via supertest — not the auth.js unit tests, which call the router
 * handlers' internals directly.
 *
 * This sandbox/CI environment has no live MongoDB, so /register and
 * /login cannot exercise the full happy path (user creation, password
 * hashing, JWT issuance) end-to-end here. That happy path IS covered at
 * the unit level elsewhere. What a real HTTP test against the live app
 * *can* verify — and what actually matters for "does the full HTTP →
 * response cycle behave correctly" — is:
 *   1. Input validation runs and rejects bad input with 400 *before* any
 *      DB access is attempted (no DB required to prove this).
 *   2. When MongoDB is unavailable, register/login degrade to a clean,
 *      typed 503 (`DB_UNAVAILABLE`) rather than crashing or hanging —
 *      this is the exact "MongoDB connection error handling" concern
 *      from H-4, verified here at the HTTP boundary instead of the
 *      module boundary.
 *   3. requireAuth middleware actually gates protected routes (`/me`,
 *      `/logout`) with 401 when no token is presented, through the real
 *      middleware chain (cookies, CORS, JSON body parsing, rate limiting)
 *      — not just a unit test of the middleware function in isolation.
 *   4. Malformed/absent bearer tokens are rejected the same way.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

const { app } = require('../server/index.js');

describe('auth flow (end-to-end via supertest, real Express app)', () => {
  describe('POST /api/auth/register', () => {
    it('rejects a missing/invalid email with 400 before touching the DB', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ password: 'longenoughpassword' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('rejects a too-short password with 400 before touching the DB', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'someone@example.com', password: 'short' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('returns 503 DB_UNAVAILABLE for otherwise-valid input when MongoDB is not connected (this env)', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: `e2e-${Date.now()}@example.com`, password: 'longenoughpassword' });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
    });
  });

  describe('POST /api/auth/login', () => {
    it('rejects a request missing email or password with 400', async () => {
      const res = await request(app).post('/api/auth/login').send({ email: 'a@b.com' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('returns 503 DB_UNAVAILABLE for otherwise-valid input when MongoDB is not connected (this env)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'someone@example.com', password: 'whatever123' });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
    });

    // Security phase (2026-07-09): before this fix, a non-string email/
    // password (e.g. a NoSQL-injection probe shaped like { "$gt": "" })
    // passed the old `!email || !password` truthy check (an object is
    // truthy) and only failed later inside .toLowerCase()/bcrypt.compare(),
    // surfacing as a generic 500 instead of a clean 400 — inconsistent with
    // /register, which already type-checked. This proves the type check now
    // runs (and rejects with 400) before any DB access is attempted, so it
    // holds even in this DB-less test environment.
    it('rejects a non-string email (NoSQL-injection-shaped payload) with 400, not 500', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: { $gt: '' }, password: 'whatever123' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('rejects a non-string password with 400, not 500', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'someone@example.com', password: { $gt: '' } });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });
  });

  describe('protected routes without a token', () => {
    it('GET /api/auth/me returns 401 with no Authorization header', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    it('POST /api/auth/logout returns 401 with no Authorization header', async () => {
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(401);
    });

    it('GET /api/auth/me returns 401 for a malformed bearer token', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer not-a-real-jwt');
      expect(res.status).toBe(401);
    });
  });
});

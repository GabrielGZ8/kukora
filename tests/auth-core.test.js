'use strict';

/**
 * auth-core.test.js — covers the surface of server/auth.js NOT already
 * exercised by auth.routes.test.js (which covers PATCH /me,
 * POST /change-password, and POST /refresh):
 *
 *   - requireAuth / hybridAuth middleware
 *   - POST /register, POST /login, POST /google, POST /logout, GET /me
 *   - Stream tickets: createStreamTicket / consumeStreamTicket (in-memory
 *     fallback path — no REDIS_URL is set in the test environment, so the
 *     Redis branch is never taken; that's expected and matches how Kukora
 *     runs in dev/single-instance deployments) and POST /stream-ticket.
 *
 * Same handler-extraction pattern as auth.routes.test.js and
 * middlewares.test.js — no real HTTP server, no real DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { router, requireAuth, requireRole, hybridAuth, createStreamTicket, consumeStreamTicket, getRedisStatus, JWT_SECRET } from '../server/infrastructure/auth.js';
import jwtLib from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const mongoose = require('mongoose');
const { User, TokenBlacklist } = require('../server/models.js');
const jwt = jwtLib;

function getHandler(path, method) {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No route ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    cookie() { return this; },
    clearCookie() { return this; },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── requireAuth ────────────────────────────────────────────────────────────

describe('requireAuth middleware', () => {
  it('rejects with 401 NO_TOKEN when there is no Authorization header', async () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = vi.fn();
    await requireAuth(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('NO_TOKEN');
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects with 401 NO_TOKEN when the header does not start with "Bearer "', async () => {
    const req = { headers: { authorization: 'Basic abc123' } };
    const res = mockRes();
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('NO_TOKEN');
  });

  it('rejects with 401 TOKEN_INVALID for a malformed token', async () => {
    const req = { headers: { authorization: 'Bearer not-a-real-jwt' } };
    const res = mockRes();
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('rejects with 401 TOKEN_EXPIRED for an expired token', async () => {
    const token = jwt.sign({ sub: 'u1' }, JWT_SECRET, { expiresIn: -10 });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  it('rejects with 401 TOKEN_REVOKED when the jti is blacklisted', async () => {
    vi.spyOn(TokenBlacklist, 'findOne').mockReturnValue({ lean: async () => ({ jti: 'j1' }) });
    const token = jwt.sign({ sub: 'u1', jti: 'j1' }, JWT_SECRET, { expiresIn: '5m' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_REVOKED');
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() and attaches req.user / req.userId for a valid, non-blacklisted token', async () => {
    vi.spyOn(TokenBlacklist, 'findOne').mockReturnValue({ lean: async () => null });
    const token = jwt.sign({ sub: 'u1', jti: 'j2', email: 'a@x.com' }, JWT_SECRET, { expiresIn: '5m' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = vi.fn();
    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.userId).toBe('u1');
    expect(req.user.email).toBe('a@x.com');
  });

  it('treats a blacklist lookup failure as "not blacklisted" (fail-open via .catch)', async () => {
    vi.spyOn(TokenBlacklist, 'findOne').mockReturnValue({ lean: () => Promise.reject(new Error('db down')) });
    const token = jwt.sign({ sub: 'u1', jti: 'j3' }, JWT_SECRET, { expiresIn: '5m' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ─── hybridAuth ─────────────────────────────────────────────────────────────

// ─── requireRole (H-7, Sesión 20) ──────────────────────────────────────────
describe('requireRole middleware', () => {
  function mockReqWithUser(user) {
    return { user, headers: {} };
  }

  it('devuelve 401 si no hay req.user (requireAuth no corrió antes)', () => {
    const req = mockReqWithUser(undefined);
    const res = mockRes();
    const next = vi.fn();
    requireRole('admin')(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('devuelve 403 si el rol del usuario no está en la lista permitida', () => {
    const req = mockReqWithUser({ role: 'user' });
    const res = mockRes();
    const next = vi.fn();
    requireRole('admin')(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    expect(next).not.toHaveBeenCalled();
  });

  it('llama next() si el rol del usuario coincide', () => {
    const req = mockReqWithUser({ role: 'admin' });
    const res = mockRes();
    const next = vi.fn();
    requireRole('admin')(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200); // no tocado
  });

  it('acepta múltiples roles permitidos', () => {
    const req = mockReqWithUser({ role: 'user' });
    const res = mockRes();
    const next = vi.fn();
    requireRole('admin', 'user')(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('trata un usuario sin campo role como "user" por default (nunca admin por omisión)', () => {
    const req = mockReqWithUser({});
    const res = mockRes();
    const next = vi.fn();
    requireRole('admin')(req, res, next);
    expect(res.statusCode).toBe(403);
  });
});

describe('hybridAuth middleware', () => {
  it('calls next() without setting req.user when there is no Authorization header', () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = vi.fn();
    hybridAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
  });

  it('sets req.user / req.userId for a valid bearer token', () => {
    const token = jwt.sign({ sub: 'u1' }, JWT_SECRET, { expiresIn: '5m' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = vi.fn();
    hybridAuth(req, res, next);
    expect(req.userId).toBe('u1');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('silently falls through (still calls next) for an invalid token', () => {
    const req = { headers: { authorization: 'Bearer garbage' } };
    const res = mockRes();
    const next = vi.fn();
    hybridAuth(req, res, next);
    expect(req.userId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ─── POST /register ─────────────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  const handler = getHandler('/register', 'post');

  it('rejects an invalid email with 400', async () => {
    const req = { body: { email: '', password: 'longenough1' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a short password with 400', async () => {
    const req = { body: { email: 'a@x.com', password: 'short' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('fast-fails with 503 DB_UNAVAILABLE when MongoDB is disconnected', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(0);
    const req = { body: { email: 'a@x.com', password: 'longenough1' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('DB_UNAVAILABLE');
  });

  it('returns 409 if the email is already registered', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    vi.spyOn(User, 'findOne').mockResolvedValue({ _id: 'existing' });
    const req = { body: { email: 'dup@x.com', password: 'longenough1' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(409);
  });

  it('creates the user and returns an access token on success', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    vi.spyOn(User, 'findOne').mockResolvedValue(null);
    vi.spyOn(User, 'create').mockResolvedValue({
      _id: 'u1', email: 'new@x.com', name: 'New', role: 'user', authProvider: 'local', avatarUrl: '',
    });
    const updateSpy = vi.spyOn(User, 'findByIdAndUpdate').mockResolvedValue({});

    const req = { body: { email: 'new@x.com', password: 'longenough1', name: 'New' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('returns 500 if User.create throws', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    vi.spyOn(User, 'findOne').mockResolvedValue(null);
    vi.spyOn(User, 'create').mockRejectedValue(new Error('write failed'));
    const req = { body: { email: 'boom@x.com', password: 'longenough1' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });

  // H-7 (Sesión 20): sin ADMIN_EMAILS, `role:'admin'` era inalcanzable para
  // cualquier usuario real. Este test confirma la vía de promoción real.
  it('H-7: promueve a admin automáticamente si el email está en ADMIN_EMAILS', async () => {
    const prevAdminEmails = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = 'boss@x.com, other@x.com';
    try {
      vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
      vi.spyOn(User, 'findOne').mockResolvedValue(null);
      const createdUser = { _id: 'u-admin', email: 'boss@x.com', name: 'Boss', role: 'user', authProvider: 'local', avatarUrl: '' };
      vi.spyOn(User, 'create').mockResolvedValue(createdUser);
      const updateSpy = vi.spyOn(User, 'findByIdAndUpdate').mockResolvedValue({});

      const req = { body: { email: 'boss@x.com', password: 'longenough1', name: 'Boss' } };
      const res = mockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.body.data.user.role).toBe('admin');
      // findByIdAndUpdate called twice: once for the role sync, once for refreshTokenHash.
      expect(updateSpy).toHaveBeenCalledWith('u-admin', { role: 'admin' });
    } finally {
      process.env.ADMIN_EMAILS = prevAdminEmails;
    }
  });
});

// ─── POST /login ─────────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  const handler = getHandler('/login', 'post');

  it('rejects when email or password is missing', async () => {
    const req = { body: { email: 'a@x.com' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('fast-fails with 503 when MongoDB is disconnected', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(0);
    const req = { body: { email: 'a@x.com', password: 'pw123456' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(503);
  });

  it('returns 401 for an unknown email (constant-time)', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    vi.spyOn(User, 'findOne').mockResolvedValue(null);
    const req = { body: { email: 'nope@x.com', password: 'pw123456' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 GOOGLE_ACCOUNT if the account has no local password', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    vi.spyOn(User, 'findOne').mockResolvedValue({ _id: 'u1', passwordHash: null });
    const req = { body: { email: 'g@x.com', password: 'pw123456' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('GOOGLE_ACCOUNT');
  });

  it('returns 401 for a wrong password', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    const hash = await bcrypt.hash('correct-password', 4);
    vi.spyOn(User, 'findOne').mockResolvedValue({ _id: 'u1', passwordHash: hash });
    const req = { body: { email: 'a@x.com', password: 'wrong-password' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('logs in successfully with the correct password', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    const hash = await bcrypt.hash('correct-password', 4);
    vi.spyOn(User, 'findOne').mockResolvedValue({
      _id: 'u1', email: 'a@x.com', name: 'A', role: 'user', authProvider: 'local', avatarUrl: '', passwordHash: hash,
    });
    vi.spyOn(User, 'findByIdAndUpdate').mockResolvedValue({});

    const req = { body: { email: 'a@x.com', password: 'correct-password' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.data.accessToken).toBe('string');
  });

  it('returns 500 on unexpected error', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    vi.spyOn(User, 'findOne').mockRejectedValue(new Error('db exploded'));
    const req = { body: { email: 'a@x.com', password: 'pw123456' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });
});

// ─── POST /google ────────────────────────────────────────────────────────

describe('POST /api/auth/google', () => {
  const handler = getHandler('/google', 'post');

  // NOTE: FIREBASE_PROJECT_ID is intentionally unset in the test environment
  // (see vitest.config.js env block and firebaseAdmin.test.js), so
  // verifyFirebaseIdToken() always throws FIREBASE_NOT_CONFIGURED before any
  // downstream logic (user lookup/creation/linking) runs. auth.js imports it
  // via `const { verifyFirebaseIdToken } = require('./firebaseAdmin')`, a
  // destructured CJS binding captured at module-load time — vi.mock() on the
  // module and vi.spyOn() on the exports object both fail to intercept that
  // already-bound local reference, so the success/GOOGLE_TOKEN_INVALID/
  // account-linking branches below are only reachable with real Firebase
  // credentials wired up, which is out of scope for a unit test here.
  it('rejects a missing idToken with 400', async () => {
    const req = { body: {} };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('fast-fails with 503 DB_UNAVAILABLE when MongoDB is disconnected, before ever calling Firebase', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(0);
    const req = { body: { idToken: 'tok' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('DB_UNAVAILABLE');
  });

  it('returns 503 GOOGLE_UNAVAILABLE when Firebase is not configured (real code path — FIREBASE_PROJECT_ID unset)', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    const req = { body: { idToken: 'tok' } };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('GOOGLE_UNAVAILABLE');
  });
});

// ─── POST /logout ────────────────────────────────────────────────────────

describe('POST /api/auth/logout', () => {
  const handler = getHandler('/logout', 'post');

  it('clears the refresh cookie and blacklists the refresh jti when present', async () => {
    const createSpy = vi.spyOn(TokenBlacklist, 'create').mockResolvedValue({});
    vi.spyOn(User, 'findByIdAndUpdate').mockResolvedValue({});
    const refreshToken = jwt.sign({ sub: 'u1', jti: 'rj1', exp: Math.floor(Date.now() / 1000) + 3600 }, 'whatever-refresh-secret');

    const req = { userId: 'u1', cookies: { kukora_refresh: refreshToken } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('still returns ok:true when there is no refresh cookie', async () => {
    vi.spyOn(User, 'findByIdAndUpdate').mockResolvedValue({});
    const req = { userId: 'u1', cookies: {} };
    const res = mockRes();
    await handler(req, res);
    expect(res.body.ok).toBe(true);
  });

  it('still returns ok:true even if clearing refreshTokenHash throws', async () => {
    vi.spyOn(User, 'findByIdAndUpdate').mockRejectedValue(new Error('db down'));
    const req = { userId: 'u1', cookies: {} };
    const res = mockRes();
    await handler(req, res);
    expect(res.body.ok).toBe(true);
  });
});

// ─── GET /me ──────────────────────────────────────────────────────────────

describe('GET /api/auth/me', () => {
  const handler = getHandler('/me', 'get');

  it('returns the user profile', async () => {
    vi.spyOn(User, 'findById').mockReturnValue({ select: async () => ({ _id: 'u1', email: 'a@x.com' }) });
    const req = { userId: 'u1' };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.user.email).toBe('a@x.com');
  });

  it('returns 404 if the user no longer exists', async () => {
    vi.spyOn(User, 'findById').mockReturnValue({ select: async () => null });
    const req = { userId: 'ghost' };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it('returns 500 on unexpected error', async () => {
    vi.spyOn(User, 'findById').mockReturnValue({ select: () => Promise.reject(new Error('db down')) });
    const req = { userId: 'u1' };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });
});

// ─── Stream tickets ─────────────────────────────────────────────────────────

describe('stream tickets (in-memory fallback — no REDIS_URL in test env)', () => {
  it('createStreamTicket returns a hex ticket with a 30s TTL', async () => {
    const { ticket, expiresIn } = await createStreamTicket('u1');
    expect(typeof ticket).toBe('string');
    expect(ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresIn).toBe(30);
  });

  it('consumeStreamTicket resolves the userId for a freshly-issued ticket', async () => {
    const { ticket } = await createStreamTicket('u42');
    const userId = await consumeStreamTicket(ticket);
    expect(userId).toBe('u42');
  });

  it('consumeStreamTicket is one-time-use — a second consume returns null', async () => {
    const { ticket } = await createStreamTicket('u7');
    await consumeStreamTicket(ticket);
    const second = await consumeStreamTicket(ticket);
    expect(second).toBeNull();
  });

  it('consumeStreamTicket returns null for an unknown ticket', async () => {
    expect(await consumeStreamTicket('never-issued')).toBeNull();
  });

  it('consumeStreamTicket returns null for a falsy ticket', async () => {
    expect(await consumeStreamTicket('')).toBeNull();
    expect(await consumeStreamTicket(null)).toBeNull();
  });

  it('POST /stream-ticket returns a ticket for an authenticated user', async () => {
    const handler = getHandler('/stream-ticket', 'post');
    const req = { userId: 'u99' };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.ticket).toBe('string');
    expect(await consumeStreamTicket(res.body.ticket)).toBe('u99');
  });
});

// ─── L-2: Redis health status ───────────────────────────────────────────────

describe('getRedisStatus (L-2 — /health and /api/readiness Redis check)', () => {
  it('reports configured:false and connected:false when REDIS_URL is unset (this test env)', () => {
    // No REDIS_URL in the test environment -> in-memory ticket store, which
    // is a supported single-instance mode, not a degraded one.
    const status = getRedisStatus();
    expect(status).toEqual({ configured: false, connected: false });
  });

  it('returns a plain, JSON-serializable object', () => {
    const status = getRedisStatus();
    expect(() => JSON.stringify(status)).not.toThrow();
  });
});

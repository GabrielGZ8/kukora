'use strict';

/**
 * auth.routes.test.js — direct unit tests for the new auth.js surface:
 *   - PATCH /me now accepts a whitelist of fields (name, onboardingDone)
 *     instead of only `name`.
 *   - POST /change-password (new endpoint).
 *
 * Route handlers are extracted from the express.Router() stack and invoked
 * directly with fake req/res objects (same pattern as middlewares.test.js),
 * rather than booting a real HTTP server.
 *
 * Mocking note: auth.js loads models.js via CJS `require('./models')`.
 * If this file also `import`s models.js via ESM, Vitest evaluates the
 * module body a second time under this project's CJS/ESM interop, which
 * re-runs `mongoose.model('User', ...)` and throws a real
 * OverwriteModelError — even with the global mongoose mock in
 * tests/setup.js. Using `require()` here instead of `import` resolves
 * models.js through the same CJS module cache auth.js already populated,
 * giving us the literal `User` object auth.js calls internally so
 * `vi.spyOn` actually intercepts it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { router } from '../server/infrastructure/auth.js';

// require(), not import — same reason as the User model note above: auth.js
// loads bcryptjs via CJS `require('bcryptjs')`. An ESM `import bcrypt from
// 'bcryptjs'` resolves to a *different* module instance under this
// project's CJS/ESM interop, so `vi.spyOn(bcrypt, 'compare')` on the ESM
// import silently does nothing — the real bcrypt.compare still runs
// against the fake hash below, which happens to also return false, so a
// naive test can pass for the wrong reason without ever proving the mock
// worked. Found and fixed while adding the login security-logging tests.
const bcrypt = require('bcryptjs');
const { User } = require('../server/models.js');
const { logger } = require('../server/infrastructure/logger.js');

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

describe('POST /api/auth/login — security event logging', () => {
  // Security phase (2026-07-09): before this session, neither a wrong-
  // password attempt nor a stolen/reused refresh token left any trace in
  // the logs — no way to alert on or investigate a brute-force /
  // credential-stuffing / token-theft pattern. These tests prove the new
  // log lines fire, with the exact userId/jti context and without ever
  // logging the raw email or password.
  const handler = getHandler('/login', 'post');
  const mongoose = require('mongoose');

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
  });

  it('logs a security warning (with userId, no raw credentials) on wrong password', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(User, 'findOne').mockResolvedValue({ _id: 'u1', passwordHash: 'irrelevant-hash' });
    vi.spyOn(bcrypt, 'compare').mockResolvedValue(false);

    const req = { body: { email: 'someone@example.com', password: 'wrong-password' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(warnSpy).toHaveBeenCalledWith(
      'auth',
      'Failed login attempt (wrong password)',
      { userId: 'u1' }
    );
    // Never log the raw credentials.
    const loggedMeta = warnSpy.mock.calls.find(c => c[1] === 'Failed login attempt (wrong password)')[2];
    expect(JSON.stringify(loggedMeta)).not.toContain('wrong-password');
    expect(JSON.stringify(loggedMeta)).not.toContain('someone@example.com');
  });

  it('does not log anything extra when the password is correct', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(User, 'findOne').mockResolvedValue({
      _id: 'u1', email: 'someone@example.com', name: 'X', role: 'user', passwordHash: 'irrelevant',
    });
    vi.spyOn(bcrypt, 'compare').mockResolvedValue(true);
    vi.spyOn(User, 'findByIdAndUpdate').mockResolvedValue({});

    const req = { body: { email: 'someone@example.com', password: 'correct-password' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(warnSpy).not.toHaveBeenCalledWith('auth', 'Failed login attempt (wrong password)', expect.anything());
  });
});

describe('PATCH /api/auth/me — whitelist update', () => {
  const handler = getHandler('/me', 'patch');

  beforeEach(() => { vi.restoreAllMocks(); });

  it('accepts a valid name and forwards only name to the update', async () => {
    const spy = vi.spyOn(User, 'findByIdAndUpdate').mockReturnValue({
      select: () => Promise.resolve({ _id: 'u1', name: 'Gabriel', onboardingDone: false }),
    });
    const req = { userId: 'u1', body: { name: 'Gabriel' } };
    const res = mockRes();
    await handler(req, res);

    expect(spy).toHaveBeenCalledWith('u1', { name: 'Gabriel' }, { new: true });
    expect(res.body.ok).toBe(true);
  });

  it('accepts onboardingDone:true and forwards it as a boolean', async () => {
    const spy = vi.spyOn(User, 'findByIdAndUpdate').mockReturnValue({
      select: () => Promise.resolve({ _id: 'u1', onboardingDone: true }),
    });
    const req = { userId: 'u1', body: { onboardingDone: true } };
    const res = mockRes();
    await handler(req, res);

    expect(spy).toHaveBeenCalledWith('u1', { onboardingDone: true }, { new: true });
    expect(res.body.ok).toBe(true);
  });

  it('coerces a truthy non-boolean onboardingDone value to boolean', async () => {
    const spy = vi.spyOn(User, 'findByIdAndUpdate').mockReturnValue({
      select: () => Promise.resolve({ _id: 'u1', onboardingDone: true }),
    });
    const req = { userId: 'u1', body: { onboardingDone: 'yes' } };
    const res = mockRes();
    await handler(req, res);

    expect(spy).toHaveBeenCalledWith('u1', { onboardingDone: true }, { new: true });
  });

  it('rejects an empty body with no valid fields', async () => {
    const req = { userId: 'u1', body: {} };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('rejects a name over 80 chars', async () => {
    const req = { userId: 'u1', body: { name: 'x'.repeat(81) } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  it('rejects a blank/whitespace-only name', async () => {
    const req = { userId: 'u1', body: { name: '   ' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  it('allows updating name and onboardingDone together in one request', async () => {
    const spy = vi.spyOn(User, 'findByIdAndUpdate').mockReturnValue({
      select: () => Promise.resolve({ _id: 'u1', name: 'Gabriel', onboardingDone: true }),
    });
    const req = { userId: 'u1', body: { name: 'Gabriel', onboardingDone: true } };
    const res = mockRes();
    await handler(req, res);

    expect(spy).toHaveBeenCalledWith('u1', { name: 'Gabriel', onboardingDone: true }, { new: true });
  });

  it('returns 404 when the user no longer exists', async () => {
    vi.spyOn(User, 'findByIdAndUpdate').mockReturnValue({
      select: () => Promise.resolve(null),
    });
    const req = { userId: 'ghost', body: { name: 'X' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(404);
  });

  it('ignores unknown fields silently rather than erroring', async () => {
    const spy = vi.spyOn(User, 'findByIdAndUpdate').mockReturnValue({
      select: () => Promise.resolve({ _id: 'u1', name: 'Gabriel' }),
    });
    const req = { userId: 'u1', body: { name: 'Gabriel', someRandomField: 'x' } };
    const res = mockRes();
    await handler(req, res);

    expect(spy).toHaveBeenCalledWith('u1', { name: 'Gabriel' }, { new: true });
  });

  it('returns 500 if the database call throws', async () => {
    vi.spyOn(User, 'findByIdAndUpdate').mockImplementation(() => {
      throw new Error('connection lost');
    });
    const req = { userId: 'u1', body: { name: 'Gabriel' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});

describe('POST /api/auth/change-password', () => {
  const handler = getHandler('/change-password', 'post');

  beforeEach(() => { vi.restoreAllMocks(); });

  it('rejects when currentPassword is missing', async () => {
    const req = { userId: 'u1', body: { newPassword: 'newpassword123' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('rejects when currentPassword is not a string', async () => {
    const req = { userId: 'u1', body: { currentPassword: 12345678, newPassword: 'newpassword123' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  it('rejects when newPassword is missing', async () => {
    const req = { userId: 'u1', body: { currentPassword: 'old12345' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  it('rejects when newPassword is under 8 characters', async () => {
    const req = { userId: 'u1', body: { currentPassword: 'old12345', newPassword: 'short' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  it('returns 404 if the user record is gone', async () => {
    vi.spyOn(User, 'findById').mockResolvedValue(null);
    const req = { userId: 'ghost', body: { currentPassword: 'old12345', newPassword: 'newpassword123' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(404);
  });

  it('rejects when currentPassword does not match the stored hash', async () => {
    const realHash = await bcrypt.hash('correct-password', 4);
    vi.spyOn(User, 'findById').mockResolvedValue({ _id: 'u1', passwordHash: realHash });

    const req = { userId: 'u1', body: { currentPassword: 'wrong-password', newPassword: 'newpassword123' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it('accepts a correct currentPassword, rehashes, and invalidates the refresh token', async () => {
    const realHash = await bcrypt.hash('correct-password', 4);
    vi.spyOn(User, 'findById').mockResolvedValue({ _id: 'u1', passwordHash: realHash });
    const updateSpy = vi.spyOn(User, 'findByIdAndUpdate').mockResolvedValue({});

    const req = { userId: 'u1', body: { currentPassword: 'correct-password', newPassword: 'newpassword123' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const [calledId, calledUpdate] = updateSpy.mock.calls[0];
    expect(calledId).toBe('u1');
    expect(calledUpdate.refreshTokenHash).toBeNull();
    expect(typeof calledUpdate.passwordHash).toBe('string');
    expect(calledUpdate.passwordHash).not.toBe('correct-password');
  });

  it('returns 500 if findById throws unexpectedly', async () => {
    vi.spyOn(User, 'findById').mockRejectedValue(new Error('db down'));
    const req = { userId: 'u1', body: { currentPassword: 'old12345', newPassword: 'newpassword123' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
  });
});

describe('POST /api/auth/refresh', () => {
  const handler = getHandler('/refresh', 'post');
  const { JWT_REFRESH_SECRET } = require('../server/infrastructure/auth.js');
  const jwt = require('jsonwebtoken');
  const { TokenBlacklist } = require('../server/models.js');
  const mongoose = require('mongoose');

  beforeEach(() => { vi.restoreAllMocks(); });

  function signRefreshToken(overrides = {}) {
    const { jti, ...rest } = overrides;
    return jwt.sign(
      { sub: 'u1', type: 'refresh', ...rest },
      JWT_REFRESH_SECRET,
      { expiresIn: '7d', jwtid: jti || 'jti-1' }
    );
  }

  it('returns 401 NO_REFRESH when there is no refresh cookie, without touching the DB', async () => {
    const dbSpy = vi.spyOn(TokenBlacklist, 'findOne');
    const req = { cookies: {} };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('NO_REFRESH');
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it('fast-fails with 503 DB_UNAVAILABLE when MongoDB is disconnected, without ever calling jwt.verify', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(0);
    const verifySpy = vi.spyOn(jwt, 'verify');

    const req = { cookies: { kukora_refresh: signRefreshToken() } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('DB_UNAVAILABLE');
    // The whole point of the fast-fail guard: a stale cookie with DB down
    // must not fall through into token verification / Mongo queries that
    // would otherwise block for ~6s on Mongoose's serverSelectionTimeoutMS.
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it('returns 401 REFRESH_INVALID for a malformed/expired token even when DB is connected', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    const req = { cookies: { kukora_refresh: 'not-a-real-jwt' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('REFRESH_INVALID');
  });

  it('returns 401 TOKEN_REVOKED if the jti is blacklisted', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    vi.spyOn(TokenBlacklist, 'findOne').mockResolvedValue({ jti: 'jti-1' });

    const req = { cookies: { kukora_refresh: signRefreshToken({ jti: 'jti-1' }) } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_REVOKED');
  });

  it('returns 401 TOKEN_REUSE if the stored refreshTokenHash does not match (token reuse / already rotated), and logs it as a security warning', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    vi.spyOn(TokenBlacklist, 'findOne').mockResolvedValue(null);
    vi.spyOn(User, 'findById').mockResolvedValue({ _id: 'u1', refreshTokenHash: 'some-other-hash' });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const req = { cookies: { kukora_refresh: signRefreshToken({ jti: 'jti-reuse-test' }) } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_REUSE');
    // Security phase (2026-07-09): before this fix, the strongest signal
    // this system has for a stolen refresh token left zero trace anywhere.
    expect(warnSpy).toHaveBeenCalledWith(
      'auth',
      'Refresh token reuse detected (stolen/already-rotated token)',
      { userId: 'u1', jti: 'jti-reuse-test' }
    );
  });

  it('issues a new access token and rotates the refresh token on success', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    vi.spyOn(TokenBlacklist, 'findOne').mockResolvedValue(null);
    const createSpy = vi.spyOn(TokenBlacklist, 'create').mockResolvedValue({});

    const crypto = require('crypto');
    const refreshToken = signRefreshToken();
    const matchingHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    vi.spyOn(User, 'findById').mockResolvedValue({
      _id: 'u1', email: 'g@x.com', name: 'Gabriel', role: 'user',
      refreshTokenHash: matchingHash,
    });
    const updateSpy = vi.spyOn(User, 'findByIdAndUpdate').mockResolvedValue({});

    const req = { cookies: { kukora_refresh: refreshToken } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(createSpy).toHaveBeenCalledTimes(1); // old jti blacklisted
    expect(updateSpy).toHaveBeenCalledTimes(1);  // new refreshTokenHash stored
  });
});
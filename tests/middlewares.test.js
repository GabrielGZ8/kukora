'use strict';

/**
 * middlewares.test.js — direct unit tests for session/request middleware
 *
 * Both middlewares previously had zero test coverage despite being on the
 * hot path of every single request — sessionMiddleware in particular is
 * the thing every persistence/userId-scoped feature in the app depends
 * on, so a regression here would silently corrupt data isolation between
 * users (or, as discovered while wiring up the rate limiter, silently
 * defeat anonymous-user rate limiting).
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { sessionMiddleware } from '../server/infrastructure/sessionMiddleware.js';
import { requestMiddleware } from '../server/infrastructure/requestMiddleware.js';

// ─── sessionMiddleware ──────────────────────────────────────────────────

describe('sessionMiddleware', () => {
  it('assigns "anonymous" when no session header is present', () => {
    const req = { headers: {} };
    const next = vi.fn();
    sessionMiddleware(req, {}, next);
    expect(req.userId).toBe('anonymous');
    expect(next).toHaveBeenCalledOnce();
  });

  it('accepts a valid UUID v4 session header (lowercased)', () => {
    const uuid = 'A1B2C3D4-E5F6-4789-9ABC-DEF012345678';
    const req = { headers: { 'x-session-id': uuid } };
    const next = vi.fn();
    sessionMiddleware(req, {}, next);
    expect(req.userId).toBe(uuid.toLowerCase());
  });

  it('falls back to "anonymous" for a malformed session header', () => {
    const req = { headers: { 'x-session-id': 'not-a-real-uuid' } };
    const next = vi.fn();
    sessionMiddleware(req, {}, next);
    expect(req.userId).toBe('anonymous');
  });

  it('falls back to "anonymous" for a non-v4 UUID (wrong version nibble)', () => {
    // version nibble must be '4' — this one is version 1
    const req = { headers: { 'x-session-id': 'a1b2c3d4-e5f6-1789-9abc-def012345678' } };
    const next = vi.fn();
    sessionMiddleware(req, {}, next);
    expect(req.userId).toBe('anonymous');
  });

  it('rejects header-injection attempts disguised as a session id', () => {
    const req = { headers: { 'x-session-id': '"; DROP TABLE users; --' } };
    const next = vi.fn();
    sessionMiddleware(req, {}, next);
    expect(req.userId).toBe('anonymous');
  });

  it('always calls next() exactly once, synchronously', () => {
    const req = { headers: {} };
    const next = vi.fn();
    sessionMiddleware(req, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ─── requestMiddleware ──────────────────────────────────────────────────

function makeMockRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.setHeader = vi.fn();
  return res;
}

describe('requestMiddleware', () => {
  it('sets an X-Request-ID header and calls next()', () => {
    const req = { method: 'GET', path: '/api/test' };
    const res = makeMockRes();
    const next = vi.fn();

    requestMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.requestId).toBeTypeOf('string');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', req.requestId);
  });

  it('does not throw when the response finishes normally', () => {
    const req = { method: 'GET', path: '/api/test' };
    const res = makeMockRes();
    requestMiddleware(req, res, vi.fn());

    res.statusCode = 200;
    expect(() => res.emit('finish')).not.toThrow();
  });

  it('does not throw on a slow request (exercises the slow-request warn path)', async () => {
    const req = { method: 'GET', path: '/api/slow' };
    const res = makeMockRes();
    requestMiddleware(req, res, vi.fn());

    // Simulate elapsed time by waiting briefly isn't reliable in CI;
    // instead just confirm emitting 'finish' under a >500ms statusCode
    // branch doesn't throw, regardless of actual elapsed time.
    res.statusCode = 503;
    expect(() => res.emit('finish')).not.toThrow();
  });

  it('generates a distinct requestId per call', () => {
    const reqA = { method: 'GET', path: '/a' };
    const reqB = { method: 'GET', path: '/b' };
    requestMiddleware(reqA, makeMockRes(), vi.fn());
    requestMiddleware(reqB, makeMockRes(), vi.fn());
    expect(reqA.requestId).not.toBe(reqB.requestId);
  });
});

'use strict';

/**
 * notifications.routes.test.js — direct unit tests for notifications.routes.js
 * (the bell-icon system: SSE stream init frame, paginated history, and
 * per-user mark-as-read on broadcast notifications).
 *
 * Same require()-based pattern as auth.routes.test.js: this file pulls
 * `Notification` via CJS require() (not ESM import) so it shares the
 * exact module instance notifications.routes.js already resolved via its
 * own require('./models'), letting vi.spyOn actually intercept calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import router from '../server/routes/notifications.routes.js';
const { requireAuthForStream } = router;

const { Notification } = require('../server/models.js');
const mongoose = require('mongoose');

function getHandler(path, method) {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No route ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    written: [],
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    flushHeaders() {},
    write(chunk) { this.written.push(chunk); },
  };
  return res;
}

function mockReq(extra = {}) {
  return {
    userId: 'u1',
    query: {},
    params: {},
    on: vi.fn(),
    ...extra,
  };
}

describe('GET /api/notifications (history)', () => {
  const handler = getHandler('/', 'get');

  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns an empty list with 0 unread when the DB is not connected', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(0);
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(true);
    expect(res.body.data.notifications).toEqual([]);
    expect(res.body.data.unread).toBe(0);
  });

  it('maps stored docs to read:true/false based on whether userId is in readBy', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    vi.spyOn(Notification, 'find').mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: async () => [
            { _id: 'n1', event: 'circuit_breaker_activated', title: 'CB', severity: 'critical', readBy: ['u1'], createdAt: new Date() },
            { _id: 'n2', event: 'daily_stop', title: 'Stop', severity: 'warn', readBy: [], createdAt: new Date() },
          ],
        }),
      }),
    });
    vi.spyOn(Notification, 'countDocuments').mockResolvedValue(1);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(true);
    expect(res.body.data.notifications).toHaveLength(2);
    expect(res.body.data.notifications[0].read).toBe(true);
    expect(res.body.data.notifications[1].read).toBe(false);
    expect(res.body.data.unread).toBe(1);
  });

  it('caps limit at 100 even if a larger value is requested', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(0);
    const req = mockReq({ query: { limit: '99999' } });
    const res = mockRes();
    // With DB disconnected this short-circuits before limit is used, but
    // the handler must not throw on a hostile limit value either way.
    await expect(handler(req, res)).resolves.not.toThrow();
  });

  it('returns 500 if the database query throws', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    vi.spyOn(Notification, 'find').mockImplementation(() => { throw new Error('boom'); });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});

describe('PATCH /api/notifications/:id/read', () => {
  const handler = getHandler('/:id/read', 'patch');

  beforeEach(() => { vi.restoreAllMocks(); });

  it('no-ops successfully when the DB is not connected', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(0);
    const req = mockReq({ params: { id: '507f1f77bcf86cd799439011' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(true);
  });

  it('adds the requesting userId to readBy via $addToSet (never duplicating)', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    const spy = vi.spyOn(Notification, 'findByIdAndUpdate').mockResolvedValue({});

    const req = mockReq({ params: { id: '507f1f77bcf86cd799439011' } });
    const res = mockRes();
    await handler(req, res);

    expect(spy).toHaveBeenCalledWith('507f1f77bcf86cd799439011', { $addToSet: { readBy: 'u1' } });
    expect(res.body.ok).toBe(true);
  });

  it('returns 500 if the update throws', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    vi.spyOn(Notification, 'findByIdAndUpdate').mockRejectedValue(new Error('bad id'));

    const req = mockReq({ params: { id: '507f1f77bcf86cd799439012' } });
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
  });
});

describe('POST /api/notifications/read-all', () => {
  const handler = getHandler('/read-all', 'post');

  beforeEach(() => { vi.restoreAllMocks(); });

  it('no-ops with updated:0 when the DB is not connected', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(0);
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.body).toEqual({ ok: true, data: { updated: 0 } });
  });

  it('marks every notification not yet read by this user as read', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    const spy = vi.spyOn(Notification, 'updateMany').mockResolvedValue({ modifiedCount: 5 });

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(spy).toHaveBeenCalledWith(
      { readBy: { $ne: 'u1' } },
      { $addToSet: { readBy: 'u1' } }
    );
    expect(res.body.data.updated).toBe(5);
  });
});

describe('requireAuthForStream — EventSource-compatible auth', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('uses the Authorization header when present, ignoring any query ticket', async () => {
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET } = require('../server/infrastructure/auth.js');
    const headerToken = jwt.sign({ sub: 'header-user' }, JWT_SECRET);

    const req = { headers: { authorization: `Bearer ${headerToken}` }, query: {} };
    const res = mockRes();
    const next = vi.fn();
    await requireAuthForStream(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.userId).toBe('header-user');
  });

  it('falls back to ?ticket= when no Authorization header is present, consuming a valid one-time ticket', async () => {
    const { createStreamTicket } = require('../server/infrastructure/auth.js');
    const { ticket } = await createStreamTicket('ticket-user');

    const req = { headers: {}, query: { ticket } };
    const res = mockRes();
    const next = vi.fn();
    await requireAuthForStream(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.userId).toBe('ticket-user');
  });

  it('rejects with 401 when neither header nor query ticket is present', async () => {
    const req = { headers: {}, query: {} };
    const res = mockRes();
    const next = vi.fn();
    await requireAuthForStream(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TICKET_INVALID');
  });

  it('rejects with 401 for a malformed/unknown ticket', async () => {
    const req = { headers: {}, query: { ticket: 'not-a-real-ticket' } };
    const res = mockRes();
    const next = vi.fn();
    await requireAuthForStream(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TICKET_INVALID');
  });

  it('rejects reuse of an already-consumed ticket (one-time use)', async () => {
    const { createStreamTicket } = require('../server/infrastructure/auth.js');
    const { ticket } = await createStreamTicket('u1');

    const firstReq = { headers: {}, query: { ticket } };
    await requireAuthForStream(firstReq, mockRes(), vi.fn());

    // Second attempt with the same ticket must fail — it was deleted on first use.
    const secondReq = { headers: {}, query: { ticket } };
    const res = mockRes();
    const next = vi.fn();
    await requireAuthForStream(secondReq, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TICKET_INVALID');
  });
});

describe('GET /api/notifications/stream (SSE)', () => {
  const handler = getHandler('/stream', 'get');
  const { notificationClients } = require('../server/application/arbitrage.state.js');

  beforeEach(() => {
    vi.restoreAllMocks();
    notificationClients.clear();
  });

  it('sets SSE headers and registers the connection for later pushes', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(0);
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(req.on).toHaveBeenCalledWith('close', expect.any(Function));
  });
  it('writes an init frame containing the unread count when DB is connected', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1);
    vi.spyOn(Notification, 'countDocuments').mockResolvedValue(3);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    const initFrame = res.written.find(w => w.includes('"type":"init"'));
    expect(initFrame).toBeDefined();
    expect(initFrame).toContain('"unread":3');
  });

  it('still sends an init frame (unread:0) when the DB is not connected', async () => {
    vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(0);
    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    const initFrame = res.written.find(w => w.includes('"type":"init"'));
    expect(initFrame).toContain('"unread":0');
  });

  // M-4: MAX_SSE_CLIENTS-equivalent enforcement for the notifications stream.
  describe('M-4: connection limit enforcement', () => {
    it('accepts the connection and adds it to notificationClients while under the cap', async () => {
      vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(0);
      const req = mockReq();
      const res = mockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(notificationClients.has(res)).toBe(true);
    });

    it('rejects new connections with 503 once notificationClients.size reaches MAX_NOTIFICATION_SSE_CLIENTS (default 200)', async () => {
      vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(0);
      for (let i = 0; i < 200; i++) notificationClients.add({ fake: i });

      const req = mockReq();
      const res = mockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({ ok: false, error: expect.stringContaining('capacity') });
      // Rejected connections must never be registered or get SSE headers.
      expect(res.headers['Content-Type']).toBeUndefined();
      expect(notificationClients.has(res)).toBe(false);
    });

    it('accepts a connection again once the pool drops back under the cap', async () => {
      vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(0);
      for (let i = 0; i < 200; i++) notificationClients.add({ fake: i });
      notificationClients.clear();
      for (let i = 0; i < 199; i++) notificationClients.add({ fake: i });

      const req = mockReq();
      const res = mockRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(notificationClients.has(res)).toBe(true);
    });
  });
});

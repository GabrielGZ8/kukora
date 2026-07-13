'use strict';
/**
 * notifications.routes.js — Kukora
 *
 * In-app system notifications (bell icon in the topbar). Distinct from
 * the price `Alert` model (coin above/below) — these are engine/system
 * events (circuit breaker, drawdown, exchange offline, daily loss, etc.)
 * produced by alertWebhookService.dispatch() and persisted to the
 * `Notification` collection.
 *
 * The arbitrage engine is a single global instance (not per-user), so
 * these events are broadcast (userId: 'broadcast') — every authenticated
 * user sees the same feed. "Read" state is tracked per-viewer via the
 * `readBy` array on each document, so one user dismissing a notification
 * never marks it read for anyone else.
 *
 * Endpoints:
 *   GET   /api/notifications/stream      — SSE push of new notifications
 *   GET   /api/notifications             — paginated history + unread count
 *   PATCH /api/notifications/:id/read    — mark one notification read (for me)
 *   POST  /api/notifications/read-all    — mark everything read (for me)
 */

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { logger } = require('../infrastructure/logger');
const { requireAuth, consumeStreamTicket } = require('../infrastructure/auth');
const { Notification } = require('../models');
const state = require('../application/arbitrage.state');
const { notificationClients } = state;
const { sendError } = require('../infrastructure/errorResponse');
const { ValidationError } = require('../domain/errors');

const isDbReady = () => mongoose.connection.readyState === 1;

// M-4 fix: the arbitrage SSE streams (server/arbitrage/subroutes/stream.routes.js)
// already enforce MAX_SSE_CLIENTS / MAX_ALERT_SSE_CLIENTS, but this notification
// stream — the third long-lived SSE connection pool in the app — had no cap. A
// single user opening many tabs could exhaust the connection pool the same way.
// Same env-var convention, same 503 response shape.
const MAX_NOTIFICATION_SSE_CLIENTS = parseInt(process.env.MAX_NOTIFICATION_SSE_CLIENTS || '200', 10);

// requireAuthForStream — browser EventSource cannot set custom headers, so
// the Authorization: Bearer header requireAuth() expects is unavailable on
// the one connection that matters here. This uses the same one-time
// stream-ticket exchange as the arbitrage SSE routes (see server/auth.js,
// C-2 fix): the client exchanges its real access token for a 30s,
// single-use ticket via POST /api/auth/stream-ticket (over a header, never
// a URL), then opens the EventSource with that ticket as ?ticket=. The
// ticket is consumed on first use, so it never lingers anywhere a real JWT
// would — not in proxy access logs, not in browser history, not in a
// Referer header. Every other route in this file still goes through the
// strict, header-only requireAuth.
async function requireAuthForStream(req, res, next) {
  const header = req.headers['authorization'];
  if (header && header.startsWith('Bearer ')) return requireAuth(req, res, next);

  const userId = await consumeStreamTicket(req.query.ticket);
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired stream ticket', code: 'TICKET_INVALID' });
  }
  req.userId = userId;
  next();
}

// ─── GET /api/notifications/stream — SSE ───────────────────────────────────
router.get('/stream', requireAuthForStream, async (req, res) => {
  if (notificationClients.size >= MAX_NOTIFICATION_SSE_CLIENTS) {
    return res.status(503).json({ ok: false, error: 'Notifications SSE capacity reached. Try again shortly.' });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(hb); } }, 15000);
  notificationClients.add(res);

  // Send an init frame with the current unread count so the bell badge
  // is correct immediately on connect, without waiting for the next event.
  try {
    let unread = 0;
    if (isDbReady()) {
      unread = await Notification.countDocuments({ readBy: { $ne: req.userId } });
    }
    res.write(`data: ${JSON.stringify({ type: 'init', unread })}\n\n`);
  } catch { /* non-fatal — client just starts at 0 until the next push */ }

  req.on('close', () => { notificationClients.delete(res); clearInterval(hb); });
});

// ─── GET /api/notifications — paginated history ────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 100);
    if (!isDbReady()) {
      return res.json({ ok: true, data: { notifications: [], unread: 0 } });
    }
    const [docs, unread] = await Promise.all([
      // Issue 30: Time-bound (30 days) + future-proof userId filter
      (() => {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        return Notification.find({
          $or: [{ userId: 'broadcast' }, { userId: req.userId }],
          createdAt: { $gte: thirtyDaysAgo },
        }).sort({ createdAt: -1 }).limit(limit).lean();
      })(),
      Notification.countDocuments({ readBy: { $ne: req.userId } }),
    ]);
    const notifications = docs.map(d => ({
      id:        d._id.toString(),
      event:     d.event,
      title:     d.title,
      severity:  d.severity,
      read:      d.readBy.includes(req.userId),
      createdAt: d.createdAt,
    }));
    res.json({ ok: true, data: { notifications, unread } });
  } catch (e) {
    logger.error('notifications', 'List error', { err: e.message });
    res.status(500).json({ ok: false, error: 'Could not load notifications' });
  }
});

// ─── PATCH /api/notifications/:id/read ─────────────────────────────────────
router.patch('/:id/read', requireAuth, async (req, res) => {
  try {
    // ObjectId validation — prevents CastError from reaching the DB layer
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return sendError(res, new ValidationError('Invalid notification id'));
    }
    if (!isDbReady()) return res.json({ ok: true, data: { read: true } });
    await Notification.findByIdAndUpdate(req.params.id, { $addToSet: { readBy: req.userId } });
    res.json({ ok: true, data: { read: true } });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Could not mark as read' });
  }
});

// ─── POST /api/notifications/read-all ───────────────────────────────────────
router.post('/read-all', requireAuth, async (req, res) => {
  try {
    if (!isDbReady()) return res.json({ ok: true, data: { updated: 0 } });
    const result = await Notification.updateMany(
      { readBy: { $ne: req.userId } },
      { $addToSet: { readBy: req.userId } }
    );
    res.json({ ok: true, data: { updated: result.modifiedCount || 0 } });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Could not mark all as read' });
  }
});

// Exposed for direct unit testing (see tests/notifications.routes.test.js).
// Attach to the router function before exporting so module.exports is always
// the router function itself — avoids any risk of the property assignment
// being interpreted as replacing the export with a plain object.
router.requireAuthForStream = requireAuthForStream;
module.exports = router;
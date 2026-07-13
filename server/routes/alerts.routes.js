'use strict';

/**
 * Alerts routes — extracted from server/index.js as part of audit fix 2.5
 * (SRP: separate route modules per domain, remove business logic from index.js).
 *
 * All routes require authentication. Validation runs before any DB access:
 * types, value ranges, and string lengths are checked here rather than
 * relying solely on the Mongoose schema (which only enforces `required`).
 *
 * Nivel 3 #3 (audit): data access goes through server/repositories/ instead
 * of calling the Alert model directly — route handlers stay focused on
 * HTTP concerns (validation, status codes) and delegate persistence to the
 * repository layer, which is what actually enforces the userId guard.
 */

const express  = require('express');
const mongoose = require('mongoose');
const router   = express.Router();

const { buildRepositories }                = require('../repositories');
const { requireAuth }                      = require('../infrastructure/auth');
const { validateAlertCreate, validateAlertUpdate } = require('../domain/validation');
const { sendError } = require('../infrastructure/errorResponse');
const { ValidationError } = require('../domain/errors');

const repos   = buildRepositories();

// ─── Helpers ──────────────────────────────────────────────────────────────

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

const isDbReady = () => mongoose.connection.readyState === 1;

const wrapDb = (fn, fallback) => async (req, res) => {
  if (!isDbReady()) {
    const data = typeof fallback === 'function' ? fallback(req) : fallback;
    return res.json({ ok: true, data, _noDb: true });
  }
  // Auditoría (sección 2): DomainError (ValidationError, ConflictError, etc.)
  // que suba desde repos.alerts se traduce a su status/code propio en vez de
  // aplanarse siempre a 500 — ver server/infrastructure/errorResponse.js.
  try { res.json({ ok: true, data: await fn(req) }); }
  catch (e) { sendError(res, e); }
};

// ─── Routes ───────────────────────────────────────────────────────────────

// GET /api/alerts — list user's alerts, newest first
router.get('/', requireAuth, wrapDb(
  req => repos.alerts.listForUser(req.userId),
  []
));

// POST /api/alerts — create a new alert
router.post('/', requireAuth, (req, res) => {
  const v = validateAlertCreate(req.body);
  if (!v.valid) return sendError(res, new ValidationError(v.error));
  return wrapDb(r => repos.alerts.addAlert(r.userId, v.value), null)(req, res);
});

// DELETE /api/alerts/:id — delete own alert
router.delete('/:id', requireAuth, wrapDb(req => {
  if (!isValidObjectId(req.params.id)) return null;
  // Ownership check — only delete own alerts (Issue 4), enforced in the repo
  return repos.alerts.deleteAlert(req.userId, req.params.id);
}, null));

// PATCH /api/alerts/:id — update own alert
router.patch('/:id', requireAuth, (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return sendError(res, new ValidationError('Invalid id'));
  }
  const v = validateAlertUpdate(req.body);
  if (!v.valid) return sendError(res, new ValidationError(v.error));
  // Ownership check — only update own alerts (Issue 4), enforced in the repo
  return wrapDb(r => repos.alerts.updateAlert(r.userId, r.params.id, v.value), null)(req, res);
});

module.exports = router;

'use strict';

/**
 * Portfolio routes — extracted from server/index.js as part of audit fix 2.5
 * (SRP: separate route modules per domain, remove business logic from index.js).
 *
 * Supports pagination via ?limit=&offset= (defaults: limit 50, max 200, offset 0).
 * Portfolio can grow large position-by-position, so pagination is necessary here
 * even though alerts/watchlist don't need it.
 *
 * Nivel 3 #3 (audit): data access goes through server/repositories/ instead
 * of calling the Portfolio model directly, including the idempotency-key
 * replay logic (now PortfolioRepository.addEntryIdempotent()).
 */

const express  = require('express');
const mongoose = require('mongoose');
const router   = express.Router();

const { buildRepositories }                        = require('../repositories');
const { requireAuth }                                = require('../infrastructure/auth');
const { validatePortfolioCreate, parsePagination }   = require('../domain/validation');
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
  try { res.json({ ok: true, data: await fn(req) }); }
  catch (e) { sendError(res, e); }
};

// ─── Routes ───────────────────────────────────────────────────────────────

// GET /api/portfolio — paginated list of user's positions
router.get('/', requireAuth, (req, res) => {
  const { limit, offset } = parsePagination(req.query);
  return wrapDb(async r => {
    const { items, total } = await repos.portfolio.listForUser(r.userId, { offset, limit });
    return { items, total, limit, offset };
  }, { items: [], total: 0, limit, offset })(req, res);
});

// POST /api/portfolio — create a new position (with idempotency key support)
router.post('/', requireAuth, (req, res) => {
  const v = validatePortfolioCreate(req.body);
  if (!v.valid) return sendError(res, new ValidationError(v.error));

  // I-7 fix: Idempotency key support. If the client provides an
  // Idempotency-Key header, check for a recent duplicate within 60s
  // and return the original result rather than creating a second position.
  // This prevents duplicate positions on client retries after network timeouts.
  const idempotencyKey = req.headers['idempotency-key'];
  if (idempotencyKey) {
    const cleanKey = String(idempotencyKey).slice(0, 128); // bound key length
    return wrapDb(
      r => repos.portfolio.addEntryIdempotent(r.userId, v.value, cleanKey),
      null
    )(req, res);
  }

  return wrapDb(r => repos.portfolio.addEntry(r.userId, v.value), null)(req, res);
});

// DELETE /api/portfolio/:id — delete own position
router.delete('/:id', requireAuth, wrapDb(req => {
  if (!isValidObjectId(req.params.id)) return null;
  // Ownership check — only delete own positions (Issue 4), enforced in the repo
  return repos.portfolio.deleteEntry(req.userId, req.params.id);
}, null));

module.exports = router;

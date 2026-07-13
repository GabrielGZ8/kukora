'use strict';

/**
 * Watchlist routes — extracted from server/index.js as part of audit fix 2.5
 * (SRP: separate route modules per domain, remove business logic from index.js).
 *
 * Nivel 3 #3 (audit): data access goes through server/repositories/ instead
 * of calling the Watchlist model directly.
 */

const express  = require('express');
const mongoose = require('mongoose');
const router   = express.Router();

const { buildRepositories }     = require('../repositories');
const { requireAuth }           = require('../infrastructure/auth');
const { validateWatchlistSave } = require('../domain/validation');
const { sendError } = require('../infrastructure/errorResponse');
const { ValidationError } = require('../domain/errors');

const repos   = buildRepositories();

// ─── Helpers ──────────────────────────────────────────────────────────────

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

// GET /api/watchlist — return user's coin watchlist
router.get('/', requireAuth, wrapDb(
  req => repos.watchlist.getWatchlist(req.userId),
  { coins: [] }
));

// POST /api/watchlist — create or replace user's watchlist
router.post('/', requireAuth, (req, res) => {
  const v = validateWatchlistSave(req.body);
  if (!v.valid) return sendError(res, new ValidationError(v.error));
  return wrapDb(
    r => repos.watchlist.upsertCoins(r.userId, v.value.coins),
    { coins: v.value.coins }
  )(req, res);
});

module.exports = router;

'use strict';

/**
 * featureFlags.routes.js — read/write access to the feature flag registry.
 *
 * Mounted at /api/feature-flags and /api/v1/feature-flags (see server/index.js).
 * requireAuth gates every route; requirePermission (server/infrastructure/rbac.js)
 * gates mutations at the granularity that matters here — kill-switch flags
 * specifically require the admin-only FLAGS_KILL_SWITCH permission, while
 * every other flag only needs FLAGS_WRITE (operator or admin).
 */

const express = require('express');
const router  = express.Router();

const { requireAuth } = require('../infrastructure/auth');
const { requirePermission, PERMISSIONS } = require('../infrastructure/rbac');
const featureFlags    = require('../infrastructure/featureFlags');

router.use(requireAuth);

// GET /api/feature-flags — list all flags with current global values.
router.get('/', requirePermission(PERMISSIONS.FLAGS_READ), (req, res) => {
  res.json({ flags: featureFlags.listFlags() });
});

// GET /api/feature-flags/history — recent audit trail.
router.get('/history', requirePermission(PERMISSIONS.FLAGS_READ), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  res.json({ history: featureFlags.getHistory(limit) });
});

// GET /api/feature-flags/:key — single flag definition + resolved value for
// the caller's tenant (if ?tenantId= is provided).
router.get('/:key', requirePermission(PERMISSIONS.FLAGS_READ), (req, res) => {
  try {
    const def = featureFlags.getDefinition(req.params.key);
    const value = featureFlags.getValue(req.params.key, { tenantId: req.query.tenantId });
    res.json({ ...def, resolvedValue: value });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// POST /api/feature-flags/:key { value } — set the global value.
// Kill-switch flags (tagged 'kill-switch' in FLAG_DEFINITIONS) require the
// admin-only FLAGS_KILL_SWITCH permission — the single highest-blast-radius
// action in this file gets its own, stricter gate rather than riding along
// on the general FLAGS_WRITE permission that any operator has.
router.post('/:key', (req, res, next) => {
  let def;
  try { def = featureFlags.getDefinition(req.params.key); }
  catch (err) { return res.status(404).json({ error: err.message }); }
  const needed = def.tags.includes('kill-switch') ? PERMISSIONS.FLAGS_KILL_SWITCH : PERMISSIONS.FLAGS_WRITE;
  return requirePermission(needed)(req, res, next);
}, (req, res) => {
  try {
    const result = featureFlags.setFlag(req.params.key, req.body.value, { userId: req.userId });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/feature-flags/:key/tenant/:tenantId { value } — set a tenant override.
router.post('/:key/tenant/:tenantId', requirePermission(PERMISSIONS.FLAGS_WRITE), (req, res) => {
  try {
    const result = featureFlags.setTenantOverride(
      req.params.key, req.params.tenantId, req.body.value, { userId: req.userId }
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/feature-flags/:key/tenant/:tenantId — clear a tenant override.
router.delete('/:key/tenant/:tenantId', requirePermission(PERMISSIONS.FLAGS_WRITE), (req, res) => {
  try {
    const result = featureFlags.clearTenantOverride(
      req.params.key, req.params.tenantId, { userId: req.userId }
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;

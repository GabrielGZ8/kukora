/**
 * rbac.js — Kukora Role-Based Access Control
 *
 * Builds a fine-grained permission layer on top of the role field that
 * already exists on the User model and already travels inside every JWT
 * (auth.js: `role: user.role`). Nothing about authentication changes —
 * this is purely an authorization layer.
 *
 * Why permissions instead of just checking role everywhere:
 *   `requireRole('admin')` (already used in a few places — see
 *   arbitrage/subroutes/config.routes.js) is fine for a strict binary gate,
 *   but it means every call site has to know and agree on which roles are
 *   allowed. `requirePermission('flags:kill_switch')` names *what the
 *   route needs*, not *who's allowed* — the mapping from roles to
 *   permissions lives in exactly one place (ROLE_PERMISSIONS below), so
 *   promoting/demoting what a role can do is a one-line change here
 *   instead of an audit of every route file.
 *
 * Three roles (User model: 'user' | 'operator' | 'admin'):
 *   user     — read-only on ops/flags/jobs surfaces. Can act within their
 *              own tenant scope elsewhere in the app (tenantBot routes,
 *              unaffected by this module).
 *   operator — day-to-day ops: flip non-kill-switch flags, trigger jobs.
 *              The role an on-call engineer or ops lead gets.
 *   admin    — operator + the actions with the highest blast radius:
 *              kill switches and (future) user/role management.
 *
 * Unknown/missing roles resolve to 'user' — the least-privileged set —
 * never to an error and never to elevated access. Fail closed.
 */

'use strict';

const PERMISSIONS = Object.freeze({
  FLAGS_READ:        'flags:read',
  FLAGS_WRITE:        'flags:write',        // non-kill-switch flags (global + tenant overrides)
  FLAGS_KILL_SWITCH:  'flags:kill_switch',   // killSwitchTrading / killSwitchTenantExecution specifically
  JOBS_READ:          'jobs:read',
  JOBS_RUN:           'jobs:run',
  OPS_READ:           'ops:read',
  TRADES_REPLAY:      'trades:replay',
});

const ROLE_PERMISSIONS = Object.freeze({
  user: Object.freeze([
    PERMISSIONS.FLAGS_READ, PERMISSIONS.JOBS_READ, PERMISSIONS.OPS_READ, PERMISSIONS.TRADES_REPLAY,
  ]),
  operator: Object.freeze([
    PERMISSIONS.FLAGS_READ, PERMISSIONS.FLAGS_WRITE,
    PERMISSIONS.JOBS_READ, PERMISSIONS.JOBS_RUN,
    PERMISSIONS.OPS_READ, PERMISSIONS.TRADES_REPLAY,
  ]),
  admin: Object.freeze([
    PERMISSIONS.FLAGS_READ, PERMISSIONS.FLAGS_WRITE, PERMISSIONS.FLAGS_KILL_SWITCH,
    PERMISSIONS.JOBS_READ, PERMISSIONS.JOBS_RUN,
    PERMISSIONS.OPS_READ, PERMISSIONS.TRADES_REPLAY,
  ]),
});

/** True if `role` (fails closed to 'user' if unrecognized) grants `permission`. */
function hasPermission(role, permission) {
  const perms = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.user;
  return perms.includes(permission);
}

/**
 * Express middleware. Must be mounted after requireAuth (reads req.user.role,
 * exactly like requireRole() in auth.js — no extra DB roundtrip).
 */
function requirePermission(permission) {
  return function (req, res, next) {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: 'Authentication required', code: 'NO_TOKEN' });
    }
    const role = req.user.role || 'user';
    if (!hasPermission(role, permission)) {
      return res.status(403).json({
        ok: false,
        error: `Forbidden: requires permission "${permission}" (role "${role}" does not grant it)`,
        code: 'INSUFFICIENT_PERMISSION',
      });
    }
    next();
  };
}

module.exports = { PERMISSIONS, ROLE_PERMISSIONS, hasPermission, requirePermission };

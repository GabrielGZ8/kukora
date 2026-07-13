'use strict';
/**
 * twoFactor.js — Fase 3 pendiente #1: TOTP-based 2FA gating switching a
 * user into live trading mode and placing live orders.
 *
 * State model (per userId):
 *   - "pending" secret: created by beginSetup(), not yet usable to trade —
 *     exists only to prove the user scanned the QR / added it to their
 *     authenticator app before it's trusted.
 *   - "enabled" secret: promoted from pending by confirmSetup() once a
 *     valid token round-trips. This is the secret verify() checks against.
 *
 * Storage is in-memory (Map), consistent with liveExecution.js's
 * _userModes — this is a single-operator deployment model (see the module
 * header of liveExecution.js), not a multi-tenant SaaS, so per-process
 * state is an accepted tradeoff rather than an oversight. Restarting the
 * server clears 2FA enrollment the same way it clears trading mode.
 */
const { logger } = require('../infrastructure/logger');
const totp = require('../infrastructure/totp');
const _pending = new Map(); // userId -> secret
const _enabled = new Map(); // userId -> secret
/**
 * beginSetup — generates a new candidate secret for userId and returns it
 * plus an otpauth:// URL for QR-code enrollment. Does NOT enable 2FA yet;
 * call confirmSetup() with a token generated from this secret to do that.
 * Calling this again before confirming simply replaces the pending secret
 * (e.g. the user re-scanned after an app reinstall).
 */
function beginSetup(userId, { accountName } = {}) {
  const secret = totp.generateSecret();
  _pending.set(userId, secret);
  const otpauthUrl = totp.generateOtpauthUrl(secret, {
    issuer: 'Kukora',
    accountName: accountName || userId,
  });
  return { secret, otpauthUrl };
}
/**
 * confirmSetup — promotes the pending secret to enabled once the caller
 * proves possession of it via a valid current token. Throws (rather than
 * returning false) on failure, matching the style of the trading routes
 * that call this and turn a thrown Error into a 400/401 response.
 */
function confirmSetup(userId, token) {
  const secret = _pending.get(userId);
  if (!secret) {
    throw new Error('No pending 2FA setup for this user. POST /api/trading/2fa/setup first.');
  }
  if (!totp.verifyToken(secret, token)) {
    throw new Error('Invalid 2FA token');
  }
  _enabled.set(userId, secret);
  _pending.delete(userId);
  logger.info('twoFactor', '2FA enabled', { userId });
  return { enabled: true };
}
/** isEnabled — true once confirmSetup() has succeeded for this user. */
function isEnabled(userId) {
  return _enabled.has(userId);
}
/**
 * verify — checks `token` against the user's enabled secret. Never
 * throws: returns false both for a wrong token and for a user with no
 * enabled 2FA at all, so callers can use it as a single boolean gate.
 */
function verify(userId, token) {
  const secret = _enabled.get(userId);
  if (!secret) return false;
  return totp.verifyToken(secret, token);
}
/**
 * disable — requires a valid current token (proof of possession) before
 * turning 2FA off, so a hijacked session can't silently downgrade a
 * user's account security.
 */
function disable(userId, token) {
  const secret = _enabled.get(userId);
  if (!secret || !totp.verifyToken(secret, token)) {
    throw new Error('Invalid 2FA token');
  }
  _enabled.delete(userId);
  logger.info('twoFactor', '2FA disabled', { userId });
  return { enabled: false };
}
/** getStatus — shape consumed directly by GET /api/trading/2fa/status. */
function getStatus(userId) {
  return {
    enabled: isEnabled(userId),
    pendingSetup: _pending.has(userId),
  };
}
/** _resetAll — test helper only; clears all enrollment state. */
function _resetAll() {
  _pending.clear();
  _enabled.clear();
}
module.exports = {
  beginSetup,
  confirmSetup,
  isEnabled,
  verify,
  disable,
  getStatus,
  _resetAll,
};

'use strict';

/**
 * sessionMiddleware.js — Session-based user identity
 *
 * Reads the X-Session-ID header sent by the frontend (a UUID v4 stored in
 * localStorage) and attaches it to req.userId. This makes the persistence
 * layer multi-session without requiring full authentication.
 *
 * If no session header is present (e.g. curl, Postman, healthchecks),
 * falls back to 'anonymous' rather than crashing.
 *
 * The frontend generates the session ID on first load and stores it in
 * localStorage under the key 'kukora_session_id'.
 */

const SESSION_HEADER = 'x-session-id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sessionMiddleware(req, res, next) {
  const raw = req.headers[SESSION_HEADER];
  // Validate it's actually a UUID v4 to prevent header injection
  if (raw && UUID_RE.test(raw)) {
    req.userId = raw.toLowerCase();
  } else {
    req.userId = 'anonymous';
  }
  next();
}

module.exports = { sessionMiddleware };

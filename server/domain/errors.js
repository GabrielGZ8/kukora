'use strict';
/**
 * server/domainErrors.js — audit fix 3.5 (jerarquía de errores de dominio)
 *
 * Before this fix, every route decided its own status code and error shape
 * by hand (`{ ok:false, error }` in some files, `{ ok:false, error, code }`
 * in others like auth.js), and the global error handler in index.js had no
 * way to distinguish "bad input" from "not found" from "insufficient funds" —
 * everything that reached it became a generic 500.
 *
 * This introduces a minimal hierarchy of domain errors with a `status` and a
 * machine-readable `code`, so:
 *   - routes can `throw new ValidationError(...)` instead of hand-rolling
 *     `res.status(400).json(...)`
 *   - the global error handler (server/index.js) can inspect `err.status`/
 *     `err.code` and respond consistently, without each route repeating the
 *     status-code logic.
 *
 * This is additive — existing routes that already do manual try/catch with
 * their own response shapes keep working unchanged. New and refactored code
 * should prefer throwing these.
 */

class DomainError extends Error {
  constructor(message, { status = 500, code = 'DOMAIN_ERROR', details = undefined } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    Error.captureStackTrace?.(this, this.constructor);
  }

  /** Shape sent to the client — never leaks stack traces. */
  toResponse() {
    const body = { ok: false, error: this.message, code: this.code };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

class ValidationError extends DomainError {
  constructor(message = 'Invalid input', details) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', details });
  }
}

class NotFoundError extends DomainError {
  constructor(message = 'Resource not found', details) {
    super(message, { status: 404, code: 'NOT_FOUND', details });
  }
}

class UnauthorizedError extends DomainError {
  constructor(message = 'Unauthorized', details) {
    super(message, { status: 401, code: 'UNAUTHORIZED', details });
  }
}

class ForbiddenError extends DomainError {
  constructor(message = 'Forbidden', details) {
    super(message, { status: 403, code: 'FORBIDDEN', details });
  }
}

class ConflictError extends DomainError {
  constructor(message = 'Conflict', details) {
    super(message, { status: 409, code: 'CONFLICT', details });
  }
}

/** Thrown by walletManager.js when a trade can't be applied due to balance. */
class InsufficientBalanceError extends DomainError {
  constructor(message = 'Insufficient balance', details) {
    super(message, { status: 422, code: 'INSUFFICIENT_BALANCE', details });
  }
}

/** Thrown by advancedRiskEngine.js when a trade is blocked by a risk rule. */
class RiskLimitError extends DomainError {
  constructor(message = 'Risk limit exceeded', details) {
    super(message, { status: 422, code: 'RISK_LIMIT_EXCEEDED', details });
  }
}

class RateLimitError extends DomainError {
  constructor(message = 'Too many requests', details) {
    super(message, { status: 429, code: 'RATE_LIMITED', details });
  }
}

class UpstreamServiceError extends DomainError {
  constructor(message = 'Upstream service unavailable', details) {
    super(message, { status: 503, code: 'UPSTREAM_UNAVAILABLE', details });
  }
}

/**
 * expressErrorHandler — drop-in replacement for the ad-hoc global handler
 * in server/index.js. Inspects DomainError instances for status/code/shape;
 * falls back to a generic 500 for anything else (never leaks stack traces).
 *
 * Usage in server/index.js:
 *   const { expressErrorHandler } = require('./domainErrors');
 *   app.use(expressErrorHandler(logger, IS_PROD));
 */
function expressErrorHandler(logger, isProd) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (err instanceof DomainError) {
      logger?.warn?.('express', err.message, { code: err.code, status: err.status, path: req.path, requestId: req.requestId });
      return res.status(err.status).json(err.toResponse());
    }
    logger?.error?.('express', 'Unhandled error', { err: err.message, path: req.path, requestId: req.requestId });
    const msg = isProd ? 'Internal server error' : err.message;
    return res.status(500).json({ ok: false, error: msg, code: 'INTERNAL_ERROR' });
  };
}

module.exports = {
  DomainError,
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  InsufficientBalanceError,
  RiskLimitError,
  RateLimitError,
  UpstreamServiceError,
  expressErrorHandler,
};

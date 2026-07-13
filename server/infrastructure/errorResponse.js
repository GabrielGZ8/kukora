'use strict';
/**
 * server/infrastructure/errorResponse.js
 *
 * Auditoría (sección 2, "manejo de errores"): la jerarquía `DomainError`
 * (server/domain/errors.js) existía pero ningún archivo de rutas la usaba —
 * cada uno repetía a mano `res.status(500).json({ ok:false, error })`, sin
 * distinguir un error de validación de uno de negocio o uno inesperado.
 *
 * `sendError` es el único punto donde una ruta traduce una excepción a una
 * respuesta HTTP. Si el error es un `DomainError` (o subclase: ValidationError,
 * NotFoundError, RiskLimitError, etc.) se usa su status/code/details propios.
 * Si es un error no tipado (bug, fallo de red, etc.) cae al status por
 * defecto (500) y oculta el mensaje interno en producción.
 *
 * Uso:
 *   const { sendError } = require('../infrastructure/errorResponse');
 *   try { ... } catch (e) { return sendError(res, e); }
 */

const { DomainError } = require('../domain/errors');

const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * @param {import('express').Response} res
 * @param {Error} err
 * @param {{ fallbackStatus?: number }} [opts]
 */
function sendError(res, err, opts = {}) {
  const fallbackStatus = opts.fallbackStatus ?? 500;

  if (err instanceof DomainError) {
    return res.status(err.status).json(err.toResponse());
  }

  // Legacy ad-hoc pattern still in use in a few call sites:
  // Object.assign(new Error(msg), { status: NNN }). Honor it during migration
  // so behavior doesn't change until every call site is converted.
  if (typeof err.status === 'number') {
    return res.status(err.status).json({ ok: false, error: err.message });
  }

  const msg = IS_PROD ? 'Internal server error' : err.message;
  return res.status(fallbackStatus).json({ ok: false, error: msg });
}

module.exports = { sendError };

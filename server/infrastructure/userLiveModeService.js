'use strict';
/**
 * userLiveModeService.js — checkpoint-37: toggle de "trading en vivo" POR
 * USUARIO, separado del `tradingMode` GLOBAL de liveConfig.js.
 *
 * GAP que cierra: antes de este módulo, `LIVE_TRADING_ENABLED` (env var,
 * liveConfig.js) era la ÚNICA puerta de trading en vivo — un interruptor
 * de todo-o-nada a nivel de servidor, controlado solo por el operador del
 * despliegue. Con credenciales por-usuario (userSecretsVault.js) ya
 * existiendo, falta la segunda mitad: que CADA USUARIO decida si SU CUENTA
 * específica opera en vivo, incluso con el servidor habilitado
 * globalmente. Un usuario nuevo, o uno que aún no conectó un exchange, NO
 * debe empezar a operar en vivo solo porque el operador activó
 * LIVE_TRADING_ENABLED=true para la plataforma entera.
 *
 * CONTRATO DE ACTIVACIÓN (enableLiveMode): activar el toggle EXIGE, en este
 * orden, los tres requisitos pedidos explícitamente:
 *   1. Al menos un exchange conectado con credenciales propias
 *      (userSecretsVault.hasAnyUserExchange) — sin esto, "modo real" no
 *      tendría ninguna credencial con la que operar.
 *   2. 2FA CONFIRMADO — reusa el mecanismo YA EXISTENTE en
 *      server/application/twoFactor.js (isEnabled + verify), sin duplicar
 *      lógica de TOTP aquí. El usuario debe tener 2FA habilitado Y proveer
 *      un token válido en el momento de activar (no basta con "2FA está
 *      habilitado en general" — se exige prueba de posesión AHORA, mismo
 *      criterio que ya usa twoFactor.disable()).
 *   3. Aceptación EXPLÍCITA del disclaimer de riesgo — `disclaimerAccepted
 *      !== true` rechaza. No hay checkbox pre-marcado posible desde este
 *      lado: el llamador (la ruta HTTP) debe recibir `true` literal del
 *      body, nunca un default.
 *
 * GATE DE EJECUCIÓN: `isLiveModeEnabled(userId)` es lo que
 * liveExecution.js:executeLive/executeCrossExchangeLive consulta ANTES de
 * cualquier ejecución real — ver `_requireUserLiveModeEnabled()` ahí. Esto
 * es un gate ADICIONAL sobre (nunca en reemplazo de) el existente
 * `LIVE_ENABLED` global / `getUserMode(userId) === 'live'`: para que un
 * trade real ocurra, TODOS deben ser true — servidor global habilitado,
 * modo del usuario en 'live', Y este toggle en true.
 *
 * PERSISTENCIA: mismo patrón que userRiskProfileService.js — LRU en
 * memoria (hot path síncrono, sin roundtrip a Mongo en cada trade) +
 * persistencia best-effort a UserTradingConfig.liveTradingEnabled. A
 * diferencia de userSecretsVault.setUserCredentials(), esto SÍ es
 * fire-and-forget: perder la persistencia de "modo real activado" tras un
 * reinicio del proceso es de bajo riesgo (el usuario simplemente necesita
 * reactivarlo — 2FA + disclaimer de nuevo — no es una credencial que se
 * "pierda" de forma insegura, es un estado que vuelve a su default seguro
 * `false`).
 */

const { logger } = require('./logger');
let _twoFactorRef = require('../application/twoFactor');
function _setTwoFactorForTests(m) { _twoFactorRef = m; }
function _resetTwoFactorForTests() { _twoFactorRef = require('../application/twoFactor'); }
let _userSecretsVaultRef = require('./userSecretsVault');
// Test-only seam — same root cause as the mongoose seam below: this
// module's internal CJS `require('./userSecretsVault')` and a test file's
// top-level ESM `import * as userSecretsVault from '.../userSecretsVault.js'`
// resolve to two *different* module instances under this project's Vitest
// setup (confirmed by direct object-identity check), so a test populating
// the ESM instance's in-memory cache is invisible to this module's own CJS
// instance unless a test points this module at the exact same instance.
function _setUserSecretsVaultForTests(m) { _userSecretsVaultRef = m; }
function _resetUserSecretsVaultForTests() { _userSecretsVaultRef = require('./userSecretsVault'); }

const MAX_CACHED_USERS = 1000;
const _enabled = new Map(); // userId -> { enabled: bool, enabledAt, disclaimerHash }

function _lruSet(userId, value) {
  if (_enabled.has(userId)) _enabled.delete(userId);
  if (_enabled.size >= MAX_CACHED_USERS) {
    const oldest = _enabled.keys().next().value;
    _enabled.delete(oldest);
  }
  _enabled.set(userId, value);
}

/** isLiveModeEnabled — synchronous hot-path check consumed by liveExecution.js. */
function isLiveModeEnabled(userId) {
  const entry = _enabled.get(userId);
  return !!(entry && entry.enabled);
}

/** getStatus — shape consumed by GET /api/user/live-mode. */
function getStatus(userId) {
  const entry = _enabled.get(userId);
  return {
    enabled: !!(entry && entry.enabled),
    enabledAt: entry?.enabledAt || null,
  };
}

const RISK_DISCLAIMER_TEXT =
  'Real-money trading uses actual funds on your connected exchange account(s). ' +
  'Kukora is not a financial advisor and does not guarantee profits. Market ' +
  'conditions, exchange outages, and software bugs can all result in financial ' +
  'loss. You are solely responsible for any losses incurred while live trading ' +
  'is enabled on your account.';

function _hashDisclaimer() {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(RISK_DISCLAIMER_TEXT).digest('hex');
}

/**
 * enableLiveMode — activates real-money trading for `userId`. Throws with a
 * clear, specific message on the first unmet requirement (never silently
 * fails, never partially activates).
 */
async function enableLiveMode(userId, { twoFactorToken, disclaimerAccepted } = {}) {
  if (!userId) throw new Error('userId is required');

  const hasExchange = await _userSecretsVaultRef.hasAnyUserExchange(userId);
  if (!hasExchange) {
    throw new Error(
      'Connect at least one exchange with your own API credentials before enabling live trading ' +
      '(POST /api/user/exchange-credentials).'
    );
  }

  if (!_twoFactorRef.isEnabled(userId)) {
    throw new Error('Two-factor authentication is not set up for this account. Set up 2FA before enabling live trading.');
  }
  if (!twoFactorToken || !_twoFactorRef.verify(userId, twoFactorToken)) {
    throw new Error('Invalid or missing 2FA token — a current 2FA code is required to enable live trading.');
  }

  if (disclaimerAccepted !== true) {
    throw new Error(
      'You must explicitly accept the risk disclaimer to enable live trading (disclaimerAccepted must be true).'
    );
  }

  const now = new Date();
  const disclaimerHash = _hashDisclaimer();
  _lruSet(userId, { enabled: true, enabledAt: now, disclaimerHash });
  logger.info('userLiveModeService', 'Live trading enabled for user', { userId });
  _persist(userId, true, now, disclaimerHash); // fire-and-forget, non-fatal
  return { enabled: true, enabledAt: now };
}

/** disableLiveMode — always succeeds; no 2FA required to turn OFF real trading. */
function disableLiveMode(userId) {
  _lruSet(userId, { enabled: false, enabledAt: null, disclaimerHash: null });
  logger.info('userLiveModeService', 'Live trading disabled for user', { userId });
  _persist(userId, false, null, null);
  return { enabled: false };
}

// ─── DB persistence (best-effort; falls back to in-memory only) ──────────
let _UserTradingConfig;
function _getModel() {
  if (!_UserTradingConfig) {
    try { _UserTradingConfig = require('../models').UserTradingConfig; } catch { /* unavailable */ }
  }
  return _UserTradingConfig;
}
function _resetModelForTests() { _UserTradingConfig = undefined; }

// Test-only seam (same root cause/fix as persistenceService.js /
// userSecretsVault.js): this module's internal CJS `require('mongoose')`
// and a test file's top-level ESM `import mongoose from 'mongoose'`
// resolve to two *different* mocked module instances in this project's
// Vitest setup — see the longer comment in persistenceService.js.
let _mongooseRef = require('mongoose');
function _setMongooseForTests(m) { _mongooseRef = m; }
function _resetMongooseForTests() { _mongooseRef = require('mongoose'); }

async function _persist(userId, enabled, enabledAt, disclaimerHash) {
  if (_mongooseRef.connection.readyState !== 1) return;
  const Model = _getModel();
  if (!Model) return;
  try {
    await Model.findOneAndUpdate(
      { userId },
      { $set: {
          liveTradingEnabled: enabled,
          liveTradingEnabledAt: enabledAt,
          liveTradingDisclaimerHash: disclaimerHash,
          updatedAt: new Date(),
        } },
      { upsert: true }
    );
  } catch (e) { logger.warn?.('userLiveModeService', 'Persist failed (non-fatal)', { error: e.message }); }
}

/** Hydrate the in-memory toggle for a user from the DB (call on login). */
async function loadLiveModeFromDb(userId) {
  if (_mongooseRef.connection.readyState !== 1) return getStatus(userId);
  const Model = _getModel();
  if (!Model) return getStatus(userId);
  try {
    const doc = await Model.findOne({ userId }).lean();
    if (doc && doc.liveTradingEnabled) {
      _lruSet(userId, {
        enabled: true,
        enabledAt: doc.liveTradingEnabledAt || null,
        disclaimerHash: doc.liveTradingDisclaimerHash || null,
      });
    }
  } catch { /* non-fatal */ }
  return getStatus(userId);
}

function _resetForTests() {
  _enabled.clear();
  _resetModelForTests();
}

/**
 * _forceEnableForTests — test-only seam. Bypasses the exchange/2FA/
 * disclaimer requirements enforced by enableLiveMode() so pre-existing
 * liveExecution.js test suites (written before this per-user toggle
 * existed) can keep exercising executeLive/executeCrossExchangeLive's
 * actual trading logic without re-deriving 2FA + exchange-connection
 * fixtures for every test. Never called from production code paths —
 * only from test loader helpers (see _autoSeedOpportunityStore-style
 * wrappers in tests/liveExecution*.test.js).
 */
function _forceEnableForTests(userId) {
  if (!userId) return;
  _lruSet(userId, { enabled: true, enabledAt: new Date(), disclaimerHash: 'test-bypass' });
}

module.exports = {
  RISK_DISCLAIMER_TEXT,
  isLiveModeEnabled,
  getStatus,
  enableLiveMode,
  disableLiveMode,
  loadLiveModeFromDb,
  _resetForTests,
  _forceEnableForTests,
  _setMongooseForTests,
  _resetMongooseForTests,
  _setUserSecretsVaultForTests,
  _resetUserSecretsVaultForTests,
  _setTwoFactorForTests,
  _resetTwoFactorForTests,
};

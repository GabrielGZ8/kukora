'use strict';
/**
 * userSecretsVault.js — checkpoint-37: bóveda de credenciales POR USUARIO.
 *
 * GAP (pedido explícito de extensión): `secretsVault.js` es, por diseño
 * documentado en su propio header, una bóveda GLOBAL — un único archivo
 * cifrado en disco, sin ningún concepto de `userId`. Con arbitraje
 * multi-usuario, cada usuario necesita poder conectar SUS PROPIAS
 * credenciales de exchange, sin que un operador tenga que tocar env vars
 * ni el archivo de bóveda global. Este módulo es un HERMANO de
 * secretsVault.js (mismo patrón AES-256-GCM, misma KUKORA_MASTER_KEY, mismas
 * encrypt()/decrypt()) — no una reescritura — extendiendo el almacenamiento
 * a Mongo (colección `UserExchangeCredential`, ver server/models.js) en vez
 * de un archivo plano, porque las credenciales por-usuario sí necesitan un
 * índice consultable por userId (secretsVault.js nunca lo necesitó: solo
 * había una bóveda entera para todo el despliegue).
 *
 * A DIFERENCIA de userRiskProfileService.js / userLiveModeService.js —
 * ambos "best-effort, fire-and-forget" porque perder ese estado en un
 * reinicio simplemente vuelve al default seguro — setUserCredentials() aquí
 * es SÍNCRONO CON LA ESCRITURA A MONGO: si la base de datos no está
 * conectada, la llamada FALLA (throw), en vez de reportar éxito y dejar la
 * credencial solo en el caché en memoria. Guardar una API key solo en RAM y
 * decirle al usuario "conectado" sería mentirle — la credencial
 * desaparecería en el siguiente reinicio del proceso sin ningún aviso.
 *
 * Lectura (getUserCredentials): caché LRU en memoria primero (hot path,
 * consumido por liveExecution.js en cada trade — ver _resolveCredentials()
 * ahí), Mongo como fuente de verdad detrás del caché. Nunca lanza para un
 * usuario sin credenciales — retorna null, igual que
 * secretsVault.getCredentials() retorna source:'none'.
 */

const { logger } = require('./logger');
const secretsVault = require('./secretsVault');

const MAX_CACHED_USERS = 1000;
// key: `${userId}::${exchange}` -> { apiKey, apiSecret, apiPassphrase, connectedAt }
const _cache = new Map();

function _cacheKey(userId, exchange) {
  return `${userId}::${exchange}`;
}

function _lruSet(key, value) {
  if (_cache.has(key)) _cache.delete(key);
  if (_cache.size >= MAX_CACHED_USERS) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
  _cache.set(key, value);
}

// ─── Model + mongoose test seams (same documented pattern as
// persistenceService.js / userRiskProfileService.js's siblings) ───────────
let _UserExchangeCredential;
function _getModel() {
  if (!_UserExchangeCredential) {
    try { _UserExchangeCredential = require('../models').UserExchangeCredential; } catch { /* unavailable */ }
  }
  return _UserExchangeCredential;
}
function _resetModelForTests() { _UserExchangeCredential = undefined; }

// This module's internal CJS `require('mongoose')` and a test file's
// top-level ESM `import mongoose from 'mongoose'` resolve to two
// *different* mocked module instances in this project's Vitest setup —
// see the longer comment in persistenceService.js for the full root cause.
let _mongooseRef = require('mongoose');
function _setMongooseForTests(m) { _mongooseRef = m; }
function _resetMongooseForTests() { _mongooseRef = require('mongoose'); }
function _isDbReady() { return _mongooseRef.connection.readyState === 1; }

/**
 * setUserCredentials — connects (or rotates) a user's own API credentials
 * for `exchange`. Encrypts apiKey/apiSecret (and apiPassphrase, OKX only)
 * with the same AES-256-GCM scheme as the global vault, then upserts to
 * Mongo. THROWS if the database is not connected — this is a deliberate
 * departure from the fire-and-forget persistence used elsewhere in this
 * checkpoint (see module header) because silently keeping a credential
 * only in memory would misrepresent it as durably saved.
 */
async function setUserCredentials(userId, exchange, apiKey, apiSecret, extra = {}) {
  if (!userId || !exchange || !apiKey || !apiSecret) {
    throw new Error('setUserCredentials(userId, exchange, apiKey, apiSecret) requires all four arguments');
  }
  if (!_isDbReady()) {
    throw new Error(
      'Cannot persist exchange credentials — database is not connected. Refusing to report ' +
      'success while the credential would only live in memory and vanish on the next restart.'
    );
  }
  const Model = _getModel();
  if (!Model) {
    throw new Error('Cannot persist exchange credentials — UserExchangeCredential model is unavailable.');
  }

  const exchangeLower = exchange.toLowerCase();
  const passphrase = extra.passphrase || null;

  const $set = {
    apiKeyEnc: secretsVault.encrypt(apiKey),
    apiSecretEnc: secretsVault.encrypt(apiSecret),
    apiPassphraseEnc: passphrase ? secretsVault.encrypt(passphrase) : null,
    updatedAt: new Date(),
  };

  const doc = await Model.findOneAndUpdate(
    { userId, exchange: exchangeLower },
    { $set, $setOnInsert: { connectedAt: new Date() } },
    { upsert: true, new: true }
  );

  const connectedAt = (doc && doc.connectedAt) || new Date();
  _lruSet(_cacheKey(userId, exchangeLower), {
    apiKey, apiSecret, apiPassphrase: passphrase, connectedAt,
  });

  logger.info('userSecretsVault', 'User exchange credentials connected/rotated', { userId, exchange: exchangeLower });
  return { ok: true, exchange: exchangeLower, connectedAt };
}

/**
 * getUserCredentials — hot-path read consumed by liveExecution.js's
 * _resolveCredentials(). Serves from the in-memory cache when populated
 * (no Mongo round-trip); falls back to Mongo + decrypt on a cache miss.
 * Never throws for "no credentials" — returns null so callers can fall
 * back to the global vault/env exactly as before.
 */
async function getUserCredentials(userId, exchange) {
  const exchangeLower = exchange.toLowerCase();
  const key = _cacheKey(userId, exchangeLower);

  const cached = _cache.get(key);
  if (cached) {
    return { apiKey: cached.apiKey, apiSecret: cached.apiSecret, apiPassphrase: cached.apiPassphrase || null, source: 'user' };
  }

  if (!_isDbReady()) return null;
  const Model = _getModel();
  if (!Model) return null;

  try {
    const doc = await Model.findOne({ userId, exchange: exchangeLower }).lean();
    if (!doc) return null;

    const apiKey = secretsVault.decrypt(doc.apiKeyEnc);
    const apiSecret = secretsVault.decrypt(doc.apiSecretEnc);
    const apiPassphrase = doc.apiPassphraseEnc ? secretsVault.decrypt(doc.apiPassphraseEnc) : null;

    _lruSet(key, { apiKey, apiSecret, apiPassphrase, connectedAt: doc.connectedAt });
    return { apiKey, apiSecret, apiPassphrase, source: 'user' };
  } catch (e) {
    logger.warn?.('userSecretsVault', 'Failed to read/decrypt user credentials', { userId, exchange: exchangeLower, error: e.message });
    return null;
  }
}

/**
 * listUserExchanges — exchange name + connectedAt only, NEVER key
 * material. Consumed by GET /api/user/exchange-credentials.
 */
async function listUserExchanges(userId) {
  if (!_isDbReady()) return [];
  const Model = _getModel();
  if (!Model) return [];
  try {
    const docs = await Model.find({ userId }).sort({ connectedAt: -1 }).lean();
    return (docs || []).map(d => ({ exchange: d.exchange, connectedAt: d.connectedAt }));
  } catch (e) {
    logger.warn?.('userSecretsVault', 'Failed to list user exchanges', { userId, error: e.message });
    return [];
  }
}

/**
 * hasAnyUserExchange — used by userLiveModeService.enableLiveMode()'s first
 * requirement. Checks the in-memory cache first — covers the common flow
 * where a user just connected an exchange earlier in the same process
 * (e.g. immediately enabling live mode right after connecting a key)
 * without a redundant Mongo round-trip — then falls back to a real
 * listUserExchanges() DB query for a cache-cold check (e.g. right after a
 * restart, before any credential has been read/written in this process).
 */
async function hasAnyUserExchange(userId) {
  for (const key of _cache.keys()) {
    if (key.startsWith(`${userId}::`)) return true;
  }
  const list = await listUserExchanges(userId);
  return list.length > 0;
}

/** deleteUserCredentials — removes a connected exchange (disconnect/rotate-out). */
async function deleteUserCredentials(userId, exchange) {
  const exchangeLower = exchange.toLowerCase();
  _cache.delete(_cacheKey(userId, exchangeLower));

  if (!_isDbReady()) return { ok: true, existed: false };
  const Model = _getModel();
  if (!Model) return { ok: true, existed: false };

  try {
    const doc = await Model.findOneAndDelete({ userId, exchange: exchangeLower });
    const existed = Boolean(doc);
    logger.info('userSecretsVault', 'User exchange credentials deleted', { userId, exchange: exchangeLower, existed });
    return { ok: true, existed };
  } catch (e) {
    logger.warn?.('userSecretsVault', 'Failed to delete user credentials', { userId, exchange: exchangeLower, error: e.message });
    return { ok: true, existed: false };
  }
}

function _resetForTests() {
  _cache.clear();
  _resetModelForTests();
}

module.exports = {
  setUserCredentials,
  getUserCredentials,
  listUserExchanges,
  hasAnyUserExchange,
  deleteUserCredentials,
  _resetForTests,
  _setMongooseForTests,
  _resetMongooseForTests,
};

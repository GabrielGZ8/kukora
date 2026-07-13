'use strict';

/**
 * server/repositories/baseRepository.js — Repository Layer base class
 * (audit Level 3 #3; extraído de repositories/index.js en la sesión de
 * cierre del hallazgo estructural "repositorio único de 315 líneas" de
 * la auditoría de comité 2026-07-08, sección de Arquitectura).
 *
 * CONTEXTO DEL REFACTOR: `server/repositories/index.js` concentraba en un
 * solo archivo la clase base, las 3 clases concretas (Alert/Watchlist/
 * Portfolio), `MockRepository` y la factory `buildRepositories()` — 315
 * líneas para 5 responsabilidades distintas. Se extrajo cada una a su
 * propio archivo (mismo patrón ya usado para `server/domain/{engines,
 * risk,wallet}/` — "domain/ en subcarpetas por responsabilidad", hallazgo
 * #3 de la hoja de ruta de 8 puntos, ya cerrado en sesiones previas).
 *
 * IMPORTANTE — no romper `tests/repositories-real.test.js`: ese archivo
 * hace `vi.spyOn(BaseRepository.prototype, '_isDbReady')` para controlar
 * el flag de "DB lista" de forma determinista. Mientras `AlertRepository`/
 * `WatchlistRepository`/`PortfolioRepository` sigan extendiendo esta MISMA
 * clase (importada, no copiada) el spy sigue funcionando exactamente
 * igual — Node cachea el módulo, así que hay una sola instancia de
 * `BaseRepository` en todo el proceso.
 *
 * Design decisions (sin cambios respecto al archivo original):
 *   - Repositories are NOT singletons — callers can new them up or use
 *     the pre-built exports from repositories/index.js.
 *   - All methods are async and resolve with plain objects (lean: true),
 *     not Mongoose documents. Callers never need to call .toObject().
 *   - findOneAndDelete / findOneAndUpdate always include the userId guard
 *     so row-level isolation is enforced at the repo layer, not per-route.
 *
 * H-4 fix (ver MIGRATION_CLEANUP_LOG.md, Sesión 19): un error real de
 * Mongo (timeout, conexión caída, índice corrupto) ya no se traga con
 * `.catch(() => [])` / `.catch(() => null)` — se loguea con `_logDbError`
 * y se re-lanza, distinguiéndolo de "no hay resultados" (que sigue siendo
 * el comportamiento correcto cuando `_isDbReady()` es `false`, un modo de
 * degradación intencional y ya probado, `_noDb: true`).
 */

const { logger } = require('../infrastructure/logger');

/**
 * _logDbError — loguea el error real con contexto (operación, modelo) y lo
 * re-lanza sin modificar. Usar como `.catch(e => _logDbError(e, 'findByUser', this.Model.modelName))`.
 * Exportado porque `alertRepository.js`/`watchlistRepository.js`/
 * `portfolioRepository.js` también lo usan para sus métodos propios
 * (`upsertCoins`, `listForUser`, `addEntryIdempotent`, ...).
 */
function _logDbError(err, operation, modelName) {
  logger.error('repository', `DB operation failed: ${operation}`, {
    model: modelName,
    err: err.message,
  });
  throw err;
}

// ── Base repository ────────────────────────────────────────────────────────

class BaseRepository {
  /**
   * @param {import('mongoose').Model<any>} Model
   */
  constructor(Model) {
    this.Model = Model;
  }

  /** @returns {boolean} */
  _isDbReady() {
    const mongoose = require('mongoose');
    return mongoose.connection.readyState === 1;
  }

  /**
   * findByUser — fetch all documents owned by userId, newest first.
   * @param {string} userId
   * @param {object} [extra] - additional filter fields
   * @returns {Promise<object[]>}
   */
  async findByUser(userId, extra = {}) {
    if (!this._isDbReady()) return [];
    return this.Model.find({ userId, ...extra })
      .sort({ createdAt: -1 })
      .lean()
      .catch(e => _logDbError(e, 'findByUser', this.Model.modelName));
  }

  /**
   * findOneByUser — fetch a single document owned by userId.
   * @param {string} userId
   * @param {object} [extra]
   * @returns {Promise<object|null>}
   */
  async findOneByUser(userId, extra = {}) {
    if (!this._isDbReady()) return null;
    return this.Model.findOne({ userId, ...extra }).lean()
      .catch(e => _logDbError(e, 'findOneByUser', this.Model.modelName));
  }

  /**
   * create — insert a new document, stamping userId.
   * @param {string} userId
   * @param {object} data
   * @returns {Promise<object|null>}
   */
  async create(userId, data) {
    if (!this._isDbReady()) return null;
    return this.Model.create({ ...data, userId })
      .catch(e => _logDbError(e, 'create', this.Model.modelName));
  }

  /**
   * updateByUser — findOneAndUpdate with userId guard (row-level isolation).
   * @param {string} userId
   * @param {string} id  - document _id
   * @param {object} patch
   * @returns {Promise<object|null>}
   */
  async updateByUser(userId, id, patch) {
    if (!this._isDbReady()) return null;
    return this.Model.findOneAndUpdate(
      { _id: id, userId },
      patch,
      { new: true },
    ).lean().catch(e => _logDbError(e, 'updateByUser', this.Model.modelName));
  }

  /**
   * deleteByUser — findOneAndDelete with userId guard (row-level isolation).
   * @param {string} userId
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async deleteByUser(userId, id) {
    if (!this._isDbReady()) return null;
    return this.Model.findOneAndDelete({ _id: id, userId })
      .catch(e => _logDbError(e, 'deleteByUser', this.Model.modelName));
  }
}

module.exports = { BaseRepository, _logDbError };

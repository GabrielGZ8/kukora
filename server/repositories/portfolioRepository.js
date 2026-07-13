'use strict';

/**
 * server/repositories/portfolioRepository.js — Portfolio entity repository.
 * Extraído de repositories/index.js (ver baseRepository.js para el
 * contexto completo del refactor).
 */

const { BaseRepository, _logDbError } = require('./baseRepository');

class PortfolioRepository extends BaseRepository {
  constructor(PortfolioModel) { super(PortfolioModel); }

  async listForUser(userId, { offset = 0, limit = 20 } = {}) {
    if (!this._isDbReady()) return { items: [], total: 0 };
    const [items, total] = await Promise.all([
      this.Model.find({ userId })
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean()
        .catch(e => _logDbError(e, 'listForUser.find', this.Model.modelName)),
      this.Model.countDocuments({ userId })
        .catch(e => _logDbError(e, 'listForUser.count', this.Model.modelName)),
    ]);
    return { items, total };
  }

  async addEntry(userId, data) {
    return this.create(userId, data);
  }

  /**
   * addEntryIdempotent — same as addEntry, but replays the original result
   * for a duplicate (userId, idempotencyKey) pair created within
   * `windowMs` instead of creating a second position. Moved here from the
   * route handler (Nivel 3 #3 — routes should not touch Mongoose directly).
   *
   * @param {string} userId
   * @param {object} data
   * @param {string} idempotencyKey
   * @param {number} [windowMs=60000]
   */
  async addEntryIdempotent(userId, data, idempotencyKey, windowMs = 60_000) {
    if (!this._isDbReady()) return null;
    const since = new Date(Date.now() - windowMs);
    const existing = await this.Model.findOne({
      userId,
      _idempotencyKey: idempotencyKey,
      createdAt: { $gte: since },
    }).lean().catch(e => _logDbError(e, 'addEntryIdempotent.findOne', this.Model.modelName));
    if (existing) return existing; // replay: return the original result
    return this.Model.create({ ...data, userId, _idempotencyKey: idempotencyKey })
      .catch(e => _logDbError(e, 'addEntryIdempotent.create', this.Model.modelName));
  }

  async deleteEntry(userId, entryId) {
    return this.deleteByUser(userId, entryId);
  }
}

module.exports = { PortfolioRepository };

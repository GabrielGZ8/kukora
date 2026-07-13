'use strict';

/**
 * server/repositories/watchlistRepository.js — Watchlist entity repository.
 * Extraído de repositories/index.js (ver baseRepository.js para el
 * contexto completo del refactor).
 */

const { BaseRepository, _logDbError } = require('./baseRepository');

class WatchlistRepository extends BaseRepository {
  constructor(WatchlistModel) { super(WatchlistModel); }

  async getWatchlist(userId) {
    const doc = await this.findOneByUser(userId);
    return doc ?? { coins: [] };
  }

  async upsertCoins(userId, coins) {
    if (!this._isDbReady()) return { coins };
    const doc = await this.Model.findOneAndUpdate(
      { userId },
      { $set: { coins } },
      { upsert: true, new: true },
    ).lean().catch(e => _logDbError(e, 'upsertCoins', this.Model.modelName));
    return doc ?? { coins };
  }
}

module.exports = { WatchlistRepository };

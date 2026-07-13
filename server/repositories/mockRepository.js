'use strict';

/**
 * server/repositories/mockRepository.js — in-memory implementation of
 * BaseRepository's API, for tests. Extraído de repositories/index.js
 * (ver baseRepository.js para el contexto completo del refactor).
 *
 * Usage in tests:
 *   const repo = new MockRepository([{ _id: '1', userId: 'u1', coin: 'BTC' }]);
 *   const results = await repo.findByUser('u1');
 *   expect(results).toHaveLength(1);
 *
 * Row-level isolation is enforced: findByUser('u2') returns [] in the above.
 */

class MockRepository {
  /** @param {object[]} [initialData] */
  constructor(initialData = []) {
    this._store = [...initialData];
  }

  async findByUser(userId, extra = {}) {
    return this._store.filter(d => {
      if (d.userId !== userId) return false;
      return Object.entries(extra).every(([k, v]) => d[k] === v);
    });
  }

  async findOneByUser(userId, extra = {}) {
    return (await this.findByUser(userId, extra))[0] ?? null;
  }

  async create(userId, data) {
    const doc = { _id: `mock-${Date.now()}`, userId, ...data };
    this._store.push(doc);
    return doc;
  }

  async updateByUser(userId, id, patch) {
    const idx = this._store.findIndex(d => d._id === id && d.userId === userId);
    if (idx === -1) return null;
    this._store[idx] = { ...this._store[idx], ...patch };
    return this._store[idx];
  }

  async deleteByUser(userId, id) {
    const idx = this._store.findIndex(d => d._id === id && d.userId === userId);
    if (idx === -1) return null;
    return this._store.splice(idx, 1)[0];
  }

  /** Reset store to empty or provided data (test helper). */
  reset(data = []) { this._store = [...data]; }

  /** Return a snapshot of current store (test helper). */
  snapshot() { return this._store.map(d => ({ ...d })); }
}

module.exports = { MockRepository };

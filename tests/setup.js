'use strict';

/**
 * tests/setup.js — Global test setup for Vitest
 *
 * Mocks mongoose before any server module is loaded, so modules that
 * require('./models') or mongoose can be imported in unit tests without
 * a live database connection.
 */

import { vi } from 'vitest';

vi.mock('mongoose', () => {
  class MockSchema {
    constructor() {}
    index() { return this; }
  }
  MockSchema.Types = { Mixed: 'Mixed', ObjectId: 'ObjectId' };

  // Real mongoose throws OverwriteModelError if mongoose.model(name, schema)
  // is called twice for the same name. server/models.js calls it once per
  // model at module load time — fine in production (loaded once), but in
  // tests several files independently `require('../server/models.js')`,
  // and depending on vitest's module cache behavior across files that can
  // re-execute the module body. Caching by name here mirrors mongoose's
  // real "return existing model" behavior instead of throwing.
  const _models = {};
  function model(name) {
    if (!_models[name]) {
      _models[name] = {
        create:            vi.fn(async (doc) => ({ ...doc, _id: 'mock-id' })),
        find:              vi.fn(() => ({
          sort: () => ({
            skip: (n) => ({
              limit: () => ({ lean: async () => [] }),
            }),
            limit: () => ({ lean: async () => [] }),
            lean: async () => [],
          }),
          lean: async () => [],
        })),
        // findOne returns an object with BOTH .lean() (direct, for TokenBlacklist usage)
        // AND .sort().lean() (for chained queries).
        findOne:           vi.fn(() => ({
          lean:  async () => null,
          sort:  () => ({ lean: async () => null }),
          catch: (fn) => Promise.resolve(null).catch(fn),
        })),
        findById:          vi.fn(async () => null),
        findOneAndUpdate:  vi.fn(async () => null),
        findOneAndDelete:  vi.fn(async () => null),
        findByIdAndUpdate: vi.fn(() => ({ select: async () => null })),
        findByIdAndDelete: vi.fn(async () => null),
        countDocuments:    vi.fn(async () => 0),
        updateMany:        vi.fn(async () => ({ modifiedCount: 0 })),
      };
    }
    return _models[name];
  }

  return {
    default: {
      Schema: MockSchema,
      model,
      connect:    vi.fn(async () => {}),
      connection: { readyState: 0, db: { admin: () => ({ ping: async () => ({}) }) } },
    },
    Schema: MockSchema,
  };
});

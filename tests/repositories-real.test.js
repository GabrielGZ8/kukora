'use strict';

/**
 * repositories-real.test.js
 *
 * tests/repositories.test.js solo ejerce MockRepository — nunca las clases
 * reales (BaseRepository, AlertRepository, WatchlistRepository,
 * PortfolioRepository), que son las que de verdad hablan con Mongoose
 * (find().sort().skip().limit().lean(), findOneAndUpdate con upsert,
 * countDocuments, _isDbReady()). Por eso repositories/index.js seguía en
 * ~43% de cobertura pese a tener 24 tests.
 *
 * Estrategia: en vez de mockear mongoose globalmente (con los problemas de
 * interop require()/import ya vistos en watchdog), usamos vi.spyOn sobre
 * BaseRepository.prototype._isDbReady para controlar el flag "DB lista"
 * de forma determinista, y un Model falso minimalista que imita el query
 * builder de Mongoose (find/findOne/findOneAndUpdate/findOneAndDelete/
 * countDocuments/create) sobre un array en memoria.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  BaseRepository,
  AlertRepository,
  WatchlistRepository,
  PortfolioRepository,
} = require('../server/repositories/index.js');

function matches(doc, query) {
  return Object.entries(query).every(([k, v]) => String(doc[k]) === String(v));
}

/** Construye un Model falso respaldado por un array en memoria. */
function makeFakeModel(store) {
  return {
    _store: store,
    find(query = {}) {
      const rows = () => store.filter(d => matches(d, query));
      const chain = {
        sort() { return chain; },
        skip(n) { chain._skip = n; return chain; },
        limit(n) { chain._limit = n; return chain; },
        lean: async () => {
          let r = rows();
          if (chain._skip != null) r = r.slice(chain._skip);
          if (chain._limit != null) r = r.slice(0, chain._limit);
          return r;
        },
      };
      return chain;
    },
    findOne(query = {}) {
      return { lean: async () => store.find(d => matches(d, query)) || null };
    },
    async create(doc) {
      const created = { _id: `id-${store.length + 1}`, ...doc };
      store.push(created);
      return created;
    },
    findOneAndUpdate(query, patch, opts = {}) {
      return {
        lean: async () => {
          const idx = store.findIndex(d => matches(d, query));
          const setPatch = patch.$set || patch;
          if (idx === -1) {
            if (opts.upsert) {
              const created = { _id: `id-${store.length + 1}`, ...query, ...setPatch };
              store.push(created);
              return created;
            }
            return null;
          }
          store[idx] = { ...store[idx], ...setPatch };
          return store[idx];
        },
      };
    },
    async findOneAndDelete(query) {
      const idx = store.findIndex(d => matches(d, query));
      if (idx === -1) return null;
      return store.splice(idx, 1)[0];
    },
    async countDocuments(query = {}) {
      return store.filter(d => matches(d, query)).length;
    },
  };
}

describe('BaseRepository (real, DB-backed via fake Model)', () => {
  let store;
  let repo;
  let readySpy;

  beforeEach(() => {
    store = [
      { _id: '1', userId: 'u1', name: 'Alpha', createdAt: new Date('2024-01-01') },
      { _id: '2', userId: 'u1', name: 'Beta', createdAt: new Date('2024-01-02') },
      { _id: '3', userId: 'u2', name: 'Gamma', createdAt: new Date('2024-01-03') },
    ];
    repo = new BaseRepository(makeFakeModel(store));
    readySpy = vi.spyOn(BaseRepository.prototype, '_isDbReady').mockReturnValue(true);
  });

  afterEach(() => {
    readySpy.mockRestore();
  });

  describe('cuando la DB no está lista (_isDbReady = false)', () => {
    it('findByUser devuelve []', async () => {
      readySpy.mockReturnValue(false);
      expect(await repo.findByUser('u1')).toEqual([]);
    });

    it('findOneByUser devuelve null', async () => {
      readySpy.mockReturnValue(false);
      expect(await repo.findOneByUser('u1')).toBeNull();
    });

    it('create devuelve null', async () => {
      readySpy.mockReturnValue(false);
      expect(await repo.create('u1', { name: 'X' })).toBeNull();
    });

    it('updateByUser devuelve null', async () => {
      readySpy.mockReturnValue(false);
      expect(await repo.updateByUser('u1', '1', {})).toBeNull();
    });

    it('deleteByUser devuelve null', async () => {
      readySpy.mockReturnValue(false);
      expect(await repo.deleteByUser('u1', '1')).toBeNull();
    });
  });

  describe('cuando la DB está lista', () => {
    it('findByUser filtra por userId', async () => {
      const result = await repo.findByUser('u1');
      expect(result).toHaveLength(2);
      result.forEach(d => expect(d.userId).toBe('u1'));
    });

    it('findByUser aplica filtros extra', async () => {
      const result = await repo.findByUser('u1', { name: 'Alpha' });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Alpha');
    });

    it('findOneByUser devuelve el primer match', async () => {
      const doc = await repo.findOneByUser('u2');
      expect(doc.name).toBe('Gamma');
    });

    it('findOneByUser devuelve null si no hay match', async () => {
      expect(await repo.findOneByUser('nadie')).toBeNull();
    });

    it('create inserta el documento con userId', async () => {
      const doc = await repo.create('u3', { name: 'Delta' });
      expect(doc.userId).toBe('u3');
      expect(doc.name).toBe('Delta');
      expect(store).toHaveLength(4);
    });

    it('updateByUser actualiza respetando el guard de userId', async () => {
      const updated = await repo.updateByUser('u1', '1', { name: 'Alpha v2' });
      expect(updated.name).toBe('Alpha v2');
    });

    it('updateByUser retorna null si el documento pertenece a otro usuario', async () => {
      const result = await repo.updateByUser('u2', '1', { name: 'Hacked' });
      expect(result).toBeNull();
      expect(store.find(d => d._id === '1').name).toBe('Alpha');
    });

    it('deleteByUser elimina respetando el guard de userId', async () => {
      const deleted = await repo.deleteByUser('u1', '2');
      expect(deleted.name).toBe('Beta');
      expect(store.find(d => d._id === '2')).toBeUndefined();
    });

    it('deleteByUser retorna null si el documento pertenece a otro usuario', async () => {
      const result = await repo.deleteByUser('u2', '1');
      expect(result).toBeNull();
      expect(store.find(d => d._id === '1')).toBeDefined();
    });
  });

  describe('manejo de errores del Model (H-4: throw + log, no swallow)', () => {
    // H-4 fix (Sesión 19, MIGRATION_CLEANUP_LOG.md): antes estos métodos
    // tragaban cualquier error del Model y devolvían un valor por defecto
    // ([]/null), indistinguible de "no hay resultados". Ahora el error real
    // se loguea (logger.error) y se re-lanza — los route handlers ya usan
    // el patrón `wrapDb` que captura la excepción y responde 500, así que
    // un caído de Mongo ya no se disfraza de "sin datos".
    it('findByUser re-lanza el error del Model en vez de devolver []', async () => {
      const throwingModel = {
        modelName: 'FakeModel',
        find: () => ({
          sort: () => ({ lean: () => Promise.reject(new Error('db down')) }),
        }),
      };
      const r = new BaseRepository(throwingModel);
      await expect(r.findByUser('u1')).rejects.toThrow('db down');
    });

    it('create re-lanza el error del Model en vez de devolver null', async () => {
      const throwingModel = {
        modelName: 'FakeModel',
        create: () => Promise.reject(new Error('write failed')),
      };
      const r = new BaseRepository(throwingModel);
      await expect(r.create('u1', {})).rejects.toThrow('write failed');
    });

    it('findByUser sigue devolviendo [] cuando _isDbReady() es false (degradación intencional, no un error)', async () => {
      const throwingModel = {
        modelName: 'FakeModel',
        find: () => { throw new Error('should never be called'); },
      };
      const r = new BaseRepository(throwingModel);
      vi.spyOn(BaseRepository.prototype, '_isDbReady').mockReturnValueOnce(false);
      expect(await r.findByUser('u1')).toEqual([]);
    });
  });
});

describe('AlertRepository (real)', () => {
  let store;
  let repo;
  let readySpy;

  beforeEach(() => {
    store = [{ _id: 'a1', userId: 'u1', type: 'price', threshold: 70000 }];
    repo = new AlertRepository(makeFakeModel(store));
    readySpy = vi.spyOn(BaseRepository.prototype, '_isDbReady').mockReturnValue(true);
  });

  afterEach(() => readySpy.mockRestore());

  it('listForUser delega en findByUser', async () => {
    expect(await repo.listForUser('u1')).toHaveLength(1);
  });

  it('addAlert delega en create y estampa userId', async () => {
    const created = await repo.addAlert('u1', { type: 'volume', threshold: 1000 });
    expect(created.userId).toBe('u1');
    expect(await repo.listForUser('u1')).toHaveLength(2);
  });

  it('deleteAlert respeta el guard de userId', async () => {
    const result = await repo.deleteAlert('u2', 'a1');
    expect(result).toBeNull();
  });

  it('updateAlert actualiza el threshold', async () => {
    const updated = await repo.updateAlert('u1', 'a1', { threshold: 75000 });
    expect(updated.threshold).toBe(75000);
  });
});

describe('WatchlistRepository (real)', () => {
  let store;
  let repo;
  let readySpy;

  beforeEach(() => {
    store = [];
    repo = new WatchlistRepository(makeFakeModel(store));
    readySpy = vi.spyOn(BaseRepository.prototype, '_isDbReady').mockReturnValue(true);
  });

  afterEach(() => readySpy.mockRestore());

  it('getWatchlist devuelve { coins: [] } si no existe documento', async () => {
    const wl = await repo.getWatchlist('u1');
    expect(wl).toEqual({ coins: [] });
  });

  it('getWatchlist devuelve el documento existente', async () => {
    store.push({ _id: 'w1', userId: 'u1', coins: ['BTC', 'ETH'] });
    const wl = await repo.getWatchlist('u1');
    expect(wl.coins).toEqual(['BTC', 'ETH']);
  });

  it('upsertCoins crea el documento si no existe (upsert)', async () => {
    const result = await repo.upsertCoins('u1', ['BTC']);
    expect(result.coins).toEqual(['BTC']);
    expect(store).toHaveLength(1);
  });

  it('upsertCoins actualiza el documento existente', async () => {
    store.push({ _id: 'w1', userId: 'u1', coins: ['BTC'] });
    const result = await repo.upsertCoins('u1', ['BTC', 'ETH', 'SOL']);
    expect(result.coins).toEqual(['BTC', 'ETH', 'SOL']);
    expect(store).toHaveLength(1);
  });

  it('upsertCoins devuelve { coins } sin tocar el store si la DB no está lista', async () => {
    readySpy.mockReturnValue(false);
    const result = await repo.upsertCoins('u1', ['BTC']);
    expect(result).toEqual({ coins: ['BTC'] });
    expect(store).toHaveLength(0);
  });
});

describe('PortfolioRepository (real)', () => {
  let store;
  let repo;
  let readySpy;

  beforeEach(() => {
    store = Array.from({ length: 25 }, (_, i) => ({
      _id: `p${i}`,
      userId: i < 20 ? 'u1' : 'u2',
      asset: 'BTC',
      qty: i,
    }));
    repo = new PortfolioRepository(makeFakeModel(store));
    readySpy = vi.spyOn(BaseRepository.prototype, '_isDbReady').mockReturnValue(true);
  });

  afterEach(() => readySpy.mockRestore());

  it('listForUser pagina con offset/limit por defecto (20)', async () => {
    const { items, total } = await repo.listForUser('u1');
    expect(total).toBe(20);
    expect(items).toHaveLength(20);
  });

  it('listForUser respeta offset y limit personalizados', async () => {
    const { items, total } = await repo.listForUser('u1', { offset: 5, limit: 3 });
    expect(total).toBe(20);
    expect(items).toHaveLength(3);
  });

  it('listForUser devuelve total=0 e items=[] si la DB no está lista', async () => {
    readySpy.mockReturnValue(false);
    const { items, total } = await repo.listForUser('u1');
    expect(items).toEqual([]);
    expect(total).toBe(0);
  });

  it('addEntry crea una entrada con userId', async () => {
    const entry = await repo.addEntry('u3', { asset: 'ETH', qty: 1 });
    expect(entry.userId).toBe('u3');
  });

  it('deleteEntry respeta el guard de userId', async () => {
    const result = await repo.deleteEntry('u2', 'p0'); // p0 pertenece a u1
    expect(result).toBeNull();
  });

  it('deleteEntry elimina la entrada correcta', async () => {
    const result = await repo.deleteEntry('u1', 'p0');
    expect(result.asset).toBe('BTC');
  });

  describe('addEntryIdempotent (Nivel 3 #3 — replay logic moved from portfolio.routes.js)', () => {
    /**
     * makeFakeModel's generic `matches()` does plain string equality, which
     * can't express `createdAt: { $gte: since }` — so this group uses a
     * small purpose-built fake Model that understands that one operator,
     * matching the exact query shape PortfolioRepository.addEntryIdempotent
     * issues.
     */
    function makeIdempotentFakeModel(idemStore) {
      return {
        findOne(query) {
          return {
            lean: async () => idemStore.find(d =>
              d.userId === query.userId &&
              d._idempotencyKey === query._idempotencyKey &&
              d.createdAt >= query.createdAt.$gte
            ) || null,
          };
        },
        async create(doc) {
          const created = { _id: `idem-${idemStore.length + 1}`, createdAt: new Date(), ...doc };
          idemStore.push(created);
          return created;
        },
      };
    }

    let idemStore;
    let idemRepo;

    beforeEach(() => {
      idemStore = [];
      idemRepo = new PortfolioRepository(makeIdempotentFakeModel(idemStore));
    });

    it('crea una nueva posición la primera vez que se ve una idempotency key', async () => {
      const entry = await idemRepo.addEntryIdempotent('u1', { asset: 'BTC', qty: 1 }, 'key-abc');
      expect(entry.userId).toBe('u1');
      expect(entry._idempotencyKey).toBe('key-abc');
      expect(idemStore).toHaveLength(1);
    });

    it('repite (no duplica) el resultado original para la misma key dentro de la ventana', async () => {
      const first = await idemRepo.addEntryIdempotent('u1', { asset: 'BTC', qty: 1 }, 'key-abc');
      const second = await idemRepo.addEntryIdempotent('u1', { asset: 'BTC', qty: 1 }, 'key-abc');
      expect(second).toEqual(first);
      expect(idemStore).toHaveLength(1); // no se creó una segunda entrada
    });

    it('crea una entrada nueva si la key ya expiró (fuera de la ventana de 60s)', async () => {
      await idemRepo.addEntryIdempotent('u1', { asset: 'BTC', qty: 1 }, 'key-abc');
      idemStore[0].createdAt = new Date(Date.now() - 120_000); // 2 min atrás
      const second = await idemRepo.addEntryIdempotent('u1', { asset: 'BTC', qty: 2 }, 'key-abc');
      expect(idemStore).toHaveLength(2);
      expect(second.qty).toBe(2);
    });

    it('devuelve null sin tocar el store si la DB no está lista', async () => {
      readySpy.mockReturnValueOnce(false);
      const result = await idemRepo.addEntryIdempotent('u1', { asset: 'BTC', qty: 1 }, 'key-xyz');
      expect(result).toBeNull();
      expect(idemStore).toHaveLength(0);
    });
  });
});

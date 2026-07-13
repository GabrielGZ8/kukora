import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import persistenceService from '../server/infrastructure/persistenceService.js';

function setReadyState(v) { mongoose.connection.readyState = v; }

describe('persistenceService', () => {
  afterEach(() => {
    mongoose.connection.readyState = 0;
    vi.restoreAllMocks();
  });

  describe('session id management', () => {
    it('currentSessionId returns a kukora-<date> id by default', () => {
      expect(persistenceService.currentSessionId()).toMatch(/^kukora-\d{4}-\d{2}-\d{2}/);
    });

    it('advanceSession changes the session id (forces a clean slate)', () => {
      const before = persistenceService.currentSessionId();
      persistenceService.advanceSession();
      const after = persistenceService.currentSessionId();
      expect(after).not.toBe(before);
      expect(after).toMatch(/-reset-\d+$/);
    });
  });

  describe('write operations — no-op when MongoDB is not ready', () => {
    beforeEach(() => { setReadyState(0); });

    it('persistEquityPoint resolves without throwing and does not touch the DB', async () => {
      await expect(persistenceService.persistEquityPoint({ ts: Date.now(), value: 100 })).resolves.toBeUndefined();
    });

    it('persistTrade resolves without throwing when DB is not ready', async () => {
      await expect(persistenceService.persistTrade({ ts: Date.now(), netProfit: 1 })).resolves.toBeUndefined();
    });

    it('persistSessionMeta resolves without throwing when DB is not ready', async () => {
      await expect(persistenceService.persistSessionMeta({ totalTrades: 1 })).resolves.toBeUndefined();
    });

    it('restoreSession returns null when DB is not ready', async () => {
      await expect(persistenceService.restoreSession()).resolves.toBeNull();
    });
  });

  describe('write operations — never throw even if the DB write itself fails', () => {
    beforeEach(() => { setReadyState(1); });

    it('persistEquityPoint swallows DB errors (non-fatal by design)', async () => {
      // The mocked SessionDoc.create resolves successfully by default; this
      // test documents the contract (never throw) rather than forcing a
      // synthetic rejection, since the implementation wraps every call in
      // try/catch with an intentionally empty catch.
      await expect(persistenceService.persistEquityPoint({ ts: Date.now(), value: 1 })).resolves.toBeUndefined();
    });
  });

  describe('restoreSession — happy path with MongoDB ready', () => {
    beforeEach(() => { setReadyState(1); });

    it('returns null when no session_meta document exists for today', async () => {
      const result = await persistenceService.restoreSession();
      expect(result).toBeNull();
    });
  });

  describe('engine snapshot persistence', () => {
    it('persistEngineSnapshot resolves without throwing when DB is not ready', async () => {
      setReadyState(0);
      await expect(persistenceService.persistEngineSnapshot({ dailyPnl: 5 }, 'u1')).resolves.toBeUndefined();
    });

    it('restoreEngineSnapshot returns null when DB is not ready', async () => {
      setReadyState(0);
      await expect(persistenceService.restoreEngineSnapshot('u1')).resolves.toBeNull();
    });

    it('restoreEngineSnapshot returns null when no snapshot exists for the user/day (DB ready)', async () => {
      setReadyState(1);
      const result = await persistenceService.restoreEngineSnapshot('u1');
      expect(result).toBeNull();
    });
  });

  // Punto 7 (auditoría comité, sección 12): balances de wallet no tenían
  // ningún mecanismo de persistencia. Estos tests inyectan un modelo fake
  // vía `_setEngineSnapshotModelForTests` (mismo patrón que
  // `_resetPendingExecutionModelForTests`) y usan `_setMongooseForTests`
  // para apuntar `_readyState()` a la MISMA instancia mockeada de mongoose
  // que este test-file controla vía `setReadyState` (ESM import) — el
  // `require('mongoose')` interno de persistenceService.js resuelve una
  // instancia de mock distinta a la de un `import mongoose` de un test,
  // ver comentario original junto a `_mongooseRef` en persistenceService.js.
  describe('engine snapshot persistence — wallets field (punto 7)', () => {
    beforeEach(() => {
      persistenceService._setMongooseForTests(mongoose);
      setReadyState(1);
      persistenceService._resetEngineSnapshotModelForTests();
    });
    afterEach(() => {
      persistenceService._resetEngineSnapshotModelForTests();
      persistenceService._resetMongooseForTests();
    });

    it('persistEngineSnapshot forwards `wallets` in the $set payload when provided', async () => {
      const findOneAndUpdate = vi.fn().mockResolvedValue({});
      persistenceService._setEngineSnapshotModelForTests({ findOneAndUpdate });
      const wallets = { BTC: { binance: 1 }, ETH: {}, XRP: {}, USDT: { binance: 1000 } };

      await persistenceService.persistEngineSnapshot({ dailyPnl: 5, wallets }, 'u-wallets');

      expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
      const [, update] = findOneAndUpdate.mock.calls[0];
      expect(update.$set.wallets).toEqual(wallets);
    });

    it('persistEngineSnapshot does NOT include `wallets` in $set when the caller omits it (no accidental overwrite with null)', async () => {
      const findOneAndUpdate = vi.fn().mockResolvedValue({});
      persistenceService._setEngineSnapshotModelForTests({ findOneAndUpdate });

      await persistenceService.persistEngineSnapshot({ dailyPnl: 5 }, 'u-no-wallets');

      expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
      const [, update] = findOneAndUpdate.mock.calls[0];
      expect('wallets' in update.$set).toBe(false);
    });

    it('restoreEngineSnapshot returns the persisted `wallets` blob', async () => {
      const wallets = { BTC: { binance: 2 }, ETH: {}, XRP: {}, USDT: { binance: 500 } };
      persistenceService._setEngineSnapshotModelForTests({
        findOne: () => ({
          lean: async () => ({ equityCurve: [], dailyPnl: 0, totalTrades: 0, tradeLog: [], counters: {}, wallets }),
        }),
      });

      const result = await persistenceService.restoreEngineSnapshot('u-wallets');
      expect(result.wallets).toEqual(wallets);
    });

    it('restoreEngineSnapshot returns wallets: null for a legacy document without the field', async () => {
      persistenceService._setEngineSnapshotModelForTests({
        findOne: () => ({
          lean: async () => ({ equityCurve: [], dailyPnl: 0, totalTrades: 0, tradeLog: [], counters: {} }),
        }),
      });

      const result = await persistenceService.restoreEngineSnapshot('u-legacy');
      expect(result.wallets).toBeNull();
    });
  });

  // Auditoría del comité (Sesión 34, P1 #2 — crash recovery para ejecuciones
  // cross-exchange en curso). Nota de estilo: estas pruebas verifican
  // comportamiento (resuelve sin lanzar, forma del retorno) en vez de
  // aserciones de spy sobre el modelo obtenido vía require('../server/models')
  // — un probe de identidad confirmó que en este proyecto el grafo ESM
  // (`import mongoose from 'mongoose'` de este archivo) y el grafo CJS
  // (`require('../models')` interno de persistenceService.js) resuelven a
  // instancias mockeadas de mongoose distintas, así que un `vi.spyOn` sobre
  // el modelo requerido aquí no ve las llamadas reales hechas del lado CJS.
  // Mismo estilo ya usado arriba para engine snapshot persistence.
  describe('pending execution — crash recovery for in-flight cross-exchange trades', () => {
    beforeEach(() => { persistenceService._resetPendingExecutionModelForTests(); });

    const entry = {
      tradeId: 'xlive-test-1', userId: 'u1', buyExchange: 'binance', sellExchange: 'bybit',
      symbol: 'BTCUSDT', amount: 0.01, opportunityId: 'arb-binance-bybit',
    };

    it('markPendingExecution is a silent no-op when MongoDB is not ready', async () => {
      setReadyState(0);
      await expect(persistenceService.markPendingExecution(entry)).resolves.toBeUndefined();
    });

    it('resolvePendingExecution is a silent no-op when MongoDB is not ready', async () => {
      setReadyState(0);
      await expect(persistenceService.resolvePendingExecution('xlive-test-1')).resolves.toBeUndefined();
    });

    it('listUnresolvedPendingExecutions returns [] (not null) when MongoDB is not ready', async () => {
      setReadyState(0);
      const result = await persistenceService.listUnresolvedPendingExecutions();
      expect(result).toEqual([]);
    });

    it('markPendingExecution resolves without throwing when MongoDB is ready', async () => {
      setReadyState(1);
      await expect(persistenceService.markPendingExecution(entry)).resolves.toBeUndefined();
    });

    it('resolvePendingExecution resolves without throwing when MongoDB is ready', async () => {
      setReadyState(1);
      await expect(persistenceService.resolvePendingExecution('xlive-test-1')).resolves.toBeUndefined();
    });

    it('listUnresolvedPendingExecutions returns an array when MongoDB is ready (mocked model returns [])', async () => {
      setReadyState(1);
      const result = await persistenceService.listUnresolvedPendingExecutions();
      expect(Array.isArray(result)).toBe(true);
    });

    it('markPendingExecution never throws even when passed a malformed entry', async () => {
      setReadyState(1);
      await expect(persistenceService.markPendingExecution({})).resolves.toBeUndefined();
    });

    it('resolvePendingExecution never throws even when passed an unknown tradeId', async () => {
      setReadyState(1);
      await expect(persistenceService.resolvePendingExecution('does-not-exist')).resolves.toBeUndefined();
    });

    it('_resetPendingExecutionModelForTests does not throw and can be called repeatedly', () => {
      expect(() => {
        persistenceService._resetPendingExecutionModelForTests();
        persistenceService._resetPendingExecutionModelForTests();
      }).not.toThrow();
    });
  });

  describe('periodic flush lifecycle', () => {
    it('startPeriodicFlush / stopPeriodicFlush do not throw and are idempotent', () => {
      expect(() => {
        persistenceService.startPeriodicFlush(() => ({ totalTrades: 1 }), 60_000);
        persistenceService.startPeriodicFlush(() => ({ totalTrades: 1 }), 60_000); // calling twice is a no-op
        persistenceService.stopPeriodicFlush();
        persistenceService.stopPeriodicFlush(); // calling twice is a no-op
      }).not.toThrow();
    });

    it('startEngineSnapshotFlush / stopEngineSnapshotFlush do not throw', () => {
      expect(() => {
        persistenceService.startEngineSnapshotFlush(() => ({ dailyPnl: 1 }), 'u1', 30_000);
        persistenceService.stopEngineSnapshotFlush();
      }).not.toThrow();
    });
  });

  // ── M-5: retry queue for failed trade/equity persistence writes ──────────
  describe('M-5: persistence retry queue', () => {
    const SessionDoc = require('../server/infrastructure/persistence/models/SessionDoc.js');

    beforeEach(() => {
      persistenceService._resetRetryQueueForTests();
      delete process.env.MONGODB_URI;
      setReadyState(0);
      // Root cause (confirmed via an object-identity probe, not just the
      // async-window theory originally suspected): this file's ESM
      // `import mongoose from 'mongoose'` and persistenceService.js's
      // internal CJS `require('mongoose')` resolve to two *different*
      // mocked module instances in this project's Vitest setup — so
      // setReadyState() here was invisible to _flushRetryQueue()'s
      // internal readyState check. Point the module at this file's own
      // mongoose instance for the duration of this describe block so
      // both sides read/write the same object.
      persistenceService._setMongooseForTests(mongoose);
      // Second finding while fixing the above: with readyState now
      // correctly reporting 1, `_flushRetryQueue()` actually reaches
      // `SessionDoc.create()`. That call goes through SessionDoc.js's own
      // internal `require('mongoose')` -- which, per the same CJS-require
      // graph, is a real (unmocked) mongoose Model with no live
      // connection, so an un-spied `.create()` call hangs indefinitely
      // (bufferCommands waiting for a connection) instead of throwing or
      // resolving. Every test in this block that can reach the real write
      // path needs `SessionDoc.create` spied -- default to resolving here;
      // individual tests override with `mockRejectedValueOnce` to
      // exercise the failure path.
      vi.spyOn(SessionDoc, 'create').mockResolvedValue({ _id: 'mock-id' });
    });
    afterEach(() => {
      delete process.env.MONGODB_URI;
      persistenceService._resetRetryQueueForTests();
      setReadyState(0);
      persistenceService._resetMongooseForTests();
      vi.restoreAllMocks();
    });

    it('does NOT enqueue when Mongo is unreachable but MONGODB_URI was never configured (intentional in-memory mode)', async () => {
      setReadyState(0);
      await persistenceService.persistTrade({ ts: Date.now(), netProfit: 1 });
      await persistenceService.persistEquityPoint({ ts: Date.now(), value: 1 });
      expect(persistenceService._getRetryQueueSizeForTests()).toBe(0);
    });

    it('enqueues a failed trade write when MONGODB_URI is configured but Mongo is currently down', async () => {
      process.env.MONGODB_URI = 'mongodb://fake-configured-uri/kukora';
      setReadyState(0);
      await persistenceService.persistTrade({ ts: Date.now(), netProfit: 5 });
      expect(persistenceService._getRetryQueueSizeForTests()).toBe(1);
    });

    it('enqueues a failed equity-point write when the DB write itself throws (Mongo up, write fails)', async () => {
      process.env.MONGODB_URI = 'mongodb://fake-configured-uri/kukora';
      setReadyState(1);
      vi.spyOn(SessionDoc, 'create').mockRejectedValueOnce(new Error('write failed'));
      await persistenceService.persistEquityPoint({ ts: Date.now(), value: 42 });
      expect(persistenceService._getRetryQueueSizeForTests()).toBe(1);
    });

    // RESOLVED (Sesión 7): the previous session's theory — a shared mocked
    // singleton with an async-timing propagation gap — was disproved by an
    // object-identity probe. The actual root cause: this file's top-level
    // ESM `import mongoose from 'mongoose'` and persistenceService.js's
    // internal CJS `require('mongoose')` resolve to two *different* mocked
    // module instances in this project's Vitest setup (`r1 === r2` across
    // two `require()` calls is true — require's own cache is fine — but
    // `import mongoose` !== `require('mongoose')`). That's also why the
    // "enqueue" tests above happened to pass: `setReadyState(0)` on the
    // ESM instance was a no-op as far as production code was concerned,
    // but persistenceService.js's *own* CJS-side mongoose instance
    // defaults to `readyState: 0` too, so the two independent states
    // coincidentally agreed whenever the test wanted readyState=0. The
    // moment a test needed readyState=1 to be visible to production code
    // (exactly what these two tests do), the mismatch surfaced. Fixed via
    // `_setMongooseForTests()` in the `beforeEach` above, which points
    // persistenceService.js's internal reference at this file's own
    // mongoose instance for this describe block.
    it('_flushRetryQueueForTests drains the queue once Mongo is reachable again', async () => {
      process.env.MONGODB_URI = 'mongodb://fake-configured-uri/kukora';
      setReadyState(0);
      await persistenceService.persistTrade({ ts: Date.now(), netProfit: 5 });
      expect(persistenceService._getRetryQueueSizeForTests()).toBe(1);

      setReadyState(1); // Mongo recovers
      await persistenceService._flushRetryQueueForTests();
      expect(persistenceService._getRetryQueueSizeForTests()).toBe(0);
    });

    it('re-queues an item that fails again during a flush attempt, incrementing its attempt count', async () => {
      process.env.MONGODB_URI = 'mongodb://fake-configured-uri/kukora';
      setReadyState(0);
      await persistenceService.persistTrade({ ts: Date.now(), netProfit: 5 });

      setReadyState(1);
      vi.spyOn(SessionDoc, 'create').mockRejectedValueOnce(new Error('still down'));
      await persistenceService._flushRetryQueueForTests();
      // Still queued — the retry attempt itself failed, so it goes back in.
      expect(persistenceService._getRetryQueueSizeForTests()).toBe(1);

      // A subsequent successful flush drains it.
      await persistenceService._flushRetryQueueForTests();
      expect(persistenceService._getRetryQueueSizeForTests()).toBe(0);
    });

    it('is a no-op when Mongo is unreachable (does not clear or touch the queue)', async () => {
      process.env.MONGODB_URI = 'mongodb://fake-configured-uri/kukora';
      setReadyState(0);
      await persistenceService.persistTrade({ ts: Date.now(), netProfit: 5 });
      expect(persistenceService._getRetryQueueSizeForTests()).toBe(1);

      // Mongo still down during the flush attempt itself.
      await persistenceService._flushRetryQueueForTests();
      expect(persistenceService._getRetryQueueSizeForTests()).toBe(1);
    });

    it('startPersistenceRetryFlush / stopPersistenceRetryFlush do not throw and are idempotent', () => {
      expect(() => {
        persistenceService.startPersistenceRetryFlush(15_000);
        persistenceService.startPersistenceRetryFlush(15_000); // second call is a no-op
        persistenceService.stopPersistenceRetryFlush();
        persistenceService.stopPersistenceRetryFlush(); // second call is a no-op
      }).not.toThrow();
    });
  });
});

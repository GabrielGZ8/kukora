'use strict';

/**
 * user-data.routes.test.js
 *
 * Tests para las 4 rutas de datos de usuario:
 *   alerts.routes.js, watchlist.routes.js, portfolio.routes.js, dataset.routes.js
 *
 * Objetivo principal (auditoría Nivel 1 #2 — Row-level authorization):
 * Verificar que todas las operaciones CRUD filtran por req.userId, de modo
 * que ningún usuario pueda leer ni modificar datos de otro.
 *
 * Estructura: se prueban los handlers directamente desde el router stack
 * (patrón establecido en crypto.routes.test.js), con el req.userId ya
 * inyectado (la capa requireAuth no forma parte de estos tests unitarios
 * — su lógica JWT se prueba en auth.routes.test.js).
 *
 * Se ejercita la rama isDbReady=false (fallback _noDb:true) por defecto
 * (que es lo que mongoose mock devuelve: readyState=0), y también la rama
 * isDbReady=true (queries reales contra el mongoose mock) para verificar
 * que userId se usa correctamente como filtro.
 *
 * Nivel 3 #3 (audit): las rutas ahora delegan en server/repositories/, cuyos
 * métodos usan .lean() en las queries de Mongoose — los mocks de este
 * archivo reflejan esa cadena (find().sort().lean(), findOne().lean(), etc).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Importar módulos (CJS singletons) ──────────────────────────────────────
const alertsRouter    = require('../server/routes/alerts.routes.js');
const watchlistRouter = require('../server/routes/watchlist.routes.js');
const portfolioRouter = require('../server/routes/portfolio.routes.js');
const datasetRouter   = require('../server/routes/dataset.routes.js');
const mongoose        = require('mongoose');

// ── Utilidades ────────────────────────────────────────────────────────────

/** Obtiene el handler final (post-middleware) de una ruta del router stack. */
function getHandler(router, path, method = 'get') {
  const layer = router.stack.find(
    l => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No route ${method.toUpperCase()} ${path}`);
  // El último handler en route.stack es el controlador real (los previos son middleware)
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

/** Mock de Express res con el mínimo para estos tests. */
function mockRes() {
  const res = {
    _statusCode: 200,
    _body: null,
    status(code) { this._statusCode = code; return this; },
    json(body)   { this._body = body;       return this; },
    setHeader() { return this; },
    send(data)   { this._body = data;       return this; },
  };
  return res;
}

/** Mock de Express req con userId ya resuelto (como lo dejaría requireAuth). */
function mockReq(extra = {}) {
  return { params: {}, query: {}, body: {}, headers: {}, userId: 'user-123', ...extra };
}

// ── Tests: alerts ──────────────────────────────────────────────────────────
describe('alerts.routes', () => {
  const { Alert } = require('../server/models');

  beforeEach(() => vi.clearAllMocks());

  describe('GET / — isDbReady:false', () => {
    it('devuelve { ok: true, data: [], _noDb: true } cuando DB no está lista', async () => {
      const handler = getHandler(alertsRouter, '/');
      const res = mockRes();
      await handler(mockReq(), res);
      expect(res._body).toMatchObject({ ok: true, data: [], _noDb: true });
    });
  });

  describe('GET / — isDbReady:true (row-level auth)', () => {
    let origReadyState;
    beforeEach(() => { origReadyState = mongoose.connection.readyState; mongoose.connection.readyState = 1; });
    afterEach(() => { mongoose.connection.readyState = origReadyState; });

    it('llama Alert.find con userId del request', async () => {
      const handler = getHandler(alertsRouter, '/');
      const findSpy = vi.spyOn(Alert, 'find').mockReturnValue({
        sort: () => ({ lean: () => Promise.resolve([]) }),
      });
      await handler(mockReq({ userId: 'user-abc' }), mockRes());
      expect(findSpy).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-abc' }));
    });

    it('NO devuelve datos de otro usuario (userId diferente no está en el filtro)', async () => {
      const handler = getHandler(alertsRouter, '/');
      vi.spyOn(Alert, 'find').mockImplementation((filter) => ({
        sort: () => ({ lean: () => Promise.resolve(filter.userId === 'user-abc' ? [{ id: 1 }] : []) }),
      }));
      const res1 = mockRes();
      const res2 = mockRes();
      await handler(mockReq({ userId: 'user-abc' }), res1);
      await handler(mockReq({ userId: 'user-xyz' }), res2);
      expect(res1._body.data).toHaveLength(1);
      expect(res2._body.data).toHaveLength(0);
    });
  });

  describe('POST / — validación', () => {
    it('devuelve 400 cuando el body no pasa la validación (sin campos requeridos)', async () => {
      // Obtener el handler de validación (penúltimo en la cadena, antes del wrapDb)
      const route = alertsRouter.stack.find(l => l.route?.path === '/' && l.route.methods.post);
      // El handler post tiene: requireAuth, validador+wrapDb inline
      const handler = route.route.stack[route.route.stack.length - 1].handle;
      const res = mockRes();
      await handler(mockReq({ body: {} }), res);
      expect(res._statusCode).toBe(400);
      expect(res._body.ok).toBe(false);
      expect(res._body.error).toBeTruthy();
    });
  });

  describe('DELETE /:id — row-level auth', () => {
    let origReadyState;
    beforeEach(() => { origReadyState = mongoose.connection.readyState; mongoose.connection.readyState = 1; });
    afterEach(() => { mongoose.connection.readyState = origReadyState; });

    it('llama findOneAndDelete con _id Y userId del request', async () => {
      const handler = getHandler(alertsRouter, '/:id', 'delete');
      const deleteSpy = vi.spyOn(Alert, 'findOneAndDelete').mockResolvedValue(null);
      await handler(mockReq({ params: { id: '507f1f77bcf86cd799439011' }, userId: 'user-abc' }), mockRes());
      expect(deleteSpy).toHaveBeenCalledWith(expect.objectContaining({
        _id: '507f1f77bcf86cd799439011',
        userId: 'user-abc',
      }));
    });

    it('devuelve null (sin error) para id con formato ObjectId inválido', async () => {
      const handler = getHandler(alertsRouter, '/:id', 'delete');
      const res = mockRes();
      await handler(mockReq({ params: { id: 'not-valid-id' } }), res);
      expect(res._body).toMatchObject({ ok: true, data: null });
    });
  });

  describe('PATCH /:id — row-level auth', () => {
    it('devuelve 400 para id inválido', async () => {
      const route = alertsRouter.stack.find(l => l.route?.path === '/:id' && l.route.methods.patch);
      const handler = route.route.stack[route.route.stack.length - 1].handle;
      const res = mockRes();
      await handler(mockReq({ params: { id: 'bad' } }), res);
      expect(res._statusCode).toBe(400);
      expect(res._body.error).toBe('Invalid id');
    });
  });
});

// ── Tests: watchlist ──────────────────────────────────────────────────────
describe('watchlist.routes', () => {
  const { Watchlist } = require('../server/models');

  beforeEach(() => vi.clearAllMocks());

  describe('GET / — isDbReady:false', () => {
    it('devuelve fallback { coins: [] } sin tocar DB', async () => {
      const handler = getHandler(watchlistRouter, '/');
      const res = mockRes();
      await handler(mockReq(), res);
      expect(res._body).toMatchObject({ ok: true, data: { coins: [] }, _noDb: true });
    });
  });

  describe('GET / — isDbReady:true (row-level auth)', () => {
    let origReadyState;
    beforeEach(() => { origReadyState = mongoose.connection.readyState; mongoose.connection.readyState = 1; });
    afterEach(() => { mongoose.connection.readyState = origReadyState; });

    it('filtra Watchlist.findOne con el userId del request', async () => {
      const handler = getHandler(watchlistRouter, '/');
      const findOneSpy = vi.spyOn(Watchlist, 'findOne').mockReturnValue({
        lean: () => Promise.resolve({ coins: ['BTC'] }),
      });
      await handler(mockReq({ userId: 'user-qrs' }), mockRes());
      expect(findOneSpy).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-qrs' }));
    });

    it('devuelve { coins: [] } si el usuario no tiene watchlist', async () => {
      const handler = getHandler(watchlistRouter, '/');
      vi.spyOn(Watchlist, 'findOne').mockReturnValue({ lean: () => Promise.resolve(null) });
      const res = mockRes();
      await handler(mockReq(), res);
      expect(res._body).toMatchObject({ ok: true, data: { coins: [] } });
    });
  });

  describe('POST / — validación + row-level auth', () => {
    it('devuelve 400 cuando falta el campo coins', async () => {
      const route = watchlistRouter.stack.find(l => l.route?.path === '/' && l.route.methods.post);
      const handler = route.route.stack[route.route.stack.length - 1].handle;
      const res = mockRes();
      await handler(mockReq({ body: {} }), res);
      expect(res._statusCode).toBe(400);
    });

    it('isDbReady:false — devuelve coins del body como fallback', async () => {
      const route = watchlistRouter.stack.find(l => l.route?.path === '/' && l.route.methods.post);
      const handler = route.route.stack[route.route.stack.length - 1].handle;
      const res = mockRes();
      await handler(mockReq({ body: { coins: ['BTC', 'ETH'] } }), res);
      expect(res._body).toMatchObject({ ok: true, data: { coins: ['BTC', 'ETH'] }, _noDb: true });
    });
  });
});

// ── Tests: portfolio ──────────────────────────────────────────────────────
describe('portfolio.routes', () => {
  const { Portfolio } = require('../server/models');

  beforeEach(() => vi.clearAllMocks());

  describe('GET / — isDbReady:false', () => {
    it('devuelve paginación vacía como fallback', async () => {
      const route = portfolioRouter.stack.find(l => l.route?.path === '/' && l.route.methods.get);
      const handler = route.route.stack[route.route.stack.length - 1].handle;
      const res = mockRes();
      await handler(mockReq({ query: {} }), res);
      expect(res._body).toMatchObject({ ok: true, data: { items: [], total: 0 }, _noDb: true });
    });
  });

  describe('GET / — isDbReady:true (row-level auth)', () => {
    let origReadyState;
    beforeEach(() => { origReadyState = mongoose.connection.readyState; mongoose.connection.readyState = 1; });
    afterEach(() => { mongoose.connection.readyState = origReadyState; });

    it('Portfolio.find filtra por userId del request', async () => {
      const route = portfolioRouter.stack.find(l => l.route?.path === '/' && l.route.methods.get);
      const handler = route.route.stack[route.route.stack.length - 1].handle;
      const findSpy = vi.spyOn(Portfolio, 'find').mockReturnValue({
        sort: () => ({
          skip: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }),
        }),
      });
      vi.spyOn(Portfolio, 'countDocuments').mockResolvedValue(0);
      await handler(mockReq({ query: {}, userId: 'user-pqr' }), mockRes());
      expect(findSpy).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-pqr' }));
    });
  });

  describe('POST / — validación + idempotency', () => {
    it('devuelve 400 cuando el body no pasa validación', async () => {
      const route = portfolioRouter.stack.find(l => l.route?.path === '/' && l.route.methods.post);
      const handler = route.route.stack[route.route.stack.length - 1].handle;
      const res = mockRes();
      await handler(mockReq({ body: {} }), res);
      expect(res._statusCode).toBe(400);
    });

    it('con Idempotency-Key: reutiliza el resultado si ya existe uno reciente para esa key', async () => {
      const route = portfolioRouter.stack.find(l => l.route?.path === '/' && l.route.methods.post);
      const handler = route.route.stack[route.route.stack.length - 1].handle;

      const origReadyState = mongoose.connection.readyState;
      mongoose.connection.readyState = 1;

      const existingEntry = { _id: 'existing-1', asset: 'BTC', quantity: 1, entryPrice: 100, coinId: 'bitcoin', coinName: 'Bitcoin', symbol: 'BTC' };
      vi.spyOn(Portfolio, 'findOne').mockReturnValue({ lean: () => Promise.resolve(existingEntry) });
      const createSpy = vi.spyOn(Portfolio, 'create');

      const res = mockRes();
      await handler(mockReq({
        headers: { 'idempotency-key': 'dup-key-1' },
        body: { coinId: 'bitcoin', coinName: 'Bitcoin', symbol: 'BTC', quantity: 1, entryPrice: 100 },
      }), res);

      expect(res._body).toMatchObject({ ok: true, data: existingEntry });
      expect(createSpy).not.toHaveBeenCalled(); // replay, no duplicate insert

      mongoose.connection.readyState = origReadyState;
    });

    it('con Idempotency-Key: crea una nueva posición si no hay duplicado reciente', async () => {
      const route = portfolioRouter.stack.find(l => l.route?.path === '/' && l.route.methods.post);
      const handler = route.route.stack[route.route.stack.length - 1].handle;

      const origReadyState = mongoose.connection.readyState;
      mongoose.connection.readyState = 1;

      vi.spyOn(Portfolio, 'findOne').mockReturnValue({ lean: () => Promise.resolve(null) });
      const createSpy = vi.spyOn(Portfolio, 'create').mockResolvedValue({ _id: 'new-1' });

      const res = mockRes();
      await handler(mockReq({
        headers: { 'idempotency-key': 'fresh-key-1' },
        userId: 'user-idem',
        body: { coinId: 'bitcoin', coinName: 'Bitcoin', symbol: 'BTC', quantity: 1, entryPrice: 100 },
      }), res);

      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-idem',
        _idempotencyKey: 'fresh-key-1',
      }));
      expect(res._body).toMatchObject({ ok: true, data: { _id: 'new-1' } });

      mongoose.connection.readyState = origReadyState;
    });

    it('sin Idempotency-Key: crea una posición normal vía repositorio', async () => {
      const route = portfolioRouter.stack.find(l => l.route?.path === '/' && l.route.methods.post);
      const handler = route.route.stack[route.route.stack.length - 1].handle;

      const origReadyState = mongoose.connection.readyState;
      mongoose.connection.readyState = 1;

      const createSpy = vi.spyOn(Portfolio, 'create').mockResolvedValue({ _id: 'plain-1' });

      const res = mockRes();
      await handler(mockReq({
        headers: {},
        userId: 'user-plain',
        body: { coinId: 'ethereum', coinName: 'Ethereum', symbol: 'ETH', quantity: 2, entryPrice: 3000 },
      }), res);

      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-plain' }));
      expect(res._body).toMatchObject({ ok: true, data: { _id: 'plain-1' } });

      mongoose.connection.readyState = origReadyState;
    });
  });

  describe('DELETE /:id — row-level auth', () => {
    let origReadyState;
    beforeEach(() => { origReadyState = mongoose.connection.readyState; mongoose.connection.readyState = 1; });
    afterEach(() => { mongoose.connection.readyState = origReadyState; });

    it('llama findOneAndDelete con _id Y userId del request', async () => {
      const handler = getHandler(portfolioRouter, '/:id', 'delete');
      const deleteSpy = vi.spyOn(Portfolio, 'findOneAndDelete').mockResolvedValue(null);
      await handler(mockReq({ params: { id: '507f1f77bcf86cd799439011' }, userId: 'user-del' }), mockRes());
      expect(deleteSpy).toHaveBeenCalledWith(expect.objectContaining({
        _id: '507f1f77bcf86cd799439011',
        userId: 'user-del',
      }));
    });

    it('devuelve null (sin error) para ObjectId inválido', async () => {
      const handler = getHandler(portfolioRouter, '/:id', 'delete');
      const res = mockRes();
      await handler(mockReq({ params: { id: 'bad-id' } }), res);
      expect(res._body).toMatchObject({ ok: true, data: null });
    });
  });
});

// ── Tests: dataset ────────────────────────────────────────────────────────
describe('dataset.routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('POST /analyze', () => {
    it('devuelve 400 si no se proporciona csv ni json', async () => {
      const handler = getHandler(datasetRouter, '/analyze', 'post');
      const res = mockRes();
      await handler(mockReq({ body: {} }), res);
      expect(res._statusCode).toBe(400);
      expect(res._body.ok).toBe(false);
    });

    it('devuelve 400 si json no es array', async () => {
      const handler = getHandler(datasetRouter, '/analyze', 'post');
      const res = mockRes();
      await handler(mockReq({ body: { json: 'not-array' } }), res);
      expect(res._statusCode).toBe(400);
    });

    it('devuelve 400 si el dataset está vacío', async () => {
      const handler = getHandler(datasetRouter, '/analyze', 'post');
      const res = mockRes();
      await handler(mockReq({ body: { json: [] } }), res);
      expect(res._statusCode).toBe(400);
    });

    it('devuelve 413 si el dataset supera 10000 filas', async () => {
      const handler = getHandler(datasetRouter, '/analyze', 'post');
      const res = mockRes();
      const bigJson = Array.from({ length: 10001 }, (_, i) => ({ price: i, date: '2024-01-01' }));
      await handler(mockReq({ body: { json: bigJson } }), res);
      expect(res._statusCode).toBe(413);
    });

    it('devuelve ok:true con resultado para un JSON válido (mín. 35 filas)', async () => {
      const handler = getHandler(datasetRouter, '/analyze', 'post');
      const res = mockRes();
      const rows = Array.from({ length: 35 }, (_, i) => ({
        price: 100 + i * 0.5,
        date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().split('T')[0],
      }));
      await handler(mockReq({ body: { json: rows } }), res);
      expect(res._body.ok).toBe(true);
      expect(res._body.data).toBeDefined();
    });

    it('analiza un CSV básico correctamente (mín. 35 filas)', async () => {
      const handler = getHandler(datasetRouter, '/analyze', 'post');
      const res = mockRes();
      const rows = Array.from({ length: 35 }, (_, i) => ({
        price: 100 + i * 0.5,
        date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().split('T')[0],
      }));
      const csv = 'date,price\n' + rows.map(r => `${r.date},${r.price}`).join('\n');
      await handler(mockReq({ body: { csv } }), res);
      expect(res._body.ok).toBe(true);
    });
  });

  describe('GET /example', () => {
    it('devuelve un CSV sintético de 90 días', async () => {
      const handler = getHandler(datasetRouter, '/example', 'get');
      const res = mockRes();
      await handler(mockReq(), res);
      // res.send() con CSV
      expect(typeof res._body).toBe('string');
      expect(res._body).toContain('date,price,volume');
      const lines = res._body.trim().split('\n');
      expect(lines).toHaveLength(91); // header + 90 filas
    });

    it('el CSV no contiene datos de usuario (ruta pública)', async () => {
      // dataset.routes no usa requireAuth — correcto: solo datos sintéticos
      const route = datasetRouter.stack.find(l => l.route?.path === '/example' && l.route.methods.get);
      const middlewares = route.route.stack.map(l => l.handle.name);
      // No debe tener ningún middleware llamado 'requireAuth'
      expect(middlewares).not.toContain('requireAuth');
    });
  });
});

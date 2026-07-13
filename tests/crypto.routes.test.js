'use strict';

/**
 * crypto.routes.test.js — direct unit tests for server/crypto.routes.js
 *
 * Audit v2, section 3.2 / 9.1: this file had ZERO test coverage despite
 * having 11 handlers that all shared a temporal-dead-zone bug
 * (`const id = sanitizeCoinId(id)` referencing itself before
 * initialization), which threw a ReferenceError on every single request
 * to those endpoints. That bug has since been fixed in the source, but it
 * survived undetected specifically because nothing exercised this file.
 *
 * MOCKING NOTE: crypto.routes.js is plain CommonJS and requires
 * ./crypto.service via require(), not ESM import. vi.mock() factories only
 * intercept Vite's ESM module graph, so a vi.mock('../server/crypto.service.js')
 * factory does NOT intercept that internal require() call (verified — it still
 * hit the real CoinGecko API and got a 403 from this sandbox's network policy).
 * Instead we require() the same CJS singleton these tests' module pulls in,
 * and vi.spyOn() its methods directly — since both crypto.routes.js and this
 * test file share the exact same module.exports object instance, the spy is
 * visible to the route handlers without any network call ever happening.
 *
 * These tests:
 *   1. Regression-guard the TDZ bug directly (every :id route must read
 *      req.params.id, not shadow a local `id` before assignment).
 *   2. Cover the "invalid coin id" 400 path for every :id route (this also
 *      regression-guards a second bug found while writing these tests: the
 *      `handle()` wrapper used to ignore `err.status` and always return
 *      429/503, making the 400 branch dead code — fixed in this same pass).
 *   3. Cover one happy path per major route group, with no real network calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const cryptoService = require('../server/infrastructure/crypto.service.js');
const router = require('../server/routes/crypto.routes.js');

function getHandler(path, method = 'get') {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No route ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

function mockReq(extra = {}) {
  return { params: {}, query: {}, ...extra };
}

function priceHistory(points = 60) {
  return {
    prices: Array.from({ length: points }, (_, i) => [1700000000000 + i * 86400000, 100 + i]),
  };
}

// Every route that takes a :id param and must sanitize it. This list is
// the direct regression guard for the TDZ bug — if any of these throws
// "Cannot access 'id' before initialization", the test fails loudly
// instead of silently like it did in production before this audit.
const ID_ROUTES = [
  '/coin/:id',
  '/coin/:id/ohlc',
  '/coin/:id/history',
  '/coin/:id/technical',
  '/coin/:id/analytics',
  '/coin/:id/anomaly',
  '/coin/:id/risk',
  '/coin/:id/forecast',
  '/coin/:id/montecarlo',
  '/coin/:id/regime',
  '/coin/:id/backtest',
];

describe('crypto.routes — TDZ regression guard (audit 3.2)', () => {
  beforeEach(() => {
    vi.spyOn(cryptoService, 'getCoinDetail').mockResolvedValue({ id: 'bitcoin' });
    vi.spyOn(cryptoService, 'getOHLC').mockResolvedValue([]);
    vi.spyOn(cryptoService, 'getPriceHistory').mockResolvedValue(priceHistory());
    vi.spyOn(cryptoService, 'getGlobal').mockResolvedValue({ market_cap_percentage: { btc: 50 } });
  });

  it.each(ID_ROUTES)('%s does not throw ReferenceError on a valid id', async (path) => {
    const handler = getHandler(path, 'get');
    const req = mockReq({ params: { id: 'bitcoin' } });
    const res = mockRes();
    await handler(req, res);
    // The bug threw before res.json/res.status was ever called — as long
    // as we got a response at all (success or a *handled* business error
    // like "Datos insuficientes"), the TDZ regression has not returned.
    expect(res.body).not.toBeNull();
    expect(res.body.ok === true || typeof res.body.error === 'string').toBe(true);
  });

  it.each(ID_ROUTES)('%s returns 400 ok:false for a symbols-only id that sanitizes to empty', async (path) => {
    const handler = getHandler(path, 'get');
    const req = mockReq({ params: { id: '$$$///' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

describe('crypto.routes — sanitizeCoinId behavior', () => {
  beforeEach(() => {
    vi.spyOn(cryptoService, 'getCoinDetail').mockResolvedValue({ id: 'bitcoin' });
  });

  it('strips path traversal and special characters before hitting the service layer', async () => {
    const handler = getHandler('/coin/:id', 'get');
    const req = mockReq({ params: { id: 'Bitcoin../<script>' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.body.ok).toBe(true);
    const calledWith = cryptoService.getCoinDetail.mock.calls.at(-1)[0];
    expect(calledWith).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('crypto.routes — happy paths', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /markets returns market data', async () => {
    vi.spyOn(cryptoService, 'getMarkets').mockResolvedValue([{ id: 'bitcoin', current_price: 50000 }]);
    const handler = getHandler('/markets', 'get');
    const req = mockReq({ query: { limit: '10' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0].id).toBe('bitcoin');
  });

  it('GET /global returns global market stats', async () => {
    vi.spyOn(cryptoService, 'getGlobal').mockResolvedValue({ market_cap_percentage: { btc: 50 } });
    const handler = getHandler('/global', 'get');
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.market_cap_percentage.btc).toBe(50);
  });

  it('GET /coin/:id/technical computes indicators from price history', async () => {
    vi.spyOn(cryptoService, 'getPriceHistory').mockResolvedValue(priceHistory(60));
    const handler = getHandler('/coin/:id/technical', 'get');
    const req = mockReq({ params: { id: 'bitcoin' }, query: { days: '60' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.indicators).toHaveProperty('sma20');
    expect(res.body.data.indicators).toHaveProperty('rsi');
  });

  it('GET /coin/:id/technical returns a handled error for insufficient data', async () => {
    vi.spyOn(cryptoService, 'getPriceHistory').mockResolvedValue({ prices: [[1, 1], [2, 2]] }); // < 26 points
    const handler = getHandler('/coin/:id/technical', 'get');
    const req = mockReq({ params: { id: 'bitcoin' } });
    const res = mockRes();
    await handler(req, res);
    expect(res.body.ok).toBe(false);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

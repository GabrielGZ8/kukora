'use strict';

/**
 * cryptoRoutesCoverage.test.js — targeted branch coverage for
 * server/routes/crypto.routes.js (roadmap #9, KUKORA_AUDITORIA_COMITE.md
 * section 6/12: "crypto.routes.js tiene 66% statements / 55% branch — justo
 * uno de los archivos de rutas más grandes y con más lógica de validación").
 *
 * tests/crypto.routes.test.js already covers the TDZ regression guard and
 * one happy path per route group. This file goes after what that one
 * doesn't: the `handle()` error-branching (legacy `.status`, message-based
 * rate-limit detection, DomainError subclasses), the `cachedCall()` circuit
 * breaker (stale-serve while rate-limited, outage threshold trip), the
 * route-level `/anomalies` cache, and the per-id try/catch fallback loops
 * in /scores, /overview, /correlation, /regime and /kcs.
 *
 * MODULE ISOLATION NOTE: crypto.routes.js keeps circuit-breaker state
 * (`_rateLimitedUntil`, `_consecutiveFails`, `_cache`, `_anomaliesCache`) in
 * module-level closures. vi.resetModules() only clears Vite's ESM module
 * graph — it does NOT clear Node's CommonJS require.cache, and this file
 * (like crypto.routes.js itself) uses require(), not import. So each test
 * that depends on fresh circuit-breaker state manually deletes the relevant
 * require.cache entries and re-requires both the router and the service
 * singleton it wraps, in that order, so the router's internal require()
 * picks up the same fresh service mock instance this test file spies on.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const ROUTER_PATH = require.resolve('../server/routes/crypto.routes.js');
const SERVICE_PATH = require.resolve('../server/infrastructure/crypto.service.js');

function freshRouterAndService() {
  delete require.cache[ROUTER_PATH];
  delete require.cache[SERVICE_PATH];
  const cryptoService = require('../server/infrastructure/crypto.service.js');
  const router = require('../server/routes/crypto.routes.js');
  return { cryptoService, router };
}

function getHandler(router, path, method = 'get') {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No route ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function mockReq(extra = {}) {
  return { params: {}, query: {}, ...extra };
}

function priceHistory(points = 40, base = 100) {
  return {
    prices: Array.from({ length: points }, (_, i) => [1700000000000 + i * 86400000, base + i]),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('crypto.routes — handle() error branching (roadmap #9)', () => {
  it('respects a legacy ad-hoc { status } error instead of guessing 429/503', async () => {
    const { cryptoService, router } = freshRouterAndService();
    vi.spyOn(cryptoService, 'getCoinDetail').mockRejectedValue(
      Object.assign(new Error('teapot'), { status: 418 })
    );
    const handler = getHandler(router, '/coin/:id', 'get');
    const res = mockRes();
    await handler(mockReq({ params: { id: 'bitcoin' } }), res);
    expect(res.statusCode).toBe(418);
    expect(res.body).toEqual({ ok: false, error: 'teapot' });
  });

  it('detects a rate-limit condition from the error message when the error is not a RateLimitError instance', async () => {
    const { cryptoService, router } = freshRouterAndService();
    vi.spyOn(cryptoService, 'getCoinDetail').mockRejectedValue(new Error('upstream rate exceeded'));
    const handler = getHandler(router, '/coin/:id', 'get');
    const res = mockRes();
    await handler(mockReq({ params: { id: 'bitcoin' } }), res);
    expect(res.statusCode).toBe(429);
    expect(res.body.ok).toBe(false);
    expect(res.body.isRateLimit).toBe(true);
  });

  it('falls back to 503 for a generic, non-rate-limit, non-DomainError failure', async () => {
    const { cryptoService, router } = freshRouterAndService();
    vi.spyOn(cryptoService, 'getOHLC').mockRejectedValue(new Error('database timeout'));
    const handler = getHandler(router, '/coin/:id/ohlc', 'get');
    const res = mockRes();
    await handler(mockReq({ params: { id: 'bitcoin' } }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'database timeout', isRateLimit: false });
  });

  it('serializes a RateLimitError DomainError instance with isRateLimit flagged', async () => {
    const { cryptoService, router } = freshRouterAndService();
    const { RateLimitError } = require('../server/domain/errors.js');
    vi.spyOn(cryptoService, 'getCoinDetail').mockRejectedValue(new RateLimitError('CoinGecko rate limited'));
    const handler = getHandler(router, '/coin/:id', 'get');
    const res = mockRes();
    await handler(mockReq({ params: { id: 'bitcoin' } }), res);
    expect(res.statusCode).toBe(429);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.body.isRateLimit).toBe(true);
  });

  it('serializes an UpstreamServiceError DomainError instance without the isRateLimit flag', async () => {
    const { cryptoService, router } = freshRouterAndService();
    const { UpstreamServiceError } = require('../server/domain/errors.js');
    vi.spyOn(cryptoService, 'getCoinDetail').mockRejectedValue(new UpstreamServiceError('CoinGecko is down'));
    const handler = getHandler(router, '/coin/:id', 'get');
    const res = mockRes();
    await handler(mockReq({ params: { id: 'bitcoin' } }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'CoinGecko is down', code: 'UPSTREAM_UNAVAILABLE' });
  });
});

describe('crypto.routes — cachedCall circuit breaker (roadmap #9)', () => {
  it('serves a fresh cache hit without calling the underlying service again', async () => {
    const { cryptoService, router } = freshRouterAndService();
    const spy = vi.spyOn(cryptoService, 'getMarkets').mockResolvedValue({ coins: [{ id: 'bitcoin' }] });
    const handler = getHandler(router, '/markets', 'get');

    const res1 = mockRes();
    await handler(mockReq({ query: { limit: '50' } }), res1);
    const res2 = mockRes();
    await handler(mockReq({ query: { limit: '50' } }), res2);

    expect(res1.body.ok).toBe(true);
    expect(res2.body.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('serves stale cached data instead of hammering CoinGecko while the circuit is open (rate-limited-with-hit shortcut)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { cryptoService, router } = freshRouterAndService();
    vi.spyOn(cryptoService, 'getMarkets').mockResolvedValue({ coins: [{ id: 'bitcoin' }] });
    vi.spyOn(cryptoService, 'getTrending').mockRejectedValue(new Error('429 Too Many Requests'));

    const marketsHandler = getHandler(router, '/markets', 'get');
    const trendingHandler = getHandler(router, '/trending', 'get');

    // T=0: prime the `markets_50` cache with a real success.
    const primed = mockRes();
    await marketsHandler(mockReq({ query: { limit: '50' } }), primed);
    expect(primed.body.ok).toBe(true);

    // T=50s: a totally different cache key (`trending`) fails with a 429,
    // opening the circuit for RATE_LIMIT_BACKOFF_MS (65s) from this point.
    vi.setSystemTime(50_000);
    const rateLimited = mockRes();
    await trendingHandler(mockReq(), rateLimited);
    expect(rateLimited.statusCode).toBe(429);

    // T=91s: the `markets_50` entry is now stale (>90s CACHE_TTL old), but
    // the circuit opened at T=50s is still active until T=115s. This hits
    // cachedCall's top-of-function "isRateLimited() && hit" shortcut —
    // stale data served WITHOUT calling getMarkets a second time.
    vi.setSystemTime(91_000);
    const stale = mockRes();
    await marketsHandler(mockReq({ query: { limit: '50' } }), stale);
    expect(stale.body.ok).toBe(true);
    expect(stale.body.data).toEqual({ coins: [{ id: 'bitcoin' }] });
    expect(cryptoService.getMarkets).toHaveBeenCalledTimes(1);
  });

  it('rejects with a RateLimitError when the circuit is open and there is no cached data at all', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { cryptoService, router } = freshRouterAndService();
    vi.spyOn(cryptoService, 'getTrending').mockRejectedValue(new Error('429 Too Many Requests'));
    vi.spyOn(cryptoService, 'getGlobal').mockResolvedValue({ market_cap_percentage: { btc: 50 } });

    const trendingHandler = getHandler(router, '/trending', 'get');
    const globalHandler = getHandler(router, '/global', 'get');

    // Trip the circuit via `trending` (never cached before).
    const rateLimited = mockRes();
    await trendingHandler(mockReq(), rateLimited);
    expect(rateLimited.statusCode).toBe(429);

    // `global` was never cached either, so cachedCall must reject with a
    // RateLimitError rather than attempt the (currently forbidden) call.
    const res = mockRes();
    await globalHandler(mockReq(), res);
    expect(res.statusCode).toBe(429);
    expect(res.body.ok).toBe(false);
    expect(res.body.isRateLimit).toBe(true);
    expect(cryptoService.getGlobal).not.toHaveBeenCalled();
  });

  it('trips the circuit after OUTAGE_FAIL_THRESHOLD consecutive non-429 failures and serves stale data', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { cryptoService, router } = freshRouterAndService();
    const globalHandler = getHandler(router, '/global', 'get');

    // T=0: prime the `global` cache with a real success.
    vi.spyOn(cryptoService, 'getGlobal').mockResolvedValueOnce({ market_cap_percentage: { btc: 42 } });
    const primed = mockRes();
    await globalHandler(mockReq(), primed);
    expect(primed.body.data.market_cap_percentage.btc).toBe(42);

    // Age the cache past the 90s TTL so subsequent calls actually retry
    // the underlying service instead of short-circuiting on a fresh hit.
    vi.setSystemTime(91_000);
    cryptoService.getGlobal.mockRejectedValue(new Error('ECONNRESET'));

    // Failures 1 and 2: below OUTAGE_FAIL_THRESHOLD (3) — serve stale data
    // immediately without opening the circuit.
    const f1 = mockRes();
    await globalHandler(mockReq(), f1);
    expect(f1.body.ok).toBe(true);
    expect(f1.body.data.market_cap_percentage.btc).toBe(42);

    const f2 = mockRes();
    await globalHandler(mockReq(), f2);
    expect(f2.body.ok).toBe(true);
    expect(f2.body.data.market_cap_percentage.btc).toBe(42);

    // Failure 3: trips the circuit (markRateLimited) AND still serves the
    // stale data it has on hand — covers the `if (hit) { refresh; return }`
    // branch inside the outage-threshold path specifically.
    const f3 = mockRes();
    await globalHandler(mockReq(), f3);
    expect(f3.body.ok).toBe(true);
    expect(f3.body.data.market_cap_percentage.btc).toBe(42);

    expect(cryptoService.getGlobal).toHaveBeenCalledTimes(4); // 1 prime + 3 failed retries
  });
});

describe('crypto.routes — /anomalies route-level cache (roadmap #9)', () => {
  it('builds the batch on a cold cache, then serves the cached result on the next call within the TTL', async () => {
    const { cryptoService, router } = freshRouterAndService();
    const spy = vi.spyOn(cryptoService, 'getPriceHistory').mockResolvedValue(priceHistory(10));
    const handler = getHandler(router, '/anomalies', 'get');

    const res1 = mockRes();
    await handler(mockReq({ query: { coins: 'bitcoin,ethereum', days: '7' } }), res1);
    expect(res1.body.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2); // one call per id

    const res2 = mockRes();
    await handler(mockReq({ query: { coins: 'bitcoin,ethereum', days: '7' } }), res2);
    expect(res2.body.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2); // unchanged — served from the route cache
    expect(res2.body.data).toEqual(res1.body.data);
  });

  it('falls back to an empty-prices asset for any id whose history fetch fails', async () => {
    const { cryptoService, router } = freshRouterAndService();
    vi.spyOn(cryptoService, 'getPriceHistory')
      .mockImplementationOnce(() => Promise.resolve(priceHistory(10)))
      .mockImplementationOnce(() => Promise.reject(new Error('boom')));
    const handler = getHandler(router, '/anomalies', 'get');
    const res = mockRes();
    await handler(mockReq({ query: { coins: 'bitcoin,ethereum', days: '7' } }), res);
    expect(res.body.ok).toBe(true);
  });
});

describe('crypto.routes — batch routes: per-id try/catch fallback (roadmap #9)', () => {
  it('GET /scores falls back to a zero-volume asset when one id fails to fetch history', async () => {
    const { cryptoService, router } = freshRouterAndService();
    vi.spyOn(cryptoService, 'getMarkets').mockResolvedValue({
      coins: [{ id: 'bitcoin', name: 'Bitcoin', total_volume: 1_000_000, market_cap: 2_000_000 }],
    });
    vi.spyOn(cryptoService, 'getPriceHistory')
      .mockImplementationOnce(() => Promise.resolve(priceHistory(30)))
      .mockImplementationOnce(() => Promise.reject(new Error('boom')));

    const handler = getHandler(router, '/scores', 'get');
    const res = mockRes();
    await handler(mockReq({ query: { coins: 'bitcoin,ethereum', days: '30' } }), res);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.map(a => a.id)).toEqual(['bitcoin', 'ethereum']);
  });

  it('GET /scores parses a custom weights JSON query param', async () => {
    const { cryptoService, router } = freshRouterAndService();
    vi.spyOn(cryptoService, 'getMarkets').mockResolvedValue({ coins: [] });
    vi.spyOn(cryptoService, 'getPriceHistory').mockResolvedValue(priceHistory(30));

    const handler = getHandler(router, '/scores', 'get');
    const res = mockRes();
    const weights = JSON.stringify({ momentum: 0.5, volatility: 0.5, performance: 0, volume: 0 });
    await handler(mockReq({ query: { coins: 'bitcoin', weights } }), res);
    expect(res.body.ok).toBe(true);
  });

  it('GET /correlation falls back to an empty-prices asset when one id fails', async () => {
    const { cryptoService, router } = freshRouterAndService();
    vi.spyOn(cryptoService, 'getPriceHistory')
      .mockImplementationOnce(() => Promise.resolve(priceHistory(30)))
      .mockImplementationOnce(() => Promise.reject(new Error('boom')));

    const handler = getHandler(router, '/correlation', 'get');
    const res = mockRes();
    await handler(mockReq({ query: { coins: 'bitcoin,ethereum', days: '30' } }), res);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.ids).toEqual(['bitcoin', 'ethereum']);
    expect(res.body.data.matrix).toBeDefined();
  });

  it('GET /regime falls back to an empty-prices asset when one id fails, and computes KCS with the real btc dominance', async () => {
    const { cryptoService, router } = freshRouterAndService();
    vi.spyOn(cryptoService, 'getPriceHistory')
      .mockImplementationOnce(() => Promise.resolve(priceHistory(30)))
      .mockImplementationOnce(() => Promise.reject(new Error('boom')));
    vi.spyOn(cryptoService, 'getGlobal').mockResolvedValue({ market_cap_percentage: { btc: 55 } });

    const handler = getHandler(router, '/regime', 'get');
    const res = mockRes();
    await handler(mockReq({ query: { coins: 'bitcoin,ethereum', days: '30' } }), res);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.kcs).toBeDefined();
  });

  it('GET /kcs falls back gracefully when both a price-history id fails and the global market call fails', async () => {
    const { cryptoService, router } = freshRouterAndService();
    vi.spyOn(cryptoService, 'getPriceHistory')
      .mockImplementationOnce(() => Promise.resolve(priceHistory(30)))
      .mockImplementationOnce(() => Promise.reject(new Error('boom')));
    vi.spyOn(cryptoService, 'getGlobal').mockRejectedValue(new Error('global down'));

    const handler = getHandler(router, '/kcs', 'get');
    const res = mockRes();
    await handler(mockReq({ query: { coins: 'bitcoin,ethereum', days: '30' } }), res);
    expect(res.body.ok).toBe(true);
  });
});

describe('crypto.routes — GET /overview branch coverage (roadmap #9)', () => {
  it('handles coins with a full 30+ point sparkline (real trend + anomaly detection)', async () => {
    const { cryptoService, router } = freshRouterAndService();
    const sparkline = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 2) * 20);
    vi.spyOn(cryptoService, 'getMarkets').mockResolvedValue({
      coins: [{
        id: 'bitcoin', name: 'Bitcoin', symbol: 'btc', image: 'x.png',
        current_price: 50000, price_change_percentage_24h: 3,
        price_change_percentage_7d_in_currency: 5, total_volume: 1e9, market_cap: 1e12,
        volatility_score: 12, sparkline_in_7d: { price: sparkline },
      }],
    });
    const handler = getHandler(router, '/overview', 'get');
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.coins[0].trend).toBeDefined();
    expect(Array.isArray(res.body.data.gainers)).toBe(true);
    expect(Array.isArray(res.body.data.losers)).toBe(true);
    expect(Array.isArray(res.body.data.mostVolatile)).toBe(true);
    expect(Array.isArray(res.body.data.anomalous)).toBe(true);
  });

  it('falls back to sideways trend and low-severity anomaly for coins with a short sparkline', async () => {
    const { cryptoService, router } = freshRouterAndService();
    vi.spyOn(cryptoService, 'getMarkets').mockResolvedValue({
      coins: [{
        id: 'shortcoin', name: 'Short', symbol: 'shrt',
        current_price: 1, price_change_percentage_24h: 0,
        total_volume: 1, market_cap: 1,
        sparkline_in_7d: { price: [1, 2, 3] }, // < 5 points: skips detectAnomalies too
      }],
    });
    const handler = getHandler(router, '/overview', 'get');
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.coins[0].trendRaw).toBe('sideways');
    expect(res.body.data.coins[0].anomaly.level).toBe('low');
  });

  it('handles a coin with no sparkline data at all', async () => {
    const { cryptoService, router } = freshRouterAndService();
    vi.spyOn(cryptoService, 'getMarkets').mockResolvedValue({
      coins: [{ id: 'nosparkline', name: 'NoSpark', symbol: 'ns', current_price: 1, total_volume: 1, market_cap: 1 }],
    });
    const handler = getHandler(router, '/overview', 'get');
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.coins[0].trendRaw).toBe('sideways');
  });
});

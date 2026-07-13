'use strict';

/**
 * arbitrage.query.routes.test.js
 * Cobertura para server/arbitrage/subroutes/query.routes.js (556 líneas, 0% antes)
 * Patrón: require() del router CJS + vi.spyOn() sobre singletons compartidos.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Spies ANTES de cargar el router ────────────────────────────────────────
const exchangeSvc   = require('../server/infrastructure/exchangeService.js');
const walletMgr     = require('../server/domain/wallet/walletManager');
const replaySvc     = require('../server/infrastructure/replayService.js');
const advRisk       = require('../server/domain/risk/advancedRiskEngine');
const obsSvc        = require('../server/infrastructure/observabilityService.js');
const exchangeIntel = require('../server/infrastructure/exchangeIntelligence.js');
const latencyRacing = require('../server/infrastructure/latencyRacing.js');
const mlScoring     = require('../server/domain/engines/mlScoringPipeline');

vi.spyOn(exchangeSvc, 'getOrderBooks').mockResolvedValue([]);
vi.spyOn(exchangeSvc, 'wsStatus').mockReturnValue({});
vi.spyOn(walletMgr,   'getPnL').mockReturnValue({ realizedPnl: 0, unrealizedPnl: 0, totalPnl: 0 });
vi.spyOn(walletMgr,   'getTradeHistory').mockReturnValue([]);
vi.spyOn(walletMgr,   'getBalances').mockReturnValue({});
vi.spyOn(replaySvc,   'listReplays').mockReturnValue([]);
vi.spyOn(replaySvc,   'getBestReplay').mockReturnValue(null);
vi.spyOn(replaySvc,   'getReplayById').mockReturnValue(null);
vi.spyOn(advRisk,     'getStatus').mockReturnValue({ circuitBreaker: { active: false }, consecutiveFailures: 0 });
vi.spyOn(advRisk,     'getDrawdownPct').mockReturnValue(0);
vi.spyOn(advRisk,     'activateCircuitBreaker').mockReturnValue({ ok: true, alreadyActive: false });
vi.spyOn(obsSvc,      'getDashboard').mockReturnValue({ events: [], rcaSummary: {} });
vi.spyOn(obsSvc,      'getRCASummary').mockReturnValue({});
vi.spyOn(obsSvc,      'getRCALog').mockReturnValue([]);
vi.spyOn(obsSvc,      'getEvents').mockReturnValue([]);
vi.spyOn(obsSvc,      'getAllRecentEvents').mockReturnValue([]);
vi.spyOn(obsSvc,      'getExchangeHealth').mockReturnValue({});
vi.spyOn(exchangeIntel, 'getExchangeRanking').mockReturnValue([]);
vi.spyOn(exchangeIntel, 'getReliabilityLeaderboard').mockReturnValue([]);
vi.spyOn(exchangeIntel, 'getVolatilityStatus').mockReturnValue({});
vi.spyOn(exchangeIntel, 'getHistoricalLearning').mockReturnValue([]);
vi.spyOn(exchangeIntel, 'getPredictiveRanking').mockReturnValue([]);
vi.spyOn(latencyRacing, 'getRounds').mockReturnValue([]);
vi.spyOn(latencyRacing, 'getLeaderboard').mockReturnValue([]);
vi.spyOn(mlScoring,   'scoreOpportunity').mockReturnValue({ score: 75 });
vi.spyOn(mlScoring,   'getRegisteredModels').mockReturnValue([]);
vi.spyOn(mlScoring,   'getActiveModelName').mockReturnValue('default');

const queryRouter = require('../server/arbitrage/subroutes/query.routes.js');

// ── Helpers ────────────────────────────────────────────────────────────────
function getHandler(path, method = 'get') {
  const layer = queryRouter.stack.find(
    l => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No route ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
// Sesión 19, ítem #16: para probar que validateBody(schema) de verdad
// rechaza payloads inválidos con 400 (no solo el handler final, que los
// tests de arriba ejercitan saltándose el middleware a propósito).
function getFirstMiddleware(path, method = 'post') {
  const layer = queryRouter.stack.find(
    l => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No route ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}
// Sesión 20 (H-7): algunas rutas ahora tienen requireRole('admin') delante
// de validateBody — este helper permite tomar cualquier posición del stack
// en vez de asumir siempre índice 0.
function getMiddlewareAt(path, index, method = 'post') {
  const layer = queryRouter.stack.find(
    l => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No route ${method.toUpperCase()} ${path}`);
  return layer.route.stack[index].handle;
}
function mockRes() {
  const r = { _status: 200, _body: null };
  r.status = (c) => { r._status = c; return r; };
  r.json   = (b) => { r._body = b;   return r; };
  return r;
}
function mockReq(extra = {}) {
  return { params: {}, query: {}, body: {}, headers: {}, userId: 'u1', ...extra };
}

beforeEach(() => vi.clearAllMocks());

// ── Tests ──────────────────────────────────────────────────────────────────
describe('arbitrage/subroutes/query.routes', () => {

  it('GET /stats — ok:true con campos de estado', async () => {
    const res = mockRes();
    await getHandler('/stats')(mockReq(), res);
    expect(res._body.ok).toBe(true);
    expect(res._body.data).toHaveProperty('botEnabled');
    expect(res._body.data).toHaveProperty('rejectionCounts');
  });

  it('GET /intelligence — ok:true', async () => {
    const res = mockRes();
    await getHandler('/intelligence')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /lifecycle — ok:true', () => {
    const res = mockRes();
    getHandler('/lifecycle')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /executive — ok:true', async () => {
    const res = mockRes();
    await getHandler('/executive')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /replays — lista vacía', async () => {
    const res = mockRes();
    await getHandler('/replays')(mockReq(), res);
    expect(res._body.ok).toBe(true);
    expect(Array.isArray(res._body.data)).toBe(true);
  });

  it('GET /replays/best — ok:true', async () => {
    const res = mockRes();
    await getHandler('/replays/best')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /replays/:id — 404 para id inexistente', async () => {
    const res = mockRes();
    await getHandler('/replays/:id')(mockReq({ params: { id: 'x' } }), res);
    expect(res._status).toBe(404);
    expect(res._body.ok).toBe(false);
  });

  it('GET /journal — ok:true', () => {
    const res = mockRes();
    getHandler('/journal')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /stress-test/scenarios — ok:true', () => {
    const res = mockRes();
    getHandler('/stress-test/scenarios')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  describe('POST /stress-test/activate (Sesión 19 #16 — validateBody; Sesión 20 H-7 — requireRole)', () => {
    it('H-7: rechaza con 403 a un usuario sin rol admin, antes de llegar a validateBody', () => {
      const res = mockRes();
      let nextCalled = false;
      getFirstMiddleware('/stress-test/activate')(
        mockReq({ body: { type: 'fee_spike' }, user: { role: 'user' } }), res, () => { nextCalled = true; },
      );
      expect(nextCalled).toBe(false);
      expect(res._status).toBe(403);
    });

    it('H-7: deja pasar a un usuario admin hacia validateBody', () => {
      const res = mockRes();
      let nextCalled = false;
      getFirstMiddleware('/stress-test/activate')(
        mockReq({ body: { type: 'fee_spike' }, user: { role: 'admin' } }), res, () => { nextCalled = true; },
      );
      expect(nextCalled).toBe(true);
    });

    it('rechaza expiresAfterMs no numérico con 400 (validateBody, tras pasar requireRole)', () => {
      const res = mockRes();
      let nextCalled = false;
      getMiddlewareAt('/stress-test/activate', 1)(
        mockReq({ body: { type: 'fee_spike', expiresAfterMs: 'abc' }, user: { role: 'admin' } }), res, () => { nextCalled = true; },
      );
      expect(nextCalled).toBe(false);
      expect(res._status).toBe(400);
    });

    it('deja pasar un body válido al siguiente middleware', () => {
      const res = mockRes();
      let nextCalled = false;
      getMiddlewareAt('/stress-test/activate', 1)(
        mockReq({ body: { type: 'fee_spike', multiplier: 2 }, user: { role: 'admin' } }), res, () => { nextCalled = true; },
      );
      expect(nextCalled).toBe(true);
      expect(res._status).toBe(200); // no tocado por el middleware
    });
  });

  describe('POST /stress-test/deactivate — H-7: requireRole(admin)', () => {
    it('rechaza con 403 a un usuario sin rol admin', () => {
      const res = mockRes();
      let nextCalled = false;
      getFirstMiddleware('/stress-test/deactivate')(
        mockReq({ user: { role: 'user' } }), res, () => { nextCalled = true; },
      );
      expect(nextCalled).toBe(false);
      expect(res._status).toBe(403);
    });
  });

  it('GET /decay-curve — ok:true', () => {
    const res = mockRes();
    getHandler('/decay-curve')(mockReq({ query: { pair: 'Binance-Kraken' } }), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /latency-racing — ok:true', () => {
    const res = mockRes();
    getHandler('/latency-racing')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /missed — ok:true', () => {
    const res = mockRes();
    getHandler('/missed')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /statarrb-pairs — ok:true', () => {
    const res = mockRes();
    getHandler('/statarrb-pairs')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /arb-backtest/summary — ok:true', () => {
    const res = mockRes();
    getHandler('/arb-backtest/summary')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  describe('POST /arb-backtest/simulate (Sesión 19, ítem #16 — validateBody)', () => {
    it('rechaza minScore no numérico con 400 antes de llegar al handler', () => {
      const res = mockRes();
      let nextCalled = false;
      getFirstMiddleware('/arb-backtest/simulate')(
        mockReq({ body: { minScore: 'high' } }), res, () => { nextCalled = true; },
      );
      expect(nextCalled).toBe(false);
      expect(res._status).toBe(400);
    });

    it('deja pasar un body válido (u omitido) al handler', () => {
      const res = mockRes();
      let nextCalled = false;
      getFirstMiddleware('/arb-backtest/simulate')(mockReq({ body: {} }), res, () => { nextCalled = true; });
      expect(nextCalled).toBe(true);
    });
  });

  it('GET /adaptive-recommendation — ok:true', () => {
    const res = mockRes();
    getHandler('/adaptive-recommendation')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /reliability — ok:true', () => {
    const res = mockRes();
    getHandler('/reliability')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /alerts/config — ok:true', () => {
    const res = mockRes();
    getHandler('/alerts/config')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /alerts/history — ok:true', () => {
    const res = mockRes();
    getHandler('/alerts/history')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /position-sizing — ok:true', () => {
    const res = mockRes();
    getHandler('/position-sizing')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /execution-quality — ok:true', async () => {
    const res = mockRes();
    await getHandler('/execution-quality')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /spread-momentum — ok:true', () => {
    const res = mockRes();
    getHandler('/spread-momentum')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /spread-heatmap — ok:true', async () => {
    const res = mockRes();
    await getHandler('/spread-heatmap')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /daily-reports — ok:true', async () => {
    const res = mockRes();
    await getHandler('/daily-reports')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /daily-stats — ok:true', async () => {
    const res = mockRes();
    await getHandler('/daily-stats')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /e2e-latency — ok:true', () => {
    const res = mockRes();
    getHandler('/e2e-latency')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /risk/status — ok:true con circuitBreaker', () => {
    const res = mockRes();
    getHandler('/risk/status')(mockReq(), res);
    expect(res._body.ok).toBe(true);
    expect(res._body.data).toBeDefined();
  });

  it('GET /risk/status — H-6 remainder (Sesión 21): el capitalUSD pasado a advRisk.getStatus incluye el valor de ETH', () => {
    walletMgr.getBalances.mockReturnValueOnce({
      BTC:  { Binance: 1 },
      ETH:  { Binance: 10 },
      USDT: { Binance: 1000 },
    });
    const getStatusSpy = vi.spyOn(advRisk, 'getStatus').mockReturnValue({});
    const res = mockRes();
    getHandler('/risk/status')(mockReq(), res);
    const capitalArg = getStatusSpy.mock.calls[0][0];
    // 1 BTC * fallback(50000) + 10 ETH * fallback(2500) + 1000 USDT = 76000
    expect(capitalArg).toBeGreaterThanOrEqual(1000 + 10 * 2500);
  });

  it('POST /risk/circuit-breaker/reset — ok:true', () => {
    vi.spyOn(advRisk, 'resetCircuitBreaker').mockReturnValue();
    const res = mockRes();
    getHandler('/risk/circuit-breaker/reset', 'post')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('POST /risk/circuit-breaker/reset — H-7: requireRole(admin) rechaza con 403 a un usuario sin rol admin', () => {
    const res = mockRes();
    let nextCalled = false;
    getFirstMiddleware('/risk/circuit-breaker/reset')(
      mockReq({ user: { role: 'user' } }), res, () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(403);
  });

  // Auditoría del comité (Sesión 34, P0 #2 — kill switch manual).
  describe('POST /risk/circuit-breaker/activate — kill switch manual', () => {
    it('ok:true con reason válido, llama a activateCircuitBreaker(reason, "manual")', () => {
      vi.spyOn(advRisk, 'activateCircuitBreaker').mockReturnValue({ ok: true, alreadyActive: false });
      const res = mockRes();
      getHandler('/risk/circuit-breaker/activate', 'post')(
        mockReq({ body: { reason: 'operador detuvo el sistema manualmente' } }), res,
      );
      expect(res._body.ok).toBe(true);
      expect(advRisk.activateCircuitBreaker).toHaveBeenCalledWith('operador detuvo el sistema manualmente', 'manual');
    });

    it('requireRole(admin) rechaza con 403 a un usuario sin rol admin', () => {
      const res = mockRes();
      let nextCalled = false;
      getFirstMiddleware('/risk/circuit-breaker/activate')(
        mockReq({ user: { role: 'user' } }), res, () => { nextCalled = true; },
      );
      expect(nextCalled).toBe(false);
      expect(res._status).toBe(403);
    });

    it('deja pasar a un usuario admin hacia validateBody', () => {
      const res = mockRes();
      let nextCalled = false;
      getFirstMiddleware('/risk/circuit-breaker/activate')(
        mockReq({ body: { reason: 'halt manual' }, user: { role: 'admin' } }), res, () => { nextCalled = true; },
      );
      expect(nextCalled).toBe(true);
    });

    it('validateBody rechaza sin reason con 400', () => {
      const res = mockRes();
      let nextCalled = false;
      getMiddlewareAt('/risk/circuit-breaker/activate', 1)(
        mockReq({ user: { role: 'admin' }, body: {} }), res, () => { nextCalled = true; },
      );
      expect(nextCalled).toBe(false);
      expect(res._status).toBe(400);
    });

    it('validateBody rechaza reason de menos de 3 caracteres con 400', () => {
      const res = mockRes();
      let nextCalled = false;
      getMiddlewareAt('/risk/circuit-breaker/activate', 1)(
        mockReq({ user: { role: 'admin' }, body: { reason: 'hi' } }), res, () => { nextCalled = true; },
      );
      expect(nextCalled).toBe(false);
      expect(res._status).toBe(400);
    });

    it('validateBody deja pasar un reason válido', () => {
      const res = mockRes();
      let nextCalled = false;
      getMiddlewareAt('/risk/circuit-breaker/activate', 1)(
        mockReq({ user: { role: 'admin' }, body: { reason: 'spread anomaly detected manually' } }), res, () => { nextCalled = true; },
      );
      expect(nextCalled).toBe(true);
    });
  });

  it('GET /observability/dashboard — ok:true', () => {
    const res = mockRes();
    getHandler('/observability/dashboard')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /observability/rca — ok:true', () => {
    const res = mockRes();
    getHandler('/observability/rca')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /observability/events — ok:true', () => {
    const res = mockRes();
    getHandler('/observability/events')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('GET /observability/exchange-health — ok:true', () => {
    const res = mockRes();
    getHandler('/observability/exchange-health')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });

  it('POST /ml/score — 400 sin buyExchange/sellExchange', () => {
    const res = mockRes();
    getHandler('/ml/score', 'post')(mockReq({ body: {} }), res);
    expect(res._status).toBe(400);
  });

  it('POST /ml/score — ok:true con oportunidad válida', () => {
    const res = mockRes();
    getHandler('/ml/score', 'post')(mockReq({ body: { buyExchange: 'Binance', sellExchange: 'Kraken' } }), res);
    expect(res._body.ok).toBe(true);
  });

  it('POST /ml/score — el middleware validateBody rechaza buyExchange no-string con 400', () => {
    const res = mockRes();
    let nextCalled = false;
    getFirstMiddleware('/ml/score')(
      mockReq({ body: { buyExchange: { nested: true }, sellExchange: 'Kraken' } }), res, () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
  });

  it('POST /ml/score — el middleware validateBody rechaza un body sin netProfit/spreadPct/viable con 400 (MlScoreBodySchema ya no es un alias laxo de OpportunitySchema)', () => {
    const res = mockRes();
    let nextCalled = false;
    getFirstMiddleware('/ml/score')(
      mockReq({ body: { buyExchange: 'Binance', sellExchange: 'Kraken' } }), res, () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(false);
    expect(res._status).toBe(400);
  });

  it('POST /ml/score — el middleware validateBody deja pasar un body con netProfit/spreadPct/viable presentes', () => {
    const res = mockRes();
    let nextCalled = false;
    getFirstMiddleware('/ml/score')(
      mockReq({ body: { buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 12.5, spreadPct: 0.3, viable: true } }), res, () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
  });

  it('GET /ml/info — ok:true', () => {
    const res = mockRes();
    getHandler('/ml/info')(mockReq(), res);
    expect(res._body.ok).toBe(true);
  });
});

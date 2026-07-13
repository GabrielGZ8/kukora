'use strict';

/**
 * arbitrage.stream.routes.test.js
 * Cobertura para server/arbitrage/subroutes/stream.routes.js (268 líneas, 0% antes).
 *
 * Enfoque: extraer los handlers directamente del router (como en
 * arbitrage.config.routes.test.js) y simular req/res mínimos, incluyendo
 * SSE (res.write/setHeader/flushHeaders) y el ciclo de vida 'close' del
 * request. setInterval se espía para capturar el callback del heartbeat
 * sin dejar timers reales corriendo entre tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Spies antes de cargar el router ───────────────────────────────────────
const auth               = require('../server/infrastructure/auth.js');
const state               = require('../server/application/arbitrage.state.js');
const arbitrageOrch       = require('../server/application/arbitrageOrchestrator.js');
const exchangeSvc         = require('../server/infrastructure/exchangeService.js');
const opportunityDetection = require('../server/domain/engines/opportunityDetection');
const walletManager       = require('../server/domain/wallet/walletManager');
const replayService       = require('../server/infrastructure/replayService.js');
const speedBenchmark       = require('../server/infrastructure/speedBenchmark.js');
const persistenceService   = require('../server/infrastructure/persistenceService.js');
const missedTracker        = require('../server/infrastructure/missedOpportunityTracker.js');
const exchangeReliability  = require('../server/infrastructure/exchangeReliabilityDynamic.js');
const adaptiveScoring      = require('../server/domain/engines/adaptiveScoring');
const alertWebhookService  = require('../server/infrastructure/alertWebhookService.js');
const executionJournal     = require('../server/domain/analytics/executionJournal');
const stressTestService    = require('../server/domain/risk/stressTestService');
const latencyRacing        = require('../server/infrastructure/latencyRacing.js');
const e2eLatency            = require('../server/infrastructure/e2eLatencyTracker.js');
const spreadMomentum        = require('../server/domain/engines/spreadMomentumEngine');
const adaptivePosition      = require('../server/domain/risk/adaptivePositionSizing');
const exchangeIntelligence  = require('../server/infrastructure/exchangeIntelligence.js');
const liveConfig            = require('../server/infrastructure/liveConfig.js');

vi.spyOn(auth, 'consumeStreamTicket').mockImplementation(async (ticket) => (ticket === 'good-ticket' ? 'user-1' : null));

vi.spyOn(arbitrageOrch, 'getMinScore').mockReturnValue(10);
vi.spyOn(exchangeSvc, 'getOrderBooks').mockResolvedValue([]);
vi.spyOn(exchangeSvc, 'wsStatus').mockReturnValue({ connected: true });
vi.spyOn(exchangeSvc, 'getFreshness').mockReturnValue({});
vi.spyOn(opportunityDetection, 'detectOpportunities').mockReturnValue({ opportunities: [], triangularSignal: null });
vi.spyOn(opportunityDetection, 'getDailyPnl').mockReturnValue(0);
vi.spyOn(opportunityDetection, 'isDailyLossBreached').mockReturnValue(false);
vi.spyOn(opportunityDetection, 'resetDailyPnl').mockImplementation(() => {});
vi.spyOn(opportunityDetection, 'getRejectionCounts').mockReturnValue({});
vi.spyOn(opportunityDetection, 'getBestOpportunitySeen').mockReturnValue(null);
vi.spyOn(opportunityDetection, 'getNearViableCount').mockReturnValue(0);
vi.spyOn(opportunityDetection, 'resetSessionStats').mockImplementation(() => {});
vi.spyOn(opportunityDetection, 'resetStatArb').mockImplementation(() => {});
vi.spyOn(walletManager, 'getBalances').mockReturnValue({ USD: 1000 });
vi.spyOn(walletManager, 'resetBalances').mockImplementation(() => {});
vi.spyOn(walletManager, 'getTradeHistory').mockReturnValue([]);
vi.spyOn(walletManager, 'getPnL').mockReturnValue({ totalPnl: 0, realizedPnl: 0, unrealizedPnl: 0, totalTrades: 0, winRate: 0 });
vi.spyOn(replayService, 'resetReplays').mockImplementation(() => {});
vi.spyOn(speedBenchmark, 'resetBenchmark').mockImplementation(() => {});
vi.spyOn(persistenceService, 'advanceSession').mockImplementation(() => {});
vi.spyOn(missedTracker, 'resetMissed').mockImplementation(() => {});
vi.spyOn(exchangeReliability, 'resetReliability').mockImplementation(() => {});
vi.spyOn(adaptiveScoring, 'resetAdaptive').mockImplementation(() => {});
vi.spyOn(alertWebhookService, 'resetAlerts').mockImplementation(() => {});
vi.spyOn(executionJournal, 'resetJournal').mockImplementation(() => {});
vi.spyOn(stressTestService, 'deactivateScenario').mockImplementation(() => {});
vi.spyOn(latencyRacing, 'resetRacing').mockImplementation(() => {});
vi.spyOn(e2eLatency, 'reset').mockImplementation(() => {});
vi.spyOn(spreadMomentum, 'reset').mockImplementation(() => {});
vi.spyOn(adaptivePosition, 'reset').mockImplementation(() => {});
vi.spyOn(exchangeIntelligence, 'resetIntelligence').mockImplementation(() => {});
vi.spyOn(liveConfig, 'setMany').mockReturnValue({ ok: true });

// Cargar el router DESPUÉS de los spies
const streamRouter = require('../server/arbitrage/subroutes/stream.routes.js');

// ── Helpers ────────────────────────────────────────────────────────────────
function getHandlers(path, method = 'get') {
  const layer = streamRouter.stack.find(
    l => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No route ${method.toUpperCase()} ${path}`);
  // Returns the full middleware chain (may include auth middleware + final handler)
  return layer.route.stack.map(s => s.handle);
}

function mockRes() {
  const r = {
    _status: 200,
    _body: null,
    _headers: {},
    _written: [],
    _ended: false,
  };
  r.status       = (c) => { r._status = c; return r; };
  r.json         = (b) => { r._body = b; return r; };
  r.setHeader    = (k, v) => { r._headers[k] = v; return r; };
  r.flushHeaders = () => { return r; };
  r.write        = (chunk) => { r._written.push(chunk); return true; };
  r.end          = () => { r._ended = true; return r; };
  return r;
}

function mockReq(extra = {}) {
  const listeners = {};
  return {
    params: {}, query: {}, body: {}, headers: {},
    on: (event, cb) => { listeners[event] = cb; },
    _trigger: (event) => listeners[event] && listeners[event](),
    ...extra,
  };
}

async function runChain(handlers, req, res) {
  for (const h of handlers) {
    let calledNext = false;
    // eslint-disable-next-line no-loop-func
    await h(req, res, () => { calledNext = true; });
    if (!calledNext) return; // middleware short-circuited (e.g. auth failure)
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.sseClients.clear();
  state.sseClientUid.clear();
  state.alertsClients.clear();
  state.resetCounters();
  state.clearEquityCurve();
  auth.consumeStreamTicket.mockImplementation(async (ticket) => (ticket === 'good-ticket' ? 'user-1' : null));
});

let setIntervalSpy;
let clearIntervalSpy;
beforeEach(() => {
  setIntervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue(999);
  clearIntervalSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => {});
});
afterEach(() => {
  setIntervalSpy.mockRestore();
  clearIntervalSpy.mockRestore();
});

describe('arbitrage/subroutes/stream.routes', () => {
  describe('GET /stream (SSE)', () => {
    it('rejects requests without a valid stream ticket (401)', async () => {
      const handlers = getHandlers('/stream');
      const req = mockReq({ query: { ticket: 'bad-ticket' } });
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._status).toBe(401);
      expect(res._ended).toBe(true);
    });

    it('sets up SSE headers and writes an init payload for an authenticated client', async () => {
      const handlers = getHandlers('/stream');
      const req = mockReq({ query: { ticket: 'good-ticket' } });
      const res = mockRes();
      await runChain(handlers, req, res);

      expect(res._headers['Content-Type']).toBe('text/event-stream');
      expect(res._written.length).toBeGreaterThan(0);
      const initPayload = JSON.parse(res._written[0].replace(/^data: /, '').trim());
      expect(initPayload.type).toBe('init');
      expect(state.sseClients.has(res)).toBe(true);
    });

    it('removes the client from sseClients when the request closes', async () => {
      const handlers = getHandlers('/stream');
      const req = mockReq({ query: { ticket: 'good-ticket' } });
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(state.sseClients.has(res)).toBe(true);

      req._trigger('close');
      expect(state.sseClients.has(res)).toBe(false);
      expect(clearIntervalSpy).toHaveBeenCalled();
    });

    it('registers the connecting uid in sseClientUid, and clears it on close', async () => {
      const handlers = getHandlers('/stream');
      const req = mockReq({ query: { ticket: 'good-ticket' } });
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(state.sseClientUid.get(res)).toBe('user-1');

      req._trigger('close');
      expect(state.sseClientUid.has(res)).toBe(false);
    });

    it('the init payload carries a `tenant` overlay scoped to the connecting uid', async () => {
      const handlers = getHandlers('/stream');
      const req = mockReq({ query: { ticket: 'good-ticket' } });
      const res = mockRes();
      await runChain(handlers, req, res);

      const initPayload = JSON.parse(res._written[0].replace(/^data: /, '').trim());
      expect(initPayload.type).toBe('init');
      expect(initPayload.tenant).toBeTruthy();
      expect(initPayload.tenant.uid).toBe('user-1');
      expect(initPayload.tenant.botEnabled).toBe(false); // this uid never toggled its bot on
    });

    it('returns 503 when the SSE client capacity is reached', async () => {
      const handlers = getHandlers('/stream');
      // Fill sseClients up to MAX_SSE_CLIENTS (default 200)
      for (let i = 0; i < 200; i++) state.sseClients.add({ write: () => {} });

      const req = mockReq({ query: { ticket: 'good-ticket' } });
      const res = mockRes();
      await runChain(handlers, req, res);

      expect(res._status).toBe(503);
      expect(res._body.ok).toBe(false);
    });

    it('falls back to an error init payload when order book / opportunity detection throws', async () => {
      opportunityDetection.detectOpportunities.mockImplementationOnce(() => { throw new Error('detection boom'); });
      const handlers = getHandlers('/stream');
      const req = mockReq({ query: { ticket: 'good-ticket' } });
      const res = mockRes();
      await runChain(handlers, req, res);

      // detectOpportunities throwing is caught internally (non-fatal) — init payload still succeeds.
      expect(res._written.length).toBeGreaterThan(0);
      const initPayload = JSON.parse(res._written[0].replace(/^data: /, '').trim());
      expect(initPayload.type).toBe('init');
    });
  });

  describe('GET /alerts-stream (SSE)', () => {
    it('rejects requests without a valid stream ticket (401)', async () => {
      const handlers = getHandlers('/alerts-stream');
      const req = mockReq({ query: { ticket: 'bad-ticket' } });
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._status).toBe(401);
    });

    it('registers the client and writes the last trade if history exists', async () => {
      const lastTrade = { id: 't1', ts: new Date().toISOString(), pnl: 5 };
      walletManager.getTradeHistory.mockReturnValueOnce([lastTrade]);

      const handlers = getHandlers('/alerts-stream');
      const req = mockReq({ query: { ticket: 'good-ticket' } });
      const res = mockRes();
      await runChain(handlers, req, res);

      expect(state.alertsClients.has(res)).toBe(true);
      expect(res._written.length).toBe(1);
      const payload = JSON.parse(res._written[0].replace(/^data: /, '').trim());
      expect(payload.type).toBe('arb_trade');
      expect(payload.trade.id).toBe('t1');
    });

    it('does not write an initial payload when there is no trade history', async () => {
      walletManager.getTradeHistory.mockReturnValueOnce([]);
      const handlers = getHandlers('/alerts-stream');
      const req = mockReq({ query: { ticket: 'good-ticket' } });
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._written.length).toBe(0);
    });

    it('returns 503 when alert SSE capacity is reached', async () => {
      for (let i = 0; i < 200; i++) state.alertsClients.add({ write: () => {} });
      const handlers = getHandlers('/alerts-stream');
      const req = mockReq({ query: { ticket: 'good-ticket' } });
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._status).toBe(503);
    });

    it('removes the client from alertsClients on close', async () => {
      const handlers = getHandlers('/alerts-stream');
      const req = mockReq({ query: { ticket: 'good-ticket' } });
      const res = mockRes();
      await runChain(handlers, req, res);
      req._trigger('close');
      expect(state.alertsClients.has(res)).toBe(false);
    });
  });

  describe('GET /live', () => {
    it('returns a one-shot snapshot with ok: true', async () => {
      const handlers = getHandlers('/live');
      const req = mockReq();
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._body.ok).toBe(true);
      expect(res._body).toHaveProperty('orderBooks');
      expect(res._body).toHaveProperty('pnl');
    });

    it('returns 500 when an internal call throws', async () => {
      exchangeSvc.getOrderBooks.mockRejectedValueOnce(new Error('exchange down'));
      const handlers = getHandlers('/live');
      const req = mockReq();
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._status).toBe(500);
      expect(res._body.ok).toBe(false);
    });
  });

  describe('POST /bot', () => {
    it('enables the bot and updates minScore, broadcasting to sseClients', async () => {
      const client = { write: vi.fn() };
      state.sseClients.add(client);

      const handlers = getHandlers('/bot', 'post');
      const req = mockReq({ body: { enabled: true, score: 42 } });
      const res = mockRes();
      await runChain(handlers, req, res);

      expect(res._body.ok).toBe(true);
      expect(liveConfig.setMany).toHaveBeenCalledWith({ minScore: 42 }, 'bot-control');
      expect(client.write).toHaveBeenCalled();
    });

    it('ignores an out-of-range score', async () => {
      const handlers = getHandlers('/bot', 'post');
      const req = mockReq({ body: { score: 500 } });
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(liveConfig.setMany).not.toHaveBeenCalled();
      expect(res._body.ok).toBe(true);
    });

    it('returns 500 when setBotEnabled/config throws', async () => {
      liveConfig.setMany.mockImplementationOnce(() => { throw new Error('bad config'); });
      const handlers = getHandlers('/bot', 'post');
      const req = mockReq({ body: { score: 20 } });
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._status).toBe(500);
    });
  });

  describe('POST /reset', () => {
    const originalEnv = { ...process.env };
    afterEach(() => { process.env = { ...originalEnv }; });

    it('is unprotected in dev mode when ADMIN_TOKEN is not set', async () => {
      delete process.env.ADMIN_TOKEN;
      process.env.NODE_ENV = 'test';
      const handlers = getHandlers('/reset', 'post');
      const req = mockReq();
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._body.ok).toBe(true);
      expect(walletManager.resetBalances).toHaveBeenCalled();
    });

    it('requires ADMIN_TOKEN in production and returns 503 if missing', async () => {
      delete process.env.ADMIN_TOKEN;
      process.env.NODE_ENV = 'production';
      const handlers = getHandlers('/reset', 'post');
      const req = mockReq();
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._status).toBe(503);
      process.env.NODE_ENV = 'test';
    });

    it('rejects requests with an invalid X-Admin-Token when ADMIN_TOKEN is set', async () => {
      process.env.ADMIN_TOKEN = 'secret-token';
      const handlers = getHandlers('/reset', 'post');
      const req = mockReq({ headers: { 'x-admin-token': 'wrong' } });
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._status).toBe(401);
      delete process.env.ADMIN_TOKEN;
    });

    it('accepts a valid X-Admin-Token and resets all subsystems', async () => {
      process.env.ADMIN_TOKEN = 'secret-token';
      const handlers = getHandlers('/reset', 'post');
      const req = mockReq({ headers: { 'x-admin-token': 'secret-token' } });
      const res = mockRes();
      await runChain(handlers, req, res);

      expect(res._body.ok).toBe(true);
      expect(walletManager.resetBalances).toHaveBeenCalled();
      expect(opportunityDetection.resetDailyPnl).toHaveBeenCalled();
      expect(opportunityDetection.resetSessionStats).toHaveBeenCalled();
      expect(persistenceService.advanceSession).toHaveBeenCalled();
      delete process.env.ADMIN_TOKEN;
    });

    it('returns 500 if a reset subsystem call throws', async () => {
      delete process.env.ADMIN_TOKEN;
      process.env.NODE_ENV = 'test';
      walletManager.resetBalances.mockImplementationOnce(() => { throw new Error('reset boom'); });
      const handlers = getHandlers('/reset', 'post');
      const req = mockReq();
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._status).toBe(500);
    });
  });

  describe('GET /history', () => {
    it('returns trade history in reverse order', async () => {
      walletManager.getTradeHistory.mockReturnValueOnce([{ id: 1 }, { id: 2 }]);
      const handlers = getHandlers('/history');
      const req = mockReq();
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._body.ok).toBe(true);
      expect(res._body.data).toEqual([{ id: 2 }, { id: 1 }]);
    });

    it('returns 500 on error', async () => {
      walletManager.getTradeHistory.mockImplementationOnce(() => { throw new Error('boom'); });
      const handlers = getHandlers('/history');
      const req = mockReq();
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._status).toBe(500);
    });

    // Área 4 fix: pagination + filtering so the frontend can browse the
    // full trade history instead of only the last 20 trades pushed over SSE.
    it('paginates with limit/offset', async () => {
      const trades = Array.from({ length: 30 }, (_, i) => ({ id: i, status: 'profit', buyExchange: 'Binance', sellExchange: 'Kraken' }));
      walletManager.getTradeHistory.mockReturnValueOnce(trades);
      const handlers = getHandlers('/history');
      const req = mockReq({ query: { limit: '10', offset: '5' } });
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._body.ok).toBe(true);
      expect(res._body.data.length).toBe(10);
      // trades reversed first (id 29..0), so offset 5 starts at id 24
      expect(res._body.data[0].id).toBe(24);
      expect(res._body.pagination).toEqual({ limit: 10, offset: 5, total: 30, returned: 10 });
    });

    it('caps limit at 500 even if a larger value is requested', async () => {
      walletManager.getTradeHistory.mockReturnValueOnce([{ id: 1 }]);
      const handlers = getHandlers('/history');
      const req = mockReq({ query: { limit: '99999' } });
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._body.pagination.limit).toBe(500);
    });

    it('filters by exchange (matches either leg, case-insensitive)', async () => {
      const trades = [
        { id: 1, status: 'profit', buyExchange: 'Binance', sellExchange: 'Kraken' },
        { id: 2, status: 'profit', buyExchange: 'Kraken',  sellExchange: 'Bybit' },
        { id: 3, status: 'loss',   buyExchange: 'OKX',     sellExchange: 'Bybit' },
      ];
      walletManager.getTradeHistory.mockReturnValueOnce(trades);
      const handlers = getHandlers('/history');
      const req = mockReq({ query: { exchange: 'binance' } });
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._body.data).toEqual([{ id: 1, status: 'profit', buyExchange: 'Binance', sellExchange: 'Kraken' }]);
      expect(res._body.pagination.total).toBe(1);
    });

    it('filters by status', async () => {
      const trades = [
        { id: 1, status: 'profit', buyExchange: 'Binance', sellExchange: 'Kraken' },
        { id: 2, status: 'loss',   buyExchange: 'Kraken',  sellExchange: 'Bybit' },
      ];
      walletManager.getTradeHistory.mockReturnValueOnce(trades);
      const handlers = getHandlers('/history');
      const req = mockReq({ query: { status: 'loss' } });
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._body.data).toEqual([{ id: 2, status: 'loss', buyExchange: 'Kraken', sellExchange: 'Bybit' }]);
    });

    it('ignores an invalid status filter value', async () => {
      const trades = [{ id: 1, status: 'profit', buyExchange: 'Binance', sellExchange: 'Kraken' }];
      walletManager.getTradeHistory.mockReturnValueOnce(trades);
      const handlers = getHandlers('/history');
      const req = mockReq({ query: { status: 'bogus' } });
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._body.data.length).toBe(1);
    });
  });

  describe('GET /wallets', () => {
    it('returns current balances', async () => {
      walletManager.getBalances.mockReturnValueOnce({ USD: 500, BTC: 0.01 });
      const handlers = getHandlers('/wallets');
      const req = mockReq();
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._body.ok).toBe(true);
      expect(res._body.data).toEqual({ USD: 500, BTC: 0.01 });
    });

    it('returns 500 on error', async () => {
      walletManager.getBalances.mockImplementationOnce(() => { throw new Error('boom'); });
      const handlers = getHandlers('/wallets');
      const req = mockReq();
      const res = mockRes();
      await runChain(handlers, req, res);
      expect(res._status).toBe(500);
    });
  });
});

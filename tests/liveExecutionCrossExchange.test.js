'use strict';

/**
 * liveExecutionCrossExchange.test.js
 *
 * Tests for executeCrossExchangeLive() — Fase 3's real dual-leg
 * cross-exchange execution (server/application/liveExecution.js).
 *
 * Uses a host-routed fetch mock (rather than a single sequential queue,
 * as tests/liveExecution.test.js uses for the single-leg path) because
 * the buy and sell legs run concurrently via Promise.all — a shared
 * counter would make call ordering nondeterministic. Each exchange host
 * gets its own independent response queue and counter.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadModule({ liveEnabled = false } = {}) {
  vi.resetModules();
  process.env.LIVE_TRADING_ENABLED = liveEnabled ? 'true' : 'false';
  const mod = await import('../server/application/liveExecution.js?t=' + Math.random());
  const liveExecution = mod.default || mod;
  return _autoSeedOpportunityStore(liveExecution);
}

// See tests/liveExecution.test.js for the full rationale (AUDIT FINDING 1
// fix): auto-seeds the server-side opportunity snapshot store with
// whatever opportunity object each test passes in, so hand-built fixtures
// keep working through the real resolveTrustedOpportunity() gate.
function _autoSeedOpportunityStore(liveExecution) {
  const store = liveExecution._opportunitySnapshotStore;
  const userLiveModeService = require('../server/infrastructure/userLiveModeService');
  const wrap = (fn) => (opportunity, ...rest) => {
    if (opportunity && opportunity.id) store.recordSnapshot(opportunity);
    if (rest[0]) userLiveModeService._forceEnableForTests(rest[0]);
    return fn(opportunity, ...rest);
  };
  liveExecution.executeLive = wrap(liveExecution.executeLive);
  liveExecution.executeCrossExchangeLive = wrap(liveExecution.executeCrossExchangeLive);
  return liveExecution;
}

/**
 * mockFetchByHost — routes each fetch() call to a per-host response queue
 * based on the request URL's hostname, so concurrent requests to different
 * exchanges (buy leg vs sell leg) don't interfere with each other's call
 * ordering.
 */
function mockFetchByHost(routes) {
  const counters = {};
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const host = new URL(url).host;
    const seq = routes[host];
    if (!seq) throw new Error(`mockFetchByHost: no route configured for host ${host}`);
    counters[host] = counters[host] || 0;
    const r = seq[Math.min(counters[host], seq.length - 1)];
    counters[host]++;
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r.body };
  }));
}

describe('executeCrossExchangeLive (Fase 3)', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  describe('paper mode / disabled safety gate', () => {
    it('delegates to paper execution when LIVE_TRADING_ENABLED is false', async () => {
      const liveExecution = await loadModule({ liveEnabled: false });
      const opp = { id: 'x1', buyExchange: 'binance', sellExchange: 'bybit' };
      const result = await liveExecution.executeCrossExchangeLive(opp, 'u1', 0.01);
      expect(result).toMatchObject({ ok: true, mode: 'paper', simulated: true });
      expect(result.tradeId).toMatch(/^xlive-/);
    });

    it('never calls fetch in paper mode', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const liveExecution = await loadModule({ liveEnabled: false });
      await liveExecution.executeCrossExchangeLive(
        { id: 'x1', buyExchange: 'binance', sellExchange: 'bybit' }, 'u1', 0.01,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('input validation (live mode)', () => {
    it('rejects when sellExchange is missing', async () => {
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      await expect(liveExecution.executeCrossExchangeLive({ id: 'x1', buyExchange: 'binance' }, 'u1', 0.01))
        .rejects.toThrow(/buyExchange and opportunity.sellExchange are both required/);
    });

    it('rejects when buyExchange === sellExchange', async () => {
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      await expect(liveExecution.executeCrossExchangeLive(
        { id: 'x1', buyExchange: 'binance', sellExchange: 'binance' }, 'u1', 0.01,
      )).rejects.toThrow(/must differ/);
    });

    it('rejects a truly unsupported exchange pair before touching any client', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      await expect(liveExecution.executeCrossExchangeLive(
        { id: 'x1', buyExchange: 'binance', sellExchange: 'kucoin' }, 'u1', 0.01,
      )).rejects.toThrow(/not fully supported/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    // coinbase is now a supported live-execution exchange (audit item #3,
    // closes the 3-of-5 gap) — this pair now fails on missing credentials
    // instead of being rejected outright. Full OKX/Coinbase client coverage
    // lives in tests/liveExecutionOkxCoinbase.test.js.
    it('accepts binance/coinbase as a pair, failing later on missing credentials rather than "not supported"', async () => {
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      process.env.BINANCE_API_KEY = 'k';
      process.env.BINANCE_API_SECRET = 's';
      delete process.env.COINBASE_API_KEY;
      delete process.env.COINBASE_API_SECRET;
      await expect(liveExecution.executeCrossExchangeLive(
        { id: 'x1', buyExchange: 'binance', sellExchange: 'coinbase' }, 'u1', 0.01,
      )).rejects.toThrow(/COINBASE_API_KEY and COINBASE_API_SECRET must be set/);
    });

    it('rejects when the sell-exchange API credentials are missing', async () => {
      process.env.BINANCE_API_KEY = 'k';
      process.env.BINANCE_API_SECRET = 's';
      delete process.env.BYBIT_API_KEY;
      delete process.env.BYBIT_API_SECRET;
      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      await expect(liveExecution.executeCrossExchangeLive(
        { id: 'x1', buyExchange: 'binance', sellExchange: 'bybit' }, 'u1', 0.01,
      )).rejects.toThrow(/BYBIT_API_KEY and BYBIT_API_SECRET must be set/);
    });
  });

  describe('full dual-leg execution (mocked Binance buy-leg + Bybit sell-leg)', () => {
    function setKeys() {
      process.env.BINANCE_API_KEY = 'bk';
      process.env.BINANCE_API_SECRET = 'bs';
      process.env.BYBIT_API_KEY = 'yk';
      process.env.BYBIT_API_SECRET = 'ys';
    }

    it('executes both legs and returns gross profit when both fill', async () => {
      setKeys();
      mockFetchByHost({
        'api.binance.com': [
          { body: { canTrade: true } },                                          // preflight: account
          { body: { balances: [{ asset: 'USDT', free: '999999' }] } },           // preflight: balance
          { body: { orderId: 111 } },                                            // placeMarketOrder (buy)
          { body: { status: 'FILLED', cummulativeQuoteQty: '500', executedQty: '0.01' } }, // getOrder (buy)
        ],
        'api.bybit.com': [
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } }, // preflight: account
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } }, // preflight: balance
          { body: { retCode: 0, result: { orderId: '222' } } },                  // placeMarketOrder (sell)
          { body: { retCode: 0, result: { list: [{ orderStatus: 'Filled', cumExecQty: '0.01', avgPrice: '50100' }] } } }, // getOrder (sell)
        ],
      });

      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      const opp = { id: 'x1', buyExchange: 'binance', sellExchange: 'bybit', pair: 'BTC/USDT', detectedAt: Date.now() };
      const result = await liveExecution.executeCrossExchangeLive(opp, 'u1', 0.01);

      expect(result.ok).toBe(true);
      expect(result.mode).toBe('live');
      expect(result.buyExchange).toBe('binance');
      expect(result.sellExchange).toBe('bybit');
      expect(result.buyFillPrice).toBeCloseTo(50000, 0);
      expect(result.sellFillPrice).toBeCloseTo(50100, 0);
      expect(result.fillQty).toBeCloseTo(0.01, 5);
      expect(result.grossProfit).toBeCloseTo(1.0, 2);

      const log = liveExecution.getAuditLog();
      expect(log.some(e => e.event === 'CROSS_EXECUTE_SUCCESS')).toBe(true);
      expect(log.some(e => e.event === 'LEG_BUY_CONFIRMED')).toBe(true);
      expect(log.some(e => e.event === 'LEG_SELL_CONFIRMED')).toBe(true);
    });

    // AUDIT FINDING 3b wiring test: a successful cross-exchange trade's
    // grossProfit must reach the real-fills P&L ledger the live risk gate
    // reads from (see tests/liveExecution.test.js for the ledger's own
    // unit tests and the risk-gate-blocking regression test).
    it('records grossProfit into the live P&L ledger on a clean cross-exchange success (Hallazgo 3b fix)', async () => {
      setKeys();
      mockFetchByHost({
        'api.binance.com': [
          { body: { canTrade: true } },
          { body: { balances: [{ asset: 'USDT', free: '999999' }] } },
          { body: { orderId: 111 } },
          { body: { status: 'FILLED', cummulativeQuoteQty: '500', executedQty: '0.01' } },
        ],
        'api.bybit.com': [
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } },
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } },
          { body: { retCode: 0, result: { orderId: '222' } } },
          { body: { retCode: 0, result: { list: [{ orderStatus: 'Filled', cumExecQty: '0.01', avgPrice: '50100' }] } } },
        ],
      });

      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u-ledger-x', 'live');
      const opp = { id: 'x1-ledger', buyExchange: 'binance', sellExchange: 'bybit', pair: 'BTC/USDT', detectedAt: Date.now() };
      liveExecution._liveTradeLedger._resetForTest(); // see tests/liveExecution.test.js wiring test for rationale
      expect(liveExecution._liveTradeLedger.getTodaysLivePnl()).toBe(0);
      const result = await liveExecution.executeCrossExchangeLive(opp, 'u-ledger-x', 0.01);
      expect(result.ok).toBe(true);
      expect(liveExecution._liveTradeLedger.getTodaysLivePnl()).toBeCloseTo(result.grossProfit, 8);
    });

    // Robustez (refinamiento post-Sesión 34): el mismo gate institucional
    // ahora también protege la ruta cross-exchange, con el mismo soporte de
    // perfil de riesgo por usuario.
    it('blocks the trade when a per-user maxPositionValueUSD override is stricter, before placing either leg', async () => {
      setKeys();
      mockFetchByHost({
        'api.binance.com': [
          { body: { canTrade: true } },
          { body: { balances: [{ asset: 'USDT', free: '999999' }] } },
        ],
        'api.bybit.com': [
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } },
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } },
        ],
      });

      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('cross-risk-user-1', 'live');

      const userRiskProfileService = require('../server/domain/risk/userRiskProfileService');
      userRiskProfileService.setUserRiskProfile('cross-risk-user-1', { maxPositionValueUSD: 400 });

      const opp = { id: 'x1', buyExchange: 'binance', sellExchange: 'bybit', pair: 'BTC/USDT', buyPrice: 50000, detectedAt: Date.now() };
      await expect(liveExecution.executeCrossExchangeLive(opp, 'cross-risk-user-1', 0.01))
        .rejects.toThrow(/Risk check failed: position_size/);
    });

    it('blocks the trade when the user restricted activeExchanges away from one of the two legs', async () => {
      setKeys();
      mockFetchByHost({
        'api.binance.com': [
          { body: { canTrade: true } },
          { body: { balances: [{ asset: 'USDT', free: '999999' }] } },
        ],
        'api.bybit.com': [
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } },
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } },
        ],
      });

      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('cross-risk-user-2', 'live');

      const userRiskProfileService = require('../server/domain/risk/userRiskProfileService');
      userRiskProfileService.setUserRiskProfile('cross-risk-user-2', { activeExchanges: ['Binance'] }); // missing Bybit

      const opp = { id: 'x1', buyExchange: 'binance', sellExchange: 'bybit', pair: 'BTC/USDT', detectedAt: Date.now() };
      await expect(liveExecution.executeCrossExchangeLive(opp, 'cross-risk-user-2', 0.01))
        .rejects.toThrow(/bybit not allowed/);
    });

    it('flattens the buy leg (CLOSE_NOW) when the sell leg fails to fill, and throws a partial error', async () => {
      setKeys();
      mockFetchByHost({
        'api.binance.com': [
          { body: { canTrade: true } },
          { body: { balances: [{ asset: 'USDT', free: '999999' }] } },
          { body: { balances: [{ asset: 'USDT', free: '999999' }] } }, // risk gate: real capital USDT (buy exchange, Hallazgo 3 fix)
          { body: { balances: [{ asset: 'BTC', free: '5' }] } },       // risk gate: real capital BTC (buy exchange, Hallazgo 3 fix)
          { body: { orderId: 111 } },                                             // placeMarketOrder (buy)
          { body: { status: 'FILLED', cummulativeQuoteQty: '500', executedQty: '0.01' } }, // getOrder (buy) -> filled
          { body: {} },                                                           // cancelOrder n/a, but emergency SELL placeMarketOrder next
          { body: { orderId: 333 } },                                             // emergency flatten placeMarketOrder (SELL on binance)
        ],
        'api.bybit.com': [
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } },
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } },
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } }, // risk gate: real capital (sell exchange, Hallazgo 3 fix)
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } }, // risk gate: real capital (sell exchange, Hallazgo 3 fix)
          { body: { retCode: 0, result: { orderId: '222' } } },                  // placeMarketOrder (sell)
          { body: { retCode: 0, result: { list: [{ orderStatus: 'New', cumExecQty: '0', avgPrice: '0' }] } } }, // getOrder -> not filled
          { body: { retCode: 0, result: {} } },                                  // cancelOrder (sell, unfilled)
        ],
      });

      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      const opp = { id: 'x2', buyExchange: 'binance', sellExchange: 'bybit', pair: 'BTC/USDT', detectedAt: Date.now() };

      let caught;
      try {
        await liveExecution.executeCrossExchangeLive(opp, 'u1', 0.01);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect(caught.partial).toBe(true);
      expect(caught.recovery.ok).toBe(true);
      expect(caught.message).toMatch(/flattened successfully/);

      const log = liveExecution.getAuditLog();
      expect(log.some(e => e.event === 'INCOMPLETE_LEG_DETECTED' && e.openLeg === 'buy')).toBe(true);
      expect(log.some(e => e.event === 'CLOSE_NOW_SENT')).toBe(true);
      expect(log.some(e => e.event === 'CROSS_PARTIAL_RECOVERED')).toBe(true);
    });

    it('throws a plain (non-partial) error when neither leg fills', async () => {
      setKeys();
      mockFetchByHost({
        'api.binance.com': [
          { body: { canTrade: true } },
          { body: { balances: [{ asset: 'USDT', free: '999999' }] } },
          { body: { orderId: 111 } },
          { body: { status: 'NEW', cummulativeQuoteQty: '0', executedQty: '0' } }, // not filled
          { body: {} }, // cancelOrder
        ],
        'api.bybit.com': [
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } },
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } },
          { body: { retCode: 0, result: { orderId: '222' } } },
          { body: { retCode: 0, result: { list: [{ orderStatus: 'New', cumExecQty: '0', avgPrice: '0' }] } } }, // not filled
          { body: { retCode: 0, result: {} } }, // cancelOrder
        ],
      });

      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      const opp = { id: 'x3', buyExchange: 'binance', sellExchange: 'bybit', pair: 'BTC/USDT', detectedAt: Date.now() };

      let caught;
      try {
        await liveExecution.executeCrossExchangeLive(opp, 'u1', 0.01);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect(caught.partial).toBeUndefined();
      expect(caught.message).toMatch(/failed on both legs/);

      const log = liveExecution.getAuditLog();
      expect(log.some(e => e.event === 'CROSS_EXECUTE_FAILED')).toBe(true);
      expect(log.some(e => e.event === 'CLOSE_NOW_SENT')).toBe(false);
    });

    it('blocks the trade when the sell-side has insufficient base-asset inventory', async () => {
      setKeys();
      mockFetchByHost({
        'api.binance.com': [
          { body: { canTrade: true } },
          { body: { balances: [{ asset: 'USDT', free: '999999' }] } },
        ],
        'api.bybit.com': [
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '0.0001' }] }] } } }, // account
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '0.0001' }] }] } } }, // balance too low
        ],
      });

      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      const opp = { id: 'x4', buyExchange: 'binance', sellExchange: 'bybit', pair: 'BTC/USDT', detectedAt: Date.now() };

      await expect(liveExecution.executeCrossExchangeLive(opp, 'u1', 0.01))
        .rejects.toThrow(/Insufficient BTC balance on sell exchange/);
    });
  });

  describe('3-tier partial fill system (Fase 1 committee answer, genuine partial fills)', () => {
    function setKeys() {
      process.env.BINANCE_API_KEY = 'bk';
      process.env.BINANCE_API_SECRET = 'bs';
      process.env.BYBIT_API_KEY = 'yk';
      process.env.BYBIT_API_SECRET = 'ys';
    }

    it('tier "low": flattens only the unmatched residual, not the full buy quantity, when the sell leg partially fills below 50%', async () => {
      setKeys();
      mockFetchByHost({
        'api.binance.com': [
          { body: { canTrade: true } },
          { body: { balances: [{ asset: 'USDT', free: '999999' }] } },
          { body: { balances: [{ asset: 'USDT', free: '999999' }] } }, // risk gate: real capital USDT (buy exchange, Hallazgo 3 fix)
          { body: { balances: [{ asset: 'BTC', free: '5' }] } },       // risk gate: real capital BTC (buy exchange, Hallazgo 3 fix)
          { body: { orderId: 111 } },                                                       // buy placeMarketOrder
          { body: { status: 'FILLED', cummulativeQuoteQty: '500', executedQty: '0.01' } },   // buy getOrder -> fully filled
          { body: { orderId: 333 } },                                                        // emergency flatten SELL on binance
        ],
        'api.bybit.com': [
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } }, // account
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } }, // balance
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } }, // risk gate: real capital (sell exchange, Hallazgo 3 fix)
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } }, // risk gate: real capital (sell exchange, Hallazgo 3 fix)
          { body: { retCode: 0, result: { orderId: '222' } } },                              // sell placeMarketOrder
          // Genuine partial fill: 0.002 of the requested 0.01 (20%) — below
          // minimumFillRatio (0.50), so this is tier 'low'.
          { body: { retCode: 0, result: { list: [{ orderStatus: 'PartiallyFilled', cumExecQty: '0.002', avgPrice: '50050' }] } } },
          { body: { retCode: 0, result: {} } },                                              // cancelOrder (residual on sell)
        ],
      });

      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      const opp = { id: 'x5', buyExchange: 'binance', sellExchange: 'bybit', pair: 'BTC/USDT', detectedAt: Date.now() };

      let caught;
      try {
        await liveExecution.executeCrossExchangeLive(opp, 'u1', 0.01);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect(caught.partial).toBe(true);
      expect(caught.tier).toBe('low');

      const log = liveExecution.getAuditLog();
      const detected = log.find(e => e.event === 'INCOMPLETE_LEG_DETECTED');
      expect(detected).toBeDefined();
      expect(detected.tier).toBe('low');
      // The critical correctness assertion: only the unmatched residual
      // (0.01 - 0.002 = 0.008) is flattened — NOT the full 0.01 bought.
      // Flattening the full amount would double-count the 0.002 the sell
      // leg already sold, silently over-hedging by that quantity.
      expect(detected.qty).toBeCloseTo(0.008, 8);

      const closeSent = log.find(e => e.event === 'CLOSE_NOW_SENT');
      expect(closeSent).toBeDefined();
      expect(closeSent.qty).toBeCloseTo(0.008, 8);
    });

    it('tier "mid": attempts to complete the residual with an immediate market order before falling back to flattening', async () => {
      setKeys();
      mockFetchByHost({
        'api.binance.com': [
          { body: { canTrade: true } },
          { body: { balances: [{ asset: 'USDT', free: '999999' }] } },
          { body: { balances: [{ asset: 'USDT', free: '999999' }] } }, // risk gate: real capital USDT (buy exchange, Hallazgo 3 fix)
          { body: { balances: [{ asset: 'BTC', free: '5' }] } },       // risk gate: real capital BTC (buy exchange, Hallazgo 3 fix)
          { body: { orderId: 111 } },                                                       // buy placeMarketOrder
          { body: { status: 'FILLED', cummulativeQuoteQty: '500', executedQty: '0.01' } },   // buy getOrder -> fully filled
        ],
        'api.bybit.com': [
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } }, // account
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } }, // balance
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } }, // risk gate: real capital (sell exchange, Hallazgo 3 fix)
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } }, // risk gate: real capital (sell exchange, Hallazgo 3 fix)
          { body: { retCode: 0, result: { orderId: '222' } } },                              // sell placeMarketOrder
          // Genuine partial fill: 0.0065 of 0.01 (65%) — between minimumFillRatio
          // (0.50) and highFillRatioThreshold (0.80) => tier 'mid'.
          { body: { retCode: 0, result: { list: [{ orderStatus: 'PartiallyFilled', cumExecQty: '0.0065', avgPrice: '50050' }] } } },
          { body: { retCode: 0, result: {} } },                                              // cancelOrder (residual on original sell order)
          { body: { retCode: 0, result: { orderId: '444' } } },                              // SELL_RESIDUAL placeMarketOrder (0.0035)
          { body: { retCode: 0, result: { list: [{ orderStatus: 'Filled', cumExecQty: '0.0035', avgPrice: '50040' }] } } }, // SELL_RESIDUAL getOrder -> filled
        ],
      });

      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      const opp = { id: 'x6', buyExchange: 'binance', sellExchange: 'bybit', pair: 'BTC/USDT', detectedAt: Date.now() };

      const result = await liveExecution.executeCrossExchangeLive(opp, 'u1', 0.01);

      expect(result.ok).toBe(true);
      expect(result.partialTier).toBe('mid');
      expect(result.residualCompleted).toBe(true);
      expect(result.fillQty).toBeCloseTo(0.01, 8);

      const log = liveExecution.getAuditLog();
      expect(log.some(e => e.event === 'CROSS_RESIDUAL_COMPLETED')).toBe(true);
      expect(log.some(e => e.event === 'INCOMPLETE_LEG_DETECTED')).toBe(false); // never fell back to flatten
    });

    it('routes through the Smart Order Router: ioc_protected policy sends a protected LIMIT/IOC order, not a plain market order', async () => {
      setKeys();
      const liveConfigModule = require('../server/infrastructure/liveConfig.js');
      liveConfigModule.setMany({ orderExecutionPolicy: 'ioc_protected', maxSlippagePct: 0.5 }, 'test');

      mockFetchByHost({
        'api.binance.com': [
          { body: { canTrade: true } },
          { body: { balances: [{ asset: 'USDT', free: '999999' }] } },
          { body: { orderId: 111 } },                                                       // buy LIMIT/IOC placeOrder
          { body: { status: 'FILLED', cummulativeQuoteQty: '500', executedQty: '0.01' } },
        ],
        'api.bybit.com': [
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } },
          { body: { retCode: 0, result: { list: [{ coin: [{ coin: 'BTC', walletBalance: '5' }] }] } } },
          { body: { retCode: 0, result: { orderId: '222' } } },                              // sell LIMIT/IOC placeOrder
          { body: { retCode: 0, result: { list: [{ orderStatus: 'Filled', cumExecQty: '0.01', avgPrice: '50100' }] } } },
        ],
      });

      const liveExecution = await loadModule({ liveEnabled: true });
      liveExecution.setUserMode('u1', 'live');
      const opp = { id: 'x7', buyExchange: 'binance', sellExchange: 'bybit', pair: 'BTC/USDT', buyPrice: 50000, sellPrice: 50100, detectedAt: Date.now() };
      const result = await liveExecution.executeCrossExchangeLive(opp, 'u1', 0.01);

      expect(result.ok).toBe(true);

      const log = liveExecution.getAuditLog();
      const buySent = log.find(e => e.event === 'LEG_BUY_SENT');
      const sellSent = log.find(e => e.event === 'LEG_SELL_SENT');
      expect(buySent.orderType).toBe('LIMIT_IOC');
      expect(buySent.limitPrice).toBeCloseTo(50000 * 1.005, 2); // BUY protected upward
      expect(sellSent.orderType).toBe('LIMIT_IOC');
      expect(sellSent.limitPrice).toBeCloseTo(50100 * 0.995, 2); // SELL protected downward

      liveConfigModule.reset('test');
    });
  });
});

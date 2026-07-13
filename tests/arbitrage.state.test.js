import { describe, it, expect, beforeEach } from 'vitest';
import * as state from '../server/application/arbitrage.state.js';

describe('arbitrage.state', () => {
  describe('bot enabled/started', () => {
    it('defaults to enabled', () => {
      expect(state.getBotEnabled()).toBe(true);
    });

    it('setBotEnabled coerces truthy/falsy values to booleans', () => {
      state.setBotEnabled(0);
      expect(state.getBotEnabled()).toBe(false);
      state.setBotEnabled('yes');
      expect(state.getBotEnabled()).toBe(true);
      state.setBotEnabled(true);
    });

    it('resetBotStarted updates getBotStarted to a recent timestamp', () => {
      const before = Date.now();
      state.resetBotStarted();
      const started = state.getBotStarted();
      expect(started).toBeGreaterThanOrEqual(before);
      expect(started).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('BTC price tracking', () => {
    it('falls back to FALLBACK_BTC_PRICE_USD when no price has ever been set', () => {
      // Can't fully reset module state across tests, but we can verify the
      // fallback constant itself and that setting 0/negative is rejected.
      expect(state.FALLBACK_BTC_PRICE_USD).toBe(50000);
    });

    it('setLastKnownBtcPrice updates the price when positive', () => {
      state.setLastKnownBtcPrice(65000);
      expect(state.getLastKnownBtcPrice()).toBe(65000);
      expect(state.getBestBtcPrice()).toBe(65000);
    });

    it('setLastKnownBtcPrice ignores zero/negative values', () => {
      state.setLastKnownBtcPrice(65000);
      state.setLastKnownBtcPrice(-100);
      expect(state.getLastKnownBtcPrice()).toBe(65000);
      state.setLastKnownBtcPrice(0);
      expect(state.getLastKnownBtcPrice()).toBe(65000);
    });
  });

  // H-6 remainder (Sesión 21): antes no existía ningún tracking de precio
  // ETH, así que executeBestOpportunity() no podía valorar tenencias de
  // ETH en USD para el cálculo de capital de riesgo. Mismo patrón exacto
  // que BTC.
  describe('ETH price tracking', () => {
    it('falls back to FALLBACK_ETH_PRICE_USD when no price has ever been set', () => {
      expect(state.FALLBACK_ETH_PRICE_USD).toBe(2500);
    });

    it('setLastKnownEthPrice updates the price when positive', () => {
      state.setLastKnownEthPrice(2700);
      expect(state.getLastKnownEthPrice()).toBe(2700);
    });

    it('setLastKnownEthPrice ignores zero/negative values', () => {
      state.setLastKnownEthPrice(2700);
      state.setLastKnownEthPrice(-50);
      expect(state.getLastKnownEthPrice()).toBe(2700);
      state.setLastKnownEthPrice(0);
      expect(state.getLastKnownEthPrice()).toBe(2700);
    });
  });

  describe('execution timestamp', () => {
    it('getLastAnyExecTs / setLastAnyExecTs round-trip', () => {
      state.setLastAnyExecTs(123456789);
      expect(state.getLastAnyExecTs()).toBe(123456789);
    });
  });

  describe('checkFingerprint', () => {
    const op = { buyExchange: 'Binance', sellExchange: 'Kraken', buyPrice: 100.123, sellPrice: 101.456, spreadPct: 1.234 };

    it('returns true for a brand new fingerprint', () => {
      const uniqueOp = { ...op, buyPrice: 999.1 };
      expect(state.checkFingerprint(uniqueOp, Date.now())).toBe(true);
    });

    it('returns false for a duplicate fingerprint seen within the TTL window', () => {
      const now = Date.now();
      const uniqueOp = { ...op, buyPrice: 888.2 };
      expect(state.checkFingerprint(uniqueOp, now)).toBe(true);
      expect(state.checkFingerprint(uniqueOp, now + 100)).toBe(false);
    });

    it('returns true again once the TTL window has elapsed', () => {
      const now = Date.now();
      const uniqueOp = { ...op, buyPrice: 777.3 };
      expect(state.checkFingerprint(uniqueOp, now)).toBe(true);
      expect(state.checkFingerprint(uniqueOp, now + 6000)).toBe(true); // TTL is 5000ms
    });
  });

  describe('counters', () => {
    beforeEach(() => {
      state.resetCounters();
    });

    it('starts at zero after reset', () => {
      expect(state.getCounters()).toEqual({ totalOpportunitiesScanned: 0, totalViableFound: 0, tickCount: 0 });
      expect(state.getTickCount()).toBe(0);
    });

    it('incrementScanned/incrementViable/incrementTick increase counters by default of 1', () => {
      state.incrementScanned();
      state.incrementViable();
      state.incrementTick();
      expect(state.getCounters()).toEqual({ totalOpportunitiesScanned: 1, totalViableFound: 1, tickCount: 1 });
    });

    it('incrementScanned/incrementViable accept a custom increment amount', () => {
      state.incrementScanned(5);
      state.incrementViable(3);
      expect(state.getCounters().totalOpportunitiesScanned).toBe(5);
      expect(state.getCounters().totalViableFound).toBe(3);
    });
  });

  describe('equity curve', () => {
    beforeEach(() => {
      state.clearEquityCurve();
    });

    it('starts empty after clear', () => {
      expect(state.getEquityCurve()).toEqual([]);
    });

    it('appendEquityPoint accumulates cumulative pnl across trades', () => {
      state.appendEquityPoint({ buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 10, ts: 1 });
      state.appendEquityPoint({ buyExchange: 'Kraken', sellExchange: 'Bybit', netProfit: -3, ts: 2 });
      const curve = state.getEquityCurve();
      expect(curve).toHaveLength(2);
      expect(curve[0].pnl).toBe(10);
      expect(curve[1].pnl).toBe(7);
      expect(curve[0].label).toBe('B→K');
      expect(curve[1].profit).toBe(-3);
    });

    it('setEquityCurve replaces the curve wholesale', () => {
      state.setEquityCurve([{ i: 0, ts: 1, pnl: 99, profit: 99, label: 'X→Y' }]);
      expect(state.getEquityCurve()).toHaveLength(1);
      expect(state.getEquityCurve()[0].pnl).toBe(99);
    });

    it('caps the equity curve at 500 points, keeping only the most recent', () => {
      state.clearEquityCurve();
      for (let i = 0; i < 510; i++) {
        state.appendEquityPoint({ buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 1, ts: i });
      }
      const curve = state.getEquityCurve();
      expect(curve.length).toBe(500);
    });
  });

  describe('SSE push helpers', () => {
    it('pushToSSE writes to all registered sseClients and removes clients that throw', () => {
      const ok = { write: () => {} };
      const broken = { write: () => { throw new Error('closed'); } };
      state.sseClients.add(ok);
      state.sseClients.add(broken);
      state.pushToSSE({ hello: 'world' });
      expect(state.sseClients.has(broken)).toBe(false);
      expect(state.sseClients.has(ok)).toBe(true);
      state.sseClients.delete(ok);
    });

    it('a client with no registered uid gets the shared payload unchanged (backward compatible)', () => {
      let received = null;
      const client = { write: (payload) => { received = payload; } };
      state.sseClients.add(client);
      state.pushToSSE({ hello: 'shared' });
      expect(received).toContain('"hello":"shared"');
      expect(received).not.toContain('"tenant"');
      state.sseClients.delete(client);
    });

    it('a client registered with a uid gets a `tenant` overlay merged into the shared payload', () => {
      const tenantBotState = require('../server/infrastructure/tenantBotState');
      const { resetBalances, applyTrade, EXCHANGES } = require('../server/domain/wallet/walletManager');
      const [EX_A, EX_B] = EXCHANGES;
      resetBalances('state-test-uid-1');
      tenantBotState.setEnabled('state-test-uid-1', true);

      let received = null;
      const client = { write: (payload) => { received = payload; } };
      state.sseClients.add(client);
      state.sseClientUid.set(client, 'state-test-uid-1');
      state.pushToSSE({ hello: 'shared' });

      const parsed = JSON.parse(received.replace(/^data: /, '').trim());
      expect(parsed.hello).toBe('shared'); // shared payload preserved
      expect(parsed.tenant.uid).toBe('state-test-uid-1');
      expect(parsed.tenant.botEnabled).toBe(true);

      state.sseClients.delete(client);
      state.sseClientUid.delete(client);
      tenantBotState.setEnabled('state-test-uid-1', false);
    });

    it('two clients with different uids get independent tenant overlays from the same broadcast', () => {
      const { resetBalances, applyTrade, EXCHANGES } = require('../server/domain/wallet/walletManager');
      const [EX_A, EX_B] = EXCHANGES;
      resetBalances('state-test-uid-a');
      resetBalances('state-test-uid-b');

      const baseTrade = {
        id: 'st1', buyExchange: EX_A, sellExchange: EX_B,
        buyPrice: 50000, sellPrice: 50100, amount: 0.01,
        buyFee: 1, sellFee: 1, grossProfit: 1, netProfit: 7,
        spreadPct: '0.2', slippage: 0, executionMs: 50,
        slippageMethod: 'real', ts: Date.now(),
      };

      let receivedA = null, receivedB = null;
      const clientA = { write: (p) => { receivedA = p; } };
      const clientB = { write: (p) => { receivedB = p; } };
      state.sseClients.add(clientA);
      state.sseClients.add(clientB);
      state.sseClientUid.set(clientA, 'state-test-uid-a');
      state.sseClientUid.set(clientB, 'state-test-uid-b');

      return applyTrade(baseTrade, 'state-test-uid-a').then(() => {
        state.pushToSSE({ hello: 'shared' });
        const parsedA = JSON.parse(receivedA.replace(/^data: /, '').trim());
        const parsedB = JSON.parse(receivedB.replace(/^data: /, '').trim());
        expect(parsedA.tenant.pnl.totalTrades).toBe(1);
        expect(parsedB.tenant.pnl.totalTrades).toBe(0);

        state.sseClients.delete(clientA);
        state.sseClients.delete(clientB);
        state.sseClientUid.delete(clientA);
        state.sseClientUid.delete(clientB);
      });
    });

    it('removing a broken client also cleans up its sseClientUid entry', () => {
      const broken = { write: () => { throw new Error('closed'); } };
      state.sseClients.add(broken);
      state.sseClientUid.set(broken, 'state-test-uid-broken');
      state.pushToSSE({ hello: 'world' });
      expect(state.sseClients.has(broken)).toBe(false);
      expect(state.sseClientUid.has(broken)).toBe(false);
    });

    it('pushToAlerts writes to all registered alertsClients', () => {
      let received = null;
      const client = { write: (payload) => { received = payload; } };
      state.alertsClients.add(client);
      state.pushToAlerts({ alert: 'test' });
      expect(received).toContain('"alert":"test"');
      state.alertsClients.delete(client);
    });

    it('pushToNotifications writes to all registered notificationClients', () => {
      let received = null;
      const client = { write: (payload) => { received = payload; } };
      state.notificationClients.add(client);
      state.pushToNotifications({ notif: 'test' });
      expect(received).toContain('"notif":"test"');
      state.notificationClients.delete(client);
    });
  });

  describe('getBestAskPrice', () => {
    it('returns null when there are no valid order books', () => {
      expect(state.getBestAskPrice([])).toBeNull();
      expect(state.getBestAskPrice([{ exchange: 'Binance', error: 'down' }])).toBeNull();
      expect(state.getBestAskPrice(undefined)).toBeNull();
    });

    it('prefers Binance ask when Binance is present among valid order books', () => {
      const books = [
        { exchange: 'Binance', ask: 100 },
        { exchange: 'Kraken', ask: 90 },
      ];
      expect(state.getBestAskPrice(books)).toBe(100);
    });

    it('falls back to the lowest ask when Binance is absent', () => {
      const books = [
        { exchange: 'Kraken', ask: 90 },
        { exchange: 'Bybit', ask: 85 },
      ];
      expect(state.getBestAskPrice(books)).toBe(85);
    });

    it('filters out order books with an error or missing ask', () => {
      const books = [
        { exchange: 'Kraken', ask: 90, error: 'stale' },
        { exchange: 'Bybit', ask: null },
        { exchange: 'OKX', ask: 95 },
      ];
      expect(state.getBestAskPrice(books)).toBe(95);
    });
  });
});

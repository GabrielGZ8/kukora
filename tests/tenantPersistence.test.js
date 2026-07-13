'use strict';

/**
 * tenantPersistence.test.js — ADR-017, pendiente #2 (persistencia
 * por-tenant).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';

const tenantPersistence = require('../server/infrastructure/tenantPersistence');
const persistenceService = require('../server/infrastructure/persistenceService');
const tenantBotState = require('../server/infrastructure/tenantBotState');
const { resetBalances, applyTrade, EXCHANGES, getBalances, getInitialBalances } = require('../server/domain/wallet/walletManager');

function setReadyState(v) { mongoose.connection.readyState = v; }

const [EX_A, EX_B] = EXCHANGES;
function baseTrade(overrides = {}) {
  return {
    id: 't1', buyExchange: EX_A, sellExchange: EX_B,
    buyPrice: 50000, sellPrice: 50100, amount: 0.01,
    buyFee: 1, sellFee: 1, grossProfit: 1, netProfit: 0.5,
    spreadPct: '0.2', slippage: 0, executionMs: 50,
    slippageMethod: 'real', ts: Date.now(),
    ...overrides,
  };
}

describe('tenantPersistence', () => {
  afterEach(() => {
    mongoose.connection.readyState = 0;
    vi.restoreAllMocks();
    tenantPersistence.stopTenantPersistenceFlush();
  });

  describe('_buildSnapshotForTenant', () => {
    it('returns an empty-but-well-formed snapshot for a tenant with no trades', () => {
      resetBalances('tp-uid-empty');
      const snap = tenantPersistence._buildSnapshotForTenant('tp-uid-empty');
      expect(snap.equityCurve).toEqual([]);
      expect(snap.totalTrades).toBe(0);
      expect(snap.tradeLog).toEqual([]);
    });

    it('derives a cumulative equity curve from the tenant trade history', async () => {
      resetBalances('tp-uid-curve');
      await applyTrade(baseTrade({ id: 't1', netProfit: 1 }), 'tp-uid-curve');
      await applyTrade(baseTrade({ id: 't2', netProfit: 2 }), 'tp-uid-curve');
      const snap = tenantPersistence._buildSnapshotForTenant('tp-uid-curve');
      expect(snap.equityCurve.length).toBe(2);
      expect(snap.equityCurve[1].pnl).toBe(3);
      expect(snap.totalTrades).toBe(2);
    });

    it('two different tenants get independent snapshots', async () => {
      resetBalances('tp-uid-x');
      resetBalances('tp-uid-y');
      await applyTrade(baseTrade({ id: 'x1', netProfit: 5 }), 'tp-uid-x');
      const snapX = tenantPersistence._buildSnapshotForTenant('tp-uid-x');
      const snapY = tenantPersistence._buildSnapshotForTenant('tp-uid-y');
      expect(snapX.totalTrades).toBe(1);
      expect(snapY.totalTrades).toBe(0);
    });

    // Punto 7 (auditoría comité, sección 12): el snapshot por-tenant debe
    // incluir los balances reales de wallet, no solo el historial/P&L.
    it('includes the tenant\'s real wallet balances via getBalances(uid)', async () => {
      resetBalances('tp-uid-wallets');
      await applyTrade(baseTrade({ id: 'w1', netProfit: 3 }), 'tp-uid-wallets');
      const snap = tenantPersistence._buildSnapshotForTenant('tp-uid-wallets');
      expect(snap.wallets).toEqual(getBalances('tp-uid-wallets'));
    });
  });

  describe('persistActiveTenantSnapshots', () => {
    it('is a no-op (attempted: 0) when there are no active tenants', async () => {
      const result = await tenantPersistence.persistActiveTenantSnapshots();
      expect(result.attempted).toBe(0);
      expect(result.persisted).toBe(0);
    });

    it('persists a snapshot for every active tenant', async () => {
      setReadyState(1);
      resetBalances('tp-uid-good1');
      resetBalances('tp-uid-good2');
      tenantBotState.setEnabled('tp-uid-good1', true);
      tenantBotState.setEnabled('tp-uid-good2', true);

      const result = await tenantPersistence.persistActiveTenantSnapshots();
      expect(result.attempted).toBe(2);
      expect(result.persisted).toBe(2);

      tenantBotState.setEnabled('tp-uid-good1', false);
      tenantBotState.setEnabled('tp-uid-good2', false);
    });

    it('an error persisting one tenant does not prevent persisting another (isolated failures)', async () => {
      setReadyState(1);
      resetBalances('tp-uid-bad');
      resetBalances('tp-uid-good');
      tenantBotState.setEnabled('tp-uid-bad', true);
      tenantBotState.setEnabled('tp-uid-good', true);

      const spy = vi.spyOn(persistenceService, 'persistEngineSnapshot').mockImplementation(async (snap, uid) => {
        if (uid === 'tp-uid-bad') throw new Error('synthetic Mongo write failure');
        return undefined;
      });

      const result = await tenantPersistence.persistActiveTenantSnapshots();
      expect(result.attempted).toBe(2);
      expect(result.persisted).toBe(1); // solo tp-uid-good

      spy.mockRestore();
      tenantBotState.setEnabled('tp-uid-bad', false);
      tenantBotState.setEnabled('tp-uid-good', false);
    });
  });

  describe('restoreTenantSnapshot', () => {
    it('does nothing (no throw) when MongoDB is not ready', async () => {
      setReadyState(0);
      const result = await tenantPersistence.restoreTenantSnapshot('tp-uid-z');
      expect(result).toBeNull();
    });

    it('returns null when MongoDB is not ready (never throws)', async () => {
      setReadyState(0);
      await expect(tenantPersistence.restoreTenantSnapshot('tp-uid-z')).resolves.toBeNull();
    });

    it('returns null when no snapshot exists for that uid/day (DB ready)', async () => {
      setReadyState(1);
      const result = await tenantPersistence.restoreTenantSnapshot('tp-uid-never-persisted');
      expect(result).toBeNull();
    });

    // Punto 7 (auditoría comité, sección 12): restaurar wallets debe
    // aplicarlas al estado vivo del tenant vía setBalances, no solo
    // devolverlas en el objeto de retorno.
    it('applies a valid restored `wallets` blob to the tenant\'s live wallet state', async () => {
      setReadyState(1);
      resetBalances('tp-uid-restore-wallets');
      const wallets = getInitialBalances();
      wallets.BTC.Binance = 42;
      const spy = vi.spyOn(persistenceService, 'restoreEngineSnapshot').mockResolvedValueOnce({
        equityCurve: [], dailyPnl: 0, totalTrades: 0, tradeLog: [], counters: {}, wallets,
      });

      await tenantPersistence.restoreTenantSnapshot('tp-uid-restore-wallets');

      expect(getBalances('tp-uid-restore-wallets').BTC.Binance).toBe(42);
      spy.mockRestore();
    });

    it('leaves the tenant\'s wallet untouched when the restored `wallets` blob is malformed', async () => {
      setReadyState(1);
      resetBalances('tp-uid-restore-bad-wallets');
      const before = getBalances('tp-uid-restore-bad-wallets');
      const spy = vi.spyOn(persistenceService, 'restoreEngineSnapshot').mockResolvedValueOnce({
        equityCurve: [], dailyPnl: 0, totalTrades: 0, tradeLog: [], counters: {}, wallets: { BTC: {} },
      });

      await tenantPersistence.restoreTenantSnapshot('tp-uid-restore-bad-wallets');

      expect(getBalances('tp-uid-restore-bad-wallets')).toEqual(before);
      spy.mockRestore();
    });

    it('does not attempt to apply wallets when the restored snapshot has none (legacy document)', async () => {
      setReadyState(1);
      resetBalances('tp-uid-restore-no-wallets');
      const before = getBalances('tp-uid-restore-no-wallets');
      const spy = vi.spyOn(persistenceService, 'restoreEngineSnapshot').mockResolvedValueOnce({
        equityCurve: [], dailyPnl: 0, totalTrades: 0, tradeLog: [], counters: {},
      });

      await tenantPersistence.restoreTenantSnapshot('tp-uid-restore-no-wallets');

      expect(getBalances('tp-uid-restore-no-wallets')).toEqual(before);
      spy.mockRestore();
    });

    it('never throws even if the underlying restore call rejects', async () => {
      setReadyState(1);
      const spy = vi.spyOn(persistenceService, 'restoreEngineSnapshot').mockRejectedValueOnce(new Error('boom'));
      const result = await tenantPersistence.restoreTenantSnapshot('tp-uid-z');
      expect(result).toBeNull();
      spy.mockRestore();
    });
  });

  describe('startTenantPersistenceFlush / stopTenantPersistenceFlush', () => {
    it('do not throw and are idempotent to call twice', () => {
      expect(() => {
        tenantPersistence.startTenantPersistenceFlush(30_000);
        tenantPersistence.startTenantPersistenceFlush(30_000);
      }).not.toThrow();
      tenantPersistence.stopTenantPersistenceFlush();
    });
  });
});

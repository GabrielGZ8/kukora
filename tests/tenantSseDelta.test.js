'use strict';

/**
 * tenantSseDelta.test.js — ADR-017, pendiente #1 (SSE por-usuario), A1.
 * Prueba la función pura de armado de delta por-tenant, SIN ningún wiring
 * a un stream/socket real (ver cabecera de tenantSseDelta.js: ese wiring
 * queda deliberadamente para una sesión futura, sin presión de deadline).
 */

import { describe, it, expect, afterEach } from 'vitest';

const tenantSseDelta = require('../server/infrastructure/tenantSseDelta');
const tenantBotState = require('../server/infrastructure/tenantBotState');
const { resetBalances, applyTrade } = require('../server/domain/wallet/walletManager');
const { getEnabledExchangeNames } = require('../server/infrastructure/exchangeRegistry');

const [EX_A, EX_B] = getEnabledExchangeNames();

const _uidsToCleanup = new Set();
function enableTenant(uid) {
  tenantBotState.setEnabled(uid, true);
  _uidsToCleanup.add(uid);
}

describe('tenantSseDelta', () => {
  afterEach(() => {
    for (const uid of _uidsToCleanup) tenantBotState.setEnabled(uid, false);
    _uidsToCleanup.clear();
  });

  describe('buildTenantSseDelta', () => {
    it('returns botEnabled=false and empty history for a tenant that never toggled the bot', () => {
      const uid = 'sse-uid-fresh';
      resetBalances(uid);

      const delta = tenantSseDelta.buildTenantSseDelta(uid);

      expect(delta.uid).toBe(uid);
      expect(delta.botEnabled).toBe(false);
      expect(delta.history).toEqual([]);
    });

    it('reflects botEnabled=true after tenantBotState.setEnabled(uid, true)', () => {
      const uid = 'sse-uid-enabled';
      enableTenant(uid);
      resetBalances(uid);

      const delta = tenantSseDelta.buildTenantSseDelta(uid);

      expect(delta.botEnabled).toBe(true);
      expect(delta.botStatus.startedAt).toBeTruthy();
    });

    it('two different uids get independent wallet/pnl/history snapshots', async () => {
      const uidA = 'sse-uid-a';
      const uidB = 'sse-uid-b';
      resetBalances(uidA);
      resetBalances(uidB);

      await applyTrade({
        buyExchange: EX_A, sellExchange: EX_B,
        buyPrice: 50000, sellPrice: 50200, amount: 0.01,
        grossProfit: 2, netProfit: 1.5, buyFee: 0.3, sellFee: 0.2,
        slippage: 0, withdrawalFeeUSD: 0, ts: Date.now(),
      }, uidA);

      const deltaA = tenantSseDelta.buildTenantSseDelta(uidA);
      const deltaB = tenantSseDelta.buildTenantSseDelta(uidB);

      expect(deltaA.history.length).toBeGreaterThan(0);
      expect(deltaB.history.length).toBe(0);
      expect(deltaA.wallets).not.toEqual(deltaB.wallets);
    });

    it('caps history at historyLimit, most recent first (same convention as the shared /stream payload)', async () => {
      const uid = 'sse-uid-history';
      resetBalances(uid);

      for (let i = 0; i < 5; i++) {
        await applyTrade({
          buyExchange: EX_A, sellExchange: EX_B,
          buyPrice: 50000 + i, sellPrice: 50200 + i, amount: 0.001,
          grossProfit: 0.5, netProfit: 0.3, buyFee: 0.1, sellFee: 0.1,
          slippage: 0, withdrawalFeeUSD: 0, ts: Date.now() + i,
        }, uid);
      }

      const delta = tenantSseDelta.buildTenantSseDelta(uid, { historyLimit: 2 });
      expect(delta.history.length).toBe(2);
      // Más reciente primero (mismo criterio que .slice(-N).reverse() en stream.routes.js)
      expect(delta.history[0].buyPrice).toBeGreaterThan(delta.history[1].buyPrice);
    });

    it('never throws even if walletManager/tenantBotState internals misbehave for an unknown uid shape', () => {
      expect(() => tenantSseDelta.buildTenantSseDelta(undefined)).not.toThrow();
    });
  });

  describe('mergeTenantOverlay', () => {
    it('returns the SAME shared payload object, unmodified, when uid is null/undefined (backward compatibility)', () => {
      const shared = { type: 'tick', orderBooks: [], opportunities: [] };

      const resultNull = tenantSseDelta.mergeTenantOverlay(shared, null);
      const resultUndef = tenantSseDelta.mergeTenantOverlay(shared, undefined);

      expect(resultNull).toBe(shared); // misma referencia — cero copia innecesaria
      expect(resultUndef).toBe(shared);
      expect(resultNull.tenant).toBeUndefined();
    });

    it('adds a `tenant` key without mutating or reshaping the original shared payload when uid is present', () => {
      const uid = 'sse-uid-overlay';
      resetBalances(uid);
      const shared = { type: 'tick', orderBooks: [{ exchange: EX_A }], opportunities: [] };
      const sharedCopy = { ...shared };

      const result = tenantSseDelta.mergeTenantOverlay(shared, uid);

      expect(shared).toEqual(sharedCopy); // el original no fue mutado
      expect(result).not.toBe(shared);    // pero el resultado es un objeto nuevo
      expect(result.type).toBe('tick');
      expect(result.orderBooks).toBe(shared.orderBooks); // mismos datos de mercado, sin duplicar
      expect(result.tenant).toBeDefined();
      expect(result.tenant.uid).toBe(uid);
    });
  });
});

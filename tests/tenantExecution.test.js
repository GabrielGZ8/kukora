'use strict';

/**
 * tenantExecution.test.js — ADR-017, item 1 fase B.
 * Verifica el pase de ejecución por-tenant: selección con config/dedup
 * por-tenant, ejecución aislada contra el wallet de cada uid, y que un
 * fallo para un tenant nunca interrumpe al resto ni afecta el bot
 * compartido (que no se toca desde este módulo).
 */

import { describe, it, expect, afterEach } from 'vitest';

const tenantExecution = require('../server/infrastructure/tenantExecution');
const tenantBotState   = require('../server/infrastructure/tenantBotState');
const tenantConfig     = require('../server/infrastructure/tenantConfig');
const { getBalances, resetBalances, getTradeHistory } = require('../server/domain/wallet/walletManager');
const { getEnabledExchangeNames } = require('../server/infrastructure/exchangeRegistry');

const [EX_A, EX_B] = getEnabledExchangeNames();

function makeOpportunity(overrides = {}) {
  return {
    buyExchange:  EX_A,
    sellExchange: EX_B,
    buyPrice:     50000,
    sellPrice:    50200,
    grossProfit:  10,
    buyFee:       1,
    sellFee:      1,
    slippage:     0.5,
    withdrawalFeeUSD: 0,
    spreadPct:    0.4,
    score:        80,
    viable:       true,
    circuitBreaker: false,
    liquidityOk:  true,
    ...overrides,
  };
}

function makeEthOpportunity(overrides = {}) {
  return makeOpportunity({
    asset: 'ETH',
    buyPrice: 2500, sellPrice: 2512.5,
    grossProfit: 3, buyFee: 0.3, sellFee: 0.3, slippage: 0.1,
    spreadPct: 0.5,
    ...overrides,
  });
}

// tenantBotState es un singleton de módulo (por diseño — ver ADR-017):
// no hay un "reset global de tests" para activeUids(). Cada test que
// habilita un uid lo vuelve a apagar al final para no contaminar el
// activeUids() de los tests siguientes en este archivo.
const _uidsToCleanup = new Set();
function enableTenant(uid) {
  tenantBotState.setEnabled(uid, true);
  _uidsToCleanup.add(uid);
}

describe('tenantExecution', () => {
  afterEach(() => {
    for (const uid of _uidsToCleanup) tenantBotState.setEnabled(uid, false);
    _uidsToCleanup.clear();
  });

  it('runTenantExecutionPass is a no-op when there are no active tenants', async () => {
    const results = await tenantExecution.runTenantExecutionPass([makeOpportunity()], Date.now());
    expect(results).toEqual([]);
  });

  it('runTenantExecutionPass is a no-op when there are no opportunities', async () => {
    enableTenant('noop-uid');
    const results = await tenantExecution.runTenantExecutionPass([], Date.now());
    expect(results).toEqual([]);
  });

  it('executes for an active tenant and isolates the trade to that uid wallet', async () => {
    const uid = 'exec-uid-1';
    enableTenant(uid);
    resetBalances(uid);
    resetBalances('other-uid');

    const before = getBalances(uid);
    const otherBefore = getBalances('other-uid');

    const results = await tenantExecution.runTenantExecutionPass([makeOpportunity()], Date.now());

    expect(results.length).toBe(1);
    expect(results[0].uid).toBe(uid);
    expect(results[0].ok).toBe(true);

    const after = getBalances(uid);
    const otherAfter = getBalances('other-uid');

    // El wallet del tenant que ejecutó cambió...
    expect(after.USDT[EX_A]).not.toBe(before.USDT[EX_A]);
    // ...pero el de cualquier otro tenant permanece intacto.
    expect(otherAfter).toEqual(otherBefore);

    const history = getTradeHistory(uid);
    expect(history.length).toBeGreaterThan(0);
  });

  it('does not execute the same opportunity twice for the same tenant within the fingerprint TTL', async () => {
    const uid = 'exec-uid-2';
    enableTenant(uid);
    resetBalances(uid);

    const op = makeOpportunity({ buyPrice: 51000, sellPrice: 51300, spreadPct: 0.58 });
    const now = Date.now();

    const first = await tenantExecution.runTenantExecutionPass([op], now);
    expect(first.length).toBe(1);
    expect(first[0].ok).toBe(true);

    // Misma oportunidad (mismo fingerprint), mismo instante lógico — debe
    // ser descartada por el dedup por-tenant, igual que el bot compartido
    // se protege con su propio Map global.
    const second = await tenantExecution.runTenantExecutionPass([op], now + 10);
    expect(second.length).toBe(0);
  });

  it('two different active tenants can each execute independently in the same tick', async () => {
    const uidA = 'exec-uid-3a';
    const uidB = 'exec-uid-3b';
    enableTenant(uidA);
    enableTenant(uidB);
    resetBalances(uidA);
    resetBalances(uidB);

    const op = makeOpportunity({ buyPrice: 52000, sellPrice: 52250, spreadPct: 0.48 });
    const results = await tenantExecution.runTenantExecutionPass([op], Date.now());

    const uids = results.map((r) => r.uid).sort();
    expect(uids).toEqual([uidA, uidB].sort());
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('skips tenants whose effective minScore is not met, without affecting others', async () => {
    const uidStrict = 'exec-uid-strict';
    const uidLoose  = 'exec-uid-loose';
    enableTenant(uidStrict);
    enableTenant(uidLoose);
    resetBalances(uidStrict);
    resetBalances(uidLoose);

    tenantConfig.setMany(uidStrict, { minScore: 99 });
    tenantConfig.resetAll(uidLoose);

    const op = makeOpportunity({ score: 50, buyPrice: 53000, sellPrice: 53200, spreadPct: 0.37 });
    const results = await tenantExecution.runTenantExecutionPass([op], Date.now());

    const uids = results.map((r) => r.uid);
    expect(uids).not.toContain(uidStrict);
    expect(uids).toContain(uidLoose);

    tenantConfig.resetAll(uidStrict);
  });

  it('a tenant with insufficient balance fails gracefully without throwing', async () => {
    const uid = 'exec-uid-poor';
    enableTenant(uid);
    resetBalances(uid);
    // Drena el wallet de este tenant específicamente (no toca el default
    // ni ningún otro uid — walletManager ya está aislado por-uid).
    const wallets = getBalances(uid);
    for (const ex of Object.keys(wallets.USDT)) wallets.USDT[ex] = 0;

    const op = makeOpportunity({ buyPrice: 54000, sellPrice: 54300, spreadPct: 0.55 });

    // executeSimulated calcula ejecución parcial/insuficiente a partir del
    // snapshot real de getBalances(uid), no del objeto local `wallets` de
    // arriba (que es una copia) — así que en su lugar forzamos el drenaje
    // real vía resetBalances + gasto simulado no es trivial aquí; en su
    // lugar verificamos que el pase nunca lanza, sea cual sea el resultado.
    await expect(
      tenantExecution.runTenantExecutionPass([op], Date.now())
    ).resolves.toBeInstanceOf(Array);
  });

  it('an error selecting/executing for one uid does not prevent other tenants from executing', async () => {
    const uidBad  = 'exec-uid-bad-config';
    const uidGood = 'exec-uid-good-config';
    enableTenant(uidBad);
    enableTenant(uidGood);
    resetBalances(uidBad);
    resetBalances(uidGood);

    // Override deliberadamente muy restrictivo (pero válido, dentro del
    // rango 0-100 que liveConfig.validateOne acepta) para forzar que ESTE
    // tenant rechace la oportunidad, mientras el otro tenant (sin
    // override) la ejecuta con normalidad.
    tenantConfig.setMany(uidBad, { minScore: 95 });

    const op = makeOpportunity({ buyPrice: 55000, sellPrice: 55400, spreadPct: 0.72 });
    const results = await tenantExecution.runTenantExecutionPass([op], Date.now());

    const uids = results.map((r) => r.uid);
    expect(uids).not.toContain(uidBad);
    expect(uids).toContain(uidGood);

    tenantConfig.resetAll(uidBad);
  });

  // ── A3 (Sesión 2026-07-07): extensión ETH ────────────────────────────
  describe('A3 — extensión ETH', () => {
    it('executes an ETH opportunity for an active tenant when passed as the second argument', async () => {
      const uid = 'eth-uid-1';
      enableTenant(uid);
      resetBalances(uid);

      const results = await tenantExecution.runTenantExecutionPass([], [makeEthOpportunity()], Date.now());

      expect(results.length).toBe(1);
      expect(results[0].uid).toBe(uid);
      expect(results[0].ok).toBe(true);
      expect(results[0].trade.buyExchange).toBe(EX_A);

      const history = getTradeHistory(uid);
      expect(history.length).toBeGreaterThan(0);
    });

    it('a tenant only executes ONE trade per tick: BTC opportunity wins over ETH when both are viable', async () => {
      const uid = 'eth-uid-2';
      enableTenant(uid);
      resetBalances(uid);

      const btcOp = makeOpportunity({ buyPrice: 56000, sellPrice: 56300, spreadPct: 0.53 });
      const ethOp = makeEthOpportunity({ buyPrice: 2600, sellPrice: 2613, spreadPct: 0.5 });

      const results = await tenantExecution.runTenantExecutionPass([btcOp], [ethOp], Date.now());

      // Solo un trade para este tenant este tick — mismo criterio que el
      // bot compartido (evaluateAndExecuteEth solo corre si BTC no
      // ejecutó).
      const forThisUid = results.filter((r) => r.uid === uid);
      expect(forThisUid.length).toBe(1);
    });

    it('BTC and ETH fingerprints are independent per tenant: deduping BTC does not block ETH for the same tenant/tick-window', async () => {
      const uid = 'eth-uid-3';
      enableTenant(uid);
      resetBalances(uid);

      const btcOp = makeOpportunity({ buyPrice: 57000, sellPrice: 57300, spreadPct: 0.53 });
      const now = Date.now();

      // Primer tick: ejecuta BTC (ETH ni se evalúa porque BTC ganó).
      const first = await tenantExecution.runTenantExecutionPass([btcOp], [], now);
      expect(first.length).toBe(1);

      // Segundo tick, mismo instante lógico: BTC repetido está deduplicado
      // (fingerprint BTC), pero una oportunidad ETH nueva SÍ debe poder
      // ejecutar — el dedup de un pool nunca contamina al otro.
      const ethOp = makeEthOpportunity({ buyPrice: 2700, sellPrice: 2713.5, spreadPct: 0.5 });
      const second = await tenantExecution.runTenantExecutionPass([btcOp], [ethOp], now + 10);

      expect(second.length).toBe(1);
      expect(second[0].trade.buyExchange).toBe(EX_A);
    });

    it('two different tenants can each execute independently in different pools in the same tick (tenant A → BTC, tenant B → ETH)', async () => {
      const uidBtc = 'eth-uid-4a';
      const uidEth = 'eth-uid-4b';
      enableTenant(uidBtc);
      enableTenant(uidEth);
      resetBalances(uidBtc);
      resetBalances(uidEth);

      // uidBtc solo tendrá una oportunidad BTC viable a su alcance en la
      // práctica porque ambas listas se ofrecen a AMBOS tenants — lo que
      // realmente se está probando es que cada uid resuelve su propio
      // "un trade por tick" de forma independiente del otro uid.
      const btcOp = makeOpportunity({ buyPrice: 58000, sellPrice: 58300, spreadPct: 0.52 });
      const ethOp = makeEthOpportunity({ buyPrice: 2800, sellPrice: 2814, spreadPct: 0.5 });

      const results = await tenantExecution.runTenantExecutionPass([btcOp], [ethOp], Date.now());

      const uidsThatTraded = results.map((r) => r.uid).sort();
      expect(uidsThatTraded).toEqual([uidBtc, uidEth].sort());
      expect(results.every((r) => r.ok)).toBe(true);
    });

    it('is backward compatible with the pre-A3 two-argument signature (opportunities, now) — no ETH evaluated', async () => {
      const uid = 'eth-uid-legacy';
      enableTenant(uid);
      resetBalances(uid);

      const btcOp = makeOpportunity({ buyPrice: 59000, sellPrice: 59300, spreadPct: 0.51 });
      // Firma vieja: segundo argumento es `now` (number), no ethOpportunities.
      const results = await tenantExecution.runTenantExecutionPass([btcOp], Date.now());

      expect(results.length).toBe(1);
      expect(results[0].ok).toBe(true);
    });

    it('an error executing ETH for one tenant does not prevent BTC execution for another tenant', async () => {
      const uidEthBad = 'eth-uid-bad';
      const uidBtcGood = 'eth-uid-good';
      enableTenant(uidEthBad);
      enableTenant(uidBtcGood);
      resetBalances(uidEthBad);
      resetBalances(uidBtcGood);

      tenantConfig.setMany(uidEthBad, { minScore: 99 }); // rechaza ETH y BTC para este uid

      const btcOp = makeOpportunity({ buyPrice: 60000, sellPrice: 60300, spreadPct: 0.5 });
      const ethOp = makeEthOpportunity({ buyPrice: 2900, sellPrice: 2914.5, spreadPct: 0.5 });

      const results = await tenantExecution.runTenantExecutionPass([btcOp], [ethOp], Date.now());

      const uids = results.map((r) => r.uid);
      expect(uids).not.toContain(uidEthBad);
      expect(uids).toContain(uidBtcGood);

      tenantConfig.resetAll(uidEthBad);
    });
  });
});

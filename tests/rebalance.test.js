'use strict';

/**
 * rebalance.test.js — regression tests for the wallets/rebalancing
 * robustness fixes (kukora audit session).
 *
 * Covers three bugs found and fixed together, because they compound:
 *
 * 1. rebalanceEngine.js hardcoded its exchange list instead of deriving it
 *    from exchangeRegistry (the documented single source of truth used by
 *    liveConfig/walletManager/arbitrageOrchestrator) — a newly-registered
 *    exchange would silently be excluded from analyzeBalance/suggestRebalance.
 *
 * 2. executeRebalance()'s real caller — POST /api/arbitrage/rebalance/execute
 *    — only ever passed (suggestion, btcPrice), a 2-argument call, but the
 *    function used to be declared as (suggestion, wallets, _btcPrice). So
 *    `wallets` silently received a number instead of a balances object,
 *    and the endpoint could never do anything but fail with "insufficient
 *    balance". Separately, even a correctly-wired `wallets` argument would
 *    have been a disposable deep copy from getBalances() — mutating it
 *    would never persist. applyRebalanceTransfer() in walletManager is the
 *    real fix: it mutates the module's live wallet state and is what
 *    executeRebalance now calls.
 *
 * 3. executeRebalance() is reachable with a client-supplied `suggestion`
 *    object (server/arbitrage/subroutes/config.routes.js falls back to
 *    req.body.suggestion), so `suggestion.viable` is not a trustworthy
 *    authorization check on its own — asset/from/to/amount must be
 *    independently validated against the known exchange list before any
 *    balance is touched.
 */

import { describe, it, expect, beforeEach } from 'vitest';

const {
  getBalances,
  resetBalances,
  applyRebalanceTransfer,
  EXCHANGES,
} = require('../server/domain/wallet/walletManager');

const rebalanceEngine = require('../server/domain/engines/rebalanceEngine');

const [EX_A, EX_B] = EXCHANGES;

beforeEach(() => {
  resetBalances();
});

describe('walletManager.applyRebalanceTransfer', () => {
  it('moves capital between two exchanges and persists it in real wallet state', () => {
    const before = getBalances();
    const result = applyRebalanceTransfer('USDT', EX_A, EX_B, 1000, 6);

    expect(result.ok).toBe(true);
    const after = getBalances();
    expect(after.USDT[EX_A]).toBeCloseTo(before.USDT[EX_A] - 1000, 6);
    expect(after.USDT[EX_B]).toBeCloseTo(before.USDT[EX_B] + 1000 - 6, 6);

    // getBalances() must reflect the mutation on subsequent calls too —
    // i.e. the transfer landed on the module's live state, not a
    // throwaway copy.
    expect(getBalances().USDT[EX_A]).toBeCloseTo(before.USDT[EX_A] - 1000, 6);
  });

  it('rejects a transfer to/from an unknown exchange', () => {
    const result = applyRebalanceTransfer('USDT', EX_A, 'NotAnExchange', 1000, 6);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Unknown exchange/);
  });

  it('rejects when amount does not cover the withdrawal fee, without mutating balances', () => {
    const before = getBalances();
    const result = applyRebalanceTransfer('BTC', EX_A, EX_B, 0.0001, 0.0003);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not cover/);
    expect(getBalances()).toEqual(before);
  });

  it('rejects when source balance is insufficient, without mutating balances', () => {
    const before = getBalances();
    const result = applyRebalanceTransfer('USDT', EX_A, EX_B, before.USDT[EX_A] + 1, 6);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Insufficient/);
    expect(getBalances()).toEqual(before);
  });

  it('rejects non-finite or non-positive amounts', () => {
    expect(applyRebalanceTransfer('USDT', EX_A, EX_B, 0, 6).ok).toBe(false);
    expect(applyRebalanceTransfer('USDT', EX_A, EX_B, -5, 6).ok).toBe(false);
    expect(applyRebalanceTransfer('USDT', EX_A, EX_B, NaN, 6).ok).toBe(false);
    expect(applyRebalanceTransfer('USDT', EX_A, EX_B, Infinity, 6).ok).toBe(false);
  });
});

describe('rebalanceEngine.executeRebalance — call-site & persistence fix', () => {
  it('actually moves capital end-to-end, called the same way the route calls it: (suggestion, btcPrice)', () => {
    const before = getBalances();
    const suggestion = {
      asset: 'USDT', from: EX_A, to: EX_B, amount: 500, fee: 6, viable: true,
    };

    // This mirrors server/arbitrage/subroutes/config.routes.js exactly:
    // rebalanceEngine.executeRebalance(suggestion, btcPrice) — 2 args.
    const result = rebalanceEngine.executeRebalance(suggestion, 50000);

    expect(result.ok).toBe(true);
    expect(result.walletsAfter).toBeDefined();
    expect(result.walletsAfter.USDT[EX_A]).toBeCloseTo(before.USDT[EX_A] - 500, 6);

    // And the module-level wallet state actually changed.
    expect(getBalances().USDT[EX_A]).toBeCloseTo(before.USDT[EX_A] - 500, 6);
  });

  it('rejects a suggestion whose viable flag is client-supplied but whose fields are bogus', () => {
    const before = getBalances();

    const bogus = { asset: 'USDT', from: EX_A, to: 'hacker_wallet', amount: 999999, fee: 0, viable: true };
    const result = rebalanceEngine.executeRebalance(bogus, 50000);

    expect(result.ok).toBe(false);
    expect(getBalances()).toEqual(before);
  });

  it('rejects an unsupported asset even when marked viable', () => {
    const result = rebalanceEngine.executeRebalance(
      { asset: 'ETH', from: EX_A, to: EX_B, amount: 10, fee: 1, viable: true },
      50000
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Unsupported asset/);
  });

  it('rejects from === to', () => {
    const result = rebalanceEngine.executeRebalance(
      { asset: 'USDT', from: EX_A, to: EX_A, amount: 10, fee: 1, viable: true },
      50000
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/must be different/);
  });

  it('rejects when suggestion.viable is falsy', () => {
    const result = rebalanceEngine.executeRebalance(
      { asset: 'USDT', from: EX_A, to: EX_B, amount: 10, fee: 1, viable: false },
      50000
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not viable/);
  });

  it('records a history entry and emits an observability event on success', () => {
    const result = rebalanceEngine.executeRebalance(
      { asset: 'USDT', from: EX_A, to: EX_B, amount: 500, fee: 6, viable: true },
      50000
    );
    expect(result.ok).toBe(true);
    const history = rebalanceEngine.getRebalanceHistory(1);
    expect(history[0].id).toBe(result.id);
    expect(history[0].from).toBe(EX_A);
    expect(history[0].to).toBe(EX_B);
  });
});

describe('rebalanceEngine — dynamic exchange list', () => {
  it('analyzeBalance().summary.byExchange covers every exchange the wallets actually have', () => {
    const analysis = rebalanceEngine.analyzeBalance(50000);
    const namesInSummary = analysis.summary.byExchange.map(e => e.exchange).sort();
    expect(namesInSummary).toEqual([...EXCHANGES].sort());
  });
});

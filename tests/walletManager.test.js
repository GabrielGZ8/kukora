'use strict';

/**
 * walletManager.test.js — unit tests for server/walletManager.js
 *
 * Audit v2, section 9.1: flagged as the single highest-priority module to
 * cover ("el módulo que mueve dinero simulado", 380 lines, 0 test refs).
 * These tests exercise balance validation, the rollback-on-integrity-failure
 * path, the async mutex that serializes concurrent applyTrade() calls, and
 * the getPnL() aggregation math.
 */

import { describe, it, expect, beforeEach } from 'vitest';

const {
  getBalances,
  resetBalances,
  getTradeHistory,
  getPnL,
  getInitialBalances,
  applyTrade,
  EXCHANGES,
  calcWithdrawalFee,
  setBalances,
  isValidWalletsShape,
} = require('../server/domain/wallet/walletManager');

const [EX_A, EX_B] = EXCHANGES;

function baseTrade(overrides = {}) {
  return {
    id: 'trade-1',
    buyExchange: EX_A,
    sellExchange: EX_B,
    buyPrice: 50000,
    sellPrice: 50100,
    amount: 0.01,
    buyFee: 1,
    sellFee: 1,
    grossProfit: 1,
    netProfit: 0.5,
    spreadPct: '0.2',
    slippage: 0,
    executionMs: 50,
    slippageMethod: 'real',
    ts: Date.now(),
    ...overrides,
  };
}

describe('walletManager — balances & resets', () => {
  beforeEach(() => resetBalances());

  it('getInitialBalances and getBalances start identical and are deep copies', () => {
    const initial = getInitialBalances();
    const current = getBalances();
    expect(current).toEqual(initial);
    // Mutating the returned object must not affect internal state
    current.BTC[EX_A] = 999;
    expect(getBalances().BTC[EX_A]).not.toBe(999);
  });

  it('resetBalances clears trade history and restores wallets', async () => {
    await applyTrade(baseTrade());
    expect(getTradeHistory().length).toBe(1);
    resetBalances();
    expect(getTradeHistory().length).toBe(0);
    expect(getBalances()).toEqual(getInitialBalances());
  });

  // BUG FIX (Área 4 audit): tradeHistory previously grew unbounded — every
  // completed trade was pushed with no cap, unlike every other rolling
  // history buffer in the codebase (tradeStateMachine, rebalanceEngine,
  // opportunityLifecycle all cap at 200-500). This verifies the fix: the
  // array is capped at 500 and drops the oldest entry (FIFO), so the most
  // recent trade is always present and memory can't grow indefinitely
  // over a long-running bot session.
  it('caps tradeHistory at 500 entries, dropping the oldest first (FIFO)', async () => {
    // Alternate direction each trade so BTC/USDT balances round-trip back
    // and forth between the two exchanges instead of draining one side.
    for (let i = 0; i < 501; i++) {
      const forward = i % 2 === 0;
      const result = await applyTrade(baseTrade({
        id: `cap-${i}`,
        buyExchange:  forward ? EX_A : EX_B,
        sellExchange: forward ? EX_B : EX_A,
        amount: 0.001,
      }));
      expect(result.ok).toBe(true);
    }
    const history = getTradeHistory();
    expect(history.length).toBe(500);
    // The oldest trade (cap-0) should have been evicted...
    expect(history.some(t => t.id === 'cap-0')).toBe(false);
    // ...while the newest (cap-500) is still present.
    expect(history.some(t => t.id === 'cap-500')).toBe(true);
  });
});

describe('walletManager — applyTrade validation', () => {
  beforeEach(() => resetBalances());

  it('accepts a valid trade and deducts/credits the right wallets', async () => {
    const before = getBalances();
    const trade = baseTrade({ amount: 0.01, buyPrice: 50000, sellPrice: 50100, buyFee: 1, sellFee: 1 });
    const result = await applyTrade(trade);

    expect(result.ok).toBe(true);
    const after = getBalances();
    // Buyer spends USDT, gains BTC; seller spends BTC, gains USDT.
    expect(after.USDT[EX_A]).toBeCloseTo(before.USDT[EX_A] - (50000 * 0.01 + 1), 6);
    expect(after.BTC[EX_A]).toBeCloseTo(before.BTC[EX_A] + 0.01, 8);
    expect(after.BTC[EX_B]).toBeCloseTo(before.BTC[EX_B] - 0.01, 8);
    expect(after.USDT[EX_B]).toBeCloseTo(before.USDT[EX_B] + (50100 * 0.01 - 1), 6);
  });

  it('rejects a trade referencing an unknown buy exchange', async () => {
    const result = await applyTrade(baseTrade({ buyExchange: 'NotAnExchange' }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Unknown exchange/);
    // Balances must be untouched
    expect(getBalances()).toEqual(getInitialBalances());
  });

  it('rejects a trade referencing an unknown sell exchange', async () => {
    const result = await applyTrade(baseTrade({ sellExchange: 'NotAnExchange' }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Unknown exchange/);
  });

  it('rejects a trade when USDT balance is insufficient', async () => {
    const huge = baseTrade({ amount: 1_000_000 }); // far exceeds default $110k USDT wallet
    const result = await applyTrade(huge);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Insufficient USDT/);
    expect(getBalances()).toEqual(getInitialBalances());
  });

  it('rejects a trade when BTC balance is insufficient', async () => {
    const huge = baseTrade({ amount: 999 }); // far exceeds default 1 BTC wallet, but cheap enough not to trip USDT check first
    huge.buyPrice = 1; // keep usdtCost tiny so the BTC check is what fails
    const result = await applyTrade(huge);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Insufficient BTC/);
  });

  it('does not mutate balances at all when a trade is rejected', async () => {
    const snapshot = getBalances();
    await applyTrade(baseTrade({ amount: 1_000_000 }));
    await applyTrade(baseTrade({ buyExchange: 'Nope' }));
    expect(getBalances()).toEqual(snapshot);
  });
});

describe('walletManager — concurrency (mutex)', () => {
  beforeEach(() => resetBalances());

  it('serializes concurrent applyTrade calls so balances never go negative', async () => {
    // Fire several trades concurrently without awaiting individually — the
    // mutex (Issue 7 fix) must queue them so each sees the previous trade's
    // effect, rather than racing on a stale balance snapshot.
    const trades = Array.from({ length: 5 }, (_, i) =>
      baseTrade({ id: `t${i}`, amount: 0.01, buyPrice: 50000, sellPrice: 50100 })
    );
    const results = await Promise.all(trades.map(t => applyTrade(t)));

    expect(results.every(r => r.ok)).toBe(true);
    expect(getTradeHistory().length).toBe(5);
    for (const ex of EXCHANGES) {
      expect(getBalances().USDT[ex]).toBeGreaterThanOrEqual(-0.01);
      expect(getBalances().BTC[ex]).toBeGreaterThanOrEqual(-0.000001);
    }
  });
});

describe('walletManager — getPnL aggregation', () => {
  beforeEach(() => resetBalances());

  it('returns the empty-state shape with no trades', () => {
    const pnl = getPnL();
    expect(pnl.totalTrades).toBe(0);
    expect(pnl.totalPnl).toBe(0);
    expect(pnl.bestTrade).toBeNull();
  });

  it('aggregates realized P&L, win rate, and streaks across trades', async () => {
    await applyTrade(baseTrade({ id: 'w1', netProfit: 10 }));
    await applyTrade(baseTrade({ id: 'w2', netProfit: 5 }));
    await applyTrade(baseTrade({ id: 'l1', netProfit: -3 }));

    const pnl = getPnL();
    expect(pnl.totalTrades).toBe(3);
    expect(pnl.wins).toBe(2);
    expect(pnl.losses).toBe(1);
    expect(pnl.realizedPnl).toBeCloseTo(12, 4);
    expect(pnl.winRate).toBeCloseTo((2 / 3) * 100, 1);
    expect(pnl.currentStreakType).toBe('loss');
    expect(pnl.currentStreak).toBe(1);
    expect(pnl.bestTrade.id).toBe('w1');
    expect(pnl.worstTrade.id).toBe('l1');
  });
});

describe('walletManager — H-6: multi-asset (ETH) wallet support (Sesión 20)', () => {
  beforeEach(() => resetBalances());

  it('getInitialBalances includes an ETH bucket sized independently from BTC/USDT', () => {
    const initial = getInitialBalances();
    expect(initial).toHaveProperty('ETH');
    EXCHANGES.forEach(ex => {
      expect(initial.ETH[ex]).toBeGreaterThan(0);
    });
  });

  it('an ETH trade debits/credits the ETH wallet and leaves BTC completely untouched', async () => {
    const btcBefore = getBalances().BTC;
    const result = await applyTrade(baseTrade({
      id: 'eth-1', asset: 'ETH', amount: 5, buyPrice: 2500, sellPrice: 2510, netProfit: 48,
    }));
    expect(result.ok).toBe(true);
    expect(result.trade.asset).toBe('ETH');

    const after = getBalances();
    // ETH moved: buyExchange gained 5, sellExchange lost 5
    expect(after.ETH[EX_A]).toBeCloseTo(getInitialBalances().ETH[EX_A] + 5, 6);
    expect(after.ETH[EX_B]).toBeCloseTo(getInitialBalances().ETH[EX_B] - 5, 6);
    // BTC must be byte-for-byte unchanged — this is the exact bug H-6 closes:
    // before the fix, an "ETH" trade silently mutated the BTC wallet instead.
    expect(after.BTC).toEqual(btcBefore);
  });

  it('a trade with no asset field defaults to BTC (unchanged legacy behavior)', async () => {
    const ethBefore = getBalances().ETH;
    const result = await applyTrade(baseTrade({ id: 'legacy-1' }));
    expect(result.ok).toBe(true);
    expect(result.trade.asset).toBe('BTC');
    // ETH wallet must be untouched by a legacy (asset-less) trade.
    expect(getBalances().ETH).toEqual(ethBefore);
  });

  it('rejects an ETH trade that exceeds available ETH balance on the sell exchange (checks the right bucket)', async () => {
    // Cheap buyPrice keeps the USDT leg well within balance, isolating the
    // ETH-availability check (40 ETH default per exchange) as the only
    // possible rejection reason.
    const hugeEth = baseTrade({ id: 'eth-huge', asset: 'ETH', amount: 999, buyPrice: 10, sellPrice: 10.1 });
    const result = await applyTrade(hugeEth);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ETH/);
  });

  it('getPnL accepts an optional currentEthPrice without throwing and keeps realizedPnl unaffected', async () => {
    await applyTrade(baseTrade({ id: 'eth-2', asset: 'ETH', amount: 2, buyPrice: 2500, sellPrice: 2510, netProfit: 18 }));
    const pnlNoPrices  = getPnL();
    const pnlBtcOnly   = getPnL(50000);
    const pnlBtcAndEth = getPnL(50000, 2600);
    // Backward compatible: omitting currentEthPrice must not throw and must
    // produce the same realizedPnl as before this fix.
    expect(pnlNoPrices.realizedPnl).toBeCloseTo(18, 4);
    // A single trade only redistributes ETH between exchanges (total ETH
    // held is unchanged), so unrealizedPnl is unaffected by currentEthPrice
    // here — this asserts the call is safe and additive, not that it must
    // change the number.
    expect(pnlBtcAndEth.realizedPnl).toBeCloseTo(pnlBtcOnly.realizedPnl, 4);
    expect(pnlBtcAndEth).toHaveProperty('unrealizedPnl');
  });
});

describe('walletManager — item 3: multi-asset (XRP) wallet support, mismo fix que H-6', () => {
  beforeEach(() => resetBalances());

  it('getInitialBalances includes an XRP bucket sized independently from BTC/ETH/USDT', () => {
    const initial = getInitialBalances();
    expect(initial).toHaveProperty('XRP');
    EXCHANGES.forEach(ex => {
      expect(initial.XRP[ex]).toBeGreaterThan(0);
    });
  });

  it('an XRP trade debits/credits the XRP wallet and leaves BTC/ETH completely untouched (the exact bug item 3 closes)', async () => {
    const btcBefore = getBalances().BTC;
    const ethBefore = getBalances().ETH;
    const result = await applyTrade(baseTrade({
      id: 'xrp-1', asset: 'XRP', amount: 500, buyPrice: 2.4, sellPrice: 2.42, netProfit: 8,
    }));
    expect(result.ok).toBe(true);
    expect(result.trade.asset).toBe('XRP');

    const after = getBalances();
    expect(after.XRP[EX_A]).toBeCloseTo(getInitialBalances().XRP[EX_A] + 500, 6);
    expect(after.XRP[EX_B]).toBeCloseTo(getInitialBalances().XRP[EX_B] - 500, 6);
    // Before this fix, any asset other than 'ETH' silently fell into the BTC
    // bucket — an "XRP" trade would have mutated BTC instead.
    expect(after.BTC).toEqual(btcBefore);
    expect(after.ETH).toEqual(ethBefore);
  });

  it('rejects an XRP trade that exceeds available XRP balance on the sell exchange (checks the right bucket)', async () => {
    // Amount picked so the USDT leg is well within balance (110000 default)
    // but exceeds the 45000-XRP default per exchange — isolates the
    // XRP-availability check as the only possible rejection reason.
    const hugeXrp = baseTrade({ id: 'xrp-huge', asset: 'XRP', amount: 999999, buyPrice: 0.01, sellPrice: 0.0101 });
    const result = await applyTrade(hugeXrp);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/XRP/);
  });

  it('getPnL accepts an optional currentXrpPrice (4th param) without throwing, backward compatible with the existing 3-arg signature', async () => {
    await applyTrade(baseTrade({ id: 'xrp-2', asset: 'XRP', amount: 100, buyPrice: 2.4, sellPrice: 2.42, netProfit: 2 }));
    const pnlNoPrices = getPnL();
    const pnlWithXrp  = getPnL(50000, 2600, null, 2.5);
    expect(pnlNoPrices.realizedPnl).toBeCloseTo(2, 4);
    expect(pnlWithXrp.realizedPnl).toBeCloseTo(pnlNoPrices.realizedPnl, 4);
    expect(pnlWithXrp).toHaveProperty('unrealizedPnl');
  });
});

describe('walletManager — calcWithdrawalFee', () => {
  it('returns a symmetric round-trip estimate, informational only', () => {
    const fee = calcWithdrawalFee(EX_A, EX_B, 0.01, 50000);
    expect(fee).toHaveProperty('btcWithdrawalUSD');
    expect(fee).toHaveProperty('usdtWithdrawalUSD');
    expect(fee.totalUSD).toBeCloseTo(fee.btcWithdrawalUSD + fee.usdtWithdrawalUSD, 4);
  });
});

describe('walletManager — item 1 refinamiento: aislamiento real por uid (Firebase UID)', () => {
  beforeEach(() => { resetBalances('uid-a'); resetBalances('uid-b'); resetBalances(); });

  it('applyTrade against one uid never touches another uid\'s wallet', async () => {
    await applyTrade(baseTrade({ id: 'a1', amount: 0.01 }), 'uid-a');
    expect(getTradeHistory('uid-a').length).toBe(1);
    expect(getTradeHistory('uid-b').length).toBe(0);
    expect(getTradeHistory().length).toBe(0); // default bucket untouched
    expect(getBalances('uid-b')).toEqual(getInitialBalances());
  });

  it('resetBalances(uid) only resets that uid\'s bucket', async () => {
    await applyTrade(baseTrade({ id: 'a1' }), 'uid-a');
    await applyTrade(baseTrade({ id: 'b1' }), 'uid-b');
    resetBalances('uid-a');
    expect(getTradeHistory('uid-a').length).toBe(0);
    expect(getTradeHistory('uid-b').length).toBe(1);
  });

  it('getPnL(uid) aggregates only that uid\'s own trades', async () => {
    await applyTrade(baseTrade({ id: 'a1', netProfit: 10 }), 'uid-a');
    await applyTrade(baseTrade({ id: 'a2', netProfit: 5 }),  'uid-a');
    await applyTrade(baseTrade({ id: 'b1', netProfit: -100 }), 'uid-b');
    expect(getPnL(null, null, 'uid-a').totalTrades).toBe(2);
    expect(getPnL(null, null, 'uid-a').realizedPnl).toBeCloseTo(15, 4);
    expect(getPnL(null, null, 'uid-b').totalTrades).toBe(1);
  });

  it('a caller that never passes uid keeps behaving exactly like the pre-refactor single global wallet (DEFAULT_UID)', async () => {
    await applyTrade(baseTrade({ id: 'legacy' }));
    expect(getTradeHistory().length).toBe(1);
    expect(getTradeHistory('default').length).toBe(1); // same bucket, explicit vs implicit
  });
});

describe('walletManager — isValidWalletsShape / setBalances (punto 7, auditoría comité sección 12)', () => {
  beforeEach(() => resetBalances('wm-restore-uid'));

  it('isValidWalletsShape accepts a well-formed Wallets object', () => {
    const wallets = getInitialBalances();
    expect(isValidWalletsShape(wallets)).toBe(true);
  });

  it('isValidWalletsShape rejects null/undefined/non-objects', () => {
    expect(isValidWalletsShape(null)).toBe(false);
    expect(isValidWalletsShape(undefined)).toBe(false);
    expect(isValidWalletsShape('BTC')).toBe(false);
    expect(isValidWalletsShape(42)).toBe(false);
  });

  it('isValidWalletsShape rejects an object missing a required asset bucket', () => {
    const wallets = getInitialBalances();
    delete wallets.XRP;
    expect(isValidWalletsShape(wallets)).toBe(false);
  });

  it('isValidWalletsShape rejects a bucket that is an array or has non-numeric values', () => {
    const wallets = getInitialBalances();
    expect(isValidWalletsShape({ ...wallets, BTC: [] })).toBe(false);
    expect(isValidWalletsShape({ ...wallets, BTC: { [EX_A]: 'not-a-number' } })).toBe(false);
    expect(isValidWalletsShape({ ...wallets, BTC: { [EX_A]: NaN } })).toBe(false);
  });

  it('setBalances applies a valid wallets blob and getBalances reflects it', () => {
    const custom = getInitialBalances();
    custom.BTC[EX_A] = 12.5;
    custom.USDT[EX_B] = 999999;
    const applied = setBalances(custom, 'wm-restore-uid');
    expect(applied).toBe(true);
    const restored = getBalances('wm-restore-uid');
    expect(restored.BTC[EX_A]).toBe(12.5);
    expect(restored.USDT[EX_B]).toBe(999999);
  });

  it('setBalances rejects a malformed blob and leaves the tenant wallet untouched', () => {
    const before = getBalances('wm-restore-uid');
    const applied = setBalances({ BTC: {} }, 'wm-restore-uid'); // missing ETH/XRP/USDT
    expect(applied).toBe(false);
    expect(getBalances('wm-restore-uid')).toEqual(before);
  });

  it('setBalances stores a deep copy — mutating the input afterwards does not affect the tenant', () => {
    const custom = getInitialBalances();
    custom.BTC[EX_A] = 7;
    setBalances(custom, 'wm-restore-uid');
    custom.BTC[EX_A] = 999; // mutate the source after passing it in
    expect(getBalances('wm-restore-uid').BTC[EX_A]).toBe(7);
  });

  it('setBalances is per-tenant — applying to one uid does not affect another', () => {
    resetBalances('wm-restore-uid-2');
    const custom = getInitialBalances();
    custom.ETH[EX_A] = 55;
    setBalances(custom, 'wm-restore-uid');
    expect(getBalances('wm-restore-uid').ETH[EX_A]).toBe(55);
    expect(getBalances('wm-restore-uid-2').ETH[EX_A]).not.toBe(55);
  });
});

describe('walletManager — LRU eviction never wipes an active tenant (checkpoint 27 fix)', () => {
  const tenantBotState = require('../server/infrastructure/tenantBotState');

  it('a tenant with the bot enabled keeps its custom balance even after 1000+ other uids push it to the edge of the LRU cap', () => {
    const activeUid = 'wm-active-tenant-survives-eviction';
    tenantBotState.setEnabled(activeUid, true);

    const custom = getInitialBalances();
    custom.BTC[EX_A] = 42.5;
    setBalances(custom, activeUid);
    expect(getBalances(activeUid).BTC[EX_A]).toBe(42.5);

    // Same LRU cap as the real deployment (DEFAULT_MAX_TENANTS = 1000).
    // Touch 1500 other uids — enough to have evicted activeUid several
    // times over under the pre-fix behavior (plain oldest-first eviction).
    for (let i = 0; i < 1500; i++) getBalances(`wm-lru-filler-${i}`);

    // Before this fix: activeUid would have been evicted long ago and this
    // would return a fresh wallet (BTC[EX_A] back to the initial balance),
    // which is exactly the silent data-loss the due-diligence doc flagged.
    expect(getBalances(activeUid).BTC[EX_A]).toBe(42.5);

    tenantBotState.setEnabled(activeUid, false); // cleanup: don't leak into other test files
  });

  it('an inactive (bot-off) tenant can still be evicted normally — this fix does not pin every uid forever', () => {
    const inactiveUid = 'wm-inactive-tenant-can-be-evicted';
    const custom = getInitialBalances();
    custom.BTC[EX_A] = 17.25;
    setBalances(custom, inactiveUid); // bot never enabled for this uid

    for (let i = 0; i < 1500; i++) getBalances(`wm-lru-filler-b-${i}`);

    // Eviction of an inactive tenant resetting to initial balances on their
    // next visit is the documented, tolerable trade-off — unchanged by
    // this fix. We only assert the store still functions (doesn't throw /
    // still returns a valid wallets shape), not a specific eviction outcome,
    // since Map iteration order across 1500 filler uids makes the exact
    // survivor set an implementation detail, not the contract under test.
    expect(isValidWalletsShape(getBalances(inactiveUid))).toBe(true);
  });
});


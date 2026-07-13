'use strict';

/**
 * auditedPnl.test.js — unit tests for server/auditedPnl.js
 *
 * Audit v2, section 9.1: another of the 34 untested server modules, and
 * one of the financially sensitive ones — this is the module that proves
 * (or disproves) that trade.netProfit actually matches the real wallet
 * delta, which is the whole point of an "audited" P&L layer.
 */

import { describe, it, expect, beforeEach } from 'vitest';

const auditedPnl = require('../server/domain/wallet/auditedPnl');

function wallets(usdt, btc) {
  return { USDT: { Binance: usdt }, BTC: { Binance: btc } };
}

function baseTrade(overrides = {}) {
  return {
    id: 't1',
    ts: '2026-06-29T10:00:00.000Z',
    buyExchange: 'Binance',
    sellExchange: 'Kraken',
    amount: 0.01,
    buyPrice: 50000,
    sellPrice: 50100,
    netProfit: 0.5,
    totalFees: 1,
    slippage: 0.1,
    slippageMethod: 'real',
    score: 80,
    type: 'cross_exchange',
    ...overrides,
  };
}

describe('auditedPnl — computeWalletUSD', () => {
  it('sums BTC (at current price) plus USDT across all exchanges', () => {
    const w = { BTC: { Binance: 1, Kraken: 0.5 }, USDT: { Binance: 1000, Kraken: 500 } };
    expect(auditedPnl.computeWalletUSD(w, 50000)).toBe(1.5 * 50000 + 1500);
  });

  it('returns 0 for null/undefined wallets', () => {
    expect(auditedPnl.computeWalletUSD(null, 50000)).toBe(0);
  });
});

describe('auditedPnl — recordAuditedTrade reconciliation', () => {
  beforeEach(() => {
    auditedPnl.initSession(wallets(110000, 1), 50000);
  });

  it('marks a trade reconciled when wallet delta matches netProfit within tolerance', () => {
    const before = wallets(110000, 1);
    // Wallet USD delta exactly equal to netProfit (0.5)
    const after = wallets(110000.5, 1);
    const entry = auditedPnl.recordAuditedTrade(baseTrade({ netProfit: 0.5 }), before, after, 50000);
    expect(entry.reconciled).toBe(true);
    expect(entry.reconciliationDelta).toBeCloseTo(0, 6);
  });

  it('flags a trade as unreconciled when wallet delta diverges from netProfit beyond tolerance', () => {
    const before = wallets(110000, 1);
    const after = wallets(110050, 1); // wallet jumped $50 but trade only claims $0.5
    const entry = auditedPnl.recordAuditedTrade(baseTrade({ netProfit: 0.5 }), before, after, 50000);
    expect(entry.reconciled).toBe(false);
    expect(Math.abs(entry.reconciliationDelta)).toBeGreaterThan(0.01);
  });

  it('computes grossProfit as (sellPrice - buyPrice) * amount', () => {
    const before = wallets(110000, 1);
    const after = wallets(110000.5, 1);
    const entry = auditedPnl.recordAuditedTrade(
      baseTrade({ buyPrice: 50000, sellPrice: 50200, amount: 0.02, netProfit: 0.5 }),
      before, after, 50000
    );
    expect(entry.grossProfit).toBeCloseTo((50200 - 50000) * 0.02, 6);
  });

  it('updates the daily ledger keyed by the trade date (ledger persists across initSession, unlike _trades)', () => {
    const before = wallets(110000, 1);
    const after = wallets(110000.5, 1);
    const countBefore = auditedPnl.getDailyLedger().find(d => d.date === '2026-06-29')?.tradeCount || 0;

    auditedPnl.recordAuditedTrade(baseTrade({ id: 'ledger-1', ts: '2026-06-29T10:00:00.000Z' }), before, after, 50000);
    auditedPnl.recordAuditedTrade(baseTrade({ id: 'ledger-2', ts: '2026-06-29T12:00:00.000Z' }), before, after, 50000);

    const day = auditedPnl.getDailyLedger().find(d => d.date === '2026-06-29');
    expect(day).toBeDefined();
    // Note: getDailyLedger() is cumulative by design (the audit trail's whole
    // point is a durable per-day record), so we assert it grew by exactly 2
    // rather than asserting an absolute count that other tests in this file
    // (which also use 2026-06-29 timestamps) would otherwise pollute.
    expect(day.tradeCount).toBe(countBefore + 2);
  });
});

describe('auditedPnl — getAuditedPnl aggregation', () => {
  beforeEach(() => {
    auditedPnl.initSession(wallets(110000, 1), 50000);
  });

  it('returns a null unrealizedPnl/totalPnl-as-realized shape with no current wallets passed', () => {
    const before = wallets(110000, 1);
    const after = wallets(110000.5, 1);
    auditedPnl.recordAuditedTrade(baseTrade({ netProfit: 0.5 }), before, after, 50000);

    const result = auditedPnl.getAuditedPnl(null, null);
    expect(result.realizedPnl).toBeCloseTo(0.5, 6);
    expect(result.unrealizedPnl).toBeNull();
    expect(result.totalPnl).toBeCloseTo(0.5, 6);
  });

  it('includes unrealizedPnl and folds it into totalPnl when current wallets are passed', () => {
    const before = wallets(110000, 1);
    const after = wallets(110000.5, 1);
    auditedPnl.recordAuditedTrade(baseTrade({ netProfit: 0.5 }), before, after, 50000);

    // BTC price rose since session start, so the 1 BTC held is now worth more
    const current = wallets(110000.5, 1);
    const result = auditedPnl.getAuditedPnl(current, 51000);
    expect(result.unrealizedPnl).toBeGreaterThan(0);
    expect(result.totalPnl).toBeCloseTo(result.realizedPnl + result.unrealizedPnl, 4);
  });

  it('aggregates win/loss counts, win rate, best/worst trade, and attribution by pair/type', () => {
    const before = wallets(110000, 1);
    auditedPnl.recordAuditedTrade(baseTrade({ id: 'w1', netProfit: 10 }), before, wallets(110010, 1), 50000);
    auditedPnl.recordAuditedTrade(baseTrade({ id: 'w2', netProfit: 5 }), before, wallets(110005, 1), 50000);
    auditedPnl.recordAuditedTrade(baseTrade({ id: 'l1', netProfit: -3, buyExchange: 'Kraken', sellExchange: 'Bybit' }), before, wallets(109997, 1), 50000);

    const result = auditedPnl.getAuditedPnl(null, null);
    expect(result.totalTrades).toBe(3);
    expect(result.winningTrades).toBe(2);
    expect(result.losingTrades).toBe(1);
    expect(result.winRate).toBeCloseTo((2 / 3) * 100, 1);
    expect(result.bestTrade).toBeCloseTo(10, 4);
    expect(result.worstTrade).toBeCloseTo(-3, 4);
    expect(result.byExchangePair['Binance→Kraken']).toBeCloseTo(15, 4);
    expect(result.byExchangePair['Kraken→Bybit']).toBeCloseTo(-3, 4);
    expect(result.byType['cross_exchange']).toBeCloseTo(12, 4);
  });

  it('flags reconciled:false at the aggregate level if any single trade failed reconciliation', () => {
    const before = wallets(110000, 1);
    auditedPnl.recordAuditedTrade(baseTrade({ id: 'good', netProfit: 0.5 }), before, wallets(110000.5, 1), 50000);
    auditedPnl.recordAuditedTrade(baseTrade({ id: 'bad', netProfit: 0.5 }), before, wallets(110050, 1), 50000); // big unexplained jump

    const result = auditedPnl.getAuditedPnl(null, null);
    expect(result.reconciled).toBe(false);
    expect(result.reconciliationErrors).toBe(1);
  });
});

describe('auditedPnl — getAuditTrail & exportCsv', () => {
  beforeEach(() => {
    auditedPnl.initSession(wallets(110000, 1), 50000);
  });

  it('getAuditTrail returns trades newest-first, capped at the given limit', () => {
    const before = wallets(110000, 1);
    for (let i = 0; i < 5; i++) {
      auditedPnl.recordAuditedTrade(baseTrade({ id: `t${i}`, netProfit: 1 }), before, wallets(110001, 1), 50000);
    }
    const trail = auditedPnl.getAuditTrail(3);
    expect(trail.length).toBe(3);
    expect(trail[0].id).toBe('t4'); // most recent first
  });

  it('exportCsv produces a header row plus one row per trade', () => {
    const before = wallets(110000, 1);
    auditedPnl.recordAuditedTrade(baseTrade({ id: 't1' }), before, wallets(110000.5, 1), 50000);
    auditedPnl.recordAuditedTrade(baseTrade({ id: 't2' }), before, wallets(110000.5, 1), 50000);

    const csv = auditedPnl.exportCsv();
    const lines = csv.split('\n');
    expect(lines[0]).toMatch(/^id,ts,pair,type/);
    expect(lines.length).toBe(3); // header + 2 trades
    expect(lines[1]).toContain('t1');
  });
});

describe('auditedPnl — initSession resets state', () => {
  it('clears previously recorded trades on re-init', () => {
    auditedPnl.initSession(wallets(110000, 1), 50000);
    auditedPnl.recordAuditedTrade(baseTrade(), wallets(110000, 1), wallets(110000.5, 1), 50000);
    expect(auditedPnl.getAuditTrail().length).toBe(1);

    auditedPnl.initSession(wallets(110000, 1), 50000);
    expect(auditedPnl.getAuditTrail().length).toBe(0);
  });
});

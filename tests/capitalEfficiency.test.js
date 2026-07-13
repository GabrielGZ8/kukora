import { describe, it, expect } from 'vitest';
import { computeCapitalEfficiency, computeRebalanceProjection, ALL_EXCHANGES } from '../server/domain/wallet/capitalEfficiency.js';

describe('computeCapitalEfficiency', () => {
  it('returns an error shape when btcPrice is missing or non-positive', () => {
    const wallets = { BTC: { Binance: 1 }, USDT: { Binance: 1000 } };
    expect(computeCapitalEfficiency(wallets, 0, {}, 1000).error).toBe('no_btc_price');
    expect(computeCapitalEfficiency(wallets, null, {}, 1000).error).toBe('no_btc_price');
    expect(computeCapitalEfficiency(wallets, -100, {}, 1000).error).toBe('no_btc_price');
  });

  it('sums BTC/USDT across all exchanges into capitalDeployedUSD', () => {
    const wallets = {
      BTC:  { Binance: 0.5, Kraken: 0.5 },
      USDT: { Binance: 10000, Kraken: 10000 },
    };
    const r = computeCapitalEfficiency(wallets, 50000, { realizedPnl: 0, totalTrades: 0 }, 3_600_000);
    // 1 BTC * 50000 + 20000 USDT = 70000
    expect(r.capitalDeployedUSD).toBe(70000);
    expect(r.totalBtcHeld).toBe(1);
    expect(r.totalUsdtHeld).toBe(20000);
  });

  it('projects daily/yearly profit from the session profit rate', () => {
    const wallets = { BTC: { Binance: 1 }, USDT: { Binance: 0 } };
    // 1 hour uptime, $10 realized pnl -> $10/hr -> $240/day -> $87600/yr
    const r = computeCapitalEfficiency(wallets, 50000, { realizedPnl: 10, totalTrades: 10 }, 3_600_000);
    expect(r.profitPerHourProjected).toBeCloseTo(10, 4);
    expect(r.profitPerDayProjected).toBeCloseTo(240, 2);
    expect(r.profitPerYearProjected).toBeCloseTo(87600, 2);
  });

  it('computes roiAnnualizedPct relative to capital deployed', () => {
    const wallets = { BTC: { Binance: 1 }, USDT: { Binance: 0 } }; // 50000 USD deployed
    const r = computeCapitalEfficiency(wallets, 50000, { realizedPnl: 10, totalTrades: 10 }, 3_600_000);
    // profitPerYearProjected ≈ 87600, roi = 87600/50000*100 = 175.2%
    expect(r.roiAnnualizedPct).toBeCloseTo(175.2, 1);
  });

  it('returns null roi when capital deployed is 0', () => {
    const wallets = { BTC: {}, USDT: {} };
    const r = computeCapitalEfficiency(wallets, 50000, { realizedPnl: 0, totalTrades: 0 }, 3_600_000);
    expect(r.capitalDeployedUSD).toBe(0);
    expect(r.roiAnnualizedPct).toBeNull();
  });

  it('floors uptime at 1 minute to avoid divide-by-near-zero blowups', () => {
    const wallets = { BTC: { Binance: 1 }, USDT: { Binance: 0 } };
    const r = computeCapitalEfficiency(wallets, 50000, { realizedPnl: 1, totalTrades: 1 }, 0);
    expect(r.uptimeHours).toBeCloseTo(1 / 60, 2);
  });

  it('falls back from realizedPnl to totalPnl when realizedPnl is absent', () => {
    const wallets = { BTC: { Binance: 1 }, USDT: { Binance: 0 } };
    const r = computeCapitalEfficiency(wallets, 50000, { totalPnl: 5, totalTrades: 1 }, 3_600_000);
    expect(r.realizedPnlSession).toBeCloseTo(5, 4);
  });

  it('infraBreakEvenDays is null when there is no positive daily profit', () => {
    const wallets = { BTC: { Binance: 1 }, USDT: { Binance: 0 } };
    const r = computeCapitalEfficiency(wallets, 50000, { realizedPnl: -10, totalTrades: 1 }, 3_600_000);
    expect(r.infraBreakEvenDays).toBeNull();
  });

  it('adds a low-confidence note when totalTrades < 5', () => {
    const wallets = { BTC: { Binance: 1 }, USDT: { Binance: 0 } };
    const few = computeCapitalEfficiency(wallets, 50000, { realizedPnl: 1, totalTrades: 2 }, 3_600_000);
    expect(few.note).toMatch(/high uncertainty/);
    const many = computeCapitalEfficiency(wallets, 50000, { realizedPnl: 1, totalTrades: 20 }, 3_600_000);
    expect(many.note).toBeNull();
  });
});

describe('computeRebalanceProjection', () => {
  const initialBalances = {
    BTC:  Object.fromEntries(ALL_EXCHANGES.map(e => [e, 1])),
    USDT: Object.fromEntries(ALL_EXCHANGES.map(e => [e, 10000])),
  };

  it('reports zero drift and no rebalance needed when balances match initial', () => {
    const r = computeRebalanceProjection(initialBalances, initialBalances, [], 50000);
    expect(r.maxDriftPct).toBe(0);
    expect(r.rebalanceNeeded).toBe(false);
  });

  it('flags rebalanceNeeded once drift crosses the configured threshold (default 15%)', () => {
    const wallets = {
      BTC:  { ...initialBalances.BTC, Binance: 1.2 }, // 20% drift
      USDT: initialBalances.USDT,
    };
    const r = computeRebalanceProjection(wallets, initialBalances, [], 50000);
    expect(r.maxDriftPct).toBeCloseTo(20, 5);
    expect(r.rebalanceNeeded).toBe(true);
  });

  it('handles a zero initial balance gracefully (no division by zero / NaN)', () => {
    const zeroInit = { BTC: { Binance: 0 }, USDT: { Binance: 0 } };
    const wallets  = { BTC: { Binance: 5 }, USDT: { Binance: 100 } };
    const r = computeRebalanceProjection(wallets, zeroInit, [], 50000);
    expect(r.drifts.find(d => d.exchange === 'Binance').btcDriftPct).toBe(0);
    expect(Number.isNaN(r.maxDriftPct)).toBe(false);
  });

  it('projects hoursUntilRebalance via linear extrapolation when not yet needed', () => {
    const wallets = {
      BTC:  { ...initialBalances.BTC, Binance: 1.05 }, // 5% drift
      USDT: initialBalances.USDT,
    };
    const now = Date.now();
    const tradeHistory = [
      { ts: new Date(now - 3_600_000).toISOString() },
      { ts: new Date(now - 1_800_000).toISOString() },
      { ts: new Date(now).toISOString() },
    ];
    const r = computeRebalanceProjection(wallets, initialBalances, tradeHistory, 50000);
    expect(r.rebalanceNeeded).toBe(false);
    expect(r.hoursUntilRebalance).not.toBeNull();
    expect(r.hoursUntilRebalance).toBeGreaterThan(0);
  });

  it('does not project hoursUntilRebalance with fewer than 3 trades', () => {
    const wallets = { BTC: { ...initialBalances.BTC, Binance: 1.05 }, USDT: initialBalances.USDT };
    const r = computeRebalanceProjection(wallets, initialBalances, [{ ts: new Date().toISOString() }], 50000);
    expect(r.hoursUntilRebalance).toBeNull();
  });

  it('estimates a rebalance cost in USD using withdrawal fees for the two most-drifted exchanges', () => {
    const wallets = {
      BTC:  { ...initialBalances.BTC, Binance: 1.3, Kraken: 0.7 },
      USDT: initialBalances.USDT,
    };
    const r = computeRebalanceProjection(wallets, initialBalances, [], 50000);
    expect(r.estimatedRebalanceCostUSD).not.toBeNull();
    expect(r.estimatedRebalanceCostUSD).toBeGreaterThan(0);
  });

  it('includes all 5 exchanges in the drifts array regardless of input', () => {
    const r = computeRebalanceProjection(initialBalances, initialBalances, [], 50000);
    expect(r.drifts.map(d => d.exchange).sort()).toEqual([...ALL_EXCHANGES].sort());
  });
});

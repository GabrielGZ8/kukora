'use strict';

/**
 * tests/opportunity.test.js — server/opportunity.js (Nivel 2 #3 del roadmap)
 *
 * server/opportunity.js es el compilado de server-types/server/opportunity.ts
 * (single source of truth para la forma de un Opportunity). Antes de esta
 * ronda existía el .ts pero nunca se compilaba a .js ni se consumía en
 * runtime — era documentación aspiracional, no un contrato real.
 *
 * Esta ronda:
 *   1. Compila opportunity.ts -> server/opportunity.js (isOpportunity, el
 *      único export en runtime — las interfaces TS no generan código JS).
 *   2. Lo conecta en arbitrageOrchestrator.executeBestOpportunity() como
 *      un chequeo de contrato NO bloqueante (emite un warning vía
 *      observabilityService si la forma no matchea, pero nunca lanza ni
 *      altera el flujo de ejecución — ver el comentario en ese archivo).
 *   3. Este archivo verifica que el objeto REAL que produce
 *      opportunityDetection.detectOpportunities() efectivamente cumple
 *      isOpportunity() — el propósito explícito documentado en el .ts: que
 *      un cambio futuro que rompa la forma se detecte aquí, no en
 *      producción.
 */

import { describe, it, expect } from 'vitest';

const { isOpportunity, isTrade, createTrade, isOpportunityLogEntry } = require('../server/domain/opportunity.js');

// Mismo fixture que tests/engine.test.js — orderBooks con feedAgeMs:0 para
// evitar el filtro de isFeedStale() en entorno de test.
const makeOrderBooks = (overrides = {}) => {
  const base = {
    Binance:  { exchange: 'Binance',  ask: 29900, bid: 29890, ts: Date.now(), feedAgeMs: 0 },
    Kraken:   { exchange: 'Kraken',   ask: 30100, bid: 30090, ts: Date.now(), feedAgeMs: 0 },
    Bybit:    { exchange: 'Bybit',    ask: 29950, bid: 29940, ts: Date.now(), feedAgeMs: 0 },
    OKX:      { exchange: 'OKX',      ask: 30050, bid: 30040, ts: Date.now(), feedAgeMs: 0 },
    Coinbase: { exchange: 'Coinbase', ask: 30000, bid: 29990, ts: Date.now(), feedAgeMs: 0 },
  };
  Object.assign(base, overrides);
  return Object.values(base);
};

describe('opportunity.js — isOpportunity (type guard)', () => {
  it('accepts a minimal well-formed opportunity object', () => {
    expect(isOpportunity({
      buyExchange: 'Binance', sellExchange: 'Kraken',
      netProfit: 12.5, spreadPct: 0.4, viable: true,
    })).toBe(true);
  });

  it('rejects null, undefined, and non-object values', () => {
    expect(isOpportunity(null)).toBe(false);
    expect(isOpportunity(undefined)).toBe(false);
    expect(isOpportunity('opportunity')).toBe(false);
    expect(isOpportunity(42)).toBe(false);
  });

  it('rejects an object missing a required field', () => {
    expect(isOpportunity({
      buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 1, spreadPct: 0.1,
      // viable omitted
    })).toBe(false);
  });

  it('rejects an object where a required field has the wrong type', () => {
    expect(isOpportunity({
      buyExchange: 'Binance', sellExchange: 'Kraken',
      netProfit: '12.5', // string instead of number
      spreadPct: 0.4, viable: true,
    })).toBe(false);
  });
});

describe('opportunity.js — isTrade (type guard)', () => {
  it('accepts a minimal well-formed trade object', () => {
    expect(isTrade({
      id: 'trade-1-abc', buyExchange: 'Binance', sellExchange: 'Kraken',
      amount: 0.1, netProfit: 12.5, ts: new Date().toISOString(),
    })).toBe(true);
  });

  it('rejects null, undefined, and non-object values', () => {
    expect(isTrade(null)).toBe(false);
    expect(isTrade(undefined)).toBe(false);
    expect(isTrade('trade')).toBe(false);
  });

  it('rejects an object missing a required field (id)', () => {
    expect(isTrade({
      buyExchange: 'Binance', sellExchange: 'Kraken',
      amount: 0.1, netProfit: 12.5, ts: new Date().toISOString(),
    })).toBe(false);
  });
});

describe('opportunity.js — createTrade (canonical constructor)', () => {
  it('fills id/ts/status/executionMs/totalFees when omitted', () => {
    const trade = createTrade({
      asset: 'BTC', buyExchange: 'Binance', sellExchange: 'Kraken',
      buyPrice: 30000, sellPrice: 30100, amount: 0.1, requestedAmount: 0.1,
      partialFill: false, grossProfit: 10, buyFee: 1, sellFee: 1,
      slippage: 0.5, slippagePct: 0.01, slippageMethod: 'real',
      withdrawalFeeUSD: 2, withdrawalModel: 'periodic_rebalancing',
      netProfit: 7.5, netProfitPct: 0.25, spreadPct: 0.33, breakEvenPct: 0.1,
      score: 80, buySource: 'ws', sellSource: 'ws', feeMode: 'taker',
    });
    expect(trade.id).toMatch(/^trade-/);
    expect(trade.ts).toEqual(expect.any(String));
    expect(trade.status).toBe('profit'); // netProfit > 0
    expect(trade.totalFees).toBe(2);     // buyFee + sellFee
    expect(isTrade(trade)).toBe(true);
  });

  it('derives status: "loss" when netProfit <= 0, and respects explicit overrides', () => {
    const trade = createTrade({
      asset: 'BTC', buyExchange: 'Binance', sellExchange: 'Kraken',
      buyPrice: 30000, sellPrice: 30100, amount: 0.1, requestedAmount: 0.1,
      partialFill: false, grossProfit: -1, buyFee: 1, sellFee: 1,
      slippage: 0, slippagePct: 0, slippageMethod: 'fallback',
      withdrawalFeeUSD: 0, withdrawalModel: 'periodic_rebalancing',
      netProfit: -3, netProfitPct: -0.1, spreadPct: 0.1, breakEvenPct: 0.2,
      score: 0, buySource: 'http', sellSource: 'http', feeMode: 'taker',
      id: 'trade-fixed-id',
    });
    expect(trade.status).toBe('loss');
    expect(trade.id).toBe('trade-fixed-id'); // explicit id respected, not regenerated
  });
});

describe('opportunity.js — contract with the real Trade producer (executeSimulated)', () => {
  it('the trade object returned by executeSimulated() satisfies isTrade()', async () => {
    const { detectOpportunities, executeSimulated } = await import('../server/domain/engines/opportunityDetection.js');
    // 0.5% spread — comfortably above minSpreadPct and below maxSpreadPct
    // (a spread as large as the isOpportunity fixture above trips the
    // circuit breaker instead of producing a viable opportunity).
    const books = makeOrderBooks({
      Binance: { exchange: 'Binance', ask: 30000, bid: 29990, ts: Date.now(), feedAgeMs: 0 },
      Kraken:  { exchange: 'Kraken',  ask: 30160, bid: 30150, ts: Date.now(), feedAgeMs: 0 },
    });
    const { opportunities } = detectOpportunities(books, 0.1);
    const viable = opportunities.find(o => o.viable);
    expect(viable).toBeTruthy();

    const wallets = {
      USDT: { Binance: 1_000_000, Kraken: 1_000_000, Bybit: 1_000_000, OKX: 1_000_000, Coinbase: 1_000_000 },
      BTC:  { Binance: 100, Kraken: 100, Bybit: 100, OKX: 100, Coinbase: 100 },
    };
    const result = executeSimulated(viable, wallets, 0.1);
    expect(result.ok).toBe(true);
    expect(isTrade(result.trade)).toBe(true);
  });
});

describe('opportunity.js — isOpportunityLogEntry (type guard, audit roadmap: named log-entry contract)', () => {
  it('accepts a well-formed reduced log entry', () => {
    expect(isOpportunityLogEntry({
      pair: 'Binance→Kraken', netProfit: 1.5, spreadPct: 0.3, breakEvenPct: 0.1,
      viable: true, rejCat: null, slipMethod: 'real', feeMode: 'taker', score: 72, ts: new Date().toISOString(),
    })).toBe(true);
  });

  it('rejects null/undefined/non-objects', () => {
    expect(isOpportunityLogEntry(null)).toBe(false);
    expect(isOpportunityLogEntry(undefined)).toBe(false);
    expect(isOpportunityLogEntry('entry')).toBe(false);
    expect(isOpportunityLogEntry(42)).toBe(false);
  });

  it('rejects an entry missing `score` (the exact drift bug found in CHECKPOINT_13)', () => {
    expect(isOpportunityLogEntry({
      pair: 'Binance→Kraken', netProfit: 1.5, spreadPct: 0.3, viable: true, ts: new Date().toISOString(),
    })).toBe(false);
  });

  it('rejects a full Opportunity object (buyExchange/sellExchange separate, no `pair`) — the two shapes are intentionally distinct', () => {
    expect(isOpportunityLogEntry({
      buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 1.5, spreadPct: 0.3,
      viable: true, score: 72, ts: new Date().toISOString(),
    })).toBe(false);
  });

  it('the real entries pushed by opportunityDetection.detectOpportunities() into the log satisfy isOpportunityLogEntry', async () => {
    const { detectOpportunities, getOpportunityLog } = await import('../server/domain/engines/opportunityDetection.js');
    const books = makeOrderBooks({
      Binance: { exchange: 'Binance', ask: 30000, bid: 29990, ts: Date.now(), feedAgeMs: 0 },
      Kraken:  { exchange: 'Kraken',  ask: 30160, bid: 30150, ts: Date.now(), feedAgeMs: 0 },
    });
    detectOpportunities(books, 0.1);
    const log = getOpportunityLog();
    const viableEntries = log.filter(e => e.viable);
    expect(viableEntries.length).toBeGreaterThan(0);
    for (const entry of viableEntries) {
      expect(isOpportunityLogEntry(entry)).toBe(true);
    }
  });
});

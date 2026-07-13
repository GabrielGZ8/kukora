'use strict';

/**
 * engine.test.js — Capa 4: cobertura de módulos prioritarios
 *
 * Covers:
 *   - scoringService.js:       scoreAssets — composite 0-100 asset scoring
 *   - opportunityDetection.js:      detectOpportunities — full return shape
 *   - advancedRiskEngine.js:   circuit breaker, preTradeRiskCheck, getStatus, assetRiskScore
 *   - alertWebhookService.js:  getAlertHistory, getConfig, alertCircuitBreakerActivated
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ─── Helpers ──────────────────────────────────────────────────────────────

const makePrices = (n, trend = 'up') =>
  Array.from({ length: n }, (_, i) =>
    trend === 'up'   ? 100 + i * 2
  : trend === 'down' ? 200 - i * 2
  : 100 + Math.sin(i) * 5
  );

// Build the array-of-objects shape that detectOpportunities expects
// feedAgeMs:0 prevents isFeedStale() from filtering the books in test env
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

// ─── scoringService.js ────────────────────────────────────────────────────

describe('scoringService — scoreAssets', () => {
  it('returns an array sorted descending by score', async () => {
    const { scoreAssets } = await import('../server/domain/engines/scoringService.js');
    const assets = [
      { id: 'btc', name: 'BTC', prices: makePrices(60, 'up') },
      { id: 'eth', name: 'ETH', prices: makePrices(60, 'down') },
      { id: 'sol', name: 'SOL', prices: makePrices(60, 'flat') },
    ];
    const result = scoreAssets(assets);
    expect(result.length).toBe(3);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
    }
  });

  it('each result has required fields: id, score, label, breakdown', async () => {
    const { scoreAssets } = await import('../server/domain/engines/scoringService.js');
    const [r] = scoreAssets([{ id: 'ada', name: 'ADA', prices: makePrices(50, 'up') }]);
    expect(r).toHaveProperty('id', 'ada');
    expect(r).toHaveProperty('score');
    expect(r).toHaveProperty('label');
    expect(r).toHaveProperty('breakdown');
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('returns empty array for no assets', async () => {
    const { scoreAssets } = await import('../server/domain/engines/scoringService.js');
    expect(scoreAssets([])).toEqual([]);
  });

  it('assigns a higher score to uptrend vs downtrend', async () => {
    const { scoreAssets } = await import('../server/domain/engines/scoringService.js');
    const result = scoreAssets([
      { id: 'up',   name: 'Up',   prices: makePrices(60, 'up') },
      { id: 'down', name: 'Down', prices: makePrices(60, 'down') },
    ]);
    const upScore   = result.find(r => r.id === 'up').score;
    const downScore = result.find(r => r.id === 'down').score;
    expect(upScore).toBeGreaterThan(downScore);
  });

  it('gracefully handles assets with fewer than 5 prices', async () => {
    const { scoreAssets } = await import('../server/domain/engines/scoringService.js');
    const result = scoreAssets([{ id: 'tiny', name: 'Tiny', prices: [100, 102] }]);
    expect(result.length).toBe(1);
    expect(result[0].score).toBeGreaterThanOrEqual(0);
  });

  it('respects custom weights — result stays in [0, 100]', async () => {
    const { scoreAssets } = await import('../server/domain/engines/scoringService.js');
    const [r] = scoreAssets(
      [{ id: 'x', name: 'X', prices: makePrices(60, 'up') }],
      { weights: { momentum: 1.0, volatility: 0, performance: 0, volume: 0 } }
    );
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('all breakdown values are numeric', async () => {
    const { scoreAssets } = await import('../server/domain/engines/scoringService.js');
    const [r] = scoreAssets([{ id: 'z', name: 'Z', prices: makePrices(60, 'up') }]);
    Object.values(r.breakdown).forEach(v => {
      expect(typeof v).toBe('number');
      expect(v).toBeGreaterThanOrEqual(0);
    });
  });
});

// ─── opportunityDetection.js — detectOpportunities ────────────────────────────

describe('opportunityDetection — detectOpportunities', () => {
  it('returns object with opportunities array and metadata', async () => {
    const { detectOpportunities } = await import('../server/domain/engines/opportunityDetection.js');
    const result = detectOpportunities(makeOrderBooks(), 0.001);
    expect(result).toHaveProperty('opportunities');
    expect(Array.isArray(result.opportunities)).toBe(true);
    expect(result).toHaveProperty('evalMs');
  });

  it('each opportunity in the array has required shape fields', async () => {
    const { detectOpportunities } = await import('../server/domain/engines/opportunityDetection.js');
    const books = makeOrderBooks({
      Binance: { exchange: 'Binance', ask: 27000, bid: 26990, ts: Date.now() },
      Kraken:  { exchange: 'Kraken',  ask: 31000, bid: 30990, ts: Date.now() },
    });
    const { opportunities } = detectOpportunities(books, 0.001);
    if (opportunities.length > 0) {
      const op = opportunities[0];
      expect(op).toHaveProperty('buyExchange');
      expect(op).toHaveProperty('sellExchange');
      expect(op).toHaveProperty('spreadPct');
      expect(op).toHaveProperty('netProfit');
      expect(op).toHaveProperty('viable');
      expect(typeof op.viable).toBe('boolean');
    }
  });

  it('returns no viable opportunities when spread is zero', async () => {
    const { detectOpportunities } = await import('../server/domain/engines/opportunityDetection.js');
    const flat = ['Binance','Kraken','Bybit','OKX','Coinbase'].map(ex => ({
      exchange: ex, ask: 30000, bid: 29999, ts: Date.now(),
    }));
    const { opportunities } = detectOpportunities(flat, 0.001);
    expect(opportunities.filter(o => o.viable).length).toBe(0);
  });

  it('computes positive netProfit for opportunity with 1.4% spread', async () => {
    const { detectOpportunities } = await import('../server/domain/engines/opportunityDetection.js');
    // Binance cheapest buyer, Kraken highest seller — spread ~1.4%
    const books = makeOrderBooks({
      Binance: { exchange: 'Binance', ask: 29700, bid: 29690, ts: Date.now() },
      Kraken:  { exchange: 'Kraken',  ask: 30120, bid: 30110, ts: Date.now() },
    });
    const { opportunities } = detectOpportunities(books, 0.1);
    // The engine evaluates all active-exchange pairs; find one with positive netProfit
    const profitable = opportunities.filter(o => o.netProfit > 0);
    expect(profitable.length).toBeGreaterThan(0);
    profitable.forEach(o => {
      expect(o.spreadPct).toBeGreaterThan(0);
      expect(typeof o.buyExchange).toBe('string');
    });
  });

  it('returns empty opportunities with a single exchange', async () => {
    const { detectOpportunities } = await import('../server/domain/engines/opportunityDetection.js');
    const single = [{ exchange: 'Binance', ask: 30000, bid: 29990, ts: Date.now() }];
    expect(() => detectOpportunities(single, 0.001)).not.toThrow();
    const { opportunities } = detectOpportunities(single, 0.001);
    expect(opportunities.length).toBe(0);
  });

  it('filters out errored order books — no opportunity uses an errored exchange as buyer', async () => {
    const { detectOpportunities } = await import('../server/domain/engines/opportunityDetection.js');
    const books = makeOrderBooks();
    const erroredExchange = books[0].exchange;
    books[0].error = true;
    const { opportunities } = detectOpportunities(books, 0.001);
    opportunities.forEach(o => expect(o.buyExchange).not.toBe(erroredExchange));
  });

  it('includes triangularSignals array in result', async () => {
    const { detectOpportunities } = await import('../server/domain/engines/opportunityDetection.js');
    const result = detectOpportunities(makeOrderBooks(), 0.001);
    expect(result).toHaveProperty('triangularSignals');
    expect(Array.isArray(result.triangularSignals)).toBe(true);
  });
});

// ─── advancedRiskEngine.js ────────────────────────────────────────────────

describe('advancedRiskEngine — circuit breaker', () => {
  beforeEach(async () => {
    const eng = await import('../server/domain/risk/advancedRiskEngine.js');
    eng.resetCircuitBreaker('test-setup');
  });

  it('circuit breaker starts inactive after reset', async () => {
    const { getStatus } = await import('../server/domain/risk/advancedRiskEngine.js');
    expect(getStatus().circuitBreaker.active).toBe(false);
  });

  it('activateCircuitBreaker sets active:true with reason', async () => {
    const { activateCircuitBreaker, getStatus } = await import('../server/domain/risk/advancedRiskEngine.js');
    activateCircuitBreaker('test reason', 'manual');
    const st = getStatus();
    expect(st.circuitBreaker.active).toBe(true);
    expect(st.circuitBreaker.reason).toBe('test reason');
  });

  it('resetCircuitBreaker clears active state and reason', async () => {
    const { activateCircuitBreaker, resetCircuitBreaker, getStatus } = await import('../server/domain/risk/advancedRiskEngine.js');
    activateCircuitBreaker('oops', 'manual');
    resetCircuitBreaker('recovery');
    const st = getStatus();
    expect(st.circuitBreaker.active).toBe(false);
    expect(st.circuitBreaker.reason).toBeNull();
  });

  it('preTradeRiskCheck returns ok:false with circuit_breaker check when CB active', async () => {
    const { activateCircuitBreaker, resetCircuitBreaker, preTradeRiskCheck } = await import('../server/domain/risk/advancedRiskEngine.js');
    resetCircuitBreaker('clean');
    activateCircuitBreaker('blocking trades', 'manual');
    const result = preTradeRiskCheck(
      { spreadPct: 0.5, netProfit: 10, slippagePct: 0.01, tradeValueUSD: 500 },
      { BTC: { Binance: 1 }, USDT: { Binance: 50000 } },
      50000, 0
    );
    expect(result.ok).toBe(false);
    const cbCheck = result.checks.find(c => c.check === 'circuit_breaker');
    expect(cbCheck).toBeDefined();
    expect(cbCheck.ok).toBe(false);
  });

  it('preTradeRiskCheck result always has ok, checks, and blockedBy', async () => {
    const { resetCircuitBreaker, preTradeRiskCheck } = await import('../server/domain/risk/advancedRiskEngine.js');
    resetCircuitBreaker('clean');
    const result = preTradeRiskCheck(
      { spreadPct: 0.5, netProfit: 10, slippagePct: 0.01, tradeValueUSD: 100 },
      { BTC: { Binance: 1 }, USDT: { Binance: 50000 } },
      50000, 0
    );
    expect(typeof result.ok).toBe('boolean');
    expect(Array.isArray(result.checks)).toBe(true);
    expect('blockedBy' in result).toBe(true);
  });
});

describe('advancedRiskEngine — getStatus', () => {
  it('returns nested circuitBreaker, drawdown, and config objects', async () => {
    const { getStatus } = await import('../server/domain/risk/advancedRiskEngine.js');
    const st = getStatus(100_000, 0);
    expect(st).toHaveProperty('circuitBreaker');
    expect(st.circuitBreaker).toHaveProperty('active');
    expect(st.circuitBreaker).toHaveProperty('reason');
    expect(st).toHaveProperty('consecutiveFailures');
    expect(st).toHaveProperty('drawdown');
    expect(st).toHaveProperty('config');
  });

  it('drawdown.pct is null or number depending on equity history', async () => {
    const { getStatus } = await import('../server/domain/risk/advancedRiskEngine.js');
    const st = getStatus(95_000, -5_000);
    expect(st.drawdown.pct === null || typeof st.drawdown.pct === 'number').toBe(true);
  });
});

describe('advancedRiskEngine — assetRiskScore', () => {
  it('returns score in [0,100] with grade A-D and numeric components', async () => {
    const { assetRiskScore } = await import('../server/domain/risk/advancedRiskEngine.js');
    const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i * 0.5) * 10);
    const result = assetRiskScore(prices);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(['A', 'B', 'C', 'D']).toContain(result.grade);
    expect(typeof result.components).toBe('object');
  });

  it('returns grade C / score 50 for very short series (< 10 prices)', async () => {
    const { assetRiskScore } = await import('../server/domain/risk/advancedRiskEngine.js');
    const result = assetRiskScore([100, 101, 99]);
    expect(result.score).toBe(50);
    expect(result.grade).toBe('C');
  });

  it('volatile series scores higher risk than stable series', async () => {
    const { assetRiskScore } = await import('../server/domain/risk/advancedRiskEngine.js');
    const stable    = Array.from({ length: 30 }, () => 100);
    const volatile_ = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 30 : -30));
    const rs = assetRiskScore(stable);
    const rv = assetRiskScore(volatile_);
    expect(rv.score).toBeGreaterThanOrEqual(rs.score);
  });
});

// ─── Integration: alertWebhookService (in-process) ───────────────────────
//
// Tests the alert service's history buffer and config directly — same data
// backing GET /api/arbitrage/alerts/history.  No live HTTP server required.

describe('Integration — alertWebhookService', () => {
  it('getAlertHistory returns an array', async () => {
    const { getAlertHistory } = await import('../server/infrastructure/alertWebhookService.js');
    expect(Array.isArray(getAlertHistory(10))).toBe(true);
  });

  it('getConfig has expected top-level keys', async () => {
    const { getConfig } = await import('../server/infrastructure/alertWebhookService.js');
    const cfg = getConfig();
    expect(cfg).toHaveProperty('telegramConfigured');
    expect(cfg).toHaveProperty('webhookConfigured');
    expect(cfg).toHaveProperty('active');
    expect(cfg).toHaveProperty('v17Alerts');
  });

  it('recordPnlPoint and getPnlVelocity are callable without error', async () => {
    const { recordPnlPoint, getPnlVelocity } = await import('../server/infrastructure/alertWebhookService.js');
    expect(() => recordPnlPoint(1000, 1.5)).not.toThrow();
    const vel = getPnlVelocity();
    expect(vel === null || typeof vel === 'number').toBe(true);
  });

  it('resetAlerts clears the history buffer to empty', async () => {
    const { recordPnlPoint, resetAlerts, getAlertHistory } = await import('../server/infrastructure/alertWebhookService.js');
    recordPnlPoint(100, 0.5);
    resetAlerts();
    expect(getAlertHistory(100).length).toBe(0);
  });

  it('alertCircuitBreakerActivated is exported and resolves without throwing', async () => {
    const mod = await import('../server/infrastructure/alertWebhookService.js');
    expect(typeof mod.alertCircuitBreakerActivated).toBe('function');
    await expect(mod.alertCircuitBreakerActivated('test reason', {})).resolves.not.toThrow();
  });

  it('alertCircuitBreakerReset is exported', async () => {
    const mod = await import('../server/infrastructure/alertWebhookService.js');
    expect(typeof mod.alertCircuitBreakerReset).toBe('function');
  });
});

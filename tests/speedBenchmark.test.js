import { describe, it, expect, beforeEach } from 'vitest';
import { computeBenchmark, getHistory, resetBenchmark, POLLING_INTERVAL_MS, POLLING_AVG_WAIT_MS } from '../server/infrastructure/speedBenchmark.js';

describe('speedBenchmark', () => {
  beforeEach(() => {
    resetBenchmark();
  });

  it('exposes the documented polling constants', () => {
    expect(POLLING_INTERVAL_MS).toBe(800);
    expect(POLLING_AVG_WAIT_MS).toBe(400);
  });

  it('skips order books that are errored or missing bid/ask', () => {
    const orderBooks = [
      { exchange: 'Binance', error: 'down', source: 'ws' },
      { exchange: 'Kraken', bid: null, ask: null, source: 'ws' },
      { exchange: 'Bybit', bid: 100, ask: 100.1, source: 'ws', latencyMs: 20 },
    ];
    const result = computeBenchmark(orderBooks);
    expect(Object.keys(result.perExchange)).toEqual(['Bybit']);
    expect(result.totalExchanges).toBe(3);
  });

  it('computes wsLatencyMs and advantageMs for event-driven (ws source) feeds', () => {
    const orderBooks = [
      { exchange: 'Binance', bid: 100, ask: 100.1, source: 'ws', latencyMs: 30 },
    ];
    const result = computeBenchmark(orderBooks);
    const b = result.perExchange.Binance;
    expect(b.isEventDriven).toBe(true);
    expect(b.wsLatencyMs).toBe(30);
    // pollingDelayMs = 400 (avg wait) + 30 (network latency) = 430
    expect(b.pollingDelayMs).toBe(430);
    expect(b.advantageMs).toBe(400); // 430 - 30
    expect(result.eventDrivenCount).toBe(1);
  });

  it('treats non-ws (HTTP fallback) feeds as not event-driven with zero advantage', () => {
    const orderBooks = [
      { exchange: 'Kraken', bid: 100, ask: 100.1, source: 'http', latencyMs: 200 },
    ];
    const result = computeBenchmark(orderBooks);
    const k = result.perExchange.Kraken;
    expect(k.isEventDriven).toBe(false);
    expect(k.wsLatencyMs).toBe(200);
    expect(k.advantageMs).toBe(0);
    expect(result.eventDrivenCount).toBe(0);
  });

  it('uses POLLING_INTERVAL_MS as the effective latency for http feeds with no latencyMs', () => {
    const orderBooks = [{ exchange: 'OKX', bid: 1, ask: 1.01, source: 'http' }];
    const result = computeBenchmark(orderBooks);
    expect(result.perExchange.OKX.wsLatencyMs).toBe(800);
  });

  it('computes avgAdvantageMs as the mean across event-driven exchanges only', () => {
    const orderBooks = [
      { exchange: 'Binance', bid: 100, ask: 100.1, source: 'ws', latencyMs: 0 },
      { exchange: 'Kraken', bid: 100, ask: 100.1, source: 'ws', latencyMs: 400 },
      { exchange: 'Bybit', bid: 100, ask: 100.1, source: 'http', latencyMs: 999 },
    ];
    const result = computeBenchmark(orderBooks);
    // Binance: pollingDelay=400, advantage=400. Kraken: pollingDelay=800, advantage=400.
    expect(result.avgAdvantageMs).toBe(400);
    expect(result.eventDrivenCount).toBe(2);
  });

  it('returns avgAdvantageMs of 0 when there are no event-driven exchanges', () => {
    const orderBooks = [{ exchange: 'OKX', bid: 1, ask: 1.01, source: 'http', latencyMs: 100 }];
    const result = computeBenchmark(orderBooks);
    expect(result.avgAdvantageMs).toBe(0);
  });

  it('accumulates a rolling history capped at MAX_SAMPLES (120)', () => {
    const orderBooks = [{ exchange: 'Binance', bid: 100, ask: 100.1, source: 'ws', latencyMs: 10 }];
    for (let i = 0; i < 130; i++) computeBenchmark(orderBooks);
    const fullHistory = getHistory(200); // request more than cap
    expect(fullHistory.length).toBe(120);
  });

  it('getHistory(n) returns the n most recent samples shaped as {ts, [exchange]: wsLatencyMs}', () => {
    const orderBooks = [{ exchange: 'Binance', bid: 100, ask: 100.1, source: 'ws', latencyMs: 55 }];
    computeBenchmark(orderBooks);
    const history = getHistory(1);
    expect(history).toHaveLength(1);
    expect(history[0]).toHaveProperty('ts');
    expect(history[0].Binance).toBe(55);
  });

  it('resetBenchmark clears the rolling history', () => {
    const orderBooks = [{ exchange: 'Binance', bid: 100, ask: 100.1, source: 'ws', latencyMs: 10 }];
    computeBenchmark(orderBooks);
    expect(getHistory(10).length).toBeGreaterThan(0);
    resetBenchmark();
    expect(getHistory(10).length).toBe(0);
  });
});

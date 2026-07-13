'use strict';

/**
 * statArbEngine.test.js
 *
 * Covers detectStatArb()'s end-to-end signal pipeline (log-spread → EWMA →
 * Z-score → half-life/mean-reversion → Bollinger → confidence scoring),
 * plus getStatArbSummary() and resetStatArb(). The internal helpers
 * (updateEWMA, estimateHalfLife, bollingerPosition, updateHistory,
 * calculateZScore) are not exported, so they're exercised indirectly
 * through detectStatArb() across many synthetic order-book ticks — the
 * same way the real engine drives them from live market data.
 */

const statArb = require('../server/domain/engines/statArbEngine');

function orderBook(exchange, bid, ask, extra = {}) {
  return { exchange, bid, ask, ...extra };
}

describe('statArbEngine', () => {
  beforeEach(() => {
    statArb.resetStatArb();
  });

  describe('detectStatArb — input validation / filtering', () => {
    it('returns an empty array when given no order books', () => {
      expect(statArb.detectStatArb([])).toEqual([]);
    });

    it('returns an empty array when there is only one order book (no pairs to compare)', () => {
      const signals = statArb.detectStatArb([orderBook('Binance', 100, 100.1)]);
      expect(signals).toEqual([]);
    });

    it('filters out order books with missing bid/ask, an error flag, or non-positive prices', () => {
      const books = [
        orderBook('Binance', 100, 100.1),
        orderBook('Kraken', null, 100.2),
        orderBook('Bybit', 100.05, null),
        orderBook('OKX', 100.05, 100.15, { error: 'timeout' }),
        orderBook('Coinbase', -5, 100.15),
        orderBook('Gemini', 100.05, -1),
      ];
      // Should not throw, and with only one valid book (Binance), no pairs exist.
      expect(() => statArb.detectStatArb(books)).not.toThrow();
      expect(statArb.detectStatArb(books)).toEqual([]);
    });

    it('does not return a signal for insufficient samples (< MIN_SAMPLES ticks)', () => {
      // Feed fewer than the minimum required samples (30) — no metrics yet.
      let signals = [];
      for (let i = 0; i < 10; i++) {
        signals = statArb.detectStatArb([
          orderBook('Binance', 100.05, 100.10),
          orderBook('Kraken', 100.06, 100.11),
        ]);
      }
      expect(signals).toEqual([]);
    });
  });

  describe('detectStatArb — signal generation after warmup', () => {
    it('produces a viable long_spread signal when a large positive spread deviates from the historical mean', () => {
      // Warm up with 35 ticks of small, oscillating (mean ~0) log-spread between
      // Binance and Kraken so EWMA variance is small but non-zero.
      for (let i = 0; i < 35; i++) {
        const askA = i % 2 === 0 ? 100.10 : 100.12;
        statArb.detectStatArb([
          orderBook('Binance', 100.05, askA),
          orderBook('Kraken', 100.10, 100.15),
        ]);
      }

      // Now feed a sharp, real arbitrage-sized spread: Binance ask crashes to 90
      // while Kraken bid stays at 100.10 — a large positive log-spread jump.
      const signals = statArb.detectStatArb([
        orderBook('Binance', 89.9, 90),
        orderBook('Kraken', 100.10, 100.15),
      ]);

      const signal = signals.find(s => s.buyExchange === 'Binance' && s.sellExchange === 'Kraken');
      expect(signal).toBeDefined();
      expect(signal.type).toBe('stat_arb');
      expect(Math.abs(signal.zScore)).toBeGreaterThan(statArb.Z_THRESHOLD);
      expect(signal.direction).toBe('long_spread');
      expect(signal.pctSpread).toBeGreaterThan(0);
      expect(signal.viable).toBe(true);
      expect(signal.confidence).toBeGreaterThan(0);
      expect(signal.confidence).toBeLessThanOrEqual(99);
      expect(signal.samples).toBeGreaterThanOrEqual(30);
      expect(signal.bollinger).not.toBeNull();
      expect(typeof signal.isMeanReverting).toBe('boolean');
    });

    it('sorts signals by confidence descending', () => {
      // Warm up three exchanges so multiple directed pairs exist.
      for (let i = 0; i < 35; i++) {
        statArb.detectStatArb([
          orderBook('Binance', 100.05, 100.10 + (i % 2) * 0.01),
          orderBook('Kraken', 100.06, 100.11 + (i % 3) * 0.01),
          orderBook('Bybit', 100.07, 100.12 + (i % 2) * 0.02),
        ]);
      }

      const signals = statArb.detectStatArb([
        orderBook('Binance', 89.9, 90),
        orderBook('Kraken', 100.06, 100.11),
        orderBook('Bybit', 105, 105.5),
      ]);

      for (let i = 1; i < signals.length; i++) {
        expect(signals[i - 1].confidence).toBeGreaterThanOrEqual(signals[i].confidence);
      }
    });

    it('does not flag isStrong for signals just above Z_THRESHOLD but below Z_STRONG', () => {
      // Build up gentle history, then a moderate (not extreme) deviation.
      for (let i = 0; i < 35; i++) {
        statArb.detectStatArb([
          orderBook('Binance', 100.05, i % 2 === 0 ? 100.10 : 100.11),
          orderBook('Kraken', 100.10, 100.15),
        ]);
      }
      const signals = statArb.detectStatArb([
        orderBook('Binance', 99.5, 99.6),
        orderBook('Kraken', 100.10, 100.15),
      ]);
      const signal = signals.find(s => s.buyExchange === 'Binance' && s.sellExchange === 'Kraken');
      if (signal && Math.abs(signal.zScore) < statArb.Z_STRONG) {
        expect(signal.isStrong).toBe(false);
      }
    });
  });

  describe('getStatArbSummary', () => {
    it('returns an empty array when no pairs have been tracked', () => {
      expect(statArb.getStatArbSummary()).toEqual([]);
    });

    it('returns per-pair diagnostics after ticks have been processed', () => {
      for (let i = 0; i < 32; i++) {
        statArb.detectStatArb([
          orderBook('Binance', 100.05, 100.10),
          orderBook('Kraken', 100.06, 100.11),
        ]);
      }
      const summary = statArb.getStatArbSummary();
      expect(summary.length).toBeGreaterThan(0);

      const pair = summary.find(p => p.pair === 'Binance-Kraken');
      expect(pair).toBeDefined();
      expect(pair.samples).toBeGreaterThanOrEqual(30);
      expect(typeof pair.isMeanReverting).toBe('boolean');
    });
  });

  describe('resetStatArb', () => {
    it('clears all tracked pair history so summaries and signals restart cold', () => {
      for (let i = 0; i < 32; i++) {
        statArb.detectStatArb([
          orderBook('Binance', 100.05, 100.10),
          orderBook('Kraken', 100.06, 100.11),
        ]);
      }
      expect(statArb.getStatArbSummary().length).toBeGreaterThan(0);

      statArb.resetStatArb();

      expect(statArb.getStatArbSummary()).toEqual([]);
      // Immediately after reset, a single tick has too few samples for a signal.
      const signals = statArb.detectStatArb([
        orderBook('Binance', 89.9, 90),
        orderBook('Kraken', 100.10, 100.15),
      ]);
      expect(signals).toEqual([]);
    });
  });

  describe('exported constants', () => {
    it('exposes the quant thresholds used by the UI/tests', () => {
      expect(statArb.Z_THRESHOLD).toBe(2.0);
      expect(statArb.Z_STRONG).toBe(2.5);
      expect(statArb.MAX_HALF_LIFE).toBe(200);
      expect(statArb.EWMA_LAMBDA).toBe(0.94);
    });
  });
});

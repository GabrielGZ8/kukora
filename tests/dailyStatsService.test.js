import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as dailyStats from '../server/infrastructure/dailyStatsService.js';
import DailyStatsDoc from '../server/infrastructure/persistence/models/DailyStatsDoc.js';
// require(), not import — matches the same CJS mongoose module instance that
// dailyStatsService.js (CommonJS) uses internally. Same pattern already
// used in tests/replayService.test.js.
const mongoose = require('mongoose');

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function trade(overrides = {}) {
  return {
    ts: new Date().toISOString(),
    buyExchange: 'Binance',
    sellExchange: 'Kraken',
    netProfit: 10,
    totalFees: 1,
    ...overrides,
  };
}

describe('dailyStatsService', () => {
  beforeEach(() => {
    // reset module-level source injections between tests
    dailyStats.init({ getTradeHistory: () => [], getMissedSummary: () => null, getBestOpportunitySeen: () => null });
  });

  describe('buildDaySnapshot — date scoping (regression for the all-time-history bug)', () => {
    it('returns null when getTradeHistory is not wired', async () => {
      dailyStats.init({}); // no getTradeHistory
      await dailyStats.flush(); // should not throw
      const result = await dailyStats.getDailyStats(1);
      expect(result.days).toEqual([]);
    });

    it('returns null (no snapshot) when there are no trades at all', async () => {
      dailyStats.init({ getTradeHistory: () => [] });
      const result = await dailyStats.getDailyStats(1);
      expect(result.days).toEqual([]);
    });

    it('excludes trades from previous days when building "today"\'s snapshot', async () => {
      const oldTrade = trade({ ts: '2020-01-01T00:00:00.000Z', netProfit: 999 });
      const freshTrade = trade({ netProfit: 5 });
      dailyStats.init({
        getTradeHistory: () => [oldTrade, freshTrade],
        getMissedSummary: () => ({ captureRate: 50 }),
      });
      const result = await dailyStats.getDailyStats(1);
      expect(result.days).toHaveLength(1);
      expect(result.days[0].date).toBe(todayKey());
      expect(result.days[0].trades).toBe(1);
      expect(result.days[0].pnl).toBe(5);
    });

    it('a trade from days ago never leaks into a fresh-history day even when it is the only trade', async () => {
      const oldTrade = trade({ ts: '2020-01-01T00:00:00.000Z', netProfit: 999 });
      dailyStats.init({ getTradeHistory: () => [oldTrade] });
      const result = await dailyStats.getDailyStats(1);
      expect(result.days).toEqual([]);
    });

    it('computes winRate, fees, and pairBreakdown only from same-day trades', async () => {
      const trades = [
        trade({ ts: '2019-05-05T00:00:00.000Z', netProfit: 1000 }), // must be excluded
        trade({ netProfit: 10, totalFees: 1, buyExchange: 'Binance', sellExchange: 'Kraken' }),
        trade({ netProfit: -4, totalFees: 0.5, buyExchange: 'Binance', sellExchange: 'Kraken' }),
        trade({ netProfit: 20, totalFees: 2, buyExchange: 'OKX', sellExchange: 'Bybit' }),
      ];
      dailyStats.init({ getTradeHistory: () => trades });
      const result = await dailyStats.getDailyStats(1);
      const today = result.days[0];
      expect(today.trades).toBe(3);
      expect(today.pnl).toBeCloseTo(26, 4);
      expect(today.fees).toBeCloseTo(3.5, 4);
      expect(today.winRate).toBeCloseTo(66.7, 1);
      expect(today.pairBreakdown['Binance→Kraken'].count).toBe(2);
      expect(today.pairBreakdown['OKX→Bybit'].count).toBe(1);
    });

    it('ignores trades without a valid ISO ts field rather than crashing', async () => {
      const trades = [
        trade({ ts: undefined }),
        trade({ ts: null }),
        trade(),
      ];
      dailyStats.init({ getTradeHistory: () => trades });
      const result = await dailyStats.getDailyStats(1);
      expect(result.days[0].trades).toBe(1);
    });
  });

  describe('flush + getDailyStats persistence', () => {
    beforeEach(async () => {
      mongoose.connection.readyState = 1;
      vi.spyOn(DailyStatsDoc, 'findOneAndUpdate').mockResolvedValue({});
      vi.spyOn(DailyStatsDoc, 'find').mockReturnValue({
        sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }),
      });
    });
    afterEach(() => {
      mongoose.connection.readyState = 0;
      vi.restoreAllMocks();
    });

    it('flush() upserts a per-day doc keyed by today when trades exist', async () => {
      dailyStats.init({ getTradeHistory: () => [trade()] });
      await dailyStats.flush();
      expect(DailyStatsDoc.findOneAndUpdate).toHaveBeenCalledWith(
        { date: todayKey() },
        expect.objectContaining({ $set: expect.objectContaining({ trades: 1 }) }),
        expect.objectContaining({ upsert: true })
      );
    });

    it('flush() is a no-op when there are no trades today (avoids overwriting a real day with an empty one)', async () => {
      dailyStats.init({ getTradeHistory: () => [] });
      await dailyStats.flush();
      expect(DailyStatsDoc.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('flush() is a no-op when Mongo is not ready', async () => {
      mongoose.connection.readyState = 0;
      dailyStats.init({ getTradeHistory: () => [trade()] });
      await dailyStats.flush();
      expect(DailyStatsDoc.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('flush() swallows Mongo errors without throwing (non-fatal by design)', async () => {
      DailyStatsDoc.findOneAndUpdate.mockRejectedValueOnce(new Error('mongo down'));
      dailyStats.init({ getTradeHistory: () => [trade()] });
      await expect(dailyStats.flush()).resolves.not.toThrow();
    });

    it('recordTradeExecuted() triggers a flush without needing to be awaited', async () => {
      dailyStats.init({ getTradeHistory: () => [trade()] });
      dailyStats.recordTradeExecuted();
      await new Promise(r => setTimeout(r, 10));
      expect(DailyStatsDoc.findOneAndUpdate).toHaveBeenCalled();
    });

    it('getDailyStats merges in-memory today with persisted prior days and computes totals', async () => {
      DailyStatsDoc.find.mockReturnValue({
        sort: () => ({
          limit: () => ({
            lean: () => Promise.resolve([
              { date: '2026-01-01', trades: 2, pnl: 4, fees: 0.5, winRate: 100, captureRate: 80 },
            ]),
          }),
        }),
      });
      dailyStats.init({ getTradeHistory: () => [trade({ netProfit: 6 })] });
      const result = await dailyStats.getDailyStats(7);
      expect(result.days.length).toBe(2);
      expect(result.totals.trades).toBe(3);
      expect(result.totals.pnl).toBeCloseTo(10, 4);
      expect(result.totals.avgCaptureRate).toBe(80); // only the persisted day has captureRate
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as dailyReport from '../server/infrastructure/dailyReportService.js';
import DailyReportDoc from '../server/infrastructure/persistence/models/DailyReportDoc.js';
// require(), not import — matches the CJS mongoose module instance used
// internally by dailyReportService.js (same pattern as tests/replayService.test.js
// and tests/dailyStatsService.test.js).
const mongoose = require('mongoose');

const TODAY = '2026-07-09';

function trade(overrides = {}) {
  return {
    ts: `${TODAY}T12:00:00.000Z`,
    buyExchange: 'Binance',
    sellExchange: 'Kraken',
    netProfit: 10,
    totalFees: 1,
    score: 80,
    ...overrides,
  };
}

describe('dailyReportService', () => {
  beforeEach(() => {
    dailyReport.init({
      getTradeHistory: () => [],
      getMissedSummary: () => null,
      getBestOpportunitySeen: () => null,
      getE2EStats: () => null,
      getDailyStats: () => null,
    });
  });

  describe('generateReport — date scoping (regression for the all-time-history bug)', () => {
    it('returns null when init() was never called on this module instance', async () => {
      vi.resetModules();
      const fresh = await import('../server/infrastructure/dailyReportService.js?fresh1');
      expect(await fresh.generateReport(TODAY, 0)).toBeNull();
    });

    it('excludes trades from other days from the report for `date`', async () => {
      dailyReport.init({
        getTradeHistory: () => [
          trade({ ts: '2020-01-01T00:00:00.000Z', netProfit: 999 }),
          trade({ netProfit: 5 }),
        ],
      });
      const report = await dailyReport.generateReport(TODAY, 3_600_000);
      expect(report.data.trades).toBe(1);
      expect(report.data.pnl).toBe(5);
      expect(report.content).not.toContain('999');
    });

    it('computes pnl/fees/winRate/bestTrade/pairBreakdown only from trades matching `date`', async () => {
      const trades = [
        trade({ ts: '2019-05-05T00:00:00.000Z', netProfit: 1000 }), // must be excluded
        trade({ netProfit: 10, totalFees: 1, buyExchange: 'Binance', sellExchange: 'Kraken' }),
        trade({ netProfit: -4, totalFees: 0.5, buyExchange: 'Binance', sellExchange: 'Kraken' }),
        trade({ netProfit: 20, totalFees: 2, buyExchange: 'OKX', sellExchange: 'Bybit', score: 95 }),
      ];
      dailyReport.init({ getTradeHistory: () => trades });
      const report = await dailyReport.generateReport(TODAY, 0);
      expect(report.data.trades).toBe(3);
      expect(report.data.pnl).toBeCloseTo(26, 4);
      expect(report.data.fees).toBeCloseTo(3.5, 4);
      expect(report.data.winRate).toBeCloseTo(66.7, 1);
      expect(report.data.bestTrade.netProfit).toBe(20);
      expect(report.data.pairBreakdown['Binance→Kraken'].count).toBe(2);
      expect(report.data.pairBreakdown['OKX→Bybit'].count).toBe(1);
    });

    it('ignores trades without a valid ISO ts field rather than crashing or miscounting', async () => {
      dailyReport.init({
        getTradeHistory: () => [trade({ ts: undefined }), trade({ ts: null }), trade()],
      });
      const report = await dailyReport.generateReport(TODAY, 0);
      expect(report.data.trades).toBe(1);
    });

    it('reports zero trades (not a crash) when nothing happened on `date`', async () => {
      dailyReport.init({ getTradeHistory: () => [trade({ ts: '2019-01-01T00:00:00.000Z' })] });
      const report = await dailyReport.generateReport(TODAY, 0);
      expect(report.data.trades).toBe(0);
      expect(report.data.pnl).toBe(0);
      expect(report.data.bestTrade).toBeNull();
      expect(report.content).toContain('+$0.0000');
    });
  });

  describe('formatReport content', () => {
    it('labels captureRate as session-scoped, not day-scoped (honesty fix alongside the date-scoping fix)', async () => {
      dailyReport.init({
        getTradeHistory: () => [trade()],
        getMissedSummary: () => ({ captureRate: 42 }),
      });
      const report = await dailyReport.generateReport(TODAY, 0);
      expect(report.content).toContain('Capture rate (sesión):* 42%');
    });

    it('shows a placeholder when captureRate is unavailable', async () => {
      dailyReport.init({ getTradeHistory: () => [trade()], getMissedSummary: () => null });
      const report = await dailyReport.generateReport(TODAY, 0);
      expect(report.content).toContain('Capture rate (sesión):* —');
    });

    it('includes E2E latency line only when p50 is present', async () => {
      dailyReport.init({
        getTradeHistory: () => [trade()],
        getE2EStats: () => ({ e2e: { p50: 12, p95: 30, p99: 55 } }),
      });
      const report = await dailyReport.generateReport(TODAY, 0);
      expect(report.content).toContain('p50=12ms · p95=30ms · p99=55ms');
    });

    it('omits the pair breakdown section when there are no trades', async () => {
      dailyReport.init({ getTradeHistory: () => [] });
      const report = await dailyReport.generateReport(TODAY, 0);
      expect(report.content).not.toContain('*Por par:*');
    });
  });

  describe('sendAndPersist', () => {
    beforeEach(() => {
      mongoose.connection.readyState = 1;
      vi.spyOn(DailyReportDoc, 'findOneAndUpdate').mockResolvedValue({});
    });
    afterEach(() => {
      mongoose.connection.readyState = 0;
      vi.restoreAllMocks();
    });

    it('persists the report to Mongo keyed by date', async () => {
      dailyReport.init({ getTradeHistory: () => [trade()] });
      await dailyReport.sendAndPersist(TODAY, 0);
      expect(DailyReportDoc.findOneAndUpdate).toHaveBeenCalledWith(
        { date: TODAY },
        expect.objectContaining({ $set: expect.objectContaining({ content: expect.any(String) }) }),
        expect.objectContaining({ upsert: true })
      );
    });

    it('marks the report delivered after a successful alertService.sendRaw', async () => {
      const sendRaw = vi.fn().mockResolvedValue(true);
      dailyReport.init({ getTradeHistory: () => [trade()], alertService: { sendRaw } });
      await dailyReport.sendAndPersist(TODAY, 0);
      expect(sendRaw).toHaveBeenCalledOnce();
      expect(DailyReportDoc.findOneAndUpdate).toHaveBeenCalledWith(
        { date: TODAY }, { $set: { delivered: true } }
      );
    });

    it('still persists the report even if sending via Telegram fails (delivery is best-effort)', async () => {
      const sendRaw = vi.fn().mockRejectedValue(new Error('telegram down'));
      dailyReport.init({ getTradeHistory: () => [trade()], alertService: { sendRaw } });
      await expect(dailyReport.sendAndPersist(TODAY, 0)).resolves.toBeUndefined();
      // First call is the initial upsert; the 'delivered' update never happens
      // because sendRaw rejected — the initial persisted report is not clobbered.
      expect(DailyReportDoc.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    it('does not persist to Mongo when it is not ready, but still resolves cleanly', async () => {
      mongoose.connection.readyState = 0;
      dailyReport.init({ getTradeHistory: () => [trade()] });
      await expect(dailyReport.sendAndPersist(TODAY, 0)).resolves.toBeUndefined();
      expect(DailyReportDoc.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('swallows a total generateReport failure without throwing', async () => {
      dailyReport.init({
        getTradeHistory: () => { throw new Error('source exploded'); },
      });
      await expect(dailyReport.sendAndPersist(TODAY, 0)).resolves.toBeUndefined();
    });
  });

  describe('getRecentReports', () => {
    afterEach(() => {
      mongoose.connection.readyState = 0;
      vi.restoreAllMocks();
    });

    it('returns an empty array when Mongo is not ready', async () => {
      mongoose.connection.readyState = 0;
      expect(await dailyReport.getRecentReports()).toEqual([]);
    });

    it('maps persisted docs into the summary shape the history panel expects', async () => {
      mongoose.connection.readyState = 1;
      vi.spyOn(DailyReportDoc, 'find').mockReturnValue({
        sort: () => ({
          limit: () => ({
            lean: () => Promise.resolve([
              { date: TODAY, delivered: true, sentAt: new Date(), content: 'x'.repeat(200), data: { pnl: 5, trades: 1, winRate: 100 } },
            ]),
          }),
        }),
      });
      const result = await dailyReport.getRecentReports(1);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ date: TODAY, delivered: true, pnl: 5, trades: 1, winRate: 100 });
      expect(result[0].preview).toHaveLength(120);
    });

    it('returns an empty array (not a throw) if the Mongo query fails', async () => {
      mongoose.connection.readyState = 1;
      vi.spyOn(DailyReportDoc, 'find').mockImplementation(() => { throw new Error('boom'); });
      expect(await dailyReport.getRecentReports()).toEqual([]);
    });
  });
});

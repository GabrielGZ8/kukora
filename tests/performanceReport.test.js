import { describe, it, expect, beforeEach } from 'vitest';
import { generateJsonReport, generateHtmlReport, generateExecutiveSummary } from '../server/domain/analytics/performanceReport.js';

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

describe('performanceReport', () => {
  beforeEach(() => {
    auditedPnl.initSession(wallets(110000, 1), 50000);
  });

  describe('generateJsonReport — empty session', () => {
    const emptySession = { equityCurve: [], executions: [], wallets: null, btcPrice: 50000, uptimeMs: 0, params: {} };

    it('returns a fully-shaped report with null institutional metrics when there is no equity curve / executions', () => {
      const report = generateJsonReport(emptySession);
      expect(report.meta.reportVersion).toBe('v17');
      expect(report.meta.sessionUptimeHuman).toBe('0s');
      expect(report.institutional).toBeNull();
      expect(report.institutionalReport).toBeNull();
      expect(report.grade).toBeNull();
      expect(report.pnl.realizedPnl).toBe(0);
      expect(report.trades.total).toBe(0);
      expect(report.disclaimer).toContain('Simulated performance');
    });

    it('profitPerHour and profitPerTrade are null when uptime/trades are zero', () => {
      const report = generateJsonReport(emptySession);
      expect(report.pnl.profitPerHour).toBeNull();
      expect(report.pnl.profitPerTrade).toBeNull();
    });

    it('recommendation is an empty array when institutionalMetrics is null', () => {
      const report = generateJsonReport(emptySession);
      expect(report.recommendation).toEqual([]);
    });
  });

  describe('generateJsonReport — with recorded trades', () => {
    function buildSessionWithTrades() {
      const before = wallets(110000, 1);
      const after = wallets(110000.5, 1);
      const entry = auditedPnl.recordAuditedTrade(baseTrade({ netProfit: 0.5 }), before, after, 50000);
      const after2 = wallets(110000.5 - 0.2, 1);
      auditedPnl.recordAuditedTrade(baseTrade({ id: 't2', netProfit: -0.2 }), after, after2, 50000);
      return {
        equityCurve: [{ equity: 10000 }, { equity: 10000.5 }, { equity: 10000.3 }],
        executions: [baseTrade({ netProfit: 0.5 }), baseTrade({ id: 't2', netProfit: -0.2 })],
        wallets: after2,
        btcPrice: 50000,
        uptimeMs: 3_600_000, // 1 hour
        params: {},
      };
    }

    it('computes non-null institutional metrics and a grade once there are 2+ equity points and 1+ execution', () => {
      const report = generateJsonReport(buildSessionWithTrades());
      expect(report.institutional).not.toBeNull();
      expect(report.institutionalReport).not.toBeNull();
      expect(report.grade).not.toBeNull();
    });

    it('reflects the recorded trade totals in the trades section', () => {
      const report = generateJsonReport(buildSessionWithTrades());
      expect(report.trades.total).toBe(2);
      expect(report.trades.winning).toBe(1);
      expect(report.trades.losing).toBe(1);
    });

    it('computes profitPerHour using the realized P&L divided by uptime hours', () => {
      const report = generateJsonReport(buildSessionWithTrades());
      expect(report.pnl.profitPerHour).toBeCloseTo(report.pnl.realizedPnl / 1, 4);
    });

    it('includes daily ledger and exchange health sections', () => {
      const report = generateJsonReport(buildSessionWithTrades());
      expect(report.dailyLedger).toBeDefined();
      expect(report.exchangeHealth).toBeDefined();
    });
  });

  describe('generateHtmlReport', () => {
    it('renders a complete HTML document including the realized P&L and disclaimer', () => {
      const html = generateHtmlReport({ equityCurve: [], executions: [], wallets: null, btcPrice: 50000, uptimeMs: 0, params: {} });
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('kukora');
      expect(html).toContain('Simulated performance');
      expect(html).toContain('P&L Summary');
      expect(html).toContain('Trade Statistics');
    });

    it('omits the Risk-Adjusted Performance section when institutional metrics are null', () => {
      const html = generateHtmlReport({ equityCurve: [], executions: [], wallets: null, btcPrice: 50000, uptimeMs: 0, params: {} });
      expect(html).not.toContain('Risk-Adjusted Performance');
    });
  });

  describe('generateExecutiveSummary', () => {
    it('produces a short text summary including uptime, realized P&L, and audit status', () => {
      const summary = generateExecutiveSummary({ equityCurve: [], executions: [], wallets: null, btcPrice: 50000, uptimeMs: 0, params: {} });
      expect(summary).toContain('PERFORMANCE REPORT');
      expect(summary).toContain('Uptime');
      expect(summary).toContain('Realized P&L');
      expect(summary).toContain('Audit');
    });

    it('reports reconciled audit status when there are no reconciliation errors', () => {
      const summary = generateExecutiveSummary({ equityCurve: [], executions: [], wallets: null, btcPrice: 50000, uptimeMs: 0, params: {} });
      expect(summary).toContain('Audit: Reconciled');
    });
  });
});

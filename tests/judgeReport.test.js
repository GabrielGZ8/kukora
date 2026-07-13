import { describe, it, expect } from 'vitest';
import { generateJudgeReportHtml } from '../server/domain/analytics/judgeReport.js';

describe('judgeReport', () => {
  it('renders a well-formed self-contained HTML document with no data', () => {
    const html = generateJudgeReportHtml({});
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('Kukora');
  });

  it('shows honest "no data" messaging when institutional/validation are null', () => {
    const html = generateJudgeReportHtml({ institutional: null, validation: null });
    expect(html).toContain('No opportunity log data yet');
  });

  it('renders institutional metrics when provided', () => {
    const html = generateJudgeReportHtml({
      institutional: {
        metrics: {
          sharpeRatio: 1.8, sortinoRatio: 2.1, calmarRatio: 3.2,
          profitFactor: 1.5, kellyCriterion: 0.12, valueAtRisk95: -120.5,
          omegaRatio: 1.9, maxDrawdown: 4.2,
        },
      },
    });
    expect(html).toContain('Sharpe Ratio');
    expect(html).toContain('1.80');
  });

  it('renders significant validation verdict with honest text', () => {
    const html = generateJudgeReportHtml({
      validation: {
        overall: {
          sampleSize: 240, meanNetPnl: 1.35, ci: [0.42, 2.28],
          pValue: 0.01, significant: true, honest: 'Edge is statistically significant.',
        },
        consistency: 'Consistent across 4 windows.',
      },
    });
    expect(html).toContain('Edge is statistically significant.');
    expect(html).toContain('YES');
  });

  it('renders stress test section with active scenario', () => {
    const html = generateJudgeReportHtml({
      stressTest: {
        active: { type: 'fee_spike', label: 'Fee Spike', activeForMs: 15000 },
        availableScenarios: [{ type: 'fee_spike', label: 'Fee Spike' }, { type: 'liquidity_drop', label: 'Liquidity Drop' }],
      },
    });
    expect(html).toContain('Fee Spike');
    expect(html).toContain('Scenarios registered');
  });

  it('renders tenant snapshot table when tenants are active', () => {
    const html = generateJudgeReportHtml({
      tenants: [
        { uid: 'demo-conservative', isDemo: true, enabled: true, pnl: 12.4, trades: 8, riskTripped: false },
        { uid: 'demo-aggressive', isDemo: true, enabled: true, pnl: -3.1, trades: 15, riskTripped: true },
      ],
    });
    expect(html).toContain('demo-conservative');
    expect(html).toContain('TRIPPED');
  });

  it('escapes HTML in dynamic string fields to avoid injection', () => {
    const html = generateJudgeReportHtml({
      architecture: { overview: '<script>alert(1)</script>', modules: [] },
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

/**
 * performanceReport.js — Kukora v17
 *
 * Generador de reportes de performance institucionales.
 *
 * FORMATOS:
 *   - JSON estructurado (para API)
 *   - HTML completo (para descarga / email / inversores)
 *   - CSV de trades (para auditoría / Excel)
 *   - Resumen ejecutivo en texto (para Telegram/Slack)
 *
 * CONTENIDO DEL REPORTE:
 *   - P&L auditado (realizado + irealizado + reconciliación)
 *   - Métricas institucionales (Sharpe, Sortino, Calmar, Kelly, VaR, Omega)
 *   - Desglose por exchange pair y tipo de estrategia
 *   - Drawdown y curva de equity
 *   - Calidad de ejecución (profit capture, fill quality)
 *   - Recomendaciones operacionales
 */

'use strict';

const instBacktest = require('../engines/institutionalBacktest');
const auditedPnl   = require('../wallet/auditedPnl');
const obs          = require('../../infrastructure/observabilityService');

// ─── JSON Report ──────────────────────────────────────────────────────────

function generateJsonReport(sessionData) {
  const {
    equityCurve = [], executions = [],
    wallets, btcPrice, uptimeMs,
    params = {},
  } = sessionData;

  const pnlData    = auditedPnl.getAuditedPnl(wallets, btcPrice);
  const execQuality = obs.getExecutionQualityStats();
  const rcaSummary  = obs.getRCASummary();
  const exchHealth  = obs.getExchangeHealth();
  const dailyLedger = auditedPnl.getDailyLedger();

  // Institutional metrics from equity curve
  // Shape here must satisfy SimResult (server/domain/engines/simResult.js,
  // audit roadmap #1) — computeInstitutionalMetrics() validates it with
  // isSimResult() as a soft contract check on the way in.
  let institutionalMetrics = null;
  let institutionalReport  = null;
  if (equityCurve.length >= 2 && executions.length >= 1) {
    const simResult = { executions, equityCurve, totalNetProfit: pnlData.realizedPnl, params };
    institutionalMetrics = instBacktest.computeInstitutionalMetrics(simResult);
    institutionalReport  = instBacktest.generateInstitutionalReport(simResult);
  }

  const uptimeHours = uptimeMs / 3_600_000;

  return {
    meta: {
      generatedAt:    new Date().toISOString(),
      reportVersion:  'v17',
      sessionUptimeMs: uptimeMs,
      sessionUptimeHuman: formatUptime(uptimeMs),
      btcPriceAtReport: btcPrice,
    },

    pnl: {
      // P&L realizado (auditado)
      realizedPnl:     pnlData.realizedPnl,
      grossProfit:     pnlData.grossProfit,
      totalFees:       pnlData.totalFees,
      totalSlippage:   pnlData.totalSlippage,
      // P&L irealizado (mark-to-market)
      unrealizedPnl:   pnlData.unrealizedPnl,
      totalPnl:        pnlData.totalPnl,
      // Audit
      reconciled:      pnlData.reconciled,
      reconciliationErrors: pnlData.reconciliationErrors,
      // Rates
      profitPerHour:   uptimeHours > 0 ? +(pnlData.realizedPnl / uptimeHours).toFixed(4) : null,
      profitPerTrade:  pnlData.totalTrades > 0 ? +(pnlData.realizedPnl / pnlData.totalTrades).toFixed(4) : null,
    },

    trades: {
      total:        pnlData.totalTrades,
      winning:      pnlData.winningTrades,
      losing:       pnlData.losingTrades,
      winRate:      pnlData.winRate,
      avgWin:       pnlData.avgWin,
      avgLoss:      pnlData.avgLoss,
      best:         pnlData.bestTrade,
      worst:        pnlData.worstTrade,
      byPair:       pnlData.byExchangePair,
      byType:       pnlData.byType,
    },

    institutional:  institutionalMetrics,
    institutionalReport,

    executionQuality: {
      avgProfitCapture:    execQuality.avgProfitCapture,
      avgFillQuality:      execQuality.avgFillQuality,
      totalMissedProfit:   execQuality.totalMissedProfit,
      avgExecutionLatency: execQuality.avgExecutionLatency,
      byVerdict:           execQuality.byVerdict,
    },

    rejectionAnalysis: {
      totalRejections: rcaSummary.totalRejections,
      topReasons:      rcaSummary.topReasons,
    },

    exchangeHealth:   exchHealth,
    dailyLedger,

    grade:           institutionalMetrics?.grade || null,
    recommendation:  generateRecommendation(pnlData, institutionalMetrics, execQuality),
    disclaimer:      'Simulated performance. Past results do not guarantee future returns.',
  };
}

// ─── HTML Report ──────────────────────────────────────────────────────────

function generateHtmlReport(sessionData) {
  const report = generateJsonReport(sessionData);
  const m      = report.institutional;
  const p      = report.pnl;

  const gradeColor = {
    'A+': '#00b87a', A: '#00b87a', B: '#f59e0b', C: '#f97316', D: '#ef4444',
  }[report.grade?.grade] || '#888';

  const metric = (label, value, color = '#e2e8f0', sub = '') => `
    <div class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value" style="color:${color}">${value}</div>
      ${sub ? `<div class="metric-sub">${sub}</div>` : ''}
    </div>`;

  const fmt     = (n, d = 2) => n == null ? '—' : Number(n).toFixed(d);
  const fmtUSD  = n => n == null ? '—' : `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kukora Performance Report — ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0f1e; color: #e2e8f0; line-height: 1.5; }
  .container { max-width: 960px; margin: 0 auto; padding: 32px 24px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid #1e2a3a; padding-bottom: 24px; margin-bottom: 32px; }
  .logo { font-size: 28px; font-weight: 900; letter-spacing: -0.04em; color: #00b87a; }
  .logo span { color: #e2e8f0; }
  .report-meta { text-align: right; font-size: 12px; color: #64748b; }
  .grade-badge { display: inline-block; background: ${gradeColor}22; color: ${gradeColor}; border: 1px solid ${gradeColor}44; border-radius: 8px; padding: 6px 20px; font-size: 32px; font-weight: 900; }
  .section { margin-bottom: 40px; }
  .section-title { font-size: 11px; font-weight: 700; letter-spacing: 0.1em; color: #64748b; text-transform: uppercase; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid #1e2a3a; }
  .metric-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
  .metric-card { background: #0d1525; border: 1px solid #1e2a3a; border-radius: 10px; padding: 16px; }
  .metric-label { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; color: #64748b; text-transform: uppercase; margin-bottom: 6px; }
  .metric-value { font-size: 22px; font-weight: 800; font-family: 'SF Mono', 'Cascadia Code', monospace; }
  .metric-sub { font-size: 10px; color: #64748b; margin-top: 3px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 8px 12px; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; color: #64748b; text-transform: uppercase; border-bottom: 1px solid #1e2a3a; }
  td { padding: 8px 12px; border-bottom: 1px solid #0d1525; font-family: 'SF Mono', 'Cascadia Code', monospace; }
  tr:hover td { background: #0d1525; }
  .positive { color: #00b87a; }
  .negative { color: #ef4444; }
  .warn { color: #f59e0b; }
  .disclaimer { font-size: 11px; color: #334155; margin-top: 40px; padding-top: 16px; border-top: 1px solid #1e2a3a; }
  .recommendation { background: #0d1525; border: 1px solid #1e2a3a; border-left: 3px solid #00b87a; border-radius: 8px; padding: 16px; margin-top: 16px; font-size: 13px; }
  .reco-item { padding: 6px 0; color: #94a3b8; }
  .reco-item::before { content: '→ '; color: #00b87a; font-weight: 700; }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <div>
      <div class="logo">kukora<span>.arb</span></div>
      <div style="font-size:12px;color:#64748b;margin-top:4px">Performance Report — ${report.meta.sessionUptimeHuman} session</div>
    </div>
    <div class="report-meta">
      <div class="grade-badge">${report.grade?.grade || '—'}</div>
      <div style="margin-top:8px;font-size:11px;color:#64748b">${report.grade?.label || ''}</div>
      <div style="margin-top:4px">Generated: ${new Date(report.meta.generatedAt).toLocaleString()}</div>
      <div>BTC @ $${(report.meta.btcPriceAtReport || 0).toLocaleString()}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">P&L Summary</div>
    <div class="metric-grid">
      ${metric('Realized P&L', fmtUSD(p.realizedPnl), p.realizedPnl >= 0 ? '#00b87a' : '#ef4444')}
      ${metric('Gross Profit', fmtUSD(p.grossProfit), '#94a3b8', 'before fees & slippage')}
      ${metric('Total Fees', `-$${Math.abs(p.totalFees || 0).toFixed(4)}`, '#f59e0b')}
      ${metric('Total Slippage', `-$${Math.abs(p.totalSlippage || 0).toFixed(4)}`, '#f59e0b')}
      ${metric('Unrealized P&L', p.unrealizedPnl != null ? fmtUSD(p.unrealizedPnl) : '—', p.unrealizedPnl >= 0 ? '#94a3b8' : '#f59e0b', 'mark-to-market')}
      ${metric('Per Trade', fmtUSD(p.profitPerTrade), '#94a3b8')}
      ${metric('Per Hour', fmtUSD(p.profitPerHour), '#94a3b8')}
      ${metric('Audit', p.reconciled ? '✓ Reconciled' : `⚠ ${p.reconciliationErrors} errors`, p.reconciled ? '#00b87a' : '#ef4444')}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Trade Statistics</div>
    <div class="metric-grid">
      ${metric('Total Trades', report.trades.total)}
      ${metric('Win Rate', report.trades.winRate != null ? `${report.trades.winRate}%` : '—', report.trades.winRate >= 55 ? '#00b87a' : '#f59e0b')}
      ${metric('Avg Win', fmtUSD(report.trades.avgWin), '#00b87a')}
      ${metric('Avg Loss', fmtUSD(report.trades.avgLoss), '#ef4444')}
      ${metric('Best Trade', fmtUSD(report.trades.best), '#00b87a')}
      ${metric('Worst Trade', fmtUSD(report.trades.worst), '#ef4444')}
    </div>
  </div>

  ${m ? `
  <div class="section">
    <div class="section-title">Risk-Adjusted Performance</div>
    <div class="metric-grid">
      ${metric('Sharpe Ratio', fmt(m.sharpeRatio, 3), m.sharpeRatio > 2 ? '#00b87a' : m.sharpeRatio > 1 ? '#f59e0b' : '#ef4444', 'annualized')}
      ${metric('Sortino Ratio', fmt(m.sortinoRatio, 3), m.sortinoRatio > 2 ? '#00b87a' : '#f59e0b', 'annualized')}
      ${metric('Calmar Ratio', fmt(m.calmarRatio, 3), m.calmarRatio > 1 ? '#00b87a' : '#f59e0b')}
      ${metric('Profit Factor', fmt(m.profitFactor, 3), m.profitFactor > 2 ? '#00b87a' : m.profitFactor > 1 ? '#f59e0b' : '#ef4444')}
      ${metric('Max Drawdown', `${fmt(m.maxDrawdownPct, 2)}%`, m.maxDrawdownPct < 5 ? '#00b87a' : m.maxDrawdownPct < 10 ? '#f59e0b' : '#ef4444')}
      ${metric('VaR 95%', fmtUSD(m.valueAtRisk95), '#94a3b8', 'per trade')}
      ${metric('Omega Ratio', fmt(m.omegaRatio, 3), m.omegaRatio > 1 ? '#00b87a' : '#ef4444')}
      ${metric('Recovery Factor', fmt(m.recoveryFactor, 2), m.recoveryFactor > 1 ? '#00b87a' : '#f59e0b')}
      ${metric('Kelly (half)', m.kellyCriterion?.halfKelly != null ? `${m.kellyCriterion.halfKelly}%` : '—', '#94a3b8', 'recommended size')}
      ${metric('Time in DD', `${fmt(m.timeInDrawdownPct, 1)}%`, m.timeInDrawdownPct < 30 ? '#00b87a' : '#f59e0b', 'of session')}
    </div>
  </div>
  ` : ''}

  <div class="section">
    <div class="section-title">Execution Quality</div>
    <div class="metric-grid">
      ${metric('Profit Capture', report.executionQuality.avgProfitCapture != null ? `${(report.executionQuality.avgProfitCapture * 100).toFixed(1)}%` : '—', report.executionQuality.avgProfitCapture >= 0.9 ? '#00b87a' : '#f59e0b', 'realized/expected')}
      ${metric('Fill Quality', report.executionQuality.avgFillQuality != null ? `${(report.executionQuality.avgFillQuality * 100).toFixed(1)}%` : '—', '#94a3b8')}
      ${metric('Missed Profit', fmtUSD(-(report.executionQuality.totalMissedProfit || 0)), '#f59e0b', 'slippage loss')}
      ${metric('Avg Latency', report.executionQuality.avgExecutionLatency != null ? `${report.executionQuality.avgExecutionLatency.toFixed(0)}ms` : '—', '#94a3b8')}
    </div>
  </div>

  ${report.recommendation?.length > 0 ? `
  <div class="section">
    <div class="section-title">Operational Recommendations</div>
    <div class="recommendation">
      ${report.recommendation.map(r => `<div class="reco-item">${r}</div>`).join('')}
    </div>
  </div>
  ` : ''}

  <div class="section">
    <div class="section-title">P&L by Exchange Pair</div>
    <table>
      <thead><tr><th>Pair</th><th>Net P&L</th></tr></thead>
      <tbody>
        ${Object.entries(report.trades.byPair || {}).sort(([,a],[,b])=>b-a).map(([pair, pnl]) => `
        <tr>
          <td>${pair}</td>
          <td class="${pnl >= 0 ? 'positive' : 'negative'}">${fmtUSD(pnl)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>

  <div class="disclaimer">
    ${report.disclaimer}<br>
    Generated by Kukora v17 | Session: ${report.meta.sessionUptimeHuman} | Trades: ${report.trades.total}
  </div>

</div>
</body>
</html>`;
}

// ─── Executive text summary ───────────────────────────────────────────────

function generateExecutiveSummary(sessionData) {
  const report = generateJsonReport(sessionData);
  const p      = report.pnl;
  const m      = report.institutional;

  const lines = [
    `📊 *PERFORMANCE REPORT — Kukora v17*`,
    ``,
    `⏱ Uptime: \`${report.meta.sessionUptimeHuman}\``,
    `💰 Realized P&L: \`${p.realizedPnl >= 0 ? '+' : ''}$${p.realizedPnl?.toFixed(4)}\``,
    `📈 Trades: \`${report.trades.total}\` | Win rate: \`${report.trades.winRate}%\``,
    `🏆 Grade: \`${report.grade?.grade || '—'}\` (${report.grade?.label || ''})`,
    ``,
    m ? [
      `📐 Sharpe: \`${m.sharpeRatio?.toFixed(3) ?? '—'}\` | Sortino: \`${m.sortinoRatio?.toFixed(3) ?? '—'}\``,
      `📉 Max DD: \`${m.maxDrawdownPct?.toFixed(2)}%\` | Profit Factor: \`${m.profitFactor?.toFixed(3)}\``,
    ].join('\n') : '',
    ``,
    `✅ Audit: ${p.reconciled ? 'Reconciled' : `${p.reconciliationErrors} errors`}`,
  ].filter(Boolean).join('\n');

  return lines;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function generateRecommendation(pnlData, institutionalMetrics, execQuality) {
  const recs = [];
  if (!institutionalMetrics) return recs;

  if ((institutionalMetrics.sharpeRatio || 0) < 1) {
    recs.push('Sharpe Ratio < 1: consider increasing minScore to filter lower-quality opportunities');
  }
  if ((institutionalMetrics.maxDrawdownPct || 0) > 10) {
    recs.push('Max drawdown > 10%: reduce maxCapitalPerTrade or tighten maxDrawdownPct limit');
  }
  if ((execQuality.avgProfitCapture || 1) < 0.80) {
    recs.push('Profit capture < 80%: slippage estimation may be underestimating real market impact — review slippageMethod');
  }
  if ((pnlData.totalFees || 0) > Math.abs(pnlData.realizedPnl || 0) * 0.3) {
    recs.push('Fees consuming >30% of gross profit: consider enabling maker fees or increasing minNetProfitUSD');
  }
  if ((institutionalMetrics.winRate || 0) < 50) {
    recs.push('Win rate < 50%: review minScore threshold — some opportunities may not be viable after fees');
  }
  if (institutionalMetrics.kellyCriterion?.fullKelly < 0) {
    recs.push('Negative Kelly: strategy has no statistical edge at current parameters — do not increase position size');
  }
  return recs;
}

function formatUptime(ms) {
  if (!ms) return '0s';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h > 0)  return `${h}h ${m % 60}m`;
  if (m > 0)  return `${m}m ${s % 60}s`;
  return `${s}s`;
}

module.exports = {
  generateJsonReport,
  generateHtmlReport,
  generateExecutiveSummary,
};

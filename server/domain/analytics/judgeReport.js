'use strict';

/**
 * judgeReport.js — Kukora v2.22.0 (Iniciativa 5 del plan competitivo)
 *
 * Genera un HTML autocontenido (sin dependencias externas — todo el CSS
 * es inline, cero requests a CDN) que un jurado puede abrir offline y
 * entender la plataforma en un vistazo, sin tener que navegar 27 páginas
 * distintas del dashboard ni leer 18+ ADRs uno por uno.
 *
 * DISEÑO: este módulo es puramente una función de renderizado — recibe
 * TODOS los datos ya calculados como parámetros (mismo criterio de
 * inyección de dependencias que `statisticalValidation.validateEdge()`
 * usa con `simulateRun`), no vuelve a calcular nada ni importa los
 * motores de negocio directamente. Esto evita requires circulares y hace
 * que el generador sea trivialmente testeable con fixtures a mano.
 *
 * Combina, en una sola pantalla:
 *   1. Resumen de arquitectura (multi-tenant, RBAC, event sourcing, etc.)
 *   2. Backtest institucional (Sharpe/Sortino/Calmar/Kelly/VaR/Omega)
 *   3. Validación estadística del edge (bootstrap CI + significancia, ADR-019)
 *   4. Resultado más reciente de stress test / escenarios adversos
 *   5. Snapshot de la comparación multi-tenant (si hay tenants activos)
 *   6. Índice de ADRs relevantes
 *
 * Honestidad ante ausencia de datos: cada sección que no tiene datos
 * suficientes lo dice explícitamente ("sin datos aún", "sesión sin
 * trades") en vez de mostrar una tabla vacía sin contexto o inventar
 * números — mismo principio que rige statisticalValidation.js (ADR-019)
 * y el resto del README ("Explains rejections").
 */

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmt(n, d = 2) {
  return (n === null || n === undefined || Number.isNaN(n)) ? '—' : Number(n).toFixed(d);
}

function fmtUSD(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
}

function metricCard(label, value, color = '#e2e8f0', sub = '') {
  return `
    <div class="metric-card">
      <div class="metric-label">${esc(label)}</div>
      <div class="metric-value" style="color:${color}">${esc(value)}</div>
      ${sub ? `<div class="metric-sub">${esc(sub)}</div>` : ''}
    </div>`;
}

// ─── Sección: Arquitectura ──────────────────────────────────────────────────
function renderArchitectureSection(architecture = {}) {
  const {
    overview = 'Kukora is a multi-exchange quantitative BTC arbitrage platform (Binance, Kraken, Bybit, OKX, Coinbase).',
    modules = [],
  } = architecture;

  const moduleRows = modules.length
    ? modules.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.description)}</td></tr>`).join('')
    : '<tr><td colspan="2" class="muted">No module list provided.</td></tr>';

  return `
  <div class="section">
    <div class="section-title">Architecture Summary</div>
    <p class="overview-text">${esc(overview)}</p>
    <table>
      <thead><tr><th>Module</th><th>What it does</th></tr></thead>
      <tbody>${moduleRows}</tbody>
    </table>
  </div>`;
}

// ─── Sección: Backtest institucional ───────────────────────────────────────
function renderInstitutionalSection(institutional) {
  if (!institutional) {
    return `
  <div class="section">
    <div class="section-title">Institutional Backtest</div>
    <p class="muted">No opportunity log data yet — let the engine run for a while before generating this report.</p>
  </div>`;
  }
  const m = institutional.metrics || {};
  return `
  <div class="section">
    <div class="section-title">Institutional Backtest</div>
    <div class="metric-grid">
      ${metricCard('Sharpe Ratio', fmt(m.sharpeRatio), m.sharpeRatio >= 1 ? '#00b87a' : '#f59e0b')}
      ${metricCard('Sortino Ratio', fmt(m.sortinoRatio), m.sortinoRatio >= 1 ? '#00b87a' : '#f59e0b')}
      ${metricCard('Calmar Ratio', fmt(m.calmarRatio))}
      ${metricCard('Profit Factor', fmt(m.profitFactor))}
      ${metricCard('Kelly Criterion', fmt(m.kellyCriterion, 4))}
      ${metricCard('VaR (95%)', fmtUSD(m.valueAtRisk95), m.valueAtRisk95 < 0 ? '#ef4444' : '#00b87a')}
      ${metricCard('Omega Ratio', fmt(m.omegaRatio))}
      ${metricCard('Max Drawdown', fmt(m.maxDrawdown) + '%', '#ef4444')}
    </div>
  </div>`;
}

// ─── Sección: Validación estadística del edge (ADR-019) ────────────────────
function renderValidationSection(validation) {
  if (!validation || !validation.overall) {
    return `
  <div class="section">
    <div class="section-title">Statistical Edge Validation <span class="tag">ADR-019</span></div>
    <p class="muted">${esc(validation?.honest || 'No opportunity log data yet.')}</p>
  </div>`;
  }
  const o = validation.overall;
  const verdictColor = !o.significant ? '#f59e0b' : (o.meanNetPnl > 0 ? '#00b87a' : '#ef4444');
  return `
  <div class="section">
    <div class="section-title">Statistical Edge Validation <span class="tag">ADR-019</span></div>
    <div class="metric-grid">
      ${metricCard('Sample Size', o.sampleSize)}
      ${metricCard('Mean Net P&L / trade', fmtUSD(o.meanNetPnl), verdictColor)}
      ${metricCard('95% CI', o.ci?.[0] != null ? `[${fmt(o.ci[0], 4)}, ${fmt(o.ci[1], 4)}]` : '—')}
      ${metricCard('p-value', o.pValue != null ? fmt(o.pValue, 4) : '—')}
      ${metricCard('Significant?', o.significant ? 'YES' : 'NO', verdictColor)}
    </div>
    <div class="honest-verdict" style="border-left-color:${verdictColor}">${esc(o.honest)}</div>
    <p class="muted" style="margin-top:12px">${esc(validation.consistency || '')}</p>
  </div>`;
}

// ─── Sección: Stress test / escenarios adversos ─────────────────────────────
function renderStressTestSection(stressTest) {
  if (!stressTest) {
    return `
  <div class="section">
    <div class="section-title">Stress Test / Adversarial Scenarios</div>
    <p class="muted">No stress test data available.</p>
  </div>`;
  }
  const { active, availableScenarios = [] } = stressTest;
  const scenarioList = availableScenarios.length
    ? availableScenarios.map((s) => `<li>${esc(s.label || s.type)}</li>`).join('')
    : '<li class="muted">None registered</li>';
  return `
  <div class="section">
    <div class="section-title">Stress Test / Adversarial Scenarios</div>
    <div class="metric-grid">
      ${metricCard('Currently active', active ? (active.label || active.type) : 'none', active ? '#f59e0b' : '#00b87a')}
      ${active ? metricCard('Active for', Math.round((active.activeForMs || 0) / 1000) + 's') : ''}
      ${metricCard('Scenarios registered', availableScenarios.length)}
    </div>
    <ul class="adr-list" style="margin-top:10px">${scenarioList}</ul>
  </div>`;
}

// ─── Sección: Snapshot multi-tenant ─────────────────────────────────────────
function renderTenantSection(tenants = []) {
  if (!tenants.length) {
    return `
  <div class="section">
    <div class="section-title">Multi-Tenant Snapshot</div>
    <p class="muted">No tenants currently active. Visit the Tenant Comparison page to start a demo.</p>
  </div>`;
  }
  const rows = tenants.map((t) => `
    <tr>
      <td>${esc(t.uid)}${t.isDemo ? ' <span class="tag">DEMO</span>' : ''}</td>
      <td>${t.enabled ? '<span class="positive">ON</span>' : '<span class="muted">OFF</span>'}</td>
      <td class="${t.pnl >= 0 ? 'positive' : 'negative'}">${fmtUSD(t.pnl)}</td>
      <td>${t.trades ?? '—'}</td>
      <td>${t.riskTripped ? '<span class="negative">TRIPPED</span>' : '<span class="positive">OK</span>'}</td>
    </tr>`).join('');

  return `
  <div class="section">
    <div class="section-title">Multi-Tenant Snapshot</div>
    <table>
      <thead><tr><th>Tenant</th><th>Bot</th><th>P&L</th><th>Trades</th><th>Risk Guard</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ─── Sección: índice de ADRs ────────────────────────────────────────────────
function renderAdrSection(adrs = []) {
  if (!adrs.length) return '';
  const items = adrs.map((a) => `<li><strong>${esc(a.id)}</strong> — ${esc(a.title)}</li>`).join('');
  return `
  <div class="section">
    <div class="section-title">Relevant Architecture Decision Records</div>
    <ul class="adr-list">${items}</ul>
  </div>`;
}

/**
 * @param {object} data
 * @param {object} [data.architecture] - { overview, modules: [{name, description}] }
 * @param {object|null} [data.institutional] - { metrics, report } (shape from institutionalBacktest.js)
 * @param {object|null} [data.validation] - shape from statisticalValidation.validateEdge()
 * @param {object|null} [data.stressTest] - { active, lastResult }
 * @param {Array} [data.tenants] - [{ uid, isDemo, enabled, pnl, trades, riskTripped }]
 * @param {Array} [data.adrs] - [{ id, title }]
 * @returns {string} self-contained HTML document
 */
function generateJudgeReportHtml(data = {}) {
  const { architecture, institutional, validation, stressTest, tenants, adrs } = data;
  const generatedAt = new Date().toLocaleString('en-US', {
    dateStyle: 'long', timeStyle: 'short',
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kukora — Judge Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0f1e; color: #e2e8f0; line-height: 1.5; }
  .container { max-width: 1000px; margin: 0 auto; padding: 32px 24px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid #1e2a3a; padding-bottom: 24px; margin-bottom: 32px; }
  .logo { font-size: 30px; font-weight: 900; letter-spacing: -0.04em; color: #00b87a; }
  .logo span { color: #e2e8f0; }
  .subtitle { color: #64748b; font-size: 13px; margin-top: 4px; }
  .report-meta { text-align: right; font-size: 12px; color: #64748b; }
  .section { margin-bottom: 40px; }
  .section-title { font-size: 12px; font-weight: 700; letter-spacing: 0.1em; color: #64748b; text-transform: uppercase; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid #1e2a3a; display:flex; align-items:center; gap:8px; }
  .tag { background: #00b87a22; color: #00b87a; border: 1px solid #00b87a44; border-radius: 5px; padding: 1px 7px; font-size: 10px; font-weight: 700; text-transform: none; letter-spacing: 0; }
  .metric-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
  .metric-card { background: #0d1525; border: 1px solid #1e2a3a; border-radius: 10px; padding: 16px; }
  .metric-label { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; color: #64748b; text-transform: uppercase; margin-bottom: 6px; }
  .metric-value { font-size: 20px; font-weight: 800; font-family: 'SF Mono', 'Cascadia Code', monospace; }
  .metric-sub { font-size: 10px; color: #64748b; margin-top: 3px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  th { text-align: left; padding: 8px 12px; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; color: #64748b; text-transform: uppercase; border-bottom: 1px solid #1e2a3a; }
  td { padding: 8px 12px; border-bottom: 1px solid #0d1525; font-family: 'SF Mono', 'Cascadia Code', monospace; }
  .positive { color: #00b87a; } .negative { color: #ef4444; } .muted { color: #475569; font-family: -apple-system, sans-serif; }
  .overview-text { color: #94a3b8; font-size: 13px; margin-bottom: 16px; max-width: 760px; }
  .honest-verdict { background: #0d1525; border: 1px solid #1e2a3a; border-left: 3px solid #64748b; border-radius: 8px; padding: 14px 16px; margin-top: 14px; font-size: 13px; color: #cbd5e1; }
  .adr-list { list-style: none; font-size: 12px; color: #94a3b8; }
  .adr-list li { padding: 5px 0; border-bottom: 1px solid #0d1525; }
  .footer { font-size: 11px; color: #334155; margin-top: 40px; padding-top: 16px; border-top: 1px solid #1e2a3a; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div>
      <div class="logo">KUKORA<span>·JUDGE REPORT</span></div>
      <div class="subtitle">Self-contained snapshot for evaluation — no external dependencies, opens fully offline.</div>
    </div>
    <div class="report-meta">Generated<br>${esc(generatedAt)}</div>
  </div>

  ${renderArchitectureSection(architecture)}
  ${renderInstitutionalSection(institutional)}
  ${renderValidationSection(validation)}
  ${renderStressTestSection(stressTest)}
  ${renderTenantSection(tenants)}
  ${renderAdrSection(adrs)}

  <div class="footer">
    Kukora — Quantitative Crypto Arbitrage Intelligence Platform. This report reflects the
    live state of the running session at generation time; re-generate it for an up-to-date
    snapshot. Figures with insufficient sample size or no data are reported honestly rather
    than omitted or inflated.
  </div>
</div>
</body>
</html>`;
}

module.exports = { generateJudgeReportHtml };

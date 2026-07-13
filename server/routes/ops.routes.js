'use strict';

/**
 * ops.routes.js — Operational Dashboard
 *
 * Mounted at /api/ops and /api/v1/ops. This is the single endpoint an SRE
 * or the on-call engineer opens during an incident: system health, job
 * status, active feature flags/kill switches, tracing status, and a feed
 * of recent trade events — all in one response, so there's no hunting
 * across five different services to answer "is Kukora healthy right now".
 *
 * Gated by requireAuth (same bar as the rest of the authenticated API
 * surface today — see featureFlags.routes.js header for the RBAC note)
 * AND by the `operationalDashboard` feature flag, so a locked-down
 * deployment can disable this surface entirely with one flag flip instead
 * of a redeploy.
 */

const express = require('express');
const router  = express.Router();

const { requireAuth } = require('../infrastructure/auth');
const { requirePermission, PERMISSIONS } = require('../infrastructure/rbac');
const obs             = require('../infrastructure/observabilityService');
const featureFlags    = require('../infrastructure/featureFlags');
const backgroundJobs   = require('../infrastructure/backgroundJobs');
const eventStore       = require('../infrastructure/eventStore');
const telemetry        = require('../infrastructure/telemetry');

// Judge Report (Iniciativa 5 del plan competitivo, ver PROGRESS.md/CHANGELOG
// v2.23.0): un HTML de un clic que combina arquitectura, backtest
// institucional, validación estadística (ADR-019), stress test y el
// snapshot multi-tenant en una sola pantalla, para que un jurado no tenga
// que navegar el dashboard completo para evaluar la plataforma.
const liveConfig            = require('../infrastructure/liveConfig');
const { getOpportunityLog }  = require('../domain/engines/opportunityDetection');
const { simulateRun }        = require('../domain/engines/arbBacktestEngine');
const instBacktest           = require('../domain/engines/institutionalBacktest');
const { validateEdge }       = require('../domain/engines/statisticalValidation');
const stressTestService      = require('../domain/risk/stressTestService');
const tenantBotState         = require('../infrastructure/tenantBotState');
const tenantRiskGuard        = require('../infrastructure/tenantRiskGuard');
const { getPnL, getTradeHistory } = require('../domain/wallet/walletManager');
const { generateJudgeReportHtml } = require('../domain/analytics/judgeReport');

router.use(requireAuth);
router.use((req, res, next) => {
  if (!featureFlags.isEnabled('operationalDashboard')) {
    return res.status(404).json({ error: 'operational dashboard disabled (feature flag: operationalDashboard)' });
  }
  next();
});

// GET /api/ops — the full aggregated snapshot.
router.get('/', requirePermission(PERMISSIONS.OPS_READ), (req, res) => {
  const jobHealth = backgroundJobs.getHealthSummary();
  const activeKillSwitches = featureFlags.listFlags()
    .filter((f) => f.tags.includes('kill-switch') && f.currentValue === true)
    .map((f) => f.key);

  res.json({
    ts: new Date().toISOString(),
    overallStatus: jobHealth.overall === 'healthy' && activeKillSwitches.length === 0 ? 'healthy' : 'degraded',
    telemetry: {
      tracingEnabled: telemetry.isEnabled(),
    },
    jobs: jobHealth,
    featureFlags: {
      activeKillSwitches,
      total: featureFlags.listFlags().length,
    },
    observability: obs.getDashboard(),
    recentTradeEvents: eventStore.getRecentEvents(20),
  });
});

// GET /api/ops/jobs — background job status only (lighter payload for a polling widget).
router.get('/jobs', requirePermission(PERMISSIONS.JOBS_READ), (req, res) => {
  res.json({ jobs: backgroundJobs.getStatus(), health: backgroundJobs.getHealthSummary() });
});

// POST /api/ops/jobs/:name/run — manually trigger a job ("run now" button).
router.post('/jobs/:name/run', requirePermission(PERMISSIONS.JOBS_RUN), async (req, res) => {
  try {
    const result = await backgroundJobs.runNow(req.params.name);
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// GET /api/ops/trades/:tradeId/replay — full event timeline + projected state for one trade.
router.get('/trades/:tradeId/replay', requirePermission(PERMISSIONS.TRADES_REPLAY), (req, res) => {
  const replay = eventStore.replayTrade(req.params.tradeId);
  if (!replay.projectedState) return res.status(404).json({ error: 'no events found for this tradeId' });
  res.json(replay);
});

// GET /api/ops/judge-report — self-contained HTML report for evaluators.
// Gated same as the rest of this router (requireAuth + operationalDashboard
// flag above) plus OPS_READ, since it aggregates sensitive cross-system
// data (multi-tenant P&L, risk-guard status) that a plain user shouldn't
// see for tenants other than their own.
router.get('/judge-report', requirePermission(PERMISSIONS.OPS_READ), (req, res) => {
  try {
    const opLog = getOpportunityLog();

    let institutional = null;
    let validation = null;
    if (opLog.length) {
      const params = { minScore: liveConfig.get('minScore'), cooldownMs: liveConfig.get('cooldownMs'), feeMultiplier: 1.0 };
      const simResult = simulateRun(opLog, params);
      const capital = parseFloat(req.query.capital) || 100000;
      institutional = {
        metrics: instBacktest.computeInstitutionalMetrics(simResult, capital),
        report: instBacktest.generateInstitutionalReport(simResult, capital),
      };
      validation = validateEdge(opLog, { simulateRun, params, windows: 4 });
    }

    const stressTest = {
      active: stressTestService.getActiveScenario(),
      availableScenarios: stressTestService.listScenarios(),
    };

    const tenants = tenantBotState.activeUids().map((uid) => {
      const pnl = getPnL(null, null, uid);
      return {
        uid,
        isDemo: uid.startsWith('demo-'),
        enabled: tenantBotState.isEnabled(uid),
        pnl: pnl?.realizedPnl ?? 0,
        trades: getTradeHistory(uid).length,
        riskTripped: tenantRiskGuard.isTripped(uid),
      };
    });

    const architecture = {
      overview: 'Kukora is a multi-exchange quantitative BTC arbitrage platform (Binance, Kraken, Bybit, OKX, Coinbase), with a genuine multi-tenant execution layer, 3-tier RBAC, feature-flag kill switches, and partial event sourcing per trade.',
      modules: [
        { name: 'Arbitrage Orchestrator', description: 'Detection → scoring → execution pipeline, event-driven + 150ms polling loop.' },
        { name: 'Multi-Tenant Execution', description: 'Per-tenant config overrides, risk guard, execution pass, and SSE delta overlay (ADR-017).' },
        { name: 'RBAC', description: '3-tier permission model (user/operator/admin) gating ops/flags/jobs surfaces.' },
        { name: 'Feature Flags & Kill Switches', description: 'Typed flags with per-tenant rollout and an admin-only trading kill switch.' },
        { name: 'Institutional Backtest', description: 'Sharpe, Sortino, Calmar, Kelly, VaR, Omega over the session opportunity log.' },
        { name: 'Statistical Edge Validation', description: 'Bootstrap CI + significance test on net P&L per trade (ADR-019).' },
        { name: 'Event Sourcing (partial)', description: 'Immutable per-trade event log, replayable via /api/ops/trades/:id/replay.' },
        { name: 'Observability', description: 'OpenTelemetry tracing, RCA log, exchange health dashboard.' },
      ],
    };

    const adrs = [
      { id: 'ADR-011', title: 'Routes vs. arbitrage subroutes' },
      { id: 'ADR-015', title: 'API versioning (dual /api and /api/v1)' },
      { id: 'ADR-016', title: 'PM2 single-instance constraint' },
      { id: 'ADR-017', title: 'Multi-tenant two-phase rollout' },
      { id: 'ADR-018', title: 'Multi-pair generalization scope' },
      { id: 'ADR-019', title: 'Statistical edge validation (bootstrap CI + significance)' },
    ];

    const html = generateJudgeReportHtml({ architecture, institutional, validation, stressTest, tenants, adrs });
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename=kukora-judge-report-${new Date().toISOString().slice(0, 10)}.html`);
    res.send(html);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;

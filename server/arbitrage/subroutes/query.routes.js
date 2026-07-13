'use strict';

/**
 * arbitrage/subroutes/query.routes.js — Audit fix 2.1 (SRP refactor)
 *
 * Responsibility: read-only data queries — stats, intelligence, analysis, reporting.
 * No state mutations.
 */

const express = require('express');
const router  = express.Router();

const liveConfig = require('../../infrastructure/liveConfig');
const obs        = require('../../infrastructure/observabilityService');
const { validateBody } = require('../../infrastructure/validateRequest');
const { requireRole }  = require('../../infrastructure/auth');
const {
  StressTestActivateBodySchema,
  ManualCircuitBreakerActivateBodySchema,
  ArbBacktestSimulateBodySchema,
  MlScoreBodySchema,
} = require('../../domain/risk/arbitrageValidation');

const state = require('../../application/arbitrage.state');
const {
  getBotEnabled, getBotStarted,
  getEquityCurve, getCounters,
  getBestAskPrice, getBestBtcPrice, getLastKnownBtcPrice, getLastKnownEthPrice,
  _log,
} = state;

const { getMinScore } = require('../../application/arbitrageOrchestrator');

const { getOrderBooks, wsStatus, getOrderBooksETH } = require('../../infrastructure/exchangeService');
const {
  getDailyPnl, isDailyLossBreached,
  getRejectionCounts, getBestOpportunitySeen, getNearViableCount,
  getOpportunityLog, getStatArbSummary,
} = require('../../domain/engines/opportunityDetection');
const { getBalances, getTradeHistory, getPnL } = require('../../domain/wallet/walletManager');

const {
  getExchangeRanking, getReliabilityLeaderboard,
  getVolatilityStatus, getHistoricalLearning, getPredictiveRanking,
} = require('../../infrastructure/exchangeIntelligence');
const {
  getActiveLifecycles, getLifecycleHistory, getLifecycleSummary, getDecayCurveByPair,
} = require('../../domain/analytics/opportunityLifecycle');

const { listReplays, getReplayById, getBestReplay } = require('../../infrastructure/replayService');
const { getJournal, getJournalSummary }              = require('../../domain/analytics/executionJournal');
const { activateScenario, deactivateScenario, getActiveScenario, listScenarios } = require('../../domain/risk/stressTestService');
let _stressTestTimer = null;
const latencyRacing        = require('../../infrastructure/latencyRacing');
const { getMissedSummary, getMissedRecent } = require('../../infrastructure/missedOpportunityTracker');
const { getAllReliabilityScores }           = require('../../infrastructure/exchangeReliabilityDynamic');
const { getRecommendation }                = require('../../domain/engines/adaptiveScoring');
const { alertTradeExecuted, getConfig: getAlertConfig, getAlertHistory } = require('../../infrastructure/alertWebhookService');
const { parameterSweep, sessionSummary, simulateRun } = require('../../domain/engines/arbBacktestEngine');
const adaptivePosition  = require('../../domain/risk/adaptivePositionSizing');
const executionQuality  = require('../../infrastructure/executionQualityTracker');
const spreadMomentum    = require('../../domain/engines/spreadMomentumEngine');
const spreadHeatmap     = require('../../infrastructure/spreadHeatmapService');
const dailyReport       = require('../../infrastructure/dailyReportService');
const dailyStats        = require('../../infrastructure/dailyStatsService');
const e2eLatency        = require('../../infrastructure/e2eLatencyTracker');
const advRisk           = require('../../domain/risk/advancedRiskEngine');
const { fromAdvancedRiskStatus, isRiskContext } = require('../../domain/risk/riskContext');
const mlScoring         = require('../../domain/engines/mlScoringPipeline');
const tsm               = require('../../domain/analytics/tradeStateMachine');
const auditedPnl        = require('../../domain/wallet/auditedPnl');
const perfReport        = require('../../domain/analytics/performanceReport');
const watchdog          = require('../../infrastructure/watchdog');
const instBacktest      = require('../../domain/engines/institutionalBacktest');
const { validateEdge }  = require('../../domain/engines/statisticalValidation');
const predictReb        = require('../../domain/engines/predictiveRebalance');
const { DomainError, ValidationError, NotFoundError } = require('../../domain/errors');

// Audit remediation (roadmap #3 — DomainError adoption). See the identical
// helper/rationale in config.routes.js.
function _sendError(e, res, defaultStatus = 500) {
  if (e instanceof DomainError) return res.status(e.status).json(e.toResponse());
  return res.status(defaultStatus).json({ ok: false, error: e.message });
}

// ─── GET /stats ──────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const orderBooks   = await getOrderBooks().catch(() => []);
    const bestAskPrice = getBestAskPrice(orderBooks);
    const pnlData      = getPnL(bestAskPrice);
    const ws           = wsStatus();
    res.json({ ok: true, data: {
      ...pnlData,
      model:         'pre_funded_bilateral',
      detectionMode: 'event_driven_ws + sse_loop_150ms',
      exchanges:     5,
      wsConnections: Object.values(ws).filter(Boolean).length,
      opportunitiesScanned: getCounters().totalOpportunitiesScanned,
      viableFound:   getCounters().totalViableFound,
      tradesExecuted: getTradeHistory().length,
      uptimeMs:      Date.now() - getBotStarted(),
      dailyPnl:      getDailyPnl(),
      dailyLossBreached: isDailyLossBreached(),
      botEnabled: getBotEnabled(), minScore: getMinScore(),
      wsStatus:      ws,
      equityCurve: getEquityCurve(),
      rejectionCounts:     getRejectionCounts(),
      bestOpportunitySeen: getBestOpportunitySeen(),
      nearViableCount:     getNearViableCount(),
      opportunityLog:      getOpportunityLog().slice(-50),
    } });
  } catch (e) { _sendError(e, res); }
});

// ─── GET /intelligence ───────────────────────────────────────────────────────
router.get('/intelligence', async (req, res) => {
  try {
    const orderBooks = await getOrderBooks().catch(() => []);
    const bestAsk    = getBestAskPrice(orderBooks);
    const activeLC   = getActiveLifecycles();
    const exRanking  = getExchangeRanking();
    res.json({ ok: true, data: {
      volatilityStatus:       getVolatilityStatus(),
      exchangeRanking:        exRanking,
      reliabilityLeaderboard: getReliabilityLeaderboard(),
      historicalLearning:     getHistoricalLearning(),
      predictiveRanking:      getPredictiveRanking(activeLC, exRanking),
      activeLifecycles:       activeLC,
      lifecycleHistory:       getLifecycleHistory(50),
      lifecycleSummary:       getLifecycleSummary(),
      btcPrice:               bestAsk,
      ts: new Date().toISOString(),
    }});
  } catch (e) { _sendError(e, res); }
});

// ─── GET /lifecycle ──────────────────────────────────────────────────────────
router.get('/lifecycle', (req, res) => {
  try {
    res.json({ ok: true, data: {
      active:  getActiveLifecycles(),
      history: getLifecycleHistory(100),
      summary: getLifecycleSummary(),
    }});
  } catch (e) { _sendError(e, res); }
});

// ─── GET /executive ──────────────────────────────────────────────────────────
router.get('/executive', async (req, res) => {
  try {
    const orderBooks  = await getOrderBooks().catch(() => []);
    const bestAsk     = getBestAskPrice(orderBooks);
    const pnlData     = getPnL(bestAsk);
    const history     = getTradeHistory();
    const ws          = wsStatus();
    const activeLC    = getActiveLifecycles();
    const exRanking   = getExchangeRanking();
    const volStatus   = getVolatilityStatus();
    const relLeader   = getReliabilityLeaderboard();
    const predicted   = getPredictiveRanking(activeLC, exRanking);
    const lcSummary   = getLifecycleSummary();

    const totalOpps    = getCounters().totalOpportunitiesScanned;
    const viableOpps   = getCounters().totalViableFound;
    const totalTrades  = history.length;
    const successTrades = history.filter(t => t.netProfit > 0).length;
    const fillRate     = totalTrades > 0 ? +(successTrades / totalTrades * 100).toFixed(1) : 0;
    const avgLatency   = exRanking.reduce((s, e) => s + (e.avgLatency || 0), 0) / (exRanking.filter(e => e.avgLatency).length || 1);
    const bestExchange = exRanking[0]?.exchange || '—';
    const reliabilityAvg = Math.round(relLeader.reduce((s, e) => s + e.score, 0) / (relLeader.length || 1));

    res.json({ ok: true, data: {
      totalOpportunities: totalOpps, viableOpportunities: viableOpps,
      tradesExecuted: totalTrades,  profitToday: getDailyPnl(),
      profitSession:  pnlData.totalPnl || 0, successRate: pnlData.winRate || 0,
      fillRate, avgLatencyMs: Math.round(avgLatency), reliabilityScore: reliabilityAvg,
      riskStatus: volStatus.status, connectedExchanges: Object.values(ws).filter(Boolean).length,
      bestExchange, predictedOpportunity: predicted[0] || null,
      bestOpportunitySeen: getBestOpportunitySeen(),
      nearViableCount:     getNearViableCount(),
      rejectionCounts:     getRejectionCounts(),
      botEnabled: getBotEnabled(), uptimeMs: Date.now() - getBotStarted(),
      lifecycleSummary: lcSummary, volatilityStatus: volStatus,
      ts: new Date().toISOString(),
    }});
  } catch (e) { _sendError(e, res); }
});

// ─── Replays ─────────────────────────────────────────────────────────────────
router.get('/replays', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit,  10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const all    = await listReplays(limit + offset);
    const page   = all.slice(offset, offset + limit);
    res.json({ ok: true, data: page, pagination: { limit, offset, returned: page.length } });
  } catch (e) { _sendError(e, res); }
});

router.get('/replays/best', async (req, res) => {
  try { res.json({ ok: true, data: (await getBestReplay()) || null }); }
  catch (e) { _sendError(e, res); }
});

router.get('/replays/:id', async (req, res) => {
  try {
    const data = await getReplayById(req.params.id);
    if (!data) throw new NotFoundError('Replay not found');
    res.json({ ok: true, data });
  } catch (e) { _sendError(e, res); }
});

// ─── Journal ─────────────────────────────────────────────────────────────────
router.get('/journal', (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit,  10) || 100, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const all    = getJournal(limit + offset);
    const page   = all.slice(offset, offset + limit);
    res.json({ ok: true, data: page, summary: getJournalSummary(), pagination: { limit, offset, returned: page.length } });
  } catch (e) { _sendError(e, res); }
});

// ─── Stress test ─────────────────────────────────────────────────────────────
router.get('/stress-test/scenarios', (req, res) => {
  res.json({ ok: true, data: listScenarios(), active: getActiveScenario() });
});

router.post('/stress-test/activate', requireRole('admin'), validateBody(StressTestActivateBodySchema), (req, res) => {
  try {
    const { type, exchange, multiplier, dropPct, expiresAfterMs } = req.body;
    const MAX_STRESS_DURATION = 5 * 60_000;
    const duration = Math.min(Math.max(expiresAfterMs || 60_000, 1000), MAX_STRESS_DURATION);
    const result = activateScenario(type, { exchange, multiplier, dropPct });
    if (!result.ok) return res.status(400).json(result);
    if (_stressTestTimer) clearTimeout(_stressTestTimer);
    _stressTestTimer = setTimeout(() => { deactivateScenario(); _stressTestTimer = null; }, duration);
    _log(`[stress-test] ACTIVATED ${type} (auto-expires in ${duration}ms)`, { exchange, multiplier, dropPct });
    res.json({ ...result, expiresInMs: duration });
  } catch (e) { _sendError(e, res); }
});

router.post('/stress-test/deactivate', requireRole('admin'), (req, res) => {
  try { _log('[stress-test] DEACTIVATED'); res.json(deactivateScenario()); }
  catch (e) { _sendError(e, res); }
});

// ─── Misc analytics ───────────────────────────────────────────────────────────
router.get('/decay-curve', (req, res) => {
  try { res.json({ ok: true, data: getDecayCurveByPair() }); }
  catch (e) { _sendError(e, res); }
});

router.get('/latency-racing', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 60);
    res.json({ ok: true, rounds: latencyRacing.getRounds(limit), leaderboard: latencyRacing.getLeaderboard() });
  } catch (e) { _sendError(e, res); }
});

router.get('/missed', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    res.json({ ok: true, summary: getMissedSummary(), recent: getMissedRecent(limit) });
  } catch (e) { _sendError(e, res); }
});

router.get('/statarrb-pairs', (req, res) => {
  try { res.json({ ok: true, data: getStatArbSummary() }); }
  catch (e) { _sendError(e, res); }
});

// ─── Arb backtest ─────────────────────────────────────────────────────────────
router.get('/arb-backtest/summary', (req, res) => {
  try { res.json({ ok: true, data: sessionSummary(getOpportunityLog()) }); }
  catch (e) { _sendError(e, res); }
});

router.get('/arb-backtest/sweep', (req, res) => {
  try { res.json({ ok: true, data: parameterSweep(getOpportunityLog()) }); }
  catch (e) { _sendError(e, res); }
});

router.post('/arb-backtest/simulate', validateBody(ArbBacktestSimulateBodySchema), (req, res) => {
  try {
    const { minScore = 65, cooldownMs = 3000, feeMultiplier = 1.0 } = req.body;
    const opLog = getOpportunityLog();
    if (!opLog.length) return res.json({ ok: true, data: null, message: 'Opportunity log is empty' });
    res.json({ ok: true, data: simulateRun(opLog, { minScore, cooldownMs, feeMultiplier }) });
  } catch (e) { _sendError(e, res); }
});

router.get('/arb-backtest/institutional', (req, res) => {
  try {
    const opLog = getOpportunityLog();
    if (!opLog.length) return res.json({ ok: true, data: null, reason: 'No opportunity log data yet' });
    const bestParams = { minScore: liveConfig.get('minScore'), cooldownMs: liveConfig.get('cooldownMs'), feeMultiplier: 1.0 };
    const simResult  = simulateRun(opLog, bestParams);
    const capital    = parseFloat(req.query.capital) || 100000;
    res.json({ ok: true, data: {
      metrics: instBacktest.computeInstitutionalMetrics(simResult, capital),
      report:  instBacktest.generateInstitutionalReport(simResult, capital),
    }});
  } catch (e) { _sendError(e, res); }
});

// Validación estadística del edge: bootstrap CI + prueba de significancia
// sobre el P&L neto por operación, agregado sobre varias ventanas de
// mercado independientes (server/domain/engines/statisticalValidation.js).
// Honesto por diseño: si la muestra es chica o el edge no es distinguible
// de cero, lo reporta explícitamente en vez de maquillarlo — ver ADR-019.
router.get('/arb-backtest/validation', (req, res) => {
  try {
    const opLog = getOpportunityLog();
    if (!opLog.length) return res.json({ ok: true, data: null, reason: 'No opportunity log data yet' });
    const params = { minScore: liveConfig.get('minScore'), cooldownMs: liveConfig.get('cooldownMs'), feeMultiplier: 1.0 };
    const windows = Math.min(8, Math.max(1, parseInt(req.query.windows, 10) || 4));
    const data = validateEdge(opLog, { simulateRun, params, windows });
    res.json({ ok: true, data });
  } catch (e) { _sendError(e, res); }
});

// ─── Adaptive / reliability / alerts ─────────────────────────────────────────
router.get('/adaptive-recommendation', (req, res) => {
  try { res.json({ ok: true, data: getRecommendation() }); }
  catch (e) { _sendError(e, res); }
});

router.get('/reliability', (req, res) => {
  try { res.json({ ok: true, data: getAllReliabilityScores() }); }
  catch (e) { _sendError(e, res); }
});

router.get('/alerts/config', (req, res) => {
  try { res.json({ ok: true, data: getAlertConfig() }); }
  catch (e) { _sendError(e, res); }
});

router.post('/alerts/test', async (req, res) => {
  try {
    await alertTradeExecuted({
      id: 'test-' + Date.now(), ts: new Date().toISOString(),
      buyExchange: 'Binance', sellExchange: 'OKX',
      amount: 0.05, buyPrice: 107000, sellPrice: 107250,
      totalFees: 10.72, slippage: 2.14, netProfit: 0.80,
    });
    res.json({ ok: true, message: 'Test alert sent. Check Telegram or your webhook.' });
  } catch (e) { _sendError(e, res); }
});

router.get('/alerts/history', (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
    const offset = Math.max(parseInt(req.query.offset || '0',  10), 0);
    const all    = getAlertHistory(limit + offset);
    const page   = all.slice(offset, offset + limit);
    res.json({ ok: true, history: page, pagination: { limit, offset, returned: page.length } });
  } catch (e) { _sendError(e, res); }
});

// ─── Market / engine data ─────────────────────────────────────────────────────
router.get('/eth-books', async (req, res) => {
  try { res.json({ ok: true, data: await getOrderBooksETH() }); }
  catch (e) { _sendError(e, res); }
});

router.get('/position-sizing', (req, res) => {
  try { res.json({ ok: true, data: adaptivePosition.getSummary() }); }
  catch (e) { _sendError(e, res); }
});

router.get('/execution-quality', async (req, res) => {
  try {
    const n = Math.min(parseInt(req.query.n, 10) || 50, 200);
    res.json({ ok: true, data: await executionQuality.getQualityMetrics(n) });
  } catch (e) { _sendError(e, res); }
});

router.get('/spread-momentum', (req, res) => {
  try {
    const momentums = spreadMomentum.getAllMomentums();
    res.json({ ok: true, data: momentums, count: momentums.length });
  } catch (e) { _sendError(e, res); }
});

router.get('/spread-heatmap', async (req, res) => {
  try {
    const days   = Math.min(parseInt(req.query.days, 10) || 7, 30);
    const simple = req.query.simple === 'true';
    const data   = simple ? await spreadHeatmap.getHeatmapSimple() : await spreadHeatmap.getHeatmap(days);
    res.json({ ok: true, data });
  } catch (e) { _sendError(e, res); }
});

router.get('/daily-reports', async (req, res) => {
  try {
    const n = Math.min(parseInt(req.query.n, 10) || 14, 60);
    const reports = await dailyReport.getRecentReports(n);
    res.json({ ok: true, data: reports, count: reports.length });
  } catch (e) { _sendError(e, res); }
});

router.get('/daily-stats', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 7, 30);
    res.json({ ok: true, data: await dailyStats.getDailyStats(days) });
  } catch (e) { _sendError(e, res); }
});

router.get('/e2e-latency', (req, res) => {
  try {
    const stats   = e2eLatency.getStats();
    const samples = e2eLatency.getRecentSamples(parseInt(req.query.samples, 10) || 60);
    res.json({ ok: true, data: stats, samples });
  } catch (e) { _sendError(e, res); }
});

// ─── Risk / observability / ML ────────────────────────────────────────────────
router.get('/risk/status', (req, res) => {
  try {
    const wallets    = getBalances();
    const pnl        = getPnL();
    const sessionPnl = pnl?.realizedPnl ?? 0;
    const btcPrice   = getBestBtcPrice();
    const ethPrice   = getLastKnownEthPrice();
    const capitalUSD = Object.values(wallets.BTC  || {}).reduce((s, v) => s + v, 0) * btcPrice
                     + Object.values(wallets.ETH  || {}).reduce((s, v) => s + v, 0) * ethPrice
                     + Object.values(wallets.USDT || {}).reduce((s, v) => s + v, 0);
    const status = advRisk.getStatus(capitalUSD, sessionPnl);
    // Contract check (audit committee, sección 12, punto 1): RiskContext is
    // the shared shape this status is supposed to normalize to (see
    // domain/risk/riskContext.ts). Response body is unchanged — the
    // frontend already reads the nested RiskStatus shape directly — this
    // is a regression guard so a future edit to advancedRiskEngine.getStatus()
    // that drops a field this contract relies on gets caught here instead
    // of silently reaching the UI.
    if (!isRiskContext(fromAdvancedRiskStatus(status))) {
      obs.emit('RISK', 'contract.risk_context_shape_invalid', { source: 'global' });
    }
    res.json({ ok: true, data: status });
  } catch (e) { _sendError(e, res); }
});

// Kill switch manual (auditoria Sesion 34, P0 #2): antes solo el reset era
// accionable desde la API - activar el circuit breaker dependia siempre de
// un trigger automatico. Este endpoint permite a un operador detener el
// sistema a mano, ANTES de que drawdown/daily-loss/fallas consecutivas lo
// disparen solos. `reason` queda registrado tanto en el propio circuit
// breaker (advRisk.getStatus().circuitBreaker.reason) como en el evento de
// observabilidad, para que el halt sea auditable igual que cualquier otro
// trigger.
router.post('/risk/circuit-breaker/activate', requireRole('admin'), validateBody(ManualCircuitBreakerActivateBodySchema), (req, res) => {
  try {
    const { reason } = req.body;
    const result = advRisk.activateCircuitBreaker(reason, 'manual');
    obs.emit('RISK', 'risk.circuit_breaker.manual_activate', { source: 'ui', reason });
    res.json({ ok: true, data: result });
  } catch (e) { _sendError(e, res); }
});

router.post('/risk/circuit-breaker/reset', requireRole('admin'), (req, res) => {
  try {
    const result = advRisk.resetCircuitBreaker('ui');
    obs.emit('RISK', 'risk.circuit_breaker.manual_reset', { source: 'ui' });
    res.json({ ok: true, data: result });
  } catch (e) { _sendError(e, res); }
});

router.get('/observability/dashboard', (req, res) => {
  try { res.json({ ok: true, data: obs.getDashboard() }); }
  catch (e) { _sendError(e, res); }
});

router.get('/observability/rca', (req, res) => {
  try {
    const limit    = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const category = req.query.category || null;
    res.json({ ok: true, summary: obs.getRCASummary(), log: obs.getRCALog(limit, category) });
  } catch (e) { _sendError(e, res); }
});

router.get('/observability/events', (req, res) => {
  try {
    const category = req.query.category || null;
    const limit    = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const data     = category ? obs.getEvents(category, limit) : obs.getAllRecentEvents(limit);
    res.json({ ok: true, data, category });
  } catch (e) { _sendError(e, res); }
});

router.get('/observability/exchange-health', (req, res) => {
  try { res.json({ ok: true, data: obs.getExchangeHealth() }); }
  catch (e) { _sendError(e, res); }
});

router.post('/ml/score', validateBody(MlScoreBodySchema), (req, res) => {
  try {
    const opportunity = req.body;
    // Defense in depth (mismo criterio que /pairs en config.routes.js):
    // validateBody ya rechaza esto con 400 en producción, pero los tests
    // unitarios de este router llaman al handler final directamente,
    // saltándose el middleware — este guard preserva el 400 en ambos casos.
    if (!opportunity.buyExchange || !opportunity.sellExchange) {
      throw new ValidationError('Missing buyExchange or sellExchange');
    }
    res.json({ ok: true, data: mlScoring.scoreOpportunity(opportunity, {}) });
  } catch (e) { _sendError(e, res); }
});

router.get('/ml/info', (req, res) => {
  try {
    res.json({ ok: true, data: {
      activeModel:     mlScoring.getActiveModelName(),
      availableModels: mlScoring.getRegisteredModels(),
      scoringWeights:  liveConfig.get('scoringWeights'),
      description:     'Pluggable ML scoring pipeline. Register new models via mlScoringPipeline.registerModel()',
    }});
  } catch (e) { _sendError(e, res); }
});

// ─── Trades ───────────────────────────────────────────────────────────────────
router.get('/trades/active', (req, res) => {
  try { res.json({ ok: true, data: tsm.getActiveTrades(), stats: tsm.getStats() }); }
  catch (e) { _sendError(e, res); }
});

router.get('/trades/history', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    res.json({ ok: true, data: tsm.getHistory(limit), stats: tsm.getStats() });
  } catch (e) { _sendError(e, res); }
});

router.get('/trades/:id', (req, res) => {
  try {
    const trade = tsm.getTrade(req.params.id);
    if (!trade) throw new NotFoundError('Trade not found');
    res.json({ ok: true, data: trade });
  } catch (e) { _sendError(e, res); }
});

// ─── Audited P&L ──────────────────────────────────────────────────────────────
router.get('/pnl/audited', (req, res) => {
  try {
    const wallets  = getBalances();
    const btcPrice = getLastKnownBtcPrice();
    res.json(auditedPnl.getAuditedPnl(wallets, btcPrice));
  } catch (e) { _sendError(e, res); }
});

router.get('/pnl/audit-trail', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    res.json({ trail: auditedPnl.getAuditTrail(limit) });
  } catch (e) { _sendError(e, res); }
});

router.get('/pnl/daily-ledger', (req, res) => {
  try { res.json({ ledger: auditedPnl.getDailyLedger() }); }
  catch (e) { _sendError(e, res); }
});

router.get('/pnl/export-csv', (req, res) => {
  try {
    const csv = auditedPnl.exportCsv();
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=kukora-trades-${new Date().toISOString().slice(0, 10)}.csv`);
    res.send(csv);
  } catch (e) { _sendError(e, res); }
});

// ─── Performance reports ──────────────────────────────────────────────────────
router.get('/report/json', (req, res) => {
  try {
    const wallets  = getBalances();
    const btcPrice = getLastKnownBtcPrice();
    const uptimeMs = Date.now() - getBotStarted();
    res.json(perfReport.generateJsonReport({ wallets, btcPrice, uptimeMs, equityCurve: getEquityCurve(), executions: getTradeHistory() }));
  } catch (e) { _sendError(e, res); }
});

router.get('/report/html', (req, res) => {
  try {
    const wallets  = getBalances();
    const btcPrice = getLastKnownBtcPrice();
    const uptimeMs = Date.now() - getBotStarted();
    const html = perfReport.generateHtmlReport({ wallets, btcPrice, uptimeMs, equityCurve: getEquityCurve(), executions: getTradeHistory() });
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename=kukora-report-${new Date().toISOString().slice(0, 10)}.html`);
    res.send(html);
  } catch (e) { _sendError(e, res); }
});

router.get('/report/summary', (req, res) => {
  try {
    const wallets  = getBalances();
    const btcPrice = getLastKnownBtcPrice();
    const uptimeMs = Date.now() - getBotStarted();
    const summary  = perfReport.generateExecutiveSummary({ wallets, btcPrice, uptimeMs, equityCurve: getEquityCurve(), executions: getTradeHistory() });
    res.json({ summary });
  } catch (e) { _sendError(e, res); }
});

// ─── Watchdog ─────────────────────────────────────────────────────────────────
router.get('/watchdog/status', (req, res) => {
  try { res.json(watchdog.getStatus()); }
  catch (e) { _sendError(e, res); }
});

// ─── Capital efficiency ───────────────────────────────────────────────────────
router.get('/capital-efficiency-v2', (req, res) => {
  try {
    const wallets    = getBalances();
    const pnl        = getPnL();
    const btcPrice   = getBestBtcPrice() || 50000;
    const sessionPnl = pnl?.realizedPnl ?? 0;
    const trades     = pnl?.totalTrades ?? 0;
    const uptime     = Date.now() - getBotStarted();
    res.json({ ok: true, data: predictReb.computeCapitalEfficiency(wallets, btcPrice, sessionPnl, trades, uptime) });
  } catch (e) { _sendError(e, res); }
});

module.exports = router;

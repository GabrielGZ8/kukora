'use strict';
/**
 * arbitrageOrchestrator.js — kukora v18 (S9 fix: arquitectura modular)
 * (renombrado desde arbitrage.engine.js — auditoría técnica v2, sección 1.2:
 *  el nombre anterior era casi idéntico a opportunityDetection.js, antes
 *  arbitrageEngine.js, lo que causaba colisiones de búsqueda/autocompletado)
 *
 * Contains the two detection loops (event-driven WS + 150ms polling) and the
 * unified executeBestOpportunity() function (C3 fix from audit).
 *
 * Imports shared state from arbitrage.state.js — no local mutable variables
 * for bot state, equity curve, fingerprints, or counters.
 */

// ─── Shared state ──────────────────────────────────────────────────────────
const state = require('./arbitrage.state');
const {
  getBotEnabled, getBotStarted,
  getLastKnownBtcPrice, setLastKnownBtcPrice,
  setLastKnownEthPrice, getLastKnownEthPrice,
  getLastAnyExecTs, setLastAnyExecTs, checkFingerprint,
  pushToSSE, pushToAlerts,
  appendEquityPoint, getEquityCurve,
  incrementScanned, incrementViable, incrementTick, getTickCount,
  getBestAskPrice,
  _log, _warn,
} = state;

// ─── Services ──────────────────────────────────────────────────────────────
const {
  getOrderBooks, wsStatus, getFreshness, priceEmitter, getDepth, getOrderBooksETH,
} = require('../infrastructure/exchangeService');

const { captureIfNoteworthy }                                    = require('../infrastructure/replayService');
const { computeBenchmark, getHistory: getBenchmarkHistory }      = require('../infrastructure/speedBenchmark');
const { persistEquityPoint, persistTrade, restoreSession,
  startPeriodicFlush, currentSessionId,
  restoreEngineSnapshot,
  startEngineSnapshotFlush,
  startPersistenceRetryFlush }                 = require('../infrastructure/persistenceService');
const { startTenantPersistenceFlush, stopTenantPersistenceFlush } = require('../infrastructure/tenantPersistence');
const { recordMissed, recordExecuted, getMissedSummary }         = require('../infrastructure/missedOpportunityTracker');
const { getAllReliabilityScores, recordSlippageBias }             = require('../infrastructure/exchangeReliabilityDynamic');
const { recalcIfNeeded: recalcAdaptive, getRecommendation }      = require('../domain/engines/adaptiveScoring');
const {
  alertTradeExecuted, alertOpportunityLarge, alertDailyStop,
  alertExchangeDegraded,
} = require('../infrastructure/alertWebhookService');
const alerts = require('../infrastructure/alertWebhookService');

const {
  detectOpportunities, executeSimulated,
  getDailyPnl, addDailyPnl, isDailyLossBreached,
  getRejectionCounts, getBestOpportunitySeen, getNearViableCount,
  getOpportunityLog, getStatArbSummary,
  _DEFAULT_TRADE_AMOUNT,
} = require('../domain/engines/opportunityDetection');

const { getBalances, setBalances, getInitialBalances, applyTrade, getTradeHistory, getPnL } = require('../domain/wallet/walletManager');
const { runTenantExecutionPass } = require('../infrastructure/tenantExecution');
const { computeCapitalEfficiency, computeRebalanceProjection }   = require('../domain/wallet/capitalEfficiency');
const { recordExecutionJournalEntry, getJournalSummary }         = require('../domain/analytics/executionJournal');
const { getActiveScenario, applyActiveScenario }                 = require('../domain/risk/stressTestService');
const latencyRacing = require('../infrastructure/latencyRacing');

const dailyStats      = require('../infrastructure/dailyStatsService');
const e2eLatency      = require('../infrastructure/e2eLatencyTracker');
const spreadMomentum  = require('../domain/engines/spreadMomentumEngine');
const spreadHeatmap   = require('../infrastructure/spreadHeatmapService');
const dailyReport     = require('../infrastructure/dailyReportService');
const adaptivePosition = require('../domain/risk/adaptivePositionSizing');
const executionQuality = require('../infrastructure/executionQualityTracker');

const {
  trackAll, expireStale,
  getActiveLifecycles, getLifecycleHistory, getLifecycleSummary,
} = require('../domain/analytics/opportunityLifecycle');
const { enrichWithFillProbability } = require('../domain/engines/fillProbabilityEngine');
const { enrichWithLiquidityPrediction } = require('../domain/engines/liquidityPredictionEngine');
const marketRegimeCache = require('../domain/engines/marketRegimeCache');
const { attachExplainability } = require('../domain/analytics/explainability');
// Fix for AUDIT FINDING 1 (CRITICAL): server-side canonical copy of every
// opportunity the detection engine computes, so live execution can resolve
// client-supplied opportunities against real numbers instead of trusting
// whatever the client sent. See opportunitySnapshotStore.js for the full
// rationale and server/application/liveExecution.js's
// resolveTrustedOpportunity() for the consumer side.
const { recordSnapshots } = require('../domain/engines/opportunitySnapshotStore');
const { withSpan } = require('../infrastructure/telemetry');
const featureFlags = require('../infrastructure/featureFlags');
const eventStore = require('../infrastructure/eventStore');
const {
  recordOpportunitySeen, recordExecution, recordPairDetection,
  getExchangeRanking, getReliabilityLeaderboard,
  recordBtcPrice, getVolatilityStatus,
  getHistoricalLearning, getPredictiveRanking,
  recommendCapitalSize,
} = require('../infrastructure/exchangeIntelligence');

const { logger }       = require('../infrastructure/logger');
const liveConfig       = require('../infrastructure/liveConfig');
const tsm              = require('../domain/analytics/tradeStateMachine');
const advRisk          = require('../domain/risk/advancedRiskEngine');
const obs              = require('../infrastructure/observabilityService');
const predictReb       = require('../domain/engines/predictiveRebalance');
const auditedPnl       = require('../domain/wallet/auditedPnl');
const watchdog         = require('../infrastructure/watchdog');
const slippageValidator = require('../domain/risk/slippageValidator');
const metrics          = require('../infrastructure/metricsService');
const weeklyPnl        = require('../domain/wallet/weeklyPnlTracker');
// I-2 fix: exchange names come from the registry — adding a 6th exchange
// no longer requires editing this file.
const { getEnabledExchangeNames } = require('../infrastructure/exchangeRegistry');

// ─── Helpers ───────────────────────────────────────────────────────────────
const ALL_EXCHANGE_NAMES = getEnabledExchangeNames();
function snapshotDepths() {
  const out = {};
  for (const ex of ALL_EXCHANGE_NAMES) out[ex] = getDepth(ex);
  return out;
}

function getMinScore()    { return liveConfig.get('minScore'); }

/**
 * getEffectiveMinScore - ADR-019 Sec4: base minScore scaled by the current
 * cached market regime's score multiplier (>= 1.0 only - tightens or
 * holds, never loosens). Recomputes the regime at most once per
 * marketRegimeRefreshMs (marketRegimeCache.js), so this is cheap to call
 * from every selection predicate.
 */
function getEffectiveMinScore() {
  return getMinScore() * marketRegimeCache.getScoreMultiplier();
}
function getExecCooldown(){ return liveConfig.get('cooldownMs'); }

// ─── C3 (auditoría): execution path unificado ──────────────────────────────
/**
 * Execute the best identified opportunity. Called by BOTH detection paths
 * (event-driven and polling loop) so every execution has identical side-effects:
 * pre-trade risk check, state machine, audited P&L, alerts, execution quality.
 *
 * @param {object} best  — viable opportunity already filtered + fingerprinted
 * @param {object} opts  — { source, orderBooks, tickStartTs?, detectMs?, bookRecvMs?, statArbSignals? }
 * @returns {{ ok: boolean, trade?: object, reason?: string }}
 */
const { isOpportunity } = require('../domain/opportunity');

async function executeBestOpportunity(best, opts = {}) {
  const {
    source = 'unknown', orderBooks = [],
    tickStartTs = null, detectMs = 0, bookRecvMs = 0, statArbSignals = [], tenantId = null,
  } = opts;

  // Feature-flag kill switch — checked first, before any risk math runs.
  // killSwitchTrading halts everyone; killSwitchTenantExecution only halts
  // tenant-scoped calls (opts.tenantId set). Both default to false (safe/
  // fully-operational) — see featureFlags.js header for the naming rationale.
  if (featureFlags.isEnabled('killSwitchTrading') ||
      (tenantId && featureFlags.isEnabled('killSwitchTenantExecution'))) {
    const flag = featureFlags.isEnabled('killSwitchTrading') ? 'killSwitchTrading' : 'killSwitchTenantExecution';
    obs.recordRejection(best || {}, `Trading halted by feature flag: ${flag}`, obs.RCA_CATEGORIES.KILL_SWITCH_ACTIVE, { flag, tenantId });
    return { executed: false, reason: 'kill_switch_active', flag };
  }

  // Nivel 2 #3 (audit): single-source-of-truth Opportunity shape check.
  // Non-throwing by design — this is a contract *observation*, not a gate.
  // opportunityDetection.js is the sole producer of `best`; if a future
  // change there drops/renames a required field, this makes that visible
  // in observability instead of silently breaking a downstream consumer.
  if (!isOpportunity(best)) {
    obs.emit('RISK', 'risk.opportunity_shape_mismatch', {
      source,
      keys: best && typeof best === 'object' ? Object.keys(best) : typeof best,
    }, 'warn');
  }

  const evalStart = Date.now();
  const now       = evalStart;

  const sessionPnlNow  = getDailyPnl();
  const bestWithSizing = adaptivePosition.getPositionSizeForOpportunity(best, sessionPnlNow, _DEFAULT_TRADE_AMOUNT);
  const tradeSize      = bestWithSizing.positionSizing?.size || _DEFAULT_TRADE_AMOUNT;

  // ── Pre-trade risk check (v17) ────────────────────────────────────────
  const walletSnapshot = getBalances();
  const _pnlForRisk    = getPnL(bestWithSizing.buyPrice);
  const _capitalUSD    =
    Object.values(walletSnapshot.BTC  || {}).reduce((s,v) => s + v, 0) * (getLastKnownBtcPrice())
  // H-6 remainder (Sesión 21): antes solo se sumaban BTC + USDT — el risk
  // engine subestimaba el capital total en cuanto había posición en ETH.
  + Object.values(walletSnapshot.ETH  || {}).reduce((s,v) => s + v, 0) * (getLastKnownEthPrice())
  + Object.values(walletSnapshot.USDT || {}).reduce((s,v) => s + v, 0);

  // AUDIT FINDING 4 fix (HIGH): preTradeRiskCheck's 4th param is compared
  // directly against maxDailyLossUSD/the emergency-stop threshold inside
  // advancedRiskEngine.preTradeRiskCheck() ("Daily loss X exceeds limit Y")
  // — it MUST be today's realized P&L only. `_pnlForRisk.realizedPnl`
  // (walletManager.getPnL()) is instead the sum of up to MAX_TRADE_HISTORY
  // (500) trades with no date filter at all — old losses from days or
  // weeks ago (still sitting in the in-memory trade history) permanently
  // count against today's daily-loss breaker, while a real bad trading day
  // that happens to follow a historically profitable stretch could net out
  // to a "safe" positive number and never trip the breaker at all. The
  // correctly-scoped (local-midnight-reset) value already exists two lines
  // above as `sessionPnlNow` (`getDailyPnl()`, opportunityDetection.js) —
  // it's what `isDailyLossBreached()` and adaptive position sizing already
  // use — so this reuses it instead of introducing a third implementation.
  // (tenantRiskGuard.js's `_todaysRealizedPnl` is the per-tenant analog of
  // the same fix, already correct, and out of scope here — it protects the
  // isolated per-tenant paper bot, not this shared-bot path.)
  const riskCheck = advRisk.preTradeRiskCheck(
    bestWithSizing, walletSnapshot, _capitalUSD, sessionPnlNow
  );
  if (!riskCheck.ok) {
    obs.recordRejection(bestWithSizing, `Risk check failed: ${riskCheck.blockedBy}`,
      obs.RCA_CATEGORIES.RISK_LIMIT_EXCEEDED,
      { blockedBy: riskCheck.blockedBy, checks: riskCheck.checks, source });
    if (riskCheck.blockedBy === 'circuit_breaker') {
      const _status = advRisk.getStatus();
      alerts.alertCircuitBreakerActivated(_status.circuitBreaker.reason || 'unknown', {
        consecutiveFailures: _status.consecutiveFailures,
        sessionPnl: sessionPnlNow,
      }).catch(() => {});
    }
    if (riskCheck.blockedBy === 'drawdown') {
      const _dd = advRisk.getDrawdownPct(_capitalUSD);
      alerts.alertDrawdown(_dd, liveConfig.get('maxDrawdownPct'), _capitalUSD).catch(() => {});
    }
    return { ok: false, reason: `risk_check:${riskCheck.blockedBy}` };
  }

  // ── State machine (v17) ───────────────────────────────────────────────
  const tradeId = tsm.createTrade(bestWithSizing, source);
  eventStore.appendEvent(tradeId, 'trade.requested', {
    source, pair: `${bestWithSizing.buyExchange}→${bestWithSizing.sellExchange}`,
    amount: tradeSize, score: bestWithSizing.score, tenantId,
  });
  tsm.transition(tradeId, 'SCORING',         { actor: 'engine', reason: 'Passed pre-trade risk checks' });
  tsm.transition(tradeId, 'APPROVED',        { actor: 'engine', reason: `Score ${bestWithSizing.score} >= min ${getMinScore()}` });
  tsm.transition(tradeId, 'ORDER_CREATED',   { actor: 'engine' });
  tsm.transition(tradeId, 'ORDER_SUBMITTED', { actor: 'engine' });

  const result = executeSimulated(bestWithSizing, walletSnapshot, tradeSize);
  if (!result.ok) {
    tsm.transition(tradeId, 'FAILED', { actor: 'engine', reason: result.reason,
      data: { rca: { rejectionReason: result.reason, failureCategory: 'execution_failed' } } });
    eventStore.appendEvent(tradeId, 'trade.failed', { reason: result.reason, stage: 'execution' });
    advRisk.recordTradeOutcome(false, { reason: result.reason });
    return { ok: false, reason: result.reason };
  }

  const applyResult = await applyTrade(result.trade);
  if (!applyResult.ok) {
    tsm.transition(tradeId, 'FAILED', { actor: 'wallet_manager', reason: applyResult.reason,
      data: { rca: { rejectionReason: applyResult.reason, failureCategory: 'insufficient_balance' } } });
    eventStore.appendEvent(tradeId, 'trade.failed', { reason: applyResult.reason, stage: 'wallet_apply' });
    advRisk.recordTradeOutcome(false, { reason: applyResult.reason });
    return { ok: false, reason: applyResult.reason };
  }

  // ── Advance state machine ─────────────────────────────────────────────
  const fillRatio = applyResult.trade.amount / tradeSize;
  eventStore.appendEvent(tradeId, fillRatio < 1 ? 'trade.partial_filled' : 'trade.filled', {
    amount: applyResult.trade.amount, requestedAmount: tradeSize, fillRatio,
  });
  if (fillRatio < 1) {
    tsm.transition(tradeId, 'PARTIALLY_FILLED', { actor: 'engine',
      data: { execution: { filledAmount: applyResult.trade.amount, fillRatio } } });
    tsm.transition(tradeId, 'FILLED', { actor: 'engine',
      data: { pnl: { netProfit: applyResult.trade.netProfit } } });
  } else {
    tsm.transition(tradeId, 'FILLED', { actor: 'engine',
      data: { execution: { fillRatio: 1 }, pnl: { netProfit: applyResult.trade.netProfit } } });
  }
  tsm.transition(tradeId, 'SETTLING',  { actor: 'engine' });
  tsm.transition(tradeId, 'COMPLETED', { actor: 'engine',
    reason: `Net profit $${applyResult.trade.netProfit}` });

  advRisk.recordTradeOutcome(true);
  advRisk.recordSlippage(applyResult.trade.slippagePct || 0);
  advRisk.updateEquity(_capitalUSD + (applyResult.trade.netProfit || 0));
  obs.recordExecutionQuality(bestWithSizing, applyResult.trade);
  predictReb.recordTrade(applyResult.trade);

  // ── ADR-019 §5: feed realized slippage bias per exchange side ──────────
  // Positive slippagePct means the fill came in worse than modeled — see
  // exchangeReliabilityDynamic.getSlippagePenalty() for how this rolls up
  // into the reliability penalty. Fire-and-forget (in-memory, synchronous,
  // cannot fail) — no try/catch needed, matches the pattern of the other
  // recordX() calls in this block.
  // ── ADR-019 §5: feed realized slippage bias per exchange side ──────────
  // ADR-019 §5 bug fix: unlike liveExecution.js's real fills, executeSimulated()
  // always replays the pre-trade estimate as "realized" (trade.slippagePct
  // === opportunity.slippagePct verbatim, see opportunityDetection.js) —
  // there is no independent market fill here to diverge from the model.
  // Feeding the raw magnitude as if it were a bias fabricated a constant
  // positive "worse than modeled" signal that wasn't real, directly
  // contradicting §5's own documented semantics ("a bias <= 0 is never
  // penalized" / "self-healing"). The delta below is the honest
  // computation and correctly evaluates to 0 for the shared paper-trading
  // bot (no penalty), same as if this signal weren't wired at all, until
  // this bot's trades are backed by a real fill price. Genuine, real-money
  // slippage bias is recorded from liveExecution.js's success paths (see
  // _recordRealizedSlippageBias there).
  recordSlippageBias(bestWithSizing.buyExchange, (applyResult.trade.slippagePct || 0) - (bestWithSizing.slippagePct || 0));
  recordSlippageBias(bestWithSizing.sellExchange, (applyResult.trade.slippagePct || 0) - (bestWithSizing.slippagePct || 0));

  // ── Slippage calibration (Phase 1 production gate) ─────────────────────
  slippageValidator.recordSample({
    pair:               `${bestWithSizing.buyExchange}→${bestWithSizing.sellExchange}`,
    modeledSpreadPct:   bestWithSizing.spreadPct || 0,
    modeledNetUSD:      bestWithSizing.netProfit || 0,
    realizedSpreadPct:  applyResult.trade.spreadPct || bestWithSizing.spreadPct || 0,
    realizedNetUSD:     applyResult.trade.netProfit || 0,
    executionLatencyMs: applyResult.trade.executionMs || 0,
    score:              bestWithSizing.score || 0,
  });

  // ── Metrics ────────────────────────────────────────────────────────────
  metrics.increment('trades_executed_total');
  if (applyResult.trade.executionMs) {
    metrics.observe('execution_latency_ms', applyResult.trade.executionMs);
  }

  // ── Audited P&L + Alerts (v17) ────────────────────────────────────────
  const _pnlAfter = getPnL(bestWithSizing.buyPrice);
  auditedPnl.recordAuditedTrade(
    applyResult.trade, walletSnapshot, getBalances(), getLastKnownBtcPrice()
  );
  // Issue 14: Removed duplicate alerts.alertTradeExecuted call — keep only the named import below
  alerts.alertPnlVelocity(_pnlAfter?.realizedPnl ?? 0).catch(() => {});
  alerts.alertDailyLossWarning(_pnlAfter?.realizedPnl ?? 0, liveConfig.get('maxDailyLossUSD')).catch(() => {});

  appendEquityPoint(applyResult.trade);
  addDailyPnl(applyResult.trade.netProfit || 0);
  weeklyPnl.addWeeklyPnl(applyResult.trade.netProfit || 0);
  recordExecution(applyResult.trade);
  captureIfNoteworthy([bestWithSizing], orderBooks, snapshotDepths(), applyResult.trade).catch(() => {});
  persistTrade(applyResult.trade).catch(() => {});
  const equityCurve = getEquityCurve();
  persistEquityPoint(equityCurve[equityCurve.length - 1]).catch(() => {});
  recalcAdaptive(getOpportunityLog(), equityCurve.length);
  alertTradeExecuted(applyResult.trade).catch(() => {});
  dailyStats.recordTradeExecuted();
  executionQuality.recordTrade(bestWithSizing, result).catch?.(() => {});
  adaptivePosition.recordSize(tradeSize, bestWithSizing.score);
  try {
    const seenAtMs = bestWithSizing.lifecycle?.firstSeen
      ? new Date(bestWithSizing.lifecycle.firstSeen).getTime() : null;
    recordExecutionJournalEntry(bestWithSizing, orderBooks, applyResult.trade, seenAtMs);
  } catch (e) { _warn('[execution journal]', e.message); }

  const totalLatencyMs = tickStartTs != null ? (now - tickStartTs) : null;
  const decisionMs     = Date.now() - evalStart;

  obs.emit('EXECUTION', 'execution.trade_completed', {
    pair:           `${bestWithSizing.buyExchange}→${bestWithSizing.sellExchange}`,
    netProfit:      applyResult.trade.netProfit,
    size:           tradeSize,
    score:          bestWithSizing.score,
    slippageMethod: bestWithSizing.slippageMethod,
    timing:         { bookRecvMs, detectMs, decisionMs, totalLatencyMs },
    source,
  });

  pushToSSE({
    type:               'trade_executed',
    trade:              applyResult.trade,
    pnl:                getPnL(bestWithSizing.buyPrice),
    wallets:            getBalances(),
    ts:                 new Date().toISOString(),
    detectionSource:    source,
    detectionLatencyMs: totalLatencyMs,
    timing:             { bookRecvMs, detectMs, decisionMs, totalLatencyMs },
    ...(statArbSignals.length > 0 && { statArbSignals }),
  });

  pushToAlerts({ type: 'arb_trade', trade: applyResult.trade, ts: applyResult.trade.ts });

  return { ok: true, trade: applyResult.trade };
}

// ─── Event-driven detection (< 30ms latencia) ──────────────────────────────
// A4 (Sesión 2026-07-07): extraído de un closure anónimo pasado directo a
// `priceEmitter.on(...)` a una función nombrada, para poder invocarla
// directamente en tests sin emitir un evento real y esperar el microtask
// queue (mismo criterio que `_computeLoopDelay`/`_resetLoopBackoffForTests`:
// lógica separada del wiring). `_attachEventDriven()` sigue siendo el único
// punto que la conecta al emisor real — el comportamiento en producción no
// cambia un bit.
async function _handlePriceUpdate({ exchange, ask, ts }) {
  try {
      const now = Date.now();
      if (now - getLastAnyExecTs() < getExecCooldown()) return;
      if (!getBotEnabled() || isDailyLossBreached()) return;

      const orderBooksRaw = await getOrderBooks();
      if (!orderBooksRaw || orderBooksRaw.length < 2) return;
      const orderBooks = applyActiveScenario(orderBooksRaw);
      if (!orderBooks || orderBooks.length < 2) return;

      const bookRecvMs = Date.now() - now;
      const detStart   = Date.now();
      const { opportunities: rawOpps, triangularSignal, statArbSignals, multiHopSignal }
        = detectOpportunities(orderBooks);
      const detectMs = Date.now() - detStart;

      e2eLatency.record(bookRecvMs + detectMs, bookRecvMs, detectMs, exchange);
      spreadMomentum.recordFromOrderBooks(orderBooks, Date.now());

      const btcPrice = orderBooks.find(o => o.exchange === 'Binance')?.ask || ask;
      recordBtcPrice(btcPrice);
      if (btcPrice > 0) setLastKnownBtcPrice(btcPrice);

      const enriched      = enrichWithLiquidityPrediction(
        enrichWithFillProbability(rawOpps, btcPrice, getVolatilityStatus().score),
        { sizeUSD: liveConfig.get('tradeAmountBTC') * btcPrice },
      );
      const opportunities = attachExplainability(trackAll(enriched));
      expireStale();
      recordSnapshots(opportunities);

      for (const op of opportunities) {
        recordOpportunitySeen(op.buyExchange, op.sellExchange, op);
        if (op.viable) recordPairDetection(op.buyExchange, op.sellExchange);
        spreadHeatmap.record(
          `${op.buyExchange}→${op.sellExchange}`,
          op.spreadPct || 0,
          op.viable && !op.circuitBreaker,
        );
      }

      const opportunitiesWithMomentum = spreadMomentum.enrichOpportunities(opportunities);
      incrementScanned(opportunities.length);

      captureIfNoteworthy(opportunitiesWithMomentum, orderBooks, snapshotDepths(), null).catch(() => {});

      const topViable = opportunitiesWithMomentum.find(o => o.viable && !o.circuitBreaker && o.liquidityOk);
      if (topViable) alertOpportunityLarge(topViable).catch(() => {});

      const best = opportunitiesWithMomentum.find(op => {
        if (!op.viable || op.circuitBreaker || !op.liquidityOk) return false;
        if (op.score < getMinScore()) return false;
        return checkFingerprint(op, now);
      });

      if (!best) return;

      // Issue 25: Only advance cooldown on successful execution (moved inside await result)
      const _edResult = await executeBestOpportunity(best, {
        source:      'event_driven',
        orderBooks,
        tickStartTs: ts,
        detectMs,
        bookRecvMs,
        statArbSignals,
      });
      if (_edResult.ok) setLastAnyExecTs(now);

      // ── Triangular execution — Issue 9: routes through executeBestOpportunity ──
      try {
        if (triangularSignal && (triangularSignal.netPct || 0) >= 0.05) {
          // Synthesize a compatible opportunity object for the unified execution path
          const triOpp = {
            ...best,
            type:       'triangular',
            netPct:     triangularSignal.netPct,
            path:       triangularSignal.path,
            _triangularSignal: triangularSignal,
          };
          const triExec = await executeBestOpportunity(triOpp, {
            source: 'triangular',
            orderBooks,
          });
          if (triExec.ok) {
            obs.emit('EXECUTION', 'execution.triangular_completed', {
              path:      triangularSignal.path,
              netProfit: triExec.trade.netProfit,
              netPct:    triangularSignal.netPct,
            });
            pushToSSE({
              type:           'triangular_executed',
              trade:          triExec.trade,
              triangularPath: triangularSignal.path,
              netPct:         triangularSignal.netPct,
              ts:             new Date().toISOString(),
            });
          } else {
            _log(`[triangular] not executed: ${triExec.reason}`);
          }
        }
      } catch (triErr) { _warn('[triangular]', triErr.message); }

      // ── Multi-Hop execution — Item 4 (opt-in, disabled by default) ──────
      // Impacto documentado (per liveConfig.multiHopEnabled): con la config
      // por defecto (false), este bloque ni siquiera evalúa multiHopSignal —
      // cero latencia, CPU, o llamadas extra añadidas al tick, exactamente
      // el mismo comportamiento que existía antes de este item (informativo
      // solamente). Habilitarlo NO agrega WebSockets ni fetches nuevos hoy:
      // multiHopSignal ya se calcula cada tick sobre los mismos order books
      // del bilateral/triangular (buildExchangeChainGraph, Bellman-Ford
      // O(V·E) con V=5, E≈20 — microsegundos), así que el único costo real
      // de activarlo es el de ejecutar el trade en sí (igual a triangular).
      // Nota importante: sobre el grafo actual (mismo activo, nodos =
      // exchanges) un ciclo negativo es estructuralmente casi imposible —
      // ver la prueba matemática en el header de multiHopArbitrageEngine.js
      // — así que activar esta bandera hoy habilita la ejecución pero no
      // cambia el volumen de trades esperado. La extensión genuinamente
      // rentable (buildAssetGraphEdges, grafo multi-activo real) SÍ
      // requeriría fetchear libros ETH/USDT (u otros pares) en cada ciclo
      // — costo real de latencia/rate-limit — y deliberadamente sigue sin
      // conectarse al loop en vivo; conectarla es una decisión de producto
      // aparte, no un efecto secundario de este toggle.
      try {
        if (liveConfig.get('multiHopEnabled') && multiHopSignal &&
            (multiHopSignal.compoundedNetPct || 0) >= liveConfig.get('minMultiHopNetPct')) {
          const multiHopOpp = {
            ...best,
            type:              'multihop',
            netPct:            multiHopSignal.compoundedNetPct,
            path:              multiHopSignal.path,
            _multiHopSignal:   multiHopSignal,
          };
          const mhExec = await executeBestOpportunity(multiHopOpp, {
            source: 'multihop',
            orderBooks,
          });
          if (mhExec.ok) {
            obs.emit('EXECUTION', 'execution.multihop_completed', {
              path:      multiHopSignal.path,
              hops:      multiHopSignal.hops,
              netProfit: mhExec.trade.netProfit,
              netPct:    multiHopSignal.compoundedNetPct,
            });
            pushToSSE({
              type:        'multihop_executed',
              trade:       mhExec.trade,
              multiHopPath: multiHopSignal.path,
              hops:        multiHopSignal.hops,
              netPct:      multiHopSignal.compoundedNetPct,
              ts:          new Date().toISOString(),
            });
          } else {
            _log(`[multihop] not executed: ${mhExec.reason}`);
          }
        }
      } catch (mhErr) { _warn('[multihop]', mhErr.message); }

      // ── StatArb execution — Issue 8: now routes through executeBestOpportunity ──
      try {
        const bestStat = (statArbSignals || []).find(s => s.viable && s.confidence >= 90);
        if (bestStat) {
          const matchingOpp = rawOpps.find(o =>
            o.buyExchange === bestStat.buyExchange &&
            o.sellExchange === bestStat.sellExchange &&
            o.viable
          );
          if (matchingOpp) {
            // Route through executeBestOpportunity so all risk checks, state machine,
            // circuit breaker, daily loss limit, and audited P&L recording apply.
            const execResult = await executeBestOpportunity(matchingOpp, {
              source:         'stat_arb',
              orderBooks,
              statArbSignals: [bestStat],
            });
            if (execResult.ok) {
              _log(`[stat-arb] EXECUTED ${bestStat.buyExchange}→${bestStat.sellExchange} Z=${bestStat.zScore} net=$${execResult.trade.netProfit}`);
              pushToSSE({ type: 'stat_arb_executed', trade: execResult.trade, zScore: bestStat.zScore });
            } else {
              _log(`[stat-arb] not executed: ${execResult.reason}`);
            }
          }
        }
      } catch (e) { _warn('[stat-arb execution]', e.message); }

  } catch (e) {
    _warn('[event-driven]', e.message);
  }
}

function _attachEventDriven() {
  priceEmitter.on('priceUpdate', _handlePriceUpdate);
}

// ─── Background UI loop (150ms) ────────────────────────────────────────────
// M-1 fix: the loop previously ran forever on a flat 150ms setTimeout with
// no circuit breaker. If run() started throwing on every tick (e.g. a null
// dereference), that produced ~6.7 errors/second forever, logged only via
// the DEBUG_KUKORA-gated _warn() (silent in production). We now track
// consecutive failures, back off exponentially while they persist, and
// surface the condition through logger.error() + an observability event
// (both always-on, unlike _warn) so it is visible without DEBUG_KUKORA.
let _loopRunning = false;
let _consecutiveLoopErrors = 0;
// C-4 fix: lets server/index.js's shutdown coordinator stop the 150ms loop
// instead of leaving it running (and re-scheduling itself) while the rest
// of the process is tearing down.
let _shuttingDown = false;

const LOOP_BASE_DELAY_MS = 150;
// Below this many consecutive failures, keep the normal 150ms cadence —
// a single transient error (e.g. one exchange WS hiccup) shouldn't slow
// down the whole engine.
const LOOP_BACKOFF_THRESHOLD = 5;
// Cap the backoff so the loop always keeps trying at a bounded interval
// instead of eventually never retrying again.
const LOOP_MAX_BACKOFF_MS = 30_000;

// ── M-3: diff cache para los 4 campos "pesados" del tick SSE ───────────────
// El resto de campos throttled (journalSummary, missedSummary, etc.) ya se
// omiten condicionalmente por tickCount%N — pero orderBooks/opportunities/
// wallets/pnl se mandaban SIEMPRE completos en cada tick de 150ms, sin
// importar si habían cambiado. Se guarda la última serialización enviada de
// cada uno; si no cambió desde el tick anterior, se omite del payload (mismo
// patrón `...(cond && {campo})` que el resto del archivo) en vez de repetir
// bytes idénticos 6-7 veces por segundo por cliente conectado.
//
// Contrato con el frontend (retrocompatible): todo payload de tick trae
// `_delta: true` para señalarle al cliente que debe *mergear* los campos
// presentes sobre el estado que ya tiene, no reemplazarlo — ver el cambio
// correspondiente en `useArbitrageStream.js` (merge superficial en
// `setData`). El primer tick de cualquier conexión siempre manda los 4
// campos completos, porque el cache empieza en `undefined` y por lo tanto
// siempre difiere del primer valor real.
let _lastSentOrderBooksJSON  = undefined;
let _lastSentOpportunitiesJSON = undefined;
let _lastSentWalletsJSON     = undefined;
let _lastSentPnlJSON         = undefined;

function _diffChanged(cacheKey, value) {
  // JSON.stringify en vez de un deep-equal a mano: estos 4 campos ya se
  // serializan de todas formas para mandarlos por SSE, así que comparar
  // strings es tan barato como el trabajo que ya se iba a hacer, sin
  // agregar una dependencia de deep-equal solo para esto.
  const serialized = JSON.stringify(value);
  const changed = serialized !== _diffCacheRef[cacheKey];
  if (changed) _diffCacheRef[cacheKey] = serialized;
  return changed;
}

const _diffCacheRef = {
  get orderBooks()     { return _lastSentOrderBooksJSON; },
  set orderBooks(v)    { _lastSentOrderBooksJSON = v; },
  get opportunities()  { return _lastSentOpportunitiesJSON; },
  set opportunities(v) { _lastSentOpportunitiesJSON = v; },
  get wallets()        { return _lastSentWalletsJSON; },
  set wallets(v)       { _lastSentWalletsJSON = v; },
  get pnl()            { return _lastSentPnlJSON; },
  set pnl(v)           { _lastSentPnlJSON = v; },
};

/** Test-only: limpia el cache de diff para que cada test empiece con los 4
 * campos "siempre presentes" (mismo criterio que _resetLoopBackoffForTests). */
function _resetTickDiffCacheForTests() {
  _lastSentOrderBooksJSON     = undefined;
  _lastSentOpportunitiesJSON  = undefined;
  _lastSentWalletsJSON        = undefined;
  _lastSentPnlJSON            = undefined;
}

/** Pure function — exported for tests, no I/O. */
function _computeLoopDelay(consecutiveErrors) {
  if (consecutiveErrors < LOOP_BACKOFF_THRESHOLD) return LOOP_BASE_DELAY_MS;
  const exponent = Math.min(consecutiveErrors - LOOP_BACKOFF_THRESHOLD + 1, 8); // caps 2^8 well past LOOP_MAX_BACKOFF_MS
  return Math.min(LOOP_BASE_DELAY_MS * 2 ** exponent, LOOP_MAX_BACKOFF_MS);
}

/**
 * Records the outcome of one loop tick and, on state transitions, logs and
 * emits an observability event:
 *  - crossing the failure threshold  -> 'loop.backoff_engaged' (error)
 *  - recovering after being in backoff -> 'loop.recovered' (info)
 * Called from both failure sites inside run(): the getOrderBooks() guard
 * and the outer catch-all (see below).
 */
function _recordLoopOutcome(success, errMessage) {
  const wasInBackoff = _consecutiveLoopErrors >= LOOP_BACKOFF_THRESHOLD;

  if (success) {
    if (wasInBackoff) {
      logger.warn('arbitrageOrchestrator', 'Loop recovered after consecutive errors', {
        previousConsecutiveErrors: _consecutiveLoopErrors,
      });
      obs.emit('SYSTEM', 'loop.recovered', {
        previousConsecutiveErrors: _consecutiveLoopErrors,
      }, 'info');
    }
    _consecutiveLoopErrors = 0;
    return;
  }

  _consecutiveLoopErrors += 1;
  if (_consecutiveLoopErrors === LOOP_BACKOFF_THRESHOLD) {
    logger.error('arbitrageOrchestrator', 'Loop entering backoff after repeated errors', {
      consecutiveErrors: _consecutiveLoopErrors,
      lastError: errMessage,
    });
    obs.emit('SYSTEM', 'loop.backoff_engaged', {
      consecutiveErrors: _consecutiveLoopErrors,
      lastError: errMessage,
    }, 'error');
  }
}

/** Test-only reset — mirrors the _resetForTests() pattern used elsewhere. */
function _resetLoopBackoffForTests() {
  _consecutiveLoopErrors = 0;
  _loopRunning = false;
}

// ─── H-5 (Sesión 22): funciones puras de scoring/selección ─────────────────
/**
 * Pure selection — picks the best executable BTC opportunity from a tick's
 * detected list, or undefined if none qualifies. Extracted verbatim from
 * arbitrageLoop()'s inline `.find()` (no behavior change): must be viable,
 * not blocked by circuit breaker or liquidity, meet the live minScore, and
 * pass the fingerprint de-dup check.
 * @param {Array<object>} opportunities
 * @param {number} now  — Date.now() snapshot from the calling tick
 * @returns {object|undefined}
 */
function selectBestOpportunity(opportunities, now) {
  return opportunities.find(op => {
    if (!op.viable || op.circuitBreaker || !op.liquidityOk) return false;
    if (op.score < getEffectiveMinScore()) return false;
    if (!passesFillProbabilityGate(op)) return false;
    return checkFingerprint(op, now);
  });
}

// ADR-019 Sec1: Fill Probability execution gate
/**
 * passesFillProbabilityGate - hard gate, not a scoring input (see ADR-019
 * Part B Sec1 for the full math justification: below the gate, expected
 * value of attempting the trade is negative regardless of nominal spread,
 * because the fill itself, not the opportunity's quality, is in doubt).
 *
 * Neutral (passes) when: gate disabled, no threshold configured (0), or
 * op.fillProbability isn't present (e.g. the ETH path, which doesn't run
 * through fillProbabilityEngine today) - absence of data is never treated
 * as a rejection reason.
 */
function passesFillProbabilityGate(op) {
  if (!liveConfig.get('fillProbabilityGateEnabled')) return true;
  const threshold = liveConfig.get('minFillProbability');
  if (!threshold) return true; // 0 = disabled
  if (typeof op.fillProbability !== 'number') return true;
  if (op.fillProbability >= threshold) return true;

  obs.recordRejection(op, `Fill probability ${op.fillProbability} below minimum ${threshold}`,
    obs.RCA_CATEGORIES.FILL_PROBABILITY_TOO_LOW,
    { fillProbability: op.fillProbability, threshold, breakdown: op.fillProbabilityBreakdown || null });
  return false;
}

/**
 * Pure selection — ETH equivalent of selectBestOpportunity(). No fingerprint
 * check on the ETH path (matches the original inline predicate exactly —
 * this was already the pre-extraction behavior, not a change introduced
 * here).
 * @param {Array<object>} ethOpportunities
 * @returns {object|undefined}
 */
function selectBestEthOpportunity(ethOpportunities) {
  return ethOpportunities.find(op => {
    if (!op.viable || op.circuitBreaker || !op.liquidityOk) return false;
    if (op.score < getEffectiveMinScore()) return false;
    return true;
  });
}

// ─── H-5 (Sesión 22): housekeeping/telemetría del tick ─────────────────────
/**
 * Throttled systemic-condition alerts — extracted verbatim from
 * arbitrageLoop() (previously inline, no dedicated name). Fires the daily
 * stop alert and per-exchange reliability-degraded alerts on their existing
 * cadences (every 20 ticks / every 60 ticks respectively). Fire-and-forget,
 * same as before — errors from the alert webhooks are swallowed by the
 * `.catch(() => {})` already used at each call site, not by this function.
 * @param {number} tickCount
 */
function emitSystemicAlerts(tickCount) {
  if (tickCount % 20 !== 0) return;
  if (isDailyLossBreached()) alertDailyStop(getDailyPnl()).catch(() => {});
  if (tickCount % 60 === 0) {
    const scores = getAllReliabilityScores();
    for (const s of scores) {
      if (s.reliabilityScore < 60) alertExchangeDegraded(s.exchange, s.reliabilityScore).catch(() => {});
    }
  }
}

/**
 * Evaluates the three pre-execution guards (weekly loss/target, daily
 * target, volatility filter), including their throttled log lines —
 * extracted verbatim from the inline block inside arbitrageLoop()'s
 * bot-enabled branch. No behavior change: same cadences, same log text.
 * @param {number} tickCount
 * @returns {{weeklyBlocked: boolean, dailyTargetHit: boolean, volBlocked: boolean, volStatus: object}}
 */
function checkExecutionGuards(tickCount) {
  const weeklyBlocked  = weeklyPnl.isWeeklyLossBreached() || weeklyPnl.isWeeklyTargetHit();
  const dailyTargetHit = weeklyPnl.isDailyTargetHit(getDailyPnl());
  if (weeklyBlocked && tickCount % 60 === 0) {
    _log(weeklyPnl.isWeeklyLossBreached()
      ? '[weekly stop] Weekly loss limit breached — halted until Monday'
      : '[weekly target] Weekly profit target hit — auto-paused');
  }
  if (dailyTargetHit && tickCount % 60 === 0) {
    _log('[daily target] Daily profit target hit — auto-paused');
  }

  // ── Volatility filter ─────────────────────────────────────────────
  // Halt new trades when 1h BTC realized volatility exceeds maxVolatilityPct.
  // null = disabled. volStatus.score approximates 1h vol as reported by
  // exchangeIntelligence.getVolatilityStatus().
  const maxVol = liveConfig.get('maxVolatilityPct');
  const volStatus = getVolatilityStatus();
  const volBlocked = maxVol != null && volStatus?.score != null && volStatus.score > maxVol;
  if (volBlocked && tickCount % 20 === 0) {
    _log(`[volatility filter] vol=${volStatus.score?.toFixed(2)}% > max=${maxVol}% — halting`);
  }

  return { weeklyBlocked, dailyTargetHit, volBlocked, volStatus };
}

// ─── H-5 (Sesión 22): decisión de ejecución (BTC / ETH) ────────────────────
/**
 * BTC execution decision for one tick — extracted verbatim from
 * arbitrageLoop() (previously the first `if (getBotEnabled() && ...)` block).
 * Applies the cooldown/bot-enabled/daily-loss gate, then the three guards
 * from checkExecutionGuards(), then selects and (if found) executes the
 * best opportunity via the unified executeBestOpportunity() path. Same
 * side effects as before: recordExecuted(), setLastAnyExecTs(), the
 * '[loop-fallback] TRADE ...' log line.
 * @returns {{lastTrade: object|null}}
 */
// ─── H-5 (Sesión 22): detección ETH ─────────────────────────────────────────
/**
 * ETH bilateral opportunity detection (GAP 4) — extracted verbatim from the
 * inline block inside arbitrageLoop()'s BTC detection try/catch. Self-gated
 * on the same "every other tick (~300ms)" cadence, so calling it on an
 * odd tick is a safe no-op that returns []. Side effect preserved: updates
 * the last-known ETH price (H-6 remainder, Sesión 21) used by
 * executeBestOpportunity()'s capital-in-USD calculation. Errors are
 * swallowed exactly as before — an ETH feed hiccup must never stop the BTC
 * loop.
 * @param {number} tickCount
 * @returns {Promise<Array<object>>}
 */
async function detectEthOpportunities(tickCount) {
  if (tickCount % 2 !== 0) return [];
  try {
    const ethBooks = await getOrderBooksETH();
    if (!ethBooks || ethBooks.length < 2) return [];

    const ethDet = detectOpportunities(
      ethBooks.map(b => ({ ...b, asset: 'ETH' }))
    );
    const ethOpportunities = (ethDet.opportunities || []).map(op => ({ ...op, asset: 'ETH' }));

    // H-6 remainder (Sesión 21): sin esto, _capitalUSD en
    // executeBestOpportunity() no tenía forma de valorar las
    // tenencias de ETH en USD — subestimaba el capital total.
    const ethPrice = ethBooks.find(b => b.exchange === 'Binance')?.ask
      || ethBooks[0]?.ask;
    if (ethPrice > 0) setLastKnownEthPrice(ethPrice);

    return ethOpportunities;
  } catch { /* ETH feed errors don't stop BTC loop */ return []; }
}

async function evaluateAndExecuteBtc(opportunities, tickCount, now, orderBooks, detectMs) {
  if (!(getBotEnabled() && now - getLastAnyExecTs() >= getExecCooldown() && !isDailyLossBreached())) {
    return { lastTrade: null };
  }

  const { weeklyBlocked, dailyTargetHit, volBlocked } = checkExecutionGuards(tickCount);
  if (weeklyBlocked || dailyTargetHit || volBlocked) return { lastTrade: null };

  const best = selectBestOpportunity(opportunities, now);
  if (!best) return { lastTrade: null };

  recordExecuted();
  setLastAnyExecTs(now);
  const execResult = await executeBestOpportunity(best, {
    source:      'loop_fallback',
    orderBooks,
    tickStartTs: now,
    detectMs,
  });
  if (!execResult.ok) return { lastTrade: null };

  _log(`[loop-fallback] TRADE ${best.buyExchange}→${best.sellExchange} net=$${execResult.trade.netProfit} slip=${best.slippageMethod}`);
  return { lastTrade: execResult.trade };
}

/**
 * ETH execution decision for one tick — extracted verbatim from
 * arbitrageLoop() (previously the second `if (getBotEnabled() && ...)`
 * block, gated on `lastTrade === null` so ETH only executes if BTC didn't
 * trade this tick). See the H-6 (Sesión 20) comment preserved below for why
 * this routes through executeBestOpportunity() instead of calling
 * executeSimulated()/applyTrade() directly.
 * @param {object|null} lastTrade  — result of evaluateAndExecuteBtc() this tick
 * @returns {{lastTrade: object|null}}
 */
async function evaluateAndExecuteEth(ethOpportunities, lastTrade, tickCount, now, orderBooks, detectMs) {
  // H-6 fix (Sesión 20): antes este bloque llamaba executeSimulated()/
  // applyTrade() directamente, sin pasar por executeBestOpportunity() —
  // los trades "ETH" no tenían pre-trade risk check, state machine,
  // audited P&L, slippage calibration, ni alertas, a diferencia de BTC.
  // Además executeSimulated() y _applyTradeInternal() estaban
  // hardcodeados a wallets.BTC, así que los trades ETH en realidad
  // debitaban/acreditaban el wallet de BTC bajo una etiqueta falsa
  // (ver fix en opportunityDetection.js y walletManager.ts). Ahora ETH
  // pasa por el mismo camino unificado que BTC, con las mismas
  // garantías.
  if (!(getBotEnabled() && lastTrade === null && now - getLastAnyExecTs() >= getExecCooldown() && !isDailyLossBreached())) {
    return { lastTrade };
  }

  const bestEth = selectBestEthOpportunity(ethOpportunities);
  if (!bestEth) return { lastTrade };

  recordExecuted();
  setLastAnyExecTs(now);
  const execResult = await executeBestOpportunity(bestEth, {
    source:      'eth_loop_fallback',
    orderBooks,
    tickStartTs: now,
    detectMs,
  });
  if (!execResult.ok) return { lastTrade };

  _log(`[ETH trade] ${bestEth.buyExchange}→${bestEth.sellExchange} net=$${execResult.trade.netProfit}`);
  return { lastTrade: execResult.trade };
}

// ─── H-5 (Sesión 22): detección BTC (+ orquesta la detección ETH) ──────────
/**
 * Main per-tick opportunity detection — extracted verbatim from the inline
 * try block inside arbitrageLoop() (previously the bulk of the "detection"
 * section, with the ETH sub-block already factored out into
 * detectEthOpportunities()). Preserves every side effect and throttled
 * cadence exactly as before: metrics, counters, replay capture (every 3
 * ticks), and the periodic log line (every 20 ticks). The caller is
 * expected to wrap this in the same try/catch it always had — this
 * function does not swallow errors itself (unlike detectEthOpportunities,
 * whose feed must never stop the BTC loop).
 * @param {Array<object>} orderBooks
 * @param {number} tickCount
 * @returns {Promise<{opportunities: Array, triangularSignal: object|null,
 *   triangularSignals: Array, statArbSignals: Array, multiHopSignal: object|null,
 *   detectMs: number, ethOpportunities: Array}>}
 */
async function detectBtcOpportunities(orderBooks, tickCount) {
  const detStart = Date.now();
  const det       = detectOpportunities(orderBooks);
  const detectMs  = Date.now() - detStart;
  metrics.observe('detection_latency_ms', detectMs);
  metrics.increment('detection_cycles_total');
  const triangularSignal  = det.triangularSignal;
  const triangularSignals = det.triangularSignals || [];
  const statArbSignals    = det.statArbSignals || [];
  const multiHopSignal    = det.multiHopSignal || null;
  try { require('../infrastructure/metricsService').increment('detection_cycles'); } catch (_) { /* metricsService is optional — fire-and-forget */ }

  // ETH bilateral detection (GAP 4) — every other tick (~300ms)
  const ethOpportunities = await detectEthOpportunities(tickCount);

  const btcPriceLoop = orderBooks.find(o => o.exchange === 'Binance')?.ask;
  if (btcPriceLoop) { recordBtcPrice(btcPriceLoop); setLastKnownBtcPrice(btcPriceLoop); }
  const enrichedLoop  = enrichWithLiquidityPrediction(
    enrichWithFillProbability(det.opportunities, btcPriceLoop),
    { sizeUSD: liveConfig.get('tradeAmountBTC') * (btcPriceLoop || 50000) },
  );
  const opportunities = attachExplainability(trackAll(enrichedLoop));
  expireStale();
  recordSnapshots(opportunities);
  recordSnapshots(ethOpportunities);
  for (const op of opportunities) {
    recordOpportunitySeen(op.buyExchange, op.sellExchange, op);
    if (op.viable) recordPairDetection(op.buyExchange, op.sellExchange);
  }

  incrementScanned(opportunities.length);
  incrementViable(opportunities.filter(o => o.viable && !o.synthetic).length);
  incrementTick();

  if (tickCount % 3 === 0) {
    captureIfNoteworthy(opportunities, orderBooks, snapshotDepths(), null).catch(() => {});
  }

  const LOG_EVERY = 20;
  if (tickCount % LOG_EVERY === 0 && opportunities.length > 0) {
    const viableNow = opportunities.filter(o => o.viable).length;
    const top = opportunities[0];
    _log(
      `[arb loop] tick=${tickCount} detect=${detectMs}ms` +
      ` books=${orderBooks.length} opps=${opportunities.length} viable=${viableNow}` +
      ` | top: ${top?.buyExchange}→${top?.sellExchange}` +
      ` net=$${top?.netProfit} spread=${top?.spreadPct}% slip=${top?.slippageMethod}`
    );
  }

  return { opportunities, triangularSignal, triangularSignals, statArbSignals, multiHopSignal, detectMs, ethOpportunities };
}

// ─── H-5 (Sesión 22): housekeeping — missed-opportunity tracking ───────────
/**
 * Records why each still-open viable opportunity was NOT executed this
 * tick, in priority order — extracted verbatim from the throttled
 * (every-2-ticks) block inside arbitrageLoop(). Reasons are mutually
 * exclusive and evaluated in the same order as before: daily loss > bot
 * disabled > cooldown > score too low > fingerprint de-dup.
 * @param {Array<object>} opportunities
 * @param {number} tickCount
 */
function trackMissedOpportunities(opportunities, tickCount) {
  if (tickCount % 2 !== 0) return;
  const inCooldown   = Date.now() - getLastAnyExecTs() < getExecCooldown();
  const dailyStopped = isDailyLossBreached();
  for (const op of opportunities) {
    if (!op.viable || op.circuitBreaker || !op.liquidityOk) continue;
    if      (dailyStopped)               recordMissed(op, 'daily_loss');
    else if (!getBotEnabled())           recordMissed(op, 'other');
    else if (inCooldown)                 recordMissed(op, 'cooldown');
    else if (op.score < getMinScore())   recordMissed(op, 'score_too_low');
    else if (!checkFingerprint(op, Date.now())) recordMissed(op, 'fingerprint');
  }
}

// ─── H-5 (Sesión 22): housekeeping — enriquecimiento + payload del tick ────
/**
 * Frequency-throttled intelligence enrichment for one tick — extracted
 * verbatim from the block inside arbitrageLoop() between missed-opportunity
 * tracking and payload construction. Every throttle cadence preserved
 * exactly (predictiveRanking every 5 ticks, historicalLearning every 10,
 * lifecycleSummary every 5, speedBenchmarkHistory every 3,
 * capitalEfficiency/rebalanceProjection every 7). `oppsWithSize` is the
 * same `opportunities` array with `recommendedSize`/`recommendedSizeUSD`/
 * `capitalFactors` attached to viable entries.
 * @param {Array<object>} orderBooks
 * @param {Array<object>} opportunities
 * @param {number} tickCount
 */
function buildEnrichmentData(orderBooks, opportunities, tickCount) {
  const bestAskPrice = getBestAskPrice(orderBooks);
  const wallets      = getBalances();

  const volatilityStatus   = getVolatilityStatus();
  const exchangeRanking    = getExchangeRanking();
  const reliabilityLeader  = getReliabilityLeaderboard();
  const activeLifecycles   = getActiveLifecycles();
  const predictiveRanking  = tickCount % 5  === 0 ? getPredictiveRanking(activeLifecycles, exchangeRanking) : undefined;
  const historicalLearning = tickCount % 10 === 0 ? getHistoricalLearning() : undefined;
  const lifecycleSummary   = tickCount % 5  === 0 ? getLifecycleSummary() : undefined;
  const speedBenchmark     = computeBenchmark(orderBooks);
  const speedBenchmarkHistory = tickCount % 3 === 0 ? getBenchmarkHistory(60) : undefined;

  let capitalEfficiency, rebalanceProjection;
  if (tickCount % 7 === 0) {
    const pnlNow = getPnL(bestAskPrice);
    capitalEfficiency   = computeCapitalEfficiency(wallets, bestAskPrice, pnlNow, Date.now() - getBotStarted());
    rebalanceProjection = computeRebalanceProjection(wallets, getInitialBalances(), getTradeHistory(), bestAskPrice);
  }

  // Attach recommendedSize to viable opportunities
  const oppsWithSize = opportunities.map(op => {
    if (!op.viable) return op;
    const _capRec = recommendCapitalSize(op, wallets, bestAskPrice || 100000);
    return {
      ...op,
      recommendedSize:    typeof _capRec === 'object' ? _capRec.btc  : _capRec,
      recommendedSizeUSD: typeof _capRec === 'object' ? _capRec.usd  : null,
      capitalFactors:     typeof _capRec === 'object' ? _capRec.factors : null,
    };
  });

  return {
    bestAskPrice, wallets, volatilityStatus, exchangeRanking, reliabilityLeader,
    activeLifecycles, predictiveRanking, historicalLearning, lifecycleSummary,
    speedBenchmark, speedBenchmarkHistory, capitalEfficiency, rebalanceProjection,
    oppsWithSize,
  };
}

/**
 * Assembles the full SSE tick payload — extracted verbatim from the inline
 * object literal at the end of arbitrageLoop(). Every throttled field
 * (`...(tickCount % N === 0 && {...})`) keeps its exact original cadence.
 * `ctx` is expected to carry every field produced by detectBtcOpportunities(),
 * evaluateAndExecuteBtc()/evaluateAndExecuteEth(), and buildEnrichmentData()
 * for this tick, plus `tickCount` and `orderBooks`.
 * @param {object} ctx
 * @returns {object} the SSE payload, ready for pushToSSE()
 */
function buildTickPayload(ctx) {
  const {
    tickCount, orderBooks, triangularSignal, triangularSignals, statArbSignals, multiHopSignal,
    detectMs, lastTrade, ethOpportunities,
    bestAskPrice, wallets, volatilityStatus, exchangeRanking, reliabilityLeader,
    activeLifecycles, predictiveRanking, historicalLearning, lifecycleSummary,
    speedBenchmark, speedBenchmarkHistory, capitalEfficiency, rebalanceProjection,
    oppsWithSize,
  } = ctx;

  const { getCounters } = require('./arbitrage.state');
  const counters = getCounters();

  const pnlValue = getPnL(bestAskPrice);

  return {
    type:              'tick',
    // M-3: mergeable delta contract — el cliente debe mergear los campos
    // presentes sobre su estado previo (ver useArbitrageStream.js), no
    // reemplazarlo, porque de acá en adelante no todos los campos vienen
    // en todos los ticks.
    _delta:            true,
    botEnabled:        getBotEnabled(),
    minScore:          getMinScore(),
    uptimeMs:          Date.now() - getBotStarted(),
    wsStatus:          wsStatus(),
    feedFreshness:     getFreshness(),
    ...(_diffChanged('orderBooks', orderBooks)       && { orderBooks }),
    ...(_diffChanged('opportunities', oppsWithSize)  && { opportunities: oppsWithSize }),
    triangularSignal,
    triangularSignals: triangularSignals || [],
    statArbSignals,
    // Audit item #4 — see multiHopArbitrageEngine.js. Same shape/status as
    // triangularSignal: null when no negative cycle is currently found.
    multiHopSignal:    multiHopSignal || null,
    lastTrade,
    ...(_diffChanged('wallets', wallets)             && { wallets }),
    ...(_diffChanged('pnl', pnlValue)                && { pnl: pnlValue }),
    dailyPnl:          getDailyPnl(),
    dailyLossBreached: isDailyLossBreached(),
    weeklyStats:       weeklyPnl.getWeeklyStats(),
    opportunitiesScanned: counters.totalOpportunitiesScanned,
    viableFound:       counters.totalViableFound,
    tradesExecuted:    getTradeHistory().length,
    detectionMode:     'event_driven_ws + loop_150ms',
    detectMs,
    rejectionCounts:     getRejectionCounts(),
    bestOpportunitySeen: getBestOpportunitySeen(),
    nearViableCount:     getNearViableCount(),
    speedBenchmark,
    ...(speedBenchmarkHistory !== undefined && { speedBenchmarkHistory }),
    ...(capitalEfficiency     !== undefined && { capitalEfficiency }),
    ...(rebalanceProjection   !== undefined && { rebalanceProjection }),
    ...(tickCount % 5 === 0  && { journalSummary: getJournalSummary() }),
    stressTest: getActiveScenario(),
    ...(tickCount % 10 === 0 && { statArbSummary: getStatArbSummary() }),
    ...(tickCount % 5  === 0 && { missedSummary: getMissedSummary() }),
    ...(tickCount % 8  === 0 && { reliabilityScores: getAllReliabilityScores() }),
    ...(tickCount % 15 === 0 && { adaptiveRecommendation: getRecommendation() }),
    volatilityStatus,
    exchangeRanking,
    reliabilityLeaderboard: reliabilityLeader,
    activeLifecycles,
    ...(predictiveRanking  !== undefined && { predictiveRanking }),
    ...(historicalLearning !== undefined && { historicalLearning }),
    ...(lifecycleSummary   !== undefined && { lifecycleSummary }),
    ...(tickCount % 5  === 0 && { history: getTradeHistory().slice(-20).reverse() }),
    ...(lastTrade || tickCount % 10 === 0 ? { equityCurve: getEquityCurve().slice(-100) } : {}),
    ...(tickCount % 10 === 0 && { lifecycleHistory: getLifecycleHistory(30) }),
    ethOpportunities: ethOpportunities.slice(0, 20),
    engineConfig:  liveConfig.getAll().current,
    configChanged: liveConfig.getAll().changedKeys,
    ...(tickCount % 5 === 0 && (() => {
      try {
        const _w  = getBalances();
        const _bp = getLastKnownBtcPrice();
        return { auditedPnl: auditedPnl.getAuditedPnl(_w, _bp) };
      } catch { return {}; }
    })()),
    ts: new Date().toISOString(),
  };
}

async function arbitrageLoop() {
  if (_loopRunning) return;
  _loopRunning = true;

  const run = () => withSpan('arbitrage.tick', async () => {
    try {
      let orderBooks = [];
      try {
        const rawBooks = await withSpan('arbitrage.fetchOrderBooks', () => getOrderBooks());
        orderBooks = applyActiveScenario(rawBooks);
      } catch (e) { _warn('[arb loop] getOrderBooks:', e.message); _recordLoopOutcome(false, e.message); return; }

      let opportunities = [], triangularSignal = null, triangularSignals = [],
          statArbSignals = [], multiHopSignal = null, detectMs = 0;
      let ethOpportunities = [];
      const tickCount = getTickCount();

      try {
        ({ opportunities, triangularSignal, triangularSignals, statArbSignals, multiHopSignal, detectMs, ethOpportunities }
          = await withSpan('arbitrage.detectOpportunities', () => detectBtcOpportunities(orderBooks, tickCount),
            { attributes: { 'kukora.tick': tickCount } }));
      } catch (e) { _warn('[arb loop] detectOpportunities:', e.message); }

      let lastTrade = null;
      const now     = Date.now();

      // systemic condition alerts (throttled)
      emitSystemicAlerts(tickCount);

      ({ lastTrade } = await withSpan('arbitrage.evaluateAndExecute.btc',
        () => evaluateAndExecuteBtc(opportunities, tickCount, now, orderBooks, detectMs),
        { attributes: { 'kukora.opportunities.count': opportunities.length } }));

      // ETH execution — only if no BTC trade this tick
      ({ lastTrade } = await withSpan('arbitrage.evaluateAndExecute.eth',
        () => evaluateAndExecuteEth(ethOpportunities, lastTrade, tickCount, now, orderBooks, detectMs),
        { attributes: { 'kukora.eth_opportunities.count': ethOpportunities.length } }));

      // Item 1 fase B (ADR-017): pase de ejecución por-tenant, aditivo.
      // Corre DESPUÉS del bot compartido, sobre las mismas oportunidades
      // ya detectadas este tick (BTC y, desde A3, ETH) — no repite
      // fetches ni detección. No-op inmediato si no hay tenants activos
      // (getBotEnabled() global no se toca). Aislado en su propio
      // try/catch: un fallo aquí nunca debe afectar el tick del bot
      // compartido, que ya corrió arriba.
      try {
        await runTenantExecutionPass(opportunities, ethOpportunities, now);
      } catch (e) { _warn('[arb loop] tenant execution pass:', e.message); }

      // Track missed opportunities (throttled)
      trackMissedOpportunities(opportunities, tickCount);

      const enrichment = buildEnrichmentData(orderBooks, opportunities, tickCount);

      const payload = buildTickPayload({
        tickCount, orderBooks, triangularSignal, triangularSignals, statArbSignals, multiHopSignal,
        detectMs, lastTrade, ethOpportunities, ...enrichment,
      });
      pushToSSE(payload);
      _recordLoopOutcome(true);

    } catch (e) {
      _warn('[arb loop]', e.message);
      _recordLoopOutcome(false, e.message);
    }
  });

  async function serialLoop() {
    if (_shuttingDown) { _loopRunning = false; return; }
    try { await run(); } catch (e) { _warn('[arb loop]', e.message); _recordLoopOutcome(false, e.message); }
    if (_shuttingDown) { _loopRunning = false; return; }
    setTimeout(serialLoop, _computeLoopDelay(_consecutiveLoopErrors));
  }
  serialLoop();
}

// ─── Shutdown (C-4 fix) ─────────────────────────────────────────────────────
// Stops the 150ms loop from rescheduling itself. Idempotent — safe to call
// even if the loop already stopped on its own (e.g. never started in tests).
function stopEngine() {
  _shuttingDown = true;
  stopTenantPersistenceFlush();
}

// ─── Startup sequence ──────────────────────────────────────────────────────
async function _startup() {
  try {
    await watchdog.init();
    watchdog.registerShutdownHandler('bot_state', async () => {
      process.stdout.write('[shutdown] Saving final state...\n');
    });
    await alerts.alertSystemRestart('server_start', null);
  } catch (e) {
    process.stdout.write('[startup] watchdog init error: ' + e.message + '\n');
  }

  // Restore equity curve from persistence
  const { setEquityCurve, getCounters } = require('./arbitrage.state');
  try {
    const restored = await restoreSession();
    if (restored?.equityCurve?.length) {
      setEquityCurve(restored.equityCurve.slice(-500));
    }

    // GAP 3: Restore richer structured engine snapshot (equity + dailyPnl)
    try {
      const engineSnap = await restoreEngineSnapshot('default');
      if (engineSnap) {
        if (engineSnap.equityCurve?.length > (restored?.equityCurve?.length || 0)) {
          setEquityCurve(engineSnap.equityCurve.slice(-500));
        }
        if (engineSnap.dailyPnl) {
          addDailyPnl(engineSnap.dailyPnl);
          process.stdout.write(`[startup] Restored dailyPnl=$${engineSnap.dailyPnl} totalTrades=${engineSnap.totalTrades} from EngineSnapshot\n`);
        }
        // Punto 7 (auditoría comité, sección 12): restaurar balances de
        // wallet — antes de este fix el campo ni se persistía, así que
        // el bot compartido siempre arrancaba con el balance inicial sin
        // importar cuánto capital simulado tuviera acumulado la sesión
        // anterior. setBalances valida la forma y rechaza silenciosamente
        // un blob corrupto o de un shape legacy (sin la validación, se
        // mantiene el balance inicial de siempre).
        if (engineSnap.wallets) {
          const applied = setBalances(engineSnap.wallets);
          if (applied) {
            process.stdout.write('[startup] Restored wallet balances from EngineSnapshot\n');
          } else {
            process.stdout.write('[startup] Restored wallets blob had invalid shape — kept initial balances\n');
          }
        }
      }
    } catch (e) {
      process.stdout.write('[startup] engine snapshot restore error (non-fatal): ' + e.message + '\n');
    }

    startPeriodicFlush(() => {
      const curve = getEquityCurve();
      return {
        totalTrades:   curve.length,
        lastEquityPnl: curve[curve.length - 1]?.pnl,
        botUptimeMs:   Date.now() - getBotStarted(),
        sessionId:     currentSessionId(),
      };
    }, 60_000);

    // GAP 3: Start frequent structured engine snapshot flush (every 30s)
    startEngineSnapshotFlush(() => {
      const curve = getEquityCurve();
      return {
        equityCurve: curve,
        dailyPnl:    getDailyPnl(),
        totalTrades: curve.length,
        tradeLog:    getTradeHistory().slice(-200),
        counters:    getCounters(),
        // Punto 7: capturar balances de wallet en cada flush periódico
        // (cada 30s) para que un restart restaure el capital simulado
        // real en vez del balance inicial fijo.
        wallets:     getBalances(),
      };
    }, 'default', 30_000);

    // M-5: retry queue for persistTrade()/persistEquityPoint() writes that
    // failed while MongoDB was briefly unreachable (deploy, network blip,
    // replica-set failover) — self-heals once Mongo comes back instead of
    // silently losing that trade's persisted audit copy.
    startPersistenceRetryFlush(15_000);

    // ADR-017 pendiente #2: flush periódico de snapshots por-tenant
    // (independiente del slot único que usa startEngineSnapshotFlush para
    // el bot compartido — ver tenantPersistence.js). No-op de bajo costo
    // si no hay tenants activos.
    startTenantPersistenceFlush(30_000);

    dailyStats.init({ getTradeHistory, getMissedSummary, getBestOpportunitySeen });
    dailyStats.startPeriodicFlush(5 * 60 * 1000);
    spreadHeatmap.startPeriodicFlush(10 * 60 * 1000);
    dailyReport.init({
      getTradeHistory, getMissedSummary, getBestOpportunitySeen,
      getE2EStats:  () => e2eLatency.getStats(),
      getDailyStats: () => dailyStats.getDailyStats(1),
      alertService: { sendRaw: null },
    });
    dailyReport.start(getBotStarted());
  } catch (e) {
    _warn('[startup/restore]', e.message, '— starting fresh');
  }
}

// ─── Public API ────────────────────────────────────────────────────────────
function startEngine() {
  latencyRacing.attach(priceEmitter);
  _attachEventDriven();
  setTimeout(_startup, 0);
  arbitrageLoop();
}

module.exports = {
  startEngine,
  stopEngine,
  executeBestOpportunity,
  getMinScore,
  getExecCooldown,
  snapshotDepths,
  // M-1: pure/test-only helpers for the loop circuit breaker/backoff.
  // Not part of the runtime public API — used by arbitrageOrchestrator.test.js.
  _computeLoopDelay,
  _recordLoopOutcome,
  _resetLoopBackoffForTests,
  _getLoopBackoffStateForTests: () => _consecutiveLoopErrors,
  // M-3: reset del cache de diff del tick SSE — mismo criterio que
  // _resetLoopBackoffForTests, solo para tests.
  _resetTickDiffCacheForTests,
  // H-5 (Sesión 22): funciones puras/testeables extraídas de arbitrageLoop().
  selectBestOpportunity,
  selectBestEthOpportunity,
  emitSystemicAlerts,
  checkExecutionGuards,
  evaluateAndExecuteBtc,
  evaluateAndExecuteEth,
  detectEthOpportunities,
  detectBtcOpportunities,
  trackMissedOpportunities,
  buildEnrichmentData,
  buildTickPayload,
  // A4: handler del path event-driven, extraído para poder invocarlo
  // directamente en tests (regresión del bug de multiHopSignal — ver
  // arbitrageOrchestratorEventDriven.test.js). No es parte de la API
  // pública en runtime; solo `_attachEventDriven()` lo usa ahí.
  _handlePriceUpdateForTests: _handlePriceUpdate,
  // ADR-019: exported for test coverage of the fill probability gate and
  // the regime-scaled minScore, independent of full selectBestOpportunity().
  passesFillProbabilityGate,
  getEffectiveMinScore,
};

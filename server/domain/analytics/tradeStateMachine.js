/**
 * tradeStateMachine.js — Kukora v17
 *
 * Section 2: Institutional-grade trade lifecycle state machine.
 * Section 3: Partial fill management.
 * Section 4: Failure recovery engine.
 * Section 5: Hedge engine stubs.
 *
 * Every trade transition is persisted, auditable, and reconstructable.
 * The state machine enforces valid transitions and records all events
 * with timestamps, reasons, and actor metadata.
 *
 * State diagram:
 *
 *   OPPORTUNITY_DETECTED
 *        ↓ (scoring)
 *      SCORING
 *        ↓ (approved) / → FAILED (rejected)
 *      APPROVED
 *        ↓ (order created)
 *   ORDER_CREATED
 *        ↓ (submitted)
 *   ORDER_SUBMITTED
 *        ↓ (partial) / ↓ (full)
 *   PARTIALLY_FILLED → (retry/hedge/unwind)
 *      FILLED
 *        ↓
 *     SETTLING
 *        ↓
 *    COMPLETED / FAILED / ROLLED_BACK / EMERGENCY_EXIT
 */

'use strict';

const crypto = require('crypto');
const liveConfig = require('../../infrastructure/liveConfig');

// ─── States ────────────────────────────────────────────────────────────────
const STATES = Object.freeze({
  OPPORTUNITY_DETECTED: 'OPPORTUNITY_DETECTED',
  SCORING:              'SCORING',
  APPROVED:             'APPROVED',
  ORDER_CREATED:        'ORDER_CREATED',
  ORDER_SUBMITTED:      'ORDER_SUBMITTED',
  PARTIALLY_FILLED:     'PARTIALLY_FILLED',
  FILLED:               'FILLED',
  SETTLING:             'SETTLING',
  COMPLETED:            'COMPLETED',
  FAILED:               'FAILED',
  ROLLED_BACK:          'ROLLED_BACK',
  EMERGENCY_EXIT:       'EMERGENCY_EXIT',
});

// Valid state transitions
const TRANSITIONS = {
  OPPORTUNITY_DETECTED: ['SCORING', 'FAILED'],
  SCORING:              ['APPROVED', 'FAILED'],
  APPROVED:             ['ORDER_CREATED', 'FAILED'],
  ORDER_CREATED:        ['ORDER_SUBMITTED', 'FAILED'],
  ORDER_SUBMITTED:      ['PARTIALLY_FILLED', 'FILLED', 'FAILED'],
  PARTIALLY_FILLED:     ['FILLED', 'FAILED', 'ROLLED_BACK', 'EMERGENCY_EXIT'],
  FILLED:               ['SETTLING', 'FAILED', 'ROLLED_BACK'],
  SETTLING:             ['COMPLETED', 'FAILED', 'ROLLED_BACK'],
  COMPLETED:            [],  // terminal
  FAILED:               ['ROLLED_BACK', 'EMERGENCY_EXIT'],  // can still attempt recovery
  ROLLED_BACK:          [],  // terminal
  EMERGENCY_EXIT:       [],  // terminal
};

// ─── In-memory trade store ────────────────────────────────────────────────
const _trades = new Map();   // tradeId → TradeRecord
const _history = [];         // completed/failed trades (rolling, last 500)
const MAX_HISTORY = 500;

// ─── TradeRecord factory ──────────────────────────────────────────────────

/**
 * Create a new trade record from an opportunity.
 * Returns the tradeId.
 */
function createTrade(opportunity, source = 'engine') {
  const tradeId = `trade-${Date.now()}-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const record = {
    tradeId,
    state: STATES.OPPORTUNITY_DETECTED,
    source,
    createdAt: now,
    updatedAt: now,

    // Opportunity snapshot (immutable after creation)
    opportunity: {
      buyExchange:    opportunity.buyExchange,
      sellExchange:   opportunity.sellExchange,
      buyPrice:       opportunity.buyPrice,
      sellPrice:      opportunity.sellPrice,
      spreadPct:      opportunity.spreadPct,
      netProfit:      opportunity.netProfit,
      netProfitPct:   opportunity.netProfitPct,
      score:          opportunity.score,
      slippagePct:    opportunity.slippagePct,
      tradeAmount:    opportunity.tradeAmount,
      type:           opportunity.type || 'cross_exchange',
      pair:           opportunity.pair || `${opportunity.buyExchange}→${opportunity.sellExchange}`,
      detectedAt:     opportunity.ts || now,
    },

    // Execution tracking
    execution: {
      requestedAmount:  null,
      filledAmount:     null,
      fillRatio:        null,
      buyFillPrice:     null,
      sellFillPrice:    null,
      executionMs:      null,
      retryCount:       0,
      partialFills:     [],
    },

    // P&L tracking
    pnl: {
      grossProfit:   null,
      fees:          null,
      slippage:      null,
      netProfit:     null,
      netProfitPct:  null,
    },

    // Recovery tracking
    recovery: {
      attempted:      false,
      action:         null,     // 'retry' | 'hedge' | 'reverse' | 'cancel' | 'emergency_liquidation'
      reason:         null,
      outcome:        null,
      hedgeTrades:    [],
    },

    // RCA (Root Cause Analysis)
    rca: {
      rejectionReason:  null,
      failureCategory:  null,   // 'insufficient_liquidity' | 'insufficient_balance' | 'price_moved' | 'exchange_timeout' | 'api_outage' | 'partial_fill_below_threshold'
      diagnostics:      {},
      blockedBy:        null,   // which rule/check blocked the trade
    },

    // Full event log — every transition recorded here
    events: [
      {
        ts:        now,
        from:      null,
        to:        STATES.OPPORTUNITY_DETECTED,
        actor:     source,
        reason:    'Trade record created',
        data:      { opportunityScore: opportunity.score, spreadPct: opportunity.spreadPct },
      },
    ],
  };

  _trades.set(tradeId, record);
  return tradeId;
}

/**
 * Transition a trade to a new state.
 * Validates the transition, records the event, updates timestamps.
 * Returns { ok, record } or { ok: false, error }.
 */
function transition(tradeId, toState, { actor = 'system', reason = '', data = {} } = {}) {
  const record = _trades.get(tradeId);
  if (!record) return { ok: false, error: `Trade ${tradeId} not found` };

  const fromState = record.state;
  const allowed   = TRANSITIONS[fromState] || [];

  if (!allowed.includes(toState)) {
    return {
      ok:    false,
      error: `Invalid transition ${fromState} → ${toState} for trade ${tradeId}`,
      allowedTransitions: allowed,
    };
  }

  const now = new Date().toISOString();
  record.state     = toState;
  record.updatedAt = now;

  // Merge any data fields into the record
  if (data.execution)  Object.assign(record.execution, data.execution);
  if (data.pnl)        Object.assign(record.pnl, data.pnl);
  if (data.recovery)   Object.assign(record.recovery, data.recovery);
  if (data.rca)        Object.assign(record.rca, data.rca);

  record.events.push({
    ts:     now,
    from:   fromState,
    to:     toState,
    actor,
    reason,
    data:   { ...data, execution: undefined, pnl: undefined, recovery: undefined, rca: undefined },
  });

  // Move terminal states to history
  const terminal = ['COMPLETED', 'ROLLED_BACK', 'EMERGENCY_EXIT'];
  if (terminal.includes(toState)) {
    _history.unshift(record);
    if (_history.length > MAX_HISTORY) _history.pop();
    _trades.delete(tradeId);
  }

  return { ok: true, record };
}

/**
 * Get active (non-terminal) trades.
 */
function getActiveTrades() {
  return Array.from(_trades.values());
}

/**
 * Get completed/failed trade history.
 */
function getHistory(limit = 100) {
  return _history.slice(0, limit);
}

/**
 * Get a specific trade record (active or historical).
 */
function getTrade(tradeId) {
  return _trades.get(tradeId) || _history.find(t => t.tradeId === tradeId) || null;
}

// ─── Section 3: Partial Fill Management ──────────────────────────────────

/**
 * Classify a fill ratio into one of the 3 committee-specified tiers.
 * This is the real implementation of the Fase 1 answer: "partial fills en
 * 3 tramos — >80% acepta el fill parcial; 50-80% completa el resto con
 * market inmediata; <50% cierra la pierna ejecutada como pérdida
 * controlada."
 *
 * Returns 'high' | 'mid' | 'low'. Pure function of the two configured
 * thresholds — exported separately so callers (and tests) can classify
 * a ratio without needing a trade record.
 */
function classifyFillTier(fillRatio) {
  const highThreshold = liveConfig.get('highFillRatioThreshold');
  const minFillRatio  = liveConfig.get('minimumFillRatio');
  if (fillRatio >= highThreshold) return 'high';
  if (fillRatio >= minFillRatio)  return 'mid';
  return 'low';
}

/**
 * Evaluate what to do with a partial fill.
 * Returns a decision: 'continue' | 'hedge' | 'close_immediately' | 'cancel'
 *
 * 3-tier decision logic (Fase 1 committee answer, fully implemented):
 *   - tier 'high' (fillRatio >= highFillRatioThreshold, default 0.80):
 *       accept the partial fill as-is and record the extra slippage.
 *   - tier 'mid'  (minimumFillRatio <= fillRatio < highFillRatioThreshold):
 *       hedge — complete the residual immediately with a market order.
 *   - tier 'low'  (fillRatio < minimumFillRatio, default 0.50):
 *       close the executed leg now as a controlled loss — UNLESS the
 *       residual is too small to be worth transferring at all, in which
 *       case there is nothing actionable and we simply cancel.
 */
function evaluatePartialFill(tradeId, filledAmount, requestedAmount) {
  const record = getTrade(tradeId);
  if (!record) return { decision: 'cancel', reason: 'Trade not found' };

  const fillRatio         = filledAmount / requestedAmount;
  const residualAmount    = requestedAmount - filledAmount;
  const allowPartial      = liveConfig.get('allowPartialFills');
  const minFillRatio      = liveConfig.get('minimumFillRatio');
  const highThreshold     = liveConfig.get('highFillRatioThreshold');
  const buyPrice          = record.opportunity.buyPrice || 50000;
  const residualUSD       = residualAmount * buyPrice;
  const minTransfer       = liveConfig.get('minimumTransferAmount');
  const tier              = classifyFillTier(fillRatio);

  // Record partial fill event
  record.execution.partialFills.push({
    ts:            new Date().toISOString(),
    filledAmount,
    requestedAmount,
    fillRatio: +fillRatio.toFixed(4),
    residualAmount,
    residualUSD: +residualUSD.toFixed(2),
    tier,
  });

  // Decision tree
  if (!allowPartial) {
    return {
      decision: 'cancel',
      reason:   'Partial fills disabled in configuration',
      fillRatio,
      residualUSD,
      tier,
    };
  }

  // Tier 'high': accept as-is, no further action needed beyond booking slippage.
  if (tier === 'high') {
    return {
      decision:  'continue',
      reason:    `Fill ratio ${(fillRatio * 100).toFixed(1)}% >= high threshold ${(highThreshold * 100).toFixed(1)}% — accepting partial fill, recording slippage`,
      fillRatio,
      residualUSD,
      tier,
    };
  }

  // Below the minimum fill ratio and the residual isn't even worth acting on.
  if (residualUSD < minTransfer) {
    return {
      decision: 'cancel',
      reason:   `Residual ${residualUSD.toFixed(2)} USD below minimum transfer ${minTransfer} USD`,
      fillRatio,
      residualUSD,
      tier,
    };
  }

  // Tier 'mid': meaningful residual, fill between minFillRatio and highThreshold —
  // complete the remainder immediately with a market order (hedge the gap).
  if (tier === 'mid') {
    return {
      decision: 'hedge',
      reason:   `Fill ratio ${(fillRatio * 100).toFixed(1)}% between ${(minFillRatio * 100).toFixed(1)}% and ${(highThreshold * 100).toFixed(1)}% — completing residual ${residualUSD.toFixed(2)} USD with an immediate market order`,
      fillRatio,
      residualUSD,
      residualAmount,
      tier,
    };
  }

  // Tier 'low': fill ratio below the minimum threshold with a meaningful residual —
  // abandon the residual and close the executed leg now as a controlled loss,
  // rather than chasing an increasingly stale opportunity with more orders.
  return {
    decision: 'close_immediately',
    reason:   `Fill ratio ${(fillRatio * 100).toFixed(1)}% below minimum ${(minFillRatio * 100).toFixed(1)}% — closing executed leg immediately as a controlled loss (residual ${residualUSD.toFixed(2)} USD abandoned)`,
    fillRatio,
    residualUSD,
    residualAmount,
    tier,
  };
}

// ─── Section 4: Failure Recovery Engine ──────────────────────────────────
//
// AUDIT FINDING 7 (MEDIUM, open — governance decision, not a code fix):
// verified with `grep -rn "determineRecoveryAction\|executeRecovery\|
// planHedge" server/` that none of the three functions below (Section 4 +
// Section 5, ~246 lines) are called from any file in server/ — only from
// tests/v17.test.js directly. They are NOT dead code in the sense of being
// broken or untested (12 passing tests exercise them directly), just
// unreferenced from any real code path. A comment that used to sit above
// `_fetchWithRetry` in liveExecution.js incorrectly implied
// `determineRecoveryAction` fed the live audit trail — that claim has been
// removed (see the AUDIT FINDING 7 note there).
//
// The actual money-moving recovery path for live trading is
// `_emergencyFlatten()` in liveExecution.js — a separate, independent,
// battle-tested implementation that already places real market orders to
// neutralize residual exposure after a partial cross-exchange fill (see
// its own doc header). It does NOT call into this engine and this audit
// finding does not touch it.
//
// Left open deliberately rather than fixed unilaterally, per the same
// reasoning as Hallazgo 5: wiring a 246-line, currently-unexercised
// classification/hedge layer into the real-money execution path is a
// product/architecture decision (what should trigger a hedge vs. a flatten?
// should this run before or instead of `_emergencyFlatten`? what's the
// rollout/kill-switch story if its classification is wrong under live
// conditions?), not something to decide unprompted inside an audit pass.
// The two options on the table:
//   (a) Wire it in as a classification layer ahead of `_emergencyFlatten`
//       (i.e. `_emergencyFlatten` becomes one possible outcome of
//       `determineRecoveryAction`, not the only one) — larger change,
//       touches the real-money path, needs its own test coverage of the
//       *decision* to flatten vs. hedge vs. retry under live conditions.
//   (b) Formally document it as an available-but-unused analytics/decision
//       engine (this comment) and leave `_emergencyFlatten` as the sole
//       live recovery mechanism — zero behavior change, lowest risk.
// This pass took option (b). Revisit if/when (a) is explicitly requested.

const RECOVERY_STRATEGIES = Object.freeze({
  RETRY:                  'retry',
  HEDGE:                  'hedge',
  REVERSE:                'reverse',
  EMERGENCY_LIQUIDATION:  'emergency_liquidation',
  CANCEL:                 'cancel',
});

/**
 * Determine the correct recovery action for a failed trade scenario.
 * Returns { action, reason, priority } where priority is 1 (urgent) to 5 (low).
 *
 * Scenarios handled:
 *   - buy_succeeded_sell_failed     → hedge or reverse (exposure on buy exchange)
 *   - sell_succeeded_buy_failed     → reverse (BTC was sold but not bought — unusual)
 *   - exchange_timeout              → retry with backoff
 *   - websocket_disconnect          → retry after reconnect
 *   - api_outage                    → retry after cooldown or emergency exit
 *   - insufficient_liquidity        → cancel (no action — book was thin)
 *   - insufficient_balance          → cancel (trigger rebalance)
 *   - price_moved_against           → cancel (opportunity no longer viable)
 *   - partial_fill_below_threshold  → hedge residual or unwind
 */
function determineRecoveryAction(scenario, context = {}) {
  const maxRetries = liveConfig.get('maxOrderRetries');

  switch (scenario) {
    case 'buy_succeeded_sell_failed':
      // We hold BTC on buyExchange that we can't sell — must neutralize
      return {
        action:   context.retryCount < maxRetries ? RECOVERY_STRATEGIES.RETRY : RECOVERY_STRATEGIES.HEDGE,
        reason:   context.retryCount < maxRetries
                    ? `Retrying sell leg (attempt ${context.retryCount + 1}/${maxRetries})`
                    : 'Sell leg failed after max retries — hedging residual BTC exposure',
        priority: 1,
        urgent:   true,
      };

    case 'sell_succeeded_buy_failed':
      // We sold BTC we don't yet hold — net short position, must cover immediately
      return {
        action:   RECOVERY_STRATEGIES.EMERGENCY_LIQUIDATION,
        reason:   'Sell leg succeeded but buy leg failed — covering short position immediately',
        priority: 1,
        urgent:   true,
      };

    case 'exchange_timeout':
      return {
        action:   context.retryCount < maxRetries ? RECOVERY_STRATEGIES.RETRY : RECOVERY_STRATEGIES.CANCEL,
        reason:   context.retryCount < maxRetries
                    ? `Exchange timeout — retrying (attempt ${context.retryCount + 1}/${maxRetries})`
                    : 'Exchange timeout after max retries — cancelling trade',
        priority: 2,
        backoffMs: liveConfig.get('retryBackoffMs') * Math.pow(2, context.retryCount || 0),
      };

    case 'websocket_disconnect':
      return {
        action:   RECOVERY_STRATEGIES.RETRY,
        reason:   'WebSocket disconnected — retrying after reconnection',
        priority: 2,
        waitForReconnect: true,
      };

    case 'api_outage':
      // If we have exposure, must try to exit; otherwise wait
      if (context.hasOpenExposure) {
        return { action: RECOVERY_STRATEGIES.EMERGENCY_LIQUIDATION, reason: 'API outage with open exposure — emergency exit', priority: 1, urgent: true };
      }
      return { action: RECOVERY_STRATEGIES.CANCEL, reason: 'API outage — cancelling trade, no exposure', priority: 3 };

    case 'insufficient_liquidity':
      return { action: RECOVERY_STRATEGIES.CANCEL, reason: 'Order book too thin to fill at acceptable slippage', priority: 4 };

    case 'insufficient_balance':
      return { action: RECOVERY_STRATEGIES.CANCEL, reason: 'Insufficient balance — trigger rebalancing', priority: 3, triggerRebalance: true };

    case 'price_moved_against':
      return { action: RECOVERY_STRATEGIES.CANCEL, reason: 'Price moved against trade — opportunity no longer viable', priority: 4 };

    case 'partial_fill_below_threshold':
      return {
        action:   RECOVERY_STRATEGIES.HEDGE,
        reason:   'Partial fill below minimum threshold — hedging residual exposure',
        priority: 2,
        urgent:   context.residualUSD > 1000,
      };

    default:
      return { action: RECOVERY_STRATEGIES.CANCEL, reason: `Unknown failure scenario: ${scenario}`, priority: 5 };
  }
}

/**
 * Execute a recovery action on a failed trade.
 * Records all actions to the trade's event log.
 * Returns { ok, action, outcome, events }.
 */
function executeRecovery(tradeId, scenario, context = {}) {
  const record = getTrade(tradeId);
  if (!record) return { ok: false, error: `Trade ${tradeId} not found` };

  const { action, reason, priority, urgent } = determineRecoveryAction(scenario, context);
  const now = new Date().toISOString();

  // Record recovery attempt
  if (record.events) {
    record.events.push({
      ts:       now,
      from:     record.state,
      to:       record.state,  // stays in current state until action completes
      actor:    'recovery_engine',
      reason:   `Recovery initiated: ${reason}`,
      data:     { scenario, action, priority, urgent, context },
    });
  }

  Object.assign(record.recovery, {
    attempted: true,
    action,
    reason,
    scenario,
    initiatedAt: now,
  });

  // Simulate recovery execution
  let outcome;
  switch (action) {
    case RECOVERY_STRATEGIES.RETRY:
      record.execution.retryCount = (record.execution.retryCount || 0) + 1;
      outcome = { status: 'retry_scheduled', retryCount: record.execution.retryCount, backoffMs: context.backoffMs || liveConfig.get('retryBackoffMs') };
      break;

    case RECOVERY_STRATEGIES.CANCEL:
      outcome = { status: 'cancelled', refundedCapital: context.refundAmount || 0 };
      transition(tradeId, STATES.FAILED, {
        actor:  'recovery_engine',
        reason: `Recovery: ${reason}`,
        data:   { rca: { failureCategory: scenario, rejectionReason: reason, blockedBy: 'recovery_engine' } },
      });
      break;

    case RECOVERY_STRATEGIES.HEDGE:
      outcome = { status: 'hedge_initiated', residualAmount: context.residualAmount, hedgeExchange: context.hedgeExchange || 'best_available' };
      record.recovery.hedgeTrades.push({ ts: now, type: 'spot_hedge', amount: context.residualAmount, exchange: context.hedgeExchange });
      break;

    case RECOVERY_STRATEGIES.REVERSE:
      outcome = { status: 'reversal_initiated', direction: 'sell_to_close', amount: context.filledAmount };
      break;

    case RECOVERY_STRATEGIES.EMERGENCY_LIQUIDATION:
      outcome = { status: 'emergency_liquidation', reason, priority: 1 };
      transition(tradeId, STATES.EMERGENCY_EXIT, {
        actor:  'recovery_engine',
        reason: `Emergency liquidation: ${reason}`,
        data:   { rca: { failureCategory: scenario, rejectionReason: reason, blockedBy: 'emergency_stop' } },
      });
      break;
  }

  record.recovery.outcome = outcome;

  return { ok: true, action, outcome, reason, priority, urgent };
}

// ─── Section 5: Hedge Engine ──────────────────────────────────────────────

/**
 * Determine the best hedge strategy for residual exposure.
 * Returns a hedge plan without executing it (execution is separate).
 */
function planHedge(exposure) {
  const { asset, amount, valueUSD, sourceExchange, direction } = exposure;

  // Item 3 fix: antes la dirección del hedge se adivinaba por identidad del
  // asset (`asset === 'BTC' ? 'SELL' : 'BUY'`) — lo cual ni siquiera era un
  // criterio correcto para BTC vs ETH (la dirección correcta depende de si
  // la EXPOSICIÓN residual es larga o corta, no de qué asset es), y se
  // rompía en silencio para cualquier tercer asset (XRP, SOL...), que caía
  // en la rama "BUY" por default sin ninguna razón real. Ahora `direction`
  // es un campo explícito de la exposición ('long' | 'short'); default
  // 'long' preserva el resultado exacto de los fixtures BTC existentes
  // (exposición larga → hedge SELL).
  const isLongExposure = (direction || 'long') === 'long';
  const hedgeAction = isLongExposure ? 'SELL' : 'BUY';
  const syntheticDirection = isLongExposure ? 'SHORT' : 'LONG'; // opuesto a la exposición

  // Priority: spot hedge on same exchange (fastest) > cross-exchange spot > synthetic
  const strategies = [];

  // Strategy 1: Spot hedge on source exchange
  strategies.push({
    type:           'spot_hedge',
    exchange:       sourceExchange,
    action:         hedgeAction,
    amount,
    valueUSD,
    estimatedCost:  valueUSD * 0.001,  // taker fee estimate
    latencyMs:      50,
    priority:       1,
  });

  // Strategy 2: Cross-exchange hedge (transfer + sell)
  const targetExchanges = ['Binance', 'OKX', 'Bybit'].filter(e => e !== sourceExchange);
  for (const ex of targetExchanges) {
    strategies.push({
      type:           'cross_exchange_hedge',
      sourceExchange,
      targetExchange: ex,
      action:         hedgeAction,
      amount,
      valueUSD,
      estimatedCost:  valueUSD * 0.002,  // transfer + taker fee
      latencyMs:      2000,
      priority:       2,
    });
  }

  // Strategy 3: Synthetic hedge via perpetual (not implemented in sim, architecture only)
  strategies.push({
    type:           'synthetic_hedge',
    instrument:     `${asset}USDT-PERP`,
    direction:      syntheticDirection,
    notional:       valueUSD,
    estimatedCost:  valueUSD * 0.0005,
    latencyMs:      100,
    priority:       3,
    note:           'Requires perpetual API integration',
  });

  const recommended = strategies[0];  // spot hedge is fastest

  return {
    exposure,
    recommendedStrategy: recommended,
    allStrategies: strategies,
    urgency: valueUSD > 5000 ? 'high' : valueUSD > 1000 ? 'medium' : 'low',
  };
}

// ─── Stats / diagnostics ──────────────────────────────────────────────────

function getStats() {
  const active    = Array.from(_trades.values());
  const historical = _history;

  const byState = {};
  for (const t of active) byState[t.state] = (byState[t.state] || 0) + 1;

  const terminal = historical.reduce((acc, t) => {
    acc[t.state] = (acc[t.state] || 0) + 1;
    return acc;
  }, {});

  const recoveries = historical.filter(t => t.recovery.attempted);
  const recoverySuccessRate = recoveries.length > 0
    ? recoveries.filter(t => t.state === 'COMPLETED').length / recoveries.length
    : null;

  const partialFills = historical.filter(t => t.execution.partialFills?.length > 0);

  return {
    activeTrades:        active.length,
    totalHistorical:     historical.length,
    byState,
    terminalByState:     terminal,
    recoveryAttempts:    recoveries.length,
    recoverySuccessRate: recoverySuccessRate !== null ? +(recoverySuccessRate * 100).toFixed(1) : null,
    partialFillEvents:   partialFills.length,
    avgFillRatio: partialFills.length
      ? +(partialFills.reduce((s, t) => {
          const fills = t.execution.partialFills;
          return s + (fills[fills.length - 1]?.fillRatio || 1);
        }, 0) / partialFills.length * 100).toFixed(1)
      : null,
  };
}

module.exports = {
  STATES,
  TRANSITIONS,
  RECOVERY_STRATEGIES,
  createTrade,
  transition,
  getTrade,
  getActiveTrades,
  getHistory,
  evaluatePartialFill,
  classifyFillTier,
  determineRecoveryAction,
  executeRecovery,
  planHedge,
  getStats,
};

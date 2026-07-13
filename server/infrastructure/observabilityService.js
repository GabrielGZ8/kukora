/**
 * observabilityService.js — Kukora v17
 *
 * Section 14: Full observability — structured events, no console.log.
 * Section 6:  Execution quality analytics (expected vs realized spread/profit).
 * Section 15: Root cause analysis for rejected trades.
 *
 * Architecture:
 *   - Structured event bus replaces all console.log-based observability
 *   - Every opportunity, execution, error, and config change emits a typed event
 *   - Events are stored in rolling buffers per category
 *   - RCA engine explains every rejection in machine-readable format
 *   - Latency distributions tracked per exchange pair
 *   - Error distributions tracked per error category
 *
 * Event schema:
 *   { ts, category, event, level, data, traceId? }
 *
 * Categories:
 *   OPPORTUNITY  — detection, scoring, rejection, expiry
 *   EXECUTION    — order lifecycle, fills, settlements
 *   RISK         — circuit breakers, drawdown alerts, exposure checks
 *   REBALANCE    — trigger, plan, execution, outcome
 *   CONFIG       — parameter changes
 *   SYSTEM       — startup, shutdown, errors, health
 *   EXCHANGE     — connectivity, latency, reliability events
 */

'use strict';

const EventEmitter = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(50);

// ─── Rolling buffers ───────────────────────────────────────────────────────
const BUFFER_SIZE = 1000;

const _buffers = {
  OPPORTUNITY: [],
  EXECUTION:   [],
  RISK:        [],
  REBALANCE:   [],
  CONFIG:      [],
  SYSTEM:      [],
  EXCHANGE:    [],
  // AUDIT FINDING 8 fix (LOW): 'DEMO' (opportunityDetection.js's synthetic-
  // opportunity event, DEMO_MODE) and 'ENGINE' (backtestEngine.js's
  // run-result-shape-contract warning) were emitted live on the bus but had
  // no buffer entry here — `emit()`'s `if (buf)` guard silently skipped
  // buffering them, so neither category was ever queryable via getRecent()/
  // getEvents() history, only visible to a listener subscribed at the exact
  // moment the event fired. Purely additive: no other category was
  // affected (confirmed via `grep -rhoP` across server/ for every string
  // literal passed as emit()'s first argument — DEMO and ENGINE were the
  // only two missing).
  DEMO:        [],
  ENGINE:      [],
};

// ─── Latency distributions ────────────────────────────────────────────────
// Per exchange-pair latency distributions (raw samples, max 500 — percentile-based)
const _latencyDistributions = new Map();  // key: "ExA→ExB" → { buckets[], p50, p95, p99, count }

// ─── Error distributions ──────────────────────────────────────────────────
const _errorCounts = {};   // category → count
const _errorSeries = [];   // rolling [{ts, category, msg}], last 500

// ─── Exchange reliability ─────────────────────────────────────────────────
const _exchangeHealth = {};   // exchange → { successCount, failureCount, avgLatencyMs, lastError }

// ─── Execution quality (Section 6) ───────────────────────────────────────
const _executionQuality = [];  // rolling [{ts, pair, expectedSpread, realizedSpread, ...}]
const MAX_EQ = 500;

// ─── RCA store (Section 15) ───────────────────────────────────────────────
const _rcaLog = [];   // rolling [{ts, tradeId, reason, category, blockedBy, diagnostics}]
const MAX_RCA = 1000;

// ─── Core emit function ───────────────────────────────────────────────────

/**
 * Emit a structured event.
 *
 * @param {string} category   — one of OPPORTUNITY|EXECUTION|RISK|REBALANCE|CONFIG|SYSTEM|EXCHANGE|DEMO|ENGINE
 * @param {string} event      — event name (e.g., 'opportunity.detected', 'execution.filled')
 * @param {object} data       — event-specific payload
 * @param {string} level      — 'debug'|'info'|'warn'|'error'
 * @param {string} traceId    — optional correlation ID
 */
function emit(category, event, data = {}, level = 'info', traceId = null) {
  const structured = {
    ts:       new Date().toISOString(),
    category,
    event,
    level,
    data,
    traceId,
  };

  // Append to rolling buffer
  const buf = _buffers[category];
  if (buf) {
    buf.push(structured);
    if (buf.length > BUFFER_SIZE) buf.shift();
  }

  // Emit on the bus for real-time subscribers
  bus.emit(category, structured);
  bus.emit('*', structured);

  // Track errors
  if (level === 'error' || level === 'warn') {
    const errCat = data.errorCategory || event;
    _errorCounts[errCat] = (_errorCounts[errCat] || 0) + 1;
    _errorSeries.push({ ts: structured.ts, category: errCat, event, msg: data.message || data.reason || '' });
    if (_errorSeries.length > 500) _errorSeries.shift();
  }

  return structured;
}

// ─── Section 6: Execution Quality Analytics ──────────────────────────────

/**
 * Record execution quality metrics for a completed trade.
 * Compares expected (at detection) vs realized (at execution) values.
 */
function recordExecutionQuality(opportunity, trade) {
  const expectedSpread     = opportunity.spreadPct || 0;
  const realizedSpread     = trade.netProfitPct != null
    ? trade.netProfitPct + (trade.slippagePct || 0)
    : expectedSpread;

  const expectedProfit     = opportunity.netProfit || 0;
  const realizedProfit     = trade.netProfit || 0;

  const slippageDelta      = (trade.slippagePct || 0) - (opportunity.slippagePct || 0);
  const profitSlippage     = expectedProfit - realizedProfit;
  const fillQuality        = trade.amount / (trade.requestedAmount || trade.amount);
  const missedProfit       = Math.max(0, profitSlippage);

  const entry = {
    ts:               new Date().toISOString(),
    tradeId:          trade.id,
    pair:             `${trade.buyExchange}→${trade.sellExchange}`,
    expectedSpread,
    realizedSpread:   +realizedSpread.toFixed(4),
    expectedProfit,
    realizedProfit,
    slippageDelta:    +slippageDelta.toFixed(4),
    profitCapture:    expectedProfit !== 0 ? +(realizedProfit / expectedProfit).toFixed(3) : 1,
    fillQuality:      +fillQuality.toFixed(3),
    executionLatency: trade.executionMs || 0,
    missedProfit:     +missedProfit.toFixed(4),
    slippageMethod:   trade.slippageMethod || 'unknown',
    verdict: realizedProfit >= expectedProfit * 0.90 ? 'excellent'
           : realizedProfit >= expectedProfit * 0.75 ? 'good'
           : realizedProfit >= expectedProfit * 0.50 ? 'acceptable'
           : 'poor',
  };

  _executionQuality.push(entry);
  if (_executionQuality.length > MAX_EQ) _executionQuality.shift();

  emit('EXECUTION', 'execution.quality.recorded', {
    tradeId:       trade.id,
    pair:          entry.pair,
    profitCapture: entry.profitCapture,
    verdict:       entry.verdict,
    missedProfit:  entry.missedProfit,
  }, entry.verdict === 'poor' ? 'warn' : 'info');

  return entry;
}

/**
 * Get aggregated execution quality metrics.
 */
function getExecutionQualityStats() {
  if (_executionQuality.length === 0) {
    return { count: 0, avgProfitCapture: null, avgFillQuality: null, totalMissedProfit: null };
  }

  const count              = _executionQuality.length;
  const avgProfitCapture   = _executionQuality.reduce((s, e) => s + e.profitCapture, 0) / count;
  const avgFillQuality     = _executionQuality.reduce((s, e) => s + e.fillQuality, 0) / count;
  const totalMissedProfit  = _executionQuality.reduce((s, e) => s + e.missedProfit, 0);
  const avgExecutionLatency = _executionQuality.reduce((s, e) => s + e.executionLatency, 0) / count;
  const avgSlippageDelta   = _executionQuality.reduce((s, e) => s + e.slippageDelta, 0) / count;

  const byVerdict = _executionQuality.reduce((acc, e) => {
    acc[e.verdict] = (acc[e.verdict] || 0) + 1;
    return acc;
  }, {});

  const byPair = {};
  for (const e of _executionQuality) {
    if (!byPair[e.pair]) byPair[e.pair] = { count: 0, totalMissed: 0, avgCapture: 0 };
    byPair[e.pair].count++;
    byPair[e.pair].totalMissed += e.missedProfit;
    byPair[e.pair].avgCapture  += e.profitCapture;
  }
  for (const p of Object.keys(byPair)) {
    byPair[p].avgCapture = +(byPair[p].avgCapture / byPair[p].count).toFixed(3);
  }

  return {
    count,
    avgProfitCapture:   +avgProfitCapture.toFixed(3),
    avgFillQuality:     +avgFillQuality.toFixed(3),
    totalMissedProfit:  +totalMissedProfit.toFixed(4),
    avgExecutionLatency: +avgExecutionLatency.toFixed(1),
    avgSlippageDelta:   +avgSlippageDelta.toFixed(4),
    byVerdict,
    byPair,
    recent:             _executionQuality.slice(-20),
  };
}

// ─── Latency tracking ─────────────────────────────────────────────────────

function recordLatency(pair, latencyMs) {
  if (!_latencyDistributions.has(pair)) {
    // Performance fix (audit): cap the number of distinct pair keys to prevent
    // unbounded Map growth when many exchange-pair combos are seen over time.
    // LRU eviction: delete the oldest entry when the cap is reached.
    const MAX_PAIR_KEYS = 100;
    if (_latencyDistributions.size >= MAX_PAIR_KEYS) {
      const oldestKey = _latencyDistributions.keys().next().value;
      _latencyDistributions.delete(oldestKey);
    }
    _latencyDistributions.set(pair, {
      samples: [],
      count:   0,
      sum:     0,
      min:     Infinity,
      max:     -Infinity,
    });
  }

  const d = _latencyDistributions.get(pair);
  d.samples.push(latencyMs);
  if (d.samples.length > 500) d.samples.shift();
  d.count++;
  d.sum += latencyMs;
  if (latencyMs < d.min) d.min = latencyMs;
  if (latencyMs > d.max) d.max = latencyMs;
}

function getLatencyStats(pair) {
  const d = _latencyDistributions.get(pair);
  if (!d || d.count === 0) return null;

  const sorted = [...d.samples].sort((a, b) => a - b);
  const p = (pct) => sorted[Math.floor(sorted.length * pct)] || null;

  return {
    pair,
    count:  d.count,
    mean:   +(d.sum / d.count).toFixed(1),
    min:    d.min,
    max:    d.max,
    p50:    p(0.50),
    p90:    p(0.90),
    p95:    p(0.95),
    p99:    p(0.99),
  };
}

function getAllLatencyStats() {
  const stats = {};
  for (const pair of _latencyDistributions.keys()) {
    stats[pair] = getLatencyStats(pair);
  }
  return stats;
}

// ─── Exchange health ───────────────────────────────────────────────────────

function recordExchangeEvent(exchange, success, latencyMs = null, error = null) {
  if (!_exchangeHealth[exchange]) {
    _exchangeHealth[exchange] = { successCount: 0, failureCount: 0, latencies: [], lastError: null, lastSuccess: null };
  }
  const h = _exchangeHealth[exchange];
  if (success) {
    h.successCount++;
    h.lastSuccess = new Date().toISOString();
    if (latencyMs !== null) {
      h.latencies.push(latencyMs);
      if (h.latencies.length > 200) h.latencies.shift();
    }
  } else {
    h.failureCount++;
    h.lastError = { ts: new Date().toISOString(), message: error };
    emit('EXCHANGE', 'exchange.failure', { exchange, error, latencyMs }, 'warn');
  }
}

function getExchangeHealth() {
  const result = {};
  for (const [ex, h] of Object.entries(_exchangeHealth)) {
    const total = h.successCount + h.failureCount;
    const sorted = [...h.latencies].sort((a, b) => a - b);
    result[ex] = {
      successRate:  total > 0 ? +(h.successCount / total * 100).toFixed(1) : null,
      successCount: h.successCount,
      failureCount: h.failureCount,
      avgLatencyMs: h.latencies.length ? +(h.latencies.reduce((s, v) => s + v, 0) / h.latencies.length).toFixed(1) : null,
      p95LatencyMs: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : null,
      lastError:    h.lastError,
      lastSuccess:  h.lastSuccess,
    };
  }
  return result;
}

// ─── Section 15: Root Cause Analysis ─────────────────────────────────────

const RCA_CATEGORIES = Object.freeze({
  SCORE_TOO_LOW:            'score_too_low',
  SPREAD_TOO_SMALL:         'spread_too_small',
  SPREAD_TOO_LARGE:         'spread_too_large',
  LIQUIDITY_INSUFFICIENT:   'liquidity_insufficient',
  BALANCE_INSUFFICIENT:     'balance_insufficient',
  DAILY_LOSS_EXCEEDED:      'daily_loss_exceeded',
  DRAWDOWN_EXCEEDED:        'drawdown_exceeded',
  CIRCUIT_BREAKER_ACTIVE:   'circuit_breaker_active',
  EXCHANGE_DISABLED:        'exchange_disabled',
  SLIPPAGE_TOO_HIGH:        'slippage_too_high',
  LATENCY_TOO_HIGH:         'latency_too_high',
  STALE_DATA:               'stale_data',
  FEES_EXCEED_PROFIT:       'fees_exceed_profit',
  COOLDOWN_ACTIVE:          'cooldown_active',
  RISK_LIMIT_EXCEEDED:      'risk_limit_exceeded',
  EXECUTION_FAILED:         'execution_failed',
  // Feature-flag-driven kill switch (server/infrastructure/featureFlags.js —
  // killSwitchTrading / killSwitchTenantExecution). Distinct from
  // CIRCUIT_BREAKER_ACTIVE (automatic, failure-triggered) — this is an
  // operator-triggered halt, e.g. during an incident.
  KILL_SWITCH_ACTIVE:       'kill_switch_active',
  // ADR-019 §1: fill-probability execution gate (arbitrageOrchestrator.js
  // passesFillProbabilityGate) — distinct from LIQUIDITY_INSUFFICIENT
  // (order book depth) since fillProbability models the likelihood the
  // quoted price survives long enough to actually fill, not book depth.
  FILL_PROBABILITY_TOO_LOW: 'fill_probability_too_low',
  UNKNOWN:                  'unknown',
});

/**
 * Record a rejected trade with full RCA.
 * Returns the RCA entry for downstream use.
 */
function recordRejection(opportunity, reason, category = RCA_CATEGORIES.UNKNOWN, diagnostics = {}) {
  const entry = {
    ts:           new Date().toISOString(),
    tradeId:      opportunity.id || opportunity.tradeId || null,
    pair:         opportunity.pair || `${opportunity.buyExchange}→${opportunity.sellExchange}`,
    reason,
    category,
    humanReadable: buildHumanReadableRCA(reason, category, opportunity, diagnostics),
    diagnostics:  {
      ...diagnostics,
      opportunitySnapshot: {
        spreadPct:    opportunity.spreadPct,
        score:        opportunity.score,
        netProfit:    opportunity.netProfit,
        slippagePct:  opportunity.slippagePct,
        buyExchange:  opportunity.buyExchange,
        sellExchange: opportunity.sellExchange,
      },
    },
    machineReadable: {
      category,
      ruleViolated:   getRuleViolated(category),
      parameterValues: getRuleParameters(category),
      severity:        getRuleSeverity(category),
      recoverable:     isRecoverable(category),
    },
  };

  _rcaLog.push(entry);
  if (_rcaLog.length > MAX_RCA) _rcaLog.shift();

  emit('OPPORTUNITY', 'opportunity.rejected', {
    pair:     entry.pair,
    category,
    reason,
  }, category === RCA_CATEGORIES.EXECUTION_FAILED ? 'error' : 'info');

  return entry;
}

function buildHumanReadableRCA(reason, category, opportunity, diagnostics) {
  const pair = `${opportunity.buyExchange}→${opportunity.sellExchange}`;
  switch (category) {
    case RCA_CATEGORIES.SCORE_TOO_LOW:
      return `Trade on ${pair} rejected: composite score ${opportunity.score?.toFixed(1)} is below minimum ${diagnostics.minScore || 'configured'} threshold. Improve liquidity, spread persistence, or exchange reliability to increase score.`;
    case RCA_CATEGORIES.SPREAD_TOO_SMALL:
      return `Trade on ${pair} rejected: spread ${opportunity.spreadPct?.toFixed(4)}% is below minimum ${diagnostics.minSpreadPct || 'configured'}%. Wait for larger price divergence.`;
    case RCA_CATEGORIES.SPREAD_TOO_LARGE:
      return `Trade on ${pair} rejected: spread ${opportunity.spreadPct?.toFixed(4)}% exceeds maximum ${diagnostics.maxSpreadPct || 'configured'}%. Likely stale or erroneous price data.`;
    case RCA_CATEGORIES.LIQUIDITY_INSUFFICIENT:
      return `Trade on ${pair} rejected: order book is too thin to fill ${opportunity.tradeAmount || 'requested'} BTC at acceptable slippage. Expected fill ratio below minimum threshold.`;
    case RCA_CATEGORIES.BALANCE_INSUFFICIENT:
      return `Trade on ${pair} rejected: insufficient ${diagnostics.asset || 'balance'} on ${diagnostics.exchange || 'exchange'}. Current: ${diagnostics.available?.toFixed(4)}, Required: ${diagnostics.required?.toFixed(4)}. Trigger rebalancing.`;
    case RCA_CATEGORIES.DAILY_LOSS_EXCEEDED:
      return `All trading halted: daily P&L ${diagnostics.dailyPnl?.toFixed(2)} USD has breached the configured limit. Reset at midnight or adjust maxDailyLossUSD.`;
    case RCA_CATEGORIES.DRAWDOWN_EXCEEDED:
      return `All trading halted: portfolio drawdown ${diagnostics.drawdownPct?.toFixed(2)}% exceeds maximum ${diagnostics.maxDrawdownPct?.toFixed(2)}%. Review capital and consider reducing position sizes.`;
    case RCA_CATEGORIES.CIRCUIT_BREAKER_ACTIVE:
      return `Trade on ${pair} rejected: circuit breaker is active (${diagnostics.consecutiveFailures || 'N'} consecutive failures). Waiting for automatic reset or manual override.`;
    case RCA_CATEGORIES.FEES_EXCEED_PROFIT:
      return `Trade on ${pair} rejected: combined fees (${diagnostics.totalFeesPct?.toFixed(4)}%) exceed gross spread (${opportunity.spreadPct?.toFixed(4)}%). Net profit would be negative.`;
    case RCA_CATEGORIES.COOLDOWN_ACTIVE:
      return `Trade on ${pair} skipped: cooldown timer active (${diagnostics.remainingMs?.toFixed(0)}ms remaining since last execution).`;
    case RCA_CATEGORIES.KILL_SWITCH_ACTIVE:
      return `Trade on ${pair} rejected: the ${diagnostics.flag || 'killSwitchTrading'} feature flag is active — trading is manually halted. Clear the flag via POST /api/feature-flags/${diagnostics.flag || 'killSwitchTrading'} to resume.`;
    case RCA_CATEGORIES.FILL_PROBABILITY_TOO_LOW:
      return `Trade on ${pair} rejected: modeled fill probability ${diagnostics.fillProbability} is below minimum ${diagnostics.threshold} (ADR-019 §1). The order book is unlikely to still be there by the time the order lands, regardless of nominal spread.`;
    default:
      return `Trade on ${pair} rejected: ${reason}`;
  }
}

function getRuleViolated(category) {
  const rules = {
    score_too_low:            'minScore',
    spread_too_small:         'minSpreadPct',
    spread_too_large:         'maxSpreadPct',
    liquidity_insufficient:   'minimumFillRatio / LIQUIDITY_MIN_FILL',
    balance_insufficient:     'wallet balance check',
    daily_loss_exceeded:      'maxDailyLossUSD',
    drawdown_exceeded:        'maxDrawdownPct',
    circuit_breaker_active:   'maxConsecutiveFailures',
    exchange_disabled:        'activeExchanges',
    slippage_too_high:        'maxSlippagePct',
    fees_exceed_profit:       'minNetProfitUSD',
    cooldown_active:          'cooldownMs',
    risk_limit_exceeded:      'maxExposurePerExchange / maxPositionValueUSD',
    fill_probability_too_low: 'minFillProbability',
    kill_switch_active:       'featureFlags.killSwitchTrading / killSwitchTenantExecution',
  };
  return rules[category] || 'unknown';
}

function getRuleParameters(category) {
  const liveConfig = require('./liveConfig');
  const params = {
    score_too_low:          { minScore: liveConfig.get('minScore') },
    spread_too_small:       { minSpreadPct: liveConfig.get('minSpreadPct') },
    spread_too_large:       { maxSpreadPct: liveConfig.get('maxSpreadPct') },
    daily_loss_exceeded:    { maxDailyLossUSD: liveConfig.get('maxDailyLossUSD') },
    drawdown_exceeded:      { maxDrawdownPct: liveConfig.get('maxDrawdownPct') },
    circuit_breaker_active: { maxConsecutiveFailures: liveConfig.get('maxConsecutiveFailures') },
    fees_exceed_profit:     { minNetProfitUSD: liveConfig.get('minNetProfitUSD') },
    cooldown_active:        { cooldownMs: liveConfig.get('cooldownMs') },
    slippage_too_high:      { maxSlippagePct: liveConfig.get('maxSlippagePct') },
    fill_probability_too_low: { minFillProbability: liveConfig.get('minFillProbability') },
  };
  return params[category] || {};
}

function getRuleSeverity(category) {
  const high   = ['daily_loss_exceeded', 'drawdown_exceeded', 'circuit_breaker_active', 'execution_failed', 'kill_switch_active'];
  const medium = ['balance_insufficient', 'risk_limit_exceeded', 'exchange_disabled'];
  if (high.includes(category))   return 'high';
  if (medium.includes(category)) return 'medium';
  return 'low';
}

function isRecoverable(category) {
  const notRecoverable = ['daily_loss_exceeded', 'drawdown_exceeded'];
  return !notRecoverable.includes(category);
}

function getRCALog(limit = 100, filterCategory = null) {
  let log = _rcaLog;
  if (filterCategory) log = log.filter(e => e.category === filterCategory);
  return log.slice(-limit).reverse();
}

function getRCASummary() {
  const byCategory = {};
  for (const entry of _rcaLog) {
    byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
  }
  const topReasons = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([category, count]) => ({ category, count, rule: getRuleViolated(category), severity: getRuleSeverity(category) }));

  return {
    totalRejections: _rcaLog.length,
    byCategory,
    topReasons,
    recent:          _rcaLog.slice(-5).reverse(),
  };
}

// ─── Observability getters ────────────────────────────────────────────────

function getEvents(category, limit = 100) {
  const buf = _buffers[category];
  if (!buf) return [];
  return buf.slice(-limit).reverse();
}

function getAllRecentEvents(limit = 200) {
  const all = [];
  for (const buf of Object.values(_buffers)) all.push(...buf);
  all.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  return all.slice(0, limit);
}

function getErrorStats() {
  return {
    counts:  { ..._errorCounts },
    recent:  _errorSeries.slice(-50).reverse(),
    total:   Object.values(_errorCounts).reduce((s, v) => s + v, 0),
  };
}

function getDashboard() {
  return {
    ts:                new Date().toISOString(),
    executionQuality:  getExecutionQualityStats(),
    latency:           getAllLatencyStats(),
    exchangeHealth:    getExchangeHealth(),
    errorStats:        getErrorStats(),
    rcaSummary:        getRCASummary(),
    recentEvents:      getAllRecentEvents(50),
  };
}

module.exports = {
  emit,
  bus,
  RCA_CATEGORIES,
  recordExecutionQuality,
  getExecutionQualityStats,
  recordLatency,
  getLatencyStats,
  getAllLatencyStats,
  recordExchangeEvent,
  getExchangeHealth,
  recordRejection,
  getRCALog,
  getRCASummary,
  getEvents,
  getAllRecentEvents,
  getErrorStats,
  getDashboard,
};

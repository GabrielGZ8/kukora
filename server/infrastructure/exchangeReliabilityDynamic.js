/**
 * exchangeReliabilityDynamic.js — Kukora v10
 *
 * El exchangeIntelligence.js ya rastrea estadísticas por exchange, pero
 * el scoring del arbitraje no las usa dinámicamente para ajustar qué
 * exchanges se prefieren en tiempo real. Este módulo cierra ese loop.
 *
 * Problema que resuelve:
 * Si Kraken ha tenido feeds lentos/caídos los últimos 5 minutos, las
 * oportunidades que involucran a Kraken tienen mayor riesgo de execution
 * failure. El scoring actual no descuenta esto — puntúa a Kraken igual
 * que si estuviera perfectamente estable.
 *
 * Solución:
 * Mantiene un "reliability score" dinámico por exchange (0-100), basado en:
 *   - Feed freshness: ¿cuándo fue el último WS update? (peso 40%)
 *   - Error rate de los últimos N eventos: ¿cuántos erroraron? (peso 30%)
 *   - Latencia relativa: ¿está más lento que su baseline? (peso 30%)
 *
 * Este score se expone para que el scoring de oportunidades pueda
 * penalizar pares que involucren exchanges con reliability < umbral.
 * Integración: el opportunityDetection.js lee getDynamicPenalty(exchange)
 * y lo resta del score compuesto de la oportunidad.
 */

'use strict';

const EXCHANGES = ['Binance', 'Kraken', 'Bybit', 'OKX', 'Coinbase'];
const WINDOW_MS = 5 * 60 * 1000; // 5-minute rolling window for reliability analysis

// ── Per-exchange rolling event log ────────────────────────────────────────
const _events = {};
for (const ex of EXCHANGES) {
  _events[ex] = {
    updates:         [], // { ts, latencyMs, hadError }
    baselineLatency: null, // established in the first 2 minutes
    baselineSamples: 0,
  };
}

const MAX_EVENTS_PER_EXCHANGE = 200;

/**
 * Record a WS feed update event. Call this from exchangeService on each
 * priceUpdate emission or error event.
 * @param {string}  exchange   - exchange name
 * @param {boolean} hadError   - true if this is an error/close event
 * @param {number}  latencyMs  - WS message latency (0 for error events)
 */
function recordFeedEvent(exchange, hadError = false, latencyMs = 0) {
  const st = _events[exchange];
  if (!st) return;

  const now = Date.now();
  st.updates.push({ ts: now, latencyMs: latencyMs || 0, hadError: !!hadError });

  // Rolling window: drop events older than WINDOW_MS
  while (st.updates.length > 0 && now - st.updates[0].ts > WINDOW_MS) {
    st.updates.shift();
  }
  if (st.updates.length > MAX_EVENTS_PER_EXCHANGE) st.updates.shift();

  // Establish baseline latency from first 2 minutes of data
  if (st.baselineLatency === null && st.baselineSamples < 50 && !hadError && latencyMs > 0) {
    st.baselineSamples++;
    if (st.baselineLatency === null) st.baselineLatency = latencyMs;
    else st.baselineLatency = st.baselineLatency * 0.9 + latencyMs * 0.1; // EWMA
    if (st.baselineSamples >= 20) {
      st.baselineLatency = +st.baselineLatency.toFixed(1);
    }
  }
}

/**
 * Compute the current reliability score (0-100) for an exchange.
 * Higher = more reliable right now.
 */
function computeReliabilityScore(exchange) {
  const st = _events[exchange];
  if (!st || st.updates.length < 3) return 100; // not enough data — assume ok

  const now      = Date.now();
  const recent   = st.updates.filter(e => now - e.ts <= WINDOW_MS);
  if (recent.length < 3) return 100;

  // 1. Feed freshness: how old is the last update?
  const lastUpdateAge = now - recent[recent.length - 1].ts;
  const STALE_MS = 5000;
  const freshnessScore = Math.max(0, 100 - (lastUpdateAge / STALE_MS) * 100);

  // 2. Error rate over recent window
  const errorCount  = recent.filter(e => e.hadError).length;
  const errorRate   = errorCount / recent.length;
  const errorScore  = Math.max(0, (1 - errorRate * 5) * 100); // penalize errors heavily

  // 3. Latency vs baseline
  let latencyScore = 100;
  if (st.baselineLatency && st.baselineLatency > 0) {
    const avgLatency = recent.reduce((s, e) => s + e.latencyMs, 0) / recent.length;
    const latencyRatio = avgLatency / st.baselineLatency;
    // Penalize if current latency is > 2x baseline
    latencyScore = Math.max(0, Math.min(100, (2 - latencyRatio) * 100));
  }

  // Weighted composite (freshness matters most for arbitraje execution risk)
  const composite = freshnessScore * 0.40 + errorScore * 0.30 + latencyScore * 0.30;
  return +Math.max(0, Math.min(100, composite)).toFixed(1);
}

/**
 * Get the score penalty to apply to an opportunity involving this exchange.
 * Returns a number in [0, 25] — subtract from the opportunity's composite score.
 * Returns 0 if the exchange is healthy (reliability >= 85).
 */
function getDynamicPenalty(exchange) {
  const reliability = computeReliabilityScore(exchange);
  if (reliability >= 85) return 0;
  // Linear penalty: 0 at 85%, 25 at 0%
  return +((85 - reliability) / 85 * 25).toFixed(1);
}

function getAllReliabilityScores() {
  return EXCHANGES.map(ex => ({
    exchange:         ex,
    reliabilityScore: computeReliabilityScore(ex),
    penalty:          getDynamicPenalty(ex),
    recentEvents:     _events[ex].updates.length,
    baselineLatencyMs: _events[ex].baselineLatency,
    lastUpdateAgoMs:  _events[ex].updates.length
      ? Date.now() - _events[ex].updates[_events[ex].updates.length - 1].ts
      : null,
  }));
}

function resetReliability() {
  for (const ex of EXCHANGES) {
    _events[ex].updates      = [];
    _events[ex].baselineLatency = null;
    _events[ex].baselineSamples = 0;
  }
}

// ─── ADR-019 §5: Execution Quality / Slippage penalty ──────────────────────
// Self-healing rolling window of realized slippage bias per exchange (bias
// = realized slippagePct on a completed trade — positive means the fill
// was worse than modeled). Ages out automatically via the same WINDOW_MS
// used by the feed-health tracker above, so no manual reset is needed as
// conditions improve — a bad patch of fills 10 minutes ago stops counting
// on its own. Gated behind liveConfig.slippagePenaltyEnabled and requires
// at least minExecutionSamples observations before applying (same
// insufficient-sample guard as ADR-019 §3's getExecutionPenalty).
const _slippageSamples = {};
for (const ex of EXCHANGES) _slippageSamples[ex] = []; // { ts, biasPct }

/**
 * recordSlippageBias — record one realized-slippage observation for an
 * exchange. Called from arbitrageOrchestrator.executeBestOpportunity()
 * after a trade completes, once per side (buy/sell exchange), using the
 * trade's realized slippagePct as the bias signal.
 */
function recordSlippageBias(exchange, biasPct) {
  const arr = _slippageSamples[exchange];
  if (!arr) return;
  const now = Date.now();
  arr.push({ ts: now, biasPct: Number(biasPct) || 0 });
  while (arr.length > 0 && now - arr[0].ts > WINDOW_MS) arr.shift();
  if (arr.length > MAX_EVENTS_PER_EXCHANGE) arr.shift();
}

/**
 * getSlippagePenalty - ADR-019 §5. Returns a penalty in [0, 25] (same
 * scale as getDynamicPenalty, so the two can be combined via Math.max at
 * the call site without re-normalizing) derived from the average realized
 * slippage bias over the rolling window. 0 when disabled, insufficient
 * samples, or the average bias is at/below 0 (fills as good as or better
 * than modeled — no penalty for good execution).
 */
function getSlippagePenalty(exchange) {
  const liveConfig = require('./liveConfig');
  if (!liveConfig.get('slippagePenaltyEnabled')) return 0;

  const arr = _slippageSamples[exchange];
  if (!arr) return 0;
  const now = Date.now();
  const recent = arr.filter(s => now - s.ts <= WINDOW_MS);
  const minSamples = liveConfig.get('minExecutionSamples');
  if (recent.length < minSamples) return 0;

  const avgBias = recent.reduce((s, e) => s + e.biasPct, 0) / recent.length;
  if (avgBias <= 0) return 0;
  // Linear scale: 0% avg bias → 0 penalty, 1.0% avg bias → 25 (capped).
  return +Math.min(25, avgBias * 25).toFixed(1);
}

function resetSlippagePenalty() {
  for (const ex of EXCHANGES) _slippageSamples[ex] = [];
}

module.exports = {
  recordFeedEvent,
  getDynamicPenalty,
  computeReliabilityScore,
  getAllReliabilityScores,
  resetReliability,
  // ADR-019 §5
  recordSlippageBias,
  getSlippagePenalty,
  resetSlippagePenalty,
};

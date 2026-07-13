/**
 * missedOpportunityTracker.js — Kukora v10
 *
 * Responde la pregunta que no comparable arbitrage system. No todas se ejecutan:
 * algunas son bloqueadas por cooldown (MIN_EXEC_INTERVAL), otras por
 * fingerprinting (mismo spread visto hace <5s), otras por score bajo
 * (< minScore configurado). Cada una de esas tiene un costo de oportunidad
 * real y cuantificable.
 *
 * Este módulo registra cada oportunidad viable NO ejecutada con la razón
 * exacta, el profit potencial perdido, y agrega estadísticas de sesión:
 *   - totalMissedProfit: suma de netProfit de todas las oportunidades perdidas
 *   - missedByReason: desglose por razón (cooldown, fingerprint, score, etc.)
 *   - captureRate: trades ejecutados / (trades ejecutados + oportunidades perdidas)
 *
 * Esto demuestra madurez en el análisis de un sistema de trading — el ROI
 * no es solo lo que ganaste, sino también qué tan eficientemente usas las
 * oportunidades que el mercado ofrece.
 */

'use strict';

const MAX_MISSED = 500;

const _missed = []; // rolling buffer

const _aggregates = {
  totalMissedProfit:    0,
  totalMissedCount:     0,
  totalExecutedCount:   0,
  byReason: {
    cooldown:      { count: 0, profit: 0 },
    fingerprint:   { count: 0, profit: 0 },
    score_too_low: { count: 0, profit: 0 },
    circuit_breaker: { count: 0, profit: 0 },
    liquidity:     { count: 0, profit: 0 },
    daily_loss:    { count: 0, profit: 0 },
    other:         { count: 0, profit: 0 },
  },
};

// ── Classify why an opportunity was not executed ───────────────────────────
function classifyMissReason(op, skipReason) {
  if (!skipReason) {
    if (op.circuitBreaker) return 'circuit_breaker';
    if (!op.liquidityOk)   return 'liquidity';
    return 'other';
  }
  if (skipReason === 'cooldown')       return 'cooldown';
  if (skipReason === 'fingerprint')    return 'fingerprint';
  if (skipReason === 'score_too_low')  return 'score_too_low';
  if (skipReason === 'daily_loss')     return 'daily_loss';
  return 'other';
}

/**
 * Record a missed opportunity.
 * @param {Object} op         - The viable opportunity object
 * @param {string} skipReason - Why it wasn't executed: 'cooldown' | 'fingerprint' | 'score_too_low' | 'daily_loss'
 */
function recordMissed(op, skipReason) {
  if (!op || !op.viable) return;
  if (op.circuitBreaker || op.liquidityOk === false) return; // these are structural rejects, not misses

  const reason = classifyMissReason(op, skipReason);
  const profit = op.netProfit || 0;

  _missed.push({
    ts:           new Date().toISOString(),
    pair:         `${op.buyExchange}→${op.sellExchange}`,
    reason,
    netProfit:    +profit.toFixed(4),
    spreadPct:    op.spreadPct,
    score:        op.score,
    slippageMethod: op.slippageMethod,
  });

  if (_missed.length > MAX_MISSED) _missed.shift();

  _aggregates.totalMissedProfit += profit;
  _aggregates.totalMissedCount  += 1;
  const bucket = _aggregates.byReason[reason] || _aggregates.byReason.other;
  bucket.count  += 1;
  bucket.profit += profit;
}

function recordExecuted() {
  _aggregates.totalExecutedCount += 1;
}

function getMissedSummary() {
  const total = _aggregates.totalExecutedCount + _aggregates.totalMissedCount;
  const captureRate = total > 0
    ? +(_aggregates.totalExecutedCount / total * 100).toFixed(1)
    : null;

  return {
    totalMissedProfit:  +_aggregates.totalMissedProfit.toFixed(4),
    totalMissedCount:   _aggregates.totalMissedCount,
    totalExecutedCount: _aggregates.totalExecutedCount,
    captureRate,
    byReason: Object.fromEntries(
      Object.entries(_aggregates.byReason).map(([k, v]) => [k, {
        count:  v.count,
        profit: +v.profit.toFixed(4),
      }])
    ),
  };
}

function getMissedRecent(limit = 30) {
  return _missed.slice(-limit).reverse();
}

function resetMissed() {
  _missed.length = 0;
  _aggregates.totalMissedProfit  = 0;
  _aggregates.totalMissedCount   = 0;
  _aggregates.totalExecutedCount = 0;
  for (const k of Object.keys(_aggregates.byReason)) {
    _aggregates.byReason[k] = { count: 0, profit: 0 };
  }
}

module.exports = { recordMissed, recordExecuted, getMissedSummary, getMissedRecent, resetMissed };

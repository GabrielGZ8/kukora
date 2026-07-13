'use strict';

/**
 * slippageValidator.js — Kukora v1 (RoadmapToProduction Phase 1)
 *
 * Validates whether modeled slippage is accurate vs the spread the market
 * would actually provide — the key Phase 1 criterion before live capital deployment.
 *
 * The gap being closed:
 *   The engine models slippage via VWAP L2 walk. But does the modeled P&L
 *   match what a real order would have achieved? This module tracks:
 *     - modeledSpreadPct: the spread the engine detected at signal time
 *     - realizedSpreadPct: the spread actually captured (after execution latency)
 *     - slippageDivergencePct: how much the model over/underestimated
 *
 * Key metric — Phase 1 production gate:
 *   "Modeled slippage within 25% of realized in > 80% of opportunities"
 *   (slippageAccuracyRate >= 0.80 is the go/no-go criterion for live capital)
 *
 * In paper trading mode (current), "realized" is approximated by capturing
 * the spread 50–150ms after detection — simulating order placement latency.
 * In live mode, realizedSpreadPct comes from the actual exchange fill price.
 *
 * Architecture:
 *   - Called by arbitrageOrchestrator.js after every opportunity detection + execution
 *   - Maintains rolling 500-sample buffer (approx 2–8 hours of data)
 *   - Exposes calibration stats to /api/arbitrage/calibration endpoint
 *   - Auto-adjusts liveConfig.minNetProfitUSD if divergence is systematic
 */

const liveConfig = require('../../infrastructure/liveConfig');

// ─── Storage ──────────────────────────────────────────────────────────────────
const MAX_SAMPLES = 500;
const _samples = [];  // rolling buffer

const _stats = {
  totalSamples:           0,
  accurateSamples:        0,    // within 25% divergence
  overestimatedCount:     0,    // model said higher than realized
  underestimatedCount:    0,    // model said lower than realized
  totalDivergence:        0,    // sum of |modeledNet - realizedNet|
  autoAdjustApplied:      0,    // how many times we nudged minNetProfitUSD
  lastAutoAdjust:         null, // ISO timestamp
};

// Calibration threshold: if slippage is consistently X% off, auto-correct
// Item 2 (config dinámica): antes una const de módulo fija en 0.25. Ahora
// se lee de liveConfig en cada validación — default idéntico (0.25), sin
// cambio de comportamiento hasta que se ajuste desde la API.
const AUTO_ADJUST_WINDOW        = 50;   // require N samples before auto-adjusting
const AUTO_ADJUST_TRIGGER       = 0.30; // auto-adjust if accuracy < 30%

/**
 * recordSample — record one opportunity's modeled vs realized economics.
 *
 * @param {object} p
 *   p.pair             — "Binance→OKX"
 *   p.modeledSpreadPct — spread % the engine detected
 *   p.modeledNetUSD    — estimated net profit USD
 *   p.realizedSpreadPct — spread % actually captured (post-latency observation)
 *   p.realizedNetUSD   — actual net profit USD after execution
 *   p.executionLatencyMs — time from signal to fill (ms)
 *   p.score            — opportunity composite score at signal time
 */
function recordSample(p) {
  if (!p || typeof p.modeledNetUSD !== 'number' || typeof p.realizedNetUSD !== 'number') return;

  const divergence = Math.abs(p.modeledNetUSD - p.realizedNetUSD);
  const relDivergence = p.modeledNetUSD !== 0
    ? divergence / Math.abs(p.modeledNetUSD)
    : 0;
  const accurate = relDivergence <= liveConfig.get('slippageDivergenceThresholdPct');
  const overestimated = p.modeledNetUSD > p.realizedNetUSD;

  const sample = {
    ts:                   new Date().toISOString(),
    pair:                 p.pair || 'unknown',
    modeledSpreadPct:     p.modeledSpreadPct || 0,
    modeledNetUSD:        p.modeledNetUSD,
    realizedSpreadPct:    p.realizedSpreadPct || 0,
    realizedNetUSD:       p.realizedNetUSD,
    divergenceUSD:        +divergence.toFixed(4),
    relativeDivergence:   +relDivergence.toFixed(4),
    accurate,
    overestimated,
    executionLatencyMs:   p.executionLatencyMs || 0,
    score:                p.score || 0,
  };

  _samples.push(sample);
  if (_samples.length > MAX_SAMPLES) _samples.shift();

  // Update running stats
  _stats.totalSamples++;
  if (accurate) _stats.accurateSamples++;
  if (overestimated) _stats.overestimatedCount++;
  else _stats.underestimatedCount++;
  _stats.totalDivergence += relDivergence;

  // Auto-adjust check (only when enough samples have accumulated)
  _maybeAutoAdjust();
}

/**
 * _maybeAutoAdjust — if model is systematically overestimating profit,
 * raise minNetProfitUSD to compensate. Runs only on the first N*k samples
 * to avoid continuous oscillation.
 */
function _maybeAutoAdjust() {
  if (_stats.totalSamples < AUTO_ADJUST_WINDOW) return;
  if (_stats.totalSamples % AUTO_ADJUST_WINDOW !== 0) return; // only on window boundaries

  const accuracy = getCalibrationStats().slippageAccuracyRate;
  if (accuracy >= AUTO_ADJUST_TRIGGER) return; // healthy enough

  // Only auto-adjust upward if we're systematically overestimating profit
  const overestimatedRate = _stats.overestimatedCount / (_stats.totalSamples || 1);
  if (overestimatedRate < 0.60) return; // not systematic enough

  const currentMin = liveConfig.get('minNetProfitUSD');
  const bump = +(currentMin * 0.10).toFixed(2); // raise floor by 10%
  const newMin = Math.min(currentMin + bump, 5.00); // cap at $5 to avoid over-correction

  if (newMin > currentMin) {
    liveConfig.setMany({ minNetProfitUSD: newMin }, 'slippageValidator.autoAdjust');
    _stats.autoAdjustApplied++;
    _stats.lastAutoAdjust = new Date().toISOString();
  }
}

/**
 * getCalibrationStats — summary for the /api/arbitrage/calibration endpoint.
 */
function getCalibrationStats() {
  const n = _samples.length;
  if (!n) {
    return {
      sampleCount:            0,
      slippageAccuracyRate:   null,
      meanRelativeDivergence: null,
      overestimationRate:     null,
      phase1GateMet:          false,
      phase1GateThreshold:    0.80,
      autoAdjustApplied:      _stats.autoAdjustApplied,
      lastAutoAdjust:         _stats.lastAutoAdjust,
      recentSamples:          [],
    };
  }

  const accurate     = _samples.filter(s => s.accurate).length;
  const overestimated = _samples.filter(s => s.overestimated).length;
  const sumDiv       = _samples.reduce((a, s) => a + s.relativeDivergence, 0);

  const slippageAccuracyRate   = +(accurate / n).toFixed(4);
  const meanRelativeDivergence = +(sumDiv / n).toFixed(4);
  const overestimationRate     = +(overestimated / n).toFixed(4);

  // Pair breakdown — which pairs have the worst calibration?
  const pairStats = {};
  for (const s of _samples) {
    if (!pairStats[s.pair]) pairStats[s.pair] = { accurate: 0, total: 0, sumDiv: 0 };
    pairStats[s.pair].total++;
    if (s.accurate) pairStats[s.pair].accurate++;
    pairStats[s.pair].sumDiv += s.relativeDivergence;
  }
  const pairBreakdown = Object.entries(pairStats).map(([pair, ps]) => ({
    pair,
    sampleCount:     ps.total,
    accuracyRate:    +(ps.accurate / ps.total).toFixed(3),
    meanDivergence:  +(ps.sumDiv / ps.total).toFixed(3),
  })).sort((a, b) => a.accuracyRate - b.accuracyRate); // worst first

  return {
    sampleCount:            n,
    slippageAccuracyRate,
    meanRelativeDivergence,
    overestimationRate,
    phase1GateMet:          slippageAccuracyRate >= 0.80,
    phase1GateThreshold:    0.80,
    interpretation:         _interpret(slippageAccuracyRate, meanRelativeDivergence, overestimationRate),
    pairBreakdown,
    autoAdjustApplied:      _stats.autoAdjustApplied,
    lastAutoAdjust:         _stats.lastAutoAdjust,
    recentSamples:          _samples.slice(-20).reverse(),
  };
}

function _interpret(accuracy, meanDiv, overRate) {
  if (accuracy === null) return 'Insufficient data — need at least 1 sample.';
  if (accuracy >= 0.80) {
    return `Phase 1 gate MET — model is calibrated (${(accuracy * 100).toFixed(1)}% accurate, target ≥ 80%).`;
  }
  const direction = overRate > 0.60
    ? 'Model is overestimating profit (optimistic bias). Raise minNetProfitUSD or reduce tradeAmountBTC.'
    : overRate < 0.40
    ? 'Model is underestimating profit (conservative bias). Spreads may be wider than modeled — review VWAP depth.'
    : 'Divergence is not directional. Check execution latency — spread may be decaying before fill.';

  return `Phase 1 gate NOT MET (${(accuracy * 100).toFixed(1)}% accurate, target ≥ 80%). ${direction}`;
}

function reset() {
  _samples.length = 0;
  Object.assign(_stats, {
    totalSamples: 0, accurateSamples: 0,
    overestimatedCount: 0, underestimatedCount: 0,
    totalDivergence: 0, autoAdjustApplied: 0, lastAutoAdjust: null,
  });
}

module.exports = { recordSample, getCalibrationStats, reset };

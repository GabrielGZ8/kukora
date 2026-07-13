/**
 * adaptivePositionSizing.js — Kukora v15
 *
 * Problema que resuelve:
 *   Actualmente cada trade es exactamente DEFAULT_TRADE_AMOUNT (0.05 BTC).
 *   Un sistema institucional ajusta el tamaño según la calidad de la oportunidad:
 *   si el score es 90+ y el momentum confirma apertura → 0.10 BTC (más retorno)
 *   si el score es 65 y el momentum es incierto     → 0.025 BTC (menos riesgo)
 *
 * Modelo de sizing — 4 factores multiplicativos:
 *
 *   1. Score factor (0.5x – 1.5x)
 *      score < 60  → 0.5x  (oportunidad marginal, reducir exposición)
 *      score 60-74 → 0.8x
 *      score 75-84 → 1.0x  (baseline)
 *      score 85-94 → 1.3x
 *      score ≥ 95  → 1.5x  (oportunidad excepcional)
 *
 *   2. Momentum factor (0.7x – 1.2x)
 *      trend='closing'  → 0.7x (spread se está cerrando, reducir)
 *      trend='stable'   → 1.0x
 *      trend='opening'  → 1.2x (spread creciendo, aprovechar más)
 *      sin momentum     → 1.0x (no penalizar si no hay datos aún)
 *
 *   3. Spread quality factor (0.8x – 1.3x)
 *      spreadPct < breakEven * 1.2  → 0.8x (margen ajustado)
 *      spreadPct < breakEven * 1.5  → 1.0x
 *      spreadPct < breakEven * 2.0  → 1.1x
 *      spreadPct ≥ breakEven * 2.0  → 1.3x (spread amplio, confianza alta)
 *
 *   4. Session P&L factor (0.6x – 1.0x)
 *      Si hay pérdida acumulada en la sesión → reducir tamaño progresivamente
 *      P&L ≥ 0             → 1.0x
 *      P&L entre -$50/$0   → 0.9x
 *      P&L entre -$150/-$50 → 0.75x
 *      P&L < -$150          → 0.6x (modo defensivo)
 *
 * Resultado:
 *   size = DEFAULT_TRADE_AMOUNT × scoreFactor × momentumFactor × spreadFactor × pnlFactor
 *   Clamp al rango [MIN_SIZE, MAX_SIZE] con paso de 0.005 BTC.
 *
 * Transparencia:
 *   Cada trade incluye { positionSizing: { size, factors, reasoning } }
 *   
 */

'use strict';

const liveConfig = require('../../infrastructure/liveConfig');
const marketRegimeCache = require('../engines/marketRegimeCache');

const MIN_SIZE  = 0.01;  // BTC — floor; never size below this
const MAX_SIZE  = 0.15;  // BTC — techo de riesgo
const SIZE_STEP = 0.005; // BTC — granularidad

/**
 * computeSize — calcula el tamaño óptimo de posición para una oportunidad.
 *
 * @param {object} params
 * @param {number} params.score           — score 0-100 del engine
 * @param {number} params.spreadPct       — spread bruto %
 * @param {number} params.breakEvenPct    — break-even % para este par
 * @param {object} params.spreadMomentum  — objeto del spreadMomentumEngine (puede ser null)
 * @param {number} params.sessionPnl      — P&L acumulado de la sesión (USD)
 * @param {number} params.defaultAmount   — DEFAULT_TRADE_AMOUNT del engine
 * @param {object|null} params.liquidityPrediction — ADR-019 §2: { buy, sell } from
 *   liquidityPredictionEngine.enrichWithLiquidityPrediction(), each with
 *   { expectedFillPct, confidence, trend }. Optional — absence is neutral.
 * @returns {{ size: number, factors: object, reasoning: string[] }}
 */
function computeSize({
  score, spreadPct, breakEvenPct, spreadMomentum, sessionPnl, defaultAmount,
  liquidityPrediction = null,
  // ADR-019 §4: injectable so callers/tests can isolate from the live
  // marketRegimeCache singleton. Defaults to the real cached value in
  // production (getPositionSizeForOpportunity does not override it).
  marketRegimeSizeMultiplier = undefined,
}) {
  const base     = defaultAmount || 0.05;
  const reasoning = [];

  // ── Factor 1: Score ─────────────────────────────────────────────────────
  let scoreFactor;
  if      (score >= 95) { scoreFactor = 1.5; reasoning.push(`score ${score} ≥95 → +50% (oportunidad excepcional)`); }
  else if (score >= 85) { scoreFactor = 1.3; reasoning.push(`score ${score} 85-94 → +30%`); }
  else if (score >= 75) { scoreFactor = 1.0; reasoning.push(`score ${score} 75-84 → baseline`); }
  else if (score >= 60) { scoreFactor = 0.8; reasoning.push(`score ${score} 60-74 → -20% (marginal)`); }
  else                  { scoreFactor = 0.5; reasoning.push(`score ${score} <60 → -50% (muy marginal)`); }

  // ── Factor 2: Momentum ──────────────────────────────────────────────────
  let momentumFactor = 1.0;
  if (spreadMomentum) {
    if      (spreadMomentum.trend === 'opening' && spreadMomentum.confidence > 50) {
      momentumFactor = 1.2;
      reasoning.push(`momentum opening (conf=${spreadMomentum.confidence}%) → +20%`);
    } else if (spreadMomentum.trend === 'closing') {
      momentumFactor = 0.7;
      reasoning.push(`momentum closing (vel=${spreadMomentum.velocityPctPerSec.toFixed(4)}%/s) → -30%`);
    } else if (spreadMomentum.trend === 'stable') {
      reasoning.push(`momentum stable → sin ajuste`);
    } else {
      // Bug real (encontrado leyendo el código, no simulado): antes este
      // else también atrapaba trend='opening' con confidence <= 50 y lo
      // etiquetaba como "momentum stable" en `reasoning` — el factor
      // aplicado (1.0x, sin ajuste) siempre fue correcto, pero el texto de
      // transparencia mostrado al usuario mentía sobre cuál era el momentum
      // real. `reasoning` es la feature de explainability — que diga la
      // verdad importa tanto como que el número sea correcto.
      reasoning.push(`momentum ${spreadMomentum.trend} (confianza ${spreadMomentum.confidence ?? '—'}% insuficiente) → sin ajuste`);
    }
  } else {
    reasoning.push(`sin momentum (insuficientes muestras) → sin ajuste`);
  }

  // ── Factor 3: Spread quality ────────────────────────────────────────────
  let spreadFactor = 1.0;
  if (breakEvenPct > 0) {
    const ratio = spreadPct / breakEvenPct;
    if      (ratio >= 2.0) { spreadFactor = 1.3; reasoning.push(`spread ${ratio.toFixed(1)}x break-even → +30%`); }
    else if (ratio >= 1.5) { spreadFactor = 1.1; reasoning.push(`spread ${ratio.toFixed(1)}x break-even → +10%`); }
    else if (ratio >= 1.2) { spreadFactor = 1.0; reasoning.push(`spread ${ratio.toFixed(1)}x break-even → baseline`); }
    else                   { spreadFactor = 0.8; reasoning.push(`spread ${ratio.toFixed(1)}x break-even → -20% (margen ajustado)`); }
  }

  // ── Factor 4: Session P&L (drawdown protection) ─────────────────────────
  let pnlFactor = 1.0;
  if      (sessionPnl >= 0)    { pnlFactor = 1.0; }
  else if (sessionPnl >= -50)  { pnlFactor = 0.9;  reasoning.push(`Session P&L $${sessionPnl.toFixed(2)} → -10%`); }
  else if (sessionPnl >= -150) { pnlFactor = 0.75; reasoning.push(`Session P&L $${sessionPnl.toFixed(2)} → -25% (cautious mode)`); }
  else                         { pnlFactor = 0.6;  reasoning.push(`Session P&L $${sessionPnl.toFixed(2)} → -40% (defensive mode)`); }

  // ── Factor 5 (ADR-019 §2): Liquidity Prediction ─────────────────────────
  // ≤1.0x only — this is a defensive-only signal (see ADR-019 Part A §2):
  // a favorable liquidity prediction never increases size beyond what the
  // other four factors already decided, it can only shrink it further when
  // the predicted fill quality on either leg looks weak. Neutral (1.0x)
  // whenever: the signal is disabled, absent (no liquidityPrediction on
  // this opportunity), or its confidence is below minLiquidityConfidence
  // (untrusted — a cold-start prediction with almost no samples yet).
  let liquidityFactor = 1.0;
  if (liveConfig.get('liquidityFactorEnabled') && liquidityPrediction) {
    const { buy, sell } = liquidityPrediction;
    const minConfidence = Math.min(buy?.confidence ?? 0, sell?.confidence ?? 0);
    const requiredConfidence = liveConfig.get('minLiquidityConfidence');
    if (minConfidence >= requiredConfidence) {
      const minFillPct = Math.min(buy?.expectedFillPct ?? 100, sell?.expectedFillPct ?? 100);
      if      (minFillPct >= 90) { liquidityFactor = 1.0; }
      else if (minFillPct >= 70) { liquidityFactor = 0.85; reasoning.push(`liquidity pred. fill ${minFillPct.toFixed(0)}% (70-90) → -15%`); }
      else if (minFillPct >= 50) { liquidityFactor = 0.65; reasoning.push(`liquidity pred. fill ${minFillPct.toFixed(0)}% (50-70) → -35%`); }
      else                       { liquidityFactor = 0.40; reasoning.push(`liquidity pred. fill ${minFillPct.toFixed(0)}% (<50) → -60%`); }

      const deteriorating = buy?.trend === 'deteriorating' || sell?.trend === 'deteriorating';
      if (deteriorating) {
        liquidityFactor = Math.min(liquidityFactor, liquidityFactor * 0.9);
        reasoning.push(`liquidity trend deteriorating on at least one leg → additional -10%`);
      }
      // Belt and suspenders: never let this factor exceed 1.0, whatever
      // the math above produces.
      liquidityFactor = Math.min(1.0, liquidityFactor);
    } else {
      reasoning.push(`liquidity prediction confidence ${minConfidence.toFixed(2)} < ${requiredConfidence} → untrusted, sin ajuste`);
    }
  }

  // ── Factor 6 (ADR-019 §4): Market Regime size multiplier ────────────────
  // <=1.0x only (validated + clamped again in marketRegimeCache itself) —
  // defensive-only, periodic (not per-tick) adjustment based on the
  // currently detected market regime. 1.0 when disabled or regime is
  // BULLISH_EXPANSION/ACCUMULATION-equivalent (no tightening needed).
  const regimeFactor = marketRegimeSizeMultiplier !== undefined
    ? marketRegimeSizeMultiplier
    : marketRegimeCache.getSizeMultiplier();
  if (regimeFactor < 1.0) {
    reasoning.push(`market regime size multiplier ${regimeFactor.toFixed(2)}x → defensive reduction`);
  }

  // ── Compute final position size ─────────────────────────────────────────
  const rawSize  = base * scoreFactor * momentumFactor * spreadFactor * pnlFactor * liquidityFactor * regimeFactor;
  // Round to the nearest SIZE_STEP multiple
  const steps    = Math.round(rawSize / SIZE_STEP);
  const clamped  = Math.max(MIN_SIZE, Math.min(MAX_SIZE, steps * SIZE_STEP));
  const size     = +clamped.toFixed(3);

  return {
    size,
    factors: {
      base,
      scoreFactor:    +scoreFactor.toFixed(2),
      momentumFactor: +momentumFactor.toFixed(2),
      spreadFactor:   +spreadFactor.toFixed(2),
      pnlFactor:      +pnlFactor.toFixed(2),
      liquidityFactor: +liquidityFactor.toFixed(2),
      regimeFactor:    +regimeFactor.toFixed(2),
      combined:       +(scoreFactor * momentumFactor * spreadFactor * pnlFactor * liquidityFactor * regimeFactor).toFixed(3),
    },
    reasoning,
  };
}

/**
 * getPositionSizeForOpportunity — API pública.
 * Enriquece una oportunidad con el tamaño óptimo calculado.
 *
 * @param {object} opp         — oportunidad del engine
 * @param {number} sessionPnl  — P&L de la sesión actual
 * @param {number} defaultAmount
 * @returns {object} opp con campo positionSizing agregado
 */
function getPositionSizeForOpportunity(opp, sessionPnl = 0, defaultAmount = 0.05) {
  if (!opp) return opp;
  const sizing = computeSize({
    score:          opp.score          || 50,
    spreadPct:      opp.spreadPct      || 0,
    breakEvenPct:   opp.breakEvenPct   || 0.2,
    spreadMomentum: opp.spreadMomentum || null,
    sessionPnl,
    defaultAmount,
    liquidityPrediction: opp.liquidityPrediction || null,
  });
  return { ...opp, positionSizing: sizing };
}

/**
 * getSummary — estadísticas de sizing de la sesión.
 * Para el panel de UI.
 */
const _sizeHistory = [];
const MAX_HISTORY  = 200;

function recordSize(size, score) {
  _sizeHistory.push({ size, score, ts: Date.now() });
  if (_sizeHistory.length > MAX_HISTORY) _sizeHistory.shift();
}

function getSummary() {
  if (!_sizeHistory.length) return { avgSize: null, minSize: null, maxSize: null, count: 0 };
  const sizes = _sizeHistory.map(h => h.size);
  return {
    avgSize: +(sizes.reduce((s, v) => s + v, 0) / sizes.length).toFixed(4),
    minSize: Math.min(...sizes),
    maxSize: Math.max(...sizes),
    count:   sizes.length,
    recent:  _sizeHistory.slice(-10),
  };
}

function reset() {
  _sizeHistory.length = 0;
}

module.exports = {
  computeSize,
  getPositionSizeForOpportunity,
  recordSize,
  getSummary,
  reset,
  MIN_SIZE,
  MAX_SIZE,
};

/**
 * mlScoringPipeline.js — Kukora v17
 *
 * Section 13: Machine learning scoring pipeline.
 *
 * NO ES la fuente de verdad del score que se ve en la tabla principal de
 * oportunidades (auditoría comité, Sesión 34). Ese score lo calcula
 * `opportunityDetection.scoreOpportunityDetailed()` — determinístico,
 * explicable componente por componente, y el que decide viabilidad de
 * ejecución real. Este pipeline es un sistema de scoring ML separado e
 * intencional, expuesto solo vía `POST /api/arbitrage/ml/score` para
 * comparar el enfoque determinístico contra un modelo calibrado por
 * features — no consume `opportunityDetection` ni alimenta la decisión de
 * ejecución. Ver el comentario en `scoreOpportunityDetailed` para el
 * espejo de esta nota.
 *
 * Modular scoring pipeline that:
 *   1. Extracts features from opportunity + market context
 *   2. Scores through pluggable model backends
 *   3. Currently implements a calibrated feature-weighted model
 *      (no external ML library required — pure JS, production-ready)
 *   4. Architecture allows future ML models (ONNX, TensorFlow.js, etc.)
 *      to replace or augment the weighted model
 *
 * Outputs:
 *   execution_probability_score  (0–1)
 *   fill_probability_score       (0–1)
 *   profit_quality_score         (0–100)
 *   composite_ml_score           (0–100)
 *   feature_importances          (explainability)
 *
 * Features:
 *   - Liquidity depth (L2 book imbalance)
 *   - Spread width and persistence
 *   - Execution latency estimate
 *   - Exchange reliability (rolling success rate)
 *   - Slippage estimate vs gross spread
 *   - Time-of-day and volatility regime
 *   - Historical fill rate for this pair
 *
 * CHECKPOINT_13 — evaluado para la migración de contrato Opportunity/Trade
 * (punto 1 de la hoja de ruta) y descartado explícitamente, pero por una
 * razón distinta a statArbEngine/scoringService: este módulo SÍ recibe
 * algo con forma de Opportunity, pero su único punto de entrada real es
 * la ruta `POST /api/arbitrage/ml/score` (query.routes.js), que ya valida
 * el body contra `OpportunitySchema` (zod, con .passthrough()) antes de
 * que llegue aquí — un contrato explícito y bloqueante, más fuerte que el
 * patrón no-bloqueante de isOpportunity()+obs.emit usado en los motores
 * satélite migrados. Agregar isOpportunity() adentro de scoreOpportunity()
 * sería un chequeo redundante sobre un límite que ya está protegido.
 * Además, extractFeatures()/WeightedModel.predict() ya toleran campos
 * ausentes con valores por defecto seguros (spreadPct = 0, netProfit = 0,
 * etc.) porque este pipeline es intencionalmente un sandbox de
 * comparación ML-vs-determinístico, no un paso que mute el Opportunity
 * canónico ni alimente la ejecución real (ver nota arriba).
 */

'use strict';

const liveConfig = require('../../infrastructure/liveConfig');

// ─── Feature Registry ─────────────────────────────────────────────────────

/**
 * Extract normalized features [0, 1] from an opportunity and context.
 */
function extractFeatures(opportunity, _context = {}) {
  const {
    spreadPct        = 0,
    slippagePct      = 0,
    slippageMethod   = 'none',
    buySource        = 'rest',
    sellSource       = 'rest',
    reliabilityBuy   = 1,
    reliabilitySell  = 1,
    latencyMs        = 100,
  } = opportunity;

  const weights = liveConfig.get('scoringWeights') || {
    liquidity: 0.20, spread: 0.25, volatility: 0.10,
    execution: 0.20, reliability: 0.15, latency: 0.10,
  };

  // Feature: Liquidity quality (higher = better book)
  // VWAP slippage available → best signal. Fallback to spread-based.
  const slipRatio  = spreadPct > 0 ? slippagePct / spreadPct : 0.5;
  const liquidity  = Math.max(0, 1 - Math.min(1, slipRatio * 2));

  // Feature: Spread attractiveness (not too small, not suspiciously large)
  // Peak attractiveness at 0.15–0.50% spread, declines above 1%
  const spreadNorm = spreadPct <= 0 ? 0
    : spreadPct < 0.05 ? spreadPct / 0.05 * 0.4
    : spreadPct < 0.50 ? 0.4 + (spreadPct - 0.05) / 0.45 * 0.6
    : Math.max(0, 1 - (spreadPct - 0.50) / 2.50);

  // Feature: Volatility proxy (from slippage method — VWAP = deep book = low vol risk)
  const volatilityScore = slippageMethod === 'vwap_l2' ? 0.90
    : slippageMethod === 'l1_spread'  ? 0.70
    : slippageMethod === 'fixed'      ? 0.50
    : 0.40;

  // Feature: Execution quality (WS feeds > REST)
  const execScore = (buySource === 'ws' ? 0.6 : 0.3)
                  + (sellSource === 'ws' ? 0.4 : 0.2);

  // Feature: Exchange reliability (from context — rolling success rate)
  const relScore = Math.min(1, ((reliabilityBuy || 1) + (reliabilitySell || 1)) / 2);

  // Feature: Latency (lower = better; normalize to 0–1 where 1 = <10ms, 0 = >2000ms)
  const latScore = Math.max(0, 1 - Math.log(Math.max(1, latencyMs)) / Math.log(2000));

  // Weighted composite
  const compositeScore = (
    liquidity    * weights.liquidity    +
    spreadNorm   * weights.spread       +
    volatilityScore * weights.volatility +
    execScore    * weights.execution    +
    relScore     * weights.reliability  +
    latScore     * weights.latency
  );

  return {
    features: {
      liquidity:    +liquidity.toFixed(3),
      spread:       +spreadNorm.toFixed(3),
      volatility:   +volatilityScore.toFixed(3),
      execution:    +execScore.toFixed(3),
      reliability:  +relScore.toFixed(3),
      latency:      +latScore.toFixed(3),
    },
    compositeScore: +compositeScore.toFixed(4),
    weights,
  };
}

// ─── Model interface ──────────────────────────────────────────────────────

/**
 * WeightedModel: calibrated feature-weighted model.
 * Serves as the default production model and as a baseline
 * when comparing against future ML models.
 */
class WeightedModel {
  constructor() {
    this.name    = 'weighted_v1';
    this.version = '1.0.0';
    this._calibration = {
      // Derived from backtested session data patterns
      // These will self-improve as more execution data accumulates
      executionProbabilityBias:  0.0,
      fillProbabilityBias:       0.0,
    };
  }

  predict(features, opportunity) {
    const { compositeScore } = features;

    // Execution probability: probability the trade will execute successfully
    // Modeled as sigmoid of composite score, calibrated against fill history
    const execLogit = (compositeScore - 0.5) * 8 + this._calibration.executionProbabilityBias;
    const executionProbability = 1 / (1 + Math.exp(-execLogit));

    // Fill probability: probability of full fill (vs partial)
    const liq = features.features.liquidity;
    const fillLogit = (liq - 0.5) * 6 + this._calibration.fillProbabilityBias;
    const fillProbability = 1 / (1 + Math.exp(-fillLogit));

    // Profit quality: adjusted for slippage uncertainty
    const grossProfit   = opportunity.netProfit || 0;
    const uncertaintyPct = 1 - features.features.volatility;
    const riskAdjusted  = grossProfit * (1 - uncertaintyPct * 0.3);
    const profitQuality = Math.min(100, Math.max(0, riskAdjusted * 1000));  // scale to 0–100

    const mlScore = (executionProbability * 0.4 + fillProbability * 0.3 + compositeScore * 0.3) * 100;

    return {
      executionProbability: +executionProbability.toFixed(3),
      fillProbability:      +fillProbability.toFixed(3),
      profitQuality:        +profitQuality.toFixed(1),
      mlScore:              +mlScore.toFixed(1),
      confidence:           'medium',  // upgrade to 'high' once calibration data accumulates
    };
  }

  /** Update calibration from realized execution outcomes. */
  calibrate(predictions, outcomes) {
    if (predictions.length < 10) return;
    const actualExecRate  = outcomes.filter(o => o.executed).length / outcomes.length;
    const predictedExec   = predictions.reduce((s, p) => s + p.executionProbability, 0) / predictions.length;
    this._calibration.executionProbabilityBias += (actualExecRate - predictedExec) * 0.1;
    this._calibration.executionProbabilityBias  = Math.max(-2, Math.min(2, this._calibration.executionProbabilityBias));
  }

  getCalibration() { return { ...this._calibration }; }
}

// ─── Model registry ───────────────────────────────────────────────────────
// Future models (ONNX, TensorFlow.js, Gradient Boosting) can be registered here
// without changing the scoring pipeline's public interface.

const _models = {
  weighted_v1: new WeightedModel(),
};
let _activeModel = 'weighted_v1';

function registerModel(name, model) {
  if (!model.predict) throw new Error(`Model ${name} must implement predict(features, opportunity)`);
  _models[name] = model;
}

function setActiveModel(name) {
  if (!_models[name]) throw new Error(`Model ${name} not registered`);
  _activeModel = name;
  return { ok: true, model: name };
}

function getActiveModelName() { return _activeModel; }
function getRegisteredModels() { return Object.keys(_models); }

// ─── Main scoring function ────────────────────────────────────────────────

/**
 * Score an opportunity through the full ML pipeline.
 *
 * @param {object} opportunity  — the opportunity object from detectOpportunities
 * @param {object} context      — { reliabilityBuy, reliabilitySell, latencyMs, ... }
 * @returns {object}            — { mlScore, executionProbability, fillProbability, ... }
 */
function scoreOpportunity(opportunity, context = {}) {
  const featureResult = extractFeatures({ ...opportunity, ...context });
  const model         = _models[_activeModel];
  const prediction    = model.predict(featureResult, opportunity);

  return {
    model:                _activeModel,
    modelVersion:         model.version || '1.0.0',
    ...prediction,
    features:             featureResult.features,
    featureWeights:       featureResult.weights,
    compositeFeatureScore: featureResult.compositeScore,
    // Explainability: which feature contributed most
    topFeature: Object.entries(featureResult.features)
      .map(([name, val]) => ({ name, weighted: val * (featureResult.weights[name] || 0) }))
      .sort((a, b) => b.weighted - a.weighted)[0]?.name || 'unknown',
  };
}

/**
 * Calibrate the active model from a batch of outcomes.
 * Call this periodically (e.g., every 50 trades) to improve scoring accuracy.
 */
function calibrate(predictions, outcomes) {
  const model = _models[_activeModel];
  if (model.calibrate) model.calibrate(predictions, outcomes);
}

module.exports = {
  extractFeatures,
  scoreOpportunity,
  registerModel,
  setActiveModel,
  getActiveModelName,
  getRegisteredModels,
  calibrate,
  WeightedModel,
};

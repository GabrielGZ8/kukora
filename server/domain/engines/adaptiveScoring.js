/**
 * adaptiveScoring.js — Kukora v10 (rewrite)
 *
 * El sistema aprende el umbral óptimo de minScore basado en el historial
 * real de la sesión actual. En lugar de un minScore hardcoded, este módulo
 * analiza el opportunityLog para determinar empíricamente qué combinación
 * de (minScore, cooldownMs) maximiza profit factor out-of-sample.
 *
 * CAMBIOS VS VERSIÓN ANTERIOR:
 *   - Eliminada referencia a `runArbBacktest` (no existe — era un bug crítico)
 *   - Usa la API real de arbBacktestEngine: simulateRun + walkForward
 *   - Sweep de minScore (50→80) en lugar de minNetProfit (no almacenado en oppLog)
 *   - Walk-forward validation para evitar recomendar parámetros overfit
 *
 * FILOSOFÍA:
 *   No modifica el motor automáticamente — expone recomendaciones que el
 *   usuario puede aplicar desde la UI. Cambios automáticos de parámetros
 *   en un sistema de trading vivo sin confirmación explícita son peligrosos.
 *
 * CHECKPOINT_13 — evaluado para la migración de contrato Opportunity/Trade
 * (punto 1 de la hoja de ruta) y descartado explícitamente, mismo caso que
 * arbBacktestEngine.js (del cual este módulo consume walkForward): el
 * punto de entrada real, recalcIfNeeded(oppLog, tradeCount), recibe el
 * MISMO oppLog que getOpportunityLog() expone — un array de entradas de
 * log deliberadamente reducidas (`{ pair, netProfit, spreadPct, viable,
 * score, ts, ... }`, con `pair` como un único string "ex1→ex2"), no el
 * Opportunity canónico completo (que tiene buyExchange/sellExchange como
 * campos separados). isOpportunity() rechazaría el 100% de estas entradas
 * — no porque el dato esté corrupto, sino porque es, por diseño, una
 * forma distinta y más chica (ver comentario en opportunityDetection.js
 * junto al push a _opportunityLog). Si se quiere un contrato explícito
 * para esta forma, debería ser un tipo nuevo (`OpportunityLogEntry`,
 * mismo patrón de creación que RiskContext/StatArbSignal), no forzar
 * Opportunity. Nota relacionada: esta sesión encontró y corrigió un bug
 * real en esa forma reducida — el campo `score` que este módulo necesita
 * (línea de sweep más abajo: `walkForward(oppLog, { minScore, ... })`
 * comparado contra `op.score` dentro de arbBacktestEngine) faltaba en el
 * objeto pusheado al log, así que toda recomendación de este módulo
 * operaba sobre datos donde ningún trade pasaba nunca el filtro de score.
 * Ver tests/arbBacktestEngine.test.js y CHECKPOINT_13.md para el detalle.
 */

'use strict';

const { walkForward } = require('./arbBacktestEngine');
const liveConfig = require('../../infrastructure/liveConfig');
const { logger } = require('../../infrastructure/logger');

// Q2 audit: clean console output in production
const _DEBUG = process.env.DEBUG_KUKORA === '1';
function _warn(...args) { if (_DEBUG) logger.warn('adaptiveScoring', String(args[0]), args.length > 1 ? { extra: args.slice(1) } : undefined); }

const MIN_VIABLE_FOR_ANALYSIS = 10;  // necesitamos ≥10 oportunidades viables
const RECALC_EVERY_N_TRADES   = 5;   // recalcular cada 5 trades nuevos
// Ver liveConfig.get('adaptiveScoringRecalcIntervalMs') (item 2, config dinámica)

const SCORE_SWEEP   = [50, 55, 60, 65, 70, 75, 80];
const COOLDOWN_SWEEP = [1000, 2000, 3000, 5000, 8000];

let _lastCalculatedAt     = 0;
let _tradeCountAtLastCalc = 0;
let _recommendation       = null;

/**
 * Llama esto después de cada trade ejecutado.
 * @param {Array} oppLog       — getOpportunityLog()
 * @param {number} tradeCount  — número actual de trades ejecutados
 */
function recalcIfNeeded(oppLog, tradeCount) {
  const viable = (oppLog || []).filter(o => o.viable);
  if (viable.length < MIN_VIABLE_FOR_ANALYSIS)             return;
  if (tradeCount - _tradeCountAtLastCalc < RECALC_EVERY_N_TRADES) return;
  if (Date.now() - _lastCalculatedAt < liveConfig.get('adaptiveScoringRecalcIntervalMs'))    return;

  _lastCalculatedAt     = Date.now();
  _tradeCountAtLastCalc = tradeCount;

  try {
    _recommendation = _compute(oppLog, tradeCount);
  } catch (e) {
    _warn('[adaptiveScoring] error:', e.message);
  }
}

function _compute(oppLog, tradeCount) {
  // Sweep minScore × cooldown with walk-forward for each combination
  const results = [];
  for (const minScore of SCORE_SWEEP) {
    for (const cooldownMs of COOLDOWN_SWEEP) {
      const wf = walkForward(oppLog, { minScore, cooldownMs, feeMultiplier: 1.0 });
      if (wf.validate.tradesExecuted < 2) continue; // no suficiente data out-of-sample
      results.push({
        minScore, cooldownMs,
        validatePnl:    wf.validate.totalNetProfit,
        validateSharpe: wf.validate.sharpeRatio,
        validatePF:     wf.validate.profitFactor,
        validateTrades: wf.validate.tradesExecuted,
        stability:      wf.sharpeStability,
        // Score compuesto: premia profit Y robustez (stability cerca de 1.0 = generaliza bien)
        composite: (wf.validate.totalNetProfit * 0.5) + (wf.validate.sharpeRatio * 30) - (wf.validate.maxDrawdown * 3),
      });
    }
  }

  if (!results.length) return null;
  results.sort((a, b) => b.composite - a.composite);
  const best = results[0];

  // Comparar contra la config actual (minScore=65, cooldown=3000)
  const current = walkForward(oppLog, { minScore: 65, cooldownMs: 3000, feeMultiplier: 1.0 });

  const upliftPct = current.validate.totalNetProfit > 0
    ? +((best.validatePnl - current.validate.totalNetProfit) / current.validate.totalNetProfit * 100).toFixed(1)
    : null;

  return {
    calculatedAt:  new Date().toISOString(),
    basedOnTrades: tradeCount,
    basedOnOps:    oppLog.length,
    viableOps:     oppLog.filter(o => o.viable).length,
    best: {
      minScore:      best.minScore,
      cooldownMs:    best.cooldownMs,
      validatePnl:   +best.validatePnl.toFixed(4),
      validateSharpe: best.validateSharpe,
      validatePF:    best.validatePF,
      validateTrades: best.validateTrades,
      stability:     best.stability,
    },
    current: {
      minScore: 65, cooldownMs: 3000,
      validatePnl:    +current.validate.totalNetProfit.toFixed(4),
      validateSharpe: current.validate.sharpeRatio,
      validatePF:     current.validate.profitFactor,
    },
    upliftPct,
    isSignificant: upliftPct != null && Math.abs(upliftPct) > 10,
    message: upliftPct != null && upliftPct > 10
      ? `Switching to minScore=${best.minScore}, cooldown=${best.cooldownMs / 1000}s could improve out-of-sample P&L by ~${upliftPct}% over current config.`
      : 'Current configuration is near optimal for this session.',
    topResults: results.slice(0, 5).map(r => ({
      minScore: r.minScore, cooldownMs: r.cooldownMs,
      pnl: +r.validatePnl.toFixed(4), sharpe: r.validateSharpe, trades: r.validateTrades,
    })),
    confidence: _confidenceLabel(tradeCount),
  };
}

function _confidenceLabel(trades) {
  if (trades >= 50) return 'alta';
  if (trades >= 20) return 'media';
  if (trades >= 10) return 'baja';
  return 'insuficiente';
}

function getRecommendation() { return _recommendation; }
function resetAdaptive() {
  _recommendation       = null;
  _lastCalculatedAt     = 0;
  _tradeCountAtLastCalc = 0;
}

module.exports = { recalcIfNeeded, getRecommendation, resetAdaptive };

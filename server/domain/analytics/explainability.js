'use strict';
/**
 * explainability.js — item 6 (refinamiento post-checkpoint-03).
 *
 * PROBLEMA: el score de una oportunidad (opportunityDetection.
 * scoreOpportunityDetailed) y su fill probability (fillProbabilityEngine)
 * ya tienen breakdowns detallados por factor, pero viven en dos objetos
 * separados y no incluyen: fees en dólares, contexto de riesgo (circuit
 * breaker / drawdown / exposición), régimen de volatilidad de mercado, ni
 * qué política de ejecución (market / IOC / post-only) se usaría. El
 * pedido explícito era una sola vista donde se vea CÓMO se llegó a la
 * decisión — no un Opportunity Score aislado.
 *
 * DISEÑO: `op.explain` es una capa de AGREGACIÓN pura — no recalcula nada
 * que ya exista en `op` (score y fillProbability siguen siendo dueños de
 * su propio cálculo en sus propios módulos; este archivo solo los reúne).
 * Todo lo que consulta en vivo lee estado sin mutarlo:
 *
 *   - `advancedRiskEngine.getStatus()` es un snapshot de solo lectura.
 *     Deliberadamente NO se llama `preTradeRiskCheck()` aquí — esa función
 *     SÍ muta tracking real (peak equity, consecutive failures) y llamarla
 *     una vez por oportunidad candidata (docenas por tick) corromperia esa
 *     contabilidad. El explain de riesgo es "así está el motor ahora
 *     mismo", no "así quedaría si ejecuto esto".
 *   - `getVolatilityStatus()` (exchangeIntelligence) también es un getter
 *     puro sobre el rolling-window ya mantenido para otros fines.
 *   - `decideOrderType()` (smartOrderRouter) es una función de decisión
 *     sin efectos secundarios — mostrar qué política se usaría no
 *     modifica nada.
 *
 * Se adjunta una sola vez por oportunidad, justo después del pipeline de
 * enriquecimiento existente (enrichWithFillProbability →
 * enrichWithLiquidityPrediction) en los dos puntos donde
 * arbitrageOrchestrator arma el array `opportunities`.
 */

const advancedRiskEngine = require('../risk/advancedRiskEngine');
const { getVolatilityStatus } = require('../../infrastructure/exchangeIntelligence');
const { decideOrderType } = require('../engines/smartOrderRouter');

/**
 * buildExplainability(op) — construye el objeto `explain` para UNA
 * oportunidad ya enriquecida (score, fillProbability, liquidityPrediction
 * deben existir en `op` si están disponibles; ninguno es obligatorio).
 * Nunca lanza: cualquier fallo en una sub-sección da `null` en esa
 * sección en vez de romper la detección de oportunidades (este campo es
 * puramente informativo para la UI/API, nunca debe poder tumbar el loop).
 */
function buildExplainability(op) {
  let executionPolicy = null;
  try {
    executionPolicy = {
      buy:  decideOrderType('BUY',  op.buyPrice,  { urgent: true }),
      sell: decideOrderType('SELL', op.sellPrice, { urgent: true }),
    };
  } catch (_) { executionPolicy = null; }

  let risk = null;
  try { risk = advancedRiskEngine.getStatus(); } catch (_) { risk = null; }

  let marketContext = null;
  try { marketContext = getVolatilityStatus(); } catch (_) { marketContext = null; }

  return {
    score: {
      value:     op.score ?? null,
      breakdown: op.scoreBreakdown || null,
    },
    fillProbability: {
      value:     op.fillProbability ?? null,
      breakdown: op.fillProbabilityBreakdown || null,
    },
    fees: {
      buyFeeUSD:        op.buyFee ?? null,
      sellFeeUSD:       op.sellFee ?? null,
      totalFeesUSD:      op.totalFees ?? null,
      withdrawalFeeUSD: op.withdrawalFeeUSD ?? null,
    },
    slippage: {
      pct:    op.slippagePct ?? null,
      method: op.slippageMethod ?? null,
    },
    // Ya adjuntado por enrichWithLiquidityPrediction — solo se referencia,
    // no se recalcula.
    liquidity: op.liquidityPrediction || null,
    marketContext,
    risk,
    executionPolicy,
  };
}

/** attachExplainability(opportunities) — helper de conveniencia, mismo estilo que enrichWith*. */
function attachExplainability(opportunities) {
  return opportunities.map((op) => {
    op.explain = buildExplainability(op);
    return op;
  });
}

module.exports = { buildExplainability, attachExplainability };

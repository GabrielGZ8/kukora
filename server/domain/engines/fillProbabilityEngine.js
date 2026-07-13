/**
 * fillProbabilityEngine.js — Kukora v5
 *
 * P(fill) cuantitativo, reproducible y explicable.
 * Sin valores aleatorios — mismos inputs = mismo output.
 *
 * Componentes (suma ponderada 0-100):
 *   depthScore      35% — VWAP fill% real del order book
 *   spreadScore     25% — edge sobre break-even
 *   latencyScore    20% — calidad del feed (WS <50ms = máximo)
 *   liquidityScore  12% — método de slippage (real VWAP > fallback)
 *   volatilityScore  8% — penaliza fills en mercados volátiles
 *
 * Explainable in under 30 seconds: cada factor tiene rango documentado.
 */

const { isOpportunity } = require('../opportunity');
const obs = require('../../infrastructure/observabilityService');

function computeFillProbability(op, options = {}) {
  const volScore = options.volatilityScore || 0;

  // ── 1. Depth score (35%) ──────────────────────────────────────────
  const buyFill  = op.buyFillPct  != null ? Math.min(100, op.buyFillPct)  : 80;
  const sellFill = op.sellFillPct != null ? Math.min(100, op.sellFillPct) : 80;
  const avgFill  = (buyFill + sellFill) / 2;
  const depthScore = avgFill;  // lineal 0-100

  // ── 2. Spread edge score (25%) ────────────────────────────────────
  const spread    = op.spreadPct    || 0;
  const breakEven = op.breakEvenPct || 0;
  const edge      = Math.max(0, spread - breakEven);
  const spreadScore = Math.min(100, (edge / 0.15) * 100);

  // ── 3. Latency / feed quality score (20%) ────────────────────────
  let latScore = 20;
  if (op.buySource === 'ws' && op.sellSource === 'ws') {
    const maxLat = Math.max(op.buyLatency || 0, op.sellLatency || 0);
    if      (maxLat <= 20)  latScore = 100;
    else if (maxLat <= 50)  latScore = 90;
    else if (maxLat <= 100) latScore = 80;
    else if (maxLat <= 300) latScore = 65;
    else                    latScore = 50;
  } else if (op.buySource === 'ws' || op.sellSource === 'ws') {
    latScore = 50;
  }
  const feedAge = op.feedAgeMs || 0;
  if      (feedAge > 4000) latScore = Math.min(latScore, 5);
  else if (feedAge > 2000) latScore = Math.min(latScore, 35);
  else if (feedAge > 800)  latScore = Math.min(latScore, 65);

  // ── 4. Slippage method confidence (12%) ──────────────────────────
  let liqScore = 40;
  if      (op.slippageMethod === 'real')    liqScore = 95;
  else if (op.slippageMethod === 'partial') liqScore = 70;

  // ── 5. Volatility penalty (8%) ───────────────────────────────────
  const volFillScore = Math.max(0, 100 - volScore);

  const raw =
    depthScore   * 0.35 +
    spreadScore  * 0.25 +
    latScore     * 0.20 +
    liqScore     * 0.12 +
    volFillScore * 0.08;

  const floor = op.viable ? 35 : 0;
  const score = Math.max(floor, Math.min(100, Math.round(raw)));

  return {
    fillProbability: score,
    fillProbabilityBreakdown: {
      depthScore:      Math.round(depthScore),
      spreadScore:     Math.round(spreadScore),
      latencyScore:    Math.round(latScore),
      liquidityScore:  Math.round(liqScore),
      volatilityScore: Math.round(volFillScore),
      edge:            +edge.toFixed(4),
      avgFillPct:      +avgFill.toFixed(1),
    },
  };
}

function enrichWithFillProbability(opportunities, btcPriceUSD, volatilityScore = 0) {
  return opportunities.map(op => {
    // Contract check (audit committee, sección 12, punto 1): this is the
    // entry point where this engine consumes an Opportunity built by
    // opportunityDetection.js. Non-blocking — see the matching check in
    // opportunityDetection.js for the full rationale.
    if (!isOpportunity(op)) {
      obs.emit('RISK', 'contract.opportunity_shape_invalid', { id: op.id, buyExchange: op.buyExchange, sellExchange: op.sellExchange, source: 'fillProbabilityEngine' });
    }
    return {
      ...op,
      ...computeFillProbability(op, { btcPriceUSD, volatilityScore }),
    };
  });
}

module.exports = { computeFillProbability, enrichWithFillProbability };

'use strict';

/**
 * liquidityPredictionEngine.js — Kukora (beta)
 *
 * Closes a real gap: Kukora already scores the CURRENT known opportunity's
 * probability of filling (fillProbabilityEngine.js, a deterministic
 * snapshot formula) and calibrates modeled-vs-realized slippage AFTER the
 * fact (slippageValidator.js). Neither of those *predicts* liquidity ahead
 * of time — they only score/validate what's already been observed.
 *
 * This module is a genuinely separate capability: an online statistical
 * model that learns from every real order-book observation and predicts
 * expected liquidity conditions for a given exchange+pair+size BEFORE the
 * next book snapshot arrives — useful for pre-sizing a trade, or for
 * flagging that liquidity has been quietly deteriorating on a venue even
 * though the current snapshot still looks fine.
 *
 * HONEST FRAMING (per Kukora's own audit standard — no overselling):
 * this is a *lightweight statistical model* — double-EWMA + hour-of-day
 * seasonality + size-bucket historical averaging, all classic
 * time-series/forecasting techniques — NOT a trained neural network or
 * gradient-boosted model. It is explicitly a "beta": it needs real
 * observation volume before its predictions are trustworthy, which is why
 * every prediction ships with an explicit `confidence` and `sampleCount`
 * rather than pretending to certainty on a cold start.
 *
 * Model components, per (exchange, pair) key:
 *   1. Short-term EWMA of fillPct   (fast decay — recent regime)
 *   2. Long-term EWMA of fillPct    (slow decay — stable baseline)
 *   3. Hour-of-day bucket average   (captures day/night liquidity seasonality —
 *      real venues are measurably thinner at certain hours)
 *   4. Size-bucket average          (small/medium/large trade size — captures
 *      that fill quality degrades with size, a real market-impact effect)
 *
 * predictLiquidity() blends these with confidence-weighted shrinkage:
 * with few samples, the prediction leans on the hour-of-day / global
 * average (population prior); with many samples, it leans on the
 * pair-specific short-term EWMA (learned behavior). This shrinkage-toward-
 * the-prior pattern is standard practice for small-sample estimation.
 */

const { isOpportunity } = require('../opportunity');
const obs = require('../../infrastructure/observabilityService');

const SHORT_EWMA_ALPHA = 0.30;  // fast decay — reacts within ~3-4 observations
const LONG_EWMA_ALPHA  = 0.05;  // slow decay — reacts over ~20+ observations
const MAX_SAMPLES_PER_KEY = 500;
const CONFIDENCE_SATURATION_SAMPLES = 50; // confidence reaches ~1.0 around this many samples

const SIZE_BUCKETS = [
  { name: 'small',  maxUSD: 1000 },
  { name: 'medium', maxUSD: 10000 },
  { name: 'large',  maxUSD: Infinity },
];

function _sizeBucket(sizeUSD) {
  return SIZE_BUCKETS.find(b => sizeUSD <= b.maxUSD).name;
}

function _key(exchange, pair) {
  return `${(exchange || 'unknown').toLowerCase()}::${(pair || 'unknown').toUpperCase()}`;
}

// Per-key model state. Kept in memory (mirrors the rest of Kukora's
// in-process domain state, e.g. rebalanceEngine's _history) — this is a
// beta learning signal, not a system of record.
const _models = new Map();

function _getOrCreateModel(key) {
  if (!_models.has(key)) {
    _models.set(key, {
      shortEwma: null,
      longEwma: null,
      sampleCount: 0,
      samples: [],                 // rolling buffer of { ts, fillPct, spreadPct, sizeUSD, hour }
      hourBuckets: Array.from({ length: 24 }, () => ({ sum: 0, count: 0 })),
      sizeBuckets: { small: { sum: 0, count: 0 }, medium: { sum: 0, count: 0 }, large: { sum: 0, count: 0 } },
    });
  }
  return _models.get(key);
}

/**
 * Feed a real observation into the model. Call this whenever a fresh
 * order-book-derived fillPct is available — e.g. every opportunity that
 * passes through opportunityDetection.js already carries buyFillPct /
 * sellFillPct, which is exactly the raw signal this model learns from.
 *
 * @param {string} exchange
 * @param {string} pair          e.g. 'BTC/USDT'
 * @param {object} obs
 * @param {number} obs.fillPct   0-100, fraction of requested size fillable
 *                               within acceptable slippage at observation time
 * @param {number} [obs.spreadPct]
 * @param {number} [obs.sizeUSD] the trade size this fillPct was measured against
 * @param {number} [obs.ts]      defaults to Date.now()
 */
function recordObservation(exchange, pair, obs = {}) {
  if (typeof obs.fillPct !== 'number' || Number.isNaN(obs.fillPct)) return null;

  const key = _key(exchange, pair);
  const model = _getOrCreateModel(key);
  const ts = obs.ts || Date.now();
  const fillPct = Math.max(0, Math.min(100, obs.fillPct));
  const sizeUSD = typeof obs.sizeUSD === 'number' && obs.sizeUSD > 0 ? obs.sizeUSD : 1000;
  const hour = new Date(ts).getUTCHours();

  model.shortEwma = model.shortEwma === null ? fillPct : SHORT_EWMA_ALPHA * fillPct + (1 - SHORT_EWMA_ALPHA) * model.shortEwma;
  model.longEwma  = model.longEwma  === null ? fillPct : LONG_EWMA_ALPHA  * fillPct + (1 - LONG_EWMA_ALPHA)  * model.longEwma;
  model.sampleCount += 1;

  model.hourBuckets[hour].sum += fillPct;
  model.hourBuckets[hour].count += 1;

  const bucket = _sizeBucket(sizeUSD);
  model.sizeBuckets[bucket].sum += fillPct;
  model.sizeBuckets[bucket].count += 1;

  model.samples.push({ ts, fillPct, spreadPct: obs.spreadPct ?? null, sizeUSD, hour });
  if (model.samples.length > MAX_SAMPLES_PER_KEY) model.samples.shift();

  return { key, sampleCount: model.sampleCount };
}

/**
 * Predict expected liquidity conditions for a given exchange+pair+size,
 * blending recency (EWMA), seasonality (hour-of-day), and market-impact
 * (size bucket) signals with confidence-weighted shrinkage toward the
 * population prior when the pair-specific sample count is low.
 *
 * @param {string} exchange
 * @param {string} pair
 * @param {object} [opts]
 * @param {number} [opts.sizeUSD]  defaults to 1000
 * @param {number} [opts.ts]       defaults to Date.now() (used for the hour-of-day lookup)
 * @returns {{
 *   expectedFillPct: number,
 *   confidence: number,
 *   sampleCount: number,
 *   trend: 'improving'|'deteriorating'|'stable',
 *   hourOfDayAvgFillPct: number|null,
 *   sizeBucketAvgFillPct: number|null,
 *   recommendedMaxSizeUSD: number|null,
 *   basis: string
 * }}
 */
function predictLiquidity(exchange, pair, opts = {}) {
  const key = _key(exchange, pair);
  const model = _models.get(key);
  const sizeUSD = typeof opts.sizeUSD === 'number' && opts.sizeUSD > 0 ? opts.sizeUSD : 1000;
  const ts = opts.ts || Date.now();
  const hour = new Date(ts).getUTCHours();

  // Cold start: no observations yet for this exchange+pair at all. Return
  // an explicitly low-confidence, neutral prediction rather than a
  // fabricated number — a beta model should say "I don't know yet", not
  // guess with false precision.
  if (!model || model.sampleCount === 0) {
    return {
      expectedFillPct: 70, // neutral, moderately-conservative prior
      confidence: 0,
      sampleCount: 0,
      trend: 'stable',
      hourOfDayAvgFillPct: null,
      sizeBucketAvgFillPct: null,
      recommendedMaxSizeUSD: null,
      basis: 'cold_start_no_observations',
    };
  }

  const hourBucket = model.hourBuckets[hour];
  const hourOfDayAvg = hourBucket.count > 0 ? hourBucket.sum / hourBucket.count : null;

  const sizeBucketName = _sizeBucket(sizeUSD);
  const sizeBucketData = model.sizeBuckets[sizeBucketName];
  const sizeBucketAvg = sizeBucketData.count > 0 ? sizeBucketData.sum / sizeBucketData.count : null;

  const confidence = Math.min(1, model.sampleCount / CONFIDENCE_SATURATION_SAMPLES);

  // Population prior: hour-of-day average if we have one, else the
  // long-term EWMA, else a neutral 70. Confidence-weighted shrinkage
  // blends the pair-specific short-term EWMA toward this prior — with
  // few samples the prior dominates; with many, the learned short-term
  // signal dominates.
  const prior = hourOfDayAvg ?? model.longEwma ?? 70;
  const learned = model.shortEwma ?? prior;
  let expectedFillPct = confidence * learned + (1 - confidence) * prior;

  // Size-bucket effect: if this size bucket has its own history and it
  // diverges from the blended estimate, nudge toward it proportionally to
  // how much data that specific bucket has (capped so it can't dominate
  // with just 1-2 samples).
  if (sizeBucketAvg !== null) {
    const sizeBucketWeight = Math.min(0.4, sizeBucketData.count / CONFIDENCE_SATURATION_SAMPLES);
    expectedFillPct = (1 - sizeBucketWeight) * expectedFillPct + sizeBucketWeight * sizeBucketAvg;
  }
  expectedFillPct = Math.max(0, Math.min(100, expectedFillPct));

  // Trend: simple EWMA crossover — the same idea as a moving-average
  // crossover trend signal, applied to liquidity instead of price.
  let trend = 'stable';
  if (model.longEwma !== null && model.shortEwma !== null) {
    const delta = model.shortEwma - model.longEwma;
    if (delta > 5) trend = 'improving';
    else if (delta < -5) trend = 'deteriorating';
  }

  // Recommended max size: walk the size buckets from smallest to largest
  // and recommend the largest bucket whose historical average fill still
  // clears a reasonable bar (60%), so sizing guidance degrades gracefully
  // as a venue thins out instead of just reporting a raw score.
  let recommendedMaxSizeUSD = null;
  for (const b of SIZE_BUCKETS) {
    const data = model.sizeBuckets[b.name];
    if (data.count === 0) break;
    const avg = data.sum / data.count;
    if (avg < 60) break;
    recommendedMaxSizeUSD = b.maxUSD === Infinity ? recommendedMaxSizeUSD || sizeUSD : b.maxUSD;
  }

  return {
    expectedFillPct: +expectedFillPct.toFixed(1),
    confidence: +confidence.toFixed(2),
    sampleCount: model.sampleCount,
    trend,
    hourOfDayAvgFillPct: hourOfDayAvg !== null ? +hourOfDayAvg.toFixed(1) : null,
    sizeBucketAvgFillPct: sizeBucketAvg !== null ? +sizeBucketAvg.toFixed(1) : null,
    recommendedMaxSizeUSD,
    basis: confidence >= 0.5 ? 'learned_pair_history' : 'prior_shrinkage',
  };
}

/**
 * Convenience wrapper matching the style of
 * fillProbabilityEngine.enrichWithFillProbability(): attach a
 * `liquidityPrediction` field to each opportunity, and feed the
 * opportunity's own fillPct data back into the model as a training
 * observation in the same pass (this is what makes it "online" — every
 * opportunity that flows through the system both consumes and improves
 * the model).
 */
function enrichWithLiquidityPrediction(opportunities, { sizeUSD } = {}) {
  return opportunities.map(op => {
    // Contract check (audit committee, sección 12, punto 1): entry point
    // where this engine consumes an Opportunity built by
    // opportunityDetection.js. Non-blocking — see the matching check in
    // opportunityDetection.js for the full rationale.
    if (!isOpportunity(op)) {
      obs.emit('RISK', 'contract.opportunity_shape_invalid', { id: op.id, buyExchange: op.buyExchange, sellExchange: op.sellExchange, source: 'liquidityPredictionEngine' });
    }

    const pair = op.pair || 'BTC/USDT';
    const avgFillPct = op.buyFillPct != null && op.sellFillPct != null
      ? (op.buyFillPct + op.sellFillPct) / 2
      : null;

    if (avgFillPct !== null && op.buyExchange) {
      recordObservation(op.buyExchange, pair, { fillPct: op.buyFillPct, spreadPct: op.spreadPct, sizeUSD });
    }
    if (avgFillPct !== null && op.sellExchange) {
      recordObservation(op.sellExchange, pair, { fillPct: op.sellFillPct, spreadPct: op.spreadPct, sizeUSD });
    }

    const buyPrediction  = op.buyExchange  ? predictLiquidity(op.buyExchange,  pair, { sizeUSD }) : null;
    const sellPrediction = op.sellExchange ? predictLiquidity(op.sellExchange, pair, { sizeUSD }) : null;

    return { ...op, liquidityPrediction: { buy: buyPrediction, sell: sellPrediction } };
  });
}

/** Testing/ops utility: wipe all learned state (e.g. between test files, or on manual reset). */
function resetModels() {
  _models.clear();
}

/** Testing/ops utility: inspect raw model state for a given exchange+pair. */
function getModelState(exchange, pair) {
  const model = _models.get(_key(exchange, pair));
  if (!model) return null;
  return {
    shortEwma: model.shortEwma,
    longEwma: model.longEwma,
    sampleCount: model.sampleCount,
  };
}

module.exports = {
  recordObservation,
  predictLiquidity,
  enrichWithLiquidityPrediction,
  resetModels,
  getModelState,
};

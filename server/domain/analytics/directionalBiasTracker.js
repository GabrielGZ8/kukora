'use strict';
/**
 * directionalBiasTracker.js — Fase 3, cierre de brecha "rebalanceo predictivo
 * por sesgo direccional" (Pregunta 3, respuesta escrita de Fase 1 al comité):
 *
 *   "si el sistema observa que durante las últimas N ejecuciones un exchange
 *   ha sido consistentemente el comprador y otro el vendedor, puede anticipar
 *   desequilibrios futuros de inventario y rebalancear antes de alcanzar
 *   umbrales críticos"
 *
 * Domain-pure module: takes an array of trade records (already-known shape,
 * see below) and returns a directional bias score per exchange. Contains no
 * I/O — the caller (liveInventoryReconciliation.js) is responsible for
 * supplying the trade history, typically sourced from
 * liveExecution.getAuditLog() filtered to CROSS_EXECUTE_SUCCESS entries.
 *
 * Trade record shape expected: { buyExchange, sellExchange, ...rest }
 * (this is exactly the shape of a CROSS_EXECUTE_SUCCESS audit entry, and
 * also the shape recordTrade() in predictiveRebalance.js already consumes —
 * no new event wiring required).
 *
 * This is intentionally a *different* signal from predictiveRebalance.js's
 * consumption-rate depletion forecast (which models BTC/USDT flow rates).
 * directionalBiasTracker answers a narrower, more literal question: "has
 * this exchange been consistently on one side of the trade lately?" — which
 * is the exact mechanism promised in writing to the judging committee.
 */

const liveConfig = require('../../infrastructure/liveConfig');

const DEFAULT_WINDOW = 20;          // N most recent executions considered
const DEFAULT_MIN_SAMPLE = 8;       // don't score an exchange on too few trades
// Item 2 (config dinámica): antes una tercera const de módulo (0.7)
// duplicando lo que ahora vive en liveConfig.get('directionalBiasThreshold')
// — un solo lugar de verdad para el valor, no dos copias que puedan divergir.

/**
 * computeBias — per-exchange directional bias over the last `window` trades
 * each exchange participated in (as buyer or seller).
 *
 * @param {Array<{buyExchange:string, sellExchange:string}>} trades - most
 *   recent trades first or last, order doesn't matter; only the tail
 *   `window` entries per exchange are used, keyed by array order (index).
 * @param {object} [opts]
 * @param {number} [opts.window=20]
 * @param {number} [opts.minSample=8]
 * @returns {Object<string, {buys:number, sells:number, sampleSize:number,
 *   biasScore:number, direction:'buyer'|'seller'|'neutral'}>}
 */
function computeBias(trades, { window = DEFAULT_WINDOW, minSample = DEFAULT_MIN_SAMPLE } = {}) {
  const perExchange = {}; // exchange -> array of 'buy'|'sell' in chronological order

  for (const t of trades || []) {
    if (!t) continue;
    const buyEx = (t.buyExchange || '').toLowerCase();
    const sellEx = (t.sellExchange || '').toLowerCase();
    if (!buyEx || !sellEx) continue;

    (perExchange[buyEx] = perExchange[buyEx] || []).push('buy');
    (perExchange[sellEx] = perExchange[sellEx] || []).push('sell');
  }

  const result = {};
  for (const [exchange, sides] of Object.entries(perExchange)) {
    const recent = sides.slice(-window);
    const buys = recent.filter(s => s === 'buy').length;
    const sells = recent.filter(s => s === 'sell').length;
    const sampleSize = recent.length;
    const biasScore = sampleSize > 0 ? (buys - sells) / sampleSize : 0;

    let direction = 'neutral';
    if (sampleSize >= minSample) {
      const biasThreshold = liveConfig.get('directionalBiasThreshold');
      if (biasScore >= biasThreshold) direction = 'buyer';
      else if (biasScore <= -biasThreshold) direction = 'seller';
    }

    result[exchange] = {
      buys,
      sells,
      sampleSize,
      biasScore: +biasScore.toFixed(3),
      direction,
    };
  }

  return result;
}

/**
 * getBiasSignals — filters computeBias() output down to exchanges with a
 * statistically meaningful, consistent directional bias (enough samples and
 * |biasScore| over threshold). This is the list a caller should actually
 * act on for predictive rebalancing.
 */
function getBiasSignals(trades, opts = {}) {
  const {
    window = DEFAULT_WINDOW,
    minSample = DEFAULT_MIN_SAMPLE,
    threshold = liveConfig.get('directionalBiasThreshold'),
  } = opts;

  const bias = computeBias(trades, { window, minSample });
  return Object.entries(bias)
    .filter(([, b]) => b.sampleSize >= minSample && Math.abs(b.biasScore) >= threshold)
    .map(([exchange, b]) => ({ exchange, ...b }));
}

module.exports = {
  computeBias,
  getBiasSignals,
  DEFAULT_WINDOW,
  DEFAULT_MIN_SAMPLE,
};

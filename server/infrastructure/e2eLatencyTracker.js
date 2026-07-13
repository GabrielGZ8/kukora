/**
 * e2eLatencyTracker.js — Kukora v12
 *
 * Mide la latencia END-TO-END completa del pipeline de detección:
 *
 *   t0  = timestamp del evento WS raw (ya disponible en priceEmitter como `ts`)
 *   t1  = cuando detectOpportunities() retorna (medido en el handler)
 *   e2e = t1 - t0 = latencia total desde llegada del mensaje hasta oportunidades listas
 *
 * Componentes medidos por separado:
 *   bookRecvMs  — tiempo para traer todos los order books (getOrderBooks)
 *   detectMs    — tiempo de detectOpportunities() en sí
 *   e2eMs       — bookRecvMs + detectMs = pipeline completo
 *
 * Internals:
 *   Buffer circular de 500 muestras (FIFO). Con feeds activos a ~5 updates/s
 *   esto representa ~100s de historia reciente. Suficiente para percentiles
 *   estables sin consumir memoria significativa.
 *
 * Percentiles se calculan on-demand (sort O(n log n) sobre ≤500 elementos = <1ms).
 * No hay estado de running percentile porque priorizamos exactitud sobre velocidad
 * — este endpoint no se llama en el hot path.
 */

'use strict';

const BUFFER_SIZE = 500;

// Muestras: { e2eMs, bookRecvMs, detectMs, exchange, ts }
const _samples = [];

/**
 * record — llamar desde el priceUpdate handler en arbitrage.routes.js
 * después de que detectOpportunities() retorna.
 *
 * @param {number} e2eMs       — t_detect_done - t_ws_event (latencia total)
 * @param {number} bookRecvMs  — tiempo para getOrderBooks()
 * @param {number} detectMs    — tiempo de detectOpportunities()
 * @param {string} exchange    — exchange que disparó el update
 */
function record(e2eMs, bookRecvMs, detectMs, exchange) {
  if (typeof e2eMs !== 'number' || e2eMs < 0 || e2eMs > 30000) return; // sanity check
  _samples.push({ e2eMs, bookRecvMs, detectMs, exchange: exchange || 'unknown', ts: Date.now() });
  if (_samples.length > BUFFER_SIZE) _samples.shift();
}

/**
 * percentile — calcula el percentil p (0–100) de un array numérico.
 * Usa interpolación lineal (método de NumPy/R por defecto).
 */
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * getStats — retorna estadísticas completas de latencia E2E.
 * Seguro para llamar en cualquier momento; retorna nulls si no hay muestras.
 */
function getStats() {
  if (!_samples.length) {
    return {
      sampleCount: 0,
      e2e:         { p50: null, p95: null, p99: null, min: null, max: null, avg: null },
      bookRecv:    { p50: null, p95: null, p99: null, avg: null },
      detect:      { p50: null, p95: null, p99: null, avg: null },
      byExchange:  {},
      recentMs:    null,
    };
  }

  const e2eSorted      = [..._samples.map(s => s.e2eMs)].sort((a, b) => a - b);
  const bookSorted     = [..._samples.map(s => s.bookRecvMs)].sort((a, b) => a - b);
  const detectSorted   = [..._samples.map(s => s.detectMs)].sort((a, b) => a - b);

  const avg = arr => +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2);

  // Per-exchange breakdown
  const byExchange = {};
  for (const s of _samples) {
    if (!byExchange[s.exchange]) byExchange[s.exchange] = [];
    byExchange[s.exchange].push(s.e2eMs);
  }
  const exchangeStats = {};
  for (const [ex, vals] of Object.entries(byExchange)) {
    const sorted = [...vals].sort((a, b) => a - b);
    exchangeStats[ex] = {
      count: sorted.length,
      p50:   +percentile(sorted, 50).toFixed(1),
      p95:   +percentile(sorted, 95).toFixed(1),
      avg:   avg(sorted),
    };
  }

  return {
    sampleCount: _samples.length,
    e2e: {
      p50: +percentile(e2eSorted, 50).toFixed(1),
      p95: +percentile(e2eSorted, 95).toFixed(1),
      p99: +percentile(e2eSorted, 99).toFixed(1),
      min: +e2eSorted[0].toFixed(1),
      max: +e2eSorted[e2eSorted.length - 1].toFixed(1),
      avg: avg(e2eSorted),
    },
    bookRecv: {
      p50: +percentile(bookSorted, 50).toFixed(1),
      p95: +percentile(bookSorted, 95).toFixed(1),
      p99: +percentile(bookSorted, 99).toFixed(1),
      avg: avg(bookSorted),
    },
    detect: {
      p50: +percentile(detectSorted, 50).toFixed(1),
      p95: +percentile(detectSorted, 95).toFixed(1),
      p99: +percentile(detectSorted, 99).toFixed(1),
      avg: avg(detectSorted),
    },
    byExchange: exchangeStats,
    recentMs: _samples[_samples.length - 1]?.e2eMs ?? null,
    bufferSize: BUFFER_SIZE,
  };
}

/**
 * getRecentSamples — últimas N muestras para sparkline en UI.
 */
function getRecentSamples(n = 60) {
  return _samples.slice(-n).map(s => ({ e2eMs: s.e2eMs, detectMs: s.detectMs, ts: s.ts }));
}

function reset() {
  _samples.length = 0;
}

module.exports = { record, getStats, getRecentSamples, reset };

/**
 * spreadHeatmapService.js — Kukora v14
 *
 * Responde la pregunta: "¿A qué hora del día ocurren los mejores spreads?"
 *
 * Después de semanas de operación continua, este módulo puede mostrar que
 * Binance→OKX tiene spreads más amplios entre 2am-5am CST (cuando los mercados
 * asiáticos abren y hay rotación de liquidez). Esa es inteligencia de mercado
 * real que ningún prototipo de 48h puede tener.
 *
 * Diseño:
 *   - 24 buckets por par por par (hora 0-23 UTC)
 *   - Cada bucket acumula: count, sumSpread, maxSpread, viableCount
 *   - Flush a MongoDB cada 10 min + en cada trade ejecutado
 *   - Se restaura desde MongoDB al inicio (survives restarts)
 *   - Schema: { date, hour, pair, count, avgSpread, maxSpread, viableCount }
 *
 * En memoria mantiene los últimos 7 días (168 horas × N pares).
 * MongoDB es la fuente de verdad para historia completa.
 */

'use strict';

const mongoose = require('mongoose');
const { logger } = require('./logger');

// Q2 audit: clean console output in production
const _DEBUG = process.env.DEBUG_KUKORA === '1';
function _warn(...args) { if (_DEBUG) logger.warn('spreadHeatmapService', String(args[0]), args.length > 1 ? { extra: args.slice(1) } : undefined); }

// Audit fix 1.3: schema moved to server/models/HeatmapBucket.js.
const HeatmapBucket = require('./persistence/models/HeatmapBucket');

function isMongoReady() {
  return mongoose.connection.readyState === 1;
}

// ─── Estado en memoria ─────────────────────────────────────────────────────
// Clave: "YYYY-MM-DD|HH|pair" → { count, sumSpread, maxSpread, viableCount }
const _buckets = new Map();
const   _dirty   = new Set(); // buckets modified since last flush

function bucketKey(date, hour, pair) {
  return `${date}|${String(hour).padStart(2, '0')}|${pair}`;
}

function nowParts() {
  const now  = new Date();
  const date = now.toISOString().slice(0, 10);
  const hour = now.getUTCHours();
  return { date, hour };
}

// ─── Record ────────────────────────────────────────────────────────────────

/**
 * record — registrar un spread observado para un par en el bucket actual.
 * @param {string} pair       — "Binance→OKX"
 * @param {number} spreadPct  — spread bruto en %
 * @param {boolean} viable    — si superó el umbral de viabilidad
 */
function record(pair, spreadPct, viable = false) {
  if (typeof spreadPct !== 'number' || !isFinite(spreadPct)) return;
  const { date, hour } = nowParts();
  const key = bucketKey(date, hour, pair);

  if (!_buckets.has(key)) {
    _buckets.set(key, { date, hour, pair, count: 0, sumSpread: 0, maxSpread: -Infinity, viableCount: 0 });
  }
  const b = _buckets.get(key);
  b.count++;
  b.sumSpread  += spreadPct;
  if (spreadPct > b.maxSpread) b.maxSpread = spreadPct;
  if (viable) b.viableCount++;
  _dirty.add(key);
}

// ─── Flush ────────────────────────────────────────────────────────────────

let _flushing = false;

async function flush() {
  if (!isMongoReady() || _flushing || _dirty.size === 0) return;
  _flushing = true;
  const toFlush = [..._dirty];
  _dirty.clear();
  try {
    const ops = toFlush.map(key => {
      const b = _buckets.get(key);
      if (!b) return null;
      return {
        updateOne: {
          filter: { date: b.date, hour: b.hour, pair: b.pair },
          update: {
            $set:  { date: b.date, hour: b.hour, pair: b.pair },
            $inc:  { count: b.count, sumSpread: b.sumSpread, viableCount: b.viableCount },
            $max:  { maxSpread: b.maxSpread },
          },
          upsert: true,
        },
      };
    }).filter(Boolean);

    if (ops.length) await HeatmapBucket.bulkWrite(ops, { ordered: false });

    // Reset in-memory counters post-flush (evita doble-count)
    toFlush.forEach(key => {
      const b = _buckets.get(key);
      if (b) { b.count = 0; b.sumSpread = 0; b.maxSpread = -Infinity; b.viableCount = 0; }
    });
  } catch (e) {
    // Non-fatal — re-add to dirty set for next flush
    toFlush.forEach(k => _dirty.add(k));
    _warn('[spreadHeatmap] flush error (non-fatal):', e.message);
  } finally {
    _flushing = false;
  }
}

// ─── Periodic flush ───────────────────────────────────────────────────────

let _interval = null;
function startPeriodicFlush(ms = 10 * 60 * 1000) {
  if (_interval) return;
  _interval = setInterval(() => flush().catch(() => {}), ms);
  _interval.unref?.();
}

// ─── Query ────────────────────────────────────────────────────────────────

/**
 * getHeatmap — retorna el heatmap de las últimas N días por par.
 *
 * Output: {
 *   pairs: ["Binance→OKX", ...],
 *   hours: 0..23,
 *   data: {
 *     "Binance→OKX": {
 *       0: { avgSpread, maxSpread, count, viableCount, viableRate },
 *       1: { ... },
 *       ...23
 *     }
 *   },
 *   bestHour: { pair, hour, avgSpread },   // the best historical combination
 *   totalObservations: N,
 * }
 */
async function getHeatmap(days = 7) {
  const result = {};

  if (isMongoReady()) {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const docs = await HeatmapBucket
        .find({ date: { $gte: cutoff.toISOString().slice(0, 10) } })
        .lean();

      for (const doc of docs) {
        if (!result[doc.pair]) result[doc.pair] = {};
        const h = result[doc.pair][doc.hour] || { count: 0, sumSpread: 0, maxSpread: 0, viableCount: 0 };
        h.count       += doc.count;
        h.sumSpread   += doc.sumSpread;
        if (doc.maxSpread > h.maxSpread) h.maxSpread = doc.maxSpread;
        h.viableCount += doc.viableCount;
        result[doc.pair][doc.hour] = h;
      }
    } catch (e) {
      _warn('[spreadHeatmap] getHeatmap query error:', e.message);
    }
  }

  // Append to in-memory bucket (current bucket not yet flushed)
  for (const [_key, b] of _buckets) {
    if (b.count === 0) continue;
    if (!result[b.pair]) result[b.pair] = {};
    const h = result[b.pair][b.hour] || { count: 0, sumSpread: 0, maxSpread: 0, viableCount: 0 };
    h.count       += b.count;
    h.sumSpread   += b.sumSpread;
    if (b.maxSpread > h.maxSpread) h.maxSpread = b.maxSpread;
    h.viableCount += b.viableCount;
    result[b.pair][b.hour] = h;
  }

  // Calcular avgSpread y viableRate
  const pairs = Object.keys(result);
  let bestHour = null;
  let totalObs = 0;

  for (const pair of pairs) {
    for (const hour of Object.keys(result[pair])) {
      const h = result[pair][hour];
      h.avgSpread  = h.count > 0 ? +(h.sumSpread / h.count).toFixed(4) : 0;
      h.viableRate = h.count > 0 ? +(h.viableCount / h.count * 100).toFixed(1) : 0;
      h.maxSpread  = +h.maxSpread.toFixed(4);
      totalObs    += h.count;

      if (!bestHour || h.avgSpread > bestHour.avgSpread) {
        bestHour = { pair, hour: parseInt(hour), avgSpread: h.avgSpread, viableRate: h.viableRate, count: h.count };
      }
    }
  }

  // Ordenar pares por volumen de observaciones
  pairs.sort((a, b) => {
    const countA = Object.values(result[a]).reduce((s, h) => s + h.count, 0);
    const countB = Object.values(result[b]).reduce((s, h) => s + h.count, 0);
    return countB - countA;
  });

  return { pairs, data: result, bestHour, totalObservations: totalObs, days };
}

/**
 * getHeatmapSimple — versión rápida para el panel de UI.
 * Retorna solo los pares con más datos y las horas peak.
 */
async function getHeatmapSimple() {
  const full = await getHeatmap(7);
  const topPairs = full.pairs.slice(0, 6);
  const simplified = {};
  for (const pair of topPairs) {
    simplified[pair] = Array.from({ length: 24 }, (_, h) => ({
      hour:       h,
      avgSpread:  full.data[pair]?.[h]?.avgSpread  ?? 0,
      maxSpread:  full.data[pair]?.[h]?.maxSpread  ?? 0,
      viableRate: full.data[pair]?.[h]?.viableRate ?? 0,
      count:      full.data[pair]?.[h]?.count      ?? 0,
    }));
  }
  return { pairs: topPairs, data: simplified, bestHour: full.bestHour, totalObservations: full.totalObservations };
}

module.exports = {
  record,
  flush,
  startPeriodicFlush,
  getHeatmap,
  getHeatmapSimple,
};

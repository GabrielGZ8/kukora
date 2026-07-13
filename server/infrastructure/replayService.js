/**
 * replayService.js — Kukora v1
 *
 * Mejora #1 del roadmap: "Replay histórico de oportunidades".
 *
 * Problema que resuelve: en una demo en vivo el mercado no siempre coopera —
 *  Este módulo persiste, para cada oportunidad VIABLE
 * detectada, un snapshot completo: el estado de los 5 order books (incluyendo
 * niveles L2 cuando están disponibles) + la oportunidad detectada + (si se
 * ejecutó) el trade resultante. Esto permite "reproducir" cualquier momento
 * de la sesión a voluntad, sin depender de que el mercado vuelva a cooperar.
 *
 * Arquitectura:
 *   - Buffer en memoria SIEMPRE disponible (rolling window, últimos N).
 *     Esto garantiza que el replay funcione incluso sin MongoDB conectado.
 *   - Persistencia opcional en MongoDB (colección `replays`) cuando está
 *     disponible, para que el historial sobreviva un restart/redeploy.
 *   - Snapshots NO son fabricados: cada uno es un evento real capturado del
 *     pipeline de detección en el momento exacto en que ocurrió.
 *
 * Throttling: no guardamos cada tick (eso sería ruido y crecería sin límite).
 * Guardamos cuando:
 *   (a) una oportunidad pasa de no-viable a viable para un par (transición), o
 *   (b) se ejecuta un trade real/sintético, o
 *   (c) el spread de una oportunidad viable mejora >10% sobre el último snapshot
 *       guardado para ese mismo par (para capturar "el mejor momento").
 */

const mongoose = require('mongoose');
const { logger } = require('./logger');

// Q2 (auditoría): consola limpia en producción
const _DEBUG = process.env.DEBUG_KUKORA === '1';
function _warn(...args) { if (_DEBUG) logger.warn('replayService', String(args[0]), args.length > 1 ? { extra: args.slice(1) } : undefined); }
const MAX_MEMORY_REPLAYS = 200;         // rolling in-memory buffer size
const _memoryReplays = []; // rolling buffer, most recent last

// Bug real encontrado en auditoría post-Checkpoint 27: los IDs "mem-N" se
// derivaban de la POSICIÓN del snapshot en _memoryReplays (mem-${length-i}),
// y getReplayById() intentaba invertir esa fórmula recalculando la posición
// con el length ACTUAL del buffer. Dos problemas independientes:
//   1. La fórmula inversa estaba mal (índice quedaba espejado: pedías el
//      snapshot más reciente y te devolvía el más viejo, y viceversa).
//   2. Aunque la fórmula hubiera estado bien, un ID es un string que un
//      cliente puede guardar/clickear más tarde — para entonces el buffer
//      pudo haber rotado (shift() al pasar de MAX_MEMORY_REPLAYS), corriendo
//      todas las posiciones y volviendo cualquier ID previamente emitido
//      inválido o apuntando a un snapshot distinto.
// Fix: cada snapshot recibe un número de secuencia ESTABLE al crearse
// (nunca cambia mientras el snapshot exista en el buffer), y el ID se
// deriva de ese número, no de la posición. getReplayById() busca por ese
// número en vez de recalcular una posición.
let _seq = 0;

// Track per-pair last-saved state to decide whether a new snapshot is worth keeping.
const _lastSavedByPair = new Map(); // key: "Buy-Sell" -> { wasViable, spreadPct, ts }

// Audit fix 1.3: schema moved to server/models/ReplaySnapshot.js.
const ReplaySnapshot = require('./persistence/models/ReplaySnapshot');

/**
 * Lightweight order book snapshot: bid/ask/spread plus top-5 L2 levels when
 * available (depth comes from exchangeService's in-memory depth cache, so we
 * accept it as a param rather than re-fetching here).
 */
function buildBookSnapshot(orderBooks, depthByExchange) {
  return orderBooks.map(ob => ({
    exchange:  ob.exchange,
    bid:       ob.bid,
    ask:       ob.ask,
    spreadPct: ob.spreadPct,
    source:    ob.source,
    latencyMs: ob.latencyMs,
    error:     ob.error || null,
    depth: depthByExchange?.[ob.exchange]
      ? {
          bids: (depthByExchange[ob.exchange].bids || []).slice(0, 5),
          asks: (depthByExchange[ob.exchange].asks || []).slice(0, 5),
        }
      : null,
  }));
}

function shouldCapture(op, reason) {
  if (reason === 'trade_executed') return true;
  const key = `${op.buyExchange}-${op.sellExchange}`;
  const last = _lastSavedByPair.get(key);
  if (!last) return true; // first time we see this pair as viable
  if (!last.wasViable && op.viable) return true; // transition non-viable -> viable
  if (op.viable && last.wasViable) {
    // Only re-capture if spread improved meaningfully (avoid saving every tick)
    const improvement = (op.spreadPct - last.spreadPct) / Math.max(0.0001, Math.abs(last.spreadPct));
    if (improvement > 0.10) return true;
  }
  return false;
}

function markSeen(op) {
  const key = `${op.buyExchange}-${op.sellExchange}`;
  _lastSavedByPair.set(key, { wasViable: op.viable, spreadPct: op.spreadPct, ts: Date.now() });
}

/**
 * Main entry point — call this after detectOpportunities() on every tick
 * (event-driven or polling loop) with the full opportunities array.
 * Captures snapshots selectively per the rules in shouldCapture().
 */
async function captureIfNoteworthy(opportunities, orderBooks, depthByExchange, executedTrade) {
  if (!opportunities || !opportunities.length) return;

  // If a trade was executed this tick, always capture that exact moment,
  // tagged to the specific opportunity that produced it.
  if (executedTrade) {
    const matchingOp = opportunities.find(o =>
      o.buyExchange === executedTrade.buyExchange && o.sellExchange === executedTrade.sellExchange
    ) || opportunities[0];
    await saveSnapshot(matchingOp, orderBooks, depthByExchange, 'trade_executed', executedTrade);
  }

  for (const op of opportunities) {
    if (!op.viable) { markSeen(op); continue; }
    const reason = !_lastSavedByPair.get(`${op.buyExchange}-${op.sellExchange}`)?.wasViable
      ? 'transition_to_viable'
      : 'spread_improved';
    if (shouldCapture(op, reason)) {
      await saveSnapshot(op, orderBooks, depthByExchange, reason, null);
    }
    markSeen(op);
  }
}

async function saveSnapshot(op, orderBooks, depthByExchange, reason, executedTrade) {
  const snapshot = {
    _seq:           ++_seq,
    ts:             new Date(),
    reason,
    pair:           `${op.buyExchange}→${op.sellExchange}`,
    orderBooks:     buildBookSnapshot(orderBooks, depthByExchange),
    opportunity:    op,
    executedTrade:  executedTrade || null,
    detectionLatencyMs: op.detectionLatencyMs || 0,
  };

  _memoryReplays.push(snapshot);
  if (_memoryReplays.length > MAX_MEMORY_REPLAYS) _memoryReplays.shift();

  if (mongoose.connection.readyState === 1) {
    try {
      await ReplaySnapshot.create(snapshot);
    } catch (e) {
      _warn('[replayService] MongoDB save failed (non-fatal, kept in memory):', e.message);
    }
  }
}

/** List available replay snapshots (most recent first), with light fields only. */
async function listReplays(limit = 50) {
  if (mongoose.connection.readyState === 1) {
    try {
      const docs = await ReplaySnapshot.find()
        .sort({ ts: -1 })
        .limit(limit)
        .select('ts reason pair opportunity.netProfit opportunity.spreadPct opportunity.score executedTrade detectionLatencyMs')
        .lean();
      if (docs.length) {
        return docs.map(d => ({
          id:                 d._id.toString(),
          ts:                 d.ts,
          reason:             d.reason,
          pair:               d.pair,
          netProfit:          d.opportunity?.netProfit ?? null,
          spreadPct:          d.opportunity?.spreadPct ?? null,
          score:              d.opportunity?.score ?? null,
          executed:           !!d.executedTrade,
          detectionLatencyMs: d.detectionLatencyMs || 0,
        }));
      }
    } catch (e) {
      _warn('[replayService] MongoDB list failed, falling back to memory:', e.message);
    }
  }
  // Memory fallback (or Mongo connected but empty so far)
  return _memoryReplays.slice(-limit).reverse().map((s) => ({
    id:                 `mem-${s._seq}`,
    ts:                 s.ts,
    reason:             s.reason,
    pair:               s.pair,
    netProfit:          s.opportunity?.netProfit ?? null,
    spreadPct:          s.opportunity?.spreadPct ?? null,
    score:              s.opportunity?.score ?? null,
    executed:           !!s.executedTrade,
    detectionLatencyMs: s.detectionLatencyMs || 0,
  }));
}

/** Fetch the full snapshot (with order books) for a given id. */
async function getReplayById(id) {
  if (id.startsWith('mem-')) {
    const seq = parseInt(id.slice(4), 10);
    return _memoryReplays.find(s => s._seq === seq) || null;
  }
  if (mongoose.connection.readyState === 1) {
    try {
      const doc = await ReplaySnapshot.findById(id).lean();
      return doc;
    } catch (e) {
      _warn('[replayService] getReplayById failed:', e.message);
      return null;
    }
  }
  return null;
}

/** Returns the single best (highest netProfit) snapshot in the buffer — used by "Replay best moment today". */
async function getBestReplay() {
  if (mongoose.connection.readyState === 1) {
    try {
      const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
      const doc = await ReplaySnapshot.find({ ts: { $gte: startOfDay } })
        .sort({ 'opportunity.netProfit': -1 })
        .limit(1)
        .lean();
      if (doc.length) return doc[0];
    } catch (e) {
      _warn('[replayService] getBestReplay failed:', e.message);
    }
  }
  if (!_memoryReplays.length) return null;
  return _memoryReplays.reduce((best, s) =>
    (!best || (s.opportunity?.netProfit || -Infinity) > (best.opportunity?.netProfit || -Infinity)) ? s : best
  , null);
}

function resetReplays() {
  _memoryReplays.length = 0;
  _lastSavedByPair.clear();
  _seq = 0;
}

module.exports = {
  captureIfNoteworthy,
  listReplays,
  getReplayById,
  getBestReplay,
  resetReplays,
};

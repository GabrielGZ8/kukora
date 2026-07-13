/**
 * persistenceService.js — Kukora v10
 *
 * PROBLEMA: cuando Railway reinicia el servidor (deploy, crash, idle timeout),
 * todo el estado en memoria desaparece: equity curve, trade history, lifecycle
 * data, stat-arb EWMA state. 
 *
 * SOLUCIÓN: flush periódico a MongoDB de las series críticas, con restauración
 * automática al arrancar. Diseñado para ser completamente transparente —
 * si MongoDB no está disponible, el sistema sigue funcionando exactamente
 * igual que antes (degradación graceful a memoria pura).
 *
 * Qué se persiste:
 *   - equity_curve    : puntos de la curva de equity (timestamp + valor)
 *   - trade_history   : todos los trades ejecutados en la sesión
 *   - session_meta    : stats de sesión (totalTrades, bestSpread, etc.)
 *
 * Lo que NO se persiste (por diseño):
 *   - Order books en vivo  : siempre frescos del WS
 *   - Stat-arb EWMA state  : se reconstruye en ~30 ticks (<5s con datos reales)
 *   - Replay snapshots     : replayService ya tiene su propio Mongo schema
 */

'use strict';

const mongoose = require('mongoose');
const { logger } = require('./logger');

// Test-only seam (see M-5 follow-up, Sesión 7): root-caused the 2 skipped
// tests in tests/persistenceService.test.js. It was NOT an async timing
// window as originally suspected — in this project's Vitest setup, this
// module's internal CJS `require('mongoose')` and a test file's top-level
// ESM `import mongoose from 'mongoose'` resolve to two *different* mocked
// module instances (confirmed by an object-identity check), so mutating
// `connection.readyState` on one is invisible to the other. Reads of
// readyState go through `_readyState()` below so a test can point this
// module at the exact same mocked instance the test file controls,
// instead of depending on both resolving to one shared singleton.
let _mongooseRef = mongoose;
function _readyState() { return _mongooseRef.connection.readyState; }
function _setMongooseForTests(m) { _mongooseRef = m; }
function _resetMongooseForTests() { _mongooseRef = mongoose; }

// Q2 (auditoría): logs verbose silenciados en producción — solo se imprimen
// con DEBUG_KUKORA=1 en el .env. Ver arbitrage.routes.js para el mismo patrón.
const _DEBUG = process.env.DEBUG_KUKORA === '1';
function _log(...args)  { if (_DEBUG) logger.debug('persistenceService', String(args[0]), args.length > 1 ? { extra: args.slice(1) } : undefined); }
function _warn(...args) { if (_DEBUG) logger.warn('persistenceService', String(args[0]), args.length > 1 ? { extra: args.slice(1) } : undefined); }


// ─── Schemas ───────────────────────────────────────────────────────────────

// Audit fix 1.3: schema moved to server/models/SessionDoc.js.
const SessionDoc = require('./persistence/models/SessionDoc');

// ─── Session ID ────────────────────────────────────────────────────────────
// A session is identified by the day (YYYY-MM-DD) so data from the same
// deployment day is grouped. On reset, the session ID advances to force
// a clean slate (old data is retained for historical queries but not loaded).
let _sessionId = `kukora-${new Date().toISOString().slice(0, 10)}`;
let _flushing  = false;

function currentSessionId() { return _sessionId; }
function advanceSession() {
  _sessionId = `kukora-${new Date().toISOString().slice(0, 10)}-reset-${Date.now()}`;
}

// ─── Write operations ──────────────────────────────────────────────────────

// M-5 fix: persistTrade()/persistEquityPoint() call sites in
// arbitrageOrchestrator.js used `.catch(() => {})` with zero retry — if
// MongoDB was down for even a few seconds during a trade (a deploy, a
// brief network blip, a replica-set failover), that trade's persisted
// audit copy was gone forever, silently, with no way to know it happened.
// This module is explicitly designed to degrade to memory-only when Mongo
// is unavailable (see file header — the in-memory wallet/trade-history
// state is the real source of truth, this is a secondary audit/replay
// copy) — so a full disk-backed write-ahead log would be a bigger,
// separate architectural decision. What we can and should do cheaply: keep
// failed writes in a bounded in-memory queue and retry them on a periodic
// flush, so a brief Mongo blip self-heals instead of silently losing data,
// and give up loudly (logger.error, always-on) instead of silently after
// a bounded number of attempts for a sustained outage.
const MAX_RETRY_QUEUE_SIZE = 500;   // bounded — matches "graceful degradation", not "infinite buffer"
const MAX_RETRY_ATTEMPTS   = 10;
let _retryQueue = []; // [{ type: 'trade'|'equity_point', payload, attempts, queuedAt, sessionId }]

function _mongoConfigured() { return !!process.env.MONGODB_URI; }

function _enqueueRetry(type, payload) {
  // If MongoDB was never configured, this is intentional in-memory-only
  // mode (a supported state — see healthService.js/L-2), not an outage.
  // Queuing here would just churn the queue forever with nothing to flush.
  if (!_mongoConfigured()) return;

  if (_retryQueue.length >= MAX_RETRY_QUEUE_SIZE) {
    const dropped = _retryQueue.shift(); // drop oldest — keep the queue bounded
    logger.error('persistenceService', 'Retry queue full — dropping oldest queued write (data lost)', {
      droppedType: dropped.type, queueSize: _retryQueue.length,
    });
  }
  // AUDIT FINDING 6 fix (MEDIUM): capture the session this item actually
  // belongs to *now*, at enqueue time — not later, at flush time. Before
  // this fix, _writeQueuedItem() read the live `_sessionId` module variable
  // when it finally wrote the item, so a trade queued during a Mongo outage
  // could silently get archived under a *different* (later) session if
  // advanceSession() (manual bot reset) happened to run in between. Low
  // probability (needs an outage window to overlap a manual reset), but a
  // silent corruption of session-scoped audit trail when it does happen —
  // exactly the kind of detail an institutional auditor would test for.
  _retryQueue.push({ type, payload, attempts: 0, queuedAt: Date.now(), sessionId: _sessionId });
}

async function _writeQueuedItem(item) {
  // Fall back to the live _sessionId only for items queued before this fix
  // shipped (already-serialized queue state without a sessionId field) —
  // every new item always carries its own captured value.
  const sessionId = item.sessionId || _sessionId;
  if (item.type === 'equity_point') {
    await SessionDoc.create({ sessionId, type: 'equity_point', ts: new Date(item.payload.ts), data: item.payload });
  } else if (item.type === 'trade') {
    await SessionDoc.create({ sessionId, type: 'trade', ts: new Date(item.payload.ts || Date.now()), data: item.payload });
  }
}

async function persistEquityPoint(point) {
  if (_readyState() !== 1) { _enqueueRetry('equity_point', point); return; }
  try {
    await SessionDoc.create({ sessionId: _sessionId, type: 'equity_point', ts: new Date(point.ts), data: point });
  } catch (e) {
    _warn('persistEquityPoint failed, queuing for retry:', e.message);
    _enqueueRetry('equity_point', point);
  }
}

async function persistTrade(trade) {
  if (_readyState() !== 1) { _enqueueRetry('trade', trade); return; }
  try {
    await SessionDoc.create({ sessionId: _sessionId, type: 'trade', ts: new Date(trade.ts || Date.now()), data: trade });
  } catch (e) {
    _warn('persistTrade failed, queuing for retry:', e.message);
    _enqueueRetry('trade', trade);
  }
}

async function persistSessionMeta(meta) {
  if (_readyState() !== 1) return;
  try {
    await SessionDoc.findOneAndUpdate(
      { sessionId: _sessionId, type: 'session_meta' },
      { $set: { data: meta, ts: new Date() } },
      { upsert: true }
    );
  } catch (e) { /* non-fatal */ }
}

// ─── Read / restore ────────────────────────────────────────────────────────

/**
 * Restore equity curve and trade history from MongoDB at startup.
 * Returns { equityCurve, trades } or null if MongoDB is unavailable.
 */
async function restoreSession() {
  if (_readyState() !== 1) return null;
  try {
    const today = new Date().toISOString().slice(0, 10);
    // Find the most recent session from today (handles resets within the day)
    const meta = await SessionDoc
      .findOne({ type: 'session_meta', sessionId: { $regex: `^kukora-${today}` } })
      .sort({ ts: -1 }).lean();

    if (!meta) return null;

    const sid = meta.sessionId;
    _sessionId = sid; // Resume the same session

    const [equityDocs, tradeDocs] = await Promise.all([
      SessionDoc.find({ sessionId: sid, type: 'equity_point' }).sort({ ts: 1 }).lean(),
      SessionDoc.find({ sessionId: sid, type: 'trade' }).sort({ ts: 1 }).lean(),
    ]);

    const equityCurve = equityDocs.map(d => d.data);
    const trades      = tradeDocs.map(d => d.data);

    if (equityCurve.length || trades.length) {
      _log(`◈ Session restored from MongoDB: ${equityCurve.length} equity points, ${trades.length} trades (session: ${sid})`);
    }

    return { equityCurve, trades, sessionId: sid };
  } catch (e) {
    _warn('[persistenceService] restore failed (non-fatal):', e.message);
    return null;
  }
}

// ─── Periodic flush of session meta ────────────────────────────────────────
// Flush session meta (non-critical stats) every 60s so the session remains
// discoverable even if the server crashes before a clean shutdown.
let _flushInterval = null;

function startPeriodicFlush(getMetaFn, intervalMs = 60_000) {
  if (_flushInterval) return; // already started
  _flushInterval = setInterval(async () => {
    if (_flushing || _readyState() !== 1) return;
    _flushing = true;
    try {
      const meta = getMetaFn();
      if (meta) await persistSessionMeta(meta);
    } catch { /* non-fatal */ }
    finally { _flushing = false; }
  }, intervalMs);
  _flushInterval.unref?.();
}

function stopPeriodicFlush() {
  if (_flushInterval) { clearInterval(_flushInterval); _flushInterval = null; }
}

// ─── M-5: retry-queue flush ────────────────────────────────────────────────
let _retryFlushInterval = null;

async function _flushRetryQueue() {
  if (_readyState() !== 1 || _retryQueue.length === 0) return;
  // Snapshot-and-clear so writes that fail again during this pass re-queue
  // cleanly (via the push below) instead of racing with concurrent enqueues
  // from persistTrade()/persistEquityPoint() calls that happen mid-flush.
  const batch = _retryQueue;
  _retryQueue = [];
  for (const item of batch) {
    try {
      await _writeQueuedItem(item);
    } catch (e) {
      item.attempts += 1;
      if (item.attempts < MAX_RETRY_ATTEMPTS) {
        _retryQueue.push(item);
      } else {
        logger.error('persistenceService', 'Dropping queued write after max retry attempts (data lost)', {
          type: item.type, attempts: item.attempts, queuedAgoMs: Date.now() - item.queuedAt, err: e.message,
        });
      }
    }
  }
}

function startPersistenceRetryFlush(intervalMs = 15_000) {
  if (_retryFlushInterval) return; // already started
  _retryFlushInterval = setInterval(() => { _flushRetryQueue().catch(() => {}); }, intervalMs);
  _retryFlushInterval.unref?.();
  _log(`Persistence retry-queue flush started (every ${intervalMs / 1000}s)`);
}

function stopPersistenceRetryFlush() {
  if (_retryFlushInterval) { clearInterval(_retryFlushInterval); _retryFlushInterval = null; }
}

// Test-only helpers — mirror the _resetForTests() convention used elsewhere
// in this codebase (see arbitrageOrchestrator.js's M-1 fix).
function _getRetryQueueSizeForTests() { return _retryQueue.length; }
function _resetRetryQueueForTests()   { _retryQueue = []; }

// ─── EngineSnapshot — structured per-user, per-day critical state ─────────
// Complements the legacy session/equity persistence above with a richer,
// per-user snapshot (equity curve + dailyPnl + totalTrades + trade log).
// Falls back silently if MongoDB is unavailable.

let _EngineSnapshot;
function _getEngineSnapshotModel() {
  if (!_EngineSnapshot) {
    try { _EngineSnapshot = require('../models').EngineSnapshot; } catch { /* unavailable */ }
  }
  return _EngineSnapshot;
}
// Test-only seam (punto 7, mismo patrón que _resetPendingExecutionModelForTests):
// permite inyectar un modelo fake para verificar persistEngineSnapshot/
// restoreEngineSnapshot sin depender de que el `require('../models')` del
// test resuelva la misma instancia mockeada de mongoose que usa este módulo
// (CJS require vs ESM import del mock pueden divergir — ver _setMongooseForTests).
function _setEngineSnapshotModelForTests(m) { _EngineSnapshot = m; }
function _resetEngineSnapshotModelForTests() { _EngineSnapshot = undefined; }

/**
 * Persist a critical engine snapshot. Upserts per userId+date.
 * @param {object} snapshot - { equityCurve, dailyPnl, totalTrades, tradeLog, counters, wallets }
 * @param {string} userId
 */
async function persistEngineSnapshot(snapshot, userId = 'default') {
  if (_readyState() !== 1) return;
  const Model = _getEngineSnapshotModel();
  if (!Model) return;
  try {
    const date = new Date().toISOString().slice(0, 10);
    // Punto 7: `wallets` es opcional en el input — callers que todavía no
    // pasan balances (o los pasan como `undefined`) no deben pisar un
    // valor previamente persistido con `null`. Solo se incluye en el
    // `$set` si el caller efectivamente lo proveyó.
    const set = {
      equityCurve: (snapshot.equityCurve || []).slice(-500),
      dailyPnl:    snapshot.dailyPnl    || 0,
      totalTrades: snapshot.totalTrades || 0,
      tradeLog:    (snapshot.tradeLog   || []).slice(-200),
      counters:    snapshot.counters    || {},
      updatedAt:   new Date(),
    };
    if (snapshot.wallets !== undefined) set.wallets = snapshot.wallets;
    await Model.findOneAndUpdate(
      { userId, date },
      { $set: set },
      { upsert: true, new: true }
    );
  } catch (e) { _warn('[persistenceService] persistEngineSnapshot failed (non-fatal):', e.message); }
}

/**
 * Restore today's engine snapshot for a user.
 * @param {string} userId
 */
async function restoreEngineSnapshot(userId = 'default') {
  if (_readyState() !== 1) return null;
  const Model = _getEngineSnapshotModel();
  if (!Model) return null;
  try {
    const date = new Date().toISOString().slice(0, 10);
    const snap = await Model.findOne({ userId, date }).lean();
    if (!snap) return null;
    _log(`Engine snapshot restored for user=${userId} date=${date}: ${snap.equityCurve?.length || 0} equity pts, dailyPnl=${snap.dailyPnl}`);
    return {
      equityCurve: snap.equityCurve || [],
      dailyPnl:    snap.dailyPnl    || 0,
      totalTrades: snap.totalTrades || 0,
      tradeLog:    snap.tradeLog    || [],
      counters:    snap.counters    || {},
      wallets:     snap.wallets     || null,
    };
  } catch (e) {
    _warn('[persistenceService] restoreEngineSnapshot failed (non-fatal):', e.message);
    return null;
  }
}

let _snapshotInterval = null;

/**
 * Start periodic engine snapshot flush.
 * @param {function} getSnapshotFn - returns { equityCurve, dailyPnl, totalTrades, tradeLog, counters }
 * @param {string}   userId
 * @param {number}   intervalMs
 */
function startEngineSnapshotFlush(getSnapshotFn, userId = 'default', intervalMs = 30_000) {
  if (_snapshotInterval) clearInterval(_snapshotInterval);
  _snapshotInterval = setInterval(async () => {
    if (_readyState() !== 1) return;
    try {
      const snap = getSnapshotFn();
      if (snap) await persistEngineSnapshot(snap, userId);
    } catch (e) { _warn('[persistenceService] engine snapshot flush error (non-fatal):', e.message); }
  }, intervalMs);
  _snapshotInterval.unref?.();
  _log(`Engine snapshot flush started (every ${intervalMs / 1000}s, userId=${userId})`);
}

function stopEngineSnapshotFlush() {
  if (_snapshotInterval) { clearInterval(_snapshotInterval); _snapshotInterval = null; }
}

// ─── Pending Execution — crash recovery for in-flight cross-exchange trades
// (auditoría comité, Sesión 34, P1 #2). Ver el comentario extenso en
// server/models.js sobre `PendingExecutionSchema` para el porqué completo.
// Estas tres funciones son deliberadamente simples y sin retry queue (a
// diferencia de persistTrade/persistEquityPoint): un marcador de "ejecución
// en curso" que falla en escribirse no debe bloquear ni retrasar la
// ejecución real — en el peor caso, si Mongo está caído justo cuando se
// coloca una pata, se pierde la capacidad de detectar esa caída específica
// al reiniciar, pero el trade en sí sigue su curso normal. Igual que el
// resto del módulo, cualquier fallo de escritura/lectura se traga
// silenciosamente (non-fatal) — este marcador es una red de seguridad
// adicional, no una fuente de verdad de la que dependa la ejecución.
let _PendingExecution;
function _getPendingExecutionModel() {
  if (!_PendingExecution) {
    try { _PendingExecution = require('../models').PendingExecution; } catch { /* unavailable */ }
  }
  return _PendingExecution;
}
// Test-only seam: fuerza a que la próxima llamada vuelva a resolver el
// modelo vía require('../models') en vez de reusar la referencia cacheada
// de un test anterior (mismo patrón que _setMongooseForTests/_resetMongooseForTests).
function _resetPendingExecutionModelForTests() { _PendingExecution = undefined; }

/**
 * Marca una ejecución cross-exchange como "en curso" ANTES de colocar
 * cualquier pata. Debe llamarse siempre seguida — sin importar el
 * desenlace — de `resolvePendingExecution(tradeId)` (ver el try/finally en
 * liveExecution.js).
 * @param {object} entry - { tradeId, userId, buyExchange, sellExchange, symbol, amount, opportunityId }
 */
async function markPendingExecution(entry) {
  if (_readyState() !== 1) return;
  const Model = _getPendingExecutionModel();
  if (!Model) return;
  try {
    await Model.create({
      tradeId:       entry.tradeId,
      userId:        entry.userId,
      buyExchange:   entry.buyExchange,
      sellExchange:  entry.sellExchange,
      symbol:        entry.symbol,
      amount:        entry.amount,
      opportunityId: entry.opportunityId,
    });
  } catch (e) { _warn('[persistenceService] markPendingExecution failed (non-fatal):', e.message); }
}

/**
 * Resuelve (borra) el marcador de una ejecución que ya terminó — éxito,
 * hedge parcial, o emergency-flatten. Si esto nunca se llama porque el
 * proceso murió a mitad de camino, el documento queda huérfano a
 * propósito: es la señal que `listUnresolvedPendingExecutions()` necesita.
 * @param {string} tradeId
 */
async function resolvePendingExecution(tradeId) {
  if (_readyState() !== 1) return;
  const Model = _getPendingExecutionModel();
  if (!Model) return;
  try { await Model.deleteOne({ tradeId }); }
  catch (e) { _warn('[persistenceService] resolvePendingExecution failed (non-fatal):', e.message); }
}

/**
 * Lista todos los marcadores de ejecución sin resolver — evidencia directa
 * de que el proceso murió a mitad de una ejecución cross-exchange en la
 * sesión anterior. Llamado al arrancar (ver `checkPendingExecutionsOnBoot`
 * en server/index.js) para loggear una alerta crítica de revisión manual.
 * @returns {Promise<Array>} siempre un array (nunca null), incluso sin DB.
 */
async function listUnresolvedPendingExecutions() {
  if (_readyState() !== 1) return [];
  const Model = _getPendingExecutionModel();
  if (!Model) return [];
  try { return await Model.find({}).lean(); }
  catch (e) {
    _warn('[persistenceService] listUnresolvedPendingExecutions failed (non-fatal):', e.message);
    return [];
  }
}

module.exports = {
  currentSessionId,
  advanceSession,
  persistEquityPoint,
  persistTrade,
  persistSessionMeta,
  restoreSession,
  startPeriodicFlush,
  stopPeriodicFlush,
  persistEngineSnapshot,
  restoreEngineSnapshot,
  startEngineSnapshotFlush,
  stopEngineSnapshotFlush,
  // P1 #2: crash-recovery marker for in-flight cross-exchange trades.
  markPendingExecution,
  resolvePendingExecution,
  listUnresolvedPendingExecutions,
  _resetPendingExecutionModelForTests,
  // M-5: retry queue for failed trade/equity writes.
  startPersistenceRetryFlush,
  stopPersistenceRetryFlush,
  // C-4: one forced pass over the retry queue during graceful shutdown, so
  // trades/equity points queued right before SIGTERM get one last chance to
  // write instead of being silently dropped when the process exits.
  flushRetryQueueNow: _flushRetryQueue,
  _getRetryQueueSizeForTests,
  _resetRetryQueueForTests,
  _flushRetryQueueForTests: _flushRetryQueue,
  // Test-only seam so a test's own mocked `mongoose` instance (its ESM
  // `import`) can be pointed at directly, instead of relying on it
  // matching this module's internal CJS `require('mongoose')` by
  // coincidence — see the comment above `_readyState()` for why that
  // doesn't hold in this project's Vitest setup.
  _setMongooseForTests,
  _resetMongooseForTests,
  _setEngineSnapshotModelForTests,
  _resetEngineSnapshotModelForTests,
};

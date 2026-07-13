/**
 * eventStore.js — Kukora Partial Event Sourcing (trade lifecycle)
 *
 * Scope, deliberately partial (per the "no sobreingeniería" brief — full
 * event sourcing/CQRS is explicitly out of scope): this does NOT replace
 * Kukora's existing state model (walletManager balances, tradeStateMachine
 * current-state, MongoDB trade documents). Those remain the source of
 * truth for "what is true right now" and nothing here changes how they're
 * read or written.
 *
 * What this adds: every trade lifecycle transition is *also* appended,
 * immutably, to a per-trade event log — `requested → filled/partial/
 * rejected/failed → settled`. That log is what a real trading system's
 * compliance/audit function actually wants: not just the current state of
 * a trade, but the exact sequence of what happened to it and when, with
 * nothing overwritten or lost. Two concrete capabilities fall out of this
 * for free:
 *
 *   1. `projectTradeState(tradeId)` rebuilds a trade's state purely by
 *      folding its events — usable as a consistency check against
 *      whatever the "live" model says the state is (drift between the two
 *      is itself a bug signal worth alerting on).
 *   2. `replayTrade(tradeId)` returns the full timeline for support/
 *      incident review — "show me exactly what happened to trade X".
 *
 * Storage: append-only in-memory ring buffer (always available, same
 * pattern as replayService.js's _memoryReplays) + optional MongoDB
 * persistence (collection `trade_events`) when connected, so history
 * survives a restart. Never mutates or deletes past events — corrections
 * are new events, not edits (the actual definition of event sourcing).
 */

'use strict';

const mongoose = require('mongoose');
const obs = require('./observabilityService');

const MAX_MEMORY_EVENTS = 5000;
const _memoryEvents = []; // append-only, chronological

// Valid transitions — not enforced as a hard gate (a real exchange can
// surprise you), but unknown transitions are flagged in observability
// rather than silently accepted, same philosophy as recordRejection's RCA.
const KNOWN_EVENT_TYPES = new Set([
  'trade.requested', 'trade.filled', 'trade.partial_filled',
  'trade.rejected', 'trade.failed', 'trade.settled', 'trade.reconciled',
]);

let TradeEventDoc = null;
function _model() {
  if (TradeEventDoc) return TradeEventDoc;
  const schema = new mongoose.Schema({
    tradeId:  { type: String, required: true, index: true },
    type:     { type: String, required: true },
    ts:       { type: Date, required: true, default: Date.now },
    payload:  { type: mongoose.Schema.Types.Mixed, default: {} },
    seq:      { type: Number, required: true }, // per-trade sequence number, guarantees ordering even if ts collides
  }, { collection: 'trade_events' });
  schema.index({ tradeId: 1, seq: 1 }, { unique: true });
  TradeEventDoc = mongoose.models.TradeEventDoc || mongoose.model('TradeEventDoc', schema);
  return TradeEventDoc;
}

function _isMongoReady() {
  return mongoose.connection.readyState === 1;
}

const _seqByTrade = new Map();
function _nextSeq(tradeId) {
  const seq = (_seqByTrade.get(tradeId) || 0) + 1;
  _seqByTrade.set(tradeId, seq);
  return seq;
}

/**
 * Append an immutable event for a trade. Fire-and-forget on the Mongo side
 * — event sourcing must never become the reason a trade fails to execute,
 * so persistence failures are logged, not thrown.
 *
 * @param {string} tradeId
 * @param {string} type     one of KNOWN_EVENT_TYPES (unknown types are allowed but flagged)
 * @param {object} payload  event-specific data (fill amount, price, reason, etc.)
 */
function appendEvent(tradeId, type, payload = {}) {
  if (!tradeId) throw new Error('eventStore.appendEvent: tradeId is required');
  if (!KNOWN_EVENT_TYPES.has(type)) {
    obs.emit('SYSTEM', 'eventStore.unknownEventType', { tradeId, type }, 'warn');
  }

  const event = { tradeId, type, ts: new Date().toISOString(), payload, seq: _nextSeq(tradeId) };

  _memoryEvents.push(event);
  if (_memoryEvents.length > MAX_MEMORY_EVENTS) _memoryEvents.shift();

  if (_isMongoReady()) {
    _model().create({ ...event, ts: new Date(event.ts) }).catch((err) => {
      obs.emit('SYSTEM', 'eventStore.persistFailed', { tradeId, type, error: err.message }, 'warn');
    });
  }

  obs.emit('EXECUTION', 'eventStore.appended', { tradeId, type, seq: event.seq }, 'debug');
  return event;
}

/** All events for a trade, in order, from memory (fast path — covers the current session). */
function getEventsForTrade(tradeId) {
  return _memoryEvents.filter((e) => e.tradeId === tradeId).sort((a, b) => a.seq - b.seq);
}

/** Same as getEventsForTrade but falls back to Mongo for trades outside the in-memory window. */
async function getEventsForTradeAsync(tradeId) {
  const inMemory = getEventsForTrade(tradeId);
  if (inMemory.length > 0 || !_isMongoReady()) return inMemory;
  const docs = await _model().find({ tradeId }).sort({ seq: 1 }).lean();
  return docs.map(({ _id, __v, ...rest }) => ({ ...rest, ts: rest.ts.toISOString() }));
}

/**
 * Fold a trade's event log into a single current-state projection.
 * This is the "rebuild state from events" primitive that makes the log
 * more than a passive audit trail — it's a second, independent way to
 * arrive at "what is the state of trade X", useful as a consistency check
 * against the live model.
 */
function projectTradeState(tradeId) {
  const events = getEventsForTrade(tradeId);
  if (events.length === 0) return null;

  const state = {
    tradeId,
    status: 'unknown',
    filledAmount: 0,
    requestedAmount: null,
    history: events.map((e) => ({ type: e.type, ts: e.ts })),
  };

  for (const event of events) {
    switch (event.type) {
      case 'trade.requested':
        state.status = 'requested';
        state.requestedAmount = event.payload.amount ?? state.requestedAmount;
        break;
      case 'trade.filled':
        state.status = 'filled';
        state.filledAmount = event.payload.amount ?? state.requestedAmount ?? state.filledAmount;
        break;
      case 'trade.partial_filled':
        state.status = 'partial_filled';
        state.filledAmount += event.payload.amount ?? 0;
        break;
      case 'trade.rejected':
        state.status = 'rejected';
        state.reason = event.payload.reason;
        break;
      case 'trade.failed':
        state.status = 'failed';
        state.reason = event.payload.reason;
        break;
      case 'trade.settled':
        state.status = 'settled';
        break;
      case 'trade.reconciled':
        state.status = 'reconciled';
        state.reconciliation = event.payload;
        break;
      default:
        // Unknown event types don't change status but are kept in history.
        break;
    }
  }
  return state;
}

/** Full replay payload for support/incident review — the timeline plus the folded final state. */
function replayTrade(tradeId) {
  const events = getEventsForTrade(tradeId);
  return { tradeId, events, projectedState: projectTradeState(tradeId) };
}

/** Recent events across all trades — used by the operational dashboard. */
function getRecentEvents(limit = 100) {
  return _memoryEvents.slice(-limit).reverse();
}

function _resetForTests() {
  _memoryEvents.length = 0;
  _seqByTrade.clear();
}

module.exports = {
  KNOWN_EVENT_TYPES,
  appendEvent,
  getEventsForTrade,
  getEventsForTradeAsync,
  projectTradeState,
  replayTrade,
  getRecentEvents,
  _resetForTests,
};

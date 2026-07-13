'use strict';
/**
 * opportunitySnapshotStore.js — Kukora
 *
 * Fixes AUDIT FINDING 1 (CRITICAL, carried over from the prior audit
 * session): `POST /api/trading/execute/cross` (and `/api/trading/execute`)
 * received the full `opportunity` object from the client and every layer of
 * protection meant to guard real money read its numbers directly from that
 * payload:
 *
 *   - preflightCheck()          → staleness gate reads opportunity.detectedAt
 *   - _runInstitutionalRiskGate → capital/risk math reads opportunity.buyPrice
 *                                  / opportunity.slippagePct
 *   - _placeAndConfirm()        → the IOC "protected" order's price limit is
 *                                  computed from opportunity.buyPrice/sellPrice
 *
 * None of those three ever re-checked the numbers against the detection
 * engine that actually computed them. A stale frontend payload, a race
 * condition, or a bug re-serializing `detectedAt` could make all three
 * checks pass on a trade that doesn't actually satisfy any of them — not
 * because of an exotic exploit, but because the client was simply trusted.
 *
 * This module is the server-side source of truth those checks should read
 * from instead. `arbitrageOrchestrator.js` calls `recordSnapshots()` once
 * per detection tick with every opportunity it just computed (same place it
 * already calls `recordOpportunitySeen()` for exchange-intelligence stats —
 * see the three call sites in that file). `liveExecution.js` then resolves
 * any client-supplied opportunity against this store before doing anything
 * with its numbers: unknown or expired ids are rejected outright, and known
 * ids have every price/risk-relevant field replaced with the server's own
 * last-computed values.
 *
 * In-memory Map + TTL sweep — same pattern as `recentFingerprints` in
 * arbitrage.state.js. No new infra dependency needed for a value that's
 * only ever a few seconds old, and it fits the existing crash-recovery
 * philosophy already used for pending executions (see
 * `persistenceService.markPendingExecution` /
 * `listUnresolvedPendingExecutions`): if the process restarts, the store is
 * simply empty and every execute call correctly fails "opportunity unknown"
 * until the detection loop repopulates it — a safe default, not a gap.
 */

// Generous vs. the 2000ms staleness gate in preflightCheck(): this is "how
// long we keep an entry around to be looked up at all", not "how fresh it
// has to be to execute". The actual freshness requirement is enforced by
// the caller comparing against the *stored* detectedAt (see
// resolveTrustedOpportunity() in liveExecution.js), which is always <= this
// TTL and usually much fresher since the detection loop ticks every ~150ms.
const TTL_MS = 5000;

// Keyed by `${op.id}:${asset}` rather than bare `op.id` — opportunity ids
// are stable per exchange-pair (`arb-${buyExchange}-${sellExchange}`, see
// "Issue 12" in opportunityDetection.js) but are NOT unique across assets:
// detectEthOpportunities() in arbitrageOrchestrator.js reuses the exact same
// id scheme for ETH pairs (only tagging the result with `asset: 'ETH'`
// afterwards), so a bare id would let a BTC and an ETH opportunity on the
// same exchange pair silently overwrite each other in this store.
function _key(id, asset) {
  return `${id}:${asset || 'BTC'}`;
}

const _snapshots = new Map(); // key -> { op, storedAt }

function recordSnapshot(op) {
  if (!op || !op.id) return;
  _snapshots.set(_key(op.id, op.asset), { op, storedAt: Date.now() });
}

function recordSnapshots(ops) {
  for (const op of (ops || [])) recordSnapshot(op);
}

function _sweep() {
  const now = Date.now();
  for (const [key, entry] of _snapshots) {
    if (now - entry.storedAt > TTL_MS) _snapshots.delete(key);
  }
}
// unref() so this timer never keeps the process alive on its own — same
// convention as the fingerprint sweep in arbitrage.state.js.
setInterval(_sweep, TTL_MS).unref();

/**
 * @param {string} id opportunity.id as sent by the client
 * @param {string} [asset] opportunity.asset as sent by the client (defaults
 *   to 'BTC', matching the detection engine's own default)
 * @returns {{op:object, ageMs:number}|null} null if unknown or expired.
 */
function getSnapshot(id, asset) {
  if (!id) return null;
  const key = _key(id, asset);
  const entry = _snapshots.get(key);
  if (!entry) return null;
  const ageMs = Date.now() - entry.storedAt;
  if (ageMs > TTL_MS) { _snapshots.delete(key); return null; }
  return { op: entry.op, ageMs };
}

// Test-only helpers (mirrors the pattern used elsewhere in this codebase,
// e.g. arbitrageOrchestrator.js's `_resetDiffCacheForTests`).
function _clearForTests() { _snapshots.clear(); }
function _size() { return _snapshots.size; }

module.exports = {
  TTL_MS,
  recordSnapshot,
  recordSnapshots,
  getSnapshot,
  _clearForTests,
  _size,
};

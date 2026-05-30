/**
 * opportunityLifecycle.js — Kukora Hackathon Enhancement
 *
 * Tracks the full lifecycle of arbitrage opportunities:
 *   firstSeen → active → expired
 *
 * Key metrics per opportunity pair:
 *   firstSeen, lastSeen, durationMs, seenCount, maxSpread, maxProfit, status
 *
 * Also maintains a history of expired opportunities for the
 * "Opportunity Lifecycle Analytics" panel.
 */

// ─── In-memory store ───────────────────────────────────────────────────────
// Key: `${buyExchange}-${sellExchange}`
const _active  = new Map();   // currently visible opportunities
const _history = [];          // expired opportunities (last 200)
const MAX_HISTORY = 200;

// TTL: if we don't see a pair for > 2s, it's considered "expired"
const EXPIRY_TTL_MS = 2000;

/**
 * Call this on every opportunity emitted by detectOpportunities.
 * Returns the enriched opportunity with lifecycle fields attached.
 */
function trackOpportunity(op) {
  const key = `${op.buyExchange}-${op.sellExchange}`;
  const now  = Date.now();

  let entry = _active.get(key);

  if (!entry) {
    // First time seeing this pair in this run
    entry = {
      key,
      buyExchange:  op.buyExchange,
      sellExchange: op.sellExchange,
      firstSeen:    op.ts || new Date().toISOString(),
      firstSeenTs:  now,
      lastSeen:     op.ts || new Date().toISOString(),
      lastSeenTs:   now,
      seenCount:    1,
      durationMs:   0,
      maxSpread:    op.spreadPct  || 0,
      maxProfit:    op.netProfit  || 0,
      minBreakEven: op.breakEvenPct || 0,
      viable:       op.viable,
      status:       'active',
    };
    _active.set(key, entry);
  } else {
    // Update existing entry
    entry.lastSeen   = op.ts || new Date().toISOString();
    entry.lastSeenTs = now;
    entry.seenCount++;
    entry.durationMs = now - entry.firstSeenTs;
    if ((op.spreadPct  || 0) > entry.maxSpread) entry.maxSpread = op.spreadPct;
    if ((op.netProfit  || 0) > entry.maxProfit) entry.maxProfit = op.netProfit;
    entry.viable = op.viable;
  }

  // Attach lifecycle data to the opportunity object
  return {
    ...op,
    lifecycle: {
      firstSeen:  entry.firstSeen,
      lastSeen:   entry.lastSeen,
      durationMs: entry.durationMs,
      seenCount:  entry.seenCount,
      maxSpread:  +entry.maxSpread.toFixed(4),
      maxProfit:  +entry.maxProfit.toFixed(4),
      status:     entry.status,
    },
  };
}

/**
 * Expire opportunities that haven't been seen for > EXPIRY_TTL_MS.
 * Call this periodically (e.g., every 500ms from the main loop).
 * Returns array of newly-expired entries.
 */
function expireStale() {
  const now    = Date.now();
  const expired = [];

  for (const [key, entry] of _active) {
    if (now - entry.lastSeenTs > EXPIRY_TTL_MS) {
      entry.status     = 'expired';
      entry.durationMs = entry.lastSeenTs - entry.firstSeenTs;
      expired.push({ ...entry });
      _active.delete(key);

      if (_history.length >= MAX_HISTORY) _history.shift();
      _history.push({ ...entry });
    }
  }

  return expired;
}

/** Bulk-track an array of opportunities (called after detectOpportunities). */
function trackAll(opportunities) {
  return opportunities.map(op => trackOpportunity(op));
}

/** Returns snapshot of currently-active opportunity lifecycles. */
function getActiveLifecycles() {
  const now = Date.now();
  return Array.from(_active.values()).map(e => ({
    ...e,
    durationMs: e.lastSeenTs - e.firstSeenTs,
    ageMs: now - e.firstSeenTs,
  }));
}

/** Returns last N expired opportunity records. */
function getLifecycleHistory(n = 50) {
  return _history.slice(-n).reverse();
}

/** Summary stats for the executive dashboard. */
function getLifecycleSummary() {
  const history = _history;
  if (!history.length) return { count: 0, avgDurationMs: 0, avgSeenCount: 0, avgMaxSpread: 0, avgMaxProfit: 0, longestMs: 0 };

  const count        = history.length;
  const avgDurationMs = Math.round(history.reduce((s, e) => s + e.durationMs, 0) / count);
  const avgSeenCount  = +(history.reduce((s, e) => s + e.seenCount, 0) / count).toFixed(1);
  const avgMaxSpread  = +(history.reduce((s, e) => s + e.maxSpread, 0) / count).toFixed(4);
  const avgMaxProfit  = +(history.reduce((s, e) => s + e.maxProfit, 0) / count).toFixed(4);
  const longestMs     = Math.max(...history.map(e => e.durationMs));
  const viableRatio   = +(history.filter(e => e.viable).length / count).toFixed(3);

  return { count, avgDurationMs, avgSeenCount, avgMaxSpread, avgMaxProfit, longestMs, viableRatio };
}

module.exports = {
  trackOpportunity,
  trackAll,
  expireStale,
  getActiveLifecycles,
  getLifecycleHistory,
  getLifecycleSummary,
};
'use strict';

const { isMultiHopDetectionResult } = require('./multiHopCycle');
const obs = require('../../infrastructure/observabilityService');

/**
 * multiHopArbitrageEngine.js
 *
 * Audit item #4 (Jul 2026 arbitrage-engine audit — "Detección puramente
 * bilateral O(n²), sin arbitraje multi-hop real"). Before this module,
 * Kukora's only two detection strategies were:
 *
 *   - Bilateral (in detectOpportunities above): fixed 2-hop, buy cheapest /
 *     sell priciest across the 5 exchanges. O(n²) pairs, trivial at n=5.
 *   - detectTriangularSignal (below): fixed 3-hop, enumerated with a triple
 *     nested loop (O(n³)) — buy at A, sell at B, buy at B, sell at C, same
 *     asset throughout, three specific exchanges hardcoded into the shape
 *     of the loop.
 *
 * Neither generalizes: going from 2 to 3 hops required writing an entirely
 * new O(n³) function, and a genuine 4-hop or 5-hop compounding opportunity
 * (rare, but real on volatile days) was structurally invisible — nothing
 * looked for it.
 *
 * This module replaces "one hardcoded function per hop count" with a
 * single graph algorithm that finds the best cycle of ANY length
 * automatically: nodes = exchanges, a directed edge from X to Y has weight
 * -log(effective compounding rate from X to Y after both sides' taker
 * fees). A profitable N-hop round trip is exactly a negative-weight cycle
 * in this graph (the classic reduction used by real triangular-arbitrage
 * detectors: sum of edge weights < 0 ⇔ product of rates > 1). Bellman-Ford
 * finds it in O(V·E) regardless of how many hops the best cycle turns out
 * to have — 2, 3, or 5 — instead of needing a new enumeration function per
 * length.
 *
 * Scope note: today this operates on a single asset's order books across
 * the 5 exchanges (same shape as detectTriangularSignal). `findBestNegativeCycle`
 * and `buildGraph`/edge list are intentionally generic — they don't know
 * "exchange" from any other kind of node — so the natural extension to a
 * true multi-asset graph (nodes = (exchange, asset) pairs, using the real
 * ETH/USDT books multiPairService.js already fetches from all 5
 * exchanges) is a matter of building a different edge list and calling the
 * same `findBestNegativeCycle`, not rewriting the search. See
 * buildAssetGraphEdges() below, included and tested for exactly that case,
 * but not yet wired into the live detection loop — doing that safely means
 * fetching ETH/USDT books on every detection cycle, which is a real
 * latency/rate-limit cost that deserves its own decision, not a silent
 * side effect of this audit item.
 *
 * Honest limit of the same-asset exchange-chain graph (verified, not
 * assumed): because every node's own bid ≤ its own ask, and a CLOSED cycle
 * revisits the exact same set of exchanges on both the "bid" side and the
 * "ask" side of the product, ∏bid_i ≤ ∏ask_i always — so any closed round
 * trip that ends up holding the same asset back on its starting exchange
 * is bounded at ≤1 before fees, and strictly <1 once any fee is applied,
 * *no matter how mispriced an exchange is*. This isn't a corner case to
 * work around; it's the same no-free-lunch identity that makes wash
 * trading a single instrument through itself impossible. So for THIS
 * graph (same asset, exchange nodes), `findBestNegativeCycle` correctly
 * — and structurally — will not report a cycle in practice; that is
 * expected, not a bug, and is exactly why `detectMultiHopArbitrage`'s
 * tests below assert `hasArbitrage:false` even for a heavily-skewed book.
 * The genuinely open case where a negative cycle CAN exist is the
 * cross-asset graph (buildAssetGraphEdges) — different markets, not a
 * single instrument's own bid/ask — which is why that path is kept as
 * the real target for this algorithm going forward (see Scope note above).
 */

const EPS = 1e-12; // floating-point tolerance for the relaxation comparisons below

/**
 * One directed edge: going from `from` to `to` means "having sold your
 * position on `from` at its bid and bought back in on `to` at its ask" for
 * the exchange-chain case, or "traded asset `from` for asset `to` at the
 * given effective rate" for the generic asset-graph case. `weight` is
 * always -log(effectiveRate) so that a negative-weight cycle ⇔ a
 * profitable round trip.
 */
function _makeEdge(from, to, effectiveRate) {
  if (!(effectiveRate > 0)) return null;
  return { from, to, weight: -Math.log(effectiveRate) };
}

/**
 * buildExchangeChainGraph — the real, immediately-usable case: nodes are
 * the 5 exchanges, an edge from X to Y represents "realize the position at
 * Y's bid, re-enter at X's... " no — concretely: selling what you're
 * holding at X (its bid, net of X's taker fee) and using the proceeds to
 * buy back in at Y (its ask, net of Y's taker fee). Chaining edges
 * X→Y→Z→X compounds exactly the way detectTriangularSignal's fixed 3-hop
 * formula did, generalized to any length.
 */
function buildExchangeChainGraph(books, fees) {
  const valid = (books || []).filter(b => b && b.ask > 0 && b.bid > 0 && !b.error);
  const nodes = valid.map(b => b.exchange);
  const edges = [];

  for (const from of valid) {
    for (const to of valid) {
      if (from.exchange === to.exchange) continue;
      const feeFrom = fees[from.exchange] ?? 0.001;
      const feeTo   = fees[to.exchange]   ?? 0.001;
      // Sell at `from`'s bid (net of its fee), then that USDT buys back in
      // at `to`'s ask (net of its fee). This is the same per-leg rate
      // detectTriangularSignal used, just expressed as a graph edge
      // instead of inlined into a fixed-length loop.
      const effectiveRate = (from.bid * (1 - feeFrom)) / (to.ask * (1 + feeTo));
      const edge = _makeEdge(from.exchange, to.exchange, effectiveRate);
      if (edge) edges.push(edge);
    }
  }

  return { nodes, edges };
}

/**
 * buildAssetGraphEdges — generic multi-asset extension point (see file
 * header). `rates` is a flat list of realizable conversions:
 *   [{ from: 'USDT', to: 'BTC', effectiveRate }, ...]
 * where effectiveRate already has fees/slippage baked in (rate * (1-fee)
 * for whichever side needs it) — this function doesn't know or care what
 * the nodes represent, it just turns rate quotes into weighted edges.
 */
function buildAssetGraphEdges(rates) {
  const edges = [];
  const nodeSet = new Set();
  for (const r of rates || []) {
    if (!r || !r.from || !r.to) continue;
    const edge = _makeEdge(r.from, r.to, r.effectiveRate);
    if (edge) {
      edges.push(edge);
      nodeSet.add(r.from);
      nodeSet.add(r.to);
    }
  }
  return { nodes: [...nodeSet], edges };
}

/**
 * findBestNegativeCycle — standard Bellman-Ford negative-cycle detection,
 * generalized to arbitrary node/edge sets. Multi-source: every node starts
 * at distance 0 (equivalent to a virtual source connected to all nodes
 * with weight 0), so a negative cycle anywhere in the graph is found
 * regardless of which node it happens to pass through first.
 *
 * Returns the cycle Bellman-Ford happens to detect (there may be more than
 * one profitable cycle in a richer graph; this reports one, which is the
 * standard behavior of this algorithm and sufficient for a 5-exchange /
 * few-asset graph where at most one genuine arbitrage cycle typically
 * exists at a time).
 */
function findBestNegativeCycle(nodes, edges) {
  const V = nodes.length;
  if (V < 2 || edges.length === 0) return null;

  const dist = {};
  const pred = {};
  for (const n of nodes) { dist[n] = 0; pred[n] = null; }

  // V-1 relaxation rounds guarantee shortest paths if there's no negative cycle.
  for (let i = 0; i < V - 1; i++) {
    for (const e of edges) {
      if (dist[e.from] + e.weight < dist[e.to] - EPS) {
        dist[e.to] = dist[e.from] + e.weight;
        pred[e.to] = e.from;
      }
    }
  }

  // Vth round: any further relaxation proves a negative cycle exists, and
  // e.to is guaranteed to lie on (or be reachable from) that cycle.
  let cycleNode = null;
  for (const e of edges) {
    if (dist[e.from] + e.weight < dist[e.to] - EPS) {
      dist[e.to] = dist[e.from] + e.weight;
      pred[e.to] = e.from;
      cycleNode = e.to;
    }
  }
  if (cycleNode == null) return null; // no negative cycle — no arbitrage in this graph right now

  // Walk back V steps to guarantee landing strictly inside the cycle
  // (not just on a path leading into it).
  let node = cycleNode;
  for (let i = 0; i < V; i++) node = pred[node];

  // Reconstruct the cycle by following predecessors until we're back at `node`.
  const cyclePath = [node];
  let cur = pred[node];
  while (cur !== node && cyclePath.length <= V + 1) {
    cyclePath.push(cur);
    cur = pred[cur];
  }
  cyclePath.push(node);
  cyclePath.reverse();

  let totalWeight = 0;
  for (let i = 0; i < cyclePath.length - 1; i++) {
    const e = edges.find(e => e.from === cyclePath[i] && e.to === cyclePath[i + 1]);
    if (e) totalWeight += e.weight;
  }

  const compoundedMultiplier = Math.exp(-totalWeight);
  return {
    path: cyclePath,
    hops: cyclePath.length - 1,
    totalLogWeight: +totalWeight.toFixed(6),
    compoundedMultiplier: +compoundedMultiplier.toFixed(6),
    compoundedNetPct: +((compoundedMultiplier - 1) * 100).toFixed(4),
  };
}

/**
 * detectMultiHopArbitrage — the entry point wired into detectOpportunities
 * (see opportunityDetection.js's `multiHopSignal`). Purely informational
 * today, same status detectTriangularSignal had before it grew an
 * execution path — a `multiHopSignal.hops > 3` result would be exactly
 * the case the old fixed-length enumeration could never have found, *if*
 * one existed. In practice, on the current same-asset exchange-chain graph
 * this will almost always (structurally — see the header note above)
 * return `hasArbitrage:false`, which is the mathematically correct answer,
 * not a detection failure. The function is kept general-purpose (it
 * doesn't care whether `books`/`fees` came from the 5-exchange BTC/USDT
 * chain or, later, a real cross-asset edge list) so that wiring the
 * genuinely-open multi-asset case (buildAssetGraphEdges) in requires no
 * change here.
 */
function detectMultiHopArbitrage(books, fees) {
  const { nodes, edges } = buildExchangeChainGraph(books, fees || {});
  const cycle = findBestNegativeCycle(nodes, edges);
  const result = (!cycle || cycle.compoundedNetPct <= 0)
    ? { hasArbitrage: false, cycle: null }
    : { hasArbitrage: true, cycle };

  // Soft contract check (non-blocking — see multiHopCycle.ts). Wired at the
  // producer, same pattern as MarketRegimeResult/OpportunityLogEntry: this
  // is the only function that builds this shape, so there's no shared
  // consumer point to check it at instead.
  if (!isMultiHopDetectionResult(result)) {
    obs.emit('RISK', 'contract.multi_hop_detection_result_shape_invalid', {
      hasArbitrage: result.hasArbitrage,
    });
  }

  return result;
}

module.exports = {
  buildExchangeChainGraph,
  buildAssetGraphEdges,
  findBestNegativeCycle,
  detectMultiHopArbitrage,
};

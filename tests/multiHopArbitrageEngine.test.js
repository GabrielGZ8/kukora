'use strict';

import { describe, it, expect } from 'vitest';
const {
  buildExchangeChainGraph,
  buildAssetGraphEdges,
  findBestNegativeCycle,
  detectMultiHopArbitrage,
} = require('../server/domain/engines/multiHopArbitrageEngine');

describe('multiHopArbitrageEngine — findBestNegativeCycle (audit item #4)', () => {
  it('returns null for an empty or single-node graph', () => {
    expect(findBestNegativeCycle([], [])).toBeNull();
    expect(findBestNegativeCycle(['A'], [])).toBeNull();
  });

  it('returns null when no negative cycle exists (all rates fairly priced)', () => {
    // A→B→A round trip that loses a little at each hop (fees) — no arbitrage.
    const nodes = ['A', 'B'];
    const edges = [
      { from: 'A', to: 'B', weight: 0.001 }, // slightly costly
      { from: 'B', to: 'A', weight: 0.001 },
    ];
    expect(findBestNegativeCycle(nodes, edges)).toBeNull();
  });

  it('detects a simple 2-node negative cycle', () => {
    const nodes = ['A', 'B'];
    const edges = [
      { from: 'A', to: 'B', weight: -0.01 },
      { from: 'B', to: 'A', weight: -0.01 },
    ];
    const cycle = findBestNegativeCycle(nodes, edges);
    expect(cycle).not.toBeNull();
    expect(cycle.hops).toBe(2);
    expect(cycle.compoundedNetPct).toBeGreaterThan(0);
  });

  it('detects a genuine 5-hop negative cycle that no fixed-length (2 or 3) enumeration could find', () => {
    // A→B→C→D→E→A, each hop contributing a small negative weight (profit),
    // but NO 2-hop or 3-hop sub-cycle among these edges is itself negative
    // (there simply isn't a direct A→C or A→D edge at all) — the only way
    // to realize this profit is to take all 5 hops. This is exactly the
    // case detectTriangularSignal's fixed-3-hop enumeration structurally
    // cannot find, and detectOpportunities' bilateral scan cannot find
    // either (there's no direct A-E rate to compare).
    const nodes = ['A', 'B', 'C', 'D', 'E'];
    const edges = [
      { from: 'A', to: 'B', weight: -0.002 },
      { from: 'B', to: 'C', weight: -0.002 },
      { from: 'C', to: 'D', weight: -0.002 },
      { from: 'D', to: 'E', weight: -0.002 },
      { from: 'E', to: 'A', weight: -0.002 },
    ];
    const cycle = findBestNegativeCycle(nodes, edges);
    expect(cycle).not.toBeNull();
    expect(cycle.hops).toBe(5);
    expect(cycle.path[0]).toBe(cycle.path[cycle.path.length - 1]); // genuinely a cycle
    expect(cycle.compoundedNetPct).toBeGreaterThan(0);
  });

  it('is not fooled by a disconnected profitable-looking edge that never closes into a cycle', () => {
    // A→B is very negative (looks "profitable") but there is no way back
    // to A — this must NOT be reported as an arbitrage cycle.
    const nodes = ['A', 'B', 'C'];
    const edges = [
      { from: 'A', to: 'B', weight: -0.5 },
      { from: 'B', to: 'C', weight: 0.001 },
      // no edge back to A at all
    ];
    expect(findBestNegativeCycle(nodes, edges)).toBeNull();
  });
});

describe('multiHopArbitrageEngine — buildExchangeChainGraph', () => {
  it('builds a fully-connected directed graph across all valid books, skipping self-loops and invalid books', () => {
    const books = [
      { exchange: 'Binance', ask: 50000, bid: 49990 },
      { exchange: 'Kraken', ask: 50100, bid: 50090 },
      { exchange: 'Bybit', error: true, ask: 1, bid: 1 }, // invalid — should be excluded
    ];
    const { nodes, edges } = buildExchangeChainGraph(books, { Binance: 0.001, Kraken: 0.0026 });
    expect(nodes.sort()).toEqual(['Binance', 'Kraken']);
    // 2 valid nodes → exactly 2 directed edges (Binance→Kraken, Kraken→Binance)
    expect(edges.length).toBe(2);
    expect(edges.every(e => e.from !== e.to)).toBe(true);
  });

  it('produces a negative-weight edge when the destination bids meaningfully higher than the source asks (net of fees)', () => {
    const books = [
      { exchange: 'A', ask: 100, bid: 99.9 },
      { exchange: 'B', ask: 100.05, bid: 105 }, // B's bid is well above A's ask
    ];
    const { edges } = buildExchangeChainGraph(books, { A: 0.001, B: 0.001 });
    const aToB = edges.find(e => e.from === 'A' && e.to === 'B');
    // Selling at A's bid (99.9, net fee) then buying at B's ask (100.05, net
    // fee) is roughly break-even/slightly negative rate — but selling at
    // B's bid (105) then buying at A's ask should be strongly profitable.
    const bToA = edges.find(e => e.from === 'B' && e.to === 'A');
    expect(bToA.weight).toBeLessThan(aToB.weight);
  });
});

describe('multiHopArbitrageEngine — buildAssetGraphEdges (generic multi-asset extension point)', () => {
  it('turns a flat rate list into nodes + weighted edges', () => {
    const { nodes, edges } = buildAssetGraphEdges([
      { from: 'USDT', to: 'BTC', effectiveRate: 1 / 50000 },
      { from: 'BTC', to: 'ETH', effectiveRate: 15 },
      { from: 'ETH', to: 'USDT', effectiveRate: 3400 },
    ]);
    expect(nodes.sort()).toEqual(['BTC', 'ETH', 'USDT']);
    expect(edges.length).toBe(3);
  });

  it('skips entries with a non-positive effectiveRate rather than producing a broken edge', () => {
    const { edges } = buildAssetGraphEdges([
      { from: 'A', to: 'B', effectiveRate: 0 },
      { from: 'A', to: 'B', effectiveRate: -1 },
      { from: 'A', to: 'B', effectiveRate: 1.01 },
    ]);
    expect(edges.length).toBe(1);
  });

  it('can find a profitable cycle in a constructed 3-asset triangular rate table', () => {
    // USDT -> BTC -> ETH -> USDT with rates that compound to > 1 (a classic
    // triangular arbitrage setup), proving the same findBestNegativeCycle
    // core works identically for a real multi-asset graph, not just the
    // same-asset exchange-chain case.
    const { nodes, edges } = buildAssetGraphEdges([
      { from: 'USDT', to: 'BTC', effectiveRate: 1 / 50000 },
      { from: 'BTC', to: 'ETH', effectiveRate: 15 },          // 1 BTC -> 15 ETH (mispriced on purpose)
      { from: 'ETH', to: 'USDT', effectiveRate: 3500 },       // 1 ETH -> 3500 USDT
    ]);
    // Round-trip compounding: (1/50000) * 15 * 3500 = 1.05 -> 5% profit
    const cycle = findBestNegativeCycle(nodes, edges);
    expect(cycle).not.toBeNull();
    expect(cycle.compoundedNetPct).toBeGreaterThan(0);
  });
});

describe('multiHopArbitrageEngine — detectMultiHopArbitrage (wired entry point)', () => {
  it('returns hasArbitrage:false with no cycle when books are fairly priced across exchanges', () => {
    const books = [
      { exchange: 'Binance', ask: 50000, bid: 49995 },
      { exchange: 'Kraken', ask: 50005, bid: 50000 },
      { exchange: 'Bybit', ask: 50002, bid: 49997 },
    ];
    const result = detectMultiHopArbitrage(books, { Binance: 0.001, Kraken: 0.0026, Bybit: 0.001 });
    expect(result.hasArbitrage).toBe(false);
    expect(result.cycle).toBeNull();
  });

  it('still returns hasArbitrage:false even when one exchange is heavily mispriced — a CLOSED same-asset cycle can never be profitable', () => {
    // This looks like it "should" be an opportunity (Kraken priced ~1.2%
    // above the rest) but a closed round trip returning the SAME asset to
    // its starting exchange can never clear a profit here: every node's own
    // bid <= its own ask, so for any closed cycle ∏bid_i <= ∏ask_i over the
    // identical index set, which bounds the whole product at <=1 before
    // fees and strictly <1 after — regardless of how mispriced any single
    // exchange is. Verified numerically (not assumed) before writing this
    // assertion: every 2-hop and 3-hop closed combination on this exact
    // fixture comes out below 1. This is the correct, expected behavior of
    // findBestNegativeCycle on a same-asset exchange-chain graph — see the
    // "Honest limit" note in multiHopArbitrageEngine.js's file header.
    const books = [
      { exchange: 'Binance', ask: 50000, bid: 49995 },
      { exchange: 'Kraken', ask: 50600, bid: 50590 }, // Kraken well above the rest
      { exchange: 'Bybit', ask: 50002, bid: 49997 },
    ];
    const result = detectMultiHopArbitrage(books, { Binance: 0.001, Kraken: 0.0026, Bybit: 0.001 });
    expect(result.hasArbitrage).toBe(false);
    expect(result.cycle).toBeNull();
  });

  it('returns hasArbitrage:false gracefully with fewer than 2 valid books', () => {
    expect(detectMultiHopArbitrage([], {})).toEqual({ hasArbitrage: false, cycle: null });
    expect(detectMultiHopArbitrage([{ exchange: 'Binance', ask: 50000, bid: 49995 }], {})).toEqual({ hasArbitrage: false, cycle: null });
  });
});

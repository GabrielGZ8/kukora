'use strict';

/**
 * multiHopCycle.test.js — dedicated tests for the `MultiHopCycle` /
 * `MultiHopDetectionResult` shared type guards (audit pendiente #1: "tipos
 * de dominio compartidos entre motores satélite" — segundo de los 5
 * motores nombrados explícitamente cerrado esta ronda).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { isMultiHopCycle, isMultiHopDetectionResult } = require('../server/domain/engines/multiHopCycle');
const { detectMultiHopArbitrage, findBestNegativeCycle } = require('../server/domain/engines/multiHopArbitrageEngine');
const observability = require('../server/infrastructure/observabilityService');

describe('multiHopCycle — isMultiHopCycle', () => {
  it('accepts a real cycle produced by findBestNegativeCycle', () => {
    const nodes = ['A', 'B'];
    const edges = [
      { from: 'A', to: 'B', weight: -0.01 },
      { from: 'B', to: 'A', weight: -0.01 },
    ];
    const cycle = findBestNegativeCycle(nodes, edges);
    expect(isMultiHopCycle(cycle)).toBe(true);
  });

  it('rejects null, non-objects, and shapes with missing or wrong-typed fields', () => {
    expect(isMultiHopCycle(null)).toBe(false);
    expect(isMultiHopCycle(undefined)).toBe(false);
    expect(isMultiHopCycle('cycle')).toBe(false);
    expect(isMultiHopCycle({})).toBe(false);
    expect(isMultiHopCycle({ path: ['A', 'B'], hops: 2, totalLogWeight: -0.02 })).toBe(false); // missing fields
    expect(isMultiHopCycle({
      path: 'A,B', hops: 2, totalLogWeight: -0.02, compoundedMultiplier: 1.02, compoundedNetPct: 2,
    })).toBe(false); // path not an array
  });
});

describe('multiHopCycle — isMultiHopDetectionResult', () => {
  it('accepts the real hasArbitrage:false shape', () => {
    expect(isMultiHopDetectionResult({ hasArbitrage: false, cycle: null })).toBe(true);
  });

  it('accepts the real hasArbitrage:true shape with a valid cycle', () => {
    const nodes = ['A', 'B'];
    const edges = [
      { from: 'A', to: 'B', weight: -0.01 },
      { from: 'B', to: 'A', weight: -0.01 },
    ];
    const cycle = findBestNegativeCycle(nodes, edges);
    expect(isMultiHopDetectionResult({ hasArbitrage: true, cycle })).toBe(true);
  });

  it('rejects hasArbitrage:false with a non-null cycle, and hasArbitrage:true with cycle:null', () => {
    expect(isMultiHopDetectionResult({ hasArbitrage: false, cycle: {} })).toBe(false);
    expect(isMultiHopDetectionResult({ hasArbitrage: true, cycle: null })).toBe(false);
  });

  it('rejects null, non-objects, and missing hasArbitrage', () => {
    expect(isMultiHopDetectionResult(null)).toBe(false);
    expect(isMultiHopDetectionResult('result')).toBe(false);
    expect(isMultiHopDetectionResult({ cycle: null })).toBe(false);
  });
});

describe('multiHopArbitrageEngine — detectMultiHopArbitrage contract wiring', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('never emits contract.multi_hop_detection_result_shape_invalid for real (fairly-priced) books', () => {
    const emitSpy = vi.spyOn(observability, 'emit');
    const books = [
      { exchange: 'Binance', ask: 50000, bid: 49995 },
      { exchange: 'Kraken', ask: 50005, bid: 50000 },
      { exchange: 'Bybit', ask: 50002, bid: 49997 },
    ];
    const result = detectMultiHopArbitrage(books, { Binance: 0.001, Kraken: 0.0026, Bybit: 0.001 });
    expect(result.hasArbitrage).toBe(false);
    expect(emitSpy).not.toHaveBeenCalledWith(
      'RISK', 'contract.multi_hop_detection_result_shape_invalid', expect.anything()
    );
  });

  it('never emits the contract event for the empty/insufficient-books edge case either', () => {
    const emitSpy = vi.spyOn(observability, 'emit');
    detectMultiHopArbitrage([], {});
    expect(emitSpy).not.toHaveBeenCalledWith(
      'RISK', 'contract.multi_hop_detection_result_shape_invalid', expect.anything()
    );
  });
});

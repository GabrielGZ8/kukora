'use strict';
/**
 * tapeReplay.test.js — Iniciativa 3, lógica pura de reproducción de
 * grabaciones (scripts/lib/tapeReplay.js). No abre archivos ni red —
 * usa detectOpportunities inyectado con un stub, mismo criterio que
 * statisticalValidation.test.js usa simulateRun inyectado.
 */
import { describe, it, expect } from 'vitest';
const { replayTape, parseTapeLine, isValidSnapshot } = require('../scripts/lib/tapeReplay');

describe('isValidSnapshot', () => {
  it('accepts a snapshot with a non-empty orderBooks array', () => {
    expect(isValidSnapshot({ ts: 'x', orderBooks: [{ exchange: 'Binance', bid: 1, ask: 2 }] })).toBe(true);
  });

  it('rejects null/undefined', () => {
    expect(isValidSnapshot(null)).toBe(false);
    expect(isValidSnapshot(undefined)).toBe(false);
  });

  it('rejects a snapshot with an empty or missing orderBooks array', () => {
    expect(isValidSnapshot({ ts: 'x', orderBooks: [] })).toBe(false);
    expect(isValidSnapshot({ ts: 'x' })).toBe(false);
    expect(isValidSnapshot({ ts: 'x', orderBooks: 'not-an-array' })).toBe(false);
  });
});

describe('parseTapeLine', () => {
  it('parses a valid JSONL line into a snapshot object', () => {
    const line = JSON.stringify({ ts: '2026-01-01T00:00:00Z', orderBooks: [{ exchange: 'Binance', bid: 1, ask: 2 }] });
    const parsed = parseTapeLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed.orderBooks.length).toBe(1);
  });

  it('returns null for malformed JSON instead of throwing', () => {
    expect(() => parseTapeLine('{not valid json')).not.toThrow();
    expect(parseTapeLine('{not valid json')).toBeNull();
  });

  it('returns null for valid JSON that is not a valid snapshot shape', () => {
    expect(parseTapeLine(JSON.stringify({ foo: 'bar' }))).toBeNull();
  });

  it('returns null for a blank line', () => {
    expect(parseTapeLine('   ')).toBeNull();
    expect(parseTapeLine('')).toBeNull();
  });
});

describe('replayTape', () => {
  it('calls detectOpportunities once per valid snapshot, in order', () => {
    const calls = [];
    const detectOpportunities = (orderBooks) => { calls.push(orderBooks); return [{ id: 'x' }]; };
    const snapshots = [
      { ts: 't1', orderBooks: [{ exchange: 'Binance', bid: 1, ask: 2 }] },
      { ts: 't2', orderBooks: [{ exchange: 'Kraken', bid: 3, ask: 4 }] },
    ];
    const result = replayTape(snapshots, { detectOpportunities });
    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.opportunitiesDetected).toBe(2);
    expect(calls[0][0].exchange).toBe('Binance');
    expect(calls[1][0].exchange).toBe('Kraken');
  });

  it('skips invalid snapshots instead of throwing, and counts them', () => {
    const detectOpportunities = () => [];
    const snapshots = [
      { ts: 't1', orderBooks: [{ exchange: 'Binance', bid: 1, ask: 2 }] },
      { ts: 't2', orderBooks: [] }, // invalid: empty
      null, // invalid
    ];
    const result = replayTape(snapshots, { detectOpportunities });
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it('throws a clear error if detectOpportunities is not a function', () => {
    expect(() => replayTape([], {})).toThrow(/detectOpportunities/);
  });

  it('throws a clear error if snapshots is not an array', () => {
    expect(() => replayTape('not-an-array', { detectOpportunities: () => [] })).toThrow(/snapshots/);
  });

  it('passes tradeAmount through to detectOpportunities when provided', () => {
    let receivedAmount = null;
    const detectOpportunities = (orderBooks, tradeAmount) => { receivedAmount = tradeAmount; return []; };
    replayTape(
      [{ ts: 't1', orderBooks: [{ exchange: 'Binance', bid: 1, ask: 2 }] }],
      { detectOpportunities, tradeAmount: 0.05 },
    );
    expect(receivedAmount).toBe(0.05);
  });
});

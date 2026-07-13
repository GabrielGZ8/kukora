import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordMissed, recordExecuted, getMissedSummary, getMissedRecent, resetMissed,
} from '../server/infrastructure/missedOpportunityTracker.js';

function viableOp(overrides = {}) {
  return {
    viable: true,
    buyExchange: 'Binance',
    sellExchange: 'OKX',
    netProfit: 1.2345,
    spreadPct: 0.5,
    score: 80,
    slippageMethod: 'orderbook',
    ...overrides,
  };
}

describe('missedOpportunityTracker', () => {
  beforeEach(() => resetMissed());

  it('ignores non-viable opportunities', () => {
    recordMissed({ viable: false }, 'cooldown');
    expect(getMissedSummary().totalMissedCount).toBe(0);
  });

  it('ignores null/undefined input', () => {
    expect(() => recordMissed(null, 'cooldown')).not.toThrow();
    expect(getMissedSummary().totalMissedCount).toBe(0);
  });

  it('ignores structural rejects (circuitBreaker / liquidityOk:false) — not "misses"', () => {
    recordMissed(viableOp({ circuitBreaker: true }), null);
    recordMissed(viableOp({ liquidityOk: false }), null);
    expect(getMissedSummary().totalMissedCount).toBe(0);
  });

  it('classifies by explicit skipReason', () => {
    recordMissed(viableOp(), 'cooldown');
    recordMissed(viableOp(), 'fingerprint');
    recordMissed(viableOp(), 'score_too_low');
    recordMissed(viableOp(), 'daily_loss');
    recordMissed(viableOp(), 'some_unknown_reason');

    const summary = getMissedSummary();
    expect(summary.byReason.cooldown.count).toBe(1);
    expect(summary.byReason.fingerprint.count).toBe(1);
    expect(summary.byReason.score_too_low.count).toBe(1);
    expect(summary.byReason.daily_loss.count).toBe(1);
    expect(summary.byReason.other.count).toBe(1); // unknown reason falls back to 'other'
    expect(summary.totalMissedCount).toBe(5);
  });

  it('classifies without an explicit skipReason using op flags', () => {
    recordMissed(viableOp({ liquidityOk: true }), null); // no flags set -> 'other'
    expect(getMissedSummary().byReason.other.count).toBe(1);
  });

  it('accumulates totalMissedProfit and rounds to 4 decimals', () => {
    recordMissed(viableOp({ netProfit: 1.23456789 }), 'cooldown');
    recordMissed(viableOp({ netProfit: 2.5 }), 'cooldown');
    const summary = getMissedSummary();
    expect(summary.totalMissedProfit).toBeCloseTo(3.7346, 4);
  });

  it('treats a missing netProfit as 0', () => {
    recordMissed(viableOp({ netProfit: undefined }), 'cooldown');
    expect(getMissedSummary().totalMissedProfit).toBe(0);
  });

  it('computes captureRate as executed / (executed + missed) * 100', () => {
    recordExecuted();
    recordExecuted();
    recordExecuted();
    recordMissed(viableOp(), 'cooldown');
    // 3 executed, 1 missed -> 75%
    expect(getMissedSummary().captureRate).toBe(75);
  });

  it('captureRate is null when there is no activity at all', () => {
    expect(getMissedSummary().captureRate).toBeNull();
  });

  it('getMissedRecent returns most-recent-first, respecting the limit', () => {
    recordMissed(viableOp({ score: 1 }), 'cooldown');
    recordMissed(viableOp({ score: 2 }), 'cooldown');
    recordMissed(viableOp({ score: 3 }), 'cooldown');
    const recent = getMissedRecent(2);
    expect(recent.length).toBe(2);
    expect(recent[0].score).toBe(3); // most recent first
    expect(recent[1].score).toBe(2);
  });

  it('caps the in-memory buffer at 500 entries (oldest evicted first)', () => {
    for (let i = 0; i < 510; i++) {
      recordMissed(viableOp({ score: i }), 'cooldown');
    }
    const all = getMissedRecent(1000);
    expect(all.length).toBe(500);
    // the oldest 10 (scores 0-9) should have been evicted; most recent is 509
    expect(all[0].score).toBe(509);
    expect(all.some(r => r.score < 10)).toBe(false);
  });

  it('resetMissed clears the buffer and all aggregates', () => {
    recordExecuted();
    recordMissed(viableOp(), 'cooldown');
    resetMissed();
    const summary = getMissedSummary();
    expect(summary.totalMissedCount).toBe(0);
    expect(summary.totalExecutedCount).toBe(0);
    expect(summary.totalMissedProfit).toBe(0);
    expect(getMissedRecent(10).length).toBe(0);
    for (const bucket of Object.values(summary.byReason)) {
      expect(bucket.count).toBe(0);
      expect(bucket.profit).toBe(0);
    }
  });
});

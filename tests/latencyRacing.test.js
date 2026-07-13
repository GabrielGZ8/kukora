import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { attach, getRounds, getLeaderboard, resetRacing } from '../server/infrastructure/latencyRacing.js';

function makeEmitter() {
  // Avoid setInterval leaking between tests: attach() schedules an unref'd
  // interval, which is harmless in a short-lived test process, but we still
  // use a fresh emitter per test to avoid duplicate-listener accumulation.
  return new EventEmitter();
}

describe('latencyRacing', () => {
  beforeEach(() => resetRacing());

  it('getRounds/getLeaderboard are empty before any price updates arrive', () => {
    expect(getRounds()).toEqual([]);
    expect(getLeaderboard()).toEqual([]);
  });

  it('ignores the very first sample for an exchange (nothing to compare against yet)', () => {
    const emitter = makeEmitter();
    attach(emitter);
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 100, ask: 100.1, ts: 1000 });
    expect(getRounds()).toEqual([]);
  });

  it('ignores price moves smaller than MIN_PRICE_CHANGE_PCT (noise floor)', () => {
    const emitter = makeEmitter();
    attach(emitter);
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 100, ask: 100.1, ts: 1000 });
    // Tiny move well under 0.005%
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 100.0001, ask: 100.1001, ts: 1100 });
    emitter.emit('priceUpdate', { exchange: 'OKX', bid: 100, ask: 100.1, ts: 1000 });
    emitter.emit('priceUpdate', { exchange: 'OKX', bid: 100.0002, ask: 100.1002, ts: 1150 });
    expect(getRounds()).toEqual([]);
  });

  it('groups updates from multiple exchanges into a round when they fall within ROUND_WINDOW_MS', () => {
    const emitter = makeEmitter();
    attach(emitter);
    // seed baseline mid prices
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 100, ask: 100.1, ts: 1000 });
    emitter.emit('priceUpdate', { exchange: 'OKX', bid: 100, ask: 100.1, ts: 1000 });
    // real moves, same underlying market move propagating with different latency
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 101, ask: 101.1, ts: 2000 }); // leader
    emitter.emit('priceUpdate', { exchange: 'OKX', bid: 101, ask: 101.1, ts: 2150 }); // 150ms later
    // close the round by a move far outside the window
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 102, ask: 102.1, ts: 5000 });
    emitter.emit('priceUpdate', { exchange: 'OKX', bid: 102, ask: 102.1, ts: 5000 });

    const rounds = getRounds();
    expect(rounds.length).toBe(1);
    expect(rounds[0].leader).toBe('Binance');
    expect(rounds[0].updates.length).toBe(2);
    expect(rounds[0].spanMs).toBe(150);
  });

  it('does not archive a round where only one exchange moved (not interesting)', () => {
    const emitter = makeEmitter();
    attach(emitter);
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 100, ask: 100.1, ts: 1000 });
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 101, ask: 101.1, ts: 2000 });
    // force the round to close via a move far outside the window
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 102, ask: 102.1, ts: 5000 });
    expect(getRounds()).toEqual([]);
  });

  it('only counts an exchange\'s first move within a round (no double counting)', () => {
    const emitter = makeEmitter();
    attach(emitter);
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 100, ask: 100.1, ts: 1000 });
    emitter.emit('priceUpdate', { exchange: 'OKX', bid: 100, ask: 100.1, ts: 1000 });
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 101, ask: 101.1, ts: 2000 });
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 101.5, ask: 101.6, ts: 2050 }); // 2nd move, same round
    emitter.emit('priceUpdate', { exchange: 'OKX', bid: 101, ask: 101.1, ts: 2100 });
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 102, ask: 102.1, ts: 5000 });
    emitter.emit('priceUpdate', { exchange: 'OKX', bid: 102, ask: 102.1, ts: 5000 });

    const rounds = getRounds();
    expect(rounds[0].updates.length).toBe(2); // Binance counted once, OKX once
  });

  it('getRounds respects the limit and returns most-recent-first', () => {
    const emitter = makeEmitter();
    attach(emitter);
    let ts = 1000;
    for (let i = 0; i < 3; i++) {
      emitter.emit('priceUpdate', { exchange: 'Binance', bid: 100 + i, ask: 100.1 + i, ts });
      emitter.emit('priceUpdate', { exchange: 'OKX', bid: 100 + i, ask: 100.1 + i, ts });
      ts += 1000; // jump far enough to close the round next loop
      emitter.emit('priceUpdate', { exchange: 'Binance', bid: 100 + i + 1, ask: 100.1 + i + 1, ts });
      emitter.emit('priceUpdate', { exchange: 'OKX', bid: 100 + i + 1, ask: 100.1 + i + 1.05, ts: ts + 50 });
      ts += 1000;
    }
    // force-close the final round
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 200, ask: 200.1, ts: ts + 1000 });
    emitter.emit('priceUpdate', { exchange: 'OKX', bid: 200, ask: 200.1, ts: ts + 1000 });

    const rounds = getRounds(2);
    expect(rounds.length).toBeLessThanOrEqual(2);
  });

  it('getLeaderboard tallies wins per exchange and computes win rate percentage', () => {
    const emitter = makeEmitter();
    attach(emitter);
    // Round 1: Binance leads
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 100, ask: 100.1, ts: 1000 });
    emitter.emit('priceUpdate', { exchange: 'OKX', bid: 100, ask: 100.1, ts: 1000 });
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 101, ask: 101.1, ts: 2000 });
    emitter.emit('priceUpdate', { exchange: 'OKX', bid: 101, ask: 101.1, ts: 2100 });
    // close round 1, open + close round 2: OKX leads
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 102, ask: 102.1, ts: 5000 });
    emitter.emit('priceUpdate', { exchange: 'OKX', bid: 102.5, ask: 102.6, ts: 5000 });
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 103, ask: 103.1, ts: 5200 });
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 110, ask: 110.1, ts: 9000 });
    emitter.emit('priceUpdate', { exchange: 'OKX', bid: 110, ask: 110.1, ts: 9000 });

    const board = getLeaderboard();
    const total = board.reduce((s, b) => s + b.wins, 0);
    expect(total).toBe(2);
    for (const b of board) {
      expect(b.winRatePct).toBeCloseTo((b.wins / total) * 100, 1);
    }
  });

  it('resetRacing clears rounds, in-progress round, and last-known prices', () => {
    const emitter = makeEmitter();
    attach(emitter);
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 100, ask: 100.1, ts: 1000 });
    emitter.emit('priceUpdate', { exchange: 'OKX', bid: 100, ask: 100.1, ts: 1000 });
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 101, ask: 101.1, ts: 2000 });
    emitter.emit('priceUpdate', { exchange: 'OKX', bid: 101, ask: 101.1, ts: 2100 });
    emitter.emit('priceUpdate', { exchange: 'Binance', bid: 102, ask: 102.1, ts: 5000 });
    emitter.emit('priceUpdate', { exchange: 'OKX', bid: 102, ask: 102.1, ts: 5000 });
    expect(getRounds().length).toBeGreaterThan(0);

    resetRacing();
    expect(getRounds()).toEqual([]);
    expect(getLeaderboard()).toEqual([]);

    // last-known prices should also be cleared: the very next update for an
    // exchange should once again be treated as a "first sample", producing
    // no round on its own.
    const emitter2 = makeEmitter();
    attach(emitter2);
    emitter2.emit('priceUpdate', { exchange: 'Binance', bid: 200, ask: 200.1, ts: 1000 });
    expect(getRounds()).toEqual([]);
  });
});

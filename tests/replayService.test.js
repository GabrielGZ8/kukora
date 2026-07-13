import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { captureIfNoteworthy, listReplays, getReplayById, getBestReplay, resetReplays } from '../server/infrastructure/replayService.js';

function op(overrides = {}) {
  return {
    buyExchange: 'Binance',
    sellExchange: 'Kraken',
    viable: true,
    spreadPct: 0.5,
    netProfit: 10,
    score: 80,
    detectionLatencyMs: 5,
    ...overrides,
  };
}

function orderBooks() {
  return [
    { exchange: 'Binance', bid: 100, ask: 100.1, spreadPct: 0.1, source: 'ws', latencyMs: 5 },
    { exchange: 'Kraken', bid: 100.5, ask: 100.6, spreadPct: 0.1, source: 'ws', latencyMs: 8 },
  ];
}

describe('replayService (memory-buffer path — mongoose readyState=0 in tests)', () => {
  beforeEach(() => {
    resetReplays();
  });

  describe('captureIfNoteworthy', () => {
    it('does nothing when opportunities is empty/undefined', async () => {
      await captureIfNoteworthy([], orderBooks(), {}, null);
      expect(await listReplays()).toEqual([]);
      await captureIfNoteworthy(undefined, orderBooks(), {}, null);
      expect(await listReplays()).toEqual([]);
    });

    it('captures a viable opportunity the first time its pair is seen (transition_to_viable)', async () => {
      await captureIfNoteworthy([op()], orderBooks(), {}, null);
      const replays = await listReplays();
      expect(replays).toHaveLength(1);
      expect(replays[0].reason).toBe('transition_to_viable');
      expect(replays[0].pair).toBe('Binance→Kraken');
    });

    it('does not re-capture an unchanged viable opportunity on a subsequent tick (no meaningful spread improvement)', async () => {
      await captureIfNoteworthy([op()], orderBooks(), {}, null);
      await captureIfNoteworthy([op()], orderBooks(), {}, null);
      const replays = await listReplays();
      expect(replays).toHaveLength(1);
    });

    it('re-captures when spread improves by more than 10% over the last saved snapshot', async () => {
      await captureIfNoteworthy([op({ spreadPct: 0.5 })], orderBooks(), {}, null);
      await captureIfNoteworthy([op({ spreadPct: 0.6 })], orderBooks(), {}, null); // 20% improvement
      const replays = await listReplays();
      expect(replays).toHaveLength(2);
    });

    it('does not capture non-viable opportunities, but still tracks them via markSeen', async () => {
      await captureIfNoteworthy([op({ viable: false })], orderBooks(), {}, null);
      expect(await listReplays()).toEqual([]);
    });

    it('captures a transition from non-viable to viable', async () => {
      await captureIfNoteworthy([op({ viable: false })], orderBooks(), {}, null);
      await captureIfNoteworthy([op({ viable: true })], orderBooks(), {}, null);
      const replays = await listReplays();
      expect(replays).toHaveLength(1);
      expect(replays[0].reason).toBe('transition_to_viable');
    });

    it('always captures the matching opportunity when a trade is executed, tagged trade_executed', async () => {
      const executedTrade = { buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 12 };
      await captureIfNoteworthy([op()], orderBooks(), {}, executedTrade);
      const replays = await listReplays();
      const tradeSnap = replays.find(r => r.reason === 'trade_executed');
      expect(tradeSnap).toBeDefined();
      expect(tradeSnap.executed).toBe(true);
    });

    it('falls back to opportunities[0] when no opportunity matches the executed trade pair', async () => {
      const executedTrade = { buyExchange: 'OKX', sellExchange: 'Coinbase', netProfit: 5 };
      await captureIfNoteworthy([op()], orderBooks(), {}, executedTrade);
      const replays = await listReplays();
      const tradeSnap = replays.find(r => r.reason === 'trade_executed');
      expect(tradeSnap.pair).toBe('Binance→Kraken'); // opportunities[0]'s pair
    });
  });

  describe('listReplays', () => {
    it('returns snapshots most-recent-first', async () => {
      await captureIfNoteworthy([op({ buyExchange: 'Binance', sellExchange: 'Kraken' })], orderBooks(), {}, null);
      await captureIfNoteworthy([op({ buyExchange: 'OKX', sellExchange: 'Coinbase', spreadPct: 0.5 })], orderBooks(), {}, null);
      const replays = await listReplays();
      expect(replays[0].pair).toBe('OKX→Coinbase');
      expect(replays[1].pair).toBe('Binance→Kraken');
    });

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await captureIfNoteworthy([op({ buyExchange: 'Binance', sellExchange: 'Kraken', spreadPct: 0.5 + i })], orderBooks(), {}, null);
      }
      const replays = await listReplays(2);
      expect(replays).toHaveLength(2);
    });

    it('returns an empty array when nothing has been captured', async () => {
      expect(await listReplays()).toEqual([]);
    });
  });

  describe('getReplayById', () => {
    it('retrieves a memory-stored snapshot by its mem-N id', async () => {
      await captureIfNoteworthy([op()], orderBooks(), {}, null);
      const replays = await listReplays();
      const full = await getReplayById(replays[0].id);
      expect(full).not.toBeNull();
      expect(full.pair).toBe('Binance→Kraken');
      expect(full.orderBooks).toHaveLength(2);
    });

    it('returns null for a non-existent mem id', async () => {
      const result = await getReplayById('mem-9999');
      expect(result).toBeNull();
    });

    it('BUG REGRESSION: retrieves the CORRECT snapshot when multiple exist, for every id in the list', async () => {
      // Original bug: getReplayById() recomputed a position from the id
      // using the buffer's CURRENT length, mirroring the mapping — asking
      // for the most recent snapshot silently returned the oldest one
      // (and vice versa). Only a single-item buffer masked this in the
      // old test. Five distinct pairs here, each identifiable by netProfit.
      for (let i = 0; i < 5; i++) {
        await captureIfNoteworthy(
          [op({ buyExchange: `Ex${i}A`, sellExchange: `Ex${i}B`, netProfit: i })],
          orderBooks(), {}, null,
        );
      }
      const replays = await listReplays();
      expect(replays).toHaveLength(5);

      for (const r of replays) {
        const full = await getReplayById(r.id);
        expect(full).not.toBeNull();
        expect(full.opportunity.netProfit).toBe(r.netProfit);
      }
    });

    it('BUG REGRESSION: previously-issued ids stay valid after the buffer rotates past MAX_MEMORY_REPLAYS', async () => {
      // Original bug's second half: ids were derived from array position,
      // so once shift() dropped old entries every remaining position (and
      // therefore every previously-handed-out id) silently pointed at a
      // different snapshot. Sequence-based ids must survive rotation.
      await captureIfNoteworthy(
        [op({ buyExchange: 'Keep', sellExchange: 'Me', netProfit: 777 })],
        orderBooks(), {}, null,
      );
      const [kept] = await listReplays();

      // Push far past MAX_MEMORY_REPLAYS (200) so the kept snapshot's
      // underlying array position shifts repeatedly.
      for (let i = 0; i < 250; i++) {
        await captureIfNoteworthy(
          [op({ buyExchange: `Filler${i}A`, sellExchange: `Filler${i}B`, netProfit: -1 })],
          orderBooks(), {}, null,
        );
      }

      // The kept snapshot itself gets evicted once the buffer rotates past
      // it (rolling window by design) — confirm it's correctly gone (null,
      // not silently swapped for a different, wrong snapshot).
      const afterRotation = await getReplayById(kept.id);
      expect(afterRotation).toBeNull();

      // But an id captured AFTER the rotation settled must resolve to
      // exactly the right snapshot, not a neighbor.
      const stable = await listReplays(1);
      const stableFull = await getReplayById(stable[0].id);
      expect(stableFull.opportunity.netProfit).toBe(stable[0].netProfit);
    });

    it('returns null for a non-mem id when mongo is not connected', async () => {
      const result = await getReplayById('507f1f77bcf86cd799439011');
      expect(result).toBeNull();
    });
  });

  describe('getBestReplay', () => {
    it('returns null when there are no replays', async () => {
      expect(await getBestReplay()).toBeNull();
    });

    it('returns the snapshot with the highest opportunity.netProfit', async () => {
      await captureIfNoteworthy([op({ buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 5 })], orderBooks(), {}, null);
      await captureIfNoteworthy([op({ buyExchange: 'OKX', sellExchange: 'Coinbase', netProfit: 50, spreadPct: 0.9 })], orderBooks(), {}, null);
      const best = await getBestReplay();
      expect(best.opportunity.netProfit).toBe(50);
      expect(best.pair).toBe('OKX→Coinbase');
    });
  });

  describe('resetReplays', () => {
    it('clears the memory buffer and per-pair tracking', async () => {
      await captureIfNoteworthy([op()], orderBooks(), {}, null);
      expect(await listReplays()).toHaveLength(1);
      resetReplays();
      expect(await listReplays()).toEqual([]);
      // after reset, the same opportunity is treated as brand-new (transition_to_viable) again
      await captureIfNoteworthy([op()], orderBooks(), {}, null);
      const replays = await listReplays();
      expect(replays).toHaveLength(1);
      expect(replays[0].reason).toBe('transition_to_viable');
    });
  });
});

describe('replayService — Mongo-connected branches (checkpoint 27, closes coverage gap #4)', () => {
  const mongoose = require('mongoose');
  const ReplaySnapshot = require('../server/infrastructure/persistence/models/ReplaySnapshot');

  beforeEach(() => resetReplays());

  afterEach(() => {
    mongoose.connection.readyState = 0;
    vi.restoreAllMocks();
  });

  it('saveSnapshot(): Mongo ready — persists via ReplaySnapshot.create() in addition to the memory buffer', async () => {
    mongoose.connection.readyState = 1;
    const createSpy = vi.spyOn(ReplaySnapshot, 'create').mockResolvedValueOnce({ _id: 'x' });
    await captureIfNoteworthy([op()], orderBooks(), {}, null);
    expect(createSpy).toHaveBeenCalledTimes(1);
    // The memory buffer is still populated regardless of Mongo (always-on fallback).
    // Drop back to readyState=0 before reading it back, since listReplays() also
    // has a Mongo-ready branch and we're not spying on find() in this test.
    mongoose.connection.readyState = 0;
    expect(await listReplays()).toHaveLength(1);
  });

  it('saveSnapshot(): Mongo ready but create() rejects — non-fatal, memory buffer still has the snapshot', async () => {
    mongoose.connection.readyState = 1;
    vi.spyOn(ReplaySnapshot, 'create').mockRejectedValueOnce(new Error('synthetic Mongo write failure'));
    await expect(captureIfNoteworthy([op()], orderBooks(), {}, null)).resolves.toBeUndefined();
    mongoose.connection.readyState = 0; // same reason as above
    expect(await listReplays()).toHaveLength(1);
  });

  it('listReplays(): Mongo ready with documents — maps and returns them instead of the memory buffer', async () => {
    mongoose.connection.readyState = 1;
    const fakeDoc = {
      _id: { toString: () => 'mongo-id-1' }, ts: new Date(), reason: 'trade_executed', pair: 'Binance→Kraken',
      opportunity: { netProfit: 99, spreadPct: 1.2, score: 90 }, executedTrade: { id: 't1' }, detectionLatencyMs: 7,
    };
    vi.spyOn(ReplaySnapshot, 'find').mockReturnValue({
      sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [fakeDoc] }) }) }),
    });
    const replays = await listReplays();
    expect(replays).toEqual([{
      id: 'mongo-id-1', ts: fakeDoc.ts, reason: 'trade_executed', pair: 'Binance→Kraken',
      netProfit: 99, spreadPct: 1.2, score: 90, executed: true, detectionLatencyMs: 7,
    }]);
  });

  it('listReplays(): Mongo ready but query throws — falls back to the memory buffer instead of propagating', async () => {
    await captureIfNoteworthy([op()], orderBooks(), {}, null); // seed memory buffer first, readyState still 0 here
    mongoose.connection.readyState = 1;
    vi.spyOn(ReplaySnapshot, 'find').mockImplementation(() => { throw new Error('synthetic Mongo read failure'); });
    const replays = await listReplays();
    expect(replays).toHaveLength(1);
    expect(replays[0].pair).toBe('Binance→Kraken');
  });

  it('listReplays(): Mongo ready but returns zero documents — falls back to the memory buffer, not an empty array', async () => {
    await captureIfNoteworthy([op()], orderBooks(), {}, null); // seed memory buffer first, readyState still 0 here
    mongoose.connection.readyState = 1;
    vi.spyOn(ReplaySnapshot, 'find').mockReturnValue({
      sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [] }) }) }),
    });
    const replays = await listReplays();
    expect(replays).toHaveLength(1); // came from memory, not the (empty) Mongo result
  });

  it('getReplayById(): Mongo ready — returns the document via findById().lean()', async () => {
    mongoose.connection.readyState = 1;
    const fakeDoc = { _id: 'mongo-id-2', pair: 'OKX→Coinbase' };
    vi.spyOn(ReplaySnapshot, 'findById').mockReturnValue({ lean: async () => fakeDoc });
    const result = await getReplayById('507f1f77bcf86cd799439011');
    expect(result).toEqual(fakeDoc);
  });

  it('getReplayById(): Mongo ready but the query throws — returns null instead of propagating', async () => {
    mongoose.connection.readyState = 1;
    vi.spyOn(ReplaySnapshot, 'findById').mockImplementation(() => { throw new Error('synthetic Mongo read failure'); });
    const result = await getReplayById('507f1f77bcf86cd799439011');
    expect(result).toBeNull();
  });

  it('getBestReplay(): Mongo ready with a matching document — returns it directly, does not touch the memory buffer', async () => {
    // Populate the memory buffer with a lower-profit entry first (readyState still 0), to prove the Mongo result wins.
    await captureIfNoteworthy([op({ netProfit: 1 })], orderBooks(), {}, null);
    mongoose.connection.readyState = 1;
    const fakeDoc = { pair: 'Binance→OKX', opportunity: { netProfit: 500 } };
    vi.spyOn(ReplaySnapshot, 'find').mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => [fakeDoc] }) }),
    });
    const best = await getBestReplay();
    expect(best).toEqual(fakeDoc);
  });

  it('getBestReplay(): Mongo ready but query throws — falls back to the memory-buffer reduce', async () => {
    await captureIfNoteworthy([op({ netProfit: 42 })], orderBooks(), {}, null); // seed first, readyState still 0
    mongoose.connection.readyState = 1;
    vi.spyOn(ReplaySnapshot, 'find').mockImplementation(() => { throw new Error('synthetic Mongo read failure'); });
    const best = await getBestReplay();
    expect(best.opportunity.netProfit).toBe(42);
  });

  it('getBestReplay(): Mongo ready but zero documents today — falls back to the memory-buffer reduce', async () => {
    await captureIfNoteworthy([op({ netProfit: 17 })], orderBooks(), {}, null); // seed first, readyState still 0
    mongoose.connection.readyState = 1;
    vi.spyOn(ReplaySnapshot, 'find').mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => [] }) }),
    });
    const best = await getBestReplay();
    expect(best.opportunity.netProfit).toBe(17);
  });
});

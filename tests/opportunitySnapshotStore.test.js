'use strict';

/**
 * opportunitySnapshotStore.test.js
 *
 * Unit tests for server/domain/engines/opportunitySnapshotStore.js — the
 * server-side source of truth introduced to fix AUDIT FINDING 1 (CRITICAL):
 * live execution previously trusted opportunity.buyPrice/sellPrice/
 * detectedAt/slippagePct exactly as sent by the client. See
 * server/application/liveExecution.js's resolveTrustedOpportunity() for the
 * consumer side (covered in tests/liveExecution.test.js).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

async function loadStore() {
  vi.resetModules();
  const mod = await import('../server/domain/engines/opportunitySnapshotStore.js?t=' + Math.random());
  return mod.default || mod;
}

describe('opportunitySnapshotStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for an id that was never recorded', async () => {
    const store = await loadStore();
    expect(store.getSnapshot('nope')).toBeNull();
  });

  it('returns the recorded opportunity with its age in ms', async () => {
    const store = await loadStore();
    store.recordSnapshot({ id: 'a1', buyExchange: 'binance', sellExchange: 'kraken', buyPrice: 50000 });
    const snap = store.getSnapshot('a1');
    expect(snap).not.toBeNull();
    expect(snap.op.buyPrice).toBe(50000);
    expect(snap.ageMs).toBeGreaterThanOrEqual(0);
  });

  it('ignores opportunities with no id', async () => {
    const store = await loadStore();
    store.recordSnapshot({ buyExchange: 'binance', buyPrice: 50000 });
    expect(store._size()).toBe(0);
  });

  it('recordSnapshots() records a whole array at once', async () => {
    const store = await loadStore();
    store.recordSnapshots([
      { id: 'a1', buyPrice: 1 },
      { id: 'a2', buyPrice: 2 },
    ]);
    expect(store.getSnapshot('a1').op.buyPrice).toBe(1);
    expect(store.getSnapshot('a2').op.buyPrice).toBe(2);
  });

  it('overwrites the previous snapshot for the same id (latest detection wins)', async () => {
    const store = await loadStore();
    store.recordSnapshot({ id: 'a1', buyPrice: 50000 });
    store.recordSnapshot({ id: 'a1', buyPrice: 50123 });
    expect(store.getSnapshot('a1').op.buyPrice).toBe(50123);
    expect(store._size()).toBe(1);
  });

  it('keeps BTC and ETH opportunities on the same exchange-pair id separate', async () => {
    const store = await loadStore();
    store.recordSnapshot({ id: 'arb-binance-kraken', buyPrice: 50000 });
    store.recordSnapshot({ id: 'arb-binance-kraken', asset: 'ETH', buyPrice: 2500 });
    expect(store.getSnapshot('arb-binance-kraken').op.buyPrice).toBe(50000);
    expect(store.getSnapshot('arb-binance-kraken', 'ETH').op.buyPrice).toBe(2500);
    expect(store._size()).toBe(2);
  });

  it('expires an entry once its age exceeds TTL_MS, even before the sweep timer fires', async () => {
    vi.useFakeTimers();
    const store = await loadStore();
    store.recordSnapshot({ id: 'a1', buyPrice: 50000 });
    vi.advanceTimersByTime(store.TTL_MS + 1);
    expect(store.getSnapshot('a1')).toBeNull();
  });

  it('_clearForTests() empties the store', async () => {
    const store = await loadStore();
    store.recordSnapshot({ id: 'a1', buyPrice: 50000 });
    store._clearForTests();
    expect(store._size()).toBe(0);
    expect(store.getSnapshot('a1')).toBeNull();
  });
});

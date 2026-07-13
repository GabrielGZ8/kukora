import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('observabilityService — event buffer categories', () => {
  async function loadFresh() {
    vi.resetModules();
    const mod = await import('../server/infrastructure/observabilityService.js?t=' + Math.random());
    return mod.default || mod;
  }

  it('buffers and retrieves events for every pre-existing category (no regression)', async () => {
    const obs = await loadFresh();
    for (const category of ['OPPORTUNITY', 'EXECUTION', 'RISK', 'REBALANCE', 'CONFIG', 'SYSTEM', 'EXCHANGE']) {
      obs.emit(category, `${category.toLowerCase()}.test_event`, { probe: category });
      const events = obs.getEvents(category, 10);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].category).toBe(category);
      expect(events[0].data.probe).toBe(category);
    }
  });

  // AUDIT FINDING 8 fix (LOW): 'DEMO' (opportunityDetection.js's synthetic-
  // opportunity path, DEMO_MODE) and 'ENGINE' (backtestEngine.js's
  // run-result-shape-contract warning) were emitted on the live event bus
  // but had no entry in `_buffers`, so `emit()`'s `if (buf)` guard silently
  // dropped them from history — getEvents('DEMO'/'ENGINE') always returned
  // [] even immediately after emitting, and getAllRecentEvents() never
  // included them either. This reproduces the bug directly against the two
  // real call sites' category/event names.
  it('Hallazgo 8: DEMO events (opportunityDetection.js synthetic-opportunity) are now buffered and queryable', async () => {
    const obs = await loadFresh();
    expect(obs.getEvents('DEMO', 10)).toEqual([]); // nothing emitted yet
    obs.emit('DEMO', 'demo.synthetic_opportunity', { pair: 'Binance→Kraken', spreadPct: 1.2, netProfit: 4.5 });
    const events = obs.getEvents('DEMO', 10);
    expect(events.length).toBe(1);
    expect(events[0].category).toBe('DEMO');
    expect(events[0].event).toBe('demo.synthetic_opportunity');
    expect(events[0].data).toMatchObject({ pair: 'Binance→Kraken', netProfit: 4.5 });
  });

  it('Hallazgo 8: ENGINE events (backtestEngine.js contract-shape warning) are now buffered and queryable', async () => {
    const obs = await loadFresh();
    expect(obs.getEvents('ENGINE', 10)).toEqual([]);
    obs.emit('ENGINE', 'contract.backtest_run_result_shape_invalid', { strategyKey: 'sma_crossover' }, 'warn');
    const events = obs.getEvents('ENGINE', 10);
    expect(events.length).toBe(1);
    expect(events[0].category).toBe('ENGINE');
    expect(events[0].event).toBe('contract.backtest_run_result_shape_invalid');
    expect(events[0].level).toBe('warn');
  });

  it('Hallazgo 8: DEMO/ENGINE events now also appear in getAllRecentEvents()', async () => {
    const obs = await loadFresh();
    obs.emit('DEMO', 'demo.synthetic_opportunity', { pair: 'a→b' });
    obs.emit('ENGINE', 'contract.backtest_run_result_shape_invalid', { strategyKey: 'x' });
    const all = obs.getAllRecentEvents(50);
    expect(all.some(e => e.category === 'DEMO')).toBe(true);
    expect(all.some(e => e.category === 'ENGINE')).toBe(true);
  });

  it('an unknown/unbuffered category still does not throw (defensive default preserved)', async () => {
    const obs = await loadFresh();
    expect(() => obs.emit('TOTALLY_UNKNOWN_CATEGORY', 'x.y', {})).not.toThrow();
    expect(obs.getEvents('TOTALLY_UNKNOWN_CATEGORY', 10)).toEqual([]);
  });
});

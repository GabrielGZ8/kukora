import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('liveTradeLedger (Hallazgo 3b fix)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('starts at 0', async () => {
    const ledger = await import('../server/domain/wallet/liveTradeLedger.js?t=' + Math.random());
    expect(ledger.getTodaysLivePnl()).toBe(0);
  });

  it('accumulates recorded fills', async () => {
    const ledger = await import('../server/domain/wallet/liveTradeLedger.js?t=' + Math.random());
    ledger.recordLiveFill(12.5);
    ledger.recordLiveFill(-3.25);
    expect(ledger.getTodaysLivePnl()).toBeCloseTo(9.25, 8);
  });

  it('ignores non-finite/non-number input rather than corrupting the accumulator', async () => {
    const ledger = await import('../server/domain/wallet/liveTradeLedger.js?t=' + Math.random());
    ledger.recordLiveFill(10);
    ledger.recordLiveFill(NaN);
    ledger.recordLiveFill(undefined);
    ledger.recordLiveFill('5');
    expect(ledger.getTodaysLivePnl()).toBe(10);
  });

  it('avoids floating-point drift across many small fills (integer accumulator)', async () => {
    const ledger = await import('../server/domain/wallet/liveTradeLedger.js?t=' + Math.random());
    for (let i = 0; i < 1000; i++) ledger.recordLiveFill(0.1);
    expect(ledger.getTodaysLivePnl()).toBeCloseTo(100, 8);
  });

  it('resets when local midnight has passed since the last write', async () => {
    vi.useFakeTimers();
    try {
      const day1 = new Date(2026, 6, 10, 23, 0, 0); // July 10, 2026, 23:00 local
      vi.setSystemTime(day1);
      const ledger = await import('../server/domain/wallet/liveTradeLedger.js?t=' + Math.random());
      ledger.recordLiveFill(-40);
      expect(ledger.getTodaysLivePnl()).toBe(-40);

      const day2 = new Date(2026, 6, 11, 0, 5, 0); // 5 minutes into the next day
      vi.setSystemTime(day2);
      expect(ledger.getTodaysLivePnl()).toBe(0); // rolled over even without a new write
      ledger.recordLiveFill(-5);
      expect(ledger.getTodaysLivePnl()).toBe(-5); // yesterday's -40 does not carry over
    } finally {
      vi.useRealTimers();
    }
  });

  it('_resetForTest forces an immediate reset without waiting for midnight', async () => {
    const ledger = await import('../server/domain/wallet/liveTradeLedger.js?t=' + Math.random());
    ledger.recordLiveFill(-100);
    expect(ledger.getTodaysLivePnl()).toBe(-100);
    ledger._resetForTest();
    expect(ledger.getTodaysLivePnl()).toBe(0);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { recordExecutionJournalEntry, getJournal, getJournalSummary, resetJournal } from '../server/domain/analytics/executionJournal.js';

function opp(overrides = {}) {
  return {
    buyExchange: 'Binance', sellExchange: 'OKX',
    buyPrice: 50000, sellPrice: 50100,
    slippage: 5, slippageMethod: 'real',
    ...overrides,
  };
}
function books(buyAsk, sellBid) {
  return [
    { exchange: 'Binance', ask: buyAsk },
    { exchange: 'OKX', bid: sellBid },
  ];
}
function trade(overrides = {}) {
  return { id: 't1', amount: 0.01, ts: new Date().toISOString(), netProfit: 1, ...overrides };
}

describe('executionJournal', () => {
  beforeEach(() => resetJournal());

  it('records an entry with the expected shape', () => {
    const entry = recordExecutionJournalEntry(opp(), books(50000, 50100), trade());
    expect(entry).toMatchObject({
      tradeId: 't1',
      pair: 'Binance→OKX',
      estimatedSlippage: 5,
      actualBuyPrice: 50000,
      actualSellPrice: 50100,
    });
    expect(getJournal(10).length).toBe(1);
  });

  it('falls back to the detected price when the live order book is missing the exchange', () => {
    const entry = recordExecutionJournalEntry(opp(), [], trade());
    expect(entry.actualBuyPrice).toBe(50000);
    expect(entry.actualSellPrice).toBe(50100);
  });

  it('verdict is "sin_datos_l2" when there was no estimated slippage', () => {
    const entry = recordExecutionJournalEntry(opp({ slippage: 0 }), books(50000, 50100), trade());
    expect(entry.verdict).toBe('sin_datos_l2');
  });

  it('verdict is "conservador" when the book moved less than the model assumed', () => {
    // No price movement at all -> realizedAdverseMovementUSD = 0 <= estimatedSlippage(5)
    const entry = recordExecutionJournalEntry(opp({ slippage: 5 }), books(50000, 50100), trade());
    expect(entry.verdict).toBe('conservador');
  });

  it('verdict is "agresivo" when the book moved more against us than the model assumed', () => {
    // buy got much more expensive, sell got much cheaper -> large adverse movement
    const entry = recordExecutionJournalEntry(
      opp({ slippage: 1, buyPrice: 50000, sellPrice: 50100 }),
      books(50500, 49600),
      trade({ amount: 1 }),
    );
    expect(entry.verdict).toBe('agresivo');
  });

  it('computes realizedAdverseMovementUSD scaled by trade amount', () => {
    // buy moved +10 (worse), sell moved -10 (worse) -> adverse = (10 - (-10)) * amount
    const entry = recordExecutionJournalEntry(
      opp({ buyPrice: 50000, sellPrice: 50100 }),
      books(50010, 50090),
      trade({ amount: 2 }),
    );
    expect(entry.realizedAdverseMovementUSD).toBeCloseTo(40, 2); // (10 - (-10)) * 2
  });

  it('getJournal returns most-recent-first and respects the limit', () => {
    recordExecutionJournalEntry(opp(), books(50000, 50100), trade({ id: 't1' }));
    recordExecutionJournalEntry(opp(), books(50000, 50100), trade({ id: 't2' }));
    recordExecutionJournalEntry(opp(), books(50000, 50100), trade({ id: 't3' }));
    const recent = getJournal(2);
    expect(recent.length).toBe(2);
    expect(recent[0].tradeId).toBe('t3');
    expect(recent[1].tradeId).toBe('t2');
  });

  it('caps the journal at 200 entries', () => {
    for (let i = 0; i < 210; i++) {
      recordExecutionJournalEntry(opp(), books(50000, 50100), trade({ id: `t${i}` }));
    }
    expect(getJournal(1000).length).toBe(200);
  });

  describe('getJournalSummary', () => {
    it('returns a null-ish shape when the journal is empty', () => {
      expect(getJournalSummary()).toEqual({ count: 0, conservativePct: null, avgSlippageDelta: null });
    });

    it('excludes sin_datos_l2 entries from conservativePct/avgSlippageDelta', () => {
      recordExecutionJournalEntry(opp({ slippage: 0 }), books(50000, 50100), trade({ id: 't1' })); // sin_datos_l2
      recordExecutionJournalEntry(opp({ slippage: 5 }), books(50000, 50100), trade({ id: 't2' })); // conservador (no movement)
      const summary = getJournalSummary();
      expect(summary.count).toBe(2);
      expect(summary.withL2Count).toBe(1);
      expect(summary.conservativePct).toBe(100);
    });

    it('computes conservativePct as the share of conservative verdicts among L2-backed entries', () => {
      // one conservative, one aggressive
      recordExecutionJournalEntry(opp({ slippage: 5, buyPrice: 50000, sellPrice: 50100 }), books(50000, 50100), trade({ id: 't1' }));
      recordExecutionJournalEntry(
        opp({ slippage: 1, buyPrice: 50000, sellPrice: 50100 }),
        books(50500, 49600),
        trade({ id: 't2', amount: 1 }),
      );
      const summary = getJournalSummary();
      expect(summary.withL2Count).toBe(2);
      expect(summary.conservativePct).toBe(50);
    });
  });

  it('resetJournal clears all entries', () => {
    recordExecutionJournalEntry(opp(), books(50000, 50100), trade());
    resetJournal();
    expect(getJournal(10).length).toBe(0);
    expect(getJournalSummary().count).toBe(0);
  });
});

'use strict';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

// MOCKING NOTE (ver arbitrageOrchestrator.test.js para el precedente):
// liveInventoryReconciliation.js es CommonJS y resuelve liveExecution vía
// require() interno, accediendo a getExchangeClient como propiedad del
// objeto del módulo (no destructurada). vi.mock() con factory NO intercepta
// ese require() interno — verificado empíricamente (los 5 tests que usaban
// vi.mock() fallaban con "mockReturnValue is not a function" antes de este
// fix). El patrón correcto es: require() el mismo singleton CJS real y
// vi.spyOn() getExchangeClient sobre esa instancia compartida.
const liveExecution = require('../server/application/liveExecution');
const { checkInventory, THRESHOLDS } = require('../server/application/liveInventoryReconciliation');

let getExchangeClientSpy;

function mockClient(quoteBalance, baseBalance) {
  return {
    getBalance: vi.fn((asset) => {
      if (asset === 'USDT') return Promise.resolve(quoteBalance);
      return Promise.resolve(baseBalance);
    }),
  };
}

describe('liveInventoryReconciliation', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    getExchangeClientSpy = vi.spyOn(liveExecution, 'getExchangeClient');
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    getExchangeClientSpy.mockRestore();
  });

  it('reports "not configured" for exchanges missing API credentials', async () => {
    const result = await checkInventory({ exchanges: ['binance'] });
    expect(result.balances).toHaveLength(1);
    expect(result.balances[0]).toMatchObject({ exchange: 'binance', ok: false });
    expect(result.balances[0].error).toMatch(/not configured/);
  });

  it('fetches quote and base balances for a configured exchange', async () => {
    process.env.BINANCE_API_KEY = 'k';
    process.env.BINANCE_API_SECRET = 's';
    getExchangeClientSpy.mockReturnValue(mockClient(1000, 0.02));

    const result = await checkInventory({ exchanges: ['binance'] });
    expect(result.balances[0]).toMatchObject({
      exchange: 'binance', ok: true, quoteBalance: 1000, baseBalance: 0.02,
    });
    expect(result.totalQuote).toBe(1000);
  });

  it('never throws when a client call rejects — reports the error inline', async () => {
    process.env.BINANCE_API_KEY = 'k';
    process.env.BINANCE_API_SECRET = 's';
    getExchangeClientSpy.mockReturnValue({
      getBalance: vi.fn().mockRejectedValue(new Error('network down')),
    });

    const result = await checkInventory({ exchanges: ['binance'] });
    expect(result.balances[0]).toMatchObject({ exchange: 'binance', ok: false, error: 'network down' });
  });

  it('suggests no transfer when balances are evenly distributed', async () => {
    process.env.BINANCE_API_KEY = 'k'; process.env.BINANCE_API_SECRET = 's';
    process.env.BYBIT_API_KEY = 'k';   process.env.BYBIT_API_SECRET = 's';
    getExchangeClientSpy.mockImplementation(() => mockClient(500, 0.01));

    const result = await checkInventory({ exchanges: ['binance', 'bybit'] });
    expect(result.suggestions).toHaveLength(0);
  });

  it('suggests moving funds from the over-concentrated exchange to the lowest one', async () => {
    process.env.BINANCE_API_KEY = 'k'; process.env.BINANCE_API_SECRET = 's';
    process.env.BYBIT_API_KEY = 'k';   process.env.BYBIT_API_SECRET = 's';
    process.env.KRAKEN_API_KEY = 'k';  process.env.KRAKEN_API_SECRET = 's';

    getExchangeClientSpy.mockImplementation((exchange) => {
      if (exchange === 'binance') return mockClient(8000, 0.1); // dominant
      if (exchange === 'bybit')   return mockClient(1000, 0.1);
      return mockClient(1000, 0.1); // kraken — lowest, should be the suggested target
    });

    const result = await checkInventory({ exchanges: ['binance', 'bybit', 'kraken'] });
    expect(result.suggestions.length).toBeGreaterThan(0);
    const suggestion = result.suggestions[0];
    expect(suggestion.from).toBe('binance');
    expect(['bybit', 'kraken']).toContain(suggestion.to);
    expect(suggestion.amount).toBeGreaterThanOrEqual(THRESHOLDS.MIN_TRANSFER_USD);
  });

  it('does not suggest a transfer smaller than MIN_TRANSFER_USD', async () => {
    process.env.BINANCE_API_KEY = 'k'; process.env.BINANCE_API_SECRET = 's';
    process.env.BYBIT_API_KEY = 'k';   process.env.BYBIT_API_SECRET = 's';

    // 66/34 split is over the 65% concentration threshold, but the excess
    // in absolute dollars is tiny — should not generate a suggestion.
    getExchangeClientSpy.mockImplementation((exchange) => {
      if (exchange === 'binance') return mockClient(66, 0.001);
      return mockClient(34, 0.001);
    });

    const result = await checkInventory({ exchanges: ['binance', 'bybit'] });
    expect(result.suggestions).toHaveLength(0);
  });

  it('rejects an unsupported exchange name up front', async () => {
    const result = await checkInventory({ exchanges: ['deribit'] });
    expect(result.balances[0]).toMatchObject({ exchange: 'deribit', ok: false });
    expect(result.balances[0].error).toMatch(/not supported/);
  });

  it('defaults to checking every exchange in EXCHANGE_ENV_KEYS when none specified', async () => {
    const result = await checkInventory({});
    expect(result.balances.map(b => b.exchange).sort()).toEqual(['binance', 'bybit', 'coinbase', 'kraken', 'okx']);
  });

  it('includes checkedAt as an ISO timestamp', async () => {
    const result = await checkInventory({ exchanges: ['binance'] });
    expect(() => new Date(result.checkedAt).toISOString()).not.toThrow();
  });

  it('reactive suggestions are tagged trigger: "reactive"', async () => {
    process.env.BINANCE_API_KEY = 'k'; process.env.BINANCE_API_SECRET = 's';
    process.env.BYBIT_API_KEY = 'k';   process.env.BYBIT_API_SECRET = 's';
    getExchangeClientSpy.mockImplementation((exchange) => {
      if (exchange === 'binance') return mockClient(8000, 0.1);
      return mockClient(1000, 0.1);
    });

    const result = await checkInventory({ exchanges: ['binance', 'bybit'] });
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0].trigger).toBe('reactive');
  });

  describe('predictive suggestions (directional bias)', () => {
    let getAuditLogSpy;

    beforeEach(() => {
      getAuditLogSpy = vi.spyOn(liveExecution, 'getAuditLog');
    });
    afterEach(() => {
      getAuditLogSpy.mockRestore();
    });

    function crossTrade(buyExchange, sellExchange) {
      return { event: 'CROSS_EXECUTE_SUCCESS', buyExchange, sellExchange };
    }

    it('raises a predictive suggestion when an exchange has been consistently the seller and holds elevated (but sub-reactive-threshold) concentration', async () => {
      process.env.BINANCE_API_KEY = 'k'; process.env.BINANCE_API_SECRET = 's';
      process.env.BYBIT_API_KEY = 'k';   process.env.BYBIT_API_SECRET = 's';

      // binance at 50% concentration: above PREDICTIVE_MIN_CONCENTRATION (45%)
      // but below the reactive QUOTE_MAX_CONCENTRATION (65%).
      getExchangeClientSpy.mockImplementation((exchange) => {
        if (exchange === 'binance') return mockClient(500, 0.05);
        return mockClient(500, 0.05);
      });
      getAuditLogSpy.mockReturnValue(
        Array.from({ length: 10 }, () => crossTrade('bybit', 'binance')), // binance = sell side every time
      );

      const result = await checkInventory({ exchanges: ['binance', 'bybit'] });
      const predictive = result.suggestions.filter(s => s.trigger === 'predictive');
      expect(predictive).toHaveLength(1);
      expect(predictive[0]).toMatchObject({ from: 'binance', to: 'bybit', trigger: 'predictive' });
      expect(predictive[0].biasScore).toBeLessThan(0);
    });

    it('does not raise a predictive suggestion when the sell-biased exchange\'s concentration is still low', async () => {
      process.env.BINANCE_API_KEY = 'k'; process.env.BINANCE_API_SECRET = 's';
      process.env.BYBIT_API_KEY = 'k';   process.env.BYBIT_API_SECRET = 's';

      // binance (the sell-biased exchange below) sits at 30% concentration —
      // below PREDICTIVE_MIN_CONCENTRATION (45%), so no heads-up yet.
      getExchangeClientSpy.mockImplementation((exchange) => {
        if (exchange === 'binance') return mockClient(300, 0.05);
        return mockClient(700, 0.05);
      });
      getAuditLogSpy.mockReturnValue(
        Array.from({ length: 10 }, () => crossTrade('bybit', 'binance')), // binance = sell side
      );

      const result = await checkInventory({ exchanges: ['binance', 'bybit'] });
      expect(result.suggestions.filter(s => s.from === 'binance' && s.trigger === 'predictive')).toHaveLength(0);
    });

    it('does not raise a predictive suggestion for a "buyer"-biased exchange (draining, not accumulating, quote currency)', async () => {
      process.env.BINANCE_API_KEY = 'k'; process.env.BINANCE_API_SECRET = 's';
      process.env.BYBIT_API_KEY = 'k';   process.env.BYBIT_API_SECRET = 's';

      getExchangeClientSpy.mockImplementation((exchange) => {
        if (exchange === 'binance') return mockClient(500, 0.05);
        return mockClient(500, 0.05);
      });
      // binance is the buy side every time -> spends quote currency, does not accumulate it.
      // (bybit is consequently the consistent seller and legitimately CAN be
      // flagged predictively — this test only asserts binance itself is not.)
      getAuditLogSpy.mockReturnValue(
        Array.from({ length: 10 }, () => crossTrade('binance', 'bybit')),
      );

      const result = await checkInventory({ exchanges: ['binance', 'bybit'] });
      expect(result.suggestions.filter(s => s.from === 'binance' && s.trigger === 'predictive')).toHaveLength(0);
      expect(result.suggestions.filter(s => s.from === 'bybit' && s.trigger === 'predictive')).toHaveLength(1);
    });

    it('does not double-flag an exchange already covered by a reactive suggestion', async () => {
      process.env.BINANCE_API_KEY = 'k'; process.env.BINANCE_API_SECRET = 's';
      process.env.BYBIT_API_KEY = 'k';   process.env.BYBIT_API_SECRET = 's';

      // binance well above the reactive 65% threshold.
      getExchangeClientSpy.mockImplementation((exchange) => {
        if (exchange === 'binance') return mockClient(8000, 0.1);
        return mockClient(1000, 0.1);
      });
      getAuditLogSpy.mockReturnValue(
        Array.from({ length: 10 }, () => crossTrade('bybit', 'binance')),
      );

      const result = await checkInventory({ exchanges: ['binance', 'bybit'] });
      const binanceSuggestions = result.suggestions.filter(s => s.from === 'binance');
      expect(binanceSuggestions).toHaveLength(1);
      expect(binanceSuggestions[0].trigger).toBe('reactive');
    });

    it('ignores trades with no meaningful bias (mixed direction)', async () => {
      process.env.BINANCE_API_KEY = 'k'; process.env.BINANCE_API_SECRET = 's';
      process.env.BYBIT_API_KEY = 'k';   process.env.BYBIT_API_SECRET = 's';

      getExchangeClientSpy.mockImplementation((exchange) => {
        if (exchange === 'binance') return mockClient(500, 0.05);
        return mockClient(500, 0.05);
      });
      getAuditLogSpy.mockReturnValue([
        crossTrade('binance', 'bybit'),
        crossTrade('bybit', 'binance'),
        crossTrade('binance', 'bybit'),
        crossTrade('bybit', 'binance'),
      ]);

      const result = await checkInventory({ exchanges: ['binance', 'bybit'] });
      expect(result.suggestions.filter(s => s.trigger === 'predictive')).toHaveLength(0);
    });
  });
});

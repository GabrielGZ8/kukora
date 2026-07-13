import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  SUPPORTED_PAIRS, getUserConfig, setUserConfig, getOrderBooksForPair,
  fetchPriceREST, getDefaultConfig,
} from '../server/domain/analytics/multiPairService.js';

describe('multiPairService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('exposes the 5 supported pairs with required fields', () => {
    expect(Object.keys(SUPPORTED_PAIRS).sort()).toEqual(
      ['BNB/USDT', 'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'].sort()
    );
    for (const pair of Object.values(SUPPORTED_PAIRS)) {
      expect(pair).toHaveProperty('baseAsset');
      expect(pair).toHaveProperty('binanceSymbol');
    }
  });

  it('getDefaultConfig defaults to BTC/USDT, fully allocated, paper mode', () => {
    expect(getDefaultConfig()).toEqual({ pairs: ['BTC/USDT'], allocation: { 'BTC/USDT': 1.0 }, mode: 'paper' });
  });

  it('getUserConfig returns the default config for an unknown user', () => {
    expect(getUserConfig('unknown-user-xyz')).toEqual(getDefaultConfig());
  });

  describe('setUserConfig', () => {
    it('throws if none of the requested pairs are supported', () => {
      expect(() => setUserConfig('u1', { pairs: ['DOGE/USDT'] })).toThrow(/At least one valid pair required/);
    });

    it('filters out unsupported pairs but keeps the valid ones', () => {
      const cfg = setUserConfig('u2', { pairs: ['BTC/USDT', 'DOGE/USDT'] });
      expect(cfg.pairs).toEqual(['BTC/USDT']);
    });

    it('normalizes allocation to sum to 1.0 when weights are provided', () => {
      const cfg = setUserConfig('u3', {
        pairs: ['BTC/USDT', 'ETH/USDT'],
        allocation: { 'BTC/USDT': 3, 'ETH/USDT': 1 },
      });
      expect(cfg.allocation['BTC/USDT']).toBeCloseTo(0.75, 5);
      expect(cfg.allocation['ETH/USDT']).toBeCloseTo(0.25, 5);
    });

    it('falls back to equal weighting when no allocation is provided', () => {
      const cfg = setUserConfig('u4', { pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'] });
      expect(cfg.allocation['BTC/USDT']).toBeCloseTo(1 / 3, 5);
      expect(cfg.allocation['ETH/USDT']).toBeCloseTo(1 / 3, 5);
      expect(cfg.allocation['SOL/USDT']).toBeCloseTo(1 / 3, 5);
    });

    it('persists the config in memory so subsequent getUserConfig calls see it', () => {
      setUserConfig('u5', { pairs: ['ETH/USDT'] });
      expect(getUserConfig('u5').pairs).toEqual(['ETH/USDT']);
    });

    it('preserves the current mode when not explicitly provided', () => {
      setUserConfig('u6', { pairs: ['BTC/USDT'], mode: 'live' });
      const cfg = setUserConfig('u6', { pairs: ['ETH/USDT'] }); // mode omitted this time
      expect(cfg.mode).toBe('live');
    });

    it('defaults allocation weights of 0 for pairs not mentioned in the allocation object', () => {
      const cfg = setUserConfig('u7', {
        pairs: ['BTC/USDT', 'ETH/USDT'],
        allocation: { 'BTC/USDT': 1 }, // ETH/USDT omitted -> treated as 0
      });
      expect(cfg.allocation['BTC/USDT']).toBeCloseTo(1, 5);
      expect(cfg.allocation['ETH/USDT']).toBeCloseTo(0, 5);
    });
  });

  // NOTE: fetchPriceREST caches per-symbol for CACHE_TTL_MS (3s) with no exported
  // reset, and module state persists across tests in this file. To avoid any test
  // silently hitting another test's cached entry, every test below that exercises
  // a *successful* fetch uses a symbol no other test in this file touches.
  describe('fetchPriceREST', () => {
    it('returns null for an unsupported symbol without making a network call', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const result = await fetchPriceREST('DOGE/USDT');
      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetches and parses a valid bookTicker response', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ bidPrice: '100.5', askPrice: '101.0' }),
      })));
      const result = await fetchPriceREST('ETH/USDT');
      expect(result).toMatchObject({ exchange: 'Binance', symbol: 'ETH/USDT', bid: 100.5, ask: 101.0, source: 'rest' });
    });

    it('returns null when the upstream request fails', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
      const result = await fetchPriceREST('BNB/USDT');
      expect(result).toBeNull();
    });

    it('returns null when fetch throws (network error)', async () => {
      // Use a symbol not used elsewhere in this file to guarantee no cache hit
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
      const result = await fetchPriceREST('SOL/USDT');
      expect(result).toBeNull();
    });

    it('caches results for CACHE_TTL_MS and avoids a second network call', async () => {
      // XRP/USDT is untouched by any other fetchPriceREST-success test in this file
      const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ bidPrice: '1', askPrice: '2' }) }));
      vi.stubGlobal('fetch', fetchSpy);
      await fetchPriceREST('XRP/USDT');
      await fetchPriceREST('XRP/USDT');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('getOrderBooksForPair', () => {
    it('builds a minimal compatible order-book shape for REST-fallback pairs', async () => {
      // BNB/USDT's only prior use was a failed (ok:false) fetch, so this call
      // (3s TTL elapsed-or-not aside) issues a fresh request via mocked fetch.
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ bidPrice: '99', askPrice: '101' }),
      })));
      const books = await getOrderBooksForPair('BNB/USDT');
      expect(books.Binance).toMatchObject({ bid: 99, ask: 101, asset: 'BNB' });
      expect(books.Binance.depth.bids[0][0]).toBe(99);
    });

    it('returns an empty object when the REST fetch fails for a fallback pair', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
      const books = await getOrderBooksForPair('SOL/USDT');
      expect(books).toEqual({});
    });
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadModule() {
  vi.resetModules();
  const mod = await import('../server/application/liveExecution.js?t=' + Math.random());
  const liveExecution = mod.default || mod;
  return _autoSeedOpportunityStore(liveExecution);
}

// See tests/liveExecution.test.js for the full rationale (AUDIT FINDING 1
// fix): auto-seeds the server-side opportunity snapshot store with
// whatever opportunity object each test passes in, so hand-built fixtures
// keep working through the real resolveTrustedOpportunity() gate.
function _autoSeedOpportunityStore(liveExecution) {
  const store = liveExecution._opportunitySnapshotStore;
  const userLiveModeService = require('../server/infrastructure/userLiveModeService');
  const wrap = (fn) => (opportunity, ...rest) => {
    if (opportunity && opportunity.id) store.recordSnapshot(opportunity);
    if (rest[0]) userLiveModeService._forceEnableForTests(rest[0]);
    return fn(opportunity, ...rest);
  };
  liveExecution.executeLive = wrap(liveExecution.executeLive);
  liveExecution.executeCrossExchangeLive = wrap(liveExecution.executeCrossExchangeLive);
  return liveExecution;
}

describe('liveExecution — OKX and Coinbase support (audit item #3)', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  describe('getExchangeClient', () => {
    it('resolves an OKXClient for "okx", carrying the passphrase through', async () => {
      const liveExecution = await loadModule();
      const client = liveExecution.getExchangeClient('okx', 'key', 'secret', { passphrase: 'pp' });
      expect(client).toBeInstanceOf(liveExecution.OKXClient);
      expect(client.passphrase).toBe('pp');
    });

    it('falls back to OKX_API_PASSPHRASE env var when no passphrase is passed explicitly', async () => {
      process.env.OKX_API_PASSPHRASE = 'env-pp';
      const liveExecution = await loadModule();
      const client = liveExecution.getExchangeClient('okx', 'key', 'secret');
      expect(client.passphrase).toBe('env-pp');
    });

    it('resolves a CoinbaseClient for "coinbase"', async () => {
      const liveExecution = await loadModule();
      const client = liveExecution.getExchangeClient('coinbase', 'key', 'secret');
      expect(client).toBeInstanceOf(liveExecution.CoinbaseClient);
    });

    it('returns null for an exchange with no client (unchanged behavior)', async () => {
      const liveExecution = await loadModule();
      expect(liveExecution.getExchangeClient('kucoin', 'key', 'secret')).toBeNull();
    });
  });

  describe('OKXClient', () => {
    it('signs requests with OK-ACCESS-* headers and converts symbol to a dashed instId', async () => {
      const liveExecution = await loadModule();
      const fetchSpy = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ code: '0', data: [{ ordId: 'okx-123' }] }),
      }));
      vi.stubGlobal('fetch', fetchSpy);

      const client = liveExecution.getExchangeClient('okx', 'key', 'secret', { passphrase: 'pp' });
      const result = await client.placeMarketOrder('BTCUSDT', 'buy', 0.01);

      expect(result.orderId).toBe('okx-123');
      expect(result.instId).toBe('BTC-USDT');
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/v5/trade/order');
      expect(options.headers['OK-ACCESS-KEY']).toBe('key');
      expect(options.headers['OK-ACCESS-PASSPHRASE']).toBe('pp');
      expect(options.headers['OK-ACCESS-SIGN']).toBeTruthy();
      expect(JSON.parse(options.body)).toMatchObject({ instId: 'BTC-USDT', side: 'buy', ordType: 'market' });
    });

    it('sets the x-simulated-trading header in demo mode instead of pointing at a different host', async () => {
      const liveExecution = await loadModule();
      const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: '0', data: [{}] }) }));
      vi.stubGlobal('fetch', fetchSpy);

      const client = liveExecution.getExchangeClient('okx', 'key', 'secret', { passphrase: 'pp' });
      client.testnet = true;
      await client.placeMarketOrder('BTCUSDT', 'buy', 0.01);

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toContain('www.okx.com'); // same host as mainnet — see file header caveat
      expect(options.headers['x-simulated-trading']).toBe('1');
    });

    it('throws a clear error on a non-zero OKX response code', async () => {
      const liveExecution = await loadModule();
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ code: '51008', msg: 'Order failed. Insufficient balance' }),
      })));
      const client = liveExecution.getExchangeClient('okx', 'key', 'secret', { passphrase: 'pp' });
      await expect(client.placeMarketOrder('BTCUSDT', 'buy', 0.01)).rejects.toThrow(/51008/);
    });

    it('normalizes a filled OKX order status via _normalizeOrderStatus through preflightless getOrder shape', async () => {
      const liveExecution = await loadModule();
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ code: '0', data: [{ state: 'filled', accFillSz: '0.01', avgPx: '50000' }] }),
      })));
      const client = liveExecution.getExchangeClient('okx', 'key', 'secret', { passphrase: 'pp' });
      const status = await client.getOrder('BTCUSDT', 'okx-123');
      expect(status).toMatchObject({ state: 'filled', accFillSz: '0.01', avgPx: '50000' });
    });
  });

  describe('CoinbaseClient', () => {
    it('signs requests with CB-ACCESS-* headers and places a market order via order_configuration', async () => {
      const liveExecution = await loadModule();
      const fetchSpy = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ order_id: 'cb-456', success_response: { order_id: 'cb-456' } }),
      }));
      vi.stubGlobal('fetch', fetchSpy);

      const client = liveExecution.getExchangeClient('coinbase', 'key', 'secret');
      const result = await client.placeMarketOrder('BTCUSDT', 'BUY', 0.01);

      expect(result.orderId).toBe('cb-456');
      expect(result.productId).toBe('BTC-USDT');
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toContain('/api/v3/brokerage/orders');
      expect(options.headers['CB-ACCESS-KEY']).toBe('key');
      expect(options.headers['CB-ACCESS-SIGN']).toBeTruthy();
      const body = JSON.parse(options.body);
      expect(body.order_configuration.market_market_ioc.base_size).toBe('0.01');
    });

    it('uses limit_limit_gtc with post_only for LIMIT_MAKER orders', async () => {
      const liveExecution = await loadModule();
      const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ order_id: 'cb-789' }) }));
      vi.stubGlobal('fetch', fetchSpy);

      const client = liveExecution.getExchangeClient('coinbase', 'key', 'secret');
      await client.placeOrder('BTCUSDT', 'SELL', 0.01, { type: 'LIMIT_MAKER', price: 51000 });

      const [, options] = fetchSpy.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.order_configuration.limit_limit_gtc).toMatchObject({
        base_size: '0.01', limit_price: '51000', post_only: true,
      });
    });

    it('maps account balances into the shared {asset, free} shape used by preflightCheck', async () => {
      const liveExecution = await loadModule();
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ accounts: [{ currency: 'USDT', available_balance: { value: '1234.5' } }] }),
      })));
      const client = liveExecution.getExchangeClient('coinbase', 'key', 'secret');
      const balance = await client.getBalance('USDT');
      expect(balance).toBe(1234.5);
    });
  });

  describe('executeLive — okx passphrase gate', () => {
    it('rejects live execution on okx when OKX_API_PASSPHRASE is not configured', async () => {
      process.env.LIVE_TRADING_ENABLED = 'true';
      process.env.OKX_API_KEY = 'k';
      process.env.OKX_API_SECRET = 's';
      delete process.env.OKX_API_PASSPHRASE;
      const liveExecution = await loadModule();
      liveExecution.setUserMode('u1', 'live');
      await expect(
        liveExecution.executeLive({ id: 'op1', buyExchange: 'okx' }, 'u1', 0.01)
      ).rejects.toThrow(/OKX_API_PASSPHRASE/);
    });
  });
});

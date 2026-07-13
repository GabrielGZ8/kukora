import { describe, it, expect } from 'vitest';
import {
  registerExchange, getExchangeNames, getEnabledExchangeNames,
  getExchange, getAllExchanges, getTakerFee,
} from '../server/infrastructure/exchangeRegistry.js';

describe('exchangeRegistry', () => {
  it('registers the 5 default exchanges at module load', () => {
    expect(getExchangeNames().sort()).toEqual(['Binance', 'Bybit', 'Coinbase', 'Kraken', 'OKX'].sort());
  });

  it('getEnabledExchangeNames returns only enabled exchanges', () => {
    expect(getEnabledExchangeNames().length).toBe(5); // all 5 are enabled by default
  });

  it('getExchange returns the full descriptor for a known exchange', () => {
    const binance = getExchange('Binance');
    expect(binance).toMatchObject({ name: 'Binance', id: 'binance', enabled: true });
    expect(binance.fees).toEqual({ maker: 0.001, taker: 0.001 });
  });

  it('getExchange returns null for an unknown exchange', () => {
    expect(getExchange('NoSuchExchange')).toBeNull();
  });

  it('getAllExchanges returns descriptor objects, not just names', () => {
    const all = getAllExchanges();
    expect(all.length).toBe(5);
    expect(all[0]).toHaveProperty('wsUrl');
    expect(all[0]).toHaveProperty('fees');
  });

  it('getTakerFee returns the taker fee as a decimal for a known exchange', () => {
    expect(getTakerFee('Kraken')).toBe(0.0026);
    expect(getTakerFee('OKX')).toBe(0.001);
  });

  it('getTakerFee returns null for an unknown exchange', () => {
    expect(getTakerFee('NoSuchExchange')).toBeNull();
  });

  describe('registerExchange — plugin contract (audit I-2)', () => {
    it('throws if descriptor.name is missing', () => {
      expect(() => registerExchange({ id: 'x' })).toThrow(/descriptor.name is required/);
    });

    it('throws if descriptor.id is missing', () => {
      expect(() => registerExchange({ name: 'X' })).toThrow(/descriptor.id is required/);
    });

    it('allows registering a new (6th) exchange without touching any other module', () => {
      registerExchange({
        name: 'TestEx', id: 'testex', enabled: true,
        wsUrl: 'wss://test.example.com', pairs: ['BTC'],
        fees: { maker: 0.001, taker: 0.002 },
      });
      expect(getExchangeNames()).toContain('TestEx');
      expect(getEnabledExchangeNames()).toContain('TestEx');
      expect(getTakerFee('TestEx')).toBe(0.002);
    });

    it('a disabled exchange is excluded from getEnabledExchangeNames but still queryable via getExchange', () => {
      registerExchange({
        name: 'DisabledEx', id: 'disabledex', enabled: false,
        wsUrl: 'wss://disabled.example.com', pairs: ['BTC'],
        fees: { maker: 0.001, taker: 0.001 },
      });
      expect(getEnabledExchangeNames()).not.toContain('DisabledEx');
      expect(getExchangeNames()).toContain('DisabledEx');
      expect(getExchange('DisabledEx')).not.toBeNull();
    });

    it('re-registering the same name overwrites the previous descriptor', () => {
      registerExchange({ name: 'Overwritable', id: 'ov1', enabled: true, fees: { maker: 0.001, taker: 0.001 } });
      registerExchange({ name: 'Overwritable', id: 'ov2', enabled: true, fees: { maker: 0.002, taker: 0.002 } });
      expect(getExchange('Overwritable').id).toBe('ov2');
      expect(getTakerFee('Overwritable')).toBe(0.002);
    });
  });
});

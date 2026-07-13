import { describe, it, expect } from 'vitest';
import {
  validateAlertCreate,
  validateAlertUpdate,
  validateWatchlistSave,
  validatePortfolioCreate,
  parsePagination,
  validateArbitrageConfig,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../server/domain/validation.js';

describe('validateAlertCreate', () => {
  it('accepts a well-formed alert', () => {
    const r = validateAlertCreate({ coinId: 'bitcoin', coinName: 'Bitcoin', condition: 'above', price: 50000 });
    expect(r.valid).toBe(true);
    expect(r.value).toEqual({ coinId: 'bitcoin', coinName: 'Bitcoin', condition: 'above', price: 50000 });
  });

  it('rejects a non-object body', () => {
    expect(validateAlertCreate(null).valid).toBe(false);
    expect(validateAlertCreate('x').valid).toBe(false);
  });

  it('rejects missing/empty coinId', () => {
    const r = validateAlertCreate({ coinName: 'Bitcoin', condition: 'above', price: 1 });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/coinId/);
  });

  it('rejects a condition other than above/below', () => {
    const r = validateAlertCreate({ coinId: 'x', coinName: 'X', condition: 'sideways', price: 1 });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/condition/);
  });

  it('rejects non-positive or non-finite price', () => {
    for (const price of [0, -5, NaN, Infinity, 'abc']) {
      const r = validateAlertCreate({ coinId: 'x', coinName: 'X', condition: 'above', price });
      expect(r.valid).toBe(false);
    }
  });

  it('rejects price above the 1e12 ceiling', () => {
    const r = validateAlertCreate({ coinId: 'x', coinName: 'X', condition: 'above', price: 1e13 });
    expect(r.valid).toBe(false);
  });

  it('trims whitespace from string fields and rejects empty-after-trim', () => {
    const ok = validateAlertCreate({ coinId: '  bitcoin  ', coinName: 'Bitcoin', condition: 'below', price: 1 });
    expect(ok.valid).toBe(true);
    expect(ok.value.coinId).toBe('bitcoin');

    const bad = validateAlertCreate({ coinId: '   ', coinName: 'Bitcoin', condition: 'below', price: 1 });
    expect(bad.valid).toBe(false);
  });
});

describe('validateAlertUpdate', () => {
  it('allows a partial update with only one field', () => {
    const r = validateAlertUpdate({ triggered: true });
    expect(r.valid).toBe(true);
    expect(r.value).toEqual({ triggered: true });
  });

  it('allows an empty body (no fields to update)', () => {
    const r = validateAlertUpdate({});
    expect(r.valid).toBe(true);
    expect(r.value).toEqual({});
  });

  it('rejects an invalid condition if provided', () => {
    const r = validateAlertUpdate({ condition: 'up' });
    expect(r.valid).toBe(false);
  });

  it('rejects an invalid price if provided', () => {
    expect(validateAlertUpdate({ price: -1 }).valid).toBe(false);
  });

  it('coerces triggered to a boolean', () => {
    const r = validateAlertUpdate({ triggered: 1 });
    expect(r.value.triggered).toBe(true);
  });
});

describe('validateWatchlistSave', () => {
  it('accepts a valid coins array', () => {
    const r = validateWatchlistSave({ coins: ['bitcoin', 'ethereum'] });
    expect(r.valid).toBe(true);
    expect(r.value.coins).toEqual(['bitcoin', 'ethereum']);
  });

  it('rejects a non-array coins field', () => {
    expect(validateWatchlistSave({ coins: 'bitcoin' }).valid).toBe(false);
  });

  it('rejects more than MAX_COINS (200) entries', () => {
    const coins = Array.from({ length: 201 }, (_, i) => `coin${i}`);
    const r = validateWatchlistSave({ coins });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/200/);
  });

  it('rejects a non-string / empty entry inside the array', () => {
    expect(validateWatchlistSave({ coins: ['bitcoin', ''] }).valid).toBe(false);
    expect(validateWatchlistSave({ coins: ['bitcoin', 123] }).valid).toBe(false);
  });
});

describe('validatePortfolioCreate', () => {
  const base = { coinId: 'bitcoin', coinName: 'Bitcoin', symbol: 'BTC', quantity: 1, entryPrice: 50000 };

  it('accepts a well-formed portfolio entry', () => {
    const r = validatePortfolioCreate(base);
    expect(r.valid).toBe(true);
    expect(r.value).toMatchObject({ coinId: 'bitcoin', symbol: 'BTC', quantity: 1, entryPrice: 50000 });
  });

  it('rejects missing symbol', () => {
    const { symbol, ...rest } = base;
    expect(validatePortfolioCreate(rest).valid).toBe(false);
  });

  it('rejects non-positive quantity or entryPrice', () => {
    expect(validatePortfolioCreate({ ...base, quantity: 0 }).valid).toBe(false);
    expect(validatePortfolioCreate({ ...base, entryPrice: -1 }).valid).toBe(false);
  });

  it('accepts an optional valid image and entryDate', () => {
    const r = validatePortfolioCreate({ ...base, image: 'https://x.png', entryDate: '2024-01-01' });
    expect(r.valid).toBe(true);
    expect(r.value.image).toBe('https://x.png');
    expect(r.value.entryDate).toBeInstanceOf(Date);
  });

  it('rejects an invalid entryDate', () => {
    const r = validatePortfolioCreate({ ...base, entryDate: 'not-a-date' });
    expect(r.valid).toBe(false);
  });

  it('rejects quantity/entryPrice above their respective ceilings', () => {
    expect(validatePortfolioCreate({ ...base, quantity: 1e10 }).valid).toBe(false);
    expect(validatePortfolioCreate({ ...base, entryPrice: 1e13 }).valid).toBe(false);
  });
});

describe('parsePagination', () => {
  it('uses defaults when limit/offset are absent or invalid', () => {
    expect(parsePagination({})).toEqual({ limit: DEFAULT_LIMIT, offset: 0 });
    expect(parsePagination({ limit: 'abc', offset: 'xyz' })).toEqual({ limit: DEFAULT_LIMIT, offset: 0 });
    expect(parsePagination({ limit: '-5', offset: '-10' })).toEqual({ limit: DEFAULT_LIMIT, offset: 0 });
  });

  it('caps limit at MAX_LIMIT', () => {
    expect(parsePagination({ limit: '99999' })).toEqual({ limit: MAX_LIMIT, offset: 0 });
  });

  it('parses valid limit/offset', () => {
    expect(parsePagination({ limit: '20', offset: '40' })).toEqual({ limit: 20, offset: 40 });
  });
});

describe('validateArbitrageConfig — financial safety floors (audit 3.4 highlight)', () => {
  it('rejects an empty body', () => {
    expect(validateArbitrageConfig({}).valid).toBe(false);
    expect(validateArbitrageConfig(null).valid).toBe(false);
    expect(validateArbitrageConfig([]).valid).toBe(false);
  });

  it('blocks a maxDailyLossUSD of 0 (would disable the daily-loss circuit breaker)', () => {
    const r = validateArbitrageConfig({ maxDailyLossUSD: 0 });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/maxDailyLossUSD/);
  });

  it('accepts a valid negative maxDailyLossUSD within range', () => {
    const r = validateArbitrageConfig({ maxDailyLossUSD: -500 });
    expect(r.valid).toBe(true);
  });

  it('blocks maxDrawdownPct outside [0.5, 100]', () => {
    expect(validateArbitrageConfig({ maxDrawdownPct: 0 }).valid).toBe(false);
    expect(validateArbitrageConfig({ maxDrawdownPct: 150 }).valid).toBe(false);
    expect(validateArbitrageConfig({ maxDrawdownPct: 10 }).valid).toBe(true);
  });

  it('blocks tradeAmountBTC outside [0.001, 0.5]', () => {
    expect(validateArbitrageConfig({ tradeAmountBTC: 0 }).valid).toBe(false);
    expect(validateArbitrageConfig({ tradeAmountBTC: 1 }).valid).toBe(false);
    expect(validateArbitrageConfig({ tradeAmountBTC: 0.05 }).valid).toBe(true);
  });

  it('rejects a non-finite floor value (e.g. string that does not coerce)', () => {
    const r = validateArbitrageConfig({ maxConsecutiveFailures: 'lots' });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/maxConsecutiveFailures/);
  });

  it('requires activeExchanges to be a non-empty array when provided', () => {
    expect(validateArbitrageConfig({ activeExchanges: [] }).valid).toBe(false);
    expect(validateArbitrageConfig({ activeExchanges: 'binance' }).valid).toBe(false);
    expect(validateArbitrageConfig({ activeExchanges: ['binance', 'okx'] }).valid).toBe(true);
  });

  it('requires scoringWeights to sum to ~1.0', () => {
    expect(validateArbitrageConfig({ scoringWeights: { a: 0.5, b: 0.3 } }).valid).toBe(false);
    expect(validateArbitrageConfig({ scoringWeights: { a: 0.6, b: 0.4 } }).valid).toBe(true);
    // within the 0.01 tolerance
    expect(validateArbitrageConfig({ scoringWeights: { a: 0.505, b: 0.5 } }).valid).toBe(true);
  });

  it('rejects an invalid feeMode / capitalAllocationMode', () => {
    expect(validateArbitrageConfig({ feeMode: 'vip' }).valid).toBe(false);
    expect(validateArbitrageConfig({ feeMode: 'maker' }).valid).toBe(true);
    expect(validateArbitrageConfig({ capitalAllocationMode: 'random' }).valid).toBe(false);
    expect(validateArbitrageConfig({ capitalAllocationMode: 'dynamic' }).valid).toBe(true);
  });

  it('rejects any attempt to set tradingMode (read-only, env-controlled)', () => {
    const r = validateArbitrageConfig({ tradingMode: 'live' });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/read-only/);
  });

  it('passes through the full body unmodified when valid', () => {
    const body = { maxDailyLossUSD: -200, feeMode: 'taker' };
    const r = validateArbitrageConfig(body);
    expect(r.valid).toBe(true);
    expect(r.value).toBe(body);
  });
});

'use strict';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const rateLimiter = require('../server/infrastructure/exchangeRateLimiter');
const ORIGINAL_ENV = { ...process.env };
describe('exchangeRateLimiter', () => {
  beforeEach(() => {
    rateLimiter._resetAll();
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.useRealTimers();
  });
  it('allows requests within capacity', () => {
    expect(() => rateLimiter.assertWithinLimit('binance', 1)).not.toThrow();
  });
  it('throws RateLimitError once capacity is exhausted', () => {
    // Default binance capacity is 20; burn it all in the same tick so
    // refill (time-based) doesn't top it back up mid-loop.
    for (let i = 0; i < 20; i++) rateLimiter.assertWithinLimit('binance', 1);
    expect(() => rateLimiter.assertWithinLimit('binance', 1)).toThrow(/Rate limit exceeded/);
  });
  it('thrown error has rateLimited:true and the exchange name', () => {
    for (let i = 0; i < 20; i++) rateLimiter.assertWithinLimit('binance', 1);
    try {
      rateLimiter.assertWithinLimit('binance', 1);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(rateLimiter.RateLimitError);
      expect(e.rateLimited).toBe(true);
      expect(e.exchange).toBe('binance');
    }
  });
  it('tracks each exchange independently', () => {
    for (let i = 0; i < 20; i++) rateLimiter.assertWithinLimit('binance', 1);
    expect(() => rateLimiter.assertWithinLimit('binance', 1)).toThrow();
    // bybit's bucket is untouched
    expect(() => rateLimiter.assertWithinLimit('bybit', 1)).not.toThrow();
  });
  it('refills over time', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 20; i++) rateLimiter.assertWithinLimit('binance', 1);
    expect(() => rateLimiter.assertWithinLimit('binance', 1)).toThrow();
    // Default binance refill is 10/sec; advance 1s -> ~10 tokens back.
    vi.advanceTimersByTime(1000);
    expect(() => rateLimiter.assertWithinLimit('binance', 1)).not.toThrow();
  });
  it('is case-insensitive on exchange name', () => {
    for (let i = 0; i < 20; i++) rateLimiter.assertWithinLimit('Binance', 1);
    expect(() => rateLimiter.assertWithinLimit('BINANCE', 1)).toThrow();
  });
  it('respects EXCHANGE_RATE_LIMIT_<EXCHANGE> env override', () => {
    process.env.EXCHANGE_RATE_LIMIT_OKX = '2:1';
    rateLimiter._resetAll();
    rateLimiter.assertWithinLimit('okx', 1);
    rateLimiter.assertWithinLimit('okx', 1);
    expect(() => rateLimiter.assertWithinLimit('okx', 1)).toThrow();
  });
  it('getStatus reports capacity, refill rate, and available tokens for known exchanges', () => {
    const status = rateLimiter.getStatus();
    expect(status).toHaveProperty('binance');
    expect(status).toHaveProperty('bybit');
    expect(status).toHaveProperty('kraken');
    expect(status.binance).toMatchObject({ exchange: 'binance', capacity: 20, refillPerSecond: 10 });
    expect(status.binance.available).toBeLessThanOrEqual(20);
  });
  it('a single call consuming more than capacity always throws', () => {
    expect(() => rateLimiter.assertWithinLimit('kraken', 9999)).toThrow(/Rate limit exceeded/);
  });
});

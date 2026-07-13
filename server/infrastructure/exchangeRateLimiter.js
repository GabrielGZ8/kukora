'use strict';
/**
 * exchangeRateLimiter.js — Fase 3 pendiente #2: per-exchange rate limiting
 * for live order placement.
 *
 * A naive bug (or a stray retry loop) in the live execution path could
 * otherwise hammer an exchange's REST API fast enough to trip *their*
 * rate limits, which typically respond with temporary IP/key bans —
 * exactly the failure mode you don't want mid-trade. This is a simple
 * token-bucket limiter, enforced client-side, *before* any network call
 * goes out, so our own artificial ceiling is always well under the
 * exchange's real one.
 *
 * Deliberately fails fast (throws) rather than queuing/backing off: for
 * arbitrage, a delayed order is often worse than a rejected one (the
 * opportunity is already stale — see the `detectedAt` staleness checks in
 * liveExecution.js), so callers should treat a RateLimitError as "abort
 * this leg" rather than "retry after a pause".
 */

const { logger } = require('./logger');

// Conservative defaults, well under each exchange's real published limits
// (which vary by endpoint/tier and are documented per-exchange upstream).
// These exist to protect *us* from our own bugs, not to approach the
// exchange's actual ceiling.
const DEFAULT_CONFIGS = {
  binance:  { capacity: 20, refillPerSecond: 10 },
  bybit:    { capacity: 20, refillPerSecond: 10 },
  kraken:   { capacity: 15, refillPerSecond: 1 },  // Kraken's tiered nonce window is the strictest of the five
  okx:      { capacity: 20, refillPerSecond: 8 },  // OKX's published trade-endpoint limit is higher; kept conservative
  coinbase: { capacity: 15, refillPerSecond: 8 },  // Advanced Trade private endpoints
};

// Fallback for any exchange not in DEFAULT_CONFIGS and without an env
// override — conservative on purpose since we know nothing about it yet.
const FALLBACK_CONFIG = { capacity: 10, refillPerSecond: 5 };

class RateLimitError extends Error {
  constructor(exchange, available, cost) {
    super(`Rate limit exceeded for ${exchange}: requested ${cost}, only ${available.toFixed(2)} tokens available`);
    this.name = 'RateLimitError';
    this.rateLimited = true;
    this.exchange = exchange;
  }
}

// exchange (lowercase) -> { capacity, refillPerSecond, tokens, lastRefill }
const _buckets = new Map();

function _envOverride(exchange) {
  const raw = process.env[`EXCHANGE_RATE_LIMIT_${exchange.toUpperCase()}`];
  if (!raw) return null;
  const [capStr, refillStr] = raw.split(':');
  const capacity = parseFloat(capStr);
  const refillPerSecond = parseFloat(refillStr);
  if (!Number.isFinite(capacity) || !Number.isFinite(refillPerSecond)) return null;
  return { capacity, refillPerSecond };
}

function _configFor(exchange) {
  return _envOverride(exchange) || DEFAULT_CONFIGS[exchange] || FALLBACK_CONFIG;
}

function _getBucket(exchangeRaw) {
  const exchange = String(exchangeRaw).toLowerCase();
  let bucket = _buckets.get(exchange);
  const config = _configFor(exchange);

  if (!bucket) {
    bucket = { ...config, tokens: config.capacity, lastRefill: Date.now() };
    _buckets.set(exchange, bucket);
  } else if (bucket.capacity !== config.capacity || bucket.refillPerSecond !== config.refillPerSecond) {
    // Env override changed (e.g. a test set EXCHANGE_RATE_LIMIT_X then
    // called _resetAll()) — pick it up without losing accumulated tokens
    // beyond the new capacity.
    bucket.capacity = config.capacity;
    bucket.refillPerSecond = config.refillPerSecond;
    bucket.tokens = Math.min(bucket.tokens, bucket.capacity);
  }

  const now = Date.now();
  const elapsedSeconds = (now - bucket.lastRefill) / 1000;
  if (elapsedSeconds > 0) {
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedSeconds * bucket.refillPerSecond);
    bucket.lastRefill = now;
  }

  return { exchange, bucket };
}

/**
 * assertWithinLimit — consumes `cost` tokens (default 1 = one request) from
 * the named exchange's bucket. Throws RateLimitError synchronously if
 * there isn't enough headroom; the caller should treat this the same as
 * any other pre-flight failure and abort that leg.
 */
function assertWithinLimit(exchangeRaw, cost = 1) {
  const { exchange, bucket } = _getBucket(exchangeRaw);
  if (bucket.tokens < cost) {
    logger.warn('exchangeRateLimiter', `Rate limit hit for ${exchange}`, {
      exchange,
      capacity: bucket.capacity,
      refillPerSecond: bucket.refillPerSecond,
      available: Math.round(bucket.tokens * 100) / 100,
    });
    throw new RateLimitError(exchange, bucket.tokens, cost);
  }
  bucket.tokens -= cost;
  return { exchange, available: bucket.tokens };
}

/**
 * getStatus — snapshot of every exchange with a default config, plus any
 * exchange that has actually been used (so ad-hoc/env-overridden
 * exchanges show up too once touched).
 */
function getStatus() {
  const names = new Set([...Object.keys(DEFAULT_CONFIGS), ..._buckets.keys()]);
  const status = {};
  for (const name of names) {
    const { exchange, bucket } = _getBucket(name);
    status[exchange] = {
      exchange,
      capacity: bucket.capacity,
      refillPerSecond: bucket.refillPerSecond,
      available: Math.round(bucket.tokens * 100) / 100,
    };
  }
  return status;
}

/** _resetAll — test helper only; clears all bucket state. */
function _resetAll() {
  _buckets.clear();
}

module.exports = {
  assertWithinLimit,
  getStatus,
  RateLimitError,
  _resetAll,
};

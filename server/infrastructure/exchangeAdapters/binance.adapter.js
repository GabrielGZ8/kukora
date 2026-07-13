'use strict';

/**
 * binance.adapter.js — plugin descriptor for Binance.
 *
 * This is the whole contract for adding a new exchange to Kukora: drop a
 * file like this one into server/infrastructure/exchangeAdapters/, export a
 * descriptor matching the shape below, and the loader (index.js in this
 * folder) picks it up automatically at startup — zero edits anywhere else.
 *
 * `fees`/`pairs`/`wsUrl` feed exchangeRegistry (source of truth for
 * ALL_EXCHANGES, taker-fee lookups, etc). `healthCheck` and `symbolMap` are
 * adapter-level hooks that exchangeService.js's connection layer can opt
 * into over time — see exchangeAdapters/README.md for the migration plan
 * from "descriptor plugin" (this) to "full connection plugin" (Phase 2:
 * connect/parseMessage/normalizeOrderBook also live here, so exchangeService
 * itself becomes a thin dispatcher instead of one big per-exchange switch).
 */

module.exports = {
  name: 'Binance',
  id: 'binance',
  enabled: true,
  wsUrl: 'wss://data-stream.binance.vision/stream?streams=btcusdt@bookTicker/btcusdt@depth5@100ms/ethusdt@bookTicker/ethusdt@depth5@100ms',
  pairs: ['BTC', 'ETH'],
  fees: { maker: 0.001, taker: 0.001 },
  region: 'global',

  // Adapter-level metadata (Phase 1 additions — informational today,
  // consumed by exchangeService/health checks incrementally):
  symbolMap: { BTC: 'BTCUSDT', ETH: 'ETHUSDT' },
  rateLimitPerMinute: 1200,
};

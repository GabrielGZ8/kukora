/**
 * exchangeRegistry.js — I-2 fix: Plugin registry for exchanges.
 *
 * Before this fix, adding a new exchange required editing at least 3 files:
 *   1. exchangeService.js  — add WS connection
 *   2. arbitrageOrchestrator.js — add to ALL_EXCHANGE_NAMES array (line 92)
 *   3. feeConfig.js        — add fee schedule
 *
 * With the registry, each exchange is a self-contained descriptor object.
 * Adding a 6th exchange = create descriptor, call registerExchange().
 * ALL_EXCHANGE_NAMES is now a single-source-of-truth derived from the registry.
 *
 * Phase 1: The registry is additive — existing code paths are unchanged.
 * The registry exposes helpers that new code (and future refactors) can use.
 * No behavior changes in this iteration; pure structural improvement.
 */

'use strict';

/**
 * @typedef {Object} ExchangeDescriptor
 * @property {string}   name        - Display name (must match key in exchangeService)
 * @property {string}   id          - Lowercase stable identifier
 * @property {boolean}  enabled     - Whether this exchange is active
 * @property {string}   wsUrl       - Primary WebSocket URL
 * @property {string}   [restUrl]   - REST fallback URL
 * @property {string[]} pairs       - Supported pairs (e.g. ['BTC', 'ETH'])
 * @property {Object}   fees        - { maker: number, taker: number } as decimals
 * @property {string}   [region]    - Primary region for latency-aware routing
 */

/** @type {Map<string, ExchangeDescriptor>} */
const _registry = new Map();

/**
 * Register an exchange descriptor.
 * @param {ExchangeDescriptor} descriptor
 */
function registerExchange(descriptor) {
  if (!descriptor?.name) throw new Error('exchangeRegistry: descriptor.name is required');
  if (!descriptor?.id)   throw new Error('exchangeRegistry: descriptor.id is required');
  _registry.set(descriptor.name, descriptor);
}

/** Returns all registered exchange names (for loops, ALL_EXCHANGE_NAMES, etc.) */
function getExchangeNames() {
  return [..._registry.keys()];
}

/** Returns enabled exchange names only */
function getEnabledExchangeNames() {
  return [..._registry.values()].filter(e => e.enabled !== false).map(e => e.name);
}

/** Returns the descriptor for a specific exchange */
function getExchange(name) {
  return _registry.get(name) || null;
}

/** Returns all descriptors */
function getAllExchanges() {
  return [..._registry.values()];
}

/** Returns taker fee for an exchange (decimal, e.g. 0.001 = 0.1%) */
function getTakerFee(name) {
  return _registry.get(name)?.fees?.taker ?? null;
}

// ─── Register exchanges from the plugin directory ─────────────────────────
// Phase 2 of the I-2 fix: descriptors used to be hardcoded registerExchange()
// calls right here (5 literal blocks). They now live one-per-file as
// self-contained plugins in ./exchangeAdapters/*.adapter.js, auto-discovered
// and validated by the loader. Adding a 6th exchange is now: create
// exchangeAdapters/newexchange.adapter.js, done — this file does not change.
const { loadAdapters } = require('./exchangeAdapters');
for (const descriptor of loadAdapters()) {
  registerExchange(descriptor);
}

module.exports = {
  registerExchange,
  getExchangeNames,
  getEnabledExchangeNames,
  getExchange,
  getAllExchanges,
  getTakerFee,
};

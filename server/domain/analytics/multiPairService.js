'use strict';
/**
 * multiPairService.js — Multi-pair configuration and routing
 *
 * GAP 4: Allows users to enable/disable trading pairs and set capital allocation.
 * Supported pairs: BTC/USDT, ETH/USDT, SOL/USDT, BNB/USDT, XRP/USDT
 *
 * Uses existing BTC and ETH data from exchangeService.
 * SOL, BNB, XRP are fetched via REST fallback when WS not available.
 */

const { logger } = require('../../infrastructure/logger');

// ─── Supported pairs registry ─────────────────────────────────────────────
const SUPPORTED_PAIRS = {
  'BTC/USDT': {
    symbol: 'BTC/USDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    minTradeAmount: 0.001,
    maxTradeAmount: 0.5,
    wsSupported: true,
    binanceSymbol: 'BTCUSDT',
    krakenSymbol: 'BTC/USD',
    bybitSymbol: 'BTCUSDT',
    coinbaseSymbol: 'BTC-USD',
    okxSymbol: 'BTC-USDT',
  },
  'ETH/USDT': {
    symbol: 'ETH/USDT',
    baseAsset: 'ETH',
    quoteAsset: 'USDT',
    minTradeAmount: 0.01,
    maxTradeAmount: 10,
    wsSupported: true,
    binanceSymbol: 'ETHUSDT',
    krakenSymbol: 'ETH/USD',
    bybitSymbol: 'ETHUSDT',
    coinbaseSymbol: 'ETH-USD',
    okxSymbol: 'ETH-USDT',
  },
  'SOL/USDT': {
    symbol: 'SOL/USDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    minTradeAmount: 0.1,
    maxTradeAmount: 100,
    wsSupported: false, // REST polling fallback
    binanceSymbol: 'SOLUSDT',
    krakenSymbol: 'SOL/USD',
    bybitSymbol: 'SOLUSDT',
    coinbaseSymbol: 'SOL-USD',
    okxSymbol: 'SOL-USDT',
  },
  'BNB/USDT': {
    symbol: 'BNB/USDT',
    baseAsset: 'BNB',
    quoteAsset: 'USDT',
    minTradeAmount: 0.1,
    maxTradeAmount: 100,
    wsSupported: false,
    binanceSymbol: 'BNBUSDT',
    krakenSymbol: null,           // Kraken doesn't list BNB
    bybitSymbol: 'BNBUSDT',
    coinbaseSymbol: null,
    okxSymbol: 'BNB-USDT',
  },
  'XRP/USDT': {
    symbol: 'XRP/USDT',
    baseAsset: 'XRP',
    quoteAsset: 'USDT',
    minTradeAmount: 1,
    maxTradeAmount: 10000,
    wsSupported: false,
    binanceSymbol: 'XRPUSDT',
    krakenSymbol: 'XRP/USD',
    bybitSymbol: 'XRPUSDT',
    coinbaseSymbol: 'XRP-USD',
    okxSymbol: 'XRP-USDT',
  },
};

// ─── Per-user pair config (in-memory, synced to DB) ──────────────────────
// Issue 28: Bounded LRU map — evicts oldest entry when capacity exceeded
const MAX_USER_CONFIGS = 1000;
const _userConfigs = new Map();

function _lruSet(userId, value) {
  // If already present, delete first to refresh insertion order (LRU eviction)
  if (_userConfigs.has(userId)) _userConfigs.delete(userId);
  if (_userConfigs.size >= MAX_USER_CONFIGS) {
    // Map preserves insertion order — first key is oldest
    const oldest = _userConfigs.keys().next().value;
    _userConfigs.delete(oldest);
  }
  _userConfigs.set(userId, value);
}

function getDefaultConfig() {
  return {
    pairs: ['BTC/USDT'],
    allocation: { 'BTC/USDT': 1.0 },
    mode: 'paper',
  };
}

function getUserConfig(userId) {
  return _userConfigs.get(userId) || getDefaultConfig();
}

function setUserConfig(userId, config) {
  const current = getUserConfig(userId);

  // Validate pairs
  const validPairs = (config.pairs || []).filter(p => SUPPORTED_PAIRS[p]);
  if (validPairs.length === 0) throw new Error('At least one valid pair required');

  // Validate allocation sums to ~1.0
  const alloc = config.allocation || {};
  const allocTotal = validPairs.reduce((sum, p) => sum + (alloc[p] || 0), 0);

  // Normalize allocation to sum to 1.0
  const normalizedAlloc = {};
  if (allocTotal > 0) {
    for (const p of validPairs) {
      normalizedAlloc[p] = (alloc[p] || 0) / allocTotal;
    }
  } else {
    // Equal weight by default
    for (const p of validPairs) {
      normalizedAlloc[p] = 1 / validPairs.length;
    }
  }

  const newConfig = {
    pairs: validPairs,
    allocation: normalizedAlloc,
    mode: config.mode || current.mode,
    updatedAt: new Date().toISOString(),
  };

  _lruSet(userId, newConfig); // Issue 28: LRU eviction
  logger.info('multiPair', 'User config updated', { userId, pairs: validPairs });
  _persistUserConfig(userId, newConfig); // fire-and-forget, non-fatal
  return newConfig;
}

// ─── DB persistence (best-effort; falls back to in-memory only) ──────────
let _UserTradingConfig;
function _getModel() {
  if (!_UserTradingConfig) {
    try { _UserTradingConfig = require('../../models').UserTradingConfig; } catch { /* unavailable */ }
  }
  return _UserTradingConfig;
}

async function _persistUserConfig(userId, config) {
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) return;
  const Model = _getModel();
  if (!Model) return;
  try {
    await Model.findOneAndUpdate(
      { userId },
      { $set: { pairs: config.pairs, allocation: config.allocation, mode: config.mode, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (e) { logger.warn?.('multiPair', 'Persist failed (non-fatal)', { error: e.message }); }
}

/**
 * Hydrate the in-memory config for a user from the DB (call on login / app start).
 * Safe no-op if Mongo isn't connected or no record exists.
 */
async function loadUserConfigFromDb(userId) {
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 1) return getUserConfig(userId);
  const Model = _getModel();
  if (!Model) return getUserConfig(userId);
  try {
    const doc = await Model.findOne({ userId }).lean();
    if (doc) {
      const cfg = { pairs: doc.pairs, allocation: doc.allocation, mode: doc.mode, updatedAt: doc.updatedAt };
      _lruSet(userId, cfg); // Issue 28: LRU eviction
      return cfg;
    }
  } catch { /* non-fatal */ }
  return getUserConfig(userId);
}

// ─── REST price fetcher for non-WS pairs ─────────────────────────────────
const _priceCache = new Map(); // symbol -> { bid, ask, ts }
const CACHE_TTL_MS = 3000;

async function fetchPriceREST(symbol) {
  const cached = _priceCache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached;

  const pairInfo = SUPPORTED_PAIRS[symbol];
  if (!pairInfo) return null;

  try {
    // Fetch from Binance (most reliable, no auth needed for ticker)
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/bookTicker?symbol=${pairInfo.binanceSymbol}`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const price = {
      exchange: 'Binance',
      symbol,
      bid: parseFloat(data.bidPrice),
      ask: parseFloat(data.askPrice),
      ts: Date.now(),
      source: 'rest',
    };
    _priceCache.set(symbol, price);
    return price;
  } catch (e) {
    return null;
  }
}

// ─── Get order books for a specific pair ─────────────────────────────────
async function getOrderBooksForPair(symbol) {
  const { getOrderBooks, getOrderBooksETH } = require('../../infrastructure/exchangeService');

  if (symbol === 'BTC/USDT') return getOrderBooks();
  if (symbol === 'ETH/USDT') return getOrderBooksETH();

  // REST fallback for other pairs
  const price = await fetchPriceREST(symbol);
  if (!price) return {};

  // Return minimal order book structure compatible with arbitrageEngine
  const spread = price.ask - price.bid;
  return {
    Binance: {
      exchange: 'Binance',
      bid: price.bid,
      ask: price.ask,
      spread,
      spreadPct: (spread / price.ask * 100),
      ts: new Date().toISOString(),
      source: 'rest',
      asset: SUPPORTED_PAIRS[symbol]?.baseAsset,
      depth: { bids: [[price.bid, 10]], asks: [[price.ask, 10]] },
    },
  };
}

module.exports = {
  SUPPORTED_PAIRS,
  getUserConfig,
  setUserConfig,
  getOrderBooksForPair,
  fetchPriceREST,
  getDefaultConfig,
  loadUserConfigFromDb,
};

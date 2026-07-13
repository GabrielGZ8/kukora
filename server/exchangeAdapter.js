"use strict";
/**
 * exchangeAdapter.ts — Kukora Exchange Adapter Interface (audit Level 3 #1)
 *
 * Formal contract that every exchange integration must satisfy.
 * This interface establishes the minimum surface that arbitrageOrchestrator.js
 * and opportunityDetection.js depend on, making it possible to:
 *  - Add new exchanges without touching orchestrator logic
 *  - Write unit tests against a mock adapter (no live WS connections)
 *  - Type-check exchange data at build time with `tsc --noEmit`
 *
 * Current production adapters:
 *   Binance, Kraken, Bybit, OKX, Coinbase (in server/exchangeService.js)
 *
 * Usage:
 *   import type { ExchangeAdapter, OrderBook, Ticker } from './exchangeAdapter';
 *
 *   class BinanceAdapter implements ExchangeAdapter { ... }
 *   class MockAdapter    implements ExchangeAdapter { ... }  // tests
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockExchangeAdapter = void 0;
// ── Mock adapter (for unit tests) ────────────────────────────────────────────
/**
 * MockExchangeAdapter — a complete, in-memory implementation of ExchangeAdapter
 * for use in tests. Configurable per-test via the constructor.
 *
 * Example:
 *   const adapter = new MockExchangeAdapter('TestEx', {
 *     tickers: { 'BTC/USDT': { bid: 64000, ask: 64050 } },
 *   });
 */
class MockExchangeAdapter {
    constructor(name, opts = {}) {
        this._state = 'disconnected';
        this._orderBooks = new Map();
        this._tickers = new Map();
        this.name = name;
        if (opts.tickers) {
            for (const [pair, t] of Object.entries(opts.tickers)) {
                this._tickers.set(pair, { exchange: name, pair, bid: t.bid, ask: t.ask, timestamp: Date.now() });
            }
        }
        if (opts.orderBooks) {
            for (const [pair, ob] of Object.entries(opts.orderBooks)) {
                this._orderBooks.set(pair, ob);
            }
        }
        this._balances = opts.balances ?? [];
        this._fees = { maker: 0.001, taker: 0.001, withdrawals: {}, ...(opts.fees ?? {}) };
        this._failConnect = opts.failConnect ?? false;
    }
    async connect() {
        if (this._failConnect) {
            this._state = 'error';
            return;
        }
        this._state = 'connected';
    }
    async disconnect() { this._state = 'disconnected'; }
    getHealth() {
        return { exchange: this.name, state: this._state, latencyMs: 0 };
    }
    getOrderBook(pair) {
        return this._orderBooks.get(pair) ?? null;
    }
    getTicker(pair) {
        return this._tickers.get(pair) ?? null;
    }
    async placeOrder(params) {
        const ticker = this._tickers.get(params.pair);
        const price = params.price ?? ticker?.ask ?? 0;
        return { ok: true, orderId: `mock-${Date.now()}`, filledQty: params.quantity, avgPrice: price, fee: price * params.quantity * this._fees.taker };
    }
    async cancelOrder(_orderId, _pair) {
        return { ok: true };
    }
    async getBalances() {
        return this._balances;
    }
    getFees() { return this._fees; }
    // ── Test helpers ─────────────────────────────────────────────────────────
    /** Update a ticker mid-test. */
    setTicker(pair, bid, ask) {
        this._tickers.set(pair, { exchange: this.name, pair, bid, ask, timestamp: Date.now() });
    }
    /** Simulate a connection drop. */
    simulateDisconnect() { this._state = 'error'; }
}
exports.MockExchangeAdapter = MockExchangeAdapter;

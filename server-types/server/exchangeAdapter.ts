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

// ── Market data types ────────────────────────────────────────────────────────

/** A single level in an order book (price, size). */
export interface OrderBookLevel {
  price: number;
  size:  number;
}

/**
 * Live order book snapshot for a single trading pair on one exchange.
 * Bids are sorted highest-first, asks lowest-first (standard convention).
 */
export interface OrderBook {
  exchange:  string;
  pair:      string;      // e.g. "BTC/USDT"
  bids:      OrderBookLevel[];
  asks:      OrderBookLevel[];
  timestamp: number;      // Unix ms
}

/** Best bid/ask summary derived from a full order book. */
export interface Ticker {
  exchange:  string;
  pair:      string;
  bid:       number;
  ask:       number;
  timestamp: number;
}

// ── Trade / order types ──────────────────────────────────────────────────────

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';

export interface PlaceOrderParams {
  pair:     string;
  side:     OrderSide;
  type:     OrderType;
  quantity: number;
  price?:   number;   // required for limit orders
  clientId?: string;  // idempotency key / correlation id
}

export interface OrderResult {
  ok:         boolean;
  orderId?:   string;
  filledQty?: number;
  avgPrice?:  number;
  fee?:       number;
  reason?:    string; // human-readable error if ok:false
}

// ── Fee / balance types ──────────────────────────────────────────────────────

export interface ExchangeBalance {
  asset:     string;  // e.g. "BTC", "USDT"
  available: number;
  locked:    number;
}

export interface FeeSchedule {
  maker:       number;  // decimal, e.g. 0.001 = 0.1%
  taker:       number;
  withdrawals: Record<string, number>;  // asset → flat USD equivalent
}

// ── Connection / health types ────────────────────────────────────────────────

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface HealthStatus {
  exchange:    string;
  state:       ConnectionState;
  latencyMs?:  number;
  lastHeartbeat?: number;  // Unix ms
  errorMsg?:   string;
}

// ── Core adapter interface ───────────────────────────────────────────────────

/**
 * ExchangeAdapter — the single contract that every exchange integration must fulfill.
 *
 * Philosophy:
 *  - Methods are async; implementations must never throw synchronously.
 *  - All errors are reported via result.ok === false + result.reason string.
 *  - Adapters are stateful (WS connection, order cache) but expose a
 *    consistent interface regardless of transport (WS vs REST).
 *
 * Test strategy:
 *  - Provide a `MockExchangeAdapter` that implements this interface for
 *    unit tests. Any code that depends only on ExchangeAdapter is fully
 *    testable without network access.
 */
export interface ExchangeAdapter {
  /** Human-readable name matching the registry (e.g. "Binance"). */
  readonly name: string;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Open WS connections and subscribe to required streams. */
  connect(): Promise<void>;

  /** Close connections gracefully, flush pending state. */
  disconnect(): Promise<void>;

  /** Current connection health. Must never throw. */
  getHealth(): HealthStatus;

  // ── Market data ──────────────────────────────────────────────────────────

  /**
   * Return the latest order book for `pair`.
   * Returns null if no snapshot is available yet (pre-warmup).
   */
  getOrderBook(pair: string): OrderBook | null;

  /**
   * Return the latest best bid/ask for `pair`.
   * Returns null if no tick received yet.
   */
  getTicker(pair: string): Ticker | null;

  // ── Trading ──────────────────────────────────────────────────────────────

  /**
   * Place an order on the exchange.
   * Must be idempotent with respect to `params.clientId` if provided:
   * re-sending the same clientId within 60 s must return the original result,
   * not create a duplicate order.
   */
  placeOrder(params: PlaceOrderParams): Promise<OrderResult>;

  /**
   * Cancel an open order by exchange orderId.
   * Returns ok:true even if the order was already filled/cancelled
   * (idempotent cancellation).
   */
  cancelOrder(orderId: string, pair: string): Promise<{ ok: boolean; reason?: string }>;

  // ── Account ──────────────────────────────────────────────────────────────

  /**
   * Return balances for all assets held on this exchange.
   * In Kukora's pre-funded bilateral model this is the simulated wallet;
   * in a live adapter it would query the exchange API.
   */
  getBalances(): Promise<ExchangeBalance[]>;

  /** Return the fee schedule for this exchange. */
  getFees(): FeeSchedule;
}

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
export class MockExchangeAdapter implements ExchangeAdapter {
  readonly name: string;

  private _state: ConnectionState = 'disconnected';
  private _orderBooks: Map<string, OrderBook>  = new Map();
  private _tickers:    Map<string, Ticker>     = new Map();

  constructor(
    name: string,
    opts: {
      tickers?:    Record<string, { bid: number; ask: number }>;
      orderBooks?: Record<string, OrderBook>;
      balances?:   ExchangeBalance[];
      fees?:       Partial<FeeSchedule>;
      failConnect?: boolean;
    } = {},
  ) {
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
    this._balances    = opts.balances   ?? [];
    this._fees        = { maker: 0.001, taker: 0.001, withdrawals: {}, ...(opts.fees ?? {}) };
    this._failConnect = opts.failConnect ?? false;
  }

  private _balances:    ExchangeBalance[];
  private _fees:        FeeSchedule;
  private _failConnect: boolean;

  async connect(): Promise<void> {
    if (this._failConnect) {
      this._state = 'error';
      return;
    }
    this._state = 'connected';
  }

  async disconnect(): Promise<void> { this._state = 'disconnected'; }

  getHealth(): HealthStatus {
    return { exchange: this.name, state: this._state, latencyMs: 0 };
  }

  getOrderBook(pair: string): OrderBook | null {
    return this._orderBooks.get(pair) ?? null;
  }

  getTicker(pair: string): Ticker | null {
    return this._tickers.get(pair) ?? null;
  }

  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    const ticker = this._tickers.get(params.pair);
    const price  = params.price ?? ticker?.ask ?? 0;
    return { ok: true, orderId: `mock-${Date.now()}`, filledQty: params.quantity, avgPrice: price, fee: price * params.quantity * this._fees.taker };
  }

  async cancelOrder(_orderId: string, _pair: string): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async getBalances(): Promise<ExchangeBalance[]> {
    return this._balances;
  }

  getFees(): FeeSchedule { return this._fees; }

  // ── Test helpers ─────────────────────────────────────────────────────────

  /** Update a ticker mid-test. */
  setTicker(pair: string, bid: number, ask: number): void {
    this._tickers.set(pair, { exchange: this.name, pair, bid, ask, timestamp: Date.now() });
  }

  /** Simulate a connection drop. */
  simulateDisconnect(): void { this._state = 'error'; }
}

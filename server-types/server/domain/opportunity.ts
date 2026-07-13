/**
 * opportunity.ts — Shared Opportunity type (audit Level 2 #3)
 *
 * Compiles to server/domain/opportunity.js (Nivel 2 #1 bounded-context
 * reorg, round 11). This file was relocated from server-types/server/
 * opportunity.ts, which used to compile to server/opportunity.js — that
 * path is now a backward-compatible re-export shim
 * (require('./domain/opportunity')). Moving this .ts source here keeps
 * `npm run build:ts` / `tsc` consistent with the new location instead of
 * silently overwriting the shim with the compiled type-guard code.
 *
 * Single source of truth for the Opportunity object produced by
 * opportunityDetection.detectOpportunities() and consumed by:
 *   - arbitrageOrchestrator.executeBestOpportunity()
 *   - arbitrage.routes (stream/query handlers)
 *   - Frontend ArbitragePage, OpportunityCard, etc.
 *
 * Before this type existed, the shape was implicit — inferred from the
 * runtime object built in opportunityDetection.js line ~400. Adding a field
 * silently broke downstream consumers because there was no contract to
 * check at build time.
 *
 * Usage:
 *   import type { Opportunity, OpportunityScore } from './opportunity';
 *
 * Validation (runtime):
 *   The shape of a live Opportunity object can be checked via the
 *   `isOpportunity` type guard below (for use in route handlers that
 *   receive JSON from the WebSocket feed).
 */

// ── Score breakdown ───────────────────────────────────────────────────────────

/** Detailed breakdown of how an opportunity's composite score was computed. */
export interface OpportunityScoreBreakdown {
  profitability:  number;
  persistence:    number;
  fillRate:       number;
  latency:        number;
  feeMode:        number;
  [key: string]:  number;  // extensible for future scoring dimensions
}

// ── Rejection ────────────────────────────────────────────────────────────────

export type RejectionCategory =
  | 'daily_stop'
  | 'liquidity'
  | 'negative_spread'
  | 'circuit_breaker'
  | 'fees_slippage'
  | 'max_position'
  | 'drawdown'
  | null;

// ── Main Opportunity shape ────────────────────────────────────────────────────

/**
 * Opportunity — the full object produced by opportunityDetection.js for
 * each buy/sell exchange pair evaluated in a detection cycle.
 *
 * Fields that are only present on viable opportunities (viable === true)
 * are optional and typed as `T | undefined`.
 *
 * Fields that are always present regardless of viability are required.
 */
export interface Opportunity {
  // ── Identity ─────────────────────────────────────────────────────────────

  /** Stable per-pair ID (e.g. "arb-Binance-Kraken"). Does not change across ticks. */
  id:           string;

  /** Unix milliseconds when this opportunity was first detected in this tick. */
  detectedAt:   number;

  /** ISO-8601 timestamp string (alias for detectedAt, kept for legacy consumers). */
  ts:           string;

  // ── Exchange pair ─────────────────────────────────────────────────────────

  buyExchange:  string;   // e.g. "Binance"
  sellExchange: string;   // e.g. "Kraken"

  /** Best ask price on the buy exchange (in USDT). */
  buyPrice:     number;

  /** Best bid price on the sell exchange (in USDT). */
  sellPrice:    number;

  // ── Profitability ─────────────────────────────────────────────────────────

  spreadPct:       number;  // (sellPrice - buyPrice) / buyPrice * 100
  breakEvenPct:    number;  // minimum spread needed to break even after fees
  viabilityThresholdPct: number;
  grossProfit:     number;  // USD before fees / slippage
  buyFee:          number;  // USD
  sellFee:         number;  // USD
  totalFees:       number;  // buyFee + sellFee
  slippage:        number;  // USD — estimated slippage cost (VWAP-based or fallback)
  slippagePct:     number;  // slippage as % of notional
  slippageMethod:  'real' | 'fallback';
  buySlipMethod:   'real' | 'fallback';
  sellSlipMethod:  'real' | 'fallback';
  withdrawalFeeUSD: number;
  withdrawalModel:  'periodic_rebalancing';
  netProfit:       number;  // grossProfit - buyFee - sellFee - slippage
  netProfitPct:    number;  // netProfit / notional * 100

  /** 95% confidence interval lower bound for netProfit. */
  profitLow:   number | null;

  /** 95% confidence interval upper bound for netProfit. */
  profitHigh:  number | null;

  // ── Viability flags ───────────────────────────────────────────────────────

  /** true when this opportunity passes all checks and is safe to execute. */
  viable:         boolean;

  /** true when the spread is outside acceptable bounds (too small or too large). */
  circuitBreaker: boolean;

  /** true when L2 order book depth is sufficient to fill the full trade amount. */
  liquidityOk:    boolean;

  rejectionReason:   string | null;
  rejectionCategory: RejectionCategory;

  // ── Fill probability ──────────────────────────────────────────────────────

  /** Estimated % of trade that can be filled given current L2 depth on buy side. */
  buyFillPct:     number;

  /** Estimated % of trade that can be filled given current L2 depth on sell side. */
  sellFillPct:    number;

  // ── Scoring (only present when viable === true) ───────────────────────────

  /** Composite score 0–100. 0 for non-viable opportunities. */
  score:          number;

  /** Detailed score breakdown. null for non-viable opportunities. */
  scoreBreakdown: OpportunityScoreBreakdown | null;

  // ── Sizing ────────────────────────────────────────────────────────────────

  /** Trade size in BTC (from liveConfig or adaptive sizing). */
  tradeAmount:    number;

  /** Fee mode applied (e.g. "estimated", "taker", "maker"). */
  feeMode:        string;

  // ── Latency / telemetry ───────────────────────────────────────────────────

  buyLatency:          number;  // ms — WS feed age on buy exchange
  sellLatency:         number;  // ms — WS feed age on sell exchange
  buySource:           'ws' | 'http' | string;
  sellSource:          'ws' | 'http' | string;
  feedAgeMs:           number;  // max(buyLatency, sellLatency)
  detectionLatencyMs:  number;  // time from feed arrival to detection complete
  evalMs:              number;  // wall-clock time to evaluate this pair
}

// ── Trade (post-execution) ─────────────────────────────────────────────────

/**
 * Trade — the shape actually returned by opportunityDetection.executeSimulated()
 * and stored in walletManager.applyTrade() / tradeHistory after a successful
 * execution.
 *
 * ROADMAP NOTE (audit committee, sección 12, punto 1): before this
 * interface was corrected, the exported `ExecutedTrade` type declared
 * fields (`fillPct`, `executedAt`, `source`, `tradeAmount`, `viable`) that
 * `executeSimulated()` never actually produced, and omitted fields it
 * always does (`asset`, `requestedAmount`, `netProfitPct`, `spreadPct`,
 * `breakEvenPct`, `score`, `buySource`, `sellSource`, `status`, `ts`). A
 * type nobody's runtime object actually satisfies is worse than no type —
 * it gives false confidence without catching real drift. `Trade` below was
 * derived directly from the object literal built in
 * server/domain/engines/opportunityDetection.js (executeSimulated), not
 * from what would be nice to have.
 *
 * `ExecutedTrade` is kept as a deprecated alias so any future TS code that
 * still refers to the old name keeps compiling.
 */
export interface Trade {
  /** UUID-ish, format "trade-{timestamp}-{random}". */
  id:               string;

  /** Wallet bucket this trade settles against — 'BTC' | 'ETH' | 'XRP'. */
  asset:            string;

  buyExchange:      string;
  sellExchange:     string;
  buyPrice:         number;
  sellPrice:        number;

  /** Amount actually executed (may be < requestedAmount on partial fill). */
  amount:           number;

  /** Amount that was requested before balance-driven scaling. */
  requestedAmount:  number;

  /** true when amount < requestedAmount (insufficient balance on either leg). */
  partialFill:      boolean;

  grossProfit:      number;
  buyFee:           number;
  sellFee:          number;
  totalFees:        number;
  slippage:         number;
  slippagePct:      number | undefined;
  slippageMethod:   Opportunity['slippageMethod'] | undefined;
  withdrawalFeeUSD: number;
  withdrawalModel:  'periodic_rebalancing';
  netProfit:        number;
  netProfitPct:     number;
  spreadPct:        number | undefined;
  breakEvenPct:     number | undefined;

  /** Composite score of the opportunity this trade was executed from. */
  score:            number;

  buySource:        string | undefined;
  sellSource:       string | undefined;
  feeMode:          string;

  /** 'profit' | 'loss', derived from netProfit sign. */
  status:           'profit' | 'loss';

  /** Wall-clock ms spent inside executeSimulated(). */
  executionMs:      number;

  /** ISO-8601 timestamp of execution. */
  ts:               string;
}

/** @deprecated use {@link Trade} — kept so old imports keep compiling. */
export type ExecutedTrade = Trade;

// ── Type guards ─────────────────────────────────────────────────────────────

/**
 * Runtime type guard — checks the minimum fields needed to safely pass an
 * object to executeBestOpportunity().
 */
export function isOpportunity(obj: unknown): obj is Opportunity {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o['buyExchange']  === 'string' &&
    typeof o['sellExchange'] === 'string' &&
    typeof o['netProfit']    === 'number' &&
    typeof o['spreadPct']    === 'number' &&
    typeof o['viable']       === 'boolean'
  );
}

/**
 * Runtime type guard for a completed Trade record — checks the fields that
 * every consumer (walletManager, tenantRiskGuard, executionJournal) relies
 * on being present and correctly typed before reading `.netProfit` etc.
 */
export function isTrade(obj: unknown): obj is Trade {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o['id']           === 'string' &&
    typeof o['buyExchange']  === 'string' &&
    typeof o['sellExchange'] === 'string' &&
    typeof o['amount']       === 'number' &&
    typeof o['netProfit']    === 'number' &&
    typeof o['ts']           === 'string'
  );
}

/**
 * createTrade — canonical constructor for a Trade record. Fills the
 * execution-bookkeeping fields (id, ts, status, executionMs, totalFees) so
 * callers that build a trade from an Opportunity don't each reimplement
 * that boilerplate with their own (potentially inconsistent) defaults.
 *
 * Does not perform balance/liquidity checks — that stays in
 * executeSimulated(), which is the actual financial logic. This is purely
 * a shape-consistency helper for anywhere else in the codebase that needs
 * to construct a well-formed Trade object (tests, backtest replay,
 * satellite engines migrating onto the shared type).
 */
export function createTrade(
  fields: Omit<Trade, 'id' | 'ts' | 'status' | 'executionMs' | 'totalFees'> &
    Partial<Pick<Trade, 'id' | 'ts' | 'status' | 'executionMs' | 'totalFees'>>,
  startedAt: number = Date.now(),
): Trade {
  const totalFees = fields.totalFees ?? +(fields.buyFee + fields.sellFee).toFixed(4);
  return {
    ...fields,
    id: fields.id ?? `trade-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    totalFees,
    status: fields.status ?? (fields.netProfit > 0 ? 'profit' : 'loss'),
    executionMs: fields.executionMs ?? (Date.now() - startedAt),
    ts: fields.ts ?? new Date().toISOString(),
  };
}

// fillProbabilityEngine.enrichWithFillProbability() mutates a live
// Opportunity to add this field before execution — augmenting the
// interface here (rather than adding it above as always-present) keeps
// the type honest about the fact that it's absent until that engine runs.
declare module './opportunity' {
  interface Opportunity {
    fillProbability?: number;
  }
}

// ── OpportunityLogEntry (reduced log shape) ─────────────────────────────────

/**
 * OpportunityLogEntry — the reduced record pushed to `_opportunityLog` by
 * opportunityDetection.js for every opportunity evaluated in a tick, and
 * read back by `getOpportunityLog()`.
 *
 * This is intentionally NOT `Opportunity`: it collapses `buyExchange`/
 * `sellExchange` into a single `pair` string, and drops everything the
 * backtest/adaptive-scoring consumers (arbBacktestEngine.js,
 * adaptiveScoring.js) never read (VWAP internals, latency telemetry,
 * fill-probability inputs). Before this type existed there was no explicit
 * contract for this shape — forcing `isOpportunity()` on a log entry would
 * reject 100% of entries by design (no `buyExchange`/`sellExchange`/
 * `netProfit`... well netProfit exists, but no `viable` boolean semantics
 * differ), which is a false positive, not a real drift signal. Naming this
 * shape explicitly lets simulateRun()/walkForward() validate against the
 * right contract instead of either the wrong one or none at all.
 */
export interface OpportunityLogEntry {
  /** e.g. "Binance→Kraken" — combines buyExchange/sellExchange for this reduced shape. */
  pair:         string;
  netProfit:    number;
  spreadPct:    number;
  breakEvenPct: number;
  viable:       boolean;
  rejCat:       RejectionCategory;
  slipMethod:   Opportunity['slippageMethod'] | undefined;
  feeMode:      string;
  /** Composite score — arbBacktestEngine.simulateRun() gates execution on
   *  `score >= minScore`; this field was historically missing from the
   *  pushed object (see CHECKPOINT_13), which silently zeroed out every
   *  backtest result. Kept required here so that regression can never
   *  reappear silently. */
  score:        number;
  ts:           string;
}

/**
 * Runtime type guard for the reduced log-entry shape read by
 * arbBacktestEngine.simulateRun() / adaptiveScoring's walkForward() calls.
 * Distinct from `isOpportunity` on purpose (see interface doc above) — a
 * full `Opportunity` object does NOT satisfy this guard (no `pair`), and a
 * log entry does NOT satisfy `isOpportunity` (no `buyExchange`/`sellExchange`).
 */
export function isOpportunityLogEntry(obj: unknown): obj is OpportunityLogEntry {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o['pair']         === 'string' &&
    typeof o['netProfit']    === 'number' &&
    typeof o['spreadPct']    === 'number' &&
    typeof o['viable']       === 'boolean' &&
    typeof o['score']        === 'number' &&
    typeof o['ts']           === 'string'
  );
}

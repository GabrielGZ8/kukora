"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.isOpportunity = isOpportunity;
exports.isTrade = isTrade;
exports.createTrade = createTrade;
exports.isOpportunityLogEntry = isOpportunityLogEntry;
// ── Type guards ─────────────────────────────────────────────────────────────
/**
 * Runtime type guard — checks the minimum fields needed to safely pass an
 * object to executeBestOpportunity().
 */
function isOpportunity(obj) {
    if (typeof obj !== 'object' || obj === null)
        return false;
    const o = obj;
    return (typeof o['buyExchange'] === 'string' &&
        typeof o['sellExchange'] === 'string' &&
        typeof o['netProfit'] === 'number' &&
        typeof o['spreadPct'] === 'number' &&
        typeof o['viable'] === 'boolean');
}
/**
 * Runtime type guard for a completed Trade record — checks the fields that
 * every consumer (walletManager, tenantRiskGuard, executionJournal) relies
 * on being present and correctly typed before reading `.netProfit` etc.
 */
function isTrade(obj) {
    if (typeof obj !== 'object' || obj === null)
        return false;
    const o = obj;
    return (typeof o['id'] === 'string' &&
        typeof o['buyExchange'] === 'string' &&
        typeof o['sellExchange'] === 'string' &&
        typeof o['amount'] === 'number' &&
        typeof o['netProfit'] === 'number' &&
        typeof o['ts'] === 'string');
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
function createTrade(fields, startedAt = Date.now()) {
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
/**
 * Runtime type guard for the reduced log-entry shape read by
 * arbBacktestEngine.simulateRun() / adaptiveScoring's walkForward() calls.
 * Distinct from `isOpportunity` on purpose (see interface doc above) — a
 * full `Opportunity` object does NOT satisfy this guard (no `pair`), and a
 * log entry does NOT satisfy `isOpportunity` (no `buyExchange`/`sellExchange`).
 */
function isOpportunityLogEntry(obj) {
    if (typeof obj !== 'object' || obj === null)
        return false;
    const o = obj;
    return (typeof o['pair'] === 'string' &&
        typeof o['netProfit'] === 'number' &&
        typeof o['spreadPct'] === 'number' &&
        typeof o['viable'] === 'boolean' &&
        typeof o['score'] === 'number' &&
        typeof o['ts'] === 'string');
}

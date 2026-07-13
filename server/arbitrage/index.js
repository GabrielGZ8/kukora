'use strict';

/**
 * server/arbitrage/index.js — Barrel export for the arbitrage domain (audit fix 2.2)
 *
 * WHY THIS FILE EXISTS
 * ─────────────────────
 * The arbitrage domain previously consisted of three files in the flat server/
 * directory with confusingly similar names (FIXED — audit v2, section 1.2):
 *
 *   opportunityDetection.js (formerly arbitrageEngine.js)   — DETECTION:
 *                           detectOpportunities(), scoreOpportunity(),
 *                           executeSimulated(), executeTriangularSimulated(),
 *                           getDailyPnl(), stat-arb helpers, rejection counters
 *
 *   arbitrageOrchestrator.js (formerly arbitrage.engine.js) — ORCHESTRATION:
 *                           the two detection loops (event-driven WebSocket +
 *                           150ms polling fallback), executeBestOpportunity(),
 *                           startEngine() — imports from opportunityDetection.js
 *
 *   arbitrage.state.js   — STATE: singleton Map of shared mutable state (bot flags,
 *                           equity curve, SSE clients, fingerprints, counters)
 *                           imported by BOTH engine files
 *
 * A new engineer reading the code previously could not determine in 10 minutes
 * which file was "the real engine" (arbitrageEngine.js vs arbitrage.engine.js
 * differed only by a dot). This is now fixed by renaming both files to
 * unambiguous names, in addition to this barrel which:
 *
 *   1. Documents each module's responsibility in one place
 *   2. Provides a single stable import path:  require('./arbitrage')
 *   3. Makes the intended public surface explicit (everything else is internal)
 *
 * REMAINING REFACTOR (Roadmap 2.2)
 * ──────────────────────────────
 * `arbitrage.state.js` could still move to `server/arbitrage/state.js` for full
 * consistency with this directory's layout; left as-is for now since it carries
 * no naming ambiguity risk and the rename would touch the same wide import
 * surface as the two files already renamed in this pass.
 *
 * ROUTES (Audit fix 2.1 — DONE)
 * ──────────────────────────────
 * server/arbitrage/subroutes/ now holds the three sub-routers extracted from
 * the former 1247-line arbitrage.routes.js:
 *   stream.routes.js — SSE streams (/stream, /alerts-stream), /live, /bot,
 *                       /reset (admin-gated), /history, /wallets
 *   query.routes.js  — all read-only endpoints: /stats, /intelligence,
 *                       /executive, /replays, /journal, /observability/*,
 *                       /trades/*, /pnl/*, /report/*, /watchdog/status, etc.
 *   config.routes.js — /config (GET/POST/reset), /rebalance/*, /adversarial/*,
 *                       /mode, /pairs, /calibration, /weekly
 *
 * server/arbitrage.routes.js is now a ~40-line wiring file: it owns only
 * the global JWT guard and startEngine() bootstrap, then mounts the three
 * sub-routers. Route paths and response shapes are unchanged — this is a
 * pure internal reorganization, fully backward compatible with the frontend.
 */

// ─── State (shared singleton — imported by detection + orchestration) ─────
const state = require('../application/arbitrage.state');

// ─── Detection (opportunities, scoring, simulated execution, daily P&L) ───
const detection = require('../domain/engines/opportunityDetection');

// ─── Orchestration (loops, startEngine, executeBestOpportunity) ───────────
const orchestration = require('../application/arbitrageOrchestrator');

module.exports = {
  // ── Orchestration (public API used by index.js, healthService, routes) ──
  startEngine:             orchestration.startEngine,
  executeBestOpportunity:  orchestration.executeBestOpportunity,
  getMinScore:             orchestration.getMinScore,
  getExecCooldown:         orchestration.getExecCooldown,
  snapshotDepths:          orchestration.snapshotDepths,

  // ── Detection (used by arbitrage.routes.js, stressTestService, etc.) ────
  detectOpportunities:         detection.detectOpportunities,
  scoreOpportunity:            detection.scoreOpportunity,
  scoreOpportunityDetailed:    detection.scoreOpportunityDetailed,
  executeSimulated:            detection.executeSimulated,
  executeTriangularSimulated:  detection.executeTriangularSimulated,
  getDailyPnl:                 detection.getDailyPnl,
  addDailyPnl:                 detection.addDailyPnl,
  isDailyLossBreached:         detection.isDailyLossBreached,
  resetDailyPnl:               detection.resetDailyPnl,
  getRejectionCounts:          detection.getRejectionCounts,
  getBestOpportunitySeen:      detection.getBestOpportunitySeen,
  getNearViableCount:          detection.getNearViableCount,
  getOpportunityLog:           detection.getOpportunityLog,
  resetSessionStats:           detection.resetSessionStats,
  setStressFeeMultiplier:      detection.setStressFeeMultiplier,
  getStressFeeMultiplier:      detection.getStressFeeMultiplier,
  getStatArbSummary:           detection.getStatArbSummary,
  resetStatArb:                detection.resetStatArb,

  // ── State (used by notifications.routes.js, alertWebhookService, etc.) ──
  state,
};

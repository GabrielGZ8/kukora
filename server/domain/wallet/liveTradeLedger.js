'use strict';
/**
 * liveTradeLedger.js — AUDIT FINDING 3b fix (residual CRITICAL, closes the
 * gap flagged in the doc comment above `_runInstitutionalRiskGate` in
 * `server/application/liveExecution.js`).
 *
 * CONTEXTO: Hallazgo 3 (v2.15.0) fixed `capitalUSD` to come from the real
 * exchange balance instead of the paper wallet, but explicitly flagged
 * `sessionPnl` — the input to the daily-loss circuit breaker
 * (`advancedRiskEngine.preTradeRiskCheck`'s 4th param /
 * `checkEmergencyStop`) — as still coming from `walletManager.getPnL()`,
 * i.e. PAPER trading P&L. A live trading session could be down real money
 * all day and the daily-loss breaker protecting REAL capital would never
 * see it, because it was reading a completely different (simulated)
 * ledger.
 *
 * This module is the real-money analog of `opportunityDetection.js`'s
 * `getDailyPnl`/`addDailyPnl` (same integer-accumulator-to-avoid-FP-drift,
 * same local-midnight reset convention — kept consistent on purpose, this
 * is the same concept applied to a different ledger, not a new design).
 * `liveExecution.js` calls `recordLiveFill()` at every point it already
 * computes a realized `netProfit`/`grossProfit` for a completed real trade
 * (single-leg fill, cross-exchange clean success, and the two
 * residual-completed partial-fill success paths — see the call sites for
 * why the emergency-flatten/manual-intervention paths are deliberately
 * NOT included: those throw rather than return `ok: true`, and neither the
 * existing audit log nor `alertWebhookService.alertTradeExecuted` computes
 * a realized P&L figure for a flattened residual position either — adding
 * one here would mean inventing a P&L calculation that doesn't exist
 * anywhere else in the codebase, which is out of scope for this fix and
 * risks being wrong. `LIVE_EXECUTE_FAILED`/`CROSS_PARTIAL_UNRECOVERED`
 * events remain visible in the audit log and via
 * `alertLivePartialFailure` for manual reconciliation, same as before this
 * fix).
 *
 * SCOPE: intentionally a single global accumulator, not per-user.
 * `secretsVault.getCredentials()` — the source of the API keys
 * `liveExecution.js` trades with — is a single global vault (env vars or
 * one vault file), not per-tenant; every live trade in this deployment
 * already draws on the same real exchange account(s) regardless of which
 * `userId` initiated it. A per-user split here would imply an isolation
 * guarantee that doesn't exist anywhere else in the live-trading path.
 */

let _dailyPnlRaw  = 0; // integer: value x 10000, same convention as opportunityDetection.js
let _dailyResetTs = new Date().setHours(0, 0, 0, 0);

function _rollIfNewDay() {
  const todayMidnight = new Date().setHours(0, 0, 0, 0);
  if (todayMidnight > _dailyResetTs) {
    _dailyPnlRaw  = 0;
    _dailyResetTs = todayMidnight;
  }
}

/**
 * recordLiveFill — records the realized P&L of a single completed REAL
 * trade. Call this only at points that already compute a definite
 * netProfit/grossProfit for money that actually moved on a real exchange
 * account (see doc comment above for exactly which call sites qualify).
 * @param {number} netProfitUSD
 */
function recordLiveFill(netProfitUSD) {
  if (typeof netProfitUSD !== 'number' || !Number.isFinite(netProfitUSD)) return;
  _rollIfNewDay();
  _dailyPnlRaw += Math.round(netProfitUSD * 10000);
}

/** getTodaysLivePnl — today's (local midnight-reset) realized real-money P&L. */
function getTodaysLivePnl() {
  _rollIfNewDay();
  return _dailyPnlRaw / 10000;
}

/** Test/ops-only: force a reset without waiting for local midnight. */
function _resetForTest() {
  _dailyPnlRaw  = 0;
  _dailyResetTs = new Date().setHours(0, 0, 0, 0);
}

module.exports = {
  recordLiveFill,
  getTodaysLivePnl,
  _resetForTest,
};

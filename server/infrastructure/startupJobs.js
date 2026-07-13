/**
 * startupJobs.js — registers Kukora's built-in recurring jobs on the
 * backgroundJobs framework (server/infrastructure/backgroundJobs.js).
 *
 * Scope note: rebalanceScheduler and dailyReportService already run their
 * own internal self-scheduling loops (startAutoRebalanceLoop / init+start)
 * predating this framework — they are NOT migrated here. Wrapping them
 * would either double-execute their cycle or require refactoring two
 * live, financially-sensitive modules under a hard deadline, which is
 * more risk than the visibility gain justifies. They're left as-is
 * (documented next step: adapt them to call registerJob() so their
 * status appears in the same /api/ops dashboard as everything below).
 *
 * The jobs below are net-new, read-only/low-risk, and demonstrate the
 * framework end to end.
 */

'use strict';

const backgroundJobs = require('./backgroundJobs');
const obs = require('./observabilityService');

function _reconcileWallets() {
  const walletManager = require('../domain/wallet/walletManager');
  const balances = walletManager.getBalances();

  const negatives = [];
  for (const [exchange, assets] of Object.entries(balances || {})) {
    for (const [asset, amount] of Object.entries(assets || {})) {
      if (typeof amount === 'number' && (Number.isNaN(amount) || amount < 0)) {
        negatives.push({ exchange, asset, amount });
      }
    }
  }

  if (negatives.length > 0) {
    obs.emit('RISK', 'wallet.reconciliation.negative_balance', { negatives }, 'error');
    throw new Error(`wallet reconciliation found ${negatives.length} invalid balance(s): ${JSON.stringify(negatives)}`);
  }

  obs.emit('SYSTEM', 'wallet.reconciliation.ok', { exchanges: Object.keys(balances || {}).length }, 'debug');
}

function _featureFlagDrift() {
  // Surfaces any active kill switch in the SYSTEM event stream on a fixed
  // cadence, independent of whoever flipped it — so a kill switch left on
  // after an incident doesn't silently fade out of anyone's attention.
  const featureFlags = require('./featureFlags');
  const active = featureFlags.listFlags().filter((f) => f.tags.includes('kill-switch') && f.currentValue === true);
  if (active.length > 0) {
    obs.emit('RISK', 'featureFlag.killSwitchStillActive', { flags: active.map((f) => f.key) }, 'warn');
  }
}

/** Call once at server startup, after walletManager/persistence are ready. */
function registerBuiltinJobs() {
  backgroundJobs.registerJob('wallet.reconciliation', _reconcileWallets, {
    intervalMs: 5 * 60_000, // every 5 minutes
    retries: 1,
    timeoutMs: 5_000,
    runOnStart: false, // avoid racing wallet init on cold start
  });

  backgroundJobs.registerJob('featureFlags.killSwitchAudit', _featureFlagDrift, {
    intervalMs: 10 * 60_000, // every 10 minutes
    retries: 0,
    timeoutMs: 2_000,
  });
}

module.exports = { registerBuiltinJobs };

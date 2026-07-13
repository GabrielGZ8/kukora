'use strict';
/**
 * liveInventoryReconciliation.js — Ronda 21, Fase 3 pendiente #5:
 * "Reconciliación de inventario entre exchanges — después de una racha de
 * trades en una sola dirección, los balances pre-fondeados en cada
 * exchange se desbalancean y hace falta rebalancearlos periódicamente."
 *
 * This is distinct from server/domain/engines/rebalanceEngine.js, which rebalances
 * the *simulated* wallet model (server/walletManager.js) used by the paper
 * trading engine. This module reconciles *real* balances held on the live
 * exchange accounts that executeCrossExchangeLive() trades against
 * (server/application/liveExecution.js), fetched live via each exchange's
 * account/balance endpoint using the same env-configured API keys.
 *
 * It only ever reads balances (getAccountInfo / getBalance) — it never
 * initiates a transfer. Exchange withdrawal/transfer APIs vary widely in
 * their confirmation flows (email/2FA approval, whitelisted withdrawal
 * addresses, network selection) and are out of scope for automation here;
 * see the "Pendientes" note in docs/RoadmapToProduction.md. This gives the
 * operator (or, later, an automated transfer step) the numbers needed to
 * act on.
 *
 * Predictive extension (directionalBiasTracker.js): in addition to the
 * reactive concentration check above (fires once an exchange has *already*
 * crossed QUOTE_MAX_CONCENTRATION), this module also looks at the
 * directional bias of the last N live cross-exchange trades (sourced from
 * liveExecution.getAuditLog()). If an exchange has been consistently the
 * buyer or seller and its concentration is already trending that way — but
 * hasn't crossed the reactive threshold yet — a *predictive* suggestion is
 * raised ahead of the reactive one. Every suggestion carries a
 * `trigger: 'reactive' | 'predictive'` field so callers can tell which
 * mechanism fired.
 */

const { logger } = require('../infrastructure/logger');
const liveExecution = require('./liveExecution');
const directionalBiasTracker = require('../domain/analytics/directionalBiasTracker');

// Mirrors the spirit of rebalanceEngine.js's THRESHOLDS but applied to
// real, live-fetched balances rather than the simulated wallet model.
const THRESHOLDS = {
  QUOTE_MAX_CONCENTRATION: 0.65,  // one exchange holding >65% of total quote currency triggers a reactive suggestion
  MIN_TRANSFER_USD: 50,           // don't bother suggesting a transfer smaller than this
  PREDICTIVE_MIN_CONCENTRATION: 0.45, // below the reactive threshold, but worth a predictive heads-up if bias is consistent
};

/**
 * _fetchExchangeBalances — reads quote + base asset balances for one
 * configured exchange. Never throws: a credential/network failure for one
 * exchange is reported inline so the rest of the reconciliation can still
 * run.
 */
async function _fetchExchangeBalances(exchange, quoteAsset, baseAsset) {
  const envKeys = liveExecution.EXCHANGE_ENV_KEYS[exchange];
  if (!envKeys) return { exchange, ok: false, error: `${exchange} not supported for live execution` };

  const apiKey = process.env[envKeys.key];
  const apiSecret = process.env[envKeys.secret];
  if (!apiKey || !apiSecret) {
    return { exchange, ok: false, error: `${envKeys.key}/${envKeys.secret} not configured` };
  }

  try {
    const client = liveExecution.getExchangeClient(exchange, apiKey, apiSecret);
    const [quoteBalance, baseBalance] = await Promise.all([
      client.getBalance(quoteAsset),
      client.getBalance(baseAsset),
    ]);
    return { exchange, ok: true, quoteAsset, quoteBalance, baseAsset, baseBalance };
  } catch (e) {
    return { exchange, ok: false, error: e.message };
  }
}

/**
 * checkInventory — fetches real balances across all configured live
 * exchanges and flags quote-currency concentration imbalance the same way
 * rebalanceEngine.THRESHOLDS.USDT_MAX_CONCENTRATION does for the
 * simulated wallets, but against live account data.
 *
 * @param {object} opts
 * @param {string} opts.quoteAsset - default 'USDT'
 * @param {string} opts.baseAsset  - default 'BTC'
 * @param {string[]} [opts.exchanges] - defaults to all EXCHANGE_ENV_KEYS
 * @returns {object} { balances, totalQuote, suggestions, checkedAt }
 */
async function checkInventory({ quoteAsset = 'USDT', baseAsset = 'BTC', exchanges } = {}) {
  const targetExchanges = exchanges || Object.keys(liveExecution.EXCHANGE_ENV_KEYS);

  const balances = await Promise.all(
    targetExchanges.map(exchange => _fetchExchangeBalances(exchange, quoteAsset, baseAsset)),
  );

  const ok = balances.filter(b => b.ok);
  const totalQuote = ok.reduce((sum, b) => sum + b.quoteBalance, 0);

  const suggestions = [];
  const flaggedReactive = new Set();
  if (ok.length >= 2 && totalQuote > 0) {
    const evenShare = totalQuote / ok.length;
    for (const b of ok) {
      const concentration = b.quoteBalance / totalQuote;
      if (concentration > THRESHOLDS.QUOTE_MAX_CONCENTRATION) {
        const excess = b.quoteBalance - evenShare;
        if (excess >= THRESHOLDS.MIN_TRANSFER_USD) {
          // Suggest moving the excess to whichever other exchange is lowest.
          const target = ok
            .filter(o => o.exchange !== b.exchange)
            .sort((a, c) => a.quoteBalance - c.quoteBalance)[0];
          flaggedReactive.add(b.exchange);
          suggestions.push({
            trigger: 'reactive',
            from: b.exchange,
            to: target.exchange,
            asset: quoteAsset,
            amount: Math.round(excess * 100) / 100,
            reason: `${b.exchange} holds ${(concentration * 100).toFixed(1)}% of total ${quoteAsset} ` +
                    `(> ${(THRESHOLDS.QUOTE_MAX_CONCENTRATION * 100).toFixed(0)}% threshold)`,
          });
        }
      }
    }
  }

  // ─── Predictive: directional bias on recent live trades ─────────────────
  // Only meaningful once at least 2 exchanges reported real balances; skips
  // exchanges already flagged reactively (already actionable above) and
  // exchanges whose concentration is nowhere near becoming a problem, so
  // this never fires noise on a healthy, well-distributed book.
  if (ok.length >= 2 && totalQuote > 0) {
    const auditLog = liveExecution.getAuditLog();
    const crossTrades = auditLog.filter(e => e.event === 'CROSS_EXECUTE_SUCCESS');
    const biasSignals = directionalBiasTracker.getBiasSignals(crossTrades);

    for (const signal of biasSignals) {
      if (flaggedReactive.has(signal.exchange)) continue;
      const holder = ok.find(o => o.exchange === signal.exchange);
      if (!holder) continue;

      const concentration = holder.quoteBalance / totalQuote;
      if (concentration < THRESHOLDS.PREDICTIVE_MIN_CONCENTRATION) continue;

      // A 'buyer' exchange spends quote currency to acquire the base asset,
      // so consistently buying there *drains* quote concentration there —
      // the predictive risk is the exchange running low, not concentrated.
      // A 'seller' exchange receives quote currency from selling the base
      // asset, so consistently selling there *builds up* quote
      // concentration — that's the side worth a predictive heads-up.
      if (signal.direction !== 'seller') continue;

      const target = ok
        .filter(o => o.exchange !== signal.exchange)
        .sort((a, c) => a.quoteBalance - c.quoteBalance)[0];
      if (!target) continue;

      suggestions.push({
        trigger: 'predictive',
        from: signal.exchange,
        to: target.exchange,
        asset: quoteAsset,
        amount: null, // no reactive excess to move yet — informational, not sized
        biasScore: signal.biasScore,
        sampleSize: signal.sampleSize,
        reason: `${signal.exchange} has been the sell-side on ${signal.sells}/${signal.sampleSize} ` +
                `recent cross-exchange trades (bias ${signal.biasScore.toFixed(2)}) while already holding ` +
                `${(concentration * 100).toFixed(1)}% of total ${quoteAsset} — likely to cross the ` +
                `${(THRESHOLDS.QUOTE_MAX_CONCENTRATION * 100).toFixed(0)}% reactive threshold if this pattern continues`,
      });
    }
  }

  const failed = balances.filter(b => !b.ok);
  if (failed.length > 0) {
    logger.warn('liveInventoryReconciliation', 'Some exchanges could not be reconciled', {
      failed: failed.map(f => ({ exchange: f.exchange, error: f.error })),
    });
  }

  return {
    balances,
    totalQuote,
    quoteAsset,
    baseAsset,
    suggestions,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  checkInventory,
  THRESHOLDS,
};

'use strict';

/**
 * predictiveRebalance.js — Kukora v17
 *
 * Section 9: Predictive rebalancing engine.
 * Section 10: Capital efficiency engine.
 *
 * Replaces reactive rebalancing with predictive analytics:
 *   - Forecast balance consumption rate from recent trade history
 *   - Predict wallet depletion time per exchange
 *   - Generate rebalancing recommendations before imbalance occurs
 *   - Track capital utilization and efficiency scores
 *   - Recommend balance distribution automatically
 *
 * Models:
 *   - Rolling window depletion rate (BTC/hour per exchange)
 *   - EWMA capital utilization
 *   - Opportunity coverage score (how many opportunities are missed due to balance)
 */

const liveConfig    = require('../../infrastructure/liveConfig');
const observability = require('../../infrastructure/observabilityService');
const { isTrade }   = require('../opportunity');

// ─── State ────────────────────────────────────────────────────────────────
const _tradeHistory = [];       // recent trade records for rate calculation
const MAX_TRADE_HISTORY = 200;

const _utilizationHistory = []; // { ts, utilized, total, ratio } — rolling 100 points
const MAX_UTIL_HISTORY = 100;

/**
 * Test-only: clears trade/utilization history so test files can isolate
 * cases without relying on module-cache resets (this module keeps state
 * in closure scope, same as walletManager's in-memory wallets — in
 * production that state resets implicitly on process restart; tests need
 * an explicit hook, mirroring walletManager.resetBalances()).
 */
function _resetForTests() {
  _tradeHistory.length = 0;
  _utilizationHistory.length = 0;
}

// ─── Trade intake ─────────────────────────────────────────────────────────

function recordTrade(trade) {
  // Contract check (audit committee, sección 12, punto 1): entry point
  // where this engine consumes a Trade built by executeSimulated() (see
  // opportunityDetection.js). Non-blocking — see the matching check there
  // for the full rationale.
  if (!isTrade(trade)) {
    observability.emit('RISK', 'contract.trade_shape_invalid', { id: trade.id, buyExchange: trade.buyExchange, sellExchange: trade.sellExchange, source: 'predictiveRebalance' });
  }

  _tradeHistory.push({
    ts:            Date.now(),
    buyExchange:   trade.buyExchange,
    sellExchange:  trade.sellExchange,
    amount:        trade.amount,        // BTC consumed on sellExchange
    usdtSpent:     (trade.buyPrice || 50000) * trade.amount,  // USDT consumed on buyExchange
    netProfit:     trade.netProfit,
  });
  if (_tradeHistory.length > MAX_TRADE_HISTORY) _tradeHistory.shift();
}

// ─── Section 9: Balance consumption rate ──────────────────────────────────

/**
 * Compute rolling consumption rates per exchange.
 * Returns { exchange: { btcPerHour, usdtPerHour, depletion: { btcHours, usdtHours } } }
 */
function computeConsumptionRates(wallets, windowMs = 3600_000) {
  const now       = Date.now();
  const cutoff    = now - windowMs;
  const recent    = _tradeHistory.filter(t => t.ts >= cutoff);

  const btcConsumed  = {};  // exchange → BTC sold
  const usdtConsumed = {};  // exchange → USDT spent

  for (const t of recent) {
    btcConsumed[t.sellExchange]  = (btcConsumed[t.sellExchange]  || 0) + t.amount;
    usdtConsumed[t.buyExchange]  = (usdtConsumed[t.buyExchange]  || 0) + t.usdtSpent;
  }

  const windowHours = windowMs / 3_600_000;
  const rates       = {};
  const exchanges   = liveConfig.ALL_EXCHANGES;

  for (const ex of exchanges) {
    const btcPerHour  = (btcConsumed[ex]  || 0) / windowHours;
    const usdtPerHour = (usdtConsumed[ex] || 0) / windowHours;

    const currentBtc  = wallets.BTC?.[ex]  || 0;
    const currentUsdt = wallets.USDT?.[ex] || 0;

    const btcHours   = btcPerHour  > 0 ? currentBtc  / btcPerHour  : Infinity;
    const usdtHours  = usdtPerHour > 0 ? currentUsdt / usdtPerHour : Infinity;

    rates[ex] = {
      btcPerHour:   +btcPerHour.toFixed(6),
      usdtPerHour:  +usdtPerHour.toFixed(2),
      currentBtc:   +currentBtc.toFixed(6),
      currentUsdt:  +currentUsdt.toFixed(2),
      depletionBtcHours:  btcHours  === Infinity ? null : +btcHours.toFixed(1),
      depletionUsdtHours: usdtHours === Infinity ? null : +usdtHours.toFixed(1),
      depletionInHours:   Math.min(btcHours === Infinity ? 9999 : btcHours,
                                   usdtHours === Infinity ? 9999 : usdtHours),
    };
  }

  return rates;
}

/**
 * Generate predictive rebalancing recommendations before imbalance occurs.
 * Fires when projected depletion < predictionWindow (from liveConfig).
 */
function generatePredictiveRecommendations(wallets, btcPrice) {
  const windowSecs    = liveConfig.get('rebalancePredictionWindow');
  const windowHours   = windowSecs / 3600;
  const costLimit     = liveConfig.get('rebalanceCostLimit');
  const minTransfer   = liveConfig.get('minimumTransferAmount');

  const rates         = computeConsumptionRates(wallets);
  const recommendations = [];

  for (const [ex, rate] of Object.entries(rates)) {
    // BTC warning
    if (rate.depletionBtcHours !== null && rate.depletionBtcHours < windowHours) {
      const neededBtc     = rate.btcPerHour * windowHours - rate.currentBtc;
      const neededUSD     = neededBtc * btcPrice;

      if (neededUSD >= minTransfer) {
        const transferCost = computeTransferCost('BTC', neededBtc, btcPrice);
        recommendations.push({
          type:           'btc_depletion',
          exchange:       ex,
          urgency:        rate.depletionBtcHours < 0.5 ? 'critical' : rate.depletionBtcHours < 2 ? 'high' : 'medium',
          depletionInHours: rate.depletionBtcHours,
          neededBtc:      +neededBtc.toFixed(6),
          neededUSD:      +neededUSD.toFixed(2),
          transferCost:   +transferCost.toFixed(2),
          netBenefit:     +(neededUSD * (rate.btcPerHour / windowHours) * 0.001 - transferCost).toFixed(2),
          viable:         transferCost <= costLimit && neededUSD >= minTransfer,
          action:         `Transfer ${neededBtc.toFixed(4)} BTC to ${ex}`,
          sourceExchange: findBestSource('BTC', neededBtc, wallets, ex),
        });
      }
    }

    // USDT warning
    if (rate.depletionUsdtHours !== null && rate.depletionUsdtHours < windowHours) {
      const neededUsdt = rate.usdtPerHour * windowHours - rate.currentUsdt;

      if (neededUsdt >= minTransfer) {
        const transferCost = computeTransferCost('USDT', neededUsdt, btcPrice);
        recommendations.push({
          type:           'usdt_depletion',
          exchange:       ex,
          urgency:        rate.depletionUsdtHours < 0.5 ? 'critical' : rate.depletionUsdtHours < 2 ? 'high' : 'medium',
          depletionInHours: rate.depletionUsdtHours,
          neededUsdt:     +neededUsdt.toFixed(2),
          transferCost:   +transferCost.toFixed(2),
          viable:         transferCost <= costLimit && neededUsdt >= minTransfer,
          action:         `Transfer ${neededUsdt.toFixed(2)} USDT to ${ex}`,
          sourceExchange: findBestSource('USDT', neededUsdt, wallets, ex),
        });
      }
    }
  }

  // Sort by urgency
  const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  recommendations.sort((a, b) => (urgencyOrder[a.urgency] || 3) - (urgencyOrder[b.urgency] || 3));

  if (recommendations.some(r => r.urgency === 'critical')) {
    observability.emit('REBALANCE', 'rebalance.predictive.critical', {
      count: recommendations.filter(r => r.urgency === 'critical').length,
      exchanges: recommendations.filter(r => r.urgency === 'critical').map(r => r.exchange),
    }, 'warn');
  }

  return {
    rates,
    recommendations,
    windowHours,
    generatedAt: new Date().toISOString(),
    hasUrgent:   recommendations.some(r => r.urgency === 'critical' || r.urgency === 'high'),
  };
}

function findBestSource(asset, amount, wallets, excludeExchange) {
  const exchanges = liveConfig.ALL_EXCHANGES.filter(e => e !== excludeExchange);
  const balances = exchanges.map(ex => ({
    exchange: ex,
    balance:  wallets[asset]?.[ex] || 0,
  }));
  balances.sort((a, b) => b.balance - a.balance);
  return balances[0]?.exchange || null;
}

function computeTransferCost(asset, amount, btcPrice) {
  const { WITHDRAWAL_FEES } = require('../wallet/feeConfig');
  if (asset === 'BTC') {
    const avgFee = Object.values(WITHDRAWAL_FEES).reduce((s, f) => s + (f.BTC || 0.0003), 0) / Object.keys(WITHDRAWAL_FEES).length;
    return avgFee * btcPrice;
  }
  const avgFee = Object.values(WITHDRAWAL_FEES).reduce((s, f) => s + (f.USDT || 6), 0) / Object.keys(WITHDRAWAL_FEES).length;
  return avgFee;
}

// ─── Section 10: Capital Efficiency Engine ─────────────────────────────────

/**
 * Compute capital efficiency metrics.
 * Measures how productively deployed capital is working.
 */
function computeCapitalEfficiency(wallets, btcPrice, sessionPnl, sessionTradeCount, uptimeMs) {
  const totalBtc   = Object.values(wallets.BTC  || {}).reduce((s, v) => s + (v || 0), 0);
  const totalUsdt  = Object.values(wallets.USDT || {}).reduce((s, v) => s + (v || 0), 0);
  const totalCapital = totalBtc * btcPrice + totalUsdt;

  if (totalCapital === 0) return { error: 'No capital deployed' };

  const uptimeHours        = Math.max(uptimeMs / 3_600_000, 1 / 60);
  const profitPerHour      = sessionPnl / uptimeHours;
  const projectedDailyPnl  = profitPerHour * 24;
  const projectedYearlyPnl = projectedDailyPnl * 365;
  const roiAnnualizedPct   = totalCapital > 0 ? (projectedYearlyPnl / totalCapital) * 100 : 0;

  // Utilization: fraction of capital actively used in trades per hour
  const recentTrades    = _tradeHistory.filter(t => t.ts >= Date.now() - 3_600_000);
  const capitalUsed     = recentTrades.reduce((s, t) => s + t.usdtSpent, 0);
  const utilizationRatio = Math.min(1, capitalUsed / totalCapital);

  // Idle capital detection: exchanges with very low activity
  const idleExchanges = [];
  for (const [ex, rate] of Object.entries(computeConsumptionRates(wallets, 3_600_000))) {
    const exCapital = (wallets.BTC?.[ex] || 0) * btcPrice + (wallets.USDT?.[ex] || 0);
    const exShare   = totalCapital > 0 ? exCapital / totalCapital : 0;
    if (exShare > 0.05 && rate.btcPerHour < 0.001 && rate.usdtPerHour < 10) {
      idleExchanges.push({
        exchange:         ex,
        capitalUSD:       +exCapital.toFixed(2),
        capitalShare:     +(exShare * 100).toFixed(1),
        btcPerHour:       rate.btcPerHour,
        suggestion:       `Consider rebalancing some capital from ${ex} to higher-activity exchanges`,
      });
    }
  }

  // Opportunity coverage score: fraction of detected opportunities we could fill
  const reservePct     = liveConfig.get('reserveCapitalPct');
  const deployableCapital = totalCapital * (1 - reservePct);
  const tradesPerHour  = recentTrades.length;
  const capitalPerTrade = tradesPerHour > 0 ? deployableCapital / tradesPerHour : deployableCapital;
  const coverageScore  = Math.min(100, (deployableCapital / (50000 * 0.05)) * 10);  // relative to 1 BTC trade at $50k

  // Record utilization for history
  _utilizationHistory.push({
    ts:          Date.now(),
    utilized:    capitalUsed,
    total:       totalCapital,
    ratio:       utilizationRatio,
  });
  if (_utilizationHistory.length > MAX_UTIL_HISTORY) _utilizationHistory.shift();

  // Optimal distribution recommendation
  const optimalDistribution = computeOptimalDistribution(wallets, btcPrice, recentTrades);

  return {
    totalCapitalUSD:      +totalCapital.toFixed(2),
    deployableCapitalUSD: +deployableCapital.toFixed(2),
    reserveCapitalUSD:    +(totalCapital * reservePct).toFixed(2),
    utilizationRatio:     +utilizationRatio.toFixed(3),
    utilizationScore:     +(utilizationRatio * 100).toFixed(1),
    capitalEfficiencyScore: +(utilizationRatio * roiAnnualizedPct / 100 * 100).toFixed(1),
    opportunityCoverageScore: +coverageScore.toFixed(1),
    capitalPerTradeUSD:       +capitalPerTrade.toFixed(2),
    roiAnnualizedPct:     +roiAnnualizedPct.toFixed(2),
    projectedDailyPnl:    +projectedDailyPnl.toFixed(4),
    sessionPnl:           +sessionPnl.toFixed(4),
    sessionTradeCount,
    uptimeHours:          +uptimeHours.toFixed(2),
    profitPerHour:        +profitPerHour.toFixed(4),
    idleExchanges,
    optimalDistribution,
    utilizationTrend:     _utilizationHistory.slice(-10).map(u => ({ ts: new Date(u.ts).toISOString(), ratio: +u.ratio.toFixed(3) })),
  };
}

/**
 * Recommend optimal balance distribution based on historical trade activity.
 */
function computeOptimalDistribution(wallets, btcPrice, recentTrades) {
  const exchanges   = liveConfig.ALL_EXCHANGES;
  const buyActivity = {};   // exchange → count as buy side
  const sellActivity = {};  // exchange → count as sell side

  for (const t of recentTrades) {
    buyActivity[t.buyExchange]   = (buyActivity[t.buyExchange]   || 0) + 1;
    sellActivity[t.sellExchange] = (sellActivity[t.sellExchange] || 0) + 1;
  }

  const totalBuys  = Object.values(buyActivity).reduce((s, v) => s + v, 0) || 1;
  const totalSells = Object.values(sellActivity).reduce((s, v) => s + v, 0) || 1;

  const totalBtc  = Object.values(wallets.BTC  || {}).reduce((s, v) => s + (v || 0), 0);
  const totalUsdt = Object.values(wallets.USDT || {}).reduce((s, v) => s + (v || 0), 0);

  return exchanges.map(ex => {
    const buyShare  = (buyActivity[ex]  || 0) / totalBuys;
    const sellShare = (sellActivity[ex] || 0) / totalSells;

    // Buy-heavy → needs more USDT; Sell-heavy → needs more BTC
    const optimalUsdt = totalUsdt > 0 ? totalUsdt * Math.max(0.1, buyShare)  : null;
    const optimalBtc  = totalBtc  > 0 ? totalBtc  * Math.max(0.1, sellShare) : null;

    const currentUsdt = wallets.USDT?.[ex] || 0;
    const currentBtc  = wallets.BTC?.[ex]  || 0;

    return {
      exchange:      ex,
      buyActivity:   buyActivity[ex]  || 0,
      sellActivity:  sellActivity[ex] || 0,
      optimalUsdt:   optimalUsdt !== null ? +optimalUsdt.toFixed(2) : null,
      optimalBtc:    optimalBtc  !== null ? +optimalBtc.toFixed(6)  : null,
      currentUsdt:   +currentUsdt.toFixed(2),
      currentBtc:    +currentBtc.toFixed(6),
      usdtDelta:     optimalUsdt !== null ? +(optimalUsdt - currentUsdt).toFixed(2) : null,
      btcDelta:      optimalBtc  !== null ? +(optimalBtc  - currentBtc).toFixed(6)  : null,
    };
  });
}

module.exports = {
  recordTrade,
  computeConsumptionRates,
  generatePredictiveRecommendations,
  computeCapitalEfficiency,
  computeOptimalDistribution,
  // Test-only: clears trade/utilization history so test files can isolate
  // cases without relying on module-cache resets (this module keeps state
  // in closure scope, same as walletManager's in-memory wallets — in
  // production that state resets implicitly on process restart; tests need
  // an explicit hook, mirroring walletManager.resetBalances()).
  _resetForTests,
};

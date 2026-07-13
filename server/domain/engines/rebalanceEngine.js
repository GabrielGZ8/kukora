/**
 * rebalanceEngine.js — Kukora v17
 *
 * Intelligent balance management between exchanges.
 * Detects imbalance, computes optimal movement, simulates execution.
 *
 * v17 additions (Sections 9 & 10):
 *   - Predictive rebalancing: fires BEFORE depletion occurs
 *   - Cost/benefit analysis per rebalancing action
 *   - Integration with liveConfig for hot-reload thresholds
 *   - Structured observability events (no console.log)
 *   - Opportunity cost calculation (missed trades due to imbalance)
 *   - Full audit trail per rebalancing action
 */

'use strict';

const crypto = require('crypto');
const { isBalanceAnalysis, isRebalanceSuggestionResult, isExecuteRebalanceResult } = require('./rebalance');
const { getBalances, getPnL, applyRebalanceTransfer } = require('../wallet/walletManager');
const { WITHDRAWAL_FEES }               = require('../wallet/feeConfig');
const liveConfig                        = require('../../infrastructure/liveConfig');
const observability                     = require('../../infrastructure/observabilityService');
const { getEnabledExchangeNames }       = require('../../infrastructure/exchangeRegistry');
const { generatePredictiveRecommendations, computeConsumptionRates } = require('./predictiveRebalance');

// Edge case fix: this used to be a hardcoded literal
// (['Binance', 'Kraken', 'Bybit', 'OKX', 'Coinbase']) that silently drifted
// from the real exchange list the moment a 6th exchange was registered via
// exchangeRegistry.js — liveConfig.js, walletManager.js, and
// arbitrageOrchestrator.js already derive their exchange list from the
// registry (the documented single source of truth, see exchangeRegistry.js
// header); rebalanceEngine.js was the one holdout still hand-listing
// exchanges, which meant a newly-registered exchange's balances would be
// silently ignored by analyzeBalance()/suggestRebalance() instead of
// participating in rebalancing.
const ALL_EXCHANGES = getEnabledExchangeNames();

// Exposed for tests and external consumers.
// NOTE (robustness audit): these constants are NOT the live source of truth
// for thresholds — analyzeBalance()/suggestRebalance() below read
// liveConfig.get('rebalanceThresholdPct'|'rebalanceCostLimit'|
// 'minimumTransferAmount') instead, which are hot-reloadable. THRESHOLDS
// exists for backward-compat with external consumers/tests that read this
// export directly (see tests/smoke.test.js) and as a rough reference for
// the defaults; it does not drive behavior. If you're trying to change
// rebalancing thresholds at runtime, change liveConfig, not this object.
const THRESHOLDS = {
  USDT_MAX_CONCENTRATION:  0.60,   // 60% of total USDT in one exchange triggers rebalance
  BTC_MIN_PER_EXCHANGE:    0.002,  // minimum BTC per exchange for viable execution
  REBALANCE_COST_LIMIT:    15.0,   // max USD cost per rebalance action
  MIN_TRANSFER_USD:        50.0,   // minimum transfer worth executing
};

const MAX_HISTORY     = 200;
const _history        = [];
let   _lastSuggestion = null;
let   _opportunityCostAccumulator = 0;  // USD missed due to imbalance

// ─── Helpers ──────────────────────────────────────────────────────────────

function safeWithdrawalFee(exchange, asset) {
  if (WITHDRAWAL_FEES[exchange] && WITHDRAWAL_FEES[exchange][asset] !== undefined) {
    return WITHDRAWAL_FEES[exchange][asset];
  }
  // Item 3: fallback genérico si el exchange/asset no está en la tabla —
  // ya no asume que "no-BTC" significa el fallback plano de USDT ($6);
  // XRP tiene su propio fallback de referencia (fees casi nulos).
  if (asset === 'BTC') return 0.0003;
  if (asset === 'XRP') return 0.2;
  return 6.0;
}

// ─── Reactive balance analysis ────────────────────────────────────────────

function analyzeBalance(btcPrice = 50000) {
  const wallets        = getBalances();
  const usdtByExchange = wallets.USDT || {};
  const btcByExchange  = wallets.BTC  || {};

  const totalUSDT = Object.values(usdtByExchange).reduce((a, b) => a + b, 0);
  const totalBTC  = Object.values(btcByExchange).reduce((a, b) => a + b, 0);
  const totalUSD  = totalUSDT + totalBTC * btcPrice;

  const maxConcentration = liveConfig.get('rebalanceThresholdPct');
  const btcTargetRatio   = 1 / ALL_EXCHANGES.length;  // equal distribution
  const imbalances = [];

  // USDT concentration
  for (const [ex, usdt] of Object.entries(usdtByExchange)) {
    if (totalUSDT > 0 && usdt / totalUSDT > maxConcentration) {
      const excessPct = ((usdt / totalUSDT) - maxConcentration) * 100;
      const excessUSD = usdt - totalUSDT * maxConcentration;
      imbalances.push({
        type:        'usdt_concentration',
        exchange:    ex,
        severity:    excessPct > 30 ? 'high' : excessPct > 15 ? 'medium' : 'low',
        description: `${ex} holds ${(usdt/totalUSDT*100).toFixed(1)}% of total USDT (limit: ${(maxConcentration*100).toFixed(0)}%)`,
        excessUSD:   +excessUSD.toFixed(2),
        excessPct:   +excessPct.toFixed(2),
        currentUSDT: +usdt.toFixed(2),
        totalUSDT:   +totalUSDT.toFixed(2),
      });
    }
  }

  // BTC shortage
  for (const [ex, btc] of Object.entries(btcByExchange)) {
    const ratio     = totalBTC > 0 ? btc / totalBTC : 0;
    const minRatio  = btcTargetRatio * 0.5;  // below 50% of target is a shortage
    if (totalBTC > 0 && ratio < minRatio) {
      const shortfallBtc = totalBTC * minRatio - btc;
      const shortfallUSD = shortfallBtc * btcPrice;
      imbalances.push({
        type:          'btc_shortage',
        exchange:      ex,
        severity:      ratio < minRatio * 0.3 ? 'high' : 'medium',
        description:   `${ex} has only ${(ratio*100).toFixed(1)}% of total BTC (min: ${(minRatio*100).toFixed(0)}%)`,
        shortfallBtc:  +shortfallBtc.toFixed(6),
        shortfallUSD:  +shortfallUSD.toFixed(2),
        currentBtc:    +btc.toFixed(6),
        targetBtc:     +(totalBTC * btcTargetRatio).toFixed(6),
      });
    }
  }

  const result = {
    imbalances,
    summary: {
      totalUSDT: +totalUSDT.toFixed(2),
      totalBTC:  +totalBTC.toFixed(6),
      totalUSD:  +totalUSD.toFixed(2),
      byExchange: ALL_EXCHANGES.map(ex => ({
        exchange: ex,
        usdt:     +(usdtByExchange[ex] || 0).toFixed(2),
        btc:      +(btcByExchange[ex]  || 0).toFixed(6),
        totalUSD: +((usdtByExchange[ex] || 0) + (btcByExchange[ex] || 0) * btcPrice).toFixed(2),
      })),
    },
    healthy:    imbalances.length === 0,
    highCount:  imbalances.filter(i => i.severity === 'high').length,
  };

  // Soft contract check (non-blocking — see rebalance.ts). Wired at the
  // producer: this is the only function that builds this shape.
  if (!isBalanceAnalysis(result)) {
    observability.emit('REBALANCE', 'contract.balance_analysis_shape_invalid', {});
  }

  return result;
}

// ─── Suggestion engine ────────────────────────────────────────────────────

function suggestRebalance(btcPrice = 50000, wallets = null) {
  if (!wallets) wallets = getBalances();
  const analysis = analyzeBalance(btcPrice);
  if (analysis.healthy) {
    _lastSuggestion = null;
    const result = { needed: false, analysis, reason: 'All exchanges balanced — no rebalance needed' };
    if (!isRebalanceSuggestionResult(result)) {
      observability.emit('REBALANCE', 'contract.rebalance_suggestion_result_shape_invalid', { needed: false });
    }
    return result;
  }

  const costLimit    = liveConfig.get('rebalanceCostLimit');
  const minTransfer  = liveConfig.get('minimumTransferAmount');
  const suggestions  = [];

  for (const imbalance of analysis.imbalances) {
    if (imbalance.type === 'usdt_concentration') {
      const sourceEx  = imbalance.exchange;
      const moveUSD   = Math.min(imbalance.excessUSD, imbalance.currentUSDT * 0.5);
      if (moveUSD < minTransfer) continue;

      // Find the exchange with least USDT
      const target = ALL_EXCHANGES
        .filter(e => e !== sourceEx)
        .map(e => ({ exchange: e, usdt: wallets.USDT?.[e] || 0 }))
        .sort((a, b) => a.usdt - b.usdt)[0];

      if (!target) continue;

      const fee = safeWithdrawalFee(sourceEx, 'USDT');
      const costUSD = fee;
      const benefit = moveUSD * 0.001;  // estimated benefit from better utilization

      suggestions.push({
        asset:           'USDT',
        from:            sourceEx,
        to:              target.exchange,
        amount:          +moveUSD.toFixed(2),
        fee:             +costUSD.toFixed(4),
        netBenefit:      +(benefit - costUSD).toFixed(4),
        viable:          costUSD <= costLimit && moveUSD >= minTransfer,
        reason:          imbalance.description,
        severity:        imbalance.severity,
        priority:        imbalance.severity === 'high' ? 1 : 2,
      });
    }

    if (imbalance.type === 'btc_shortage') {
      const targetEx   = imbalance.exchange;
      const needBtc    = imbalance.shortfallBtc;
      const needUSD    = imbalance.shortfallUSD;
      if (needUSD < minTransfer) continue;

      const source = ALL_EXCHANGES
        .filter(e => e !== targetEx)
        .map(e => ({ exchange: e, btc: wallets.BTC?.[e] || 0 }))
        .sort((a, b) => b.btc - a.btc)[0];

      if (!source || source.btc < needBtc) continue;

      const fee = safeWithdrawalFee(source.exchange, 'BTC') * btcPrice;
      suggestions.push({
        asset:      'BTC',
        from:       source.exchange,
        to:         targetEx,
        amount:     +needBtc.toFixed(6),
        amountUSD:  +needUSD.toFixed(2),
        fee:        +fee.toFixed(4),
        netBenefit: +(needUSD * 0.001 - fee).toFixed(4),
        viable:     fee <= costLimit && needUSD >= minTransfer,
        reason:     imbalance.description,
        severity:   imbalance.severity,
        priority:   imbalance.severity === 'high' ? 1 : 2,
      });
    }
  }

  suggestions.sort((a, b) => a.priority - b.priority);
  _lastSuggestion = { suggestions, analysis, btcPrice, ts: new Date().toISOString() };
  const topReason = suggestions[0]?.reason || 'Imbalance detected across exchanges';
  const result = { needed: true, suggestions, analysis, reason: topReason };
  if (!isRebalanceSuggestionResult(result)) {
    observability.emit('REBALANCE', 'contract.rebalance_suggestion_result_shape_invalid', { needed: true });
  }
  return result;
}

// ─── Execution ────────────────────────────────────────────────────────────

// CALL-SITE BUG FIX (wallets/rebalancing audit): this function used to be
// `executeRebalance(suggestion, wallets, _btcPrice)`, expecting the caller
// to pass a live balances object as the 2nd argument. The only real caller
// — POST /api/arbitrage/rebalance/execute — actually calls
// `rebalanceEngine.executeRebalance(suggestion, btcPrice)` with just two
// arguments, so `wallets` silently received a *number* (btcPrice) instead.
// `wallets[asset]?.[from]` on a number is always `undefined` → `|| 0`, so
// this endpoint could never do anything but return "insufficient balance".
// Fixed by matching the function's signature to how it is actually called,
// and by committing the transfer through walletManager's real state
// (applyRebalanceTransfer) instead of mutating a parameter that — even if
// it had been wired correctly — would only ever have been a disposable
// deep copy from getBalances().
function executeRebalance(suggestion, _btcPrice) {
  if (!suggestion || !suggestion.viable) {
    return { ok: false, reason: 'Rebalance not viable or not suggested' };
  }

  const { asset, from, to, amount, fee } = suggestion;

  // Defense in depth (robustness audit): POST /api/arbitrage/rebalance/execute
  // falls back to `req.body.suggestion` when no suggestion id is tracked
  // server-side (see server/arbitrage/subroutes/config.routes.js) — so this
  // function is reachable with a caller-supplied object, and
  // `suggestion.viable` above is a field on THAT object, not something this
  // module computed. It is not a trustworthy authorization check by itself.
  // Validate the actual transfer parameters independently of what the
  // caller claims about viability.
  if (asset !== 'BTC' && asset !== 'USDT') {
    return { ok: false, reason: `Unsupported asset: ${asset}` };
  }
  if (!ALL_EXCHANGES.includes(from) || !ALL_EXCHANGES.includes(to)) {
    return { ok: false, reason: `from/to must both be a known exchange (got from=${from}, to=${to})` };
  }
  if (from === to) {
    return { ok: false, reason: 'from and to must be different exchanges' };
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: `amount must be a positive finite number (got ${amount})` };
  }

  // Withdrawal fee, charged in the transferred asset's own units (BTC fee
  // in BTC, USDT fee in USDT) at the destination. Computed here (rather
  // than trusting suggestion.fee, which for the BTC case is USD-denominated
  // — see suggestRebalance — and for a client-supplied suggestion isn't
  // trustworthy at all) so applyRebalanceTransfer can reject up front if
  // `amount` doesn't even cover it, instead of leaving a negative balance.
  const withdrawalFee = asset === 'BTC' ? safeWithdrawalFee(from, 'BTC') : safeWithdrawalFee(from, 'USDT');

  const id  = `rebal-${Date.now()}-${crypto.randomUUID()}`;
  const t0  = Date.now();

  const transfer = applyRebalanceTransfer(asset, from, to, amount, withdrawalFee);
  if (!transfer.ok) {
    return { ok: false, reason: transfer.reason };
  }

  const entry = {
    id,
    ts:          new Date().toISOString(),
    asset,
    from,
    to,
    amount,
    fee,
    durationMs:  Date.now() - t0,
    status:      'completed',
    suggestion,
  };

  _history.unshift(entry);
  if (_history.length > MAX_HISTORY) _history.pop();

  observability.emit('REBALANCE', 'rebalance.executed', {
    id, asset, from, to, amount, fee,
  });

  const result = { ok: true, id, entry, walletsAfter: transfer.balancesAfter };
  if (!isExecuteRebalanceResult(result)) {
    observability.emit('REBALANCE', 'contract.execute_rebalance_result_shape_invalid', { id });
  }
  return result;
}

// ─── Predictive rebalancing ───────────────────────────────────────────────

function getPredictiveRecommendations(btcPrice) {
  const wallets = getBalances();
  return generatePredictiveRecommendations(wallets, btcPrice);
}

function getConsumptionRates(windowMs) {
  const wallets = getBalances();
  return computeConsumptionRates(wallets, windowMs);
}

// ─── Rebalance cost as % of period profit (Fase 1 committee answer, gap 1c) ─
//
// Committee answer on record: "monitoreo el costo acumulado de rebalanceo
// como % de las ganancias del período, y si supera 15-20% es señal de
// alerta." Before this addition, rebalanceEngine tracked totalFeesSpent
// (the numerator) but never computed the ratio against period profit, and
// no alert threshold existed anywhere in the codebase — this closes that
// exact gap rather than just describing it.
//
// realizedPnl is read fresh from walletManager.getPnL() (the same realized
// P&L the rest of the app treats as ground truth) so this ratio always
// reflects the live session, not a cached or duplicated number.
function getRebalanceCostRatio() {
  const totalFeesSpent = _history.reduce((s, e) => s + (e.fee || 0), 0);
  const pnl            = getPnL();
  const realizedPnl    = pnl.realizedPnl || 0;
  const alertThreshold = liveConfig.get('rebalanceCostAlertPct');

  // Ratio is undefined (not zero) when there's no profit yet to divide by —
  // reporting 0% in that case would misleadingly imply rebalancing is free.
  const ratioPct = realizedPnl > 0 ? +((totalFeesSpent / realizedPnl) * 100).toFixed(2) : null;

  return {
    totalRebalanceCostUSD: +totalFeesSpent.toFixed(4),
    periodRealizedPnlUSD:  +realizedPnl.toFixed(4),
    ratioPct,
    alertThresholdPct:     alertThreshold,
    alert:                 ratioPct !== null && ratioPct >= alertThreshold,
    note: realizedPnl <= 0
      ? 'No realized profit yet this period — ratio undefined until there is profit to divide the cost against.'
      : null,
  };
}

// ─── History & analytics ──────────────────────────────────────────────────

function getRebalanceHistory(limit = 50) {
  return _history.slice(0, limit);
}

function getLastSuggestion() {
  return _lastSuggestion;
}

// BUG FIX (refinamiento post-Sesión 34, Área 3 — automatizar el disparo del
// rebalanceo): `getLastSuggestion()` devuelve el WRAPPER completo
// `{ suggestions, analysis, btcPrice, ts }` — nunca tuvo un campo `.viable`
// ni `.asset/.from/.to/.amount/.fee` propios. Sin embargo
// `POST /rebalance/execute` en config.routes.js hacía
// `req.body?.suggestion || rebalanceEngine.getLastSuggestion()` y pasaba
// eso DIRECTO a `executeRebalance(suggestion, btcPrice)`, que destructura
// `{ asset, from, to, amount, fee }` de ese objeto — todos `undefined` en el
// wrapper, y `suggestion.viable` también `undefined` → `executeRebalance`
// devolvía siempre `{ ok: false, reason: 'Rebalance not viable or not
// suggested' }` en el fallback, sin importar qué tan buena fuera la
// sugerencia real. El único camino que funcionaba era mandar
// `req.body.suggestion` explícito — el fallback estaba roto en la práctica
// desde que se escribió. Esta función extrae la sugerencia individual de
// mayor prioridad (ya vienen ordenadas — ver `suggestions.sort(...)` en
// `suggestRebalance`) en la forma plana que `executeRebalance` sí entiende.
function getTopViableSuggestion() {
  if (!_lastSuggestion || !Array.isArray(_lastSuggestion.suggestions)) return null;
  return _lastSuggestion.suggestions.find(s => s.viable) || null;
}

function recordMissedOpportunityCost(usd) {
  _opportunityCostAccumulator += usd;
}

function getOpportunityCost() {
  return _opportunityCostAccumulator;
}

function getRebalanceSummary(btcPrice = 50000) {
  const analysis = analyzeBalance(btcPrice);
  const recent   = _history.slice(0, 10);
  const totalFeesSpent = _history.reduce((s, e) => s + (e.fee || 0), 0);
  const rebalanceCount = _history.length;
  const costRatio = getRebalanceCostRatio();

  // Refinamiento post-Sesión 34, Área 3 — visibilidad del estado de
  // automatización directamente en el mismo summary que ya consume
  // RebalancePanel.jsx, sin necesitar un endpoint aparte.
  let autoRebalance = { enabled: false, cooldownMs: null, lastAutoExecutionTs: null };
  try {
    const liveConfigMod = require('../../infrastructure/liveConfig');
    const scheduler = require('./rebalanceScheduler');
    const lastTs = scheduler.getLastAutoExecutionTs?.() || 0;
    autoRebalance = {
      enabled:              liveConfigMod.get('autoRebalanceEnabled'),
      cooldownMs:           liveConfigMod.get('autoRebalanceCooldownMs'),
      minSeverity:          liveConfigMod.get('autoRebalanceMinSeverity'),
      lastAutoExecutionTs:  lastTs > 0 ? new Date(lastTs).toISOString() : null,
    };
  } catch { /* non-fatal — summary still useful without this */ }

  return {
    analysis,
    recentRebalances:    recent,
    totalRebalances:     rebalanceCount,
    totalFeesSpent:      +totalFeesSpent.toFixed(4),
    opportunityCostUSD:  +_opportunityCostAccumulator.toFixed(4),
    lastSuggestion:      _lastSuggestion,
    lastSuggestionTs:    _lastSuggestion?.ts || null,
    costRatio,
    autoRebalance,
  };
}

// Alias functions for test/API compatibility
function getHistory(limit = 50)  { return getRebalanceHistory(limit); }
function getSummary(btcPrice)    {
  const s = getRebalanceSummary(btcPrice);
  return { total: s.totalRebalances, totalCost: s.totalFeesSpent, ...s };
}

module.exports = {
  analyzeBalance,
  suggestRebalance,
  executeRebalance,
  // canonical names
  getRebalanceHistory,
  getLastSuggestion,
  getTopViableSuggestion,
  getRebalanceSummary,
  getRebalanceCostRatio,
  getPredictiveRecommendations,
  getConsumptionRates,
  recordMissedOpportunityCost,
  getOpportunityCost,
  // alias names (used by tests + legacy routes)
  getHistory,
  getSummary,
  // exposed constants
  THRESHOLDS,
};

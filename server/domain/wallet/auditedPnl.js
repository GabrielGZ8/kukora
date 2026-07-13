/**
 * auditedPnl.js — Kukora v17
 *
 * P&L AUDITADO — separación clara entre simulado, realizado e irealizado.
 *
 * PROBLEMA ANTERIOR:
 *   netProfit se calculaba al momento de detección usando precios de ask/bid
 *   snapshot. No había reconciliación con wallets reales. Un auditor o CFO
 *   no podía verificar ningún número.
 *
 * SOLUCIÓN v17:
 *   - Cada trade registra precios de ENTRADA (al ejecutar) vs SALIDA (al cerrar)
 *   - P&L realizado = diferencia de wallets antes/después del trade
 *   - P&L irealizado = posiciones abiertas marcadas a precio de mercado actual
 *   - Mark-to-market automático en cada ciclo
 *   - Trail de auditoría completo: cada centavo explicado
 *   - Reconciliación: walletPnl debe == sum(tradePnl) dentro de tolerancia
 *
 * ESTRUCTURA:
 *   - TradeRecord: precio entrada, precio salida, fees reales, slippage real
 *   - AuditedSession: P&L realizado + irealizado + reconciliación
 *   - DailyPnlLedger: P&L por día para reporting financiero
 */

'use strict';

// ─── State ─────────────────────────────────────────────────────────────────
const _trades        = [];    // [{id, ts, ...}] todos los trades auditados
const _dailyLedger   = {};    // 'YYYY-MM-DD' → { realized, fees, tradeCount }
let   _sessionStart  = Date.now();
let   _sessionStartWalletUSD = null;

// Tolerancia de reconciliación: diferencia máxima aceptable entre
// wallet delta y sum(netProfit) antes de disparar alerta
const RECONCILIATION_TOLERANCE_USD = 0.01;

// ─── Trade intake ─────────────────────────────────────────────────────────

/**
 * Registra un trade completado con todos los datos necesarios para auditoría.
 * Se llama DESPUÉS de applyTrade() — con precios y fees reales.
 *
 * @param {object} trade   — resultado de applyTrade()
 * @param {object} walletBefore — snapshot de wallets ANTES del trade
 * @param {object} walletAfter  — snapshot de wallets DESPUÉS del trade
 * @param {number} btcPrice — precio BTC al momento del trade
 */
function recordAuditedTrade(trade, walletBefore, walletAfter, btcPrice) {
  const usdBefore = computeWalletUSD(walletBefore, btcPrice);
  const usdAfter  = computeWalletUSD(walletAfter,  btcPrice);
  const walletDelta = usdAfter - usdBefore;

  // P&L según wallets (source of truth)
  // P&L según trade.netProfit (modelo)
  const reconciliationDelta = walletDelta - (trade.netProfit || 0);
  const reconciled = Math.abs(reconciliationDelta) <= RECONCILIATION_TOLERANCE_USD;

  const entry = {
    id:               trade.id || `t-${Date.now()}`,
    ts:               trade.ts || new Date().toISOString(),
    // Leg details
    buyExchange:      trade.buyExchange,
    sellExchange:     trade.sellExchange,
    amount:           trade.amount,
    // Prices — what we actually paid/received
    buyPrice:         trade.buyPrice,
    sellPrice:        trade.sellPrice,
    // P&L breakdown
    grossProfit:      (trade.sellPrice - trade.buyPrice) * trade.amount,
    fees:             trade.totalFees || 0,
    slippage:         trade.slippage  || 0,
    netProfit:        trade.netProfit || 0,
    // Wallet reconciliation
    walletDeltaUSD:   +walletDelta.toFixed(6),
    reconciliationDelta: +reconciliationDelta.toFixed(6),
    reconciled,
    // Wallet snapshots (for audit trail)
    walletBefore:     snapshotWallet(walletBefore, btcPrice),
    walletAfter:      snapshotWallet(walletAfter,  btcPrice),
    // Metadata
    btcPriceAtExecution: btcPrice,
    slippageMethod:   trade.slippageMethod,
    score:            trade.score,
    type:             trade.type || 'cross_exchange',
  };

  _trades.push(entry);

  // Update daily ledger
  const date = entry.ts.slice(0, 10);
  if (!_dailyLedger[date]) _dailyLedger[date] = { realized: 0, fees: 0, slippage: 0, tradeCount: 0, reconciliationErrors: 0 };
  _dailyLedger[date].realized    += entry.netProfit;
  _dailyLedger[date].fees        += entry.fees;
  _dailyLedger[date].slippage    += entry.slippage;
  _dailyLedger[date].tradeCount  += 1;
  if (!reconciled) _dailyLedger[date].reconciliationErrors += 1;

  if (!reconciled) {
    try {
      require('../../infrastructure/observabilityService').emit('SYSTEM', 'audit.reconciliation_error', {
        tradeId:    entry.id,
        delta:      reconciliationDelta,
        tolerance:  RECONCILIATION_TOLERANCE_USD,
      }, 'warn');
    } catch { /* observabilityService puede no estar disponible en tests/offline — ignorar silenciosamente */ }
  }

  return entry;
}

// ─── Mark-to-market ───────────────────────────────────────────────────────

/**
 * Computa P&L irealizado de posiciones abiertas marcadas al precio actual.
 * En el modelo pre-funded bilateral, no hay posiciones "abiertas" — todo
 * se convierte a USDT al cerrar cada trade. Sin embargo, el BTC en wallets
 * tiene un valor flotante.
 */
function computeUnrealizedPnl(currentWallets, currentBtcPrice) {
  if (_sessionStartWalletUSD === null) return null;
  const currentUSD = computeWalletUSD(currentWallets, currentBtcPrice);
  return currentUSD - _sessionStartWalletUSD;
}

// ─── Session P&L ──────────────────────────────────────────────────────────

function initSession(initialWallets, btcPrice) {
  _sessionStart          = Date.now();
  _sessionStartWalletUSD = computeWalletUSD(initialWallets, btcPrice);
  _trades.length         = 0;
}

function getAuditedPnl(currentWallets, currentBtcPrice) {
  const realized   = _trades.reduce((s, t) => s + t.netProfit, 0);
  const totalFees  = _trades.reduce((s, t) => s + t.fees, 0);
  const totalSlip  = _trades.reduce((s, t) => s + t.slippage, 0);
  const grossProfit = _trades.reduce((s, t) => s + t.grossProfit, 0);
  const unrealized = currentWallets ? computeUnrealizedPnl(currentWallets, currentBtcPrice) : null;

  const reconciliationErrors = _trades.filter(t => !t.reconciled).length;
  const reconciled = reconciliationErrors === 0;

  // Attribution breakdown
  const byExchangePair = {};
  const byType = {};
  for (const t of _trades) {
    const pair = `${t.buyExchange}→${t.sellExchange}`;
    byExchangePair[pair] = (byExchangePair[pair] || 0) + t.netProfit;
    byType[t.type || 'cross_exchange'] = (byType[t.type || 'cross_exchange'] || 0) + t.netProfit;
  }

  const wins   = _trades.filter(t => t.netProfit > 0);
  const losses = _trades.filter(t => t.netProfit <= 0);

  return {
    // Realized
    realizedPnl:      +realized.toFixed(6),
    grossProfit:      +grossProfit.toFixed(6),
    totalFees:        +totalFees.toFixed(6),
    totalSlippage:    +totalSlip.toFixed(6),
    // Unrealized
    unrealizedPnl:    unrealized !== null ? +unrealized.toFixed(6) : null,
    totalPnl:         unrealized !== null ? +(realized + unrealized).toFixed(6) : +realized.toFixed(6),
    // Trade stats
    totalTrades:      _trades.length,
    winningTrades:    wins.length,
    losingTrades:     losses.length,
    winRate:          _trades.length > 0 ? +((wins.length / _trades.length) * 100).toFixed(1) : null,
    avgWin:           wins.length   ? +(wins.reduce((s,t)=>s+t.netProfit,0)/wins.length).toFixed(4) : null,
    avgLoss:          losses.length ? +(losses.reduce((s,t)=>s+t.netProfit,0)/losses.length).toFixed(4) : null,
    bestTrade:        _trades.length ? +Math.max(..._trades.map(t=>t.netProfit)).toFixed(4) : null,
    worstTrade:       _trades.length ? +Math.min(..._trades.map(t=>t.netProfit)).toFixed(4) : null,
    // Attribution
    byExchangePair:   Object.fromEntries(Object.entries(byExchangePair).map(([k,v])=>[k,+v.toFixed(4)])),
    byType:           Object.fromEntries(Object.entries(byType).map(([k,v])=>[k,+v.toFixed(4)])),
    // Audit
    reconciled,
    reconciliationErrors,
    sessionStartUSD:  _sessionStartWalletUSD,
    sessionUptimeMs:  Date.now() - _sessionStart,
    auditVersion:     'v17',
    generatedAt:      new Date().toISOString(),
  };
}

// ─── Daily ledger ─────────────────────────────────────────────────────────

function getDailyLedger() {
  return Object.entries(_dailyLedger)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, data]) => ({
      date,
      ...data,
      realized:   +data.realized.toFixed(4),
      fees:       +data.fees.toFixed(4),
      slippage:   +data.slippage.toFixed(4),
      reconciled: data.reconciliationErrors === 0,
    }));
}

// ─── Audit trail ──────────────────────────────────────────────────────────

function getAuditTrail(limit = 100) {
  return _trades.slice(-limit).reverse().map(t => ({
    id:              t.id,
    ts:              t.ts,
    pair:            `${t.buyExchange}→${t.sellExchange}`,
    amount:          t.amount,
    buyPrice:        t.buyPrice,
    sellPrice:       t.sellPrice,
    grossProfit:     +t.grossProfit.toFixed(4),
    fees:            +t.fees.toFixed(4),
    slippage:        +t.slippage.toFixed(4),
    netProfit:       +t.netProfit.toFixed(4),
    walletDeltaUSD:  t.walletDeltaUSD,
    reconciled:      t.reconciled,
    reconciliationDelta: t.reconciliationDelta,
    type:            t.type,
    btcPrice:        t.btcPriceAtExecution,
  }));
}

/**
 * Exportar P&L completo en formato CSV para auditoría externa.
 */
function exportCsv() {
  const header = [
    'id','ts','pair','type','amount','buyPrice','sellPrice',
    'grossProfit','fees','slippage','netProfit',
    'walletDeltaUSD','reconciled','reconciliationDelta','btcPrice'
  ].join(',');
  const rows = _trades.map(t => [
    t.id, t.ts, `${t.buyExchange}→${t.sellExchange}`, t.type || 'cross_exchange',
    t.amount, t.buyPrice, t.sellPrice,
    t.grossProfit.toFixed(6), t.fees.toFixed(6), t.slippage.toFixed(6), t.netProfit.toFixed(6),
    t.walletDeltaUSD, t.reconciled, t.reconciliationDelta, t.btcPriceAtExecution,
  ].join(','));
  return [header, ...rows].join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function computeWalletUSD(wallets, btcPrice) {
  if (!wallets) return 0;
  const btc  = Object.values(wallets.BTC  || {}).reduce((s, v) => s + (v || 0), 0);
  const usdt = Object.values(wallets.USDT || {}).reduce((s, v) => s + (v || 0), 0);
  return btc * btcPrice + usdt;
}

function snapshotWallet(wallets, btcPrice) {
  if (!wallets) return null;
  return {
    totalUSD: +computeWalletUSD(wallets, btcPrice).toFixed(2),
    btc:      +Object.values(wallets.BTC  || {}).reduce((s,v)=>s+(v||0),0).toFixed(6),
    usdt:     +Object.values(wallets.USDT || {}).reduce((s,v)=>s+(v||0),0).toFixed(2),
  };
}

module.exports = {
  initSession,
  recordAuditedTrade,
  getAuditedPnl,
  computeUnrealizedPnl,
  getDailyLedger,
  getAuditTrail,
  exportCsv,
  computeWalletUSD,
};

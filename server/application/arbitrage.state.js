'use strict';
/**
 * arbitrage.state.js — kukora v18 (S9 fix: arquitectura modular)
 *
 * Single source of truth for mutable bot state, shared between:
 *   - arbitrageOrchestrator.js  (detection loops + execution)
 *   - arbitrage.routes.js  (HTTP route handlers)
 *
 * Exposes getters/setters instead of raw mutable variables so that both
 * consumers always read the current value without accidental shadowing.
 */

// ─── Debug helpers ─────────────────────────────────────────────────────────
const { logger } = require('../infrastructure/logger');
const _DEBUG = process.env.DEBUG_KUKORA === '1';
function _log(...args)  { if (_DEBUG) logger.debug('arbitrage.state', String(args[0]), args.length > 1 ? { extra: args.slice(1) } : undefined); }
function _warn(...args) {
  if (_DEBUG) logger.warn('arbitrage.state', String(args[0]), args.length > 1 ? { extra: args.slice(1) } : undefined);
}

// ─── Bot state ─────────────────────────────────────────────────────────────
let _botEnabled = true;
let _botStarted = Date.now();

function getBotEnabled()  { return _botEnabled; }
function setBotEnabled(v) { _botEnabled = !!v; }
function getBotStarted()  { return _botStarted; }
function resetBotStarted(){ _botStarted = Date.now(); }

// ─── BTC price ─────────────────────────────────────────────────────────────
const FALLBACK_BTC_PRICE_USD = 50000;
let _lastKnownBtcPrice = FALLBACK_BTC_PRICE_USD;
// H-6 remainder (Sesión 21): no existía tracking de precio ETH, así que
// _capitalUSD en executeBestOpportunity() (arbitrageOrchestrator.js) solo
// sumaba BTC + USDT — subestimando el capital total del bot en cuanto
// había posición en ETH. Mismo patrón exacto que BTC: fallback razonable,
// getter con fallback, setter que ignora valores no positivos.
const FALLBACK_ETH_PRICE_USD = 2500;
let _lastKnownEthPrice = FALLBACK_ETH_PRICE_USD;

function getLastKnownBtcPrice() { return _lastKnownBtcPrice || FALLBACK_BTC_PRICE_USD; }
function setLastKnownBtcPrice(v){ if (v > 0) _lastKnownBtcPrice = v; }
function getBestBtcPrice()      { return _lastKnownBtcPrice || FALLBACK_BTC_PRICE_USD; }
function getLastKnownEthPrice() { return _lastKnownEthPrice || FALLBACK_ETH_PRICE_USD; }
function setLastKnownEthPrice(v){ if (v > 0) _lastKnownEthPrice = v; }

// ─── Execution cooldown & fingerprints ─────────────────────────────────────
let _lastAnyExecTs = 0;
function getLastAnyExecTs()  { return _lastAnyExecTs; }
function setLastAnyExecTs(v) { _lastAnyExecTs = v; }

const recentFingerprints = new Map();
const FINGERPRINT_TTL    = 5000;
const FINGERPRINT_MAX    = 500;

// Expire stale fingerprints every 15s
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of recentFingerprints) {
    if (now - ts > FINGERPRINT_TTL) recentFingerprints.delete(k);
  }
}, 15000).unref();

function checkFingerprint(op, now) {
  const fp = `${op.buyExchange}-${op.sellExchange}-` +
             `${op.buyPrice.toFixed(1)}-${op.sellPrice.toFixed(1)}-` +
             `${op.spreadPct.toFixed(3)}`;
  const lastSeen = recentFingerprints.get(fp);
  if (lastSeen && now - lastSeen < FINGERPRINT_TTL) return false;
  if (recentFingerprints.size >= FINGERPRINT_MAX) {
    recentFingerprints.delete(recentFingerprints.keys().next().value);
  }
  recentFingerprints.set(fp, now);
  return true;
}

// ─── Counters ──────────────────────────────────────────────────────────────
let _totalOpportunitiesScanned = 0;
let _totalViableFound          = 0;
let _tickCount                 = 0;

function getCounters() {
  return {
    totalOpportunitiesScanned: _totalOpportunitiesScanned,
    totalViableFound:          _totalViableFound,
    tickCount:                 _tickCount,
  };
}
function incrementScanned(n = 1) { _totalOpportunitiesScanned += n; }
function incrementViable(n = 1)  { _totalViableFound += n; }
function incrementTick()         { _tickCount++; }
function getTickCount()          { return _tickCount; }

function resetCounters() {
  _totalOpportunitiesScanned = 0;
  _totalViableFound          = 0;
  _tickCount                 = 0;
}

// ─── Equity curve ──────────────────────────────────────────────────────────
let _equityCurve = [];

function getEquityCurve()        { return _equityCurve; }
function clearEquityCurve()      { _equityCurve = []; }
function appendEquityPoint(trade) {
  const prev = _equityCurve[_equityCurve.length - 1]?.pnl || 0;
  const cum  = +(prev + (trade.netProfit || 0)).toFixed(4);
  _equityCurve.push({
    i: _equityCurve.length, ts: trade.ts,
    pnl: cum, profit: +(trade.netProfit || 0).toFixed(4),
    label: `${trade.buyExchange[0]}→${trade.sellExchange[0]}`,
  });
  if (_equityCurve.length > 500) _equityCurve = _equityCurve.slice(-500);
}
function setEquityCurve(arr)     { _equityCurve = arr; }

// ─── SSE clients ───────────────────────────────────────────────────────────
const sseClients          = new Set();
const alertsClients       = new Set();
const notificationClients = new Set();

// ADR-017 pendiente #1 (SSE por-usuario): res -> uid, poblado por
// stream.routes.js (GET /stream) tras `requireAuthForStream` resolver el
// uid de esa conexión. Un `Map` normal (no WeakMap) porque necesitamos
// poder limpiarlo explícitamente en 'close' (mismo ciclo de vida que
// `sseClients.delete(res)`) y porque `pushToSSE` necesita iterar sobre él.
const sseClientUid = new Map();

function pushToSSE(data) {
  const sharedPayload = `data: ${JSON.stringify(data)}\n\n`;
  // Lazy require to avoid a require-cycle at module-load time
  // (tenantSseDelta -> walletManager/tenantBotState, none of which import
  // arbitrage.state.js back, but keeping this lazy matches the pattern
  // already used elsewhere in this file for cross-module requires).
  const { mergeTenantOverlay } = require('../infrastructure/tenantSseDelta');
  for (const res of sseClients) {
    try {
      const uid = sseClientUid.get(res);
      if (uid) {
        // Per-client payload: same shared tick, plus this uid's own
        // wallet/P&L/bot-status/history overlaid under `tenant`. A client
        // with no uid (shouldn't happen in practice — every /stream
        // connection is ticket-authenticated — but kept as a safe
        // fallback) gets the exact same payload as before this change.
        res.write(`data: ${JSON.stringify(mergeTenantOverlay(data, uid))}\n\n`);
      } else {
        res.write(sharedPayload);
      }
    } catch { sseClients.delete(res); sseClientUid.delete(res); }
  }
}
function pushToAlerts(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of alertsClients) {
    try { res.write(payload); } catch { alertsClients.delete(res); }
  }
}
function pushToNotifications(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of notificationClients) {
    try { res.write(payload); } catch { notificationClients.delete(res); }
  }
}

// ─── Order book helpers ────────────────────────────────────────────────────
function getBestAskPrice(orderBooks) {
  const valid = (orderBooks || []).filter(ob => ob.ask && !ob.error);
  if (!valid.length) return null;
  const binance = valid.find(ob => ob.exchange === 'Binance');
  if (binance) return binance.ask;
  return valid.reduce((best, ob) => (!best || ob.ask < best) ? ob.ask : best, null);
}

module.exports = {
  // Bot state
  getBotEnabled, setBotEnabled,
  getBotStarted, resetBotStarted,
  // BTC price
  FALLBACK_BTC_PRICE_USD,
  getLastKnownBtcPrice, setLastKnownBtcPrice, getBestBtcPrice,
  FALLBACK_ETH_PRICE_USD,
  getLastKnownEthPrice, setLastKnownEthPrice,
  // Execution
  getLastAnyExecTs, setLastAnyExecTs,
  checkFingerprint,
  // Counters
  getCounters, resetCounters,
  incrementScanned, incrementViable, incrementTick, getTickCount,
  // Equity curve
  getEquityCurve, clearEquityCurve, appendEquityPoint, setEquityCurve,
  // SSE
  sseClients, sseClientUid, alertsClients, notificationClients, pushToSSE, pushToAlerts, pushToNotifications,
  // Helpers
  getBestAskPrice,
  // Debug
  _log, _warn,
};

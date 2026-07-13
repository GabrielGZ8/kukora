'use strict';

/**
 * arbitrage/subroutes/stream.routes.js — Audit fix 2.1 (SRP refactor)
 *
 * Responsibility: real-time data delivery and bot control.
 *   GET  /stream           — primary SSE stream
 *   GET  /alerts-stream    — trade alert SSE stream
 *   GET  /live             — one-shot live snapshot
 *   POST /bot              — enable/disable bot, set minScore
 *   POST /reset            — full session reset (admin-gated)
 *   GET  /history          — trade history
 *   GET  /wallets          — current balances
 */

const express = require('express');
const router  = express.Router();

const { logger }      = require('../../infrastructure/logger');
const { consumeStreamTicket } = require('../../infrastructure/auth');
const { DomainError } = require('../../domain/errors');

// Audit remediation (roadmap #3 — DomainError adoption). See the identical
// helper/rationale in config.routes.js. This file's own capacity/auth
// checks (401/503 for SSE ticket & admin-token gating) are left as-is —
// they're transport-layer concerns specific to SSE, not domain errors.
function _sendError(e, res, defaultStatus = 500) {
  if (e instanceof DomainError) return res.status(e.status).json(e.toResponse());
  return res.status(defaultStatus).json({ ok: false, error: e.message });
}
const liveConfig      = require('../../infrastructure/liveConfig');
const { mergeTenantOverlay } = require('../../infrastructure/tenantSseDelta');

// ─── State ─────────────────────────────────────────────────────────────────
const state = require('../../application/arbitrage.state');
const {
  getBotEnabled, setBotEnabled,
  getBotStarted, resetBotStarted,
  getEquityCurve, clearEquityCurve,
  getCounters, resetCounters,
  sseClients, sseClientUid, alertsClients,
  getBestAskPrice,
  _log,
} = state;

// ─── Engine ────────────────────────────────────────────────────────────────
const { getMinScore } = require('../../application/arbitrageOrchestrator');

// ─── Services ───────────────────────────────────────────────────────────────
const { getOrderBooks, wsStatus, getFreshness } = require('../../infrastructure/exchangeService');
const {
  detectOpportunities,
  getDailyPnl, isDailyLossBreached, resetDailyPnl,
  getRejectionCounts, getBestOpportunitySeen, getNearViableCount,
  resetSessionStats, resetStatArb,
} = require('../../domain/engines/opportunityDetection');
const { getBalances, resetBalances, getTradeHistory, getPnL } = require('../../domain/wallet/walletManager');
const { resetReplays }       = require('../../infrastructure/replayService');
const { resetBenchmark }     = require('../../infrastructure/speedBenchmark');
const { advanceSession }     = require('../../infrastructure/persistenceService');
const { resetMissed }        = require('../../infrastructure/missedOpportunityTracker');
const { resetReliability }   = require('../../infrastructure/exchangeReliabilityDynamic');
const { resetAdaptive }      = require('../../domain/engines/adaptiveScoring');
const { resetAlerts }        = require('../../infrastructure/alertWebhookService');
const { resetJournal } = require('../../domain/analytics/executionJournal');
const { deactivateScenario } = require('../../domain/risk/stressTestService');
const latencyRacing          = require('../../infrastructure/latencyRacing');
const e2eLatency             = require('../../infrastructure/e2eLatencyTracker');
const spreadMomentum         = require('../../domain/engines/spreadMomentumEngine');
const adaptivePosition       = require('../../domain/risk/adaptivePositionSizing');
const obs                    = require('../../infrastructure/observabilityService');
const { resetIntelligence }  = require('../../infrastructure/exchangeIntelligence');

// ─── Helpers ────────────────────────────────────────────────────────────────
const _DEBUG = process.env.DEBUG_KUKORA === '1';
function _err(...args) {
  const msg = args.map(String).join(' ');
  if (_DEBUG) logger.error('stream.routes', msg);
  obs.emit('SYSTEM', 'internal.error', { message: msg }, 'error');
}

function pushToClients(clients, data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const r of clients) {
    try { r.write(payload); } catch { clients.delete(r); }
  }
}

function sseSetup(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

async function requireAuthForStream(req, res, next) {
  const ticket = req.query.ticket;
  const userId = await consumeStreamTicket(ticket);
  if (!userId) { res.status(401).end(); return; }
  req.userId = userId;
  next();
}

const MAX_SSE_CLIENTS       = parseInt(process.env.MAX_SSE_CLIENTS       || '200', 10);
const MAX_ALERT_SSE_CLIENTS = parseInt(process.env.MAX_ALERT_SSE_CLIENTS || '200', 10);

// ─── GET /stream ──────────────────────────────────────────────────────────
router.get('/stream', requireAuthForStream, async (req, res) => {
  if (sseClients.size >= MAX_SSE_CLIENTS) {
    return res.status(503).json({ ok: false, error: 'SSE capacity reached. Try again shortly.' });
  }
  sseSetup(req, res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(hb); } }, 15000);
  sseClients.add(res);
  // ADR-017 pendiente #1: asociar esta conexión con su uid (siempre
  // presente — requireAuthForStream ya lo exige) para que pushToSSE()
  // pueda superponer el delta por-tenant en cada tick compartido.
  sseClientUid.set(res, req.userId || null);

  try {
    let orderBooks = [], opportunities = [], triangularSignal = null, multiHopSignal = null;
    try {
      orderBooks = await getOrderBooks();
      const det = detectOpportunities(orderBooks);
      opportunities    = det.opportunities;
      triangularSignal = det.triangularSignal;
      multiHopSignal   = det.multiHopSignal || null;
    } catch (e) { _err('[stream init] error:', e.message); }

    const bestAskPrice = getBestAskPrice(orderBooks);
    let pnlData = { totalPnl: 0, realizedPnl: 0, unrealizedPnl: 0, totalTrades: 0, winRate: 0 };
    let walletData = {};
    try { pnlData    = getPnL(bestAskPrice); } catch { /* non-fatal */ }
    try { walletData = getBalances(); }        catch { /* non-fatal */ }

    const initPayload = {
      type: 'init', botEnabled: getBotEnabled(), minScore: getMinScore(),
      uptimeMs:          Date.now() - getBotStarted(),
      wsStatus:          wsStatus(),
      feedFreshness:     getFreshness(),
      orderBooks, opportunities, triangularSignal, multiHopSignal,
      wallets:           walletData,
      pnl:               pnlData,
      dailyPnl:          getDailyPnl(),
      dailyLossBreached: isDailyLossBreached(),
      history:           getTradeHistory().slice(-20).reverse(),
      equityCurve:       getEquityCurve().slice(-100),
      opportunitiesScanned: getCounters().totalOpportunitiesScanned,
      viableFound:       getCounters().totalViableFound,
      detectionMode:     'event_driven_ws + loop_150ms',
      rejectionCounts:     getRejectionCounts(),
      bestOpportunitySeen: getBestOpportunitySeen(),
      nearViableCount:     getNearViableCount(),
      ts: new Date().toISOString(),
    };
    // ADR-017 pendiente #1: el init payload lleva el mismo overlay
    // `tenant` que cada tick posterior — así un frontend multi-tenant
    // puede pintar el wallet/P&L de ESE usuario desde el primer mensaje,
    // sin esperar al siguiente tick de 150ms.
    res.write(`data: ${JSON.stringify(mergeTenantOverlay(initPayload, req.userId))}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'init', error: e.message, botEnabled: getBotEnabled(), wsStatus: wsStatus(), orderBooks: [], opportunities: [], wallets: {}, pnl: {}, ts: new Date().toISOString() })}\n\n`);
  }

  req.on('close', () => { sseClients.delete(res); sseClientUid.delete(res); clearInterval(hb); });
});

// ─── GET /alerts-stream ───────────────────────────────────────────────────
router.get('/alerts-stream', requireAuthForStream, (req, res) => {
  if (alertsClients.size >= MAX_ALERT_SSE_CLIENTS) {
    return res.status(503).json({ ok: false, error: 'Alerts SSE capacity reached.' });
  }
  sseSetup(req, res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(hb); } }, 15000);
  alertsClients.add(res);
  const h = getTradeHistory();
  if (h.length) res.write(`data: ${JSON.stringify({ type: 'arb_trade', trade: h[h.length-1], ts: h[h.length-1].ts })}\n\n`);
  req.on('close', () => { alertsClients.delete(res); clearInterval(hb); });
});

// ─── GET /live ────────────────────────────────────────────────────────────
router.get('/live', async (req, res) => {
  try {
    const orderBooks   = await getOrderBooks();
    const { opportunities, triangularSignal, multiHopSignal } = detectOpportunities(orderBooks);
    const history      = getTradeHistory();
    const lastTrade    = history.length ? history[history.length - 1] : null;
    const bestAskPrice = getBestAskPrice(orderBooks);
    res.json({
      ok: true, botEnabled: getBotEnabled(), minScore: getMinScore(),
      uptimeMs:    Date.now() - getBotStarted(),
      wsStatus:    wsStatus(),
      orderBooks, opportunities, triangularSignal, multiHopSignal, lastTrade,
      wallets:     getBalances(),
      pnl:         getPnL(bestAskPrice),
      history:     history.slice(-20).reverse(),
      equityCurve: getEquityCurve().slice(-100),
      opportunitiesScanned: getCounters().totalOpportunitiesScanned,
      viableFound: getCounters().totalViableFound,
      rejectionCounts:     getRejectionCounts(),
      bestOpportunitySeen: getBestOpportunitySeen(),
      nearViableCount:     getNearViableCount(),
    });
  } catch (e) { _sendError(e, res); }
});

// ─── POST /bot ────────────────────────────────────────────────────────────
router.post('/bot', (req, res) => {
  try {
    const { enabled, score } = req.body;
    if (typeof enabled === 'boolean') {
      setBotEnabled(enabled);
      if (enabled) resetBotStarted();
    }
    if (typeof score === 'number' && score >= 0 && score <= 100) {
      liveConfig.setMany({ minScore: score }, 'bot-control');
    }
    pushToClients(sseClients, { type: 'bot', botEnabled: getBotEnabled(), minScore: getMinScore(), uptimeMs: Date.now() - getBotStarted() });
    res.json({ ok: true, data: { botEnabled: getBotEnabled(), minScore: getMinScore(), uptimeMs: Date.now() - getBotStarted() } });
  } catch (e) { _sendError(e, res); }
});

// ─── POST /reset ──────────────────────────────────────────────────────────
router.post('/reset', (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;

  // Security fix (audit 1.3): ADMIN_TOKEN is mandatory in production.
  if (!adminToken) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({
        ok: false,
        error: 'Service misconfigured: ADMIN_TOKEN environment variable is required in production. ' +
               'Set it in your deployment environment and redeploy.',
      });
    }
    logger.warn('security', 'ADMIN_TOKEN is not set — reset endpoint is unprotected (dev mode only)');
  } else {
    const provided = req.headers['x-admin-token'];
    if (provided !== adminToken) {
      return res.status(401).json({ ok: false, error: 'Unauthorized: invalid or missing X-Admin-Token' });
    }
  }

  try {
    resetBalances();
    resetDailyPnl();
    resetSessionStats();
    resetStatArb();
    resetIntelligence();
    resetReplays();
    resetBenchmark();
    resetJournal();
    deactivateScenario();
    latencyRacing.resetRacing();
    advanceSession();
    resetMissed();
    resetReliability();
    resetAdaptive();
    resetAlerts();
    e2eLatency.reset();
    spreadMomentum.reset();
    adaptivePosition.reset();
    clearEquityCurve();
    resetCounters();
    resetBotStarted();
    pushToClients(sseClients, {
      type: 'reset', wallets: getBalances(), pnl: getPnL(),
      equityCurve: [], dailyPnl: 0, dailyLossBreached: false,
      rejectionCounts: getRejectionCounts(),
      bestOpportunitySeen: null, nearViableCount: 0,
    });
    res.json({ ok: true, data: getBalances() });
  } catch (e) { _sendError(e, res); }
});

// ─── GET /history ─────────────────────────────────────────────────────────
// Área 4 fix: this endpoint returned the FULL trade history, unbounded and
// unfilterable — the frontend never actually called it, instead showing only
// the last 20 trades pushed over SSE (lost on reload/reconnect, no way to
// browse further back). Now supports limit/offset pagination (same pattern
// as /replays, /journal, /alerts/history) plus optional `exchange` and
// `status` filters, so the UI can build a real paginated/filterable trade
// history view. Backward compatible: with no query params, `data` still
// returns the full reversed history (capped at MAX_TRADE_HISTORY=500 in
// walletManager), exactly as before.
router.get('/history', (req, res) => {
  try {
    let all = getTradeHistory().reverse();

    const exchange = req.query.exchange ? String(req.query.exchange).toLowerCase() : null;
    if (exchange) {
      all = all.filter(t =>
        String(t.buyExchange).toLowerCase() === exchange ||
        String(t.sellExchange).toLowerCase() === exchange);
    }

    const status = req.query.status ? String(req.query.status).toLowerCase() : null;
    if (status === 'profit' || status === 'loss') {
      all = all.filter(t => t.status === status);
    }

    const limit  = Math.min(parseInt(req.query.limit, 10)  || 500, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0,   0);
    const page   = all.slice(offset, offset + limit);

    res.json({ ok: true, data: page, pagination: { limit, offset, total: all.length, returned: page.length } });
  } catch (e) { _sendError(e, res); }
});

// ─── GET /wallets ─────────────────────────────────────────────────────────
router.get('/wallets', (req, res) => {
  try { res.json({ ok: true, data: getBalances() }); }
  catch (e) { _sendError(e, res); }
});

module.exports = router;

/**
 * arbitrage.routes.js — kukora arbitrage
 * SSE push, background loop 800ms, score threshold, alerts push
 * Equity curve persistida en MongoDB / memoria
 *
 * IMPROVEMENTS:
 *  - Payload SSE optimizado: history cada 5 ticks, equityCurve condicional
 *  - recentFingerprints: cleanup también cuando Map supera maxSize
 *  - OKX incluido en wallets display
 *  - Loop parallelizado: getOrderBooks + detectOpportunities sin await secuencial innecesario
 *  - Fingerprint TTL reducido a 10s para no bloquear trades válidos repetidos
 *  - FIX: getPnL recibe el mejor ask disponible (Binance o primer ask válido) para unrealizedPnl
 */
const express = require('express');
const router  = express.Router();

const { getOrderBooks, isWsConnected, wsStatus } = require('./exchangeService');
const { detectOpportunities, executeSimulated, getDailyPnl, addDailyPnl, isDailyLossBreached, resetDailyPnl } = require('./arbitrageEngine');
const { getBalances, applyTrade, resetBalances, getTradeHistory, getPnL } = require('./walletManager');

// ─── Estado del bot ────────────────────────────────────────────────────────
let botEnabled    = true;
let botStarted    = Date.now();
let lastExecTs    = 0;
let minScore      = 10;
const recentFingerprints = new Map();
const FINGERPRINT_TTL    = 10000;
const FINGERPRINT_MAX    = 500;
const MIN_EXEC_INTERVAL  = 800;

setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of recentFingerprints) {
    if (now - ts > FINGERPRINT_TTL) recentFingerprints.delete(k);
  }
}, 15000);

// ─── Equity curve ──────────────────────────────────────────────────────────
let _equityCurve = [];
let _tickCount   = 0;

async function loadEquityCurve() {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) return;
    const { ArbitrageOp } = require('./walletManager');
    const ops = await ArbitrageOp.find().sort({ ts: 1 }).lean();
    let cum = 0;
    _equityCurve = ops.map((op, i) => {
      cum += op.netProfit || 0;
      return { i, ts: op.ts, pnl: +cum.toFixed(4), profit: +(op.netProfit||0).toFixed(4), label: `${op.buyExchange[0]}→${op.sellExchange[0]}` };
    });
    console.log(`◈ Equity curve cargada: ${_equityCurve.length} puntos`);
  } catch {}
}

setTimeout(loadEquityCurve, 3000);

function appendEquityPoint(trade) {
  const prev = _equityCurve[_equityCurve.length - 1]?.pnl || 0;
  const cum  = +(prev + (trade.netProfit || 0)).toFixed(4);
  _equityCurve.push({
    i:      _equityCurve.length,
    ts:     trade.ts,
    pnl:    cum,
    profit: +(trade.netProfit || 0).toFixed(4),
    label:  `${trade.buyExchange[0]}→${trade.sellExchange[0]}`,
  });
  if (_equityCurve.length > 500) _equityCurve = _equityCurve.slice(-500);
}

// ─── Helper: extract best ask price from order books for unrealizedPnl ─────
function getBestAskPrice(orderBooks) {
  const valid = (orderBooks || []).filter(ob => ob.ask && !ob.error);
  if (!valid.length) return null;
  // Prefer Binance (lowest latency), fallback to lowest ask among all
  const binance = valid.find(ob => ob.exchange === 'Binance');
  if (binance) return binance.ask;
  return valid.reduce((best, ob) => (!best || ob.ask < best) ? ob.ask : best, null);
}

// ─── SSE Clients ───────────────────────────────────────────────────────────
const sseClients    = new Set();
const alertsClients = new Set();

function pushToClients(clients, data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

// ─── Background arbitrage loop ─────────────────────────────────────────────
let _loopRunning = false;

async function arbitrageLoop() {
  if (_loopRunning) return;
  _loopRunning = true;

  const run = async () => {
    try {
      let orderBooks = [];
      try { orderBooks = await getOrderBooks(); } catch (e) { console.warn('[arb loop] getOrderBooks:', e.message); return; }

      let opportunities = [], triangularSignal = null;
      try {
        const det = detectOpportunities(orderBooks);
        opportunities    = det.opportunities;
        triangularSignal = det.triangularSignal;
      } catch (e) { console.warn('[arb loop] detectOpportunities:', e.message); }
      let lastTrade = null;

      const now = Date.now();
      if (botEnabled && now - lastExecTs >= MIN_EXEC_INTERVAL) {
        const best = opportunities.find(op => {
          if (!op.viable) return false;
          if (op.circuitBreaker) return false;
          if (!op.liquidityOk) return false;
          if (op.score < minScore) return false;

          const fp = `${op.buyExchange}-${op.sellExchange}-${op.buyPrice.toFixed(1)}-${op.sellPrice.toFixed(1)}-${op.spreadPct.toFixed(3)}`;
          const lastSeen = recentFingerprints.get(fp);
          if (lastSeen && Date.now() - lastSeen < FINGERPRINT_TTL) return false;

          if (recentFingerprints.size >= FINGERPRINT_MAX) {
            const oldestKey = recentFingerprints.keys().next().value;
            recentFingerprints.delete(oldestKey);
          }
          recentFingerprints.set(fp, Date.now());
          return true;
        });

        if (best) {
          const wallets = getBalances();
          const result  = executeSimulated(best, wallets, 0.1);
          if (result.ok) {
            const applyResult = await applyTrade(result.trade);
            if (!applyResult.ok) {
              console.warn('[arb loop] applyTrade rejected:', applyResult.reason);
            } else {
              lastTrade  = applyResult.trade;
              lastExecTs = now;
              appendEquityPoint(applyResult.trade);
              addDailyPnl(applyResult.trade.netProfit || 0);

              pushToClients(alertsClients, {
                type:  'arb_trade',
                trade: applyResult.trade,
                ts:    applyResult.trade.ts,
              });
            }
          }
        }
      }

      if (sseClients.size > 0 || alertsClients.size > 0) {
        _tickCount++;
        // FIX: pass best ask price to getPnL for unrealizedPnl calculation
        const bestAskPrice = getBestAskPrice(orderBooks);
        const payload = {
          type:            'tick',
          botEnabled,
          minScore,
          uptimeMs:        Date.now() - botStarted,
          wsStatus:        wsStatus(),
          orderBooks,
          opportunities,
          triangularSignal,
          lastTrade,
          wallets:         getBalances(),
          pnl:             getPnL(bestAskPrice),
          dailyPnl:        getDailyPnl(),
          dailyLossBreached: isDailyLossBreached(),
          ...(_tickCount % 5 === 0 && { history: getTradeHistory().slice(-20).reverse() }),
          ...(lastTrade || _tickCount % 10 === 0 ? { equityCurve: _equityCurve.slice(-100) } : {}),
          ts:              new Date().toISOString(),
        };
        pushToClients(sseClients, payload);
      }
    } catch (e) {
      console.warn('[arb loop]', e.message);
    }
  };

  async function serialLoop() {
    try { await run(); } catch (e) { console.warn('[arb loop]', e.message); }
    setTimeout(serialLoop, 800);
  }
  serialLoop();
}

arbitrageLoop();

// ─── SSE helpers ───────────────────────────────────────────────────────────
function sseSetup(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

// ─── GET /api/arbitrage/stream ─────────────────────────────────────────────
router.get('/stream', async (req, res) => {
  // SSE must never return a 500 — once headers are flushed the connection is open.
  // We send a safe init payload even if order books have errors.
  sseSetup(req, res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(hb); } }, 15000);
  sseClients.add(res);

  try {
    let orderBooks = [], opportunities = [], triangularSignal = null;
    try {
      orderBooks = await getOrderBooks();
      const det = detectOpportunities(orderBooks);
      opportunities    = det.opportunities;
      triangularSignal = det.triangularSignal;
    } catch (e) {
      console.error('[stream init] getOrderBooks/detectOpportunities error:', e.message);
    }
    const bestAskPrice = getBestAskPrice(orderBooks);
    let pnlData = { totalPnl: 0, realizedPnl: 0, unrealizedPnl: 0, totalTrades: 0, winRate: 0 };
    try { pnlData = getPnL(bestAskPrice); } catch {}
    let walletData = {};
    try { walletData = getBalances(); } catch {}
    res.write(`data: ${JSON.stringify({
      type: 'init', botEnabled, minScore,
      uptimeMs: Date.now() - botStarted,
      wsStatus: wsStatus(),
      orderBooks, opportunities, triangularSignal,
      wallets:     walletData,
      pnl:         pnlData,
      dailyPnl:    getDailyPnl(),
      dailyLossBreached: isDailyLossBreached(),
      history:     getTradeHistory().slice(-20).reverse(),
      equityCurve: _equityCurve.slice(-100),
      ts:          new Date().toISOString(),
    })}\n\n`);
  } catch (e) {
    // Last-resort: even if JSON serialization fails, keep connection alive
    console.error('[stream init] fatal:', e.message);
    res.write(`data: ${JSON.stringify({ type: 'init', error: e.message, botEnabled, wsStatus: wsStatus(), orderBooks: [], opportunities: [], wallets: {}, pnl: {}, ts: new Date().toISOString() })}\n\n`);
  }

  req.on('close', () => { sseClients.delete(res); clearInterval(hb); });
});

// ─── GET /api/arbitrage/alerts-stream ─────────────────────────────────────
router.get('/alerts-stream', (req, res) => {
  sseSetup(req, res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(hb); } }, 15000);
  alertsClients.add(res);
  const h = getTradeHistory();
  if (h.length) res.write(`data: ${JSON.stringify({ type: 'arb_trade', trade: h[h.length-1], ts: h[h.length-1].ts })}\n\n`);
  req.on('close', () => { alertsClients.delete(res); clearInterval(hb); });
});

// ─── GET /api/arbitrage/live (REST fallback — READ ONLY) ──────────────────
router.get('/live', async (req, res) => {
  try {
    const orderBooks = await getOrderBooks();
    const { opportunities, triangularSignal } = detectOpportunities(orderBooks);
    const history    = getTradeHistory();
    const lastTrade  = history.length ? history[history.length - 1] : null;
    const bestAskPrice = getBestAskPrice(orderBooks);

    res.json({
      ok: true, botEnabled, minScore,
      uptimeMs:    Date.now() - botStarted,
      wsStatus:    wsStatus(),
      orderBooks, opportunities, triangularSignal, lastTrade,
      wallets:     getBalances(),
      pnl:         getPnL(bestAskPrice),
      history:     history.slice(-20).reverse(),
      equityCurve: _equityCurve.slice(-100),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── POST /api/arbitrage/bot ───────────────────────────────────────────────
router.post('/bot', (req, res) => {
  try {
    const { enabled, score } = req.body;
    if (typeof enabled === 'boolean') {
      botEnabled = enabled;
      if (enabled) botStarted = Date.now();
    }
    if (typeof score === 'number' && score >= 0 && score <= 100) {
      minScore = score;
    }
    pushToClients(sseClients, { type: 'bot', botEnabled, minScore, uptimeMs: Date.now() - botStarted });
    res.json({ ok: true, data: { botEnabled, minScore, uptimeMs: Date.now() - botStarted } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── POST /api/arbitrage/reset ─────────────────────────────────────────────
// Protected: requires X-Admin-Token header matching ADMIN_TOKEN env var
router.post('/reset', (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken) {
    const provided = req.headers['x-admin-token'] || req.body?.adminToken;
    if (provided !== adminToken) {
      return res.status(401).json({ ok: false, error: 'Unauthorized: invalid or missing X-Admin-Token' });
    }
  }
  try {
    resetBalances();
    resetDailyPnl();
    _equityCurve = [];
    _tickCount   = 0;
    botStarted   = Date.now();
    pushToClients(sseClients, { type: 'reset', wallets: getBalances(), pnl: getPnL(), equityCurve: [], dailyPnl: 0, dailyLossBreached: false });
    res.json({ ok: true, data: getBalances() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── GET /api/arbitrage/history ────────────────────────────────────────────
router.get('/history', (req, res) => {
  try { res.json({ ok: true, data: getTradeHistory().reverse() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── GET /api/arbitrage/wallets ────────────────────────────────────────────
router.get('/wallets', (req, res) => {
  try { res.json({ ok: true, data: getBalances() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── GET /api/arbitrage/stats ──────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const orderBooks   = await getOrderBooks().catch(() => []);
    const bestAskPrice = getBestAskPrice(orderBooks);
    // getPnL already computes pairStats correctly (trading fees only, no double-count)
    const pnlData = getPnL(bestAskPrice);
    res.json({ ok: true, data: {
      ...pnlData,
      botEnabled, minScore,
      wsStatus:   wsStatus(),
      uptimeMs:   Date.now() - botStarted,
      equityCurve: _equityCurve,
      dailyPnl:   getDailyPnl(),
      dailyLossBreached: isDailyLossBreached(),
    }});
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;

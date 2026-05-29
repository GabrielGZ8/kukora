/**
 * arbitrage.routes.js — kukora arbitrage
 * SSE push, background loop 800ms, score threshold, alerts push
 * Equity curve persistida en MongoDB / memoria
 */
const express = require('express');
const router  = express.Router();

const { getOrderBooks, isWsConnected, wsStatus } = require('./exchangeService');
const { detectOpportunities, executeSimulated }  = require('./arbitrageEngine');
const { getBalances, applyTrade, resetBalances, getTradeHistory, getPnL } = require('./walletManager');

// ─── Estado del bot ────────────────────────────────────────────────────────
let botEnabled    = true;
let botStarted    = Date.now();
let lastExecTs    = 0;
let minScore      = 10;           // configurable vía POST /bot
const recentFingerprints = new Map();
const FINGERPRINT_TTL = 15000;
const MIN_EXEC_INTERVAL = 800;

// FIX: limpiar entradas expiradas del Map para evitar crecimiento sin límite
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of recentFingerprints) {
    if (now - ts > FINGERPRINT_TTL) recentFingerprints.delete(k);
  }
}, 30000);


// ─── Equity curve en memoria (con intento de persistencia MongoDB) ─────────
let _equityCurve = [];

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

// Intentar cargar al arrancar (MongoDB puede no estar lista aún)
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
  // Cap en 500 puntos para no crecer sin límite
  if (_equityCurve.length > 500) _equityCurve = _equityCurve.slice(-500);
}

// ─── SSE Clients ───────────────────────────────────────────────────────────
const sseClients     = new Set();
const alertsClients  = new Set(); // canal dedicado a alertas de arbitraje

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
      const orderBooks    = await getOrderBooks();
      const { opportunities, triangularSignal } = detectOpportunities(orderBooks);
      let   lastTrade     = null;

      const now = Date.now();
      if (botEnabled && now - lastExecTs >= MIN_EXEC_INTERVAL) {
        const best = opportunities.find(op => {
                if (!op.viable) return false;
                if (op.circuitBreaker) return false;
                if (op.score < minScore) return false;

                // Fingerprint: include both prices at 1-decimal precision + spreadPct
                // This avoids collisions when prices differ by <$1 but spread is different
                const fp = `${op.buyExchange}-${op.sellExchange}-${op.buyPrice.toFixed(1)}-${op.sellPrice.toFixed(1)}-${op.spreadPct.toFixed(3)}`;

                const lastSeen = recentFingerprints.get(fp);

                if (lastSeen && Date.now() - lastSeen < FINGERPRINT_TTL) {
                  return false;
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

              // Push alerta de nuevo trade a AlertsPage
              pushToClients(alertsClients, {
                type:    'arb_trade',
                trade:   applyResult.trade,
                ts:      applyResult.trade.ts,
              });
            }
          }
        }
      }

      if (sseClients.size > 0 || alertsClients.size > 0) {
        const payload = {
          type:         'tick',
          botEnabled,
          minScore,
          uptimeMs:     Date.now() - botStarted,
          wsStatus:     wsStatus(),
          orderBooks,
          opportunities,
          triangularSignal,
          lastTrade,
          wallets:      getBalances(),
          pnl:          getPnL(),
          history:      getTradeHistory().slice(-20).reverse(),
          equityCurve:  _equityCurve.slice(-100),
          ts:           new Date().toISOString(),
        };
        pushToClients(sseClients, payload);
      }
    } catch (e) {
      console.warn('[arb loop]', e.message);
    }
  };

   async function serialLoop() {
          try {
            await run();
          } catch (e) {
            console.warn('[arb loop]', e.message);
          }

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
  sseSetup(req, res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(hb); } }, 15000);
  sseClients.add(res);

  // Estado inicial
  try {
    const orderBooks    = await getOrderBooks();
    const { opportunities, triangularSignal } = detectOpportunities(orderBooks);
    res.write(`data: ${JSON.stringify({
      type: 'init', botEnabled, minScore,
      uptimeMs: Date.now() - botStarted,
      wsStatus: wsStatus(),
      orderBooks, opportunities, triangularSignal,
      wallets:      getBalances(),
      pnl:          getPnL(),
      history:      getTradeHistory().slice(-20).reverse(),
      equityCurve:  _equityCurve.slice(-100),
      ts:           new Date().toISOString(),
    })}\n\n`);
  } catch {}

  req.on('close', () => { sseClients.delete(res); clearInterval(hb); });
});

// ─── GET /api/arbitrage/alerts-stream — canal para AlertsPage ─────────────
router.get('/alerts-stream', (req, res) => {
  sseSetup(req, res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(hb); } }, 15000);
  alertsClients.add(res);
  // Enviar último trade si existe
  const h = getTradeHistory();
  if (h.length) res.write(`data: ${JSON.stringify({ type: 'arb_trade', trade: h[h.length-1], ts: h[h.length-1].ts })}\n\n`);
  req.on('close', () => { alertsClients.delete(res); clearInterval(hb); });
});

// ─── GET /api/arbitrage/live (REST fallback — READ ONLY) ──────────────────
// FIX: este endpoint es ahora read-only. La ejecución de trades SOLO ocurre
// en el background loop (arbitrageLoop). Tener side-effects de ejecución aquí
// causaba race conditions y doble ejecución cuando SSE + polling corrían juntos.
router.get('/live', async (req, res) => {
  try {
    const orderBooks    = await getOrderBooks();
    const { opportunities, triangularSignal } = detectOpportunities(orderBooks);
    const history       = getTradeHistory();
    const lastTrade     = history.length ? history[history.length - 1] : null;

    res.json({
      ok: true, botEnabled, minScore,
      uptimeMs:    Date.now() - botStarted,
      wsStatus:    wsStatus(),
      orderBooks, opportunities, triangularSignal, lastTrade,
      wallets:     getBalances(),
      pnl:         getPnL(),
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
router.post('/reset', (req, res) => {
  try {
    resetBalances();
    _equityCurve = [];
    botStarted = Date.now();
    pushToClients(sseClients, { type: 'reset', wallets: getBalances(), pnl: getPnL(), equityCurve: [] });
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
router.get('/stats', (req, res) => {
  try {
    const history = getTradeHistory();
    const pairStats = {};
    history.forEach(t => {
      const key = `${t.buyExchange}→${t.sellExchange}`;
      if (!pairStats[key]) pairStats[key] = { count: 0, totalPnl: 0, wins: 0 };
      pairStats[key].count++;
      pairStats[key].totalPnl += t.netProfit || 0;
      if ((t.netProfit || 0) > 0) pairStats[key].wins++;
    });
    res.json({ ok: true, data: { ...getPnL(), botEnabled, minScore, wsStatus: wsStatus(), uptimeMs: Date.now() - botStarted, pairStats, equityCurve: _equityCurve } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
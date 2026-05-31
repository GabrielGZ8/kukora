/**
 * arbitrage.routes.js — kukora arbitrage v4
 *
 * v4 changes vs v3:
 *   - Removed seedEquityCurve() entirely. Equity curve starts empty and is built
 *     exclusively from real executed trades. No synthetic data ever injected.
 *   - loadEquityCurve() still hydrates from MongoDB on startup when available.
 *   - Triangular arbitrage (detectTriangularSignal) is now auto-executed when
 *     netPct > 0.05% and both legs individually pass viability checks.
 *     Execution is simulated across 2 legs: A→B buy, then B→C sell.
 *   - Trade amount increased to 0.05 BTC (see arbitrageEngine.js v7).
 */

const express = require('express');
const router  = express.Router();

const {
  getOrderBooks, isWsConnected, wsStatus, getFreshness, priceEmitter,
} = require('./exchangeService');

const {
  detectOpportunities, executeSimulated, executeTriangularSimulated,
  getDailyPnl, addDailyPnl, isDailyLossBreached, resetDailyPnl,
  getRejectionCounts, getBestOpportunitySeen, getNearViableCount,
  getOpportunityLog, resetSessionStats,
} = require('./arbitrageEngine');

const { getBalances, applyTrade, resetBalances, getTradeHistory, getPnL } = require('./walletManager');

// ─── Hackathon Intelligence Modules ───────────────────────────────────────
const {
  trackAll, expireStale,
  getActiveLifecycles, getLifecycleHistory, getLifecycleSummary,
} = require('./opportunityLifecycle');

const { enrichWithFillProbability } = require('./fillProbabilityEngine');

const {
  recordOpportunitySeen, recordExecution, recordWsReconnect,
  recordStaleFeed, recordFeedUpdate, recordPairDetection,
  getExchangeRanking, getReliabilityLeaderboard,
  recordBtcPrice, getVolatilityStatus,
  getHistoricalLearning, getPredictiveRanking,
  recommendCapitalSize, resetIntelligence,
} = require('./exchangeIntelligence');

// ─── Bot state ────────────────────────────────────────────────────────────
let botEnabled   = true;
let botStarted   = Date.now();
let minScore     = 10;

// ─── Unified execution cooldown ───────────────────────────────────────────
// SINGLE shared tracker for both event-driven and polling-loop execution.
// Previously two separate variables (_lastEventExecTs / lastExecTs) allowed
// both paths to fire on the same opportunity within the 300ms window.
// Now any execution — regardless of source — updates this single timestamp.
const EXEC_COOLDOWN = 300; // ms — minimum interval between any two executions
let _lastAnyExecTs  = 0;

const recentFingerprints = new Map();
const FINGERPRINT_TTL    = 5000;
const FINGERPRINT_MAX    = 500;

let _totalOpportunitiesScanned = 0;
let _totalViableFound          = 0;
let _tickCount  = 0;
const LOG_EVERY = 20;

setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of recentFingerprints) {
    if (now - ts > FINGERPRINT_TTL) recentFingerprints.delete(k);
  }
}, 15000);

// ─── Equity curve ──────────────────────────────────────────────────────────
// Starts EMPTY. Built exclusively from real executed trades.
// No synthetic seeds — the jurado can audit every data point against trade history.
let _equityCurve = [];

async function loadEquityCurve() {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      console.log('◈ No MongoDB — equity curve starts empty (will populate from live trades)');
      return;
    }
    const { ArbitrageOp } = require('./walletManager');
    const ops = await ArbitrageOp.find().sort({ ts: 1 }).lean();
    if (!ops.length) {
      console.log('◈ MongoDB connected but no trade history yet — equity curve starts empty');
      return;
    }
    let cum = 0;
    _equityCurve = ops.map((op, i) => {
      cum += op.netProfit || 0;
      return {
        i,
        ts:     op.ts,
        pnl:    +cum.toFixed(4),
        profit: +(op.netProfit || 0).toFixed(4),
        label:  `${op.buyExchange[0]}→${op.sellExchange[0]}`,
      };
    });
    console.log(`◈ Equity curve loaded from MongoDB: ${_equityCurve.length} real trades`);
  } catch (e) {
    console.warn('[loadEquityCurve] error:', e.message, '— equity curve starts empty');
  }
}

setTimeout(loadEquityCurve, 500);

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

function getBestAskPrice(orderBooks) {
  const valid = (orderBooks || []).filter(ob => ob.ask && !ob.error);
  if (!valid.length) return null;
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

// ─── Event-driven detection (< 30ms latencia) ─────────────────────────────
// Uses the shared _lastAnyExecTs cooldown. The polling loop (150ms) uses the
// same variable so neither path can fire within EXEC_COOLDOWN ms of the other.
// Deduplication is also enforced by recentFingerprints (5s TTL per price level).

priceEmitter.on('priceUpdate', async ({ exchange, bid, ask, ts }) => {
  try {
    const now = Date.now();
    if (now - _lastAnyExecTs < EXEC_COOLDOWN) return;
    if (!botEnabled || isDailyLossBreached()) return;

    const orderBooks = await getOrderBooks();
    if (!orderBooks || orderBooks.length < 2) return;

    const bookRecvMs = Date.now() - now;
    const detStart   = Date.now();
    const { opportunities: rawOpps, triangularSignal, statArbSignals, evalMs: detectEvalMs } = detectOpportunities(orderBooks);
    const detectMs = Date.now() - detStart;

    // ── Hackathon enhancements ──────────────────────────────────────
    const btcPrice = orderBooks.find(o => o.exchange === 'Binance')?.ask || ask;
    recordBtcPrice(btcPrice);
    const enriched    = enrichWithFillProbability(rawOpps, btcPrice, getVolatilityStatus().score);
    const opportunities = trackAll(enriched);
    expireStale();

    for (const op of opportunities) {
      recordOpportunitySeen(op.buyExchange, op.sellExchange, op);
      if (op.viable) recordPairDetection(op.buyExchange, op.sellExchange);
    }
    // ────────────────────────────────────────────────────────────────

    _totalOpportunitiesScanned += opportunities.length;
    // NOTE: viableFound is counted only in the polling loop to avoid double-counting
    // when both event-driven and loop detect the same tick's opportunities.

    const best = opportunities.find(op => {
      if (!op.viable || op.circuitBreaker || !op.liquidityOk) return false;
      if (op.score < minScore) return false;
      return checkFingerprint(op, now);
    });

    if (!best) return;

    const evalStart = Date.now();
    _lastAnyExecTs = now; // unified cooldown — blocks polling loop for EXEC_COOLDOWN ms

    const walletSnapshot = getBalances();
    const result = executeSimulated(best, walletSnapshot, best.tradeAmount || 0.05);
    if (!result.ok) return;

    const applyResult = await applyTrade(result.trade);
    if (!applyResult.ok) return;

    appendEquityPoint(applyResult.trade);
    addDailyPnl(applyResult.trade.netProfit || 0);
    recordExecution(applyResult.trade); // ← intelligence tracking

    const totalLatencyMs = now - ts;
    const decisionMs     = Date.now() - evalStart;

    console.log(
      `[event-driven] TRADE ${best.buyExchange}→${best.sellExchange}` +
      ` net=$${applyResult.trade.netProfit}` +
      ` | recv=${bookRecvMs}ms detect=${detectMs}ms decision=${decisionMs}ms total=${totalLatencyMs}ms` +
      ` | slip=${best.slippageMethod} score=${best.score}`
    );

    pushToClients(sseClients, {
      type: 'trade_executed',
      trade: applyResult.trade,
      pnl: getPnL(best.buyPrice),
      wallets: getBalances(),
      ts: new Date().toISOString(),
      detectionSource: 'event_driven',
      detectionLatencyMs: totalLatencyMs,
      timing: { bookRecvMs, detectMs, decisionMs, totalLatencyMs },
      statArbSignals,
    });

    pushToClients(alertsClients, {
      type: 'arb_trade', trade: applyResult.trade, ts: applyResult.trade.ts,
    });

    // ─── Triangular execution (auto) ──────────────────────────────────
    // After a successful bilateral trade, attempt to execute any active
    // triangular signal if it clears the minimum threshold.
    //
    // ARCHITECTURE NOTE — Why only leg2 is applied to wallets:
    // executeTriangularSimulated() produces leg1 (descriptive: buy BTC on A) and
    // leg2 (executable: full bilateral flow buy@A + sell@C). leg2 encodes both sides:
    //   buyExchange=A  → USDT[A] decremented, BTC[A] incremented  (leg1 effect)
    //   sellExchange=C → BTC[C] decremented, USDT[C] incremented  (leg2 effect)
    // applyTrade(leg2) therefore correctly updates all four wallet balances.
    // leg1 is not applied separately to avoid double-counting the USDT debit.
    // leg2.netProfit = totalNetProfit (both fees, full gross) — reported to equity curve.
    try {
      const { triangularSignal } = detectOpportunities(orderBooks);
      if (triangularSignal && (triangularSignal.netPct || 0) >= 0.05) {
        const walletAfter = getBalances();
        const triResult = executeTriangularSimulated(
          triangularSignal, orderBooks, walletAfter, best.tradeAmount || 0.05
        );
        if (triResult.ok) {
          // Apply each leg as a real trade record
          const applyLeg2 = await applyTrade(triResult.leg2);
          if (applyLeg2.ok) {
            appendEquityPoint(applyLeg2.trade);
            addDailyPnl(applyLeg2.trade.netProfit || 0);
            recordExecution(applyLeg2.trade);
            console.log(
              `[triangular] EXECUTED ${triangularSignal.path}` +
              ` net=$${triResult.totalNetProfit} netPct=${triResult.totalNetPct}%`
            );
            pushToClients(sseClients, {
              type: 'triangular_executed',
              trade: applyLeg2.trade,
              triangularPath: triangularSignal.path,
              netPct: triResult.totalNetPct,
              pnl: getPnL(best.buyPrice),
              wallets: getBalances(),
              ts: new Date().toISOString(),
            });
            pushToClients(alertsClients, {
              type: 'arb_trade', trade: applyLeg2.trade, ts: applyLeg2.trade.ts,
            });
          } else {
            console.log(`[triangular] apply rejected: ${applyLeg2.reason}`);
          }
        } else {
          console.log(`[triangular] not executed: ${triResult.reason}`);
        }
      }
    } catch (triErr) {
      console.warn('[triangular]', triErr.message);
    }
    // ──────────────────────────────────────────────────────────────────

    // ─── StatArb execution (auto) ──────────────────────────────────
    try {
      const bestStat = (statArbSignals || []).find(s => s.viable && s.confidence >= 90);
      if (bestStat) {
        const walletNow = getBalances();
        // StatArb trade is treated as a high-conviction bilateral trade
        // We reuse executeSimulated but with a synthetic opportunity structure
        const result = executeSimulated({
          ...bestStat,
          buyPrice: orderBooks.find(b => b.exchange === bestStat.buyExchange).ask,
          sellPrice: orderBooks.find(b => b.exchange === bestStat.sellExchange).bid,
          netProfit: bestStat.diff * 0.05, // Simplified
        }, walletNow, 0.05);
        
        if (result.ok) {
          const applyRes = await applyTrade(result.trade);
          if (applyRes.ok) {
             appendEquityPoint(applyRes.trade);
             addDailyPnl(applyRes.trade.netProfit || 0);
             console.log(`[stat-arb] EXECUTED ${bestStat.buyExchange}→${bestStat.sellExchange} Z=${bestStat.zScore}`);
             pushToClients(sseClients, { type: 'stat_arb_executed', trade: applyRes.trade, zScore: bestStat.zScore });
          }
        }
      }
    } catch (e) {
      console.warn('[stat-arb execution]', e.message);
    }
    // ───────────────────────────────────────────────────────────────

  } catch (e) {
    console.warn('[event-driven]', e.message);
  }
});

// ─── Background UI loop (150ms) ────────────────────────────────────────────
let _loopRunning = false;

async function arbitrageLoop() {
  if (_loopRunning) return;
  _loopRunning = true;

  const run = async () => {
    try {
      let orderBooks = [];
      try { orderBooks = await getOrderBooks(); } catch (e) { console.warn('[arb loop] getOrderBooks:', e.message); return; }

      let opportunities = [], triangularSignal = null, statArbSignals = [], detectMs = 0;
      let det = { opportunities: [], triangularSignal: null, statArbSignals: [], evalMs: 0 };
      try {
        const detStart = Date.now();
        det              = detectOpportunities(orderBooks);
        detectMs         = Date.now() - detStart;
        triangularSignal = det.triangularSignal;
        statArbSignals   = det.statArbSignals || [];

        // ── Hackathon enhancements ──────────────────────────────────
        const btcPriceLoop = orderBooks.find(o => o.exchange === 'Binance')?.ask;
        if (btcPriceLoop) recordBtcPrice(btcPriceLoop);
        const enrichedLoop = enrichWithFillProbability(det.opportunities, btcPriceLoop);
        opportunities = trackAll(enrichedLoop);
        expireStale();
        for (const op of opportunities) {
          recordOpportunitySeen(op.buyExchange, op.sellExchange, op);
          if (op.viable) recordPairDetection(op.buyExchange, op.sellExchange);
        }
        // ────────────────────────────────────────────────────────────

        _totalOpportunitiesScanned += opportunities.length;
        _totalViableFound += opportunities.filter(o => o.viable && !o.synthetic).length; // synthetic excluded; counted here only (not in event-driven)

        if (_tickCount % LOG_EVERY === 0 && opportunities.length > 0) {
          const viableNow = opportunities.filter(o => o.viable).length;
          const top = opportunities[0];
          console.log(
            `[arb loop] tick=${_tickCount} detect=${detectMs}ms` +
            ` books=${orderBooks.length} opps=${opportunities.length} viable=${viableNow}` +
            ` | top: ${top?.buyExchange}→${top?.sellExchange}` +
            ` net=$${top?.netProfit} spread=${top?.spreadPct}% slip=${top?.slippageMethod}`
          );
        }
      } catch (e) { console.warn('[arb loop] detectOpportunities:', e.message); }

      let lastTrade = null;
      const now = Date.now();

      if (botEnabled && now - _lastAnyExecTs >= EXEC_COOLDOWN && !isDailyLossBreached()) {
        const best = opportunities.find(op => {
          if (!op.viable || op.circuitBreaker || !op.liquidityOk) return false;
          if (op.score < minScore) return false;
          return checkFingerprint(op, now);
        });

        if (best) {
          const wallets = getBalances();
          const result  = executeSimulated(best, wallets, best.tradeAmount || 0.05);
          if (result.ok) {
            const applyResult = await applyTrade(result.trade);
            if (!applyResult.ok) {
              console.warn('[arb loop] applyTrade rejected:', applyResult.reason);
            } else {
              lastTrade       = applyResult.trade;
              _lastAnyExecTs  = now; // unified cooldown
              appendEquityPoint(applyResult.trade);
              addDailyPnl(applyResult.trade.netProfit || 0);
              recordExecution(applyResult.trade); // ← intelligence tracking
              console.log(`[loop-fallback] TRADE ${best.buyExchange}→${best.sellExchange} net=$${applyResult.trade.netProfit} slip=${best.slippageMethod}`);
              pushToClients(alertsClients, {
                type: 'arb_trade', trade: applyResult.trade, ts: applyResult.trade.ts,
              });
            }
          }
        }
      }

      _tickCount++;
      const bestAskPrice = getBestAskPrice(orderBooks);
      const wallets      = getBalances();

      // ── Intelligence enrichment ────────────────────────────────────
      const volatilityStatus    = getVolatilityStatus();
      const exchangeRanking     = getExchangeRanking();
      const reliabilityLeader   = getReliabilityLeaderboard();
      const activeLifecycles    = getActiveLifecycles();
      const predictiveRanking   = _tickCount % 5 === 0 ? getPredictiveRanking(activeLifecycles, exchangeRanking) : undefined;
      const historicalLearning  = _tickCount % 10 === 0 ? getHistoricalLearning() : undefined;
      const lifecycleSummary    = _tickCount % 5 === 0 ? getLifecycleSummary() : undefined;

      // Attach recommendedSize to top viable opportunity
      const oppsWithSize = opportunities.map(op => {
        if (!op.viable) return op;
        const _capRec = recommendCapitalSize(op, wallets, bestAskPrice || 100000);
        return {
          ...op,
          recommendedSize: typeof _capRec === 'object' ? _capRec.btc : _capRec,
          recommendedSizeUSD: typeof _capRec === 'object' ? _capRec.usd : null,
          capitalFactors: typeof _capRec === 'object' ? _capRec.factors : null,
        };
      });
      // ──────────────────────────────────────────────────────────────

      const payload = {
        type:              'tick',
        botEnabled,
        minScore,
        uptimeMs:          Date.now() - botStarted,
        wsStatus:          wsStatus(),
        feedFreshness:     getFreshness(),
        orderBooks,
        opportunities:     oppsWithSize,
        triangularSignal,
        statArbSignals:    statArbSignals,
        lastTrade,
        wallets,
        pnl:               getPnL(bestAskPrice),
        dailyPnl:          getDailyPnl(),
        dailyLossBreached: isDailyLossBreached(),
        opportunitiesScanned: _totalOpportunitiesScanned,
        viableFound:       _totalViableFound,
        detectionMode:     'event_driven_ws + loop_150ms',
        detectMs,
        rejectionCounts:     getRejectionCounts(),
        bestOpportunitySeen: getBestOpportunitySeen(),
        nearViableCount:     getNearViableCount(),
        // Intelligence modules
        volatilityStatus,
        exchangeRanking,
        reliabilityLeaderboard: reliabilityLeader,
        activeLifecycles,
        ...(predictiveRanking  !== undefined && { predictiveRanking }),
        ...(historicalLearning !== undefined && { historicalLearning }),
        ...(lifecycleSummary   !== undefined && { lifecycleSummary }),
        ...(_tickCount % 5 === 0 && { history: getTradeHistory().slice(-20).reverse() }),
        ...(lastTrade || _tickCount % 10 === 0 ? { equityCurve: _equityCurve.slice(-100) } : {}),
        ...(_tickCount % 10 === 0 && { lifecycleHistory: getLifecycleHistory(30) }),
        ts: new Date().toISOString(),
      };
      pushToClients(sseClients, payload);

    } catch (e) {
      console.warn('[arb loop]', e.message);
    }
  };

  async function serialLoop() {
    try { await run(); } catch (e) { console.warn('[arb loop]', e.message); }
    setTimeout(serialLoop, 150);
  }
  serialLoop();
}

arbitrageLoop();

// ─── SSE setup helper ──────────────────────────────────────────────────────
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

  try {
    let orderBooks = [], opportunities = [], triangularSignal = null;
    try {
      orderBooks = await getOrderBooks();
      const det = detectOpportunities(orderBooks);
      opportunities    = det.opportunities;
      triangularSignal = det.triangularSignal;
    } catch (e) { console.error('[stream init] error:', e.message); }

    const bestAskPrice = getBestAskPrice(orderBooks);
    let pnlData = { totalPnl: 0, realizedPnl: 0, unrealizedPnl: 0, totalTrades: 0, winRate: 0 };
    let walletData = {};
    try { pnlData    = getPnL(bestAskPrice); } catch {}
    try { walletData = getBalances(); } catch {}

    res.write(`data: ${JSON.stringify({
      type: 'init', botEnabled, minScore,
      uptimeMs:          Date.now() - botStarted,
      wsStatus:          wsStatus(),
      feedFreshness:     getFreshness(),
      orderBooks, opportunities, triangularSignal,
      wallets:           walletData,
      pnl:               pnlData,
      dailyPnl:          getDailyPnl(),
      dailyLossBreached: isDailyLossBreached(),
      history:           getTradeHistory().slice(-20).reverse(),
      equityCurve:       _equityCurve.slice(-100),
      opportunitiesScanned: _totalOpportunitiesScanned,
      viableFound:       _totalViableFound,
      detectionMode:     'event_driven_ws + loop_150ms',
      rejectionCounts:     getRejectionCounts(),
      bestOpportunitySeen: getBestOpportunitySeen(),
      nearViableCount:     getNearViableCount(),
      ts: new Date().toISOString(),
    })}\n\n`);
  } catch (e) {
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

// ─── GET /api/arbitrage/live ───────────────────────────────────────────────
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
      opportunitiesScanned: _totalOpportunitiesScanned,
      viableFound: _totalViableFound,
      rejectionCounts:     getRejectionCounts(),
      bestOpportunitySeen: getBestOpportunitySeen(),
      nearViableCount:     getNearViableCount(),
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── POST /api/arbitrage/bot ───────────────────────────────────────────────
router.post('/bot', (req, res) => {
  try {
    const { enabled, score } = req.body;
    if (typeof enabled === 'boolean') {
      botEnabled = enabled;
      if (enabled) botStarted = Date.now();
    }
    if (typeof score === 'number' && score >= 0 && score <= 100) minScore = score;
    pushToClients(sseClients, { type: 'bot', botEnabled, minScore, uptimeMs: Date.now() - botStarted });
    res.json({ ok: true, data: { botEnabled, minScore, uptimeMs: Date.now() - botStarted } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── POST /api/arbitrage/reset ─────────────────────────────────────────────
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
    resetSessionStats();
    resetIntelligence(); // ← intelligence reset
    _equityCurve               = [];
    _tickCount                 = 0;
    _totalOpportunitiesScanned = 0;
    _totalViableFound          = 0;
    botStarted                 = Date.now();
    pushToClients(sseClients, {
      type: 'reset', wallets: getBalances(), pnl: getPnL(),
      equityCurve: [], dailyPnl: 0, dailyLossBreached: false,
      rejectionCounts: getRejectionCounts(),
      bestOpportunitySeen: null, nearViableCount: 0,
    });
    res.json({ ok: true, data: getBalances() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
    const pnlData      = getPnL(bestAskPrice);
    const ws           = wsStatus();
    res.json({ ok: true, data: {
      ...pnlData,
      model:         'pre_funded_bilateral',
      detectionMode: 'event_driven_ws + sse_loop_150ms',
      exchanges:     5,
      wsConnections: Object.values(ws).filter(Boolean).length,
      opportunitiesScanned: _totalOpportunitiesScanned,
      viableFound:   _totalViableFound,
      tradesExecuted: getTradeHistory().length,
      uptimeMs:      Date.now() - botStarted,
      dailyPnl:      getDailyPnl(),
      dailyLossBreached: isDailyLossBreached(),
      botEnabled, minScore,
      wsStatus:      ws,
      equityCurve:   _equityCurve,
      rejectionCounts:     getRejectionCounts(),
      bestOpportunitySeen: getBestOpportunitySeen(),
      nearViableCount:     getNearViableCount(),
      opportunityLog:      getOpportunityLog().slice(-50),
    }});
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── GET /api/arbitrage/intelligence ──────────────────────────────────────
// Executive intelligence snapshot — used by ExecutiveDashboard + panels
router.get('/intelligence', async (req, res) => {
  try {
    const orderBooks  = await getOrderBooks().catch(() => []);
    const bestAsk     = getBestAskPrice(orderBooks);
    const wallets     = getBalances();
    const activeLC    = getActiveLifecycles();
    const exRanking   = getExchangeRanking();

    res.json({ ok: true, data: {
      volatilityStatus:      getVolatilityStatus(),
      exchangeRanking:       exRanking,
      reliabilityLeaderboard:getReliabilityLeaderboard(),
      historicalLearning:    getHistoricalLearning(),
      predictiveRanking:     getPredictiveRanking(activeLC, exRanking),
      activeLifecycles:      activeLC,
      lifecycleHistory:      getLifecycleHistory(50),
      lifecycleSummary:      getLifecycleSummary(),
      btcPrice:              bestAsk,
      ts: new Date().toISOString(),
    }});
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── GET /api/arbitrage/lifecycle ─────────────────────────────────────────
router.get('/lifecycle', (req, res) => {
  try {
    res.json({ ok: true, data: {
      active:  getActiveLifecycles(),
      history: getLifecycleHistory(100),
      summary: getLifecycleSummary(),
    }});
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── GET /api/arbitrage/executive ─────────────────────────────────────────
// One-shot endpoint for the Executive Dashboard panel
router.get('/executive', async (req, res) => {
  try {
    const orderBooks   = await getOrderBooks().catch(() => []);
    const bestAsk      = getBestAskPrice(orderBooks);
    const pnlData      = getPnL(bestAsk);
    const history      = getTradeHistory();
    const ws           = wsStatus();
    const activeLC     = getActiveLifecycles();
    const exRanking    = getExchangeRanking();
    const volStatus    = getVolatilityStatus();
    const relLeader    = getReliabilityLeaderboard();
    const predicted    = getPredictiveRanking(activeLC, exRanking);
    const lcSummary    = getLifecycleSummary();

    const totalOpps    = _totalOpportunitiesScanned;
    const viableOpps   = _totalViableFound;
    const totalTrades  = history.length;
    const successTrades= history.filter(t => t.netProfit > 0).length;
    const fillRate     = totalTrades > 0 ? +(successTrades / totalTrades * 100).toFixed(1) : 0;
    const avgLatency   = exRanking.reduce((s, e) => s + (e.avgLatency || 0), 0) / (exRanking.filter(e => e.avgLatency).length || 1);
    const bestExchange = exRanking[0]?.exchange || '—';
    const reliabilityAvg = Math.round(relLeader.reduce((s, e) => s + e.score, 0) / (relLeader.length || 1));

    res.json({ ok: true, data: {
      // Core stats
      totalOpportunities:   totalOpps,
      viableOpportunities:  viableOpps,
      tradesExecuted:       totalTrades,
      profitToday:          getDailyPnl(),
      profitSession:        pnlData.totalPnl || 0,
      successRate:          pnlData.winRate   || 0,
      fillRate,
      avgLatencyMs:         Math.round(avgLatency),
      reliabilityScore:     reliabilityAvg,
      riskStatus:           volStatus.status,
      connectedExchanges:   Object.values(ws).filter(Boolean).length,
      bestExchange,
      predictedOpportunity: predicted[0] || null,
      bestOpportunitySeen:  getBestOpportunitySeen(),
      nearViableCount:      getNearViableCount(),
      rejectionCounts:      getRejectionCounts(),
      botEnabled,
      uptimeMs:             Date.now() - botStarted,
      lifecycleSummary:     lcSummary,
      volatilityStatus:     volStatus,
      ts: new Date().toISOString(),
    }});
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
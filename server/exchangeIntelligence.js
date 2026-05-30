/**
 * exchangeIntelligence.js — Kukora Hackathon Enhancement
 *
 * Consolidates:
 *   4. Exchange Performance Ranking
 *   5. Exchange Reliability Score
 *   6. Volatility Risk Filter
 *   7. Historical Learning Engine (pure heuristic, no AI)
 *   8. Predictive Opportunity Ranking
 *
 * All state is in-memory. No random values. Fully explainable.
 */

const EXCHANGES = ['Binance', 'Kraken', 'Bybit', 'OKX', 'Coinbase'];

// ─── Exchange Performance Stats ────────────────────────────────────────────
// Per-exchange rolling stats, reset on /reset
const _exStats = {};
for (const ex of EXCHANGES) {
  _exStats[ex] = {
    opportunitiesSeen:     0,
    opportunitiesExecuted: 0,
    totalProfit:           0,
    successCount:          0,   // trades with netProfit > 0
    failureCount:          0,
    latencySum:            0,
    latencyCount:          0,
    fillProbSum:           0,
    fillProbCount:         0,
    wsDrops:               0,   // reconnect events
    staleCount:            0,   // times feed was stale
    feedUpdateCount:       0,   // total WS messages received
    lastFeedTs:            0,
  };
}

/** Record that an exchange appeared in a detected opportunity. */
function recordOpportunitySeen(buyExchange, sellExchange, op) {
  for (const ex of [buyExchange, sellExchange]) {
    if (!_exStats[ex]) continue;
    _exStats[ex].opportunitiesSeen++;
    const lat = ex === buyExchange ? (op.buyLatency || 0) : (op.sellLatency || 0);
    _exStats[ex].latencySum   += lat;
    _exStats[ex].latencyCount++;
    if (op.fillProbability != null) {
      _exStats[ex].fillProbSum   += op.fillProbability;
      _exStats[ex].fillProbCount++;
    }
  }
}

/** Record a trade execution. */
function recordExecution(trade) {
  for (const ex of [trade.buyExchange, trade.sellExchange]) {
    if (!_exStats[ex]) continue;
    _exStats[ex].opportunitiesExecuted++;
    _exStats[ex].totalProfit += (trade.netProfit || 0) / 2; // split between two sides
    if ((trade.netProfit || 0) > 0) _exStats[ex].successCount++;
    else                             _exStats[ex].failureCount++;
  }
  // Update heuristic learner
  _updateLearner(trade);
}

/** Record a WS reconnect event. */
function recordWsReconnect(exchange) {
  if (_exStats[exchange]) _exStats[exchange].wsDrops++;
}

/** Record a stale feed hit. */
function recordStaleFeed(exchange) {
  if (_exStats[exchange]) _exStats[exchange].staleCount++;
}

/** Record a WS feed update. */
function recordFeedUpdate(exchange) {
  if (_exStats[exchange]) {
    _exStats[exchange].feedUpdateCount++;
    _exStats[exchange].lastFeedTs = Date.now();
  }
}

/** Returns ranked exchange stats (for leaderboard). */
function getExchangeRanking() {
  return EXCHANGES.map(ex => {
    const s = _exStats[ex];
    const avgLatency       = s.latencyCount > 0 ? Math.round(s.latencySum / s.latencyCount) : null;
    const avgFillProb      = s.fillProbCount > 0 ? Math.round(s.fillProbSum / s.fillProbCount) : null;
    const successRate      = (s.successCount + s.failureCount) > 0
      ? +(s.successCount / (s.successCount + s.failureCount) * 100).toFixed(1)
      : null;
    const avgProfit        = s.opportunitiesExecuted > 0
      ? +(s.totalProfit / s.opportunitiesExecuted).toFixed(4)
      : null;
    const reliability      = computeReliabilityScore(ex);
    return {
      exchange: ex,
      opportunitiesSeen:     s.opportunitiesSeen,
      opportunitiesExecuted: s.opportunitiesExecuted,
      avgProfit,
      successRate,
      avgLatency,
      avgFillProbability: avgFillProb,
      reliability,
    };
  }).sort((a, b) => {
    // Sort by composite: successRate * reliability
    const scoreA = (a.successRate || 0) + (a.reliability || 0) * 0.5;
    const scoreB = (b.successRate || 0) + (b.reliability || 0) * 0.5;
    return scoreB - scoreA;
  });
}

// ─── Exchange Reliability Score ────────────────────────────────────────────
/**
 * 0-100 score.
 * Components:
 *   wsUptime  (40%) — ratio of feed messages vs expected (1/s = 1000ms cadence)
 *   staleRate (30%) — fraction of detection cycles where feed was stale
 *   latency   (20%) — lower avg latency = higher score
 *   drops     (10%) — WS reconnect events in session
 */
function computeReliabilityScore(exchange) {
  const s = _exStats[exchange];
  if (!s) return 0;

  const totalOpps = s.opportunitiesSeen || 1;

  // WS uptime proxy: feed updates per opportunity seen (ideal ~5-10)
  const updatesPerOpp = s.feedUpdateCount / totalOpps;
  const wsScore = Math.min(100, (updatesPerOpp / 8) * 100);

  // Stale rate
  const staleRate  = s.staleCount / Math.max(1, s.feedUpdateCount + s.staleCount);
  const staleScore = Math.max(0, 100 - staleRate * 200);

  // Latency score: 0ms=100, 100ms=80, 500ms=0
  const avgLat = s.latencyCount > 0 ? s.latencySum / s.latencyCount : 500;
  const latScore = Math.max(0, 100 - avgLat * 0.2);

  // Drop score: 0 drops=100, 5 drops=0
  const dropScore = Math.max(0, 100 - s.wsDrops * 20);

  const raw = wsScore * 0.40 + staleScore * 0.30 + latScore * 0.20 + dropScore * 0.10;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function getReliabilityLeaderboard() {
  return EXCHANGES.map(ex => ({
    exchange: ex,
    score:    computeReliabilityScore(ex),
    wsDrops:  _exStats[ex].wsDrops,
    staleCount: _exStats[ex].staleCount,
    feedUpdates: _exStats[ex].feedUpdateCount,
  })).sort((a, b) => b.score - a.score);
}

// ─── Volatility Engine — Motor Cuantitativo ───────────────────────────────
//
// Calcula rolling volatility usando log-returns (estándar quant/HFT).
// Tres ventanas: short (micro), mid (trading), long (regime).
//
// Thresholds BTC/USD spot:
//   STABLE    score <30   — trades normales
//   CAUTION   score 30-64 — reducir tamaño
//   HIGH RISK score >=65  — bloquear ejecución

const _priceBuffer = [];
const MAX_PRICE_BUF = 120;

const _VOL_SHORT = 10;
const _VOL_MID   = 40;
const _VOL_LONG  = 120;

let _currentVolatilityScore = 0;
let _riskStatus = 'STABLE';
let _executionBlocked = false;
let _rollingVol = 0;
let _shortVol   = 0;
let _longVol    = 0;
let _momentum   = 0;

function _logReturnStdDev(prices) {
  if (prices.length < 2) return 0;
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i-1] > 0 && prices[i] > 0)
      returns.push(Math.log(prices[i] / prices[i-1]));
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

function recordBtcPrice(price) {
  if (!price || isNaN(price) || price <= 0) return;
  _priceBuffer.push({ price, ts: Date.now() });
  if (_priceBuffer.length > MAX_PRICE_BUF) _priceBuffer.shift();
  _updateVolatility();
}

function _updateVolatility() {
  const n = _priceBuffer.length;
  if (n < 5) {
    _currentVolatilityScore = 0;
    _riskStatus = 'STABLE';
    _executionBlocked = false;
    return;
  }

  const all   = _priceBuffer.map(p => p.price);
  const short = all.slice(-Math.min(_VOL_SHORT, n));
  const mid   = all.slice(-Math.min(_VOL_MID,   n));
  const long  = all.slice(-Math.min(_VOL_LONG,  n));

  _shortVol   = _logReturnStdDev(short);
  _rollingVol = _logReturnStdDev(mid);
  _longVol    = _logReturnStdDev(long);

  if (n >= 3) {
    const last = all[n - 1], base = all[n - 3];
    _momentum = base > 0 ? Math.abs((last - base) / base) * 100 : 0;
  }

  const shortHigh  = Math.max(...short);
  const shortLow   = Math.min(...short);
  const shortMid   = (shortHigh + shortLow) / 2;
  const microNoise = shortMid > 0 ? ((shortHigh - shortLow) / shortMid) * 100 : 0;

  const volScore      = Math.min(50, (_rollingVol / 0.025) * 50);
  const shortVolScore = Math.min(25, (_shortVol   / 0.020) * 25);
  const momentumScore = Math.min(15, (_momentum   / 0.15)  * 15);
  const noiseScore    = Math.min(10, (microNoise  / 0.05)  * 10);

  _currentVolatilityScore = Math.min(100, Math.round(volScore + shortVolScore + momentumScore + noiseScore));

  if (_currentVolatilityScore >= 65) {
    _riskStatus = 'HIGH RISK';
    _executionBlocked = true;
  } else if (_currentVolatilityScore >= 30) {
    _riskStatus = 'CAUTION';
    _executionBlocked = false;
  } else {
    _riskStatus = 'STABLE';
    _executionBlocked = false;
  }
}

function getVolatilityStatus() {
  return {
    score:            _currentVolatilityScore,
    status:           _riskStatus,
    executionBlocked: _executionBlocked,
    bufferSize:       _priceBuffer.length,
    rollingVol:       +_rollingVol.toFixed(6),
    shortVol:         +_shortVol.toFixed(6),
    longVol:          +_longVol.toFixed(6),
    momentum:         +_momentum.toFixed(6),
  };
}

// ─── Historical Learning Engine (heuristic) ───────────────────────────────
// Tracks per-pair heuristic pattern: buyExchange→sellExchange
const _pairLearner = new Map();
// Key: "BuyEx→SellEx"

function _updateLearner(trade) {
  const key = `${trade.buyExchange}→${trade.sellExchange}`;
  let entry = _pairLearner.get(key);
  if (!entry) {
    entry = { key, detections: 0, executions: 0, successes: 0, failures: 0, profitSum: 0 };
    _pairLearner.set(key, entry);
  }
  entry.executions++;
  if ((trade.netProfit || 0) > 0) { entry.successes++; entry.profitSum += trade.netProfit; }
  else entry.failures++;
}

/** Track detection (call every time a viable opportunity is detected). */
function recordPairDetection(buyExchange, sellExchange) {
  const key = `${buyExchange}→${sellExchange}`;
  let entry = _pairLearner.get(key);
  if (!entry) {
    entry = { key, detections: 0, executions: 0, successes: 0, failures: 0, profitSum: 0 };
    _pairLearner.set(key, entry);
  }
  entry.detections++;
}

function getHistoricalLearning() {
  return Array.from(_pairLearner.values()).map(e => {
    const historicalSuccessRate = e.executions > 0
      ? +(e.successes / e.executions * 100).toFixed(1)
      : null;
    const avgProfit = e.successes > 0
      ? +(e.profitSum / e.successes).toFixed(4)
      : null;
    // Confidence: based on sample size + success rate
    const sampleWeight = Math.min(1, e.executions / 10);
    const rateWeight   = historicalSuccessRate != null ? historicalSuccessRate / 100 : 0.5;
    const detectionRate = e.detections > 0 ? Math.min(1, e.detections / 20) : 0;
    const confidenceScore = Math.round((sampleWeight * 0.4 + rateWeight * 0.4 + detectionRate * 0.2) * 100);
    return {
      pair: e.key,
      detections: e.detections,
      executions: e.executions,
      successes:  e.successes,
      failures:   e.failures,
      historicalSuccessRate,
      avgProfit,
      confidenceScore,
    };
  }).sort((a, b) => b.confidenceScore - a.confidenceScore);
}

// ─── Predictive Opportunity Ranking ──────────────────────────────────────
/**
 * Predict the next most likely opportunity based on:
 *   - historical frequency (detectionRate)
 *   - exchange latency
 *   - spread persistence (seenCount from lifecycle)
 *   - historical success rate
 *
 * Returns top-3 predictions with probability and expected profit.
 * Does NOT invent data — uses only what has been observed.
 */
function getPredictiveRanking(activeLifecycles, exchangeRanking) {
  const learner = getHistoricalLearning();
  if (!learner.length) return [];

  const latencyMap = {};
  for (const ex of exchangeRanking) {
    latencyMap[ex.exchange] = ex.avgLatency || 999;
  }

  return learner.slice(0, 5).map(entry => {
    const [buyEx, sellEx] = entry.pair.split('→');

    // Latency factor: lower is better
    const latFactor = Math.max(0, 1 - (latencyMap[buyEx] || 500) / 1000);

    // Spread persistence: is this pair currently active?
    const lc = activeLifecycles.find(l => l.buyExchange === buyEx && l.sellExchange === sellEx);
    const persistFactor = lc ? Math.min(1, lc.seenCount / 20) : 0;

    // Combined probability (0-100)
    const detRate   = Math.min(1, entry.detections / 50);
    const succRate  = entry.historicalSuccessRate != null ? entry.historicalSuccessRate / 100 : 0.3;
    const prob      = Math.round((detRate * 0.35 + succRate * 0.40 + latFactor * 0.15 + persistFactor * 0.10) * 100);
    const expectedProfit = entry.avgProfit;

    return {
      pair:            entry.pair,
      buyExchange:     buyEx,
      sellExchange:    sellEx,
      probability:     prob,
      expectedProfit,
      historicalSuccessRate: entry.historicalSuccessRate,
      confidenceScore: entry.confidenceScore,
      currentlyActive: !!lc,
    };
  }).sort((a, b) => b.probability - a.probability).slice(0, 3);
}

// ─── Capital Allocation Recommender ───────────────────────────────────────
/**
 * Returns recommendedSize (BTC) based on:
 *   liquidity fill%, spread edge, confidence, volatility, wallet balance
 *
 * Formula: base × fillFactor × edgeFactor × confidenceFactor × riskFactor
 */
function recommendCapitalSize(op, wallets, btcPriceUSD = 100000) {
  // Dynamic capital allocation — Kelly-inspired multi-factor model
  // Returns {btc, usd, factors} — fully explainable to judges
  const BASE_BTC = 0.01;

  // 1. Fill probability factor — less aggressive than linear
  const fillProb   = (op.fillProbability || 50) / 100;
  const fillFactor = Math.pow(fillProb, 0.7);

  // 2. Edge factor: 0% edge→0.8×, 0.20%+ edge→2.0×
  const edge       = Math.max(0, (op.spreadPct || 0) - (op.breakEvenPct || 0));
  const edgeFactor = Math.min(2.0, 0.8 + edge * 12);

  // 3. Volatility risk: STABLE→1.0, CAUTION→0.65, HIGH RISK→0
  let volFactor = 1.0;
  if (_executionBlocked)                    volFactor = 0;
  else if (_currentVolatilityScore >= 50)   volFactor = 0.4;
  else if (_currentVolatilityScore >= 30)   volFactor = 0.65;
  else                                      volFactor = 1.0 - (_currentVolatilityScore / 100);

  // 4. Historical pair confidence
  const pairKey    = op.buyExchange + '>' + op.sellExchange;
  const learned    = _pairLearner.get(pairKey);
  let histFactor   = 1.0;
  if (learned && learned.executions >= 3) {
    const sr = learned.successes / learned.executions;
    histFactor = 0.7 + sr * 0.6;  // 0.7 (0% success) to 1.3 (100% success)
  }

  // 5. Liquidity factor
  const avgFill  = ((op.buyFillPct || 100) + (op.sellFillPct || 100)) / 2;
  const liqFactor = avgFill >= 90 ? 1.0 : avgFill >= 70 ? 0.7 : 0.4;

  const raw = BASE_BTC * fillFactor * edgeFactor * volFactor * histFactor * liqFactor;

  // Wallet constraints
  const usdtAvail    = wallets?.USDT?.[op.buyExchange] || 0;
  const maxFromUsdt  = usdtAvail > 0 ? usdtAvail / (btcPriceUSD * 1.005) : 0.05;
  const btcAvail     = wallets?.BTC?.[op.sellExchange]  || 0;
  const maxFromBtc   = btcAvail  > 0 ? btcAvail  * 0.95 : 0.05;

  const btc = +Math.max(0.001, Math.min(raw, maxFromUsdt, maxFromBtc, 0.1)).toFixed(6);

  return {
    btc,
    usd: +(btc * btcPriceUSD).toFixed(2),
    factors: {
      fill:       +fillFactor.toFixed(3),
      edge:       +edgeFactor.toFixed(3),
      volatility: +volFactor.toFixed(3),
      historical: +histFactor.toFixed(3),
      liquidity:  +liqFactor.toFixed(3),
    },
  };
}

function resetIntelligence() {
  for (const ex of EXCHANGES) {
    const s = _exStats[ex];
    s.opportunitiesSeen     = 0;
    s.opportunitiesExecuted = 0;
    s.totalProfit           = 0;
    s.successCount          = 0;
    s.failureCount          = 0;
    s.latencySum            = 0;
    s.latencyCount          = 0;
    s.fillProbSum           = 0;
    s.fillProbCount         = 0;
    s.wsDrops               = 0;
    s.staleCount            = 0;
    s.feedUpdateCount       = 0;
    s.lastFeedTs            = 0;
  }
  _pairLearner.clear();
  _priceBuffer.length = 0;
  _currentVolatilityScore = 0;
  _riskStatus = 'STABLE';
  _executionBlocked = false;
}

module.exports = {
  // Performance
  recordOpportunitySeen,
  recordExecution,
  recordWsReconnect,
  recordStaleFeed,
  recordFeedUpdate,
  getExchangeRanking,
  // Reliability
  computeReliabilityScore,
  getReliabilityLeaderboard,
  // Volatility
  recordBtcPrice,
  getVolatilityStatus,
  // Learning
  recordPairDetection,
  getHistoricalLearning,
  // Predictive
  getPredictiveRanking,
  // Capital
  recommendCapitalSize,
  // Reset
  resetIntelligence,
};
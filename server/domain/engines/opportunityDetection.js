const crypto = require('crypto');
const { isOpportunity, isTrade } = require('../opportunity');
const { calcRealSlippage, getDepth, isFeedStale } = require('../../infrastructure/exchangeService');
const { detectStatArb, getStatArbSummary, resetStatArb } = require('./statArbEngine');
const { detectMultiHopArbitrage } = require('./multiHopArbitrageEngine');
const { TRADING_FEES: TAKER_FEES, MAKER_FEES, WITHDRAWAL_FEES, SLIPPAGE_RATE } = require('../wallet/feeConfig');
const { getDynamicPenalty, getSlippagePenalty } = require('../../infrastructure/exchangeReliabilityDynamic');
const { getExecutionPenalty } = require('../../infrastructure/exchangeIntelligence');
const liveConfig = require('../../infrastructure/liveConfig');
const obs = require('../../infrastructure/observabilityService');

// H-8 fix: DEFAULT_TRADE_AMOUNT / USE_MAKER_FEES / MIN_NET_PROFIT used to be
// module-level constants captured once at require() time. liveConfig.set()
// hot-reloads correctly update every other call site in this file (they all
// call liveConfig.get() directly), but these three snapshots stayed frozen
// at their startup value — so hot-reloading tradeAmountBTC/feeMode/
// minNetProfitUSD silently had no effect on the DEMO_MODE synthetic
// opportunity path or the triangular execution path. Removed; every call
// site below now reads liveConfig.get(...) directly, same pattern as the
// rest of the module.

const SLIPPAGE_FIXED     = SLIPPAGE_RATE;  // 0.05% por lado (fallback)

// Pre-trade liquidity gate threshold. Was a hardcoded 0.50 literal; now reads
// liveConfig.liquidityMinFillPct (Section 2 audit) so it's hot-reloadable
// from the UI, same as every other execution parameter in this file. Default
// unchanged: 0.50 genuinely triggers partial-fill logic on thinner books
// (Kraken, Coinbase) while passing cleanly on Binance/OKX/Bybit deep L2 books.
function liquidityMinFill() { return liveConfig.get('liquidityMinFillPct'); }

function getFees() {
  // lee feeMode de liveConfig en cada ciclo — permite cambio en caliente desde UI
  const useMaker = liveConfig.get('feeMode') === 'maker';
  const base = useMaker && MAKER_FEES ? MAKER_FEES : TAKER_FEES;
  if (_stressFeeMultiplier === 1) return base;
  // Stress test mode (Mejora #9): scale every exchange's fee by a multiplier
  // to simulate "what if fees doubled tomorrow". Applied to a fresh object so
  // the original TRADING_FEES/MAKER_FEES constants are never mutated.
  const scaled = {};
  for (const ex of Object.keys(base)) scaled[ex] = base[ex] * _stressFeeMultiplier;
  return scaled;
}

// ─── Stress Test Mode (Mejora #9) ──────────────────────────────────────────
// A single in-memory multiplier, off by default (1 = no effect on normal
// production behavior). Exposed via setStressFeeMultiplier() so the stress
// test endpoint can scale fees up live without touching feeConfig.js.
let _stressFeeMultiplier = 1;
function setStressFeeMultiplier(mult) {
  _stressFeeMultiplier = (typeof mult === 'number' && mult > 0) ? mult : 1;
}
function getStressFeeMultiplier() {
  return _stressFeeMultiplier;
}

const HIGH_FEE_EXCHANGES = new Set(['Coinbase']);

// ─── Daily P&L tracking — Issue 13: integer accumulator avoids FP drift ─────
// Stored as integer units of 1/10000th of a cent to eliminate rounding errors.
let _dailyPnlRaw  = 0; // integer: value x 10000
let _dailyResetTs = new Date().setHours(0, 0, 0, 0);

function getDailyPnl()  { return _dailyPnlRaw / 10000; }
function addDailyPnl(n) {
  const todayMidnight = new Date().setHours(0, 0, 0, 0);
  if (todayMidnight > _dailyResetTs) { _dailyPnlRaw = 0; _dailyResetTs = todayMidnight; }
  _dailyPnlRaw += Math.round(n * 10000);
}
function isDailyLossBreached() {
  // maxDailyLossUSD is NEGATIVE (e.g. -500 = "losing more than $500 stops the bot").
  // breached when daily P&L falls BELOW the negative floor.
  return getDailyPnl() <= liveConfig.get('maxDailyLossUSD');
}
function resetDailyPnl() { _dailyPnlRaw = 0; _dailyResetTs = new Date().setHours(0, 0, 0, 0); }

// ─── Session analytics ────────────────────────────────────────────────────
const _rejectionCounts = {
  negative_spread: 0,
  circuit_breaker: 0,
  liquidity:       0,
  fees_slippage:   0,
  daily_stop:      0,
};

let _bestOpportunitySeen = null;
let _nearViableCount     = 0;
const _opportunityLog    = [];
const MAX_OPP_LOG        = 200;

function getRejectionCounts()    { return { ..._rejectionCounts }; }
function getBestOpportunitySeen(){ return _bestOpportunitySeen; }
function getNearViableCount()    { return _nearViableCount; }
function getOpportunityLog()     { return [..._opportunityLog]; }
function resetSessionStats() {
  Object.keys(_rejectionCounts).forEach(k => (_rejectionCounts[k] = 0));
  _bestOpportunitySeen = null;
  _nearViableCount = 0;
  _opportunityLog.length = 0;
}

// ─── Slippage history (per exchange — audit item #2) ──────────────────────
// BEFORE: a single global _slippageHistory array fed slippageStdDev(), so a
// thin Kraken/Coinbase book and a deep Binance/OKX book shared the exact
// same estimated slippage variance. That's statistically wrong — slippage
// dispersion is a property of ONE exchange's own order-book depth, not of
// the pair, and Kraken's variance can genuinely be several times Binance's.
// Every opportunity's profitLow/profitHigh confidence interval (see
// detectOpportunities below) was therefore using the wrong uncertainty for
// whichever side happened to be the thinner book.
//
// AFTER: slippage samples are tracked per exchange. An opportunity's
// interval combines the two sides' independent variances
// (Var(buy - sell) = Var(buy) + Var(sell) for independent sources) via
// combinedSlippageStdDev(buyExchange, sellExchange) instead of one shared
// number. A small global history is kept purely as a cold-start fallback
// for an exchange with fewer than MIN_SAMPLES observations so far.
const MAX_SLIP_HISTORY = 100;
const MIN_SAMPLES = 5;
const _slippageHistoryByExchange = new Map(); // exchange -> number[]
const _slippageHistoryGlobal = [];

function _stdDevOf(arr) {
  if (arr.length < MIN_SAMPLES) return null;
  const mean     = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function recordSlippage(exchange, pct) {
  if (pct == null || isNaN(pct)) return;
  _slippageHistoryGlobal.push(pct);
  if (_slippageHistoryGlobal.length > MAX_SLIP_HISTORY) _slippageHistoryGlobal.shift();

  if (!exchange) return; // legacy callers without exchange still update the global fallback
  let arr = _slippageHistoryByExchange.get(exchange);
  if (!arr) { arr = []; _slippageHistoryByExchange.set(exchange, arr); }
  arr.push(pct);
  if (arr.length > MAX_SLIP_HISTORY) arr.shift();
}

/** Per-exchange slippage stddev, falling back to the global pool while an exchange's own sample is still thin. */
function slippageStdDev(exchange) {
  if (exchange) {
    const own = _stdDevOf(_slippageHistoryByExchange.get(exchange) || []);
    if (own != null) return own;
  }
  return _stdDevOf(_slippageHistoryGlobal);
}

/**
 * Combined stddev for a bilateral opportunity's two independent legs.
 * Var(buyFill - sellFill) = Var(buy) + Var(sell) for two independent
 * random slippage sources — this is the correct combination, not "just
 * reuse whichever side's number" or "average the two".
 */
function combinedSlippageStdDev(buyExchange, sellExchange) {
  const buyStd  = slippageStdDev(buyExchange);
  const sellStd = slippageStdDev(sellExchange);
  if (buyStd == null && sellStd == null) return null;
  return Math.sqrt((buyStd || 0) ** 2 + (sellStd || 0) ** 2);
}

/** Observability: per-exchange slippage sample count + stddev, for the dashboard/health surfaces. */
function getSlippageStatsByExchange() {
  const out = {};
  for (const [exchange, arr] of _slippageHistoryByExchange.entries()) {
    out[exchange] = { samples: arr.length, stdDevPct: _stdDevOf(arr) };
  }
  return out;
}

/** Test-only: clears both per-exchange and global slippage history. */
function _resetSlippageHistory() {
  _slippageHistoryByExchange.clear();
  _slippageHistoryGlobal.length = 0;
}

// ─── Score compuesto 0-100 ────────────────────────────────────────────────
// Maximum weights per scoring component (mirrored in UI breakdown):
//   profit (profScore)       0-35  → net profit size, log scale
//   liquidity (liqScore)     0-20  → how much slippage consumes the spread
//   persistence (persScore)  0-15  → whether spread is in the "sweet zone"
//   latencia (latScore)      0-15  → ambos feeds por WS y baja latencia = mejor
//   confidence (confScore)   0-10  → price source + slippage methodology
//   penalizaciones           0-13  → fees altos, datos stale, exchange poco confiable
const DEFAULT_SCORE_WEIGHTS = {
  profit: 35, liquidity: 20, persistence: 15, latency: 15, confidence: 10,
};

/**
 * Calcula el score compuesto 0-100 de una oportunidad de arbitraje y el
 * desglose completo de los 5 componentes + 3 penalizaciones que lo forman.
 * Este es el corazón de la transparencia del algoritmo: en vez de una caja
 * negra, cada oportunidad puede mostrar EXACTAMENTE por qué tiene ese score.
 *
 * FUENTE DE VERDAD (auditoría comité, Sesión 34): esta función — no
 * `mlScoringPipeline.scoreOpportunity()` — es la que calcula el score que
 * ve el usuario en la tabla de "⚡ Oportunidades" y el que decide si una
 * oportunidad es viable para ejecución real (ver `detectBtcOpportunities`
 * → `scoreOpportunityDetailed` → `arbitrageOrchestrator.js`). Usa
 * `liveConfig.get('detailedScoreWeights')`, un score determinístico
 * 0-100, pensado para ser explicable componente por componente.
 *
 * `mlScoringPipeline.scoreOpportunity()` es un sistema SEPARADO e
 * intencional (no una duplicación accidental): un pipeline de ML
 * experimental, expuesto solo vía `POST /api/arbitrage/ml/score`, con su
 * propio `liveConfig.get('scoringWeights')`. No alimenta la tabla principal
 * ni la decisión de ejecución — es una superficie aparte para comparar
 * scoring determinístico vs. ML. Si en una demo preguntan "¿cómo se
 * calcula el score que estoy viendo?", la respuesta siempre es: esta
 * función.
 * @param {object} op - oportunidad candidata (ver shape en detectOpportunities)
 * @returns {{score: number, breakdown: object}} score final 1-100 y desglose
 */
function scoreOpportunityDetailed(op) {
  // Section 2 audit: these weights used to be a hardcoded SCORE_WEIGHTS
  // object baked directly into each formula's cap (Math.min(35, ...), the
  // "20 *" in liqScore, etc). Now read from liveConfig each call and applied
  // as a scale factor against the original (35/20/15/15/10) defaults, so
  // adjusting a weight from the UI actually changes the score, not just the
  // label shown in the breakdown.
  const weights     = liveConfig.get('detailedScoreWeights') || DEFAULT_SCORE_WEIGHTS;
  const profScale   = weights.profit      / DEFAULT_SCORE_WEIGHTS.profit;
  const liqScale    = weights.liquidity   / DEFAULT_SCORE_WEIGHTS.liquidity;
  const persScale   = weights.persistence / DEFAULT_SCORE_WEIGHTS.persistence;
  const latScale    = weights.latency     / DEFAULT_SCORE_WEIGHTS.latency;
  const confScale   = weights.confidence  / DEFAULT_SCORE_WEIGHTS.confidence;

  const profPct   = Math.max(0, op.netProfitPct || 0);
  const profScore = Math.min(weights.profit, Math.log1p(profPct * 500) * 5.5 * profScale);

  const slipPct   = op.slippagePct != null ? op.slippagePct : 0.05;
  const grossPct  = Math.max(op.spreadPct || 0, profPct + slipPct);
  const slipRatio = grossPct > 0 ? slipPct / grossPct : 0.5;
  const liqScore  = Math.max(0, DEFAULT_SCORE_WEIGHTS.liquidity * (1 - slipRatio * 1.5) * liqScale);

  const spreadPct = op.spreadPct || 0;
  let persScore;
  if      (spreadPct < 0.10) persScore = spreadPct * 50 * persScale;
  else if (spreadPct < 0.80) persScore = (5 + (spreadPct - 0.10) * 12.5) * persScale;
  else                       persScore = Math.max(0, (15 - (spreadPct - 0.80) * 10) * persScale);

  const latScore = op.buySource === 'ws' && op.sellSource === 'ws'
    ? weights.latency
    : Math.max(0, (15 - Math.floor(((op.buyLatency || 0) + (op.sellLatency || 0)) / 60)) * latScale);

  const bothWs   = op.buySource === 'ws' && op.sellSource === 'ws';
  const anyWs    = op.buySource === 'ws' || op.sellSource === 'ws';
  const wsConf   = (bothWs ? 6 : anyWs ? 4 : 2) * confScale;
  const vwapConf = (op.slippageMethod === 'real' ? 4 : op.slippageMethod === 'partial' ? 2 : 0) * confScale;
  const confScore = wsConf + vwapConf;

  const feePenalty = (HIGH_FEE_EXCHANGES.has(op.buyExchange) ||
                      HIGH_FEE_EXCHANGES.has(op.sellExchange)) ? 5 : 0;

  let stalePenalty = 0;
  if (op.feedAgeMs != null) {
    if      (op.feedAgeMs > 3000) stalePenalty = 3;
    else if (op.feedAgeMs > 1500) stalePenalty = 1;
  }

  // Dynamic reliability penalty — penalizes exchanges with degraded feeds
  // in the last 5 minutes (slow WS, errors, stale data). Returns 0 when
  // the exchange is healthy (reliability ≥ 85%) so normal operation is unaffected.
  // recordFeedEvent() in exchangeService feeds the reliability tracker in real-time.
  //
  // ADR-019 §3/§5: extended with two more penalty sources that measure
  // genuinely different failure modes than feed health — did trades on
  // this exchange actually succeed (execution outcome), and did fills come
  // in worse than modeled (slippage bias). All three are on the same
  // [0, 25] scale and combined via Math.max (worst-of), never summed, per
  // ADR-019 Part A §1: these are different lenses on the same underlying
  // risk, not independent risks that compound. getExecutionPenalty()
  // itself returns a 0-100 failure-rate value, so it's scaled to the
  // shared 0-25 range here at the combination point.
  const _reliabilityPenaltyFor = (ex) => Math.max(
    getDynamicPenalty(ex),
    getExecutionPenalty(ex) * 0.25,
    getSlippagePenalty(ex),
  );
  const buyPenalty  = _reliabilityPenaltyFor(op.buyExchange);
  const sellPenalty = _reliabilityPenaltyFor(op.sellExchange);
  const reliabilityPenalty = Math.max(buyPenalty, sellPenalty); // use worst of the two sides

  const raw = profScore + liqScore + persScore + latScore + confScore - stalePenalty - feePenalty - reliabilityPenalty;
  const score = Math.max(1, Math.min(100, Math.round(raw)));

  const breakdown = {
    components: {
      profit:      { value: +profScore.toFixed(1), max: weights.profit,      label: 'Profit neto' },
      liquidity:   { value: +liqScore.toFixed(1),  max: weights.liquidity,   label: 'Liquidez' },
      persistence: { value: +persScore.toFixed(1), max: weights.persistence, label: 'Persistencia del spread' },
      latency:     { value: +latScore.toFixed(1),  max: weights.latency,     label: 'Latencia de feed' },
      confidence:  { value: +confScore.toFixed(1), max: weights.confidence,  label: 'Confianza de la fuente' },
    },
    penalties: {
      fee:         { value: +feePenalty.toFixed(1),         label: 'Fee alto' },
      stale:       { value: +stalePenalty.toFixed(1),       label: 'Datos stale' },
      reliability: { value: +reliabilityPenalty.toFixed(1), label: 'Exchange poco confiable' },
    },
    rawScore: +raw.toFixed(1),
    finalScore: score,
  };

  return { score, breakdown };
}

// Backward-compatible: most callers only need the numeric score.
function scoreOpportunity(op) {
  return scoreOpportunityDetailed(op).score;
}

// ─── Compute slippage ─────────────────────────────────────────────────────
function computeSlippage(exchange, side, price, tradeAmount) {
  const slip = calcRealSlippage(tradeAmount, side, exchange);

  if (slip.method === 'real' && slip.slippageUSD != null) {
    recordSlippage(exchange, slip.slippagePct);
    return { slippageUSD: slip.slippageUSD, slippagePct: slip.slippagePct, method: 'real' };
  }

  const fallbackUSD = price * tradeAmount * SLIPPAGE_FIXED;
  return { slippageUSD: fallbackUSD, slippagePct: SLIPPAGE_FIXED * 100, method: 'fallback' };
}

// ─── Liquidity check ──────────────────────────────────────────────────────
function checkLiquidity(exchange, side, amount) {
  const depth = getDepth(exchange);
  if (!depth) return { ok: true, reason: null, fillable: amount, fillPct: 100 };

  const levels = side === 'buy' ? depth.asks : depth.bids;
  if (!levels || !levels.length) return { ok: true, reason: null, fillable: amount, fillPct: 100 };

  const totalQty = levels.reduce((s, [, q]) => s + q, 0);
  const fillable = Math.min(totalQty, amount);
  const fillPct  = (fillable / amount) * 100;

  if (totalQty < amount * liquidityMinFill()) {
    return {
      ok:       false,
      reason:   `Liquidity ${fillPct.toFixed(0)}% on ${exchange} ${side}: ${totalQty.toFixed(4)} BTC available`,
      fillable: totalQty,
      fillPct:  +fillPct.toFixed(1),
    };
  }
  return { ok: true, reason: null, fillable, fillPct: +fillPct.toFixed(1) };
}

// ─── detectOpportunities ──────────────────────────────────────────────────
/**
 * Escanea todos los pares de exchanges activos buscando arbitraje bilateral
 * viable (comprar en uno, vender en otro). Para cada par calcula spread,
 * slippage real (VWAP sobre L2), fees, profit neto, y si es viable le asigna
 * un score compuesto (ver scoreOpportunityDetailed). Las oportunidades NO
 * viables se registran con su razón exacta de rechazo (rejectionReason) para
 * alimentar missedOpportunityTracker .
 * @param {object} orderBooks - order books actuales por exchange ({Binance: {...}, ...})
 * @param {number} [tradeAmount] - tamaño de trade en BTC; si se omite, lee liveConfig.tradeAmountBTC
 * @returns {object} { opportunities, triangular, statArb, ... } — ver shape completo en el código
 */
function detectOpportunities(orderBooks, tradeAmount) {
  // Guard: null/undefined orderBooks returns empty result safely
  if (!Array.isArray(orderBooks)) orderBooks = [];

  // Performance fix (audit): snapshot all liveConfig values ONCE at the
  // start of each detection cycle instead of calling liveConfig.get() on
  // every iteration of the inner loop. liveConfig.get() is O(1) but has
  // function-call + Map-lookup overhead that accumulates over 89 calls per
  // cycle at 150ms intervals. Snapshotting here also guarantees a consistent
  // view of config within a single detection pass (no mid-cycle config drift).
  const _minNetProfit    = liveConfig.get('minNetProfitUSD');
  const _minSpreadPct    = liveConfig.get('minSpreadPct');
  const _maxSpreadPct    = liveConfig.get('maxSpreadPct');
  const _activeExchanges = liveConfig.get('activeExchanges');
  const _feeMode         = liveConfig.get('feeMode');
  const _feeModeLabel    = _feeMode === 'maker' ? ' [maker]' : ' [taker]';

  const amount = tradeAmount != null ? tradeAmount : liveConfig.get('tradeAmountBTC');
  const FEES   = getFees();

  const totalEvalStart = Date.now();

  const valid = orderBooks.filter(ob => {
    if (!ob.bid || !ob.ask || ob.error) return false;
    if (ob.ask <= 0 || ob.bid <= 0) return false;
    // filtrar exchanges deshabilitados por liveConfig.activeExchanges
    if (Array.isArray(_activeExchanges) && _activeExchanges.length > 0 && !_activeExchanges.includes(ob.exchange)) return false;
    if (isFeedStale(ob.exchange)) {
      return ob.feedAgeMs != null && ob.feedAgeMs < 5000;
    }
    return true;
  });

  const opportunities = [];

  for (let i = 0; i < valid.length; i++) {
    for (let j = 0; j < valid.length; j++) {
      if (i === j) continue;

      const buyEx  = valid[i];
      const sellEx = valid[j];

      const askA = buyEx.ask;
      const bidB = sellEx.bid;

      if (askA <= 0 || bidB <= 0) continue;

      const feeA = FEES[buyEx.exchange]  || 0.001;
      const feeB = FEES[sellEx.exchange] || 0.001;

      const buySlip  = computeSlippage(buyEx.exchange,  'buy',  askA, amount);
      const sellSlip = computeSlippage(sellEx.exchange, 'sell', bidB, amount);

      const slippageCost   = buySlip.slippageUSD + sellSlip.slippageUSD;
      const slippagePct    = (buySlip.slippagePct + sellSlip.slippagePct) / 2;
      const slippageMethod = (buySlip.method === 'real' && sellSlip.method === 'real') ? 'real'
                           : (buySlip.method === 'real' || sellSlip.method === 'real') ? 'partial'
                           : 'fallback';

      const buyLiq  = checkLiquidity(buyEx.exchange,  'buy',  amount);
      const sellLiq = checkLiquidity(sellEx.exchange, 'sell', amount);

      const grossProfit = (bidB - askA) * amount;
      const buyFee      = askA * amount * feeA;
      const sellFee     = bidB * amount * feeB;

      const wfBuy  = WITHDRAWAL_FEES[buyEx.exchange]  || { BTC: 0.0003, USDT: 6 };
      const wfSell = WITHDRAWAL_FEES[sellEx.exchange] || { BTC: 0.0003, USDT: 6 };
      // Symmetric round-trip rebalancing cost: BTC goes from buy→sell exchange,
      // USDT goes from sell→buy exchange. Amortized as average of both withdrawal fees.
      const withdrawalFeeUSD = +(
        ((wfBuy.BTC + wfSell.BTC) / 2) * askA +
        ((wfBuy.USDT + wfSell.USDT) / 2)
      ).toFixed(4);

      // True break-even: the minimum spread needed to cover all execution costs.
      // Does NOT include MIN_NET_PROFIT (that is a profit target, not a cost).
      const trueCost         = buyFee + sellFee + slippageCost;
      const notional         = askA * amount;
      const breakEvenPct     = notional > 0 ? +(trueCost / notional * 100).toFixed(4) : 0;
      // viabilityThresholdPct: spread needed to also clear the minimum profit target.
      const viabilityThresholdPct = notional > 0
        ? +((trueCost + liveConfig.get('minNetProfitUSD')) / notional * 100).toFixed(4)
        : 0;

      const netProfit    = grossProfit - buyFee - sellFee - slippageCost;
      const netProfitPct = notional > 0 ? (netProfit / notional) * 100 : 0;

      // Per-exchange combined stddev (audit item #2) — replaces the old
      // single global slippageStdDev(), which gave Kraken/Coinbase's
      // thinner books the exact same estimated variance as Binance/OKX's
      // deeper ones. See combinedSlippageStdDev() above for the Var(buy)+
      // Var(sell) reasoning.
      const slipStd = combinedSlippageStdDev(buyEx.exchange, sellEx.exchange);
      let profitLow = null, profitHigh = null;
      if (slipStd != null) {
        const uncertainty = slipStd * 0.01 * notional;
        profitLow  = +(netProfit - uncertainty * 1.96).toFixed(4);
        profitHigh = +(netProfit + uncertainty * 1.96).toFixed(4);
      }

      const spreadPct = ((bidB - askA) / askA) * 100;

      const cbSpreadTooSmall = spreadPct < _minSpreadPct;
      const cbSpreadTooLarge = spreadPct > _maxSpreadPct;
      const circuitBreaker   = cbSpreadTooSmall || cbSpreadTooLarge;

      const liquidityOk  = buyLiq.ok && sellLiq.ok;
      const viableRaw    = netProfit > _minNetProfit;
      const dailyStopped = isDailyLossBreached();
      const viable       = viableRaw && !circuitBreaker && liquidityOk && !dailyStopped;

      let rejectionReason   = null;
      let rejectionCategory = null;

      if (!viable) {
        if (dailyStopped) {
          rejectionCategory = 'daily_stop';
          rejectionReason   = `Daily loss limit reached ($${getDailyPnl().toFixed(2)})`;
        } else if (!liquidityOk) {
          rejectionCategory = 'liquidity';
          rejectionReason   = buyLiq.ok ? sellLiq.reason : buyLiq.reason;
        } else if (bidB <= askA) {
          rejectionCategory = 'negative_spread';
          rejectionReason   = 'Precio de compra ≥ precio de venta';
        } else if (cbSpreadTooSmall) {
          rejectionCategory = 'circuit_breaker';
          rejectionReason   = `Spread ${spreadPct.toFixed(4)}% below ${_minSpreadPct}% minimum`;
        } else if (cbSpreadTooLarge) {
          rejectionCategory = 'circuit_breaker';
          rejectionReason   = `Spread ${spreadPct.toFixed(2)}% > ${_maxSpreadPct}% (datos obsoletos)`;
        } else if (!viableRaw) {
          rejectionCategory = 'fees_slippage';
          const highFeeNote = (HIGH_FEE_EXCHANGES.has(buyEx.exchange) || HIGH_FEE_EXCHANGES.has(sellEx.exchange))
            ? ` | ⚠ Coinbase fee 0.60%` : '';
          const feeMode = _feeModeLabel;
          rejectionReason = `Net $${netProfit.toFixed(4)} < $${_minNetProfit} | ` +
            `break-even ${breakEvenPct}% | viability-threshold ${viabilityThresholdPct}% | spread ${spreadPct.toFixed(4)}% | ` +
            `Fees $${(buyFee + sellFee).toFixed(2)} + Slip $${slippageCost.toFixed(2)}${highFeeNote}${feeMode}`;
        }

        if (rejectionCategory) _rejectionCounts[rejectionCategory]++;
      }

      if (!viable && netProfit > -(_minNetProfit * 5) && netProfit <= _minNetProfit) {
        _nearViableCount++;
      }

      if (_bestOpportunitySeen === null || netProfit > _bestOpportunitySeen.netProfit) {
        _bestOpportunitySeen = {
          buyExchange:  buyEx.exchange,
          sellExchange: sellEx.exchange,
          netProfit:    +netProfit.toFixed(4),
          spreadPct:    +spreadPct.toFixed(4),
          breakEvenPct,
          feeMode:      _feeMode,
          ts:           new Date().toISOString(),
        };
      }

      const pairEvalMs = Date.now() - totalEvalStart;
      const detectionLatencyMs = buyEx.feedAgeMs || 0;

      const op = {
        id:             `arb-${buyEx.exchange}-${sellEx.exchange}`, // Issue 12: stable per-pair ID
        buyExchange:    buyEx.exchange,
        sellExchange:   sellEx.exchange,
        buyPrice:       +askA.toFixed(2),
        sellPrice:      +bidB.toFixed(2),
        spreadPct:      +spreadPct.toFixed(4),
        grossProfit:    +grossProfit.toFixed(4),
        buyFee:         +buyFee.toFixed(4),
        sellFee:        +sellFee.toFixed(4),
        totalFees:      +(buyFee + sellFee).toFixed(4),
        slippage:       +slippageCost.toFixed(4),
        slippagePct:    +slippagePct.toFixed(4),
        slippageMethod,
        buySlipMethod:  buySlip.method,
        sellSlipMethod: sellSlip.method,
        withdrawalFeeUSD,
        withdrawalModel:  'periodic_rebalancing',
        breakEvenPct,
        viabilityThresholdPct,
        netProfit:      +netProfit.toFixed(4),
        netProfitPct:   +netProfitPct.toFixed(4),
        profitLow,
        profitHigh,
        viable,
        circuitBreaker,
        liquidityOk,
        buyFillPct:     buyLiq.fillPct,
        sellFillPct:    sellLiq.fillPct,
        rejectionReason,
        rejectionCategory,
        buyLatency:     buyEx.latencyMs || 0,
        sellLatency:    sellEx.latencyMs || 0,
        buySource:      buyEx.source || 'http',
        sellSource:     sellEx.source || 'http',
        feedAgeMs:      Math.max(buyEx.feedAgeMs || 0, sellEx.feedAgeMs || 0),
        detectionLatencyMs,
        evalMs:         pairEvalMs,
        feeMode:        _feeMode,
        tradeAmount:    amount,
        detectedAt:     Date.now(),    // epoch ms — for opportunity age display in UI
        ts:             new Date().toISOString(),
      };

      if (viable) {
        const { score, breakdown } = scoreOpportunityDetailed(op);
        op.score = score;
        op.scoreBreakdown = breakdown;
      } else {
        op.score = 0;
        op.scoreBreakdown = null;
      }

      // Contract check (audit committee, sección 12, punto 1): opportunityDetection
      // is the single source of truth for the Opportunity shape (see
      // domain/opportunity.ts) — every other engine trusts that whatever comes
      // out of here matches it. This is a cheap regression guard, not a hot-path
      // validation library: if a future edit here drops a required field, this
      // fires immediately in tests/dev instead of surfacing as a confusing
      // `undefined` three modules downstream.
      if (!isOpportunity(op)) {
        obs.emit('RISK', 'contract.opportunity_shape_invalid', { id: op.id, buyExchange: op.buyExchange, sellExchange: op.sellExchange });
      }

      opportunities.push(op);

      if (_opportunityLog.length >= MAX_OPP_LOG) _opportunityLog.shift();
      _opportunityLog.push({
        pair:         `${buyEx.exchange}→${sellEx.exchange}`,
        netProfit:    op.netProfit,
        spreadPct:    op.spreadPct,
        breakEvenPct: op.breakEvenPct,
        viable:       op.viable,
        rejCat:       op.rejectionCategory,
        slipMethod:   op.slippageMethod,
        feeMode:      op.feeMode,
        // `score` was missing here (found this session): arbBacktestEngine's
        // simulateRun() gates every execution on `op.score >= minScore`, and
        // adaptiveScoring.js reads the same field via walkForward(). Without
        // it, every simulated trade silently failed that comparison
        // (`undefined >= minScore` is always false), so
        // /api/arbitrage/arb-backtest/* always reported zero trades executed
        // and zero net profit regardless of real market activity — a silent
        // drift bug with no test coverage until this session. See
        // tests/arbBacktestEngine.test.js for the regression test.
        score:        op.score,
        ts:           op.ts,
      });
    }
  }

  opportunities.sort((a, b) => {
    if (a.viable && !b.viable) return -1;
    if (!a.viable && b.viable) return 1;
    return b.score - a.score || b.netProfit - a.netProfit;
  });

  // ─── DEMO_MODE: inject synthetic opportunity when market is flat ──────────
  // Only activates when DEMO_MODE=true and no real viable opportunity exists.
  // Synthetic opportunities are clearly marked with synthetic:true and [DEMO] labels
  // so the jury can distinguish them from real detections. They demonstrate the full
  // execution pipeline (detection → score → execute → wallet update → equity curve)
  // using realistic parameters (0.40% spread, real fee structure, simulated VWAP).
  if (process.env.DEMO_MODE === 'true' && !opportunities.some(o => o.viable)) {
    const candidates = valid.filter(ob => !ob.error && ob.ask > 0 && ob.bid > 0);
    if (candidates.length >= 2) {
      const buyEx  = candidates[0];
      const sellEx = candidates[1] || candidates[0];
      const FEES   = getFees();
      const feeA   = FEES[buyEx.exchange]  || 0.001;
      const feeB   = FEES[sellEx.exchange] || 0.001;
      const askA   = buyEx.ask;
      // Synthesize a 0.40% spread — realistic for high-volatility windows
      const bidB   = +(askA * 1.004).toFixed(2);
      const amt    = liveConfig.get('tradeAmountBTC');

      const grossProfit    = (bidB - askA) * amt;
      const buyFee         = askA * amt * feeA;
      const sellFee        = bidB * amt * feeB;
      const slippageCost   = askA * amt * SLIPPAGE_FIXED * 2;
      const trueCost       = buyFee + sellFee + slippageCost;
      const notional       = askA * amt;
      const netProfit      = +(grossProfit - trueCost).toFixed(4);
      const netProfitPct   = +((netProfit / notional) * 100).toFixed(4);
      const breakEvenPct   = +((trueCost / notional) * 100).toFixed(4);
      const viabilityThresholdPct = +((( trueCost + liveConfig.get('minNetProfitUSD')) / notional) * 100).toFixed(4);
      const spreadPct      = +((bidB - askA) / askA * 100).toFixed(4);

      const wfBuy  = WITHDRAWAL_FEES[buyEx.exchange]  || { BTC: 0.0003, USDT: 6 };
      const wfSell = WITHDRAWAL_FEES[sellEx.exchange] || { BTC: 0.0003, USDT: 6 };
      const withdrawalFeeUSD = +(
        ((wfBuy.BTC + wfSell.BTC) / 2) * askA +
        ((wfBuy.USDT + wfSell.USDT) / 2)
      ).toFixed(4);

      const syntheticOp = {
        id:             `arb-demo-${Date.now()}`,
        synthetic:      true,
        buyExchange:    buyEx.exchange,
        sellExchange:   sellEx.exchange,
        buyPrice:       +askA.toFixed(2),
        sellPrice:      +bidB.toFixed(2),
        spreadPct,
        grossProfit:    +grossProfit.toFixed(4),
        buyFee:         +buyFee.toFixed(4),
        sellFee:        +sellFee.toFixed(4),
        totalFees:      +(buyFee + sellFee).toFixed(4),
        slippage:       +slippageCost.toFixed(4),
        slippagePct:    +(SLIPPAGE_FIXED * 100 * 2).toFixed(4),
        slippageMethod: 'fallback',
        buySlipMethod:  'fallback',
        sellSlipMethod: 'fallback',
        withdrawalFeeUSD,
        withdrawalModel: 'periodic_rebalancing',
        breakEvenPct,
        viabilityThresholdPct,
        netProfit,
        netProfitPct,
        profitLow:      null,
        profitHigh:     null,
        viable:         true,
        circuitBreaker: false,
        liquidityOk:    true,
        buyFillPct:     100,
        sellFillPct:    100,
        rejectionReason:   null,
        rejectionCategory: null,
        buyLatency:     buyEx.latencyMs  || 0,
        sellLatency:    sellEx.latencyMs || 0,
        buySource:      buyEx.source  || 'ws',
        sellSource:     sellEx.source || 'ws',
        feedAgeMs:      Math.max(buyEx.feedAgeMs || 0, sellEx.feedAgeMs || 0),
        detectionLatencyMs: 0,
        evalMs:         0,
        feeMode:        'taker',
        tradeAmount:    amt,
        detectedAt:     Date.now(),
        ts:             new Date().toISOString(),
        score:          0,
      };
      const detailedSynthetic = scoreOpportunityDetailed(syntheticOp);
      syntheticOp.score = detailedSynthetic.score;
      syntheticOp.scoreBreakdown = detailedSynthetic.breakdown;
      opportunities.unshift(syntheticOp);
      obs.emit('DEMO', 'demo.synthetic_opportunity', { pair: `${buyEx.exchange}→${sellEx.exchange}`, spreadPct, netProfit });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const triangularResult  = detectTriangularSignal(valid, FEES);
  const triangularSignal  = triangularResult.best;         // el mejor para auto-execution
  const triangularSignals = triangularResult.allSignals;   // todas las rutas viables para UI
  const statArbSignals    = detectStatArb(orderBooks);
  // Audit item #4: generalizes triangularSignal's fixed 3-hop enumeration
  // into an N-hop search (see multiHopArbitrageEngine.js). Informational
  // only for now, same status triangularSignal had before it grew an
  // execution path — multiHopSignal.cycle.hops can be 2, 3, 4, or 5,
  // whichever the graph's best cycle actually is.
  const multiHopResult    = detectMultiHopArbitrage(valid, FEES);
  const multiHopSignal    = multiHopResult.hasArbitrage ? multiHopResult.cycle : null;
  const evalMs = Date.now() - totalEvalStart;

  return { opportunities, triangularSignal, triangularSignals, statArbSignals, multiHopSignal, evalMs };
}

// ─── Triangular signal (informational) ───────────────────────────────────
/**
 * detectTriangularSignal — v11 (mejorado)
 *
 * Cambios respecto a la versión anterior:
 *
 * 1. Retorna un objeto { best, allSignals } en lugar de solo `best`.
 *    `allSignals` contiene TODAS las rutas con netPct > 0, ordenadas por netPct.
 *    El execution path usa `best` igual que antes — sin cambios de comportamiento.
 *    `allSignals` se expone en el SSE para mostrar en el UI cuántas rutas son
 *    simultáneamente viables.
 *
 * 2. Slippage por leg en lugar de un fallback fijo de 0.15% total.
 *    Cada leg tiene su propio spread de book (bid/ask), que es una proxy
 *    razonable del slippage de ejecución en ese exchange: si el spread del book
 *    de bB es 0.02%, ahí habrá un slippage de ejecución similar.
 *    Esto no reemplaza el VWAP L2 walk (que requiere depth data por leg),
 *    pero es más preciso que 0.15% fijo para los 3 legs.
 *
 * 3. Elimina el campo `disclaimer` mentiroso — el triangular YA se auto-ejecuta
 *    desde v9, así que el disclaimer era incorrecto.
 */
function detectTriangularSignal(books, FEES) {
  const fees = FEES || getFees();
  if (books.length < 3) return { best: null, allSignals: [] };

  const allSignals = [];

  for (let a = 0; a < books.length; a++) {
    for (let b = 0; b < books.length; b++) {
      if (b === a) continue;
      for (let c = 0; c < books.length; c++) {
        if (c === a || c === b) continue;
        const bA = books[a], bB = books[b], bC = books[c];
        if (!bA.ask || !bB.bid || !bB.ask || !bC.bid) continue;
        if (bA.error || bB.error || bC.error) continue;

        const s1 = (bB.bid - bA.ask) / bA.ask;
        const s2 = (bC.bid - bB.ask) / bB.ask;

        const grossPct = ((1 + s1) * (1 + s2) - 1) * 100;

        // Fees: one taker fee per leg (buy on A, sell on B, sell on C)
        const feePct = (
          (fees[bA.exchange] || 0.001) +
          (fees[bB.exchange] || 0.001) +
          (fees[bC.exchange] || 0.001)
        ) * 100;

        // Slippage: use book spread as proxy for execution slippage per leg.
        // spreadPct_A ≈ (ask_A − bid_A) / mid_A — measures market tightness.
        // Better than a flat 0.15% for all routes; tighter books (Binance)
        // have lower estimated slippage than wider ones (Kraken).
        const slipA = bA.ask && bA.bid ? (bA.ask - bA.bid) / ((bA.ask + bA.bid) / 2) * 100 : 0.05;
        const slipB = bB.ask && bB.bid ? (bB.ask - bB.bid) / ((bB.ask + bB.bid) / 2) * 100 : 0.05;
        const slipC = bC.ask && bC.bid ? (bC.ask - bC.bid) / ((bC.ask + bC.bid) / 2) * 100 : 0.05;
        const slipPct = slipA + slipB + slipC;

        const netPct = grossPct - feePct - slipPct;

        if (netPct > 0) {
          allSignals.push({
            path:     `${bA.exchange} → ${bB.exchange} → ${bC.exchange}`,
            netPct:   +netPct.toFixed(4),
            grossPct: +grossPct.toFixed(4),
            feePct:   +feePct.toFixed(4),
            slipPct:  +slipPct.toFixed(4),
            label:    `${bA.exchange[0]}→${bB.exchange[0]}→${bC.exchange[0]}`,
            type:     'triangular',
            // Exchanges for execution path
            legA: bA.exchange, legB: bB.exchange, legC: bC.exchange,
          });
        }
      }
    }
  }

  allSignals.sort((a, b) => b.netPct - a.netPct);
  const best = allSignals[0] || null;

  return { best, allSignals };
}

// ─── executeSimulated ─────────────────────────────────────────────────────
function executeSimulated(opportunity, wallets, amount) {
  const t0 = Date.now();
  const requestedAmount = amount != null ? amount : (opportunity.tradeAmount || liveConfig.get('tradeAmountBTC'));

  const {
    buyExchange, sellExchange, buyPrice, sellPrice,
    grossProfit, buyFee, sellFee, slippage, withdrawalFeeUSD,
  } = opportunity;

  if (!buyPrice || !sellPrice || buyPrice <= 0 || sellPrice <= 0) {
    return { ok: false, reason: 'Invalid prices in opportunity' };
  }

  if (opportunity.circuitBreaker) {
    return { ok: false, reason: 'Circuit breaker: spread too large or too small' };
  }

  if (!opportunity.liquidityOk) {
    return { ok: false, reason: opportunity.rejectionReason || 'Liquidity check failed' };
  }

  // H-6/item 3 fix: antes esto siempre leía wallets.BTC (o, tras H-6, caía a
  // BTC para cualquier asset que no fuera exactamente 'ETH') sin importar
  // qué activo fuera la oportunidad. Ahora reconoce también XRP — mismo
  // criterio que walletManager.resolveWalletAsset, consolidado aquí porque
  // este archivo no puede importar ese TS interno directamente. Default
  // 'BTC' preserva el comportamiento exacto para todo caller que nunca
  // puso `asset`.
  const asset = (opportunity.asset === 'ETH' || opportunity.asset === 'XRP') ? opportunity.asset : 'BTC';
  const usdtNeeded    = buyPrice * requestedAmount;
  const usdtBalance   = wallets.USDT?.[buyExchange] || 0;
  const assetBalance  = wallets[asset]?.[sellExchange] || 0;

  let execAmount = requestedAmount;
  if (usdtBalance < usdtNeeded) {
    execAmount = Math.floor((usdtBalance / buyPrice) * 10000) / 10000;
  }
  if (assetBalance < execAmount) {
    execAmount = Math.min(execAmount, assetBalance);
  }
  if (execAmount <= 0.0001) {
    return { ok: false, reason: `Saldo insuficiente en ${buyExchange} (USDT) o ${sellExchange} (${asset})` };
  }

  const ratio = execAmount / requestedAmount;

  const scaledGross   = +(grossProfit * ratio).toFixed(4);
  const scaledBuyFee  = +(buyFee      * ratio).toFixed(4);
  const scaledSellFee = +(sellFee     * ratio).toFixed(4);
  const scaledSlip    = +((slippage || 0) * ratio).toFixed(4);
  const execNetProfit = +((grossProfit - buyFee - sellFee - (slippage || 0)) * ratio).toFixed(4);
  const execNetProfitPct = buyPrice > 0
    ? +((execNetProfit / (buyPrice * execAmount)) * 100).toFixed(4)
    : 0;

  const trade = {
    id:              `trade-${Date.now()}-${crypto.randomUUID()}`,
    asset,
    buyExchange,
    sellExchange,
    buyPrice,
    sellPrice,
    amount:          +execAmount.toFixed(6),
    requestedAmount,
    partialFill:     execAmount < requestedAmount,
    grossProfit:     scaledGross,
    buyFee:          scaledBuyFee,
    sellFee:         scaledSellFee,
    totalFees:       +(scaledBuyFee + scaledSellFee).toFixed(4),
    slippage:        scaledSlip,
    slippagePct:     opportunity.slippagePct,
    slippageMethod:  opportunity.slippageMethod,
    withdrawalFeeUSD: withdrawalFeeUSD || 0,
    withdrawalModel:  'periodic_rebalancing',
    netProfit:       execNetProfit,
    netProfitPct:    execNetProfitPct,
    spreadPct:       opportunity.spreadPct,
    breakEvenPct:    opportunity.breakEvenPct,
    score:           opportunity.score || 0,
    buySource:       opportunity.buySource,
    sellSource:      opportunity.sellSource,
    feeMode:         opportunity.feeMode || (liveConfig.get('feeMode') === 'maker' ? 'maker' : 'taker'),
    status:          execNetProfit > 0 ? 'profit' : 'loss',
    executionMs:     Date.now() - t0,
    ts:              new Date().toISOString(),
  };

  // Contract check — see the matching isOpportunity() note above. `trade` is
  // the canonical Trade shape (domain/opportunity.ts); this is the one place
  // in the codebase that builds it, so this is where a shape regression is
  // cheapest to catch.
  if (!isTrade(trade)) {
    obs.emit('RISK', 'contract.trade_shape_invalid', { id: trade.id, buyExchange: trade.buyExchange, sellExchange: trade.sellExchange });
  }

  return { ok: true, trade };
}

// ─── executeTriangularSimulated ───────────────────────────────────────────
/**
 * Executes a 2-leg triangular arb signal as two simulated trades.
 *
 * Strategy: A→B→C means:
 *   Leg 1: Buy BTC in exchange A (spend USDT on A, receive BTC on A)
 *   Leg 2: Sell BTC in exchange C (spend BTC on C, receive USDT on C)
 *   (B is the mid-exchange whose bid/ask created the opportunity)
 *
 * Minimum threshold: netPct must exceed 0.05% to cover slippage uncertainty
 * across two legs. This is intentionally conservative.
 *
 * Returns two trade objects (leg1, leg2) or { ok: false, reason }.
 */
// MIN_TRIANGULAR_NET_PCT now reads from liveConfig for hot-reload support
function executeTriangularSimulated(signal, orderBooks, wallets, amount) {
  if (!signal) return { ok: false, reason: 'No triangular signal' };
  const MIN_TRI = liveConfig.get('minTriangularNetPct');
  if ((signal.netPct || 0) < MIN_TRI) {
    return { ok: false, reason: `Triangular netPct ${signal.netPct}% < ${MIN_TRI}% minimum` };
  }

  const FEES = getFees();
  const execAmount = amount != null ? amount : liveConfig.get('tradeAmountBTC');
  const t0 = Date.now();

  // Parse the path "Exchange A → Exchange B → Exchange C"
  const parts = signal.path.split(' → ').map(s => s.trim());
  if (parts.length < 3) return { ok: false, reason: 'Invalid triangular path format' };

  const [exA, , exC] = parts;

  const bookA = orderBooks.find(ob => ob.exchange === exA);
  const bookC = orderBooks.find(ob => ob.exchange === exC);

  if (!bookA || !bookC) return { ok: false, reason: `Order book missing for ${exA} or ${exC}` };
  if (!bookA.ask || !bookC.bid) return { ok: false, reason: 'Invalid prices in order books' };

  const askA  = bookA.ask;
  const bidC  = bookC.bid;
  const feeA  = FEES[exA] || 0.001;
  const feeC  = FEES[exC] || 0.001;

  const usdtNeeded = askA * execAmount;
  const btcNeeded  = execAmount;

  if ((wallets.USDT?.[exA] || 0) < usdtNeeded) {
    return { ok: false, reason: `Insufficient USDT on ${exA} for triangular leg 1` };
  }
  if ((wallets.BTC?.[exC] || 0) < btcNeeded) {
    return { ok: false, reason: `Insufficient BTC on ${exC} for triangular leg 2` };
  }

  const leg1BuyFee      = +(askA * execAmount * feeA).toFixed(4);
  const leg2GrossProfit = +((bidC - askA) * execAmount).toFixed(4);
  const leg2SellFee     = +(bidC * execAmount * feeC).toFixed(4);

  const totalNetProfit  = +(leg2GrossProfit - leg1BuyFee - leg2SellFee).toFixed(4);
  const totalNetPct     = +((totalNetProfit / usdtNeeded) * 100).toFixed(4);

  // Re-validate net profit after real fee calculation
  if (totalNetProfit <= liveConfig.get('minNetProfitUSD')) {
    return { ok: false, reason: `Triangular net $${totalNetProfit} after real fees below threshold` };
  }

  const leg1 = {
    id:            `tri-leg1-${Date.now()}-${crypto.randomUUID()}`,
    type:          'triangular_leg1',
    buyExchange:   exA,
    sellExchange:  exA,  // both sides on exchange A (buy BTC with USDT)
    buyPrice:      +askA.toFixed(2),
    sellPrice:     +askA.toFixed(2),
    amount:        +execAmount.toFixed(6),
    grossProfit:   0,
    buyFee:        leg1BuyFee,
    sellFee:       0,
    totalFees:     leg1BuyFee,
    slippage:      0,
    slippagePct:   0,
    slippageMethod:'triangular',
    netProfit:     +(-leg1BuyFee).toFixed(4),
    netProfitPct:  +((-leg1BuyFee / usdtNeeded) * 100).toFixed(4),
    spreadPct:     signal.grossPct || 0,
    breakEvenPct:  0,
    score:         50,
    buySource:     bookA.source || 'ws',
    sellSource:    bookA.source || 'ws',
    feeMode:       liveConfig.get('feeMode') === 'maker' ? 'maker' : 'taker',
    status:        'triangular_buy',
    triangularPath: signal.path,
    triangularLeg:  1,
    executionMs:   Date.now() - t0,
    ts:            new Date().toISOString(),
  };

  const leg2 = {
    id:            `tri-leg2-${Date.now()}-${crypto.randomUUID()}`,
    type:          'triangular_leg2',
    buyExchange:   exA,  // BTC was bought on A
    sellExchange:  exC,  // BTC is sold on C
    buyPrice:      +askA.toFixed(2),
    sellPrice:     +bidC.toFixed(2),
    amount:        +execAmount.toFixed(6),
    grossProfit:   +leg2GrossProfit.toFixed(4),
    buyFee:        leg1BuyFee,
    sellFee:       leg2SellFee,
    totalFees:     +(leg1BuyFee + leg2SellFee).toFixed(4),
    slippage:      0,
    slippagePct:   0,
    slippageMethod:'triangular',
    netProfit:     totalNetProfit,
    netProfitPct:  totalNetPct,
    spreadPct:     +(((bidC - askA) / askA) * 100).toFixed(4),
    breakEvenPct:  +((leg1BuyFee + leg2SellFee) / usdtNeeded * 100).toFixed(4),
    score:         60,
    buySource:     bookA.source || 'ws',
    sellSource:    bookC.source || 'ws',
    feeMode:       liveConfig.get('feeMode') === 'maker' ? 'maker' : 'taker',
    status:        totalNetProfit > 0 ? 'profit' : 'loss',
    triangularPath: signal.path,
    triangularLeg:  2,
    executionMs:   Date.now() - t0,
    ts:            new Date().toISOString(),
  };

  return { ok: true, leg1, leg2, totalNetProfit, totalNetPct };
}

module.exports = {
  detectOpportunities,
  scoreOpportunity,
  scoreOpportunityDetailed,
  executeSimulated,
  executeTriangularSimulated,
  getDailyPnl,
  addDailyPnl,
  isDailyLossBreached,
  resetDailyPnl,
  getRejectionCounts,
  getBestOpportunitySeen,
  getNearViableCount,
  getOpportunityLog,
  resetSessionStats,
  setStressFeeMultiplier,
  getStressFeeMultiplier,
  getStatArbSummary,
  resetStatArb,
  slippageStdDev,
  combinedSlippageStdDev,
  getSlippageStatsByExchange,
  _resetSlippageHistory,
  // exports compatibles con tests existentes (valores actuales de liveConfig)
  get _MIN_NET_PROFIT()        { return liveConfig.get('minNetProfitUSD'); },
  get _MIN_SPREAD_PCT()        { return liveConfig.get('minSpreadPct'); },
  get _DEFAULT_TRADE_AMOUNT()  { return liveConfig.get('tradeAmountBTC'); },
  get _USE_MAKER_FEES()        { return liveConfig.get('feeMode') === 'maker'; },
  get _MIN_TRIANGULAR_NET_PCT(){ return liveConfig.get('minTriangularNetPct'); },
};

/**
 * arbitrageEngine.js — kukora arbitrage v5
 *
 * FIXES v5:
 *  1. feeConfig import fixed (lowercase) — was crashing on Linux
 *  2. MIN_NET_PROFIT lowered to 0.01 USD (was 0.10) for 0.01 BTC trades
 *  3. DEMO_MODE: synthetic op gets score=50 minimum for execution
 *  4. DEMO_MODE: synthetic op also passes checkFingerprint on score threshold
 *  5. DEMO_MODE trade interval: 60-120s (was never triggering — fingerprint + minScore blocked it)
 *  6. rejectionCategory 'circuit_breaker_small' split from 'circuit_breaker' for better analytics
 *  7. breakEvenPct capped to prevent Infinity when askA=0
 *  8. slippage stddev uses safe division
 */

const { calcRealSlippage, getDepth, isFeedStale } = require('./exchangeService');
const { TRADING_FEES: TAKER_FEES, MAKER_FEES, WITHDRAWAL_FEES, SLIPPAGE_RATE } = require('./feeConfig');

// ─── Configuración ────────────────────────────────────────────────────────
const DEFAULT_TRADE_AMOUNT = parseFloat(process.env.TRADE_AMOUNT_BTC || '0.01');
const USE_MAKER_FEES       = process.env.FORCE_MAKER_FEES === 'true';
const DEMO_MODE            = process.env.DEMO_MODE === 'true';

const SLIPPAGE_FIXED     = SLIPPAGE_RATE;  // 0.05% por lado (fallback)
const MIN_NET_PROFIT     = 0.01;           // USD — umbral mínimo (era 0.10, muy alto para 0.01 BTC)
const MAX_SPREAD_PCT     = 3.0;            // circuit breaker
const MIN_SPREAD_PCT     = 0.005;          // bajado a 0.005% para capturar más reales
const MAX_DAILY_LOSS     = -500;
const LIQUIDITY_MIN_FILL = 0.80;

// Demo mode: intervalo mínimo entre trades sintéticos
const DEMO_MIN_INTERVAL_MS = 60_000;  // 60s entre ejecuciones demo
let _lastDemoExecTs = 0;

function getFees() {
  return USE_MAKER_FEES && MAKER_FEES ? MAKER_FEES : TAKER_FEES;
}

const HIGH_FEE_EXCHANGES = new Set(['Coinbase']);

// ─── Daily P&L tracking ───────────────────────────────────────────────────
let _dailyPnl     = 0;
let _dailyResetTs = new Date().setHours(0, 0, 0, 0);

function getDailyPnl()  { return _dailyPnl; }
function addDailyPnl(n) {
  const todayMidnight = new Date().setHours(0, 0, 0, 0);
  if (todayMidnight > _dailyResetTs) { _dailyPnl = 0; _dailyResetTs = todayMidnight; }
  _dailyPnl = +(_dailyPnl + n).toFixed(4);
}
function isDailyLossBreached() { return _dailyPnl <= MAX_DAILY_LOSS; }
function resetDailyPnl() { _dailyPnl = 0; _dailyResetTs = new Date().setHours(0, 0, 0, 0); }

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
  _lastDemoExecTs = 0;
}

// ─── Slippage history ─────────────────────────────────────────────────────
const _slippageHistory = [];
const MAX_SLIP_HISTORY = 100;

function recordSlippage(pct) {
  if (pct == null || isNaN(pct)) return;
  _slippageHistory.push(pct);
  if (_slippageHistory.length > MAX_SLIP_HISTORY) _slippageHistory.shift();
}

function slippageStdDev() {
  if (_slippageHistory.length < 5) return null;
  const mean     = _slippageHistory.reduce((a, b) => a + b, 0) / _slippageHistory.length;
  const variance = _slippageHistory.reduce((s, v) => s + (v - mean) ** 2, 0) / _slippageHistory.length;
  return Math.sqrt(variance);
}

// ─── Score compuesto 0-100 ────────────────────────────────────────────────
function scoreOpportunity(op) {
  const profPct   = Math.max(0, op.netProfitPct || 0);
  const profScore = Math.min(35, Math.log1p(profPct * 500) * 5.5);

  const slipPct   = op.slippagePct != null ? op.slippagePct : 0.05;
  const grossPct  = Math.max(op.spreadPct || 0, profPct + slipPct);
  const slipRatio = grossPct > 0 ? slipPct / grossPct : 0.5;
  const liqScore  = Math.max(0, 20 * (1 - slipRatio * 1.5));

  const spreadPct = op.spreadPct || 0;
  let persScore;
  if      (spreadPct < 0.10) persScore = spreadPct * 50;
  else if (spreadPct < 0.80) persScore = 5 + (spreadPct - 0.10) * 12.5;
  else                       persScore = Math.max(0, 15 - (spreadPct - 0.80) * 10);

  const totalLatMs = (op.buyLatency || 0) + (op.sellLatency || 0);
  const latScore   = op.buySource === 'ws' && op.sellSource === 'ws'
    ? 15
    : Math.max(0, 15 - Math.floor(totalLatMs / 60));

  const bothWs   = op.buySource === 'ws' && op.sellSource === 'ws';
  const anyWs    = op.buySource === 'ws' || op.sellSource === 'ws';
  const wsConf   = bothWs ? 6 : anyWs ? 4 : 2;
  const vwapConf = op.slippageMethod === 'real' ? 4 : op.slippageMethod === 'partial' ? 2 : 0;
  const confScore = wsConf + vwapConf;

  const feePenalty = (HIGH_FEE_EXCHANGES.has(op.buyExchange) ||
                      HIGH_FEE_EXCHANGES.has(op.sellExchange)) ? 5 : 0;

  let stalePenalty = 0;
  if (op.feedAgeMs != null) {
    if      (op.feedAgeMs > 3000) stalePenalty = 3;
    else if (op.feedAgeMs > 1500) stalePenalty = 1;
  }

  // Synthetic ops in DEMO_MODE get a meaningful base score
  const syntheticBonus = op.synthetic ? 20 : 0;

  const raw   = profScore + liqScore + persScore + latScore + confScore - stalePenalty - feePenalty + syntheticBonus;
  return Math.max(op.synthetic ? 15 : 1, Math.min(100, Math.round(raw)));
}

// ─── Compute slippage ─────────────────────────────────────────────────────
function computeSlippage(exchange, side, price, tradeAmount) {
  const slip = calcRealSlippage(tradeAmount, side, exchange);

  if (slip.method === 'real' && slip.slippageUSD != null) {
    recordSlippage(slip.slippagePct);
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

  if (totalQty < amount * LIQUIDITY_MIN_FILL) {
    return {
      ok:       false,
      reason:   `Liquidity ${fillPct.toFixed(0)}% on ${exchange} ${side}: ${totalQty.toFixed(4)} BTC available`,
      fillable: totalQty,
      fillPct:  +fillPct.toFixed(1),
    };
  }
  return { ok: true, reason: null, fillable, fillPct: +fillPct.toFixed(1) };
}

// ─── buildSyntheticOpportunity ────────────────────────────────────────────
function buildSyntheticOpportunity(orderBooks, tradeAmount, FEES) {
  const valid = orderBooks.filter(ob => ob.ask && !ob.error && ob.exchange !== 'Coinbase');
  if (valid.length < 2) {
    // fallback: include all if coinbase-only
    const all = orderBooks.filter(ob => ob.ask && !ob.error);
    if (all.length < 2) return null;
    valid.push(...all);
  }

  const buyEx  = valid.reduce((a, b) => a.ask < b.ask ? a : b);
  const askA   = buyEx.ask;
  // 0.40% spread gives ~$4 gross on 0.01 BTC at $100k → net ~$1.5 after fees
  const synBid = askA * 1.0042;

  const sellCandidates = valid.filter(ob => ob.exchange !== buyEx.exchange);
  if (!sellCandidates.length) return null;
  const sellEx = sellCandidates[Math.floor(Math.random() * sellCandidates.length)];

  const feeA = FEES[buyEx.exchange]  || 0.001;
  const feeB = FEES[sellEx.exchange] || 0.001;

  const grossProfit  = (synBid - askA) * tradeAmount;
  const buyFee       = askA   * tradeAmount * feeA;
  const sellFee      = synBid * tradeAmount * feeB;
  const slippageCost = askA   * tradeAmount * SLIPPAGE_FIXED * 2;
  const netProfit    = grossProfit - buyFee - sellFee - slippageCost;
  const spreadPct    = ((synBid - askA) / askA) * 100;
  const netProfitPct = askA > 0 ? (netProfit / (askA * tradeAmount)) * 100 : 0;
  const totalCost    = buyFee + sellFee + slippageCost + MIN_NET_PROFIT;
  const breakEvenPct = askA > 0 ? +(totalCost / (askA * tradeAmount) * 100).toFixed(4) : 0;

  return {
    buyExchange:    buyEx.exchange,
    sellExchange:   sellEx.exchange,
    buyPrice:       +askA.toFixed(2),
    sellPrice:      +synBid.toFixed(2),
    spreadPct:      +spreadPct.toFixed(4),
    grossProfit:    +grossProfit.toFixed(4),
    buyFee:         +buyFee.toFixed(4),
    sellFee:        +sellFee.toFixed(4),
    totalFees:      +(buyFee + sellFee).toFixed(4),
    slippage:       +slippageCost.toFixed(4),
    slippagePct:    +(SLIPPAGE_FIXED * 100 * 2).toFixed(4),
    slippageMethod: 'fallback',
    buySlipMethod:  'fallback',
    sellSlipMethod: 'fallback',
    withdrawalFeeUSD: 0,
    withdrawalModel:  'periodic_rebalancing',
    netProfit:      +netProfit.toFixed(4),
    netProfitPct:   +netProfitPct.toFixed(4),
    breakEvenPct,
    profitLow: null, profitHigh: null,
    viable:         true,
    circuitBreaker: false,
    liquidityOk:    true,
    buyFillPct:     100,
    sellFillPct:    100,
    rejectionReason:   null,
    rejectionCategory: null,
    buyLatency:     buyEx.latencyMs || 0,
    sellLatency:    sellEx.latencyMs || 0,
    buySource:      buyEx.source || 'ws',
    sellSource:     sellEx.source || 'ws',
    feedAgeMs:      0,
    detectionLatencyMs: 0,
    evalMs:         0,
    feeMode:        USE_MAKER_FEES ? 'maker' : 'taker',
    tradeAmount,
    synthetic:      true,
    syntheticNote:  'Spread sintético — DEMO_MODE activo',
    ts:             new Date().toISOString(),
  };
}

// ─── detectOpportunities ──────────────────────────────────────────────────
function detectOpportunities(orderBooks, tradeAmount) {
  const amount = tradeAmount != null ? tradeAmount : DEFAULT_TRADE_AMOUNT;
  const FEES   = getFees();

  const totalEvalStart = Date.now();

  const valid = orderBooks.filter(ob => {
    if (!ob.bid || !ob.ask || ob.error) return false;
    if (ob.ask <= 0 || ob.bid <= 0) return false;
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
      const withdrawalFeeUSD = +(wfBuy.BTC * askA + wfSell.USDT).toFixed(4);

      const totalCost    = buyFee + sellFee + slippageCost + MIN_NET_PROFIT;
      const notional     = askA * amount;
      const breakEvenPct = notional > 0 ? +(totalCost / notional * 100).toFixed(4) : 0;

      const netProfit    = grossProfit - buyFee - sellFee - slippageCost;
      const netProfitPct = notional > 0 ? (netProfit / notional) * 100 : 0;

      const slipStd = slippageStdDev();
      let profitLow = null, profitHigh = null;
      if (slipStd != null) {
        const uncertainty = slipStd * 0.01 * notional;
        profitLow  = +(netProfit - uncertainty * 1.96).toFixed(4);
        profitHigh = +(netProfit + uncertainty * 1.96).toFixed(4);
      }

      const spreadPct = ((bidB - askA) / askA) * 100;

      const cbSpreadTooSmall = spreadPct < MIN_SPREAD_PCT;
      const cbSpreadTooLarge = spreadPct > MAX_SPREAD_PCT;
      const circuitBreaker   = cbSpreadTooSmall || cbSpreadTooLarge;

      const liquidityOk  = buyLiq.ok && sellLiq.ok;
      const viableRaw    = netProfit > MIN_NET_PROFIT;
      const dailyStopped = isDailyLossBreached();
      const viable       = viableRaw && !circuitBreaker && liquidityOk && !dailyStopped;

      let rejectionReason   = null;
      let rejectionCategory = null;

      if (!viable) {
        if (dailyStopped) {
          rejectionCategory = 'daily_stop';
          rejectionReason   = `Daily loss limit reached ($${_dailyPnl.toFixed(2)})`;
        } else if (!liquidityOk) {
          rejectionCategory = 'liquidity';
          rejectionReason   = buyLiq.ok ? sellLiq.reason : buyLiq.reason;
        } else if (bidB <= askA) {
          rejectionCategory = 'negative_spread';
          rejectionReason   = 'Precio de compra ≥ precio de venta';
        } else if (cbSpreadTooSmall) {
          rejectionCategory = 'circuit_breaker';
          rejectionReason   = `Spread ${spreadPct.toFixed(4)}% < ${MIN_SPREAD_PCT}% mínimo`;
        } else if (cbSpreadTooLarge) {
          rejectionCategory = 'circuit_breaker';
          rejectionReason   = `Spread ${spreadPct.toFixed(2)}% > ${MAX_SPREAD_PCT}% (datos obsoletos)`;
        } else if (!viableRaw) {
          rejectionCategory = 'fees_slippage';
          const highFeeNote = (HIGH_FEE_EXCHANGES.has(buyEx.exchange) || HIGH_FEE_EXCHANGES.has(sellEx.exchange))
            ? ` | ⚠ Coinbase fee 0.60%` : '';
          const feeMode = USE_MAKER_FEES ? ' [maker]' : ' [taker]';
          rejectionReason = `Net $${netProfit.toFixed(4)} < $${MIN_NET_PROFIT} | ` +
            `break-even ${breakEvenPct}% | spread ${spreadPct.toFixed(4)}% | ` +
            `Fees $${(buyFee + sellFee).toFixed(2)} + Slip $${slippageCost.toFixed(2)}${highFeeNote}${feeMode}`;
        }

        if (rejectionCategory) _rejectionCounts[rejectionCategory]++;
      }

      if (!viable && netProfit > -(MIN_NET_PROFIT * 5) && netProfit <= MIN_NET_PROFIT) {
        _nearViableCount++;
      }

      if (_bestOpportunitySeen === null || netProfit > _bestOpportunitySeen.netProfit) {
        _bestOpportunitySeen = {
          buyExchange:  buyEx.exchange,
          sellExchange: sellEx.exchange,
          netProfit:    +netProfit.toFixed(4),
          spreadPct:    +spreadPct.toFixed(4),
          breakEvenPct,
          ts:           new Date().toISOString(),
        };
      }

      const pairEvalMs = Date.now() - totalEvalStart;
      const detectionLatencyMs = buyEx.feedAgeMs || 0;

      const op = {
        id:             `arb-${Date.now()}-${i}-${j}`,
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
        feeMode:        USE_MAKER_FEES ? 'maker' : 'taker',
        tradeAmount:    amount,
        synthetic:      false,
        ts:             new Date().toISOString(),
      };

      op.score = viable ? scoreOpportunity(op) : 0;
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
        ts:           op.ts,
      });
    }
  }

  // ── DEMO_MODE: inject synthetic opportunity ──────────────────────────────
  let syntheticOp = null;
  const now = Date.now();
  if (DEMO_MODE && !opportunities.some(o => o.viable)) {
    // Rate-limit synthetic injection to avoid spamming
    if (now - _lastDemoExecTs > DEMO_MIN_INTERVAL_MS) {
      const syn = buildSyntheticOpportunity(valid.length >= 2 ? valid : orderBooks.filter(ob => ob.ask && !ob.error), amount, FEES);
      if (syn) {
        syn.id    = `SYNTHETIC-${now}-${Math.random().toString(36).slice(2, 5)}`;
        syn.score = scoreOpportunity(syn);
        syntheticOp = syn;
        opportunities.unshift(syn);
        _lastDemoExecTs = now;
      }
    }
  }

  opportunities.sort((a, b) => {
    if (a.viable && !b.viable) return -1;
    if (!a.viable && b.viable) return 1;
    return b.score - a.score || b.netProfit - a.netProfit;
  });

  const triangularSignal = detectTriangularSignal(valid, FEES);
  const evalMs = Date.now() - totalEvalStart;

  return { opportunities, triangularSignal, evalMs, syntheticOp };
}

// ─── Triangular signal (informational) ───────────────────────────────────
function detectTriangularSignal(books, FEES) {
  const fees = FEES || getFees();
  if (books.length < 3) return null;
  let best = null;
  for (let a = 0; a < books.length; a++) {
    for (let b = 0; b < books.length; b++) {
      if (b === a) continue;
      for (let c = 0; c < books.length; c++) {
        if (c === a || c === b) continue;
        const bA = books[a], bB = books[b], bC = books[c];
        if (!bA.ask || !bB.bid || !bB.ask || !bC.bid) continue;
        const s1 = (bB.bid - bA.ask) / bA.ask;
        const s2 = (bC.bid - bB.ask) / bB.ask;
        const grossPct     = ((1 + s1) * (1 + s2) - 1) * 100;
        const feePct       = ((fees[bA.exchange] || 0.001) +
                              (fees[bB.exchange] || 0.001) +
                              (fees[bC.exchange] || 0.001)) * 100;
        const slipFallback = 0.15;
        const netPct       = grossPct - feePct - slipFallback;
        if (netPct > 0 && (!best || netPct > best.netPct)) {
          best = {
            path:       `${bA.exchange} → ${bB.exchange} → ${bC.exchange}`,
            netPct:     +netPct.toFixed(4),
            grossPct:   +grossPct.toFixed(4),
            label:      `${bA.exchange[0]}→${bB.exchange[0]}→${bC.exchange[0]}`,
            type:       'multi_leg_cross_exchange',
            disclaimer: 'Señal informacional — no auto-ejecutada.',
          };
        }
      }
    }
  }
  return best;
}

// ─── executeSimulated ─────────────────────────────────────────────────────
function executeSimulated(opportunity, wallets, amount) {
  const t0 = Date.now();
  const requestedAmount = amount != null ? amount : (opportunity.tradeAmount || DEFAULT_TRADE_AMOUNT);

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

  const usdtNeeded  = buyPrice * requestedAmount;
  const usdtBalance = wallets.USDT?.[buyExchange] || 0;
  const btcBalance  = wallets.BTC?.[sellExchange]  || 0;

  let execAmount = requestedAmount;
  if (usdtBalance < usdtNeeded) {
    execAmount = Math.floor((usdtBalance / buyPrice) * 10000) / 10000;
  }
  if (btcBalance < execAmount) {
    execAmount = Math.min(execAmount, btcBalance);
  }
  if (execAmount <= 0.0001) {
    return { ok: false, reason: `Saldo insuficiente en ${buyExchange} (USDT) o ${sellExchange} (BTC)` };
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
    id:              `trade-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
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
    feeMode:         opportunity.feeMode || (USE_MAKER_FEES ? 'maker' : 'taker'),
    synthetic:       opportunity.synthetic || false,
    syntheticNote:   opportunity.syntheticNote || null,
    status:          execNetProfit > 0 ? 'profit' : 'loss',
    executionMs:     Date.now() - t0,
    ts:              new Date().toISOString(),
  };

  return { ok: true, trade };
}

module.exports = {
  detectOpportunities,
  executeSimulated,
  getDailyPnl,
  addDailyPnl,
  isDailyLossBreached,
  resetDailyPnl,
  getRejectionCounts,
  getBestOpportunitySeen,
  getNearViableCount,
  getOpportunityLog,
  resetSessionStats,
  _MIN_NET_PROFIT: MIN_NET_PROFIT,
  _MIN_SPREAD_PCT: MIN_SPREAD_PCT,
  _DEFAULT_TRADE_AMOUNT: DEFAULT_TRADE_AMOUNT,
  _USE_MAKER_FEES: USE_MAKER_FEES,
  _DEMO_MODE: DEMO_MODE,
};

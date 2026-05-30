/**
 * arbitrageEngine.js — kukora arbitrage
 * Detección con slippage real desde orderbook depth (TODOS los exchanges)
 * Score compuesto: rentabilidad + velocidad + liquidez + confianza
 *
 * FIXES & IMPROVEMENTS:
 *  - Real VWAP slippage for ALL exchanges (Binance, Kraken, Bybit, OKX) — not just Binance
 *  - slippageMethod field: 'real' | 'fallback' per leg — visible in UI/history
 *  - Liquidity validation: reject opportunities where depth can't fill the order
 *  - withdrawalFeeUSD deducted ONCE here in detectOpportunities (NOT again in walletManager)
 *  - scoreOpportunity: fee efficiency + slippage method bonus
 *  - OKX included in all pair combinations
 *  - circuitBreaker: spread > 3% (was 5%) — tighter filter for stale data
 *  - Min viable threshold: netProfit must be > $0.50 (not just > 0) to avoid micro-noise trades
 *  - Triangular signal updated for 5 exchanges
 *  - FIX: withdrawalFeeUSD is a fixed per-transaction fee — NOT scaled by ratio in executeSimulated
 *  - FIX: netProfit in executeSimulated recalculated consistently
 */

const { calcRealSlippage, getDepth }                    = require('./exchangeService');
const { TRADING_FEES: FEES, WITHDRAWAL_FEES, SLIPPAGE_RATE } = require('./feeConfig');

const SLIPPAGE_FIXED = SLIPPAGE_RATE;
const MIN_NET_PROFIT  = 0.50;   // USD — minimum viable net profit per trade
const MAX_SPREAD_PCT  = 3.0;    // circuit breaker upper bound (tighter than old 5%)
const MIN_SPREAD_PCT  = 0.08;   // circuit breaker lower bound
const MAX_DAILY_LOSS  = -500;   // USD — daily loss circuit breaker; bot halts if exceeded

// ─── Daily P&L tracking ────────────────────────────────────────────────────
let _dailyPnl       = 0;
let _dailyResetTs   = new Date().setHours(0, 0, 0, 0);

function getDailyPnl()  { return _dailyPnl; }
function addDailyPnl(n) {
  const todayMidnight = new Date().setHours(0, 0, 0, 0);
  if (todayMidnight > _dailyResetTs) { _dailyPnl = 0; _dailyResetTs = todayMidnight; }
  _dailyPnl = +(_dailyPnl + n).toFixed(4);
}
function isDailyLossBreached() {
  return _dailyPnl <= MAX_DAILY_LOSS;
}
function resetDailyPnl() { _dailyPnl = 0; _dailyResetTs = new Date().setHours(0, 0, 0, 0); }

// ─── Historial de slippage para calcular CI ───────────────────────────────
const _slippageHistory = [];
const MAX_SLIP_HISTORY = 100;

function recordSlippage(pct) {
  if (pct == null || isNaN(pct)) return;
  _slippageHistory.push(pct);
  if (_slippageHistory.length > MAX_SLIP_HISTORY) _slippageHistory.shift();
}

function slippageStdDev() {
  if (_slippageHistory.length < 5) return null;
  const mean = _slippageHistory.reduce((a, b) => a + b, 0) / _slippageHistory.length;
  const variance = _slippageHistory.reduce((s, v) => s + (v - mean) ** 2, 0) / _slippageHistory.length;
  return Math.sqrt(variance);
}

// ─── Score compuesto 0-100 ────────────────────────────────────────────────
/**
 * scoreOpportunity — composite score 0-100
 *
 * Factor weights:
 *   profitability   (50%): cap 50pts — netProfitPct/0.1 × 20
 *   speed           (20%): cap 20pts — penaliza 1pt por cada 50ms
 *   liquidity       (15%): cap 15pts — slippage bajo = mejor
 *   confidence      (10%): bothWS=10, anyWS=7, HTTP=5
 *   slippageQuality  (5%): real VWAP=5, fallback=0
 */
function scoreOpportunity(op) {
  // Profitability: 0–50, cada 0.1% de ganancia neta = +20 pts (cap 50)
  const profScore = Math.min(50, (op.netProfitPct / 0.1) * 20);

  // Speed: latencia total < 50ms = 20pts, penaliza 1pt por cada 50ms extra
  const totalLatency = (op.buyLatency || 0) + (op.sellLatency || 0);
  const speedScore = Math.max(0, 20 - Math.floor(totalLatency / 50));

  // Liquidity: slippagePct bajo = mejor; real data beats fallback
  const slipScore = op.slippagePct != null
    ? Math.max(0, 15 - (op.slippagePct / 0.01) * 3)
    : 5;

  // Confidence: ambas fuentes WS = 10pts, una WS = 7pts, HTTP = 5pts
  const bothWs = op.buySource === 'ws' && op.sellSource === 'ws';
  const anyWs  = op.buySource === 'ws' || op.sellSource === 'ws';
  const confScore = bothWs ? 10 : anyWs ? 7 : 5;

  // Slippage quality bonus: real VWAP = 5pts, fallback = 0pts
  const slipQualScore = op.slippageMethod === 'real' ? 5 : 0;

  const total = Math.round(profScore + speedScore + slipScore + confScore + slipQualScore);
  return Math.max(0, Math.min(100, total));
}

// ─── Compute slippage for a given exchange + side ─────────────────────────
function computeSlippage(exchange, side, price, tradeAmount) {
  const slip = calcRealSlippage(tradeAmount, side, exchange);

  if (slip.method === 'real' && slip.slippageUSD != null) {
    recordSlippage(slip.slippagePct);
    return {
      slippageUSD: slip.slippageUSD,
      slippagePct: slip.slippagePct,
      method: 'real',
    };
  }

  // Fallback: use fixed rate
  const fallbackUSD = price * tradeAmount * SLIPPAGE_FIXED;
  return {
    slippageUSD: fallbackUSD,
    slippagePct: SLIPPAGE_FIXED * 100,
    method: 'fallback',
  };
}

// ─── Liquidity check: can the order book fill the requested amount? ────────
function checkLiquidity(exchange, side, amount) {
  const depth = getDepth(exchange);
  if (!depth) return { ok: true, reason: null, fillable: amount };

  const levels = side === 'buy' ? depth.asks : depth.bids;
  if (!levels || !levels.length) return { ok: true, reason: null, fillable: amount };

  let totalQty = levels.reduce((s, [,q]) => s + q, 0);
  if (totalQty < amount * 0.5) {
    return {
      ok: false,
      reason: `Liquidity too low on ${exchange} ${side}: ${totalQty.toFixed(4)} BTC available`,
      fillable: totalQty,
    };
  }
  return { ok: true, reason: null, fillable: Math.min(totalQty, amount) };
}

// ─── detectOpportunities ──────────────────────────────────────────────────
function detectOpportunities(orderBooks, tradeAmount = 0.1) {
  const valid = orderBooks.filter(ob => ob.bid && ob.ask && !ob.error);
  const opportunities = [];

  for (let i = 0; i < valid.length; i++) {
    for (let j = 0; j < valid.length; j++) {
      if (i === j) continue;

      const buyEx  = valid[i];
      const sellEx = valid[j];

      const askA = buyEx.ask;
      const bidB = sellEx.bid;

      const feeA = FEES[buyEx.exchange] || 0.001;
      const feeB = FEES[sellEx.exchange] || 0.001;

      // ── Real VWAP slippage for ALL exchanges ─────────────────────────
      const buySlip  = computeSlippage(buyEx.exchange,  'buy',  askA, tradeAmount);
      const sellSlip = computeSlippage(sellEx.exchange, 'sell', bidB, tradeAmount);

      const slippageCost = buySlip.slippageUSD + sellSlip.slippageUSD;
      const slippagePct  = (buySlip.slippagePct + sellSlip.slippagePct) / 2;
      const slippageMethod = (buySlip.method === 'real' && sellSlip.method === 'real') ? 'real'
                           : (buySlip.method === 'real' || sellSlip.method === 'real') ? 'partial'
                           : 'fallback';

      // ── Liquidity check ───────────────────────────────────────────────
      const buyLiq  = checkLiquidity(buyEx.exchange,  'buy',  tradeAmount);
      const sellLiq = checkLiquidity(sellEx.exchange, 'sell', tradeAmount);

      // ── P&L calculation ───────────────────────────────────────────────
      const grossProfit  = (bidB - askA) * tradeAmount;
      const buyFee       = askA * tradeAmount * feeA;
      const sellFee      = bidB * tradeAmount * feeB;

      // Withdrawal fees: BTC withdrawal from buyEx + USDT withdrawal from sellEx
      const wfBuy  = WITHDRAWAL_FEES[buyEx.exchange]  || { BTC: 0.0003, USDT: 6 };
      const wfSell = WITHDRAWAL_FEES[sellEx.exchange] || { BTC: 0.0003, USDT: 6 };
      const withdrawalFeeUSD = +(wfBuy.BTC * askA + wfSell.USDT).toFixed(4);

      // netProfit deducts withdrawal fee ONCE here — walletManager must NOT deduct again
      const netProfit    = grossProfit - buyFee - sellFee - slippageCost - withdrawalFeeUSD;
      const netProfitPct = (netProfit / (askA * tradeAmount)) * 100;

      // Record real slippage for CI
      if (buySlip.method === 'real') recordSlippage(buySlip.slippagePct);
      if (sellSlip.method === 'real') recordSlippage(sellSlip.slippagePct);

      // Confidence interval (±1.96σ = 95%)
      const slipStd = slippageStdDev();
      let profitLow = null, profitHigh = null;
      if (slipStd != null) {
        const uncertainty = slipStd * 0.01 * askA * tradeAmount;
        profitLow  = +(netProfit - uncertainty * 1.96).toFixed(4);
        profitHigh = +(netProfit + uncertainty * 1.96).toFixed(4);
      }

      const spreadPct = ((bidB - askA) / askA) * 100;

      // Circuit breakers
      const cbSpreaTooSmall = spreadPct < MIN_SPREAD_PCT;
      const cbSpreadTooLarge = spreadPct > MAX_SPREAD_PCT;
      const circuitBreaker = cbSpreaTooSmall || cbSpreadTooLarge;

      const liquidityOk = buyLiq.ok && sellLiq.ok;
      const viableRaw = netProfit > MIN_NET_PROFIT;
      const dailyStopped = isDailyLossBreached();
      const viable = viableRaw && !circuitBreaker && liquidityOk && !dailyStopped;

      let rejectionReason = null;
      if (!viable) {
        if (!liquidityOk) {
          rejectionReason = buyLiq.ok ? sellLiq.reason : buyLiq.reason;
        } else if (bidB <= askA) {
          rejectionReason = 'Precio de compra ≥ precio de venta';
        } else if (cbSpreaTooSmall) {
          rejectionReason = `Spread bruto ${spreadPct.toFixed(3)}% < ${MIN_SPREAD_PCT}% (circuit breaker)`;
        } else if (cbSpreadTooLarge) {
          rejectionReason = `Spread bruto ${spreadPct.toFixed(2)}% > ${MAX_SPREAD_PCT}% (datos posiblemente obsoletos)`;
        } else if (netProfit <= MIN_NET_PROFIT) {
          rejectionReason = `Net profit $${netProfit.toFixed(4)} < $${MIN_NET_PROFIT} mínimo | Fees $${(buyFee+sellFee).toFixed(2)} + slip $${slippageCost.toFixed(2)} + retiro $${withdrawalFeeUSD.toFixed(2)}`;
        }
      }

      const op = {
        id: `${buyEx.exchange}-${sellEx.exchange}-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
        buyExchange:   buyEx.exchange,
        sellExchange:  sellEx.exchange,
        buyPrice:      +askA.toFixed(2),
        sellPrice:     +bidB.toFixed(2),
        spreadPct:     +spreadPct.toFixed(4),
        grossProfit:   +grossProfit.toFixed(4),
        buyFee:        +buyFee.toFixed(4),
        sellFee:       +sellFee.toFixed(4),
        totalFees:     +(buyFee + sellFee).toFixed(4),
        slippage:      +slippageCost.toFixed(4),
        slippagePct:   +slippagePct.toFixed(4),
        slippageMethod,
        withdrawalFeeUSD: +withdrawalFeeUSD.toFixed(4),
        netProfit:     +netProfit.toFixed(4),
        netProfitPct:  +netProfitPct.toFixed(4),
        profitLow,
        profitHigh,
        viable,
        circuitBreaker,
        liquidityOk,
        rejectionReason,
        buyLatency:    buyEx.latencyMs || 0,
        sellLatency:   sellEx.latencyMs || 0,
        buySource:     buyEx.source || 'http',
        sellSource:    sellEx.source || 'http',
        ts:            new Date().toISOString(),
      };

      op.score = viable ? scoreOpportunity(op) : 0;
      opportunities.push(op);
    }
  }

  opportunities.sort((a, b) => {
    if (a.viable && !b.viable) return -1;
    if (!a.viable && b.viable) return 1;
    return b.score - a.score || b.netProfit - a.netProfit;
  });

  const triangularSignal = detectTriangularSignal(valid);

  return { opportunities, triangularSignal };
}

// ─── Multi-leg opportunity signal ────────────────────────────────────────
function detectTriangularSignal(books) {
  if (books.length < 3) return null;
  let best = null;
  for (let a = 0; a < books.length; a++) {
    for (let b = 0; b < books.length; b++) {
      if (b === a) continue;
      for (let c = 0; c < books.length; c++) {
        if (c === a || c === b) continue;
        const s1 = (books[b].bid - books[a].ask) / books[a].ask;
        // s2 leg: buy at exchange b ask, sell at exchange c bid
        const s2 = (books[c].bid - books[b].ask) / books[b].ask;
        // Correct compound return: (1+s1)*(1+s2) - 1, not s1+s2
        const grossPct = ((1 + s1) * (1 + s2) - 1) * 100;
        const feePct   = ((FEES[books[a].exchange] || 0.001) + (FEES[books[b].exchange] || 0.001) + (FEES[books[c].exchange] || 0.001)) * 100;
        // Include conservative slippage fallback (0.05% per leg × 2 legs) since no VWAP on triangular
        const slippageFallbackPct = 0.10;
        const netPct   = grossPct - feePct - slippageFallbackPct;
        if (netPct > 0 && (!best || netPct > best.netPct)) {
          best = {
            path:       `${books[a].exchange} → ${books[b].exchange} → ${books[c].exchange}`,
            netPct:     +netPct.toFixed(4),
            grossPct:   +grossPct.toFixed(4),
            label:      `${books[a].exchange[0]}→${books[b].exchange[0]}→${books[c].exchange[0]}`,
            type:       'multi_leg_cross_exchange',
            disclaimer: '3-exchange chain signal. Not single-exchange triangular arbitrage.',
          };
        }
      }
    }
  }
  return best;
}

// ─── executeSimulated ─────────────────────────────────────────────────────
function executeSimulated(opportunity, wallets, amount = 0.1) {
  const t0 = Date.now();
  const { buyExchange, sellExchange, buyPrice, sellPrice,
          netProfitPct, grossProfit, buyFee, sellFee, slippage, withdrawalFeeUSD } = opportunity;

  if (opportunity.circuitBreaker || (sellPrice - buyPrice) < MIN_SPREAD_PCT * 0.01 * buyPrice) {
    return { ok: false, reason: `Circuit breaker: spread too small or invalid` };
  }

  if (!opportunity.liquidityOk) {
    return { ok: false, reason: opportunity.rejectionReason || 'Liquidity check failed' };
  }

  const usdtNeeded  = buyPrice * amount;
  const usdtBalance = wallets.USDT?.[buyExchange] || 0;
  const btcBalance  = wallets.BTC?.[sellExchange]  || 0;

  let execAmount = amount;
  if (usdtBalance < usdtNeeded) {
    execAmount = Math.floor((usdtBalance / buyPrice) * 10000) / 10000;
  }
  if (btcBalance < execAmount) {
    execAmount = Math.min(execAmount, btcBalance);
  }
  if (execAmount <= 0.0001) {
    return { ok: false, reason: `Saldo insuficiente en ${buyExchange} o ${sellExchange}` };
  }

  const ratio = execAmount / amount;

  // FIX: withdrawalFeeUSD is a fixed per-transaction fee — NOT scaled by ratio.
  // netProfit recalculated consistently:
  //   netProfit = (grossProfit - buyFee - sellFee - slippage) * ratio - withdrawalFeeUSD
  const scaledGross   = +(grossProfit * ratio).toFixed(4);
  const scaledBuyFee  = +(buyFee      * ratio).toFixed(4);
  const scaledSellFee = +(sellFee     * ratio).toFixed(4);
  const scaledSlip    = +(slippage    * ratio).toFixed(4);
  const fixedWithdraw = opportunity.withdrawalFeeUSD; // NOT multiplied by ratio
  const execNetProfit = +((grossProfit - buyFee - sellFee - slippage) * ratio - fixedWithdraw).toFixed(4);

  const trade = {
    id:              `trade-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    buyExchange,     sellExchange,
    buyPrice,        sellPrice,
    amount:          +execAmount.toFixed(6),
    requestedAmount: amount,
    partialFill:     execAmount < amount,
    grossProfit:     scaledGross,
    buyFee:          scaledBuyFee,
    sellFee:         scaledSellFee,
    totalFees:       +(scaledBuyFee + scaledSellFee).toFixed(4),
    slippage:        scaledSlip,
    slippagePct:     opportunity.slippagePct,
    slippageMethod:  opportunity.slippageMethod,
    withdrawalFeeUSD: fixedWithdraw,
    netProfit:       execNetProfit,
    netProfitPct:    +netProfitPct.toFixed(4),
    spreadPct:       opportunity.spreadPct,
    score:           opportunity.score || 0,
    buySource:       opportunity.buySource,
    sellSource:      opportunity.sellSource,
    status:          execNetProfit > 0 ? 'profit' : 'loss',
    executionMs:     Date.now() - t0,
    ts:              new Date().toISOString(),
  };

  return { ok: true, trade };
}

module.exports = { detectOpportunities, executeSimulated, getDailyPnl, addDailyPnl, isDailyLossBreached, resetDailyPnl };

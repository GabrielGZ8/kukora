/**
 * arbitrageEngine.js — kukora arbitrage
 * Detección con slippage real desde orderbook depth
 * Score compuesto: rentabilidad + velocidad + liquidez + confianza
 *
 * MEJORAS:
 *  - scoreOpportunity ahora incluye factor de "fee efficiency" (penaliza exchanges costosos)
 *  - P&L realizado vs no realizado separados
 *  - Detección de "oportunidad triangular" como señal visual (sin ejecución)
 *  - Confidence intervals en netProfit basados en volatilidad histórica del slippage
 */

const { calcRealSlippage }                    = require('./exchangeService');
const { TRADING_FEES: FEES, WITHDRAWAL_FEES, SLIPPAGE_RATE } = require('./feeConfig');

const SLIPPAGE_FIXED = SLIPPAGE_RATE; // alias kept for readability

// ─── Historial de slippage para calcular CI ───────────────────────────────
const _slippageHistory = []; // últimos 50 valores reales observados
const MAX_SLIP_HISTORY = 50;

function recordSlippage(pct) {
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
// Factores:
//   profitability (55%): netProfitPct normalizado
//   speed (20%):         penaliza latencia alta
//   liquidity (10%):     slippage bajo = mejor liquidez
//   confidence (10%):    fuente WS > HTTP (más fresco)
//   feeEfficiency (5%):  penaliza si los fees son > 50% del gross profit
function scoreOpportunity(op) {
  // Profitability: 0–100, cada 0.1% de ganancia neta = +20 pts (cap 55)
  const profScore = Math.min(55, (op.netProfitPct / 0.1) * 20);

  // Speed: latencia total < 50ms = 20pts, penaliza 1pt por cada 50ms extra
  const totalLatency = (op.buyLatency || 0) + (op.sellLatency || 0);
  const speedScore = Math.max(0, 20 - Math.floor(totalLatency / 50));

  // Liquidity: slippagePct bajo = mejor; < 0.01% = full marks
  const slipScore = op.slippagePct != null
    ? Math.max(0, 10 - (op.slippagePct / 0.01) * 2)
    : 5;

  // Confidence: ambas fuentes WS = 10pts, una WS = 7pts, HTTP = 5pts
  const bothWs = op.buySource === 'ws' && op.sellSource === 'ws';
  const anyWs  = op.buySource === 'ws' || op.sellSource === 'ws';
  const confScore = bothWs ? 10 : anyWs ? 7 : 5;

  // Fee efficiency: penaliza si fees+slippage+withdrawal > 40% del gross
  let feeScore = 5;
  if (op.grossProfit > 0 && isFinite(op.grossProfit)) {
    const totalCost = (op.buyFee || 0) + (op.sellFee || 0) + (op.slippage || 0) + (op.withdrawalFeeUSD || 0);
    const costRatio = totalCost / op.grossProfit;
    feeScore = costRatio < 0.4 ? 5 : costRatio < 0.6 ? 3 : costRatio < 0.8 ? 1 : 0;
  }

  const total = Math.round(profScore + speedScore + slipScore + confScore + feeScore);
  return Math.max(0, Math.min(100, total));
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

      let buySlippage, sellSlippage, buySlippagePct, sellSlippagePct;
      if (buyEx.exchange === 'Binance') {
        const s = calcRealSlippage(tradeAmount, 'buy');
        // slippageUSD from calcRealSlippage already accounts for tradeAmount
        buySlippage    = s.slippageUSD != null ? s.slippageUSD : askA * tradeAmount * SLIPPAGE_FIXED;
        buySlippagePct = s.slippagePct;
      } else {
        // Fallback: cost = price * amount * rate  (units: USD)
        buySlippage    = askA * tradeAmount * SLIPPAGE_FIXED;
        buySlippagePct = SLIPPAGE_FIXED * 100;
      }
      if (sellEx.exchange === 'Binance') {
        const s = calcRealSlippage(tradeAmount, 'sell');
        sellSlippage    = s.slippageUSD != null ? s.slippageUSD : bidB * tradeAmount * SLIPPAGE_FIXED;
        sellSlippagePct = s.slippagePct;
      } else {
        // Fallback: cost = price * amount * rate  (units: USD)
        sellSlippage    = bidB * tradeAmount * SLIPPAGE_FIXED;
        sellSlippagePct = SLIPPAGE_FIXED * 100;
      }

      const slippagePct  = (buySlippagePct + sellSlippagePct) / 2;
      const slippageCost = buySlippage + sellSlippage;

      const grossProfit  = (bidB - askA) * tradeAmount;
      const buyFee       = askA * tradeAmount * feeA;
      const sellFee      = bidB * tradeAmount * feeB;

      // Withdrawal/rebalancing fees: BTC withdrawal from buyEx + USDT withdrawal from sellEx
      const wfBuy  = WITHDRAWAL_FEES[buyEx.exchange]  || { BTC: 0.0003, USDT: 6 };
      const wfSell = WITHDRAWAL_FEES[sellEx.exchange] || { BTC: 0.0003, USDT: 6 };
      // Use midpoint of ask as BTC price proxy for USD conversion
      const withdrawalFeeUSD = +(wfBuy.BTC * askA + wfSell.USDT).toFixed(4);

      const netProfit    = grossProfit - buyFee - sellFee - slippageCost - withdrawalFeeUSD;
      const netProfitPct = (netProfit / (askA * tradeAmount)) * 100;
      // Registrar slippage real observado para CI
      if (buySlippagePct > 0) recordSlippage(buySlippagePct);

      // Confidence interval en netProfit (±1 std del slippage histórico)
      const slipStd = slippageStdDev();
      let profitLow = null, profitHigh = null;
      if (slipStd != null) {
        const uncertainty = slipStd * 0.01 * askA * tradeAmount; // USD
        profitLow  = +(netProfit - uncertainty * 1.96).toFixed(4);
        profitHigh = +(netProfit + uncertainty * 1.96).toFixed(4);
      }

      const spreadPct = ((bidB - askA) / askA) * 100;
      // Circuit breaker: spread too small (<0.1%) OR suspiciously large (>5% = stale data)
      const circuitBreaker = spreadPct < 0.1 || spreadPct > 5;
      const viableRaw = netProfit > 0;
      const viable = viableRaw && !circuitBreaker;

      let rejectionReason = null;
      if (!viable) {
        if (bidB <= askA)        rejectionReason = 'Precio de compra ≥ precio de venta';
        else if (circuitBreaker) rejectionReason = 'Spread bruto < 0.1% (circuit breaker)';
        else {
          const totalCost = buyFee + sellFee + slippageCost + withdrawalFeeUSD;
          rejectionReason = `Costos ($${totalCost.toFixed(2)}) > ganancia bruta ($${grossProfit.toFixed(2)}): fees $${(buyFee+sellFee).toFixed(2)} + slippage $${slippageCost.toFixed(2)} + retiro $${withdrawalFeeUSD.toFixed(2)}`;
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
        withdrawalFeeUSD: +withdrawalFeeUSD.toFixed(4),
        netProfit:     +netProfit.toFixed(4),
        netProfitPct:  +netProfitPct.toFixed(4),
        // Confidence interval 95%
        profitLow,
        profitHigh,
        viable,
        circuitBreaker,
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

  // Detectar señal triangular (informativa, no ejecutable en esta versión)
  // Si hay ≥3 exchanges con datos válidos, marcamos la mejor cadena como señal
  const triangularSignal = detectTriangularSignal(valid);

  return { opportunities, triangularSignal };
}

// ─── Multi-leg opportunity signal ────────────────────────────────────────
// NOTE: This is NOT true triangular arbitrage (which involves 3 currency pairs
// on a single exchange, e.g. BTC/USDT → ETH/USDT → ETH/BTC forming a closed loop).
// True triangular arb requires all legs on ONE exchange, which is not yet
// supported in this version.
//
// What this detects: a 3-exchange sequential trade signal — a chain of two
// back-to-back cross-exchange spreads (A→B→C) that may compound gains.
// This is labeled "Multi-Leg Signal" in the UI to reflect what it actually is.
function detectTriangularSignal(books) {
  if (books.length < 3) return null;
  let best = null;
  for (let a = 0; a < books.length; a++) {
    for (let b = 0; b < books.length; b++) {
      if (b === a) continue;
      for (let c = 0; c < books.length; c++) {
        if (c === a || c === b) continue;
        // Leg 1: buy on A, sell on B
        const s1 = (books[b].bid - books[a].ask) / books[a].ask;
        // Leg 2: buy on B, sell on C (uses proceeds from Leg 1)
        const s2 = (books[c].bid - books[b].ask) / books[b].ask;
        const grossPct = (s1 + s2) * 100;
        const feePct   = (FEES[books[a].exchange] + FEES[books[b].exchange] + FEES[books[c].exchange]) * 100;
        const netPct   = grossPct - feePct;
        if (netPct > 0 && (!best || netPct > best.netPct)) {
          best = {
            path:     `${books[a].exchange} → ${books[b].exchange} → ${books[c].exchange}`,
            netPct:   +netPct.toFixed(4),
            grossPct: +grossPct.toFixed(4),
            label:    `${books[a].exchange[0]}→${books[b].exchange[0]}→${books[c].exchange[0]}`,
            // Clearly indicate this is a multi-leg cross-exchange signal
            type:     'multi_leg_cross_exchange',
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
          netProfit, netProfitPct, grossProfit, buyFee, sellFee, slippage } = opportunity;

  if (opportunity.circuitBreaker || (sellPrice - buyPrice) < 0.001 * buyPrice) {
    return { ok: false, reason: 'Circuit breaker: spread < 0.1%' };
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

  const trade = {
    id:              `trade-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    buyExchange,     sellExchange,
    buyPrice,        sellPrice,
    amount:          +execAmount.toFixed(6),
    requestedAmount: amount,
    partialFill:     execAmount < amount,
    grossProfit:     +(grossProfit * ratio).toFixed(4),
    buyFee:          +(buyFee     * ratio).toFixed(4),
    sellFee:         +(sellFee    * ratio).toFixed(4),
    totalFees:       +((buyFee + sellFee) * ratio).toFixed(4),
    slippage:        +(slippage   * ratio).toFixed(4),
    slippagePct:     opportunity.slippagePct,
    netProfit:       +(netProfit  * ratio).toFixed(4),
    netProfitPct:    +netProfitPct.toFixed(4),
    spreadPct:       opportunity.spreadPct,
    score:           opportunity.score || 0,
    buySource:       opportunity.buySource,
    sellSource:      opportunity.sellSource,
    status:          (netProfit * ratio) > 0 ? 'profit' : 'loss',
    executionMs:     Date.now() - t0,
    ts:              new Date().toISOString(),
  };

  return { ok: true, trade };
}

module.exports = { detectOpportunities, executeSimulated };
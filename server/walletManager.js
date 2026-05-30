/**
 * walletManager.js — kukora arbitrage
 * Gestiona saldos simulados por exchange
 * Persistencia en memoria + MongoDB opcional
 *
 * FIXES:
 *  - applyTrade does NOT deduct withdrawal fees from P&L
 *    (pre-funded bilateral model: withdrawal = periodic rebalancing cost, not per-trade)
 *  - withdrawalFeeUSD stored as informational field only
 *  - getPnL includes rebalancingCostEstimate
 *  - Balance validation with rollback on integrity failure
 *  - Negative balances rejected, not silently clamped
 */

const mongoose = require('mongoose');
const { WITHDRAWAL_FEES } = require('./feeConfig');

const ArbitrageOpSchema = new mongoose.Schema({
  buyExchange:    String,
  sellExchange:   String,
  buyPrice:       Number,
  sellPrice:      Number,
  amount:         Number,
  grossProfit:    Number,
  netProfit:      Number,
  netProfitPct:   Number,
  fees:           Number,
  slippage:       Number,
  withdrawalFees: Number,
  spreadPct:      String,
  status:         String,
  partialFill:    Boolean,
  executionMs:    Number,
  slippageMethod: String,
  rejectionReason: String,
  ts:             { type: Date, default: Date.now },
});

let ArbitrageOp;
try {
  ArbitrageOp = mongoose.model('ArbitrageOp');
} catch {
  ArbitrageOp = mongoose.model('ArbitrageOp', ArbitrageOpSchema);
}

// Default wallets sized for 0.05 BTC trades at up to $110k/BTC:
//   USDT: $110,000 per exchange → covers ~20 consecutive buys before rebalancing needed
//   BTC:  1 BTC per exchange → covers ~20 sells at 0.05 BTC per trade
// Both configurable via environment variables.
const INITIAL_BALANCES = {
  BTC: {
    Binance:  parseFloat(process.env.WALLET_BTC  || '1'),
    Kraken:   parseFloat(process.env.WALLET_BTC  || '1'),
    Bybit:    parseFloat(process.env.WALLET_BTC  || '1'),
    Coinbase: parseFloat(process.env.WALLET_BTC  || '1'),
    OKX:      parseFloat(process.env.WALLET_BTC  || '1'),
  },
  USDT: {
    Binance:  parseFloat(process.env.WALLET_USDT || '110000'),
    Kraken:   parseFloat(process.env.WALLET_USDT || '110000'),
    Bybit:    parseFloat(process.env.WALLET_USDT || '110000'),
    Coinbase: parseFloat(process.env.WALLET_USDT || '110000'),
    OKX:      parseFloat(process.env.WALLET_USDT || '110000'),
  },
};

const EXCHANGES = Object.keys(INITIAL_BALANCES.BTC);

let wallets = JSON.parse(JSON.stringify(INITIAL_BALANCES));
let tradeHistory = [];

function getBalances() {
  return JSON.parse(JSON.stringify(wallets));
}

/**
 * calcWithdrawalFee — computes periodic rebalancing cost (informational only)
 * Not deducted per trade in pre-funded bilateral model
 */
function calcWithdrawalFee(buyExchange, sellExchange, amount, buyPrice) {
  const buyFee  = WITHDRAWAL_FEES[buyExchange]  || { BTC: 0.0003, USDT: 6 };
  const sellFee = WITHDRAWAL_FEES[sellExchange] || { BTC: 0.0003, USDT: 6 };
  const btcWithdrawal  = buyFee.BTC * buyPrice;
  const usdtWithdrawal = sellFee.USDT;
  return {
    btcWithdrawalUSD:  +btcWithdrawal.toFixed(4),
    usdtWithdrawalUSD: +usdtWithdrawal.toFixed(4),
    totalUSD:          +(btcWithdrawal + usdtWithdrawal).toFixed(4),
  };
}

/**
 * applyTrade — validates balances BEFORE execution, rejects if insufficient.
 *
 * IMPORTANT: Pre-funded bilateral model — withdrawal fees are NOT deducted per trade.
 * trade.netProfit is already calculated without withdrawal fees in arbitrageEngine.js.
 * withdrawalFeeUSD is stored as informational field only.
 */
async function applyTrade(trade) {
  const { buyExchange, sellExchange, amount, buyPrice, sellPrice, buyFee, sellFee } = trade;

  const usdtCost  = buyPrice * amount + (buyFee || 0);
  const btcNeeded = amount;

  const usdtAvailable = wallets.USDT[buyExchange];
  const btcAvailable  = wallets.BTC[sellExchange];

  if (usdtAvailable === undefined) {
    const reason = `Unknown exchange for USDT wallet: ${buyExchange}`;
    console.warn('[walletManager] REJECTED:', reason);
    return { ok: false, reason };
  }
  if (btcAvailable === undefined) {
    const reason = `Unknown exchange for BTC wallet: ${sellExchange}`;
    console.warn('[walletManager] REJECTED:', reason);
    return { ok: false, reason };
  }
  if (usdtAvailable < usdtCost) {
    const reason = `Insufficient USDT on ${buyExchange}: need $${usdtCost.toFixed(2)}, have $${usdtAvailable.toFixed(2)}`;
    console.warn('[walletManager] REJECTED:', reason);
    return { ok: false, reason };
  }
  if (btcAvailable < btcNeeded) {
    const reason = `Insufficient BTC on ${sellExchange}: need ${btcNeeded.toFixed(6)}, have ${btcAvailable.toFixed(6)}`;
    console.warn('[walletManager] REJECTED:', reason);
    return { ok: false, reason };
  }

  // Informational only — not deducted from balances or P&L
  const wf = calcWithdrawalFee(buyExchange, sellExchange, amount, buyPrice);

  const usdtGain = sellPrice * amount - (sellFee || 0);

  wallets.USDT[buyExchange]  -= usdtCost;
  wallets.BTC[buyExchange]   += amount;
  wallets.BTC[sellExchange]  -= amount;
  wallets.USDT[sellExchange] += usdtGain;

  for (const ex of EXCHANGES) {
    if ((wallets.USDT[ex] !== undefined && wallets.USDT[ex] < -0.01) ||
        (wallets.BTC[ex]  !== undefined && wallets.BTC[ex]  < -0.000001)) {
      console.error(`[walletManager] CRITICAL: negative balance on ${ex} after trade ${trade.id} — rolling back`);
      wallets.USDT[buyExchange]  += usdtCost;
      wallets.BTC[buyExchange]   -= amount;
      wallets.BTC[sellExchange]  += amount;
      wallets.USDT[sellExchange] -= usdtGain;
      return { ok: false, reason: `Post-execution balance integrity failure on ${ex}` };
    }
  }

  const finalNetProfit    = +(trade.netProfit || 0).toFixed(4);
  const finalNetProfitPct = +((finalNetProfit / (buyPrice * amount)) * 100).toFixed(4);

  const enrichedTrade = {
    ...trade,
    netProfit:        finalNetProfit,
    netProfitPct:     finalNetProfitPct,
    // Informational only — reflects periodic rebalancing estimate, not per-trade cost
    withdrawalFees:   trade.withdrawalFeeUSD || 0,
    withdrawalDetail: wf,
    withdrawalModel:  'periodic_rebalancing',
    status:           finalNetProfit > 0 ? 'profit' : 'loss',
    balancesAfter:    getBalances(),
  };

  tradeHistory.push(enrichedTrade);

  if (mongoose.connection.readyState === 1) {
    try {
      await ArbitrageOp.create({
        buyExchange:    trade.buyExchange,
        sellExchange:   trade.sellExchange,
        buyPrice:       trade.buyPrice,
        sellPrice:      trade.sellPrice,
        amount:         trade.amount,
        grossProfit:    trade.grossProfit,
        netProfit:      finalNetProfit,
        netProfitPct:   finalNetProfitPct,
        fees:           (trade.buyFee || 0) + (trade.sellFee || 0),
        slippage:       trade.slippage,
        withdrawalFees: trade.withdrawalFeeUSD || 0,
        spreadPct:      trade.spreadPct,
        status:         enrichedTrade.status,
        partialFill:    trade.partialFill,
        executionMs:    trade.executionMs,
        slippageMethod: trade.slippageMethod,
        ts:             new Date(trade.ts),
      });
    } catch (e) {
      console.warn('⚠ ArbitrageOp MongoDB error:', e.message);
    }
  }

  return { ok: true, trade: enrichedTrade };
}

function resetBalances() {
  wallets = JSON.parse(JSON.stringify(INITIAL_BALANCES));
  tradeHistory = [];
}

function getTradeHistory() {
  return [...tradeHistory];
}

/**
 * getPnL — returns realized and unrealized P&L.
 * Includes rebalancingCostEstimate for informational display.
 */
function getPnL(currentBtcPrice = null) {
  if (!tradeHistory.length) {
    return {
      totalPnl: 0, realizedPnl: 0, unrealizedPnl: 0,
      totalTrades: 0, winRate: 0,
      bestTrade: null, worstTrade: null,
      avgExecutionMs: 0, maxDrawdown: 0,
      currentStreak: 0, currentStreakType: null,
      avgNetProfitPct: 0, totalFees: 0, totalWithdrawalFees: 0,
      slippageMethodBreakdown: {},
      rebalancingCostEstimate: 0,
    };
  }

  const wins    = tradeHistory.filter(t => (t.netProfit || 0) > 0);
  const losses  = tradeHistory.filter(t => (t.netProfit || 0) <= 0);
  const realizedPnl = tradeHistory.reduce((s, t) => s + (t.netProfit || 0), 0);
  const winRate  = (wins.length / tradeHistory.length) * 100;

  let unrealizedPnl = 0;
  if (currentBtcPrice != null && currentBtcPrice > 0) {
    const totalCurrentBtc = EXCHANGES.reduce((s, ex) => s + (wallets.BTC[ex] || 0), 0);
    const totalInitialBtc = EXCHANGES.reduce((s, ex) => s + (INITIAL_BALANCES.BTC[ex] || 0), 0);
    unrealizedPnl = (totalCurrentBtc - totalInitialBtc) * currentBtcPrice;
  }

  const totalPnl = realizedPnl + unrealizedPnl;

  let peak = 0, cum = 0, maxDrawdown = 0;
  for (const t of tradeHistory) {
    cum += t.netProfit || 0;
    if (cum > peak) peak = cum;
    const dd = peak > 0 ? ((peak - cum) / peak) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  let currentStreak = 0, currentStreakType = null;
  for (let i = tradeHistory.length - 1; i >= 0; i--) {
    const isWin = (tradeHistory[i].netProfit || 0) > 0;
    const type  = isWin ? 'win' : 'loss';
    if (currentStreakType === null) { currentStreakType = type; currentStreak = 1; }
    else if (type === currentStreakType) currentStreak++;
    else break;
  }

  const sorted          = [...tradeHistory].sort((a, b) => (b.netProfit||0) - (a.netProfit||0));
  const avgExecutionMs  = tradeHistory.reduce((s, t) => s + (t.executionMs || 0), 0) / tradeHistory.length;
  const avgNetProfitPct = tradeHistory.reduce((s, t) => s + (t.netProfitPct || 0), 0) / tradeHistory.length;
  const totalFees       = tradeHistory.reduce((s, t) => s + (t.totalFees || (t.buyFee||0) + (t.sellFee||0)), 0);
  const totalWithdrawalFees = tradeHistory.reduce((s, t) => s + (t.withdrawalFees || 0), 0);

  // Rebalancing cost estimate: ~$30 per round, 1 round per 50 trades
  const tradesCount = tradeHistory.length;
  const rebalancingRounds = Math.max(1, Math.ceil(tradesCount / 50));
  const rebalancingCostEstimate = +(rebalancingRounds * 30).toFixed(2);

  const slippageMethodBreakdown = { real: 0, fallback: 0 };
  tradeHistory.forEach(t => {
    if (t.slippageMethod === 'real') slippageMethodBreakdown.real++;
    else slippageMethodBreakdown.fallback++;
  });

  const pairStats = {};
  tradeHistory.forEach(t => {
    const key = `${t.buyExchange}→${t.sellExchange}`;
    if (!pairStats[key]) pairStats[key] = { count: 0, totalPnl: 0, wins: 0, totalFees: 0, totalWithdrawalFees: 0 };
    pairStats[key].count++;
    pairStats[key].totalPnl += t.netProfit || 0;
    pairStats[key].totalFees += (t.totalFees || (t.buyFee||0) + (t.sellFee||0));
    pairStats[key].totalWithdrawalFees = (pairStats[key].totalWithdrawalFees || 0) + (t.withdrawalFees || 0);
    if ((t.netProfit || 0) > 0) pairStats[key].wins++;
  });

  return {
    totalPnl:             +totalPnl.toFixed(4),
    realizedPnl:          +realizedPnl.toFixed(4),
    unrealizedPnl:        +unrealizedPnl.toFixed(4),
    totalTrades:          tradeHistory.length,
    wins:                 wins.length,
    losses:               losses.length,
    winRate:              +winRate.toFixed(1),
    bestTrade:            sorted[0] || null,
    worstTrade:           sorted[sorted.length - 1] || null,
    avgExecutionMs:       +avgExecutionMs.toFixed(1),
    maxDrawdown:          +maxDrawdown.toFixed(2),
    currentStreak,
    currentStreakType,
    avgNetProfitPct:      +avgNetProfitPct.toFixed(4),
    totalFees:            +totalFees.toFixed(4),
    totalWithdrawalFees:  +totalWithdrawalFees.toFixed(4),
    slippageMethodBreakdown,
    pairStats,
    rebalancingCostEstimate,
  };
}

module.exports = {
  getBalances,
  applyTrade,
  resetBalances,
  getTradeHistory,
  getPnL,
  ArbitrageOp,
  WITHDRAWAL_FEES,
  calcWithdrawalFee,
  EXCHANGES,
};

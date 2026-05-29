/**
 * walletManager.js — kukora arbitrage
 * Gestiona saldos simulados por exchange
 * Persistencia en memoria + MongoDB opcional
 *
 * MEJORAS:
 *  - P&L realizado vs no-realizado separados
 *  - Drawdown máximo del equity curve
 *  - Avg execution time
 *  - Streak de wins/losses consecutivos
 */

const mongoose = require('mongoose');

const ArbitrageOpSchema = new mongoose.Schema({
  buyExchange:   String,
  sellExchange:  String,
  buyPrice:      Number,
  sellPrice:     Number,
  amount:        Number,
  grossProfit:   Number,
  netProfit:     Number,
  netProfitPct:  Number,
  fees:          Number,
  slippage:      Number,
  spreadPct:     Number,
  status:        String,
  partialFill:   Boolean,
  executionMs:   Number,
  ts:            { type: Date, default: Date.now },
});

let ArbitrageOp;
try {
  ArbitrageOp = mongoose.model('ArbitrageOp');
} catch {
  ArbitrageOp = mongoose.model('ArbitrageOp', ArbitrageOpSchema);
}

const INITIAL_BALANCES = {
  BTC: {
    Binance:  parseFloat(process.env.WALLET_BTC  || '1'),
    Kraken:   parseFloat(process.env.WALLET_BTC  || '1'),
    Bybit:    parseFloat(process.env.WALLET_BTC  || '1'),
    Coinbase: parseFloat(process.env.WALLET_BTC  || '1'),
  },
  USDT: {
    Binance:  parseFloat(process.env.WALLET_USDT || '70000'),
    Kraken:   parseFloat(process.env.WALLET_USDT || '70000'),
    Bybit:    parseFloat(process.env.WALLET_USDT || '70000'),
    Coinbase: parseFloat(process.env.WALLET_USDT || '70000'),
  },
};

let wallets = JSON.parse(JSON.stringify(INITIAL_BALANCES));
let tradeHistory = [];

function getBalances() {
  return JSON.parse(JSON.stringify(wallets));
}

async function applyTrade(trade) {
  const { buyExchange, sellExchange, amount, buyPrice, sellPrice, buyFee, sellFee } = trade;

  const usdtCost = buyPrice * amount + (buyFee || 0);
  const usdtGain = sellPrice * amount - (sellFee || 0);

  if (wallets.USDT[buyExchange]  !== undefined) wallets.USDT[buyExchange]  -= usdtCost;
  if (wallets.BTC[buyExchange]   !== undefined) wallets.BTC[buyExchange]   += amount;
  if (wallets.BTC[sellExchange]  !== undefined) wallets.BTC[sellExchange]  -= amount;
  if (wallets.USDT[sellExchange] !== undefined) wallets.USDT[sellExchange] += usdtGain;

  ['Binance','Kraken','Bybit','Coinbase'].forEach(ex => {
    if (wallets.USDT[ex] < 0) wallets.USDT[ex] = 0;
    if (wallets.BTC[ex]  < 0) wallets.BTC[ex]  = 0;
  });

  tradeHistory.push({ ...trade, balancesAfter: getBalances() });

  if (mongoose.connection.readyState === 1) {
    try {
      await ArbitrageOp.create({
        buyExchange:  trade.buyExchange,
        sellExchange: trade.sellExchange,
        buyPrice:     trade.buyPrice,
        sellPrice:    trade.sellPrice,
        amount:       trade.amount,
        grossProfit:  trade.grossProfit,
        netProfit:    trade.netProfit,
        netProfitPct: trade.netProfitPct,
        fees:         (trade.buyFee || 0) + (trade.sellFee || 0),
        slippage:     trade.slippage,
        spreadPct:    trade.spreadPct,
        status:       trade.status,
        partialFill:  trade.partialFill,
        executionMs:  trade.executionMs,
        ts:           new Date(trade.ts),
      });
    } catch (e) {
      console.warn('⚠ ArbitrageOp MongoDB error:', e.message);
    }
  }
}

function resetBalances() {
  wallets = JSON.parse(JSON.stringify(INITIAL_BALANCES));
  tradeHistory = [];
}

function getTradeHistory() {
  return [...tradeHistory];
}

function getPnL() {
  if (!tradeHistory.length) {
    return {
      totalPnl: 0, realizedPnl: 0, unrealizedPnl: 0,
      totalTrades: 0, winRate: 0,
      bestTrade: null, worstTrade: null,
      avgExecutionMs: 0, maxDrawdown: 0,
      currentStreak: 0, currentStreakType: null,
      avgNetProfitPct: 0, totalFees: 0,
    };
  }

  const wins    = tradeHistory.filter(t => (t.netProfit || 0) > 0);
  const losses  = tradeHistory.filter(t => (t.netProfit || 0) <= 0);
  const totalPnl = tradeHistory.reduce((s, t) => s + (t.netProfit || 0), 0);
  const winRate  = (wins.length / tradeHistory.length) * 100;

  // P&L realizado = todos los trades cerrados (en simulación todos son realizados)
  const realizedPnl = totalPnl;
  // Unrealized = diferencia hipotética si hubiera abierto posiciones largas (simplificado: 0 en bot de arb)
  const unrealizedPnl = 0;

  // Max drawdown del equity curve
  let peak = 0, cum = 0, maxDrawdown = 0;
  for (const t of tradeHistory) {
    cum += t.netProfit || 0;
    if (cum > peak) peak = cum;
    const dd = peak > 0 ? ((peak - cum) / peak) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Streak actual
  let currentStreak = 0, currentStreakType = null;
  for (let i = tradeHistory.length - 1; i >= 0; i--) {
    const isWin = (tradeHistory[i].netProfit || 0) > 0;
    const type  = isWin ? 'win' : 'loss';
    if (currentStreakType === null) { currentStreakType = type; currentStreak = 1; }
    else if (type === currentStreakType) currentStreak++;
    else break;
  }

  const sorted = [...tradeHistory].sort((a, b) => (b.netProfit||0) - (a.netProfit||0));
  const avgExecutionMs = tradeHistory.reduce((s, t) => s + (t.executionMs || 0), 0) / tradeHistory.length;
  const avgNetProfitPct = tradeHistory.reduce((s, t) => s + (t.netProfitPct || 0), 0) / tradeHistory.length;
  const totalFees = tradeHistory.reduce((s, t) => s + (t.totalFees || (t.buyFee||0) + (t.sellFee||0)), 0);

  // Pair breakdown
  const pairStats = {};
  tradeHistory.forEach(t => {
    const key = `${t.buyExchange}→${t.sellExchange}`;
    if (!pairStats[key]) pairStats[key] = { count: 0, totalPnl: 0, wins: 0, totalFees: 0 };
    pairStats[key].count++;
    pairStats[key].totalPnl += t.netProfit || 0;
    pairStats[key].totalFees += t.totalFees || 0;
    if ((t.netProfit || 0) > 0) pairStats[key].wins++;
  });

  return {
    totalPnl:        +totalPnl.toFixed(4),
    realizedPnl:     +realizedPnl.toFixed(4),
    unrealizedPnl:   +unrealizedPnl.toFixed(4),
    totalTrades:     tradeHistory.length,
    wins:            wins.length,
    losses:          losses.length,
    winRate:         +winRate.toFixed(1),
    bestTrade:       sorted[0] || null,
    worstTrade:      sorted[sorted.length - 1] || null,
    avgExecutionMs:  +avgExecutionMs.toFixed(1),
    maxDrawdown:     +maxDrawdown.toFixed(2),
    currentStreak,
    currentStreakType,
    avgNetProfitPct: +avgNetProfitPct.toFixed(4),
    totalFees:       +totalFees.toFixed(4),
    pairStats,
  };
}

module.exports = {
  getBalances,
  applyTrade,
  resetBalances,
  getTradeHistory,
  getPnL,
  ArbitrageOp,
};

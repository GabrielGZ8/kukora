// ─── backtestEngine.js — simulador de estrategias sobre datos históricos ──
const { sma: calcSma, rsi: calcRsi, bollingerBands } = require('./quant');
const { stdDev, percentageChange, clean, drawdown, sharpe } = require('./analytics');

// Métricas comunes de un conjunto de trades y equity curve
const calcMetrics = (trades, equity, prices) => {
  if (trades.length === 0) {
    return { totalReturn: 0, winRate: 0, maxDrawdown: 0, sharpeRatio: 0, totalTrades: 0 };
  }
  const wins = trades.filter(t => t.pnlPct > 0).length;
  const finalValue = equity[equity.length - 1];
  const initialValue = equity[0];
  const totalReturn = +((finalValue - initialValue) / initialValue * 100).toFixed(2);
  const winRate = +(wins / trades.length * 100).toFixed(1);

  // Max drawdown en equity curve
  let peak = equity[0], maxDd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak * 100;
    if (dd > maxDd) maxDd = dd;
  }

  // Sharpe aproximado con retornos diarios de equity
  const returns = [];
  for (let i = 1; i < equity.length; i++) {
    returns.push((equity[i] - equity[i - 1]) / equity[i - 1] * 100);
  }
  const meanR = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
  const stdR  = stdDev(returns) || 1;
  const sharpeRatio = +(meanR / stdR * Math.sqrt(365)).toFixed(3);

  return {
    totalReturn,
    winRate,
    maxDrawdown: +maxDd.toFixed(2),
    sharpeRatio,
    totalTrades: trades.length,
  };
};

// ── Estrategia 1: SMA Crossover ───────────────────────────────────────────
const smaCrossover = (prices, shortP = 10, longP = 30) => {
  const shortSma = calcSma(prices, shortP);
  const longSma  = calcSma(prices, longP);
  const capital = 10000;
  let cash = capital, position = 0, entryPrice = 0, entryIdx = 0;
  const trades = [], equity = [];

  for (let i = 0; i < prices.length; i++) {
    const s = shortSma[i], l = longSma[i];
    const sPrev = shortSma[i - 1], lPrev = longSma[i - 1];
    const price = prices[i];

    if (s != null && l != null && sPrev != null && lPrev != null) {
      // Señal de compra: cruce alcista
      if (position === 0 && sPrev <= lPrev && s > l) {
        position = cash / price;
        entryPrice = price;
        entryIdx = i;
        cash = 0;
      }
      // Señal de venta: cruce bajista
      else if (position > 0 && sPrev >= lPrev && s < l) {
        const exitValue = position * price;
        const pnlPct = +((price - entryPrice) / entryPrice * 100).toFixed(2);
        trades.push({ entry: entryPrice, exit: price, entryIdx, exitIdx: i, pnlPct, duration: i - entryIdx });
        cash = exitValue;
        position = 0;
      }
    }
    equity.push(cash + position * price);
  }

  // Cerrar posición abierta al final
  if (position > 0) {
    const price = prices[prices.length - 1];
    const pnlPct = +((price - entryPrice) / entryPrice * 100).toFixed(2);
    trades.push({ entry: entryPrice, exit: price, entryIdx, exitIdx: prices.length - 1, pnlPct, duration: prices.length - 1 - entryIdx, open: true });
    equity[equity.length - 1] = cash + position * price;
  }

  return { strategy: 'SMA Crossover', params: { shortP, longP }, trades, equity, ...calcMetrics(trades, equity, prices) };
};

// ── Estrategia 2: RSI Mean Reversion ─────────────────────────────────────
const rsiMeanReversion = (prices, period = 14, oversold = 30, overbought = 70) => {
  const rsiVals = calcRsi(prices, period);
  const capital = 10000;
  let cash = capital, position = 0, entryPrice = 0, entryIdx = 0;
  const trades = [], equity = [];

  for (let i = 0; i < prices.length; i++) {
    const r = rsiVals[i], rPrev = rsiVals[i - 1];
    const price = prices[i];

    if (r != null && rPrev != null) {
      if (position === 0 && rPrev >= oversold && r < oversold) {
        position = cash / price;
        entryPrice = price;
        entryIdx = i;
        cash = 0;
      } else if (position > 0 && rPrev <= overbought && r > overbought) {
        const exitValue = position * price;
        const pnlPct = +((price - entryPrice) / entryPrice * 100).toFixed(2);
        trades.push({ entry: entryPrice, exit: price, entryIdx, exitIdx: i, pnlPct, duration: i - entryIdx });
        cash = exitValue;
        position = 0;
      }
    }
    equity.push(cash + position * price);
  }

  if (position > 0) {
    const price = prices[prices.length - 1];
    const pnlPct = +((price - entryPrice) / entryPrice * 100).toFixed(2);
    trades.push({ entry: entryPrice, exit: price, entryIdx, exitIdx: prices.length - 1, pnlPct, duration: prices.length - 1 - entryIdx, open: true });
    equity[equity.length - 1] = cash + position * price;
  }

  return { strategy: 'RSI Mean Reversion', params: { period, oversold, overbought }, trades, equity, ...calcMetrics(trades, equity, prices) };
};

// ── Estrategia 3: Bollinger Breakout ─────────────────────────────────────
const bollingerBreakout = (prices, period = 20, mult = 2) => {
  const bb = bollingerBands(prices, period, mult);
  const capital = 10000;
  let cash = capital, position = 0, entryPrice = 0, entryIdx = 0;
  const trades = [], equity = [];

  for (let i = 1; i < prices.length; i++) {
    const price = prices[i], prevPrice = prices[i - 1];
    const upper = bb.upper[i], mid = bb.middle[i];
    const prevUpper = bb.upper[i - 1];

    if (upper != null && mid != null) {
      // Compra al romper banda superior
      if (position === 0 && prevPrice <= (prevUpper || upper) && price > upper) {
        position = cash / price;
        entryPrice = price;
        entryIdx = i;
        cash = 0;
      }
      // Vende al tocar media (reversión)
      else if (position > 0 && price <= mid) {
        const exitValue = position * price;
        const pnlPct = +((price - entryPrice) / entryPrice * 100).toFixed(2);
        trades.push({ entry: entryPrice, exit: price, entryIdx, exitIdx: i, pnlPct, duration: i - entryIdx });
        cash = exitValue;
        position = 0;
      }
    }
    equity.push(cash + position * price);
  }

  if (position > 0) {
    const price = prices[prices.length - 1];
    const pnlPct = +((price - entryPrice) / entryPrice * 100).toFixed(2);
    trades.push({ entry: entryPrice, exit: price, entryIdx, exitIdx: prices.length - 1, pnlPct, duration: prices.length - 1 - entryIdx, open: true });
    equity[equity.length - 1] = cash + position * price;
  }

  return { strategy: 'Bollinger Breakout', params: { period, mult }, trades, equity, ...calcMetrics(trades, equity, prices) };
};

// ── Buy & Hold benchmark ──────────────────────────────────────────────────
const buyAndHold = (prices) => {
  const capital = 10000;
  const shares = capital / prices[0];
  const equity = prices.map(p => shares * p);
  const totalReturn = +((prices[prices.length - 1] - prices[0]) / prices[0] * 100).toFixed(2);
  let peak = equity[0], maxDd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak * 100;
    if (dd > maxDd) maxDd = dd;
  }
  return { strategy: 'Buy & Hold', equity, totalReturn, maxDrawdown: +maxDd.toFixed(2), winRate: null, sharpeRatio: null, totalTrades: 1 };
};

// ── Función principal ─────────────────────────────────────────────────────
const runBacktest = (prices, strategyKey) => {
  if (prices.length < 35) throw new Error('Se necesitan al menos 35 precios para el backtest');

  const bh = buyAndHold(prices);

  let result;
  switch (strategyKey) {
    case 'sma_crossover':    result = smaCrossover(prices); break;
    case 'rsi_reversion':    result = rsiMeanReversion(prices); break;
    case 'bollinger_breakout': result = bollingerBreakout(prices); break;
    default: result = smaCrossover(prices);
  }

  return { strategy: result, benchmark: bh };
};

const runAllStrategies = (prices) => {
  if (prices.length < 35) throw new Error('Se necesitan al menos 35 precios');
  return {
    sma_crossover:      smaCrossover(prices),
    rsi_reversion:      rsiMeanReversion(prices),
    bollinger_breakout: bollingerBreakout(prices),
    buy_and_hold:       buyAndHold(prices),
  };
};

module.exports = { runBacktest, runAllStrategies, smaCrossover, rsiMeanReversion, bollingerBreakout, buyAndHold };

// ─── analytics.js — capa analítica reusable para hackathon ──────────────
// Todas las funciones: (prices: number[]) → scalar o array
// Sin dependencias. Pragmático, debuggeable, rápido de modificar.

const last  = arr => arr[arr.length - 1];
const clean = arr => arr.filter(v => v != null && isFinite(v));

// ── Core ─────────────────────────────────────────────────────────────────

const pctChange = (a, b) => ((b - a) / Math.abs(a)) * 100;

const percentageChange = (prices) =>
  prices.map((p, i) => i === 0 ? null : pctChange(prices[i - 1], p));

const sma = (prices, period) => {
  const out = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    out.push(prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  }
  return out;
};

const stdDev = (arr) => {
  const n = arr.length;
  if (n < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(arr.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n);
};

const volatility = (prices, period = 14) => {
  // Rolling stdDev of % returns — expressed as %
  const returns = percentageChange(prices).slice(1); // drop null
  const out = Array(period).fill(null);
  for (let i = period; i <= returns.length; i++) {
    out.push(stdDev(returns.slice(i - period, i)));
  }
  return out;
};

// ── Momentum ──────────────────────────────────────────────────────────────
// Rate of change: (current / price N periods ago - 1) * 100
const momentum = (prices, period = 10) =>
  prices.map((p, i) => i < period ? null : pctChange(prices[i - period], p));

// ── Trend detection ───────────────────────────────────────────────────────
// Returns 'bullish' | 'bearish' | 'sideways' + numeric strength (-100..100)
const trendDetection = (prices, shortPeriod = 10, longPeriod = 30) => {
  if (prices.length < longPeriod) return { trend: 'sideways', strength: 0 };
  const shortSMA = last(clean(sma(prices, shortPeriod)));
  const longSMA  = last(clean(sma(prices, longPeriod)));
  const cur      = last(prices);
  const strength = pctChange(longSMA, shortSMA); // % gap between MAs

  let trend = 'sideways';
  if (strength >  1.5) trend = 'bullish';
  if (strength < -1.5) trend = 'bearish';

  // also check recent slope
  const slope = pctChange(prices[prices.length - shortPeriod], cur);
  const label = trend === 'bullish' ? '▲ Alcista' : trend === 'bearish' ? '▼ Bajista' : '→ Lateral';

  return { trend, strength: +strength.toFixed(2), slope: +slope.toFixed(2), label };
};

// ── Drawdown ──────────────────────────────────────────────────────────────
const drawdown = (prices) => {
  let peak = prices[0], maxDD = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    const dd = (peak - p) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return -(maxDD * 100);
};

// ── Total return & annualized ─────────────────────────────────────────────
const totalReturn = (prices) => pctChange(prices[0], last(prices));

const sharpe = (prices, riskFreeRate = 0) => {
  const returns = percentageChange(prices).slice(1);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std  = stdDev(returns);
  if (!std) return null;
  return +((mean - riskFreeRate) / std).toFixed(3);
};

// ── Time window slicing ───────────────────────────────────────────────────
// priceHistory: [[timestamp, price], ...]
const sliceWindow = (priceHistory, windowMs) => {
  const cutoff = Date.now() - windowMs;
  return priceHistory.filter(([ts]) => ts >= cutoff);
};

const WINDOWS = {
  '1h':  3_600_000,
  '4h':  14_400_000,
  '24h': 86_400_000,
  '7d':  604_800_000,
  '30d': 2_592_000_000,
};

const aggregateOHLC = (priceHistory, bucketMs) => {
  if (!priceHistory.length) return [];
  const buckets = {};
  for (const [ts, price] of priceHistory) {
    const key = Math.floor(ts / bucketMs) * bucketMs;
    if (!buckets[key]) buckets[key] = { ts: key, open: price, high: price, low: price, close: price };
    const b = buckets[key];
    if (price > b.high) b.high = price;
    if (price < b.low)  b.low  = price;
    b.close = price;
  }
  return Object.values(buckets).sort((a, b) => a.ts - b.ts);
};


// ── EMA (Exponential Moving Average) ─────────────────────────────────────
const ema = (prices, period) => {
  const k = 2 / (period + 1);
  const out = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    out.push(prices[i] * k + out[i - 1] * (1 - k));
  }
  return out;
};

module.exports = {
  percentageChange, pctChange, sma, ema, stdDev,
  volatility, momentum, trendDetection,
  drawdown, totalReturn, sharpe,
  sliceWindow, aggregateOHLC, WINDOWS,
  last, clean,
};

// ── Correlación de Pearson entre dos series ───────────────────────────────
const correlation = (a, b) => {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ax = a.slice(-n), bx = b.slice(-n);
  const ma = ax.reduce((s, v) => s + v, 0) / n;
  const mb = bx.reduce((s, v) => s + v, 0) / n;
  const num = ax.reduce((s, v, i) => s + (v - ma) * (bx[i] - mb), 0);
  const da  = Math.sqrt(ax.reduce((s, v) => s + (v - ma) ** 2, 0));
  const db  = Math.sqrt(bx.reduce((s, v) => s + (v - mb) ** 2, 0));
  return da && db ? +(num / (da * db)).toFixed(4) : 0;
};

// ── Value at Risk (VaR) — percentil histórico ─────────────────────────────
// confidence: 0.95 o 0.99
const valueAtRisk = (prices, confidence = 0.95) => {
  const returns = clean(percentageChange(prices));
  if (returns.length < 10) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  const idx = Math.floor((1 - confidence) * sorted.length);
  return +sorted[idx].toFixed(4);
};

// ── Beta vs benchmark (retornos simultáneos) ──────────────────────────────
const beta = (assetPrices, benchmarkPrices) => {
  const ar = clean(percentageChange(assetPrices));
  const br = clean(percentageChange(benchmarkPrices));
  const n  = Math.min(ar.length, br.length);
  if (n < 5) return null;
  const a = ar.slice(-n), b = br.slice(-n);
  const mb = b.reduce((s, v) => s + v, 0) / n;
  const cov = a.reduce((s, v, i) => s + (v - (a.reduce((x,y) => x+y,0)/n)) * (b[i] - mb), 0) / n;
  const varB= b.reduce((s, v) => s + (v - mb) ** 2, 0) / n;
  return varB ? +(cov / varB).toFixed(4) : null;
};

// ── Calmar Ratio: retorno anualizado / max drawdown ───────────────────────
const calmarRatio = (prices) => {
  const dd = Math.abs(drawdown(prices));
  if (!dd) return null;
  const ret = totalReturn(prices);
  return +(ret / dd).toFixed(4);
};

// ── Sortino: penaliza solo volatilidad negativa ───────────────────────────
const sortino = (prices, targetReturn = 0) => {
  const returns = clean(percentageChange(prices));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const downside = returns.filter(r => r < targetReturn);
  if (!downside.length) return null;
  const ds = Math.sqrt(downside.reduce((s, v) => s + (v - targetReturn) ** 2, 0) / downside.length);
  return ds ? +((mean - targetReturn) / ds).toFixed(4) : null;
};

// ── Detección de régimen de mercado ──────────────────────────────────────
// Clasifica el estado: 'trending_up' | 'trending_down' | 'ranging' | 'volatile'
const marketRegime = (prices) => {
  if (prices.length < 20) return { regime: 'unknown', label: 'Sin datos' };
  const returns  = clean(percentageChange(prices));
  const vol      = stdDev(returns);
  const trend    = trendDetection(prices);
  const dd       = Math.abs(drawdown(prices));
  const highVol  = vol > 3;

  let regime, label, color;
  if (highVol && dd > 15)       { regime = 'volatile';      label = '~ Mercado volátil';       color = 'red'; }
  else if (trend.trend === 'bullish') { regime = 'trending_up';   label = '▲ Tendencia alcista';    color = 'green'; }
  else if (trend.trend === 'bearish') { regime = 'trending_down'; label = '▼ Tendencia bajista';    color = 'red'; }
  else                                { regime = 'ranging';       label = '↔ Mercado en rango';     color = 'yellow'; }

  return { regime, label, color, vol: +vol.toFixed(3), trend: trend.strength, drawdown: +dd.toFixed(2) };
};

// ── Puntos de soporte y resistencia (pivots locales) ─────────────────────
const supportResistance = (prices, lookback = 5) => {
  const supports = [], resistances = [];
  for (let i = lookback; i < prices.length - lookback; i++) {
    const window = prices.slice(i - lookback, i + lookback + 1);
    const isMin = prices[i] === Math.min(...window);
    const isMax = prices[i] === Math.max(...window);
    if (isMin) supports.push({ index: i, price: prices[i] });
    if (isMax) resistances.push({ index: i, price: prices[i] });
  }
  const last3Sup = supports.slice(-3).map(s => s.price);
  const last3Res = resistances.slice(-3).map(r => r.price);
  return { supports: last3Sup, resistances: last3Res };
};

module.exports = {
  percentageChange, pctChange, sma, stdDev,
  volatility, momentum, trendDetection,
  drawdown, totalReturn, sharpe,
  sliceWindow, aggregateOHLC, WINDOWS,
  correlation, valueAtRisk, beta, calmarRatio, sortino,
  marketRegime, supportResistance,
  last, clean,
};

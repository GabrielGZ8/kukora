// ─── forecastService.js — forecasting estadístico sin ML libs ────────────
// Modelos implementados en JS puro: SMA-drift, EWM, Holt-Winters simplificado

const { sma, stdDev, percentageChange, clean } = require('./analytics');

// ── Modelo 1: SMA drift — proyecta con momentum de la media ──────────────
const smaDriftForecast = (prices, horizon = 7) => {
  if (prices.length < 10) return null;
  const period = Math.min(20, Math.floor(prices.length / 2));
  const recentSMA = sma(prices, period).filter(v => v !== null);
  const lastSMA   = recentSMA[recentSMA.length - 1];
  const prevSMA   = recentSMA[recentSMA.length - 2];
  const drift     = (lastSMA - prevSMA) / prevSMA; // % drift diario
  const returns   = clean(percentageChange(prices));
  const vol       = stdDev(returns) / 100;          // como decimal
  const lastPrice = prices[prices.length - 1];

  const forecast = [];
  for (let h = 1; h <= horizon; h++) {
    const point = lastPrice * Math.pow(1 + drift, h);
    const upper = point * Math.pow(1 + vol * Math.sqrt(h), 1.65); // 90% CI
    const lower = point * Math.pow(1 - vol * Math.sqrt(h), 1.65);
    forecast.push({ h, point: +point.toFixed(4), upper: +upper.toFixed(4), lower: +lower.toFixed(4) });
  }
  return { model: 'sma_drift', drift: +(drift * 100).toFixed(4), forecast };
};

// ── Modelo 2: EWM (Exponential Weighted Mean) ─────────────────────────────
const ewmForecast = (prices, horizon = 7, alpha = 0.3) => {
  if (prices.length < 5) return null;
  // Holt's double exponential smoothing (tendencia + nivel)
  let level  = prices[0];
  let trend  = prices[1] - prices[0];
  const beta = 0.1;
  for (let i = 1; i < prices.length; i++) {
    const prevLevel = level;
    level = alpha * prices[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }
  const returns = clean(percentageChange(prices));
  const vol     = stdDev(returns) / 100;
  const forecast = [];
  for (let h = 1; h <= horizon; h++) {
    const point = level + h * trend;
    const upper = point * (1 + 1.65 * vol * Math.sqrt(h));
    const lower = point * (1 - 1.65 * vol * Math.sqrt(h));
    forecast.push({ h, point: +point.toFixed(4), upper: +upper.toFixed(4), lower: +lower.toFixed(4) });
  }
  return { model: 'holt_ewm', alpha, beta, level: +level.toFixed(4), trend: +trend.toFixed(4), forecast };
};

// ── Ensemble: promedio de modelos disponibles ─────────────────────────────
const ensembleForecast = (prices, horizon = 7) => {
  const m1 = smaDriftForecast(prices, horizon);
  const m2 = ewmForecast(prices, horizon);
  if (!m1 || !m2) return m1 || m2 || null;

  const ensemble = m1.forecast.map((f, i) => ({
    h: f.h,
    point: +((f.point + m2.forecast[i].point) / 2).toFixed(4),
    upper: +((f.upper + m2.forecast[i].upper) / 2).toFixed(4),
    lower: +((f.lower + m2.forecast[i].lower) / 2).toFixed(4),
  }));
  return { model: 'ensemble', models: ['sma_drift', 'holt_ewm'], forecast: ensemble };
};

// ── Backtesting: mide accuracy del forecast contra datos reales ───────────
const backtest = (prices, horizon = 7, model = 'ensemble') => {
  if (prices.length < horizon * 3) return null;
  const trainEnd = prices.length - horizon;
  const train    = prices.slice(0, trainEnd);
  const actual   = prices.slice(trainEnd);

  const fn = model === 'sma_drift' ? smaDriftForecast : model === 'holt_ewm' ? ewmForecast : ensembleForecast;
  const result = fn(train, horizon);
  if (!result) return null;

  const predicted = result.forecast.map(f => f.point);
  const errors = actual.map((a, i) => predicted[i] ? Math.abs(a - predicted[i]) / a * 100 : null).filter(Boolean);
  const mae    = errors.reduce((a, b) => a + b, 0) / errors.length;
  const hits   = result.forecast.filter((f, i) => actual[i] >= f.lower && actual[i] <= f.upper).length;

  return {
    model,
    horizon,
    mape:      +mae.toFixed(2),           // Mean Absolute Percentage Error
    hitRate:   +((hits / horizon) * 100).toFixed(1), // % dentro del CI
    predicted,
    actual,
  };
};

module.exports = { smaDriftForecast, ewmForecast, ensembleForecast, backtest };

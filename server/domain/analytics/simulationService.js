// ─── simulationService.js — Monte Carlo GBM simulation ───────────────────
const { percentageChange, stdDev, clean } = require('./analytics');

// Box-Muller transform: N(0,1)
const randn = () => {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// GBM: S(t+1) = S(t) * exp((μ - σ²/2)dt + σ√dt * Z)
const monteCarloGBM = (prices, horizon = 30, simulations = 500) => {
  if (prices.length < 10) throw new Error('Se necesitan al menos 10 precios');

  const returns = clean(percentageChange(prices));
  const dt = 1; // 1 day
  const mu = returns.reduce((a, b) => a + b, 0) / returns.length / 100; // drift diario decimal
  const sigma = stdDev(returns) / 100; // vol diaria decimal

  const S0 = prices[prices.length - 1];

  // Generar paths
  const paths = [];
  for (let s = 0; s < simulations; s++) {
    const path = [S0];
    for (let t = 0; t < horizon; t++) {
      const prev = path[path.length - 1];
      const Z = randn();
      const next = prev * Math.exp((mu - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * Z);
      path.push(+next.toFixed(6));
    }
    paths.push(path);
  }

  // Final distribution
  const finals = paths.map(p => p[p.length - 1]).sort((a, b) => a - b);
  const n = finals.length;

  const pct = (p) => finals[Math.floor(p * n / 100)];

  const percentiles = {
    p5:  +pct(5).toFixed(4),
    p25: +pct(25).toFixed(4),
    p50: +pct(50).toFixed(4),
    p75: +pct(75).toFixed(4),
    p95: +pct(95).toFixed(4),
  };

  const mean = finals.reduce((a, b) => a + b, 0) / n;

  const probAbove = (target) => {
    const count = finals.filter(f => f >= target).length;
    return +(count / n * 100).toFixed(2);
  };

  const probBelow = (target) => {
    const count = finals.filter(f => f <= target).length;
    return +(count / n * 100).toFixed(2);
  };

  // Histograma de 20 bins
  const min = finals[0], max = finals[finals.length - 1];
  const binSize = (max - min) / 20 || 1;
  const histogram = [];
  for (let i = 0; i < 20; i++) {
    const lo = min + i * binSize;
    const hi = lo + binSize;
    const count = finals.filter(f => f >= lo && f < hi).length;
    histogram.push({ lo: +lo.toFixed(4), hi: +hi.toFixed(4), count, pct: +(count / n * 100).toFixed(1) });
  }

  return {
    S0,
    horizon,
    simulations,
    mu: +(mu * 100).toFixed(4),
    sigma: +(sigma * 100).toFixed(4),
    paths,
    percentiles,
    mean: +mean.toFixed(4),
    expectedReturn: +((mean - S0) / S0 * 100).toFixed(2),
    histogram,
    probAbove,
    probBelow,
  };
};

module.exports = { monteCarloGBM };

// ─── riskEngine.js — motor de riesgo multi-asset ─────────────────────────
// Produce un Risk Report completo por asset o portafolio

const {
  percentageChange, stdDev, sharpe, sortino, calmarRatio,
  valueAtRisk, drawdown, totalReturn, marketRegime,
  supportResistance, correlation, clean, last,
} = require('./analytics');

// Risk score 0-100 (100 = máximo riesgo)
const assetRiskScore = (prices) => {
  if (prices.length < 10) return { score: 50, grade: 'C', components: {} };

  const returns  = clean(percentageChange(prices));
  const vol      = stdDev(returns);
  const dd       = Math.abs(drawdown(prices));
  const var95    = valueAtRisk(prices, 0.95);
  const n        = returns.length;
  // Skewness: sesgo negativo = más riesgo
  const mean     = returns.reduce((a, b) => a + b, 0) / n;
  const skew     = returns.reduce((s, v) => s + ((v - mean) / (vol || 1)) ** 3, 0) / n;

  // Normalizar y ponderar componentes (0-100 cada uno)
  const volScore  = Math.min(100, vol * 10);          // >10% vol diaria = max risk
  const ddScore   = Math.min(100, dd * 1.5);           // >67% drawdown = max
  const varScore  = Math.min(100, Math.abs(var95 || 0) * 8);
  const skewScore = Math.min(100, Math.max(0, -skew * 20 + 50)); // sesgo negativo sube score

  const score = Math.round(volScore * 0.35 + ddScore * 0.30 + varScore * 0.25 + skewScore * 0.10);
  const grade = score >= 75 ? 'D' : score >= 50 ? 'C' : score >= 25 ? 'B' : 'A';

  return {
    score,
    grade,
    components: {
      volatility:   +volScore.toFixed(1),
      drawdown:     +ddScore.toFixed(1),
      var95:        +varScore.toFixed(1),
      skewPenalty:  +skewScore.toFixed(1),
    },
    raw: {
      vol:      +vol.toFixed(4),
      drawdown: +dd.toFixed(2),
      var95:    var95 != null ? +var95.toFixed(4) : null,
      skew:     +skew.toFixed(4),
      sharpe:   sharpe(prices),
      sortino:  sortino(prices),
      calmar:   calmarRatio(prices),
    },
  };
};

// Correlación matrix entre múltiples assets
const correlationMatrix = (assetsMap) => {
  const ids = Object.keys(assetsMap);
  const matrix = {};
  for (const a of ids) {
    matrix[a] = {};
    for (const b of ids) {
      const ra = clean(percentageChange(assetsMap[a]));
      const rb = clean(percentageChange(assetsMap[b]));
      matrix[a][b] = a === b ? 1 : correlation(ra, rb);
    }
  }
  return matrix;
};

// Portfolio risk — given positions [{ coinId, quantity, entryPrice, prices }]
const portfolioRisk = (positions, benchmarkPrices = null) => {
  if (!positions.length) return null;

  const weights = [];
  let totalValue = 0;
  const enriched = positions.map(p => {
    const cur   = last(p.prices || [p.entryPrice]);
    const value = cur * p.quantity;
    totalValue += value;
    return { ...p, currentValue: value };
  });

  const wt = enriched.map(p => p.currentValue / totalValue);
  const portfolioReturns = [];
  const len = Math.min(...positions.map(p => (p.prices || []).length));

  for (let i = 1; i < len; i++) {
    let dayReturn = 0;
    enriched.forEach((p, pi) => {
      const r = (p.prices[i] - p.prices[i - 1]) / p.prices[i - 1];
      dayReturn += wt[pi] * r;
    });
    portfolioReturns.push(dayReturn * 100);
  }

  const vol = stdDev(portfolioReturns);
  const mean = portfolioReturns.reduce((a, b) => a + b, 0) / (portfolioReturns.length || 1);
  const sp   = vol ? +((mean / vol)).toFixed(3) : null;
  const downside = portfolioReturns.filter(r => r < 0);
  const ds = downside.length ? Math.sqrt(downside.reduce((s, v) => s + v ** 2, 0) / downside.length) : 0;
  const so  = ds ? +((mean / ds)).toFixed(3) : null;

  return {
    totalValue,
    weights: enriched.map((p, i) => ({ coinId: p.coinId, weight: +(wt[i] * 100).toFixed(2) })),
    metrics: { volatility: +vol.toFixed(4), sharpe: sp, sortino: so, diversification: ids => ids },
    returns: portfolioReturns,
  };
};

module.exports = { assetRiskScore, correlationMatrix, portfolioRisk };

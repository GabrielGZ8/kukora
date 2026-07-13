// ─── anomalyService.js ────────────────────────────────────────────────────
// Input:  prices: number[], options?: { zThreshold, crashPct, spikePct, volMult }
// Output: { level, reason, severityScore, details[] }

const { percentageChange, stdDev, volatility, last, clean } = require('./analytics');

const DEFAULTS = {
  zThreshold:  2.5,   // z-score para detectar outlier
  crashPct:   -8,     // drop in 1 candle = crash
  spikePct:    8,     // subida en 1 vela = spike
  volMult:     2.5,   // times historical volatility = unusual
};

// z-score of last return vs historical distribution
const zScore = (returns) => {
  const vals = clean(returns);
  if (vals.length < 5) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const std  = stdDev(vals);
  if (!std) return 0;
  return (last(vals) - mean) / std;
};

const detectAnomalies = (prices, opts = {}) => {
  const cfg = { ...DEFAULTS, ...opts };
  const details = [];
  let totalScore = 0;

  if (prices.length < 5) return { level: 'low', reason: 'Datos insuficientes', severityScore: 0, details: [] };

  const returns  = clean(percentageChange(prices));
  const lastRet  = last(returns);
  const z        = zScore(returns);

  // 1. Price spike
  if (lastRet >= cfg.spikePct) {
    const score = Math.min(100, Math.round((lastRet / cfg.spikePct) * 40));
    details.push({ type: 'spike', label: 'Spike de precio', value: `+${lastRet.toFixed(2)}%`, score });
    totalScore += score;
  }

  // 2. Sudden crash
  if (lastRet <= cfg.crashPct) {
    const score = Math.min(100, Math.round((Math.abs(lastRet) / Math.abs(cfg.crashPct)) * 50));
    details.push({ type: 'crash', label: 'Sharp drop', value: `${lastRet.toFixed(2)}%`, score });
    totalScore += score;
  }

  // 3. Z-score outlier
  if (Math.abs(z) >= cfg.zThreshold) {
    const score = Math.min(100, Math.round(Math.abs(z) * 15));
    const dir   = z > 0 ? 'positivo' : 'negativo';
    details.push({ type: 'zscore', label: `Statistically anomalous return (${dir})`, value: `z=${z.toFixed(2)}`, score });
    totalScore += score;
  }

  // 4. Unusual volatility (last 5 vs historical)
  const volArr      = clean(volatility(prices, 10));
  const recentVol   = last(volatility(prices.slice(-5), 4).filter(v => v !== null)) || 0;
  const histVol     = volArr.length ? volArr.reduce((a, b) => a + b, 0) / volArr.length : 0;
  if (histVol > 0 && recentVol > histVol * cfg.volMult) {
    const score = Math.min(100, Math.round((recentVol / histVol) * 20));
    details.push({ type: 'volatility', label: 'Unusual volatility', value: `${recentVol.toFixed(2)}x historical`, score });
    totalScore += score;
  }

  const severityScore = Math.min(100, totalScore);
  const level = severityScore >= 60 ? 'high' : severityScore >= 25 ? 'medium' : 'low';
  const reason = details.length
    ? details.map(d => d.label).join(' · ')
    : 'No anomalies detected';

  return { level, reason, severityScore, details };
};

// Batch: analiza un array de assets [{ id, prices }]
const detectBatch = (assets, opts = {}) =>
  assets.map(({ id, name, prices }) => ({
    id, name,
    anomaly: detectAnomalies(prices, opts),
  })).sort((a, b) => b.anomaly.severityScore - a.anomaly.severityScore);

module.exports = { detectAnomalies, detectBatch };

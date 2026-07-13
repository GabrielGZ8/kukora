// ─── marketRegimeEngine.js — AI Market Regime Detection ─────────────────
// Detects the current market regime using multiple quantitative signals
// Output: { regime, confidence, label, interpretation, signals, historical }

const { percentageChange, stdDev, sma, clean, last } = require('../analytics/analytics');
const { isMarketRegimeResult } = require('./marketRegime');
const obs = require('../../infrastructure/observabilityService');

const REGIMES = {
  LIQUIDITY_COMPRESSION:  { id: 'LIQUIDITY_COMPRESSION',  label: 'Liquidity Compression',   color: '#FFD166', icon: '⟁', description: 'Volatility contracting, narrow range. Precedes explosive breakouts.' },
  BULLISH_EXPANSION:      { id: 'BULLISH_EXPANSION',       label: 'Bullish Expansion',        color: '#00E5A0', icon: '▲', description: 'Momentum positivo sostenido, breadth fuerte, estructura alcista.' },
  BEARISH_CONTRACTION:    { id: 'BEARISH_CONTRACTION',     label: 'Bearish Contraction',      color: '#FF4D6A', icon: '▼', description: 'Dominant selling pressure, cascade liquidations, elevated risk.' },
  DISTRIBUTION:           { id: 'DISTRIBUTION',            label: 'Distribution Phase',       color: '#A78BFA', icon: '◈', description: 'Smart money reducing exposure. Medium volatility with divergences.' },
  ACCUMULATION:           { id: 'ACCUMULATION',            label: 'Accumulation Phase',       color: '#4FA3FF', icon: '◎', description: 'Capital institucional acumulando. Precio estable con volumen creciente.' },
  VOLATILE_UNCERTAINTY:   { id: 'VOLATILE_UNCERTAINTY',    label: 'Volatile Uncertainty',     color: '#FF8C42', icon: '⚡', description: 'High volatility with no clear direction. Contradictory signals.' },
};

// Calcula volatilidad rolling normalizada
const normalizedVol = (prices, period = 14) => {
  const returns = clean(percentageChange(prices));
  if (returns.length < period) return 0.5;
  const recent = stdDev(returns.slice(-period));
  const hist   = stdDev(returns.slice(0, -period));
  if (!hist) return 0.5;
  return Math.min(2, recent / hist); // 1 = normal, >1 = elevada, <1 = comprimida
};

// Trend direction (-1 to 1)
const trendScore = (prices) => {
  if (prices.length < 20) return 0;
  const sma10 = last(clean(sma(prices, 10)));
  const sma20 = last(clean(sma(prices, 20)));
  const cur   = last(prices);
  if (!sma10 || !sma20) return 0;
  const gapPct = (sma10 - sma20) / sma20;
  const priceSma = (cur - sma20) / sma20;
  return Math.max(-1, Math.min(1, (gapPct + priceSma) * 10));
};

// Momentum score (-1 a 1)
const momentumScore = (prices) => {
  const ret7  = prices.length > 7  ? (prices[prices.length-1] - prices[prices.length-8])  / prices[prices.length-8]  : 0;
  const ret14 = prices.length > 14 ? (prices[prices.length-1] - prices[prices.length-15]) / prices[prices.length-15] : 0;
  return Math.max(-1, Math.min(1, (ret7 * 0.6 + ret14 * 0.4) * 5));
};

const detectMarketRegime = (prices, _btcDominance = null) => {
  if (prices.length < 15) {
    return { ...REGIMES.VOLATILE_UNCERTAINTY, confidence: 50, signals: [], interpretation: 'Insufficient data for regime analysis.' };
  }

  const normVol   = normalizedVol(prices);
  const trend     = trendScore(prices);
  const momentum_ = momentumScore(prices);
  const returns   = clean(percentageChange(prices));
  const recentRet = last(returns) || 0;

  // Individual signals
  const signals = [
    { name: 'Normalized Volatility', value: normVol.toFixed(2), raw: normVol,  interpretation: normVol < 0.7 ? 'Compressed (caution)' : normVol > 1.4 ? 'Expanded (risk)' : 'Normal' },
    { name: 'MA Trend',            value: `${(trend * 100).toFixed(0)}`,      raw: trend,      interpretation: trend > 0.3 ? 'Bullish' : trend < -0.3 ? 'Bearish' : 'Sideways' },
    { name: 'Momentum',                value: `${(momentum_ * 100).toFixed(0)}`,  raw: momentum_,  interpretation: momentum_ > 0.3 ? 'Positive' : momentum_ < -0.3 ? 'Negative' : 'Neutral' },
    { name: 'Recent Return',        value: `${recentRet.toFixed(2)}%`,         raw: recentRet/10, interpretation: recentRet > 3 ? 'Strong rise' : recentRet < -3 ? 'Strong drop' : 'Normal movement' },
  ];

  // Per-regime scoring
  const scores = {};

  // LIQUIDITY_COMPRESSION: low vol, sideways trend, weak momentum
  scores.LIQUIDITY_COMPRESSION = (normVol < 0.75 ? 60 : normVol < 0.9 ? 30 : 0)
    + (Math.abs(trend) < 0.2 ? 25 : Math.abs(trend) < 0.4 ? 10 : 0)
    + (Math.abs(momentum_) < 0.2 ? 15 : 0);

  // BULLISH_EXPANSION: vol normal-alta, trend alcista, momentum positivo
  scores.BULLISH_EXPANSION = (trend > 0.3 ? 40 : trend > 0.1 ? 20 : 0)
    + (momentum_ > 0.3 ? 35 : momentum_ > 0.1 ? 15 : 0)
    + (normVol > 0.9 && normVol < 1.6 ? 15 : 0)
    + (recentRet > 2 ? 10 : 0);

  // BEARISH_CONTRACTION: trend bajista, momentum negativo
  scores.BEARISH_CONTRACTION = (trend < -0.3 ? 40 : trend < -0.1 ? 20 : 0)
    + (momentum_ < -0.3 ? 35 : momentum_ < -0.1 ? 15 : 0)
    + (normVol > 1.2 ? 15 : 0)
    + (recentRet < -2 ? 10 : 0);

  // DISTRIBUTION: vol media, trend neutral-bajo con momentum decayendo
  scores.DISTRIBUTION = (normVol > 0.8 && normVol < 1.3 ? 30 : 0)
    + (trend > -0.2 && trend < 0.3 ? 25 : 0)
    + (momentum_ < 0 && momentum_ > -0.4 ? 25 : 0)
    + (recentRet < 0 && recentRet > -3 ? 20 : 0);

  // ACCUMULATION: vol baja-media, precio estable cerca de soportes
  scores.ACCUMULATION = (normVol < 1.0 ? 30 : 0)
    + (trend > -0.15 && trend < 0.25 ? 25 : 0)
    + (momentum_ > -0.1 && momentum_ < 0.3 ? 25 : 0)
    + (recentRet > -1 && recentRet < 2 ? 20 : 0);

  // VOLATILE_UNCERTAINTY: high vol, contradictory signals
  scores.VOLATILE_UNCERTAINTY = (normVol > 1.5 ? 50 : normVol > 1.2 ? 25 : 0)
    + (Math.sign(trend) !== Math.sign(momentum_) ? 30 : 0)
    + (Math.abs(recentRet) > 5 ? 20 : 0);

  // Select winning regime
  const winner = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const regimeId = winner[0];
  const rawScore = winner[1];

  // Confidence: how far ahead the winner is from runner-up
  const sorted = Object.values(scores).sort((a, b) => b - a);
  const gap = sorted[0] - (sorted[1] || 0);
  const confidence = Math.min(95, Math.max(45, 50 + gap * 0.8 + (rawScore > 80 ? 10 : 0)));

  const regime = { ...REGIMES[regimeId] };

  // Narrative interpretation — 100% deterministic based on signal values
  const volDesc    = normVol < 0.7 ? 'at historical lows' : normVol < 0.9 ? 'below average' : normVol < 1.2 ? 'normal' : normVol < 1.5 ? 'above average' : 'at elevated highs';
  const trendDesc  = trend > 0.3 ? `tendencia MA positiva (+${(trend*100).toFixed(0)})` : trend < -0.3 ? `tendencia MA negativa (${(trend*100).toFixed(0)})` : 'tendencia MA lateral';
  const momDesc    = momentum_ > 0.3 ? `momentum positivo (+${(momentum_*100).toFixed(0)})` : momentum_ < -0.3 ? `momentum negativo (${(momentum_*100).toFixed(0)})` : 'momentum neutro';
  // Breakout timing: derived deterministically from compression ratio, no random
  const compressionDays = normVol < 0.6 ? '3-5' : normVol < 0.75 ? '5-8' : '8-14';

  const interps = {
    LIQUIDITY_COMPRESSION:  `Volatility ${volDesc} (${(normVol*100).toFixed(0)}% of historical average). Sustained compression historically precedes breakouts within ${compressionDays} sessions. ${trendDesc}.`,
    BULLISH_EXPANSION:      `Estructura alcista confirmada. ${momDesc} con ${trendDesc}. Capital rotando hacia activos de riesgo. Retorno reciente: ${recentRet.toFixed(2)}%.`,
    BEARISH_CONTRACTION:    `Dominant selling pressure. ${momDesc}. Risk-off activated. Potential bearish acceleration if key supports break. Volatility ${volDesc}.`,
    DISTRIBUTION:           `Smart money reduciendo posiciones. Precio lateral mientras el volumen sugiere salidas graduales. ${trendDesc}, ${momDesc}. Proceder con cautela.`,
    ACCUMULATION:           `Price consolidating in support zone with ${volDesc} volatility. ${trendDesc}. Possible silent institutional accumulation. ${momDesc}.`,
    VOLATILE_UNCERTAINTY:   `Contradictory signals. Volatility ${volDesc}. ${trendDesc} but ${momDesc}. Wait for confirmation before taking directional exposure.`,
  };

  // Breakout probability at 7 days (quantitative heuristic)
  const breakoutProb = Math.round(
    (regimeId === 'LIQUIDITY_COMPRESSION' ? 65 : 40) +
    Math.abs(trend) * 20 + Math.abs(momentum_) * 15
  );

  const result = {
    ...regime,
    confidence: Math.round(confidence),
    signals,
    interpretation: interps[regimeId],
    breakoutProbability: Math.min(90, breakoutProb),
    metrics: { normalizedVol: +normVol.toFixed(3), trend: +trend.toFixed(3), momentum: +momentum_.toFixed(3), recentReturn: +recentRet.toFixed(2) },
    scores: Object.fromEntries(Object.entries(scores).sort((a,b) => b[1]-a[1])),
  };

  // Contract check (audit roadmap #1: MarketRegimeResult as a named type
  // — see server/domain/engines/marketRegime.js). Soft self-check, same
  // non-blocking pattern as isOpportunityLogEntry()/isSimResult(): emits a
  // RISK event instead of throwing, so a shape drift in this producer is
  // visible in observability/tests without breaking either consumer
  // (crypto.routes.js, datasetService.js).
  if (!isMarketRegimeResult(result)) {
    obs.emit('RISK', 'contract.market_regime_result_shape_invalid', { regimeId });
  }

  return result;
};

// Batch: detects regime for multiple assets and returns aggregate market regime
const detectMarketRegimeBatch = async (assetsData) => {
  const results = assetsData.map(({ id, name, prices }) => ({
    id, name, regime: detectMarketRegime(prices),
  }));

  // Consensus: most common regime weighted by confidence
  const regimeCounts = {};
  results.forEach(r => {
    const rid = r.regime.id;
    regimeCounts[rid] = (regimeCounts[rid] || 0) + r.regime.confidence;
  });
  const consensusId = Object.entries(regimeCounts).sort((a,b) => b[1]-a[1])[0]?.[0] || 'VOLATILE_UNCERTAINTY';
  const consensusConf = Math.round(Object.values(regimeCounts).reduce((a,b)=>a+b,0) / results.length);

  return {
    consensus: { ...REGIMES[consensusId], confidence: Math.min(92, consensusConf) },
    assets: results,
    timestamp: Date.now(),
  };
};

module.exports = { detectMarketRegime, detectMarketRegimeBatch, REGIMES };

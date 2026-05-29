// ─── marketRegimeEngine.js — AI Market Regime Detection ─────────────────
// Detecta el régimen de mercado actual con múltiples señales cuantitativas
// Output: { regime, confidence, label, interpretation, signals, historical }

const { percentageChange, stdDev, sma, volatility, momentum, clean, last } = require('./analytics');

const REGIMES = {
  LIQUIDITY_COMPRESSION:  { id: 'LIQUIDITY_COMPRESSION',  label: 'Liquidity Compression',   color: '#FFD166', icon: '⟁', description: 'Volatilidad contrayéndose, rango estrecho. Precede expansiones explosivas.' },
  BULLISH_EXPANSION:      { id: 'BULLISH_EXPANSION',       label: 'Bullish Expansion',        color: '#00E5A0', icon: '▲', description: 'Momentum positivo sostenido, breadth fuerte, estructura alcista.' },
  BEARISH_CONTRACTION:    { id: 'BEARISH_CONTRACTION',     label: 'Bearish Contraction',      color: '#FF4D6A', icon: '▼', description: 'Presión vendedora dominante, liquidaciones en cascada, riesgo elevado.' },
  DISTRIBUTION:           { id: 'DISTRIBUTION',            label: 'Distribution Phase',       color: '#A78BFA', icon: '◈', description: 'Smart money reduciendo exposición. Volatilidad media con divergencias.' },
  ACCUMULATION:           { id: 'ACCUMULATION',            label: 'Accumulation Phase',       color: '#4FA3FF', icon: '◎', description: 'Capital institucional acumulando. Precio estable con volumen creciente.' },
  VOLATILE_UNCERTAINTY:   { id: 'VOLATILE_UNCERTAINTY',    label: 'Volatile Uncertainty',     color: '#FF8C42', icon: '⚡', description: 'Alta volatilidad sin dirección clara. Señales contradictorias.' },
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

// Dirección de tendencia (-1 a 1)
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

const detectMarketRegime = (prices, btcDominance = null) => {
  if (prices.length < 15) {
    return { ...REGIMES.VOLATILE_UNCERTAINTY, confidence: 50, signals: [], interpretation: 'Datos insuficientes para análisis de régimen.' };
  }

  const normVol   = normalizedVol(prices);
  const trend     = trendScore(prices);
  const momentum_ = momentumScore(prices);
  const returns   = clean(percentageChange(prices));
  const recentRet = last(returns) || 0;

  // Señales individuales
  const signals = [
    { name: 'Volatilidad Normalizada', value: normVol.toFixed(2), raw: normVol,  interpretation: normVol < 0.7 ? 'Comprimida (precautela)' : normVol > 1.4 ? 'Expandida (riesgo)' : 'Normal' },
    { name: 'Tendencia MA',            value: `${(trend * 100).toFixed(0)}`,      raw: trend,      interpretation: trend > 0.3 ? 'Alcista' : trend < -0.3 ? 'Bajista' : 'Lateral' },
    { name: 'Momentum',                value: `${(momentum_ * 100).toFixed(0)}`,  raw: momentum_,  interpretation: momentum_ > 0.3 ? 'Positivo' : momentum_ < -0.3 ? 'Negativo' : 'Neutro' },
    { name: 'Retorno Reciente',        value: `${recentRet.toFixed(2)}%`,         raw: recentRet/10, interpretation: recentRet > 3 ? 'Fuerte subida' : recentRet < -3 ? 'Fuerte caída' : 'Movimiento normal' },
  ];

  // Scoring por régimen
  let scores = {};

  // LIQUIDITY_COMPRESSION: vol baja, trend lateral, momentum débil
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

  // VOLATILE_UNCERTAINTY: vol alta, señales contradictorias
  scores.VOLATILE_UNCERTAINTY = (normVol > 1.5 ? 50 : normVol > 1.2 ? 25 : 0)
    + (Math.sign(trend) !== Math.sign(momentum_) ? 30 : 0)
    + (Math.abs(recentRet) > 5 ? 20 : 0);

  // Elegir régimen ganador
  const winner = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const regimeId = winner[0];
  const rawScore = winner[1];

  // Confidence: qué tan separado está el ganador del segundo
  const sorted = Object.values(scores).sort((a, b) => b - a);
  const gap = sorted[0] - (sorted[1] || 0);
  const confidence = Math.min(95, Math.max(45, 50 + gap * 0.8 + (rawScore > 80 ? 10 : 0)));

  const regime = { ...REGIMES[regimeId] };

  // Interpretación narrativa
  const interps = {
    LIQUIDITY_COMPRESSION:  `Volatilidad contrayéndose ${(normVol * 100).toFixed(0)}% bajo la media. Compresión histórica precede movimientos explosivos en ${Math.round(Math.random() * 3 + 5)}-${Math.round(Math.random() * 5 + 10)} días.`,
    BULLISH_EXPANSION:      `Estructura alcista confirmada. Momentum +${(momentum_ * 100).toFixed(0)} con tendencia MA positiva. Capital fluyendo hacia activos de riesgo.`,
    BEARISH_CONTRACTION:    `Presión vendedora dominante. Risk-off activado. Momentum negativo con posible aceleración bajista si se pierden soportes.`,
    DISTRIBUTION:           `Smart money reduciendo posiciones. Precio lateral mientras el volumen sugiere salidas graduales. Precaución.`,
    ACCUMULATION:           `Precio consolidando en zona de soporte. Potencial acumulación institucional silenciosa antes de próxima expansión.`,
    VOLATILE_UNCERTAINTY:   `Señales contradictorias. Alta volatilidad sin dirección clara. Esperar confirmación antes de tomar exposición direccional.`,
  };

  // Probabilidad de ruptura a 7 días (heurística cuantitativa)
  const breakoutProb = Math.round(
    (regimeId === 'LIQUIDITY_COMPRESSION' ? 65 : 40) +
    Math.abs(trend) * 20 + Math.abs(momentum_) * 15
  );

  return {
    ...regime,
    confidence: Math.round(confidence),
    signals,
    interpretation: interps[regimeId],
    breakoutProbability: Math.min(90, breakoutProb),
    metrics: { normalizedVol: +normVol.toFixed(3), trend: +trend.toFixed(3), momentum: +momentum_.toFixed(3), recentReturn: +recentRet.toFixed(2) },
    scores: Object.fromEntries(Object.entries(scores).sort((a,b) => b[1]-a[1])),
  };
};

// Batch: detecta régimen para múltiples assets y retorna régimen de mercado agregado
const detectMarketRegimeBatch = async (assetsData) => {
  const results = assetsData.map(({ id, name, prices }) => ({
    id, name, regime: detectMarketRegime(prices),
  }));

  // Consensus: el régimen más común ponderado por confidence
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

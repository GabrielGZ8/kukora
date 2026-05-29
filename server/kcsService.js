// ─── kcsService.js — Kukora Composite Signal (KCS) ─────────────────────
// Métrica propietaria que combina 7 dimensiones del mercado
// Score 0-100, bias (BULLISH/BEARISH/NEUTRAL), market state

const { percentageChange, stdDev, sma, volatility, momentum, clean, last, totalReturn } = require('./analytics');

const KCS_VERSION = '1.0';

// Calcula RSI simplificado
const rsiSimple = (prices, period = 14) => {
  if (prices.length < period + 1) return 50;
  const changes = prices.slice(1).map((p, i) => p - prices[i]);
  const recent = changes.slice(-period);
  const gains = recent.filter(c => c > 0).reduce((a,b) => a+b, 0) / period;
  const losses = Math.abs(recent.filter(c => c < 0).reduce((a,b) => a+b, 0)) / period;
  if (!losses) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
};

// Normaliza valor a 0-100
const clamp01 = (v, min, max) => Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));

const computeKCS = (pricesArr, volumeArr = null, btcDominance = null, fearGreed = null) => {
  // pricesArr: array de { id, prices } — se espera BTC primero o un solo asset
  const mainPrices = pricesArr[0]?.prices || pricesArr;
  if (!mainPrices || mainPrices.length < 20) {
    return { score: 50, bias: 'NEUTRAL', state: 'UNDEFINED', components: {}, version: KCS_VERSION };
  }

  const returns = clean(percentageChange(mainPrices));

  // ── Componente 1: MOMENTUM (20%) ──────────────────────────────────────
  const mom7  = mainPrices.length > 8  ? (mainPrices[mainPrices.length-1] - mainPrices[mainPrices.length-8])  / mainPrices[mainPrices.length-8]  * 100 : 0;
  const mom14 = mainPrices.length > 15 ? (mainPrices[mainPrices.length-1] - mainPrices[mainPrices.length-15]) / mainPrices[mainPrices.length-15] * 100 : 0;
  const momentumScore = Math.max(0, Math.min(100, 50 + (mom7 * 0.6 + mom14 * 0.4) * 2));

  // ── Componente 2: VOLATILITY (15%) — menor vol = mejor señal ──────────
  const vol14 = stdDev(returns.slice(-14));
  const volScore = Math.max(0, Math.min(100, 100 - vol14 * 8));

  // ── Componente 3: BREADTH (15%) — % assets en positivo ───────────────
  let breadthScore = 50;
  if (pricesArr.length > 1) {
    const positives = pricesArr.filter(a => {
      const p = a.prices;
      return p.length > 1 && p[p.length-1] > p[p.length-2];
    }).length;
    breadthScore = (positives / pricesArr.length) * 100;
  } else {
    // usar retorno del propio asset como proxy
    breadthScore = last(returns) > 0 ? 65 : 35;
  }

  // ── Componente 4: LIQUIDITY / VOLUME ACCELERATION (20%) ──────────────
  // Si no hay vol, usamos estabilidad de precio como proxy
  const liquidityScore = volumeArr && volumeArr.length > 5
    ? Math.min(100, (volumeArr[volumeArr.length-1] / (volumeArr.slice(-7).reduce((a,b)=>a+b,0)/7)) * 50)
    : 50 + Math.min(30, Math.abs(mom7) * 1.5);

  // ── Componente 5: RSI / MOMENTUM QUALITY (15%) ────────────────────────
  const rsi = rsiSimple(mainPrices, 14);
  // RSI óptimo: 45-65 (ni sobrevendido ni sobrecomprado)
  const rsiScore = rsi > 80 ? 20 : rsi < 20 ? 25 : rsi > 65 ? 65 : rsi < 35 ? 45 : 80;

  // ── Componente 6: BTC DOMINANCE (10%) ─────────────────────────────────
  let btcDomScore = 50;
  if (btcDominance != null) {
    // Dom alta (>55%) = risk-off, menos oportunidad altcoins; Dom baja (<40%) = altseason
    btcDomScore = btcDominance > 60 ? 25 : btcDominance > 50 ? 45 : btcDominance < 40 ? 75 : 55;
  }

  // ── Componente 7: SENTIMENT / FEAR-GREED (5%) ─────────────────────────
  const sentimentScore = fearGreed != null ? fearGreed : 50 + (momentumScore - 50) * 0.3;

  // ── Score compuesto ponderado ─────────────────────────────────────────
  const weights = { momentum: 0.20, volatility: 0.15, breadth: 0.15, liquidity: 0.20, rsi: 0.15, btcDom: 0.10, sentiment: 0.05 };
  const score = Math.round(
    momentumScore  * weights.momentum  +
    volScore       * weights.volatility +
    breadthScore   * weights.breadth   +
    liquidityScore * weights.liquidity  +
    rsiScore       * weights.rsi       +
    btcDomScore    * weights.btcDom    +
    sentimentScore * weights.sentiment
  );

  // ── Bias y estado ─────────────────────────────────────────────────────
  let bias, state, color, description;
  if (score >= 72) {
    bias = 'BULLISH'; state = 'RISK ON';
    color = '#00E5A0';
    description = 'Condiciones favorables para exposición alcista. Múltiples señales convergiendo positivamente.';
  } else if (score >= 55) {
    bias = 'BULLISH'; state = 'CAUTIOUSLY BULLISH';
    color = '#4FA3FF';
    description = 'Sesgo positivo moderado. Momentum presente pero confirmar breadth antes de escalar posiciones.';
  } else if (score >= 45) {
    bias = 'NEUTRAL'; state = 'EQUILIBRIUM';
    color = '#FFD166';
    description = 'Señales balanceadas. Mercado en transición. Esperar catalizador direccional.';
  } else if (score >= 30) {
    bias = 'BEARISH'; state = 'CAUTIOUSLY BEARISH';
    color = '#FF8C42';
    description = 'Deterioro gradual de condiciones. Reducir exposición, gestionar riesgo activamente.';
  } else {
    bias = 'BEARISH'; state = 'RISK OFF';
    color = '#FF4D6A';
    description = 'Condiciones adversas. Señales bajistas múltiples. Preservar capital prioritario.';
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    bias,
    state,
    color,
    description,
    rsi: Math.round(rsi),
    components: {
      momentum:    { score: Math.round(momentumScore),  weight: weights.momentum,  label: 'Momentum 7/14d' },
      volatility:  { score: Math.round(volScore),       weight: weights.volatility, label: 'Vol. Stability' },
      breadth:     { score: Math.round(breadthScore),   weight: weights.breadth,   label: 'Market Breadth' },
      liquidity:   { score: Math.round(liquidityScore), weight: weights.liquidity, label: 'Liquidity Flow' },
      rsiQuality:  { score: rsiScore,                   weight: weights.rsi,       label: 'RSI Quality' },
      btcDominance:{ score: Math.round(btcDomScore),    weight: weights.btcDom,    label: 'BTC Dominance' },
      sentiment:   { score: Math.round(sentimentScore), weight: weights.sentiment, label: 'Sentiment' },
    },
    version: KCS_VERSION,
    timestamp: Date.now(),
  };
};

module.exports = { computeKCS, KCS_VERSION };

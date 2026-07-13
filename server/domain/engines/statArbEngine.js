/**
 * statArbEngine.js — Kukora v10 (rewrite completo)
 *
 * PROBLEMA CON LA VERSIÓN ANTERIOR:
 * El Z-score se calculaba sobre `sellEx.bid - buyEx.ask` (diferencia de precios
 * absoluta en USD). Esta señal NO es estacionaria: si BTC sube de $60k a $100k,
 * el mismo "spread" en USD es econométricamente diferente aunque represente el
 * mismo porcentaje. El Z-score sobre una señal no-estacionaria produce falsas
 * mean-reversion signals — exactly what institutional quant models track.
 *
 * SOLUCIÓN — dos cambios fundamentales:
 *
 * 1. SEÑAL: usamos log-spread relativo normalizado por precio mid:
 *      logSpread = log(bidB / askA)   [adimensional, estacionario]
 *    Esto es la representación estándar en pairs trading institucional.
 *    La diferencia: log(70250/70000) ≈ 0.00357 = +0.357% independiente del nivel.
 *
 * 2. COINTEGRACIÓN IMPLÍCITA: en lugar de asumir que todos los pares están
 *    cointegrados, medimos la "persistencia de media" (half-life of mean reversion)
 *    con una regresión AR(1) sobre la serie de log-spreads. Pares con half-life
 *    < 30 periodos son buenos candidatos; pares con half-life > 300 periodos son
 *    simplemente trending y NO deben tratarse como stat-arb.
 *
 * 3. EWMA (Exponentially Weighted Moving Average) para media y varianza,
 *    con lambda configurable. EWMA da más peso a observaciones recientes —
 *    correcto en mercados donde el microestructura cambia rápido.
 *
 * 4. BOLLINGER BANDS sobre el log-spread: además del Z-score puntual,
 *    reportamos si la señal está en la banda superior/inferior, lo que
 *    complementa al Z-score para identificar oportunidades de reversión.
 */

'use strict';

const liveConfig = require('../../infrastructure/liveConfig');

// ── Parámetros (hot-reloadable vía liveConfig — Section 2 audit) ───────────
// Estos ya NO son constantes fijas: cada uso lee liveConfig.get(...) en el
// momento, igual que el resto del motor (opportunityDetection.js, etc.), para
// que ajustar Z_THRESHOLD/WINDOW_SIZE/etc desde la UI tenga efecto real sin
// reiniciar el proceso. Los valores por defecto son exactamente los mismos
// que antes (120 / 0.94 / 2.0 / 2.5 / 30 / 200), así que el comportamiento
// no cambia hasta que alguien los toque.
function WINDOW_SIZE()   { return liveConfig.get('statArbWindowSize'); }
function EWMA_LAMBDA()   { return liveConfig.get('statArbEwmaLambda'); }
function Z_THRESHOLD()   { return liveConfig.get('statArbZThreshold'); }
function Z_STRONG()      { return liveConfig.get('statArbZStrong'); }
function MIN_SAMPLES()   { return liveConfig.get('statArbMinSamples'); }
function MAX_HALF_LIFE() { return liveConfig.get('statArbMaxHalfLife'); }

// ── Estado por par ──────────────────────────────────────────────────────────
// Cada entrada del Map guarda:
//   logSpreads[]  — serie temporal de log-spreads
//   ewmaMean      — EWMA de la media (actualizada incremental)
//   ewmaVar       — EWMA de la varianza (actualizada incremental, más eficiente que recalcular)
//   halfLife      — estimado de half-life de mean-reversion (recalculado cada N períodos)
//   lastRecalcAt  — cuándo se recalculó halfLife por última vez
const _state = new Map();

// ── EWMA incremental ─────────────────────────────────────────────────────────
// Actualiza media y varianza EWMA en O(1) — sin iterar el array en cada tick.
function updateEWMA(state, newValue) {
  if (state.ewmaMean === null) {
    state.ewmaMean = newValue;
    state.ewmaVar  = 0;
    return;
  }
  const lambda  = EWMA_LAMBDA();
  const delta   = newValue - state.ewmaMean;
  state.ewmaMean = lambda * state.ewmaMean + (1 - lambda) * newValue;
  // Varianza EWMA: σ²_t = λ·σ²_{t-1} + (1-λ)·(x_t - μ_{t-1})²
  state.ewmaVar  = lambda * state.ewmaVar + (1 - lambda) * delta * delta;
}

// ── Half-life de mean-reversion via regresión AR(1) ──────────────────────────
// Regresión OLS: ΔS_t = α + β·S_{t-1} + ε
// Half-life = -ln(2) / ln(1 + β)
// Si β ≥ 0 (no mean-reverting) → retornamos Infinity
function estimateHalfLife(series) {
  const n = series.length;
  if (n < 20) return null;

  // S_{t-1} y ΔS_t
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 1; i < n; i++) {
    const x = series[i - 1];
    const y = series[i] - series[i - 1];
    sumX  += x;
    sumY  += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const m = n - 1;
  const denom = m * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return null;

  const beta = (m * sumXY - sumX * sumY) / denom;

  if (beta >= 0) return Infinity; // No mean-reverting
  if (beta <= -2) return 0.1;     // Overshooting (stationarity violated)

  const halfLife = -Math.log(2) / Math.log(1 + beta);
  return Math.max(0.1, halfLife);
}

// ── Bollinger Bands sobre la serie ───────────────────────────────────────────
function bollingerPosition(series, mean, stdDev, multiplier = 2) {
  if (!series.length || stdDev <= 0) return null;
  const last  = series[series.length - 1];
  const upper = mean + multiplier * stdDev;
  const lower = mean - multiplier * stdDev;
  const pct_b = (last - lower) / (upper - lower); // 0=en lower, 1=en upper
  return {
    upper:  +upper.toFixed(6),
    lower:  +lower.toFixed(6),
    pct_b:  +Math.max(0, Math.min(1, pct_b)).toFixed(3),
    aboveUpper: last > upper,
    belowLower: last < lower,
  };
}

// ── updateHistory ─────────────────────────────────────────────────────────────
function updateHistory(buyEx, sellEx, logSpread) {
  const key = `${buyEx}-${sellEx}`;
  if (!_state.has(key)) {
    _state.set(key, {
      logSpreads: [],
      ewmaMean:   null,
      ewmaVar:    null,
      halfLife:   null,
      lastRecalcAt: 0,
    });
  }

  const st = _state.get(key);
  st.logSpreads.push(logSpread);
  if (st.logSpreads.length > WINDOW_SIZE()) st.logSpreads.shift();
  updateEWMA(st, logSpread);

  // Recalcular half-life cada 30 períodos (costoso, no hacer en cada tick)
  const now = Date.now();
  if (st.logSpreads.length >= MIN_SAMPLES() && now - st.lastRecalcAt > 5000) {
    st.halfLife = estimateHalfLife(st.logSpreads);
    st.lastRecalcAt = now;
  }
}

// ── calculateZScore ───────────────────────────────────────────────────────────
function calculateZScore(buyEx, sellEx, currentLogSpread) {
  const key = `${buyEx}-${sellEx}`;
  const st  = _state.get(key);
  if (!st || st.logSpreads.length < MIN_SAMPLES()) return null;
  if (st.ewmaVar === null || st.ewmaVar <= 0) return null;

  const ewmaStd = Math.sqrt(st.ewmaVar);
  if (ewmaStd === 0) return null;

  const zScore   = (currentLogSpread - st.ewmaMean) / ewmaStd;
  const bollinger = bollingerPosition(st.logSpreads, st.ewmaMean, ewmaStd);
  const halfLife  = st.halfLife;

  // Descalificar si el par no es mean-reverting (half-life demasiado largo)
  const isMeanReverting = halfLife !== null && halfLife < MAX_HALF_LIFE() && halfLife !== Infinity;

  return {
    zScore:           +zScore.toFixed(4),
    ewmaMean:         +st.ewmaMean.toFixed(6),
    ewmaStd:          +ewmaStd.toFixed(6),
    halfLife:         halfLife != null && isFinite(halfLife) ? +halfLife.toFixed(1) : null,
    isMeanReverting,
    samples:          st.logSpreads.length,
    bollinger,
  };
}

// ── detectStatArb ─────────────────────────────────────────────────────────────
// ROADMAP NOTE (audit committee, sección 12, punto 1): CHECKPOINT_11.md
// flagged this module as a candidate for an isOpportunity() entry/exit
// check, identified via a `grep buyExchange` heuristic across
// domain/engines/. On inspection this session, that heuristic doesn't
// hold here: detectStatArb() does not receive or enrich an Opportunity at
// all — it builds its own `signal` objects directly from `orderBooks`
// (type: 'stat_arb', logSpread, zScore, ewmaMean, halfLife, bollinger,
// direction, confidence, ...), a genuinely different domain shape driven
// by cointegration/mean-reversion statistics rather than the fee/slippage/
// scoring fields Opportunity carries. It shares `buyExchange`/
// `sellExchange`/`viable` field *names* with Opportunity by coincidence of
// vocabulary, not by shape — isOpportunity() would reject every signal
// this function ever produces (no netProfit/spreadPct fields), so adding
// that check here would only generate permanent false-positive RISK
// noise, not catch real drift. Same reasoning walletManager.ts's
// IncomingTrade docstring already applies to Trade: forcing structural
// identity between two intentionally different shapes is worse than
// leaving them undocumented-but-separate. Deliberately left unmigrated;
// if a future session wants a shared contract for stat-arb signals, it
// should be a new `StatArbSignal` type (mirroring `RiskContext`'s
// creation pattern), not a forced fit into `Opportunity`.
function detectStatArb(orderBooks) {
  const signals = [];
  const valid   = orderBooks.filter(ob => ob.bid && ob.ask && !ob.error && ob.bid > 0 && ob.ask > 0);

  for (let i = 0; i < valid.length; i++) {
    for (let j = 0; j < valid.length; j++) {
      if (i === j) continue;

      const buyEx  = valid[i];
      const sellEx = valid[j];

      // LOG-SPREAD: log(bidB / askA) — estacionario, adimensional, estándar institucional
      // Positivo = existe spread de arbitraje bruto (antes de fees)
      const logSpread = Math.log(sellEx.bid / buyEx.ask);
      const pctSpread = (sellEx.bid - buyEx.ask) / buyEx.ask * 100;

      updateHistory(buyEx.exchange, sellEx.exchange, logSpread);

      const metrics = calculateZScore(buyEx.exchange, sellEx.exchange, logSpread);
      if (!metrics) continue;

      const absZ = Math.abs(metrics.zScore);
      if (absZ <= Z_THRESHOLD()) continue;

      // Solo emitir señal larga (comprar en buyEx, vender en sellEx) cuando Z > 0
      // y señal corta cuando Z < 0. Z > 0 significa logSpread > ewmaMean, es decir,
      // el spread actual es mayor de lo normal — buena condición de arbitraje.
      const isLong     = metrics.zScore > Z_THRESHOLD();    // spread más amplio de lo normal
      const isShort    = metrics.zScore < -Z_THRESHOLD();   // spread más estrecho de lo normal
      const isStrong   = absZ >= Z_STRONG();
      const viable     = isLong && pctSpread > 0;          // necesita spread positivo real además del Z

      // Confianza: compuesta de Z magnitude + isMeanReverting + bollinger confirmation
      let confidence = Math.min(99, absZ * 20);
      if (metrics.isMeanReverting) confidence = Math.min(99, confidence + 10);
      if (metrics.bollinger?.aboveUpper && isLong) confidence = Math.min(99, confidence + 5);
      if (metrics.bollinger?.belowLower && isShort) confidence = Math.min(99, confidence + 5);
      if (!metrics.isMeanReverting) confidence = Math.max(0, confidence - 20); // penalizar trending pairs

      signals.push({
        type:            'stat_arb',
        buyExchange:     buyEx.exchange,
        sellExchange:    sellEx.exchange,
        // Raw spread for execution (the engine needs these)
        diff:            sellEx.bid - buyEx.ask,
        pctSpread:       +pctSpread.toFixed(4),
        // Quant signal fields
        logSpread:       +logSpread.toFixed(6),
        zScore:          metrics.zScore,
        ewmaMean:        metrics.ewmaMean,
        ewmaStd:         metrics.ewmaStd,
        halfLife:        metrics.halfLife,
        isMeanReverting: metrics.isMeanReverting,
        samples:         metrics.samples,
        bollinger:       metrics.bollinger,
        direction:       isLong ? 'long_spread' : 'short_spread',
        isStrong,
        confidence:      +confidence.toFixed(1),
        viable,
      });
    }
  }

  // Ordenar por confianza descendente
  return signals.sort((a, b) => b.confidence - a.confidence);
}

// ── getStatArbSummary ─────────────────────────────────────────────────────────
// Devuelve un resumen del estado de todos los pares rastreados — para el UI
function getStatArbSummary() {
  const pairs = [];
  for (const [key, st] of _state) {
    pairs.push({
      pair:     key,
      samples:  st.logSpreads.length,
      ewmaMean: st.ewmaMean != null ? +st.ewmaMean.toFixed(6) : null,
      halfLife: st.halfLife != null && isFinite(st.halfLife) ? +st.halfLife.toFixed(1) : null,
      isMeanReverting: st.halfLife != null && isFinite(st.halfLife) && st.halfLife < MAX_HALF_LIFE(),
    });
  }
  return pairs;
}

function resetStatArb() {
  _state.clear();
}

module.exports = {
  detectStatArb,
  getStatArbSummary,
  resetStatArb,
};

// Export current parameter values for tests / UI labels as live getters
// (not snapshotted at require() time) — reading statArb.Z_THRESHOLD returns
// liveConfig's current value, so a hot-reloaded change is reflected
// immediately for any consumer that reads the property fresh each time.
Object.defineProperties(module.exports, {
  Z_THRESHOLD:   { enumerable: true, get: Z_THRESHOLD },
  Z_STRONG:      { enumerable: true, get: Z_STRONG },
  MAX_HALF_LIFE: { enumerable: true, get: MAX_HALF_LIFE },
  EWMA_LAMBDA:   { enumerable: true, get: EWMA_LAMBDA },
});

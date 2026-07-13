/**
 * spreadMomentumEngine.js — Kukora v14
 *
 * Problema que resuelve:
 *   El motor bilateral detecta "hay spread X% ahora". Pero si ese spread se está
 *   CERRANDO a 0.05%/segundo, ejecutar puede ser peor que no hacerlo — el fill
 *   llega cuando el spread ya no existe. Si se está ABRIENDO, hay más urgencia.
 *
 * Solución — medir la primera derivada del spread en tiempo real:
 *   momentum = (spread_actual - spread_hace_N_ticks) / elapsed_ms
 *
 * Outputs por par (buyExchange→sellExchange):
 *   velocity     — velocidad de cambio del spread (%/segundo)
 *                  positivo = se está abriendo → ejecutar pronto
 *                  negativo = se está cerrando → cuidado
 *   acceleration — segunda derivada (está acelerando o frenando?)
 *   trend        — 'opening' | 'closing' | 'stable'
 *   urgency      — 0-100: qué tan urgente es ejecutar ahora vs esperar
 *   prediction   — spread estimado en 500ms basado en momentum actual
 *   confidence   — qué tan confiable es la predicción (más muestras = más)
 *
 * Diseño:
 *   Buffer circular de 20 muestras por par (ventana ~3 segundos a 150ms/tick).
 *   Regresión lineal OLS sobre las últimas N muestras para estimar velocidad.
 *   No usa valores random — same inputs always produce same output — fully auditable.
 *
 * Integración:
 *   Se llama desde el priceUpdate handler en arbitrage.routes.js.
 *   El resultado enriquece cada oportunidad detectada con { spreadMomentum }.
 *   No bloquea el pipeline — es O(N) con N≤20, <0.1ms por llamada.
 */

'use strict';

const liveConfig = require('../../infrastructure/liveConfig');
const { isOpportunity } = require('../opportunity');
const obs = require('../../infrastructure/observabilityService');

const BUFFER_SIZE   = 20;    // muestras por par (~3s a 150ms/tick)
const MIN_SAMPLES   = 5;     // minimum sample count to compute momentum
const STABLE_THRESH = 0.0005; // %/s — debajo de esto = estable
// PREDICT_MS: ver liveConfig.get('momentumPredictMs') (item 2, config dinámica)

// Estado por par: { timestamps[], spreads[] }
const _state = new Map();

/**
 * record — registra un nuevo spread para un par.
 * Llamar en cada priceUpdate con el spread bruto actual del par.
 *
 * @param {string} buyExchange
 * @param {string} sellExchange
 * @param {number} spreadPct  — spread bruto en % (puede ser negativo)
 * @param {number} ts         — timestamp ms (Date.now() por defecto)
 */
function record(buyExchange, sellExchange, spreadPct, ts = Date.now()) {
  const key = `${buyExchange}→${sellExchange}`;
  if (!_state.has(key)) {
    _state.set(key, { timestamps: [], spreads: [] });
  }
  const st = _state.get(key);
  st.timestamps.push(ts);
  st.spreads.push(spreadPct);
  if (st.timestamps.length > BUFFER_SIZE) {
    st.timestamps.shift();
    st.spreads.shift();
  }
}

/**
 * OLS lineal: ajusta y = a + b*x sobre arrays x[], y[].
 * Retorna { slope, intercept, r2 }.
 * Usado para estimar la velocidad del spread.
 */
function linearRegression(x, y) {
  const n = x.length;
  if (n < 2) return { slope: 0, intercept: y[0] || 0, r2: 0 };

  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0, sumYY = 0;
  for (let i = 0; i < n; i++) {
    sumX  += x[i];
    sumY  += y[i];
    sumXY += x[i] * y[i];
    sumXX += x[i] * x[i];
    sumYY += y[i] * y[i];
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return { slope: 0, intercept: sumY / n, r2: 0 };

  const slope     = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // R² para medir confianza del ajuste
  const yMean = sumY / n;
  const ssTot = sumYY - n * yMean * yMean;
  const ssRes = (() => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const pred = intercept + slope * x[i];
      s += (y[i] - pred) ** 2;
    }
    return s;
  })();
  const r2 = ssTot > 1e-12 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  return { slope, intercept, r2 };
}

/**
 * getMomentum — calcula el momentum del spread para un par.
 * Retorna null si no hay suficientes muestras.
 *
 * @param {string} buyExchange
 * @param {string} sellExchange
 * @returns {object|null}
 */
function getMomentum(buyExchange, sellExchange) {
  const key = `${buyExchange}→${sellExchange}`;
  const st  = _state.get(key);
  if (!st || st.timestamps.length < MIN_SAMPLES) return null;

  const n    = st.timestamps.length;
  const t0   = st.timestamps[0];

  // Normalizar timestamps a segundos desde el primer punto
  const x = st.timestamps.map(t => (t - t0) / 1000);
  const y = st.spreads;

  const reg = linearRegression(x, y);

  // velocity en %/segundo (slope de la regresión)
  const velocityPctPerSec = reg.slope;

  // Aceleración: comparar la pendiente de la primera mitad vs segunda mitad
  const mid   = Math.floor(n / 2);
  const reg1  = linearRegression(x.slice(0, mid), y.slice(0, mid));
  const reg2  = linearRegression(x.slice(mid),    y.slice(mid));
  const acceleration = reg2.slope - reg1.slope; // positivo = acelerando apertura

  // Trend label
  const absV = Math.abs(velocityPctPerSec);
  const trend = absV < STABLE_THRESH ? 'stable'
    : velocityPctPerSec > 0 ? 'opening'
    : 'closing';

  // Predicción del spread en momentumPredictMs ms
  const elapsed  = (st.timestamps[n - 1] - t0) / 1000;
  const currentPredicted = reg.intercept + reg.slope * elapsed;
  const futureElapsed    = elapsed + liveConfig.get('momentumPredictMs') / 1000;
  const predictedSpread  = reg.intercept + reg.slope * futureElapsed;

  // Urgency 0-100:
  //   - Si el spread se está cerrando rápido → baja urgencia de esperar (ejecuta ya)
  //   - Si se está abriendo → puede valer la pena esperar un tick más
  //   - Si es estable → urgencia media
  let urgency = 50;
  if (trend === 'closing') {
    // Cuánto más rápido se cierra = más urgente ejecutar AHORA
    urgency = Math.min(95, 50 + Math.abs(velocityPctPerSec) * 1000);
  } else if (trend === 'opening') {
    // Se está abriendo → menos urgente, puede mejorar
    urgency = Math.max(10, 50 - Math.abs(velocityPctPerSec) * 500);
  }

  // Confianza basada en R² y número de muestras
  const sampleConfidence = Math.min(100, (n / BUFFER_SIZE) * 100);
  const confidence       = +(reg.r2 * 0.7 * 100 + sampleConfidence * 0.3).toFixed(1);

  return {
    pair:              key,
    velocityPctPerSec: +velocityPctPerSec.toFixed(6),  // %/s
    acceleration:      +acceleration.toFixed(6),
    trend,                                               // 'opening' | 'closing' | 'stable'
    urgency:           Math.round(urgency),             // 0-100
    predictedSpread:   +predictedSpread.toFixed(4),    // % estimado en 500ms
    currentPredicted:  +currentPredicted.toFixed(4),  // % estimado regresión en t=now (validación OLS)
    currentSpread:     +y[n - 1].toFixed(4),           // spread actual
    rSquared:          +reg.r2.toFixed(3),             // calidad del ajuste OLS
    confidence:        Math.min(99, Math.round(confidence)),
    samples:           n,
  };
}

/**
 * enrichOpportunity — agrega spreadMomentum a una oportunidad detectada.
 * No-op si no hay suficientes muestras todavía.
 */
function enrichOpportunity(opp) {
  // Contract check (audit committee, sección 12, punto 1): entry point
  // where this engine consumes an Opportunity built by
  // opportunityDetection.js. Non-blocking — see the matching check in
  // opportunityDetection.js for the full rationale.
  if (!isOpportunity(opp)) {
    obs.emit('RISK', 'contract.opportunity_shape_invalid', { id: opp.id, buyExchange: opp.buyExchange, sellExchange: opp.sellExchange, source: 'spreadMomentumEngine' });
  }

  const momentum = getMomentum(opp.buyExchange, opp.sellExchange);
  if (!momentum) return opp;
  return { ...opp, spreadMomentum: momentum };
}

/**
 * enrichOpportunities — enriquece un array de oportunidades.
 */
function enrichOpportunities(opportunities) {
  return opportunities.map(enrichOpportunity);
}

/**
 * getAllMomentums — resumen de todos los pares rastreados.
 * Para el panel de UI.
 */
function getAllMomentums() {
  const result = [];
  for (const [key] of _state) {
    const [buy, sell] = key.split('→');
    const m = getMomentum(buy, sell);
    if (m) result.push(m);
  }
  return result.sort((a, b) => Math.abs(b.velocityPctPerSec) - Math.abs(a.velocityPctPerSec));
}

/**
 * recordFromOrderBooks — helper para llamar desde el pipeline.
 * Registra spreads para todos los pares posibles de un array de order books.
 */
function recordFromOrderBooks(orderBooks, ts = Date.now()) {
  const valid = orderBooks.filter(ob => ob.bid > 0 && ob.ask > 0 && !ob.error);
  for (let i = 0; i < valid.length; i++) {
    for (let j = 0; j < valid.length; j++) {
      if (i === j) continue;
      const spreadPct = (valid[j].bid - valid[i].ask) / valid[i].ask * 100;
      record(valid[i].exchange, valid[j].exchange, spreadPct, ts);
    }
  }
}

function reset() {
  _state.clear();
}

module.exports = {
  record,
  getMomentum,
  enrichOpportunity,
  enrichOpportunities,
  getAllMomentums,
  recordFromOrderBooks,
  reset,
};

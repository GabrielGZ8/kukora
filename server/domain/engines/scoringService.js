// ─── scoringService.js ────────────────────────────────────────────────────
// Score compuesto 0-100 por ASSET (Intelligence page, market screening).
// NOTE: This is NOT the arbitrage opportunity scoring system.
//       Arbitrage opportunity scoring lives in opportunityDetection.js detectOpportunities().
// Input:  assets: [{ id, name, prices, volume24h?, marketCap? }]
// Output: [{ asset, score, label, breakdown }] ordenado desc
//
// CHECKPOINT_13 — evaluado para la migración de contrato Opportunity/Trade
// (punto 1 de la hoja de ruta) y descartado explícitamente, mismo criterio
// que statArbEngine.js en CHECKPOINT_12: scoreAssets() recibe
// { id, name, prices, volume24h?, marketCap? } y devuelve
// { id, name, score, label, breakdown } — ningún campo de Opportunity
// (buyExchange/sellExchange/netProfit/spreadPct/viable) existe en ninguno
// de los dos extremos. No hay drift posible de un contrato que nunca
// comparte. Agregar isOpportunity() aquí rechazaría el 100% de las
// llamadas reales y no detectaría nada.

const { volatility, momentum, totalReturn, last, clean } = require('../analytics/analytics');

// Pesos por defecto — se pueden pisar al llamar scoreAssets(assets, { weights })
const DEFAULT_WEIGHTS = {
  momentum:    0.30,
  volatility:  0.25,   // menor volatilidad = mejor score (estabilidad)
  performance: 0.25,
  volume:      0.20,
};

// Normaliza un array de valores a 0-100 (min-max scaling)
const normalize = (values) => {
  const c = clean(values);
  if (!c.length) return values.map(() => 0);
  const min = Math.min(...c);
  const max = Math.max(...c);
  if (max === min) return values.map(() => 50);
  return values.map(v => v == null ? 0 : Math.round(((v - min) / (max - min)) * 100));
};

const scoreAssets = (assets, opts = {}) => {
  const weights = { ...DEFAULT_WEIGHTS, ...opts.weights };

  // Extraer métricas crudas
  const raw = assets.map(({ id, name, prices, volume24h = 0, marketCap = 0 }) => {
    if (!prices || prices.length < 5) {
      return { id, name, mom: 0, vol: 0, perf: 0, volume: volume24h };
    }
    const mom  = last(clean(momentum(prices, Math.min(10, prices.length - 1)))) || 0;
    const vol  = last(clean(volatility(prices, Math.min(14, prices.length - 1)))) || 0;
    const perf = totalReturn(prices);
    return { id, name, mom, vol, vol_raw: vol, perf, volume: volume24h || marketCap };
  });

  // Normalizar cada dimensión
  const moms   = normalize(raw.map(r => r.mom));
  const vols   = normalize(raw.map(r => r.vol)).map(v => 100 - v); // invertida: menos vol = mejor
  const perfs  = normalize(raw.map(r => r.perf));
  const vols24 = normalize(raw.map(r => r.volume));

  return raw.map((r, i) => {
    const breakdown = {
      momentum:    moms[i],
      volatility:  vols[i],
      performance: perfs[i],
      volume:      vols24[i],
    };
    const score = Math.round(
      breakdown.momentum    * weights.momentum +
      breakdown.volatility  * weights.volatility +
      breakdown.performance * weights.performance +
      breakdown.volume      * weights.volume
    );
    const label = score >= 75 ? 'High Opportunity'
                : score >= 50 ? 'Moderate'
                : score >= 25 ? 'Low Signal'
                :               'Avoid';
    const labelColor = score >= 75 ? 'green' : score >= 50 ? 'blue' : score >= 25 ? 'yellow' : 'red';

    return { id: r.id, name: r.name, score, label, labelColor, breakdown };
  }).sort((a, b) => b.score - a.score);
};

module.exports = { scoreAssets, DEFAULT_WEIGHTS };

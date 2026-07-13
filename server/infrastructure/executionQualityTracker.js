/**
 * executionQualityTracker.js — Kukora v15
 *
 * Responde: ¿el sistema ejecuta tan bien como predice?
 *
 * Por cada trade ejecutado compara:
 *   - slippage estimado (del VWAP walk pre-ejecución)
 *   - spread detectado (en el momento de la señal)
 *   - spread real obtenido (precio fill real vs precio señal)
 *   - net profit estimado vs net profit real
 *
 * Con suficientes trades calcula:
 *   - slippage bias: ¿sobreestima o subestima el sistema el slippage real?
 *   - spread decay: ¿cuánto % del spread detectado desaparece para cuando se ejecuta?
 *   - fill rate: ¿qué % de trades se llenan al precio estimado?
 *   - calibration score: qué tan bien calibrado está el modelo (0-100)
 *
 * Usa esto para ajustar dinámicamente el SLIPPAGE_RATE del engine:
 *   Si el slippage real es consistentemente 20% menor que el estimado,
 *   el sistema puede ser más agresivo en el umbral de viabilidad.
 *
 * Persiste en MongoDB para análisis histórico entre sesiones.
 */

'use strict';

const mongoose = require('mongoose');

// Audit fix 1.3: schema moved to server/models/ExecutionRecord.js (centralized
// model directory) so every mongoose.model() call in the project lives in one
// place instead of being scattered across 8 files.
const ExecutionRecord = require('./persistence/models/ExecutionRecord');

function isMongoReady() {
  return mongoose.connection.readyState === 1;
}

// ─── Buffer en memoria ────────────────────────────────────────────────────
const _records = [];
const MAX_RECORDS = 500;

/**
 * recordTrade — llamar después de cada trade ejecutado.
 *
 * @param {object} signal  — oportunidad que disparó la señal (pre-ejecución)
 * @param {object} result  — resultado real del executeSimulated
 */
async function recordTrade(signal, result) {
  if (!signal || !result) return;

  const estimatedNet  = signal.netProfit  || 0;
  const actualNet     = result.netProfit  || result.trade?.netProfit || 0;
  const estimatedSlip = (signal.buySlippage || 0) + (signal.sellSlippage || 0);
  const actualSlip    = (result.trade?.buySlippage || 0) + (result.trade?.sellSlippage || 0);
  const spreadDecay   = +(estimatedNet - actualNet).toFixed(4);
  const slippageBias  = +(estimatedSlip - actualSlip).toFixed(4);

  const record = {
    ts:              new Date(),
    pair:            `${signal.buyExchange}→${signal.sellExchange}`,
    asset:           signal.asset || 'BTC',
    estimatedSpread: signal.spreadPct    || 0,
    estimatedSlip,
    estimatedNet,
    actualNet,
    spreadDecay,
    slippageBias,
    score:           signal.score        || 0,
    positionSize:    signal.positionSizing?.size || signal.tradeAmount || 0.05,
  };

  _records.push(record);
  if (_records.length > MAX_RECORDS) _records.shift();

  // Persistir async — nunca bloquear el pipeline
  if (isMongoReady()) {
    ExecutionRecord.create(record).catch(() => {});
  }
}

/**
 * getQualityMetrics — análisis de calidad de ejecución.
 * Separa por asset (BTC vs ETH) y por par.
 */
async function getQualityMetrics(n = 50) {
  let records = _records.slice(-n);

  // Complementar con MongoDB si tenemos pocos registros en memoria
  if (records.length < 5 && isMongoReady()) {
    try {
      const dbRecords = await ExecutionRecord
        .find().sort({ ts: -1 }).limit(n).lean();
      // Merge sin duplicar (por ts)
      const memTs = new Set(records.map(r => r.ts?.toISOString?.() || String(r.ts)));
      for (const r of dbRecords) {
        if (!memTs.has(new Date(r.ts).toISOString())) records.push(r);
      }
      records = records.slice(-n);
    } catch { /* MongoDB no disponible o query fallida — continuar con registros en memoria */ }
  }

  if (!records.length) return { count: 0, calibrated: false };

  const nets     = records.map(r => r.actualNet);
  const decays   = records.map(r => r.spreadDecay);
  const slipBias = records.map(r => r.slippageBias);
  const avg      = arr => arr.reduce((s, v) => s + v, 0) / arr.length;

  // Calibration score 0-100
  // 100 = estimados == reales en promedio
  // Penalise if there is systematic bias (consistently over- or under-estimates)
  const avgDecay    = avg(decays);
  const avgSlipBias = avg(slipBias);
  const biasScore   = Math.max(0, 100 - Math.abs(avgDecay) * 500 - Math.abs(avgSlipBias) * 300);

  // Fill rate: trades where actualNet > estimatedNet * 0.8 (reached 80% of estimate)
  const goodFills = records.filter(r => r.actualNet >= r.estimatedNet * 0.8).length;
  const fillRate  = +(goodFills / records.length * 100).toFixed(1);

  // Slippage adjustment factor: if actual < estimated systematically, we can be more aggressive
  const slippageAdjustment = records.length >= 10
    ? +(1 - (avgSlipBias / (records.reduce((s, r) => s + r.estimatedSlip, 0) / records.length || 1))).toFixed(3)
    : 1.0;

  // Por par
  const byPair = {};
  for (const r of records) {
    if (!byPair[r.pair]) byPair[r.pair] = { count: 0, totalNet: 0, totalDecay: 0 };
    byPair[r.pair].count++;
    byPair[r.pair].totalNet   += r.actualNet;
    byPair[r.pair].totalDecay += r.spreadDecay;
  }
  for (const p of Object.keys(byPair)) {
    byPair[p].avgNet   = +(byPair[p].totalNet   / byPair[p].count).toFixed(4);
    byPair[p].avgDecay = +(byPair[p].totalDecay / byPair[p].count).toFixed(4);
  }

  // Por asset
  const btcRecords = records.filter(r => r.asset === 'BTC' || !r.asset);
  const ethRecords = records.filter(r => r.asset === 'ETH');

  return {
    count:               records.length,
    calibrated:          records.length >= 10,
    avgActualNet:        +avg(nets).toFixed(4),
    avgSpreadDecay:      +avgDecay.toFixed(4),
    avgSlippageBias:     +avgSlipBias.toFixed(4),
    fillRate,
    calibrationScore:    Math.round(biasScore),
    slippageAdjustment,  // >1 = actual slippage lower than estimated → we can be more aggressive
    byPair,
    byAsset: {
      BTC: btcRecords.length ? { count: btcRecords.length, avgNet: +avg(btcRecords.map(r => r.actualNet)).toFixed(4) } : null,
      ETH: ethRecords.length ? { count: ethRecords.length, avgNet: +avg(ethRecords.map(r => r.actualNet)).toFixed(4) } : null,
    },
    recent: records.slice(-5).map(r => ({
      ts:   r.ts, pair: r.pair, asset: r.asset,
      estimatedNet: r.estimatedNet, actualNet: r.actualNet,
      spreadDecay: r.spreadDecay, score: r.score,
    })),
  };
}

function getRecords(n = 50) {
  return _records.slice(-n);
}

function reset() {
  _records.length = 0;
}

module.exports = { recordTrade, getQualityMetrics, getRecords, reset };

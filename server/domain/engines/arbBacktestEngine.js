/**
 * arbBacktestEngine.js — Kukora v10
 *
 * PROBLEMA CON EL BACKTEST ANTERIOR:
 * El backtestEngine.js original corre SMA Crossover, RSI, Bollinger sobre
 * precios de BTC desde CoinGecko. Eso no tiene ninguna relación con la
 * estrategia de arbitraje que evalúa el challenge.
 *
 * ESTE MÓDULO responde la pregunta real:
 * "Con los datos de mercado que vimos en esta sesión, ¿cuál combinación de
 * parámetros habría maximizado el profit neto?"
 *
 * METODOLOGÍA:
 * 1. PARAMETER SWEEP sobre el opportunityLog real de sesión
 * 2. WALK-FORWARD VALIDATION: entrena en 70%, valida en 30%
 * 3. STRESS SCENARIOS: fees ×1.5, ×2, ×3 sobre los mejores parámetros
 * 4. PAIR ANALYSIS: qué pares fueron más rentables
 */
'use strict';

const { stdDev } = require('../analytics/analytics');
const { isOpportunityLogEntry } = require('../opportunity');
const obs = require('../../infrastructure/observabilityService');

// ─── Core simulation ────────────────────────────────────────────────────────

function simulateRun(opLog, params, initialCapital = 100_000) {
  const { minScore = 65, cooldownMs = 3000, feeMultiplier = 1.0 } = params;

  let equity     = initialCapital;
  let lastExecTs = 0;
  const executions  = [];
  const equityCurve = [];
  const pairStats   = {};

  for (const op of opLog) {
    // Contract check (audit roadmap: OpportunityLogEntry as a named type,
    // see domain/opportunity.ts). Soft validation — same pattern as the
    // isOpportunity() check in opportunityDetection.js: emits a RISK event
    // instead of throwing, so a shape drift is visible in observability/tests
    // without ever taking the backtest engine down.
    if (!isOpportunityLogEntry(op)) {
      obs.emit('RISK', 'contract.opportunity_log_entry_shape_invalid', { pair: op?.pair });
    }
    if (!op.viable) continue;
    const opTs = new Date(op.ts).getTime();

    // Apply fee stress: fees reduce net profit proportionally
    const adjustedNetProfit = feeMultiplier === 1.0
      ? (op.netProfit || 0)
      : (op.netProfit || 0) - Math.abs(op.netProfit || 0) * (feeMultiplier - 1) * 0.5;

    const passes = op.score >= minScore && (opTs - lastExecTs) >= cooldownMs;

    if (!pairStats[op.pair]) pairStats[op.pair] = { executed: 0, missed: 0, totalProfit: 0 };

    if (passes) {
      equity += adjustedNetProfit;
      lastExecTs = opTs;
      executions.push({ ts: op.ts, pair: op.pair, netProfit: +adjustedNetProfit.toFixed(4), score: op.score, spreadPct: op.spreadPct, equityAfter: +equity.toFixed(2) });
      pairStats[op.pair].executed++;
      pairStats[op.pair].totalProfit += adjustedNetProfit;
      equityCurve.push({ ts: op.ts, equity: +equity.toFixed(2) });
    } else {
      pairStats[op.pair].missed++;
    }
  }

  if (!executions.length) return { params, totalNetProfit: 0, tradesExecuted: 0, captureRate: 0, sharpeRatio: 0, maxDrawdown: 0, profitFactor: 0, avgNetProfitPerTrade: 0, pairStats, equityCurve: [], executions: [] };

  const profits  = executions.map(e => e.netProfit);
  const winners  = profits.filter(p => p > 0);
  const losers   = profits.filter(p => p <= 0);
  const totalNetProfit = +profits.reduce((s, p) => s + p, 0).toFixed(4);

  const profitFactor = losers.length && Math.abs(losers.reduce((s, p) => s + p, 0)) > 0
    ? +(winners.reduce((s, p) => s + p, 0) / Math.abs(losers.reduce((s, p) => s + p, 0))).toFixed(2)
    : winners.length ? 999 : 0;

  const returns  = equityCurve.slice(1).map((pt, i) => (pt.equity - equityCurve[i].equity) / equityCurve[i].equity * 100);
  const meanR    = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
  const stdR     = stdDev(returns) || 1;
  const sharpeRatio = +(meanR / stdR * Math.sqrt(252)).toFixed(3);

  let peak = initialCapital, maxDd = 0;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = (peak - pt.equity) / peak * 100;
    if (dd > maxDd) maxDd = dd;
  }

  const totalViable = opLog.filter(o => o.viable).length;

  return {
    params,
    totalNetProfit,
    tradesExecuted:           executions.length,
    totalViableOpportunities: totalViable,
    captureRate:              totalViable > 0 ? +((executions.length / totalViable) * 100).toFixed(1) : 0,
    sharpeRatio,
    maxDrawdown:              +maxDd.toFixed(2),
    profitFactor,
    avgNetProfitPerTrade:     +(totalNetProfit / executions.length).toFixed(4),
    winRate:                  winners.length > 0 ? +(winners.length / executions.length * 100).toFixed(1) : 0,
    pairStats,
    equityCurve,
    executions,
  };
}

// ─── Walk-forward validation ─────────────────────────────────────────────────

function walkForward(opLog, params, trainRatio = 0.7) {
  const splitIdx = Math.floor(opLog.length * trainRatio);
  const wf = {
    train:    simulateRun(opLog.slice(0, splitIdx), params),
    validate: simulateRun(opLog.slice(splitIdx), params),
    params,
  };
  wf.sharpeStability = wf.validate.sharpeRatio > 0 && wf.train.sharpeRatio > 0
    ? +(wf.validate.sharpeRatio / wf.train.sharpeRatio).toFixed(3) : null;
  return wf;
}

// ─── Parameter sweep ─────────────────────────────────────────────────────────

const SWEEP_GRID = {
  minScore:      [50, 55, 60, 65, 70, 75, 80],
  cooldownMs:    [1000, 2000, 3000, 5000, 8000],
  feeMultiplier: [1.0],
};

function parameterSweep(opLog) {
  if (!opLog || opLog.length < 10) return { error: 'Datos insuficientes — se necesitan al menos 10 entradas en el opportunity log', results: [] };
  const viable = opLog.filter(o => o.viable);
  if (viable.length < 5) return { error: 'Se necesitan al menos 5 oportunidades viables para el sweep', results: [] };

  const results = [];
  for (const minScore of SWEEP_GRID.minScore) {
    for (const cooldownMs of SWEEP_GRID.cooldownMs) {
      const params = { minScore, cooldownMs, feeMultiplier: 1.0 };
      const wf = walkForward(opLog, params);
      results.push({
        params,
        train:           wf.train,
        validate:        wf.validate,
        sharpeStability: wf.sharpeStability,
        compositeScore: (
          (wf.validate.totalNetProfit * 0.4) +
          (wf.validate.sharpeRatio * 50) +
          (wf.validate.captureRate * 0.3) -
          (wf.validate.maxDrawdown * 2)
        ),
      });
    }
  }

  results.sort((a, b) => b.compositeScore - a.compositeScore);
  const best = results[0];

  const stressScenarios = best ? [1.5, 2.0, 3.0].map(feeMultiplier => ({
    feeMultiplier,
    label: `Fees ×${feeMultiplier}`,
    result: simulateRun(opLog, { ...best.params, feeMultiplier }),
  })) : [];

  const currentConfigResult = simulateRun(opLog, { minScore: 65, cooldownMs: 3000, feeMultiplier: 1.0 });

  return {
    totalOpsAnalyzed: opLog.length,
    viableOps:        viable.length,
    best: best ? {
      params:          best.params,
      netProfit:       best.validate.totalNetProfit,
      sharpe:          best.validate.sharpeRatio,
      maxDrawdown:     best.validate.maxDrawdown,
      captureRate:     best.validate.captureRate,
      trades:          best.validate.tradesExecuted,
      sharpeStability: best.sharpeStability,
    } : null,
    currentConfig:  currentConfigResult,
    topResults:     results.slice(0, 10),
    stressScenarios,
    sweepGrid:      SWEEP_GRID,
  };
}

// ─── Pair analysis ────────────────────────────────────────────────────────────

function pairAnalysis(opLog) {
  const byPair = {};
  for (const op of opLog) {
    if (!byPair[op.pair]) byPair[op.pair] = { seen: 0, viable: 0, profits: [], slipMethods: {} };
    const p = byPair[op.pair];
    p.seen++;
    if (op.viable) {
      p.viable++;
      p.profits.push(op.netProfit || 0);
    }
    p.slipMethods[op.slipMethod || 'unknown'] = (p.slipMethods[op.slipMethod || 'unknown'] || 0) + 1;
  }

  return Object.entries(byPair).map(([pair, d]) => ({
    pair,
    seen:           d.seen,
    viable:         d.viable,
    viableRate:     d.seen > 0 ? +((d.viable / d.seen) * 100).toFixed(1) : 0,
    avgNetProfit:   d.profits.length ? +(d.profits.reduce((s, p) => s + p, 0) / d.profits.length).toFixed(4) : null,
    bestNetProfit:  d.profits.length ? +Math.max(...d.profits).toFixed(4) : null,
    totalProfit:    d.profits.length ? +d.profits.reduce((s, p) => s + p, 0).toFixed(4) : 0,
    dominantSlipMethod: Object.entries(d.slipMethods).sort((a, b) => b[1] - a[1])[0]?.[0],
  })).sort((a, b) => (b.totalProfit || 0) - (a.totalProfit || 0));
}

// ─── Session summary ──────────────────────────────────────────────────────────

function sessionSummary(opLog) {
  if (!opLog || !opLog.length) return null;
  const viable   = opLog.filter(o => o.viable);
  const avgSpread = viable.length ? viable.reduce((s, o) => s + (o.spreadPct || 0), 0) / viable.length : 0;
  const avgScore  = viable.length ? viable.reduce((s, o) => s + (o.score || 0), 0) / viable.length : 0;

  const buckets = {};
  for (const op of viable) {
    const d = new Date(op.ts);
    const bucket = `${d.getHours()}:${String(Math.floor(d.getMinutes() / 5) * 5).padStart(2, '0')}`;
    buckets[bucket] = (buckets[bucket] || 0) + 1;
  }

  return {
    totalOps:        opLog.length,
    viableOps:       viable.length,
    viableRate:      opLog.length > 0 ? +((viable.length / opLog.length) * 100).toFixed(1) : 0,
    avgViableSpread: +avgSpread.toFixed(4),
    avgViableScore:  +avgScore.toFixed(1),
    bestOpportunity: viable.reduce((best, o) => (!best || (o.netProfit || 0) > (best.netProfit || 0)) ? o : best, null),
    temporalBuckets: Object.entries(buckets).sort((a, b) => a[0].localeCompare(b[0])).map(([time, count]) => ({ time, count })),
    pairAnalysis:    pairAnalysis(opLog),
  };
}

module.exports = { simulateRun, walkForward, parameterSweep, pairAnalysis, sessionSummary, SWEEP_GRID };

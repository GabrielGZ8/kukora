/**
 * institutionalBacktest.js — Kukora v17
 *
 * Section 16: Institutional-grade backtesting metrics.
 *
 * Adds to the existing arbBacktestEngine.js:
 *   - Sharpe Ratio (annualized, risk-free rate configurable)
 *   - Sortino Ratio (downside deviation only)
 *   - Calmar Ratio (return / max drawdown)
 *   - Profit Factor (gross wins / gross losses)
 *   - Max Drawdown % and recovery factor
 *   - Expectancy (expected P&L per trade)
 *   - Win Rate
 *   - Average Win / Average Loss
 *   - Kelly Criterion (optimal position sizing)
 *   - Value at Risk (95th percentile loss)
 *   - Omega Ratio
 *   - Time-in-drawdown %
 *
 * Also generates institutional performance report structure
 * suitable for LP/investor reporting.
 */

'use strict';

const { isSimResult } = require('./simResult');
const obs = require('../../infrastructure/observabilityService');

const RISK_FREE_RATE_ANNUAL = parseFloat(process.env.RISK_FREE_RATE || '0.05'); // 5% default

// ─── Core statistics ──────────────────────────────────────────────────────

function computeReturns(equityCurve) {
  if (equityCurve.length < 2) return [];
  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    const curr = equityCurve[i].equity;
    if (prev > 0) returns.push((curr - prev) / prev);
  }
  return returns;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

/**
 * Sharpe Ratio — annualized.
 * Measures risk-adjusted return relative to risk-free rate.
 * Periods per year: if each equity point is one trade, use 252 * tradesPerDay.
 * If unclear, we normalize by trade count → annualize using sqrt(252).
 */
function sharpeRatio(returns, periodsPerYear = 252) {
  if (returns.length < 2) return null;
  const rf   = RISK_FREE_RATE_ANNUAL / periodsPerYear;
  const excess = returns.map(r => r - rf);
  const m    = mean(excess);
  const s    = stddev(excess);
  return s === 0 ? null : +(m / s * Math.sqrt(periodsPerYear)).toFixed(4);
}

/**
 * Sortino Ratio — annualized.
 * Like Sharpe but only penalizes downside volatility.
 */
function sortinoRatio(returns, periodsPerYear = 252) {
  if (returns.length < 2) return null;
  const rf      = RISK_FREE_RATE_ANNUAL / periodsPerYear;
  const excess  = returns.map(r => r - rf);
  const m       = mean(excess);
  const downside = excess.filter(r => r < 0);
  if (downside.length === 0) return m > 0 ? 999 : 0;
  const ds = Math.sqrt(downside.reduce((s, v) => s + v ** 2, 0) / downside.length);
  return ds === 0 ? null : +(m / ds * Math.sqrt(periodsPerYear)).toFixed(4);
}

/**
 * Max Drawdown — percentage peak-to-trough decline.
 */
function maxDrawdown(equityCurve) {
  if (equityCurve.length < 2) return { pct: 0, peakTs: null, troughTs: null, durationTrades: 0 };

  let peak      = equityCurve[0].equity;
  let peakIdx   = 0;
  let maxDd     = 0;
  let maxDdPeakIdx  = 0;
  let maxDdTroughIdx = 0;

  for (let i = 1; i < equityCurve.length; i++) {
    if (equityCurve[i].equity > peak) {
      peak    = equityCurve[i].equity;
      peakIdx = i;
    }
    const dd = (peak - equityCurve[i].equity) / peak;
    if (dd > maxDd) {
      maxDd          = dd;
      maxDdPeakIdx   = peakIdx;
      maxDdTroughIdx = i;
    }
  }

  return {
    pct:          +(maxDd * 100).toFixed(4),
    peakEquity:   equityCurve[maxDdPeakIdx]?.equity,
    troughEquity: equityCurve[maxDdTroughIdx]?.equity,
    peakTs:       equityCurve[maxDdPeakIdx]?.ts || null,
    troughTs:     equityCurve[maxDdTroughIdx]?.ts || null,
    durationTrades: maxDdTroughIdx - maxDdPeakIdx,
  };
}

/**
 * Recovery Factor — total return / max drawdown.
 * Values > 1 indicate strategy recovered more than it lost at worst.
 */
function recoveryFactor(totalReturn, maxDrawdownPct) {
  if (maxDrawdownPct === 0) return totalReturn > 0 ? 999 : 0;
  return +(totalReturn / maxDrawdownPct).toFixed(4);
}

/**
 * Calmar Ratio — annualized return / max drawdown.
 * Industry standard for CTA/fund performance attribution.
 */
function calmarRatio(annualizedReturnPct, maxDrawdownPct) {
  if (maxDrawdownPct === 0) return annualizedReturnPct > 0 ? 999 : 0;
  return +(annualizedReturnPct / maxDrawdownPct).toFixed(4);
}

/**
 * Profit Factor — gross wins / |gross losses|.
 * > 1 means strategy is net profitable.
 * > 2 is considered good; > 3 is excellent.
 */
function profitFactor(profits) {
  const wins   = profits.filter(p => p > 0).reduce((s, p) => s + p, 0);
  const losses = Math.abs(profits.filter(p => p < 0).reduce((s, p) => s + p, 0));
  if (losses === 0) return wins > 0 ? 999 : 0;
  return +(wins / losses).toFixed(4);
}

/**
 * Expectancy — average expected P&L per trade.
 * = (Win Rate × Avg Win) - (Loss Rate × Avg Loss)
 */
function expectancy(profits) {
  if (!profits.length) return { value: 0, winRate: 0, avgWin: 0, avgLoss: 0 };
  const wins   = profits.filter(p => p > 0);
  const losses = profits.filter(p => p <= 0);
  const winRate  = wins.length / profits.length;
  const lossRate = 1 - winRate;
  const avgWin   = wins.length  ? mean(wins)   : 0;
  const avgLoss  = losses.length ? Math.abs(mean(losses)) : 0;
  const value    = winRate * avgWin - lossRate * avgLoss;
  return {
    value:    +value.toFixed(4),
    winRate:  +(winRate * 100).toFixed(2),
    lossRate: +(lossRate * 100).toFixed(2),
    avgWin:   +avgWin.toFixed(4),
    avgLoss:  +avgLoss.toFixed(4),
    edgeRatio: avgLoss > 0 ? +(avgWin / avgLoss).toFixed(3) : null,
  };
}

/**
 * Kelly Criterion — optimal fraction of capital per trade.
 * f* = (p × b - q) / b   where b = avg_win/avg_loss, p = win_rate, q = 1-p
 * In practice, use half-Kelly (f* divided by 2) to account for estimation error.
 */
function kellyCriterion(profits) {
  const e = expectancy(profits);
  if (e.avgLoss === 0 || e.winRate === 0) return { fullKelly: null, halfKelly: null };
  const b = e.avgWin / e.avgLoss;
  const p = e.winRate / 100;
  const q = 1 - p;
  const fullKelly = (p * b - q) / b;
  return {
    fullKelly:  +(fullKelly * 100).toFixed(2),
    halfKelly:  +(fullKelly / 2 * 100).toFixed(2),
    suggestion: fullKelly > 0
      ? `Risk ${(fullKelly / 2 * 100).toFixed(1)}% of capital per trade (half-Kelly)`
      : 'Negative edge — do not trade this parameter set',
  };
}

/**
 * Value at Risk (95th percentile) — worst expected loss in 95% of trades.
 */
function valueAtRisk95(profits) {
  if (profits.length < 5) return null;
  const sorted = [...profits].sort((a, b) => a - b);
  const idx    = Math.floor(sorted.length * 0.05);
  return +sorted[idx].toFixed(4);
}

/**
 * Omega Ratio — probability-weighted ratio of gains to losses above/below threshold.
 * threshold = 0 (break-even). Values > 1 indicate positive expectancy.
 */
function omegaRatio(returns, threshold = 0) {
  if (returns.length < 5) return null;
  const above = returns.filter(r => r > threshold).reduce((s, r) => s + (r - threshold), 0);
  const below = Math.abs(returns.filter(r => r < threshold).reduce((s, r) => s + (r - threshold), 0));
  if (below === 0) return above > 0 ? 999 : 1;
  return +(above / below).toFixed(4);
}

/**
 * Time-in-drawdown — percentage of periods spent below previous peak.
 */
function timeInDrawdown(equityCurve) {
  if (equityCurve.length < 2) return 0;
  let peak          = equityCurve[0].equity;
  let periodsInDd   = 0;
  for (const pt of equityCurve) {
    if (pt.equity >= peak) {
      peak = pt.equity;
    } else {
      periodsInDd++;
    }
  }
  return +((periodsInDd / equityCurve.length) * 100).toFixed(2);
}

// ─── Full institutional metrics ───────────────────────────────────────────

/**
 * Compute all institutional performance metrics from a simulation result.
 *
 * @param {object} simResult — output of simulateRun() from arbBacktestEngine
 * @param {number} initialCapital
 * @returns {object} institutionalMetrics
 */
function computeInstitutionalMetrics(simResult, initialCapital = 100_000) {
  // Contract check (audit roadmap #1: SimResult as a named shared type
  // between the two producers of this parameter — arbBacktestEngine.
  // simulateRun() and performanceReport.generateJsonReport()). Soft
  // validation — same pattern as isOpportunityLogEntry() in
  // arbBacktestEngine.js: emits a RISK event instead of throwing, so a
  // shape drift is visible in observability/tests without taking either
  // producer's caller down.
  if (!isSimResult(simResult)) {
    obs.emit('RISK', 'contract.sim_result_shape_invalid', {
      hasExecutions:  Array.isArray(simResult?.executions),
      hasEquityCurve: Array.isArray(simResult?.equityCurve),
    });
  }

  const { executions = [], equityCurve = [], params = {} } = simResult;

  if (!executions.length || equityCurve.length < 2) {
    return {
      error:          'Insufficient data for institutional metrics (need at least 2 equity points)',
      minRequired:    2,
      available:      equityCurve.length,
    };
  }

  const profits = executions.map(e => e.netProfit || 0);
  const returns = computeReturns(equityCurve);

  // Assume each trade = 1 "period", annualize at 252 trading days
  // For intraday arb: use 252 * 24 if hourly, 252 * 288 if 5-min
  const periodsPerYear = 252;

  const ddResult     = maxDrawdown(equityCurve);
  const totalReturn  = ((equityCurve[equityCurve.length - 1].equity - initialCapital) / initialCapital) * 100;
  const annualized   = totalReturn * (periodsPerYear / Math.max(executions.length, 1));

  const sharpe       = sharpeRatio(returns, periodsPerYear);
  const sortino      = sortinoRatio(returns, periodsPerYear);
  const calmar       = calmarRatio(annualized, ddResult.pct);
  const pf           = profitFactor(profits);
  const exp          = expectancy(profits);
  const kelly        = kellyCriterion(profits);
  const var95        = valueAtRisk95(profits);
  const omega        = omegaRatio(returns);
  const timeInDd     = timeInDrawdown(equityCurve);
  const rf           = recoveryFactor(totalReturn, ddResult.pct);

  const wins         = profits.filter(p => p > 0);
  const losses       = profits.filter(p => p <= 0);

  return {
    // --- Summary ---
    initialCapital,
    finalCapital:     +equityCurve[equityCurve.length - 1].equity.toFixed(2),
    totalNetProfit:   +simResult.totalNetProfit.toFixed(4),
    totalReturn:      +totalReturn.toFixed(4),      // %
    annualizedReturn: +annualized.toFixed(4),        // %

    // --- Trade statistics ---
    totalTrades:      executions.length,
    winningTrades:    wins.length,
    losingTrades:     losses.length,
    winRate:          +((wins.length / executions.length) * 100).toFixed(2),
    avgNetProfit:     +((profits.reduce((s,p)=>s+p,0)/executions.length)).toFixed(4),
    avgWin:           wins.length   ? +(wins.reduce((s,p)=>s+p,0)/wins.length).toFixed(4) : 0,
    avgLoss:          losses.length ? +(losses.reduce((s,p)=>s+p,0)/losses.length).toFixed(4) : 0,
    bestTrade:        +(Math.max(...profits)).toFixed(4),
    worstTrade:       +(Math.min(...profits)).toFixed(4),
    largestWinStreak: longestStreak(profits, true),
    largestLossStreak:longestStreak(profits, false),

    // --- Risk-adjusted performance ---
    sharpeRatio:      sharpe,
    sortinoRatio:     sortino,
    calmarRatio:      calmar,
    omegaRatio:       omega,

    // --- Drawdown ---
    maxDrawdownPct:   ddResult.pct,
    maxDrawdownPeak:  ddResult.peakEquity,
    maxDrawdownTrough:ddResult.troughEquity,
    maxDrawdownDurationTrades: ddResult.durationTrades,
    timeInDrawdownPct: timeInDd,
    recoveryFactor:   rf,

    // --- Profitability ---
    profitFactor:     pf,
    expectancy:       exp,
    valueAtRisk95:    var95,

    // --- Sizing recommendation ---
    kellyCriterion:   kelly,

    // --- Context ---
    params,
    riskFreeRateAnnual: RISK_FREE_RATE_ANNUAL,
    periodsPerYear,

    // --- Performance grade ---
    grade: computePerformanceGrade(sharpe, pf, exp.winRate),
  };
}

function longestStreak(profits, wins) {
  let longest = 0, current = 0;
  for (const p of profits) {
    if (wins ? p > 0 : p <= 0) { current++; longest = Math.max(longest, current); }
    else current = 0;
  }
  return longest;
}

function computePerformanceGrade(sharpe, pf, winRate) {
  let score = 0;
  if (sharpe !== null) {
    if (sharpe > 3)       score += 4;
    else if (sharpe > 2)  score += 3;
    else if (sharpe > 1)  score += 2;
    else if (sharpe > 0)  score += 1;
  }
  if (pf > 3)       score += 3;
  else if (pf > 2)  score += 2;
  else if (pf > 1)  score += 1;
  if (winRate > 70) score += 3;
  else if (winRate > 55) score += 2;
  else if (winRate > 45) score += 1;

  if (score >= 8)  return { grade: 'A+', label: 'Institutional Excellent', score };
  if (score >= 6)  return { grade: 'A',  label: 'Institutional Good',      score };
  if (score >= 4)  return { grade: 'B',  label: 'Acceptable',              score };
  if (score >= 2)  return { grade: 'C',  label: 'Marginal',                score };
  return              { grade: 'D',  label: 'Below Threshold',         score };
}

/**
 * Generate a structured institutional performance report.
 * Suitable for LP/investor/due-diligence presentations.
 */
function generateInstitutionalReport(simResult, initialCapital = 100_000) {
  const metrics = computeInstitutionalMetrics(simResult, initialCapital);
  if (metrics.error) return { error: metrics.error };

  return {
    reportVersion: '2.0',
    generatedAt:   new Date().toISOString(),
    strategy: {
      name:       'Kukora Cross-Exchange Arbitrage',
      type:       'Statistical Arbitrage / Market Making',
      universe:   'BTC/USDT spot, 5 exchanges',
      parameters: simResult.params,
    },
    performance: {
      returns: {
        totalNetProfit:   metrics.totalNetProfit,
        totalReturnPct:   metrics.totalReturn,
        annualizedReturnPct: metrics.annualizedReturn,
        finalCapital:     metrics.finalCapital,
      },
      riskAdjusted: {
        sharpeRatio:   metrics.sharpeRatio,
        sortinoRatio:  metrics.sortinoRatio,
        calmarRatio:   metrics.calmarRatio,
        omegaRatio:    metrics.omegaRatio,
        interpretation: interpretRatios(metrics),
      },
      drawdown: {
        maxDrawdownPct:        metrics.maxDrawdownPct,
        recoveryFactor:        metrics.recoveryFactor,
        timeInDrawdownPct:     metrics.timeInDrawdownPct,
        maxDrawdownDuration:   `${metrics.maxDrawdownDurationTrades} trades`,
      },
    },
    tradeStatistics: {
      totalTrades:       metrics.totalTrades,
      winRate:           metrics.winRate,
      profitFactor:      metrics.profitFactor,
      expectancy:        metrics.expectancy,
      averageWin:        metrics.avgWin,
      averageLoss:       metrics.avgLoss,
      bestTrade:         metrics.bestTrade,
      worstTrade:        metrics.worstTrade,
      winStreak:         metrics.largestWinStreak,
      lossStreak:        metrics.largestLossStreak,
    },
    riskManagement: {
      valueAtRisk95:     metrics.valueAtRisk95,
      kellyCriterion:    metrics.kellyCriterion,
      impliedLeverage:   metrics.kellyCriterion?.halfKelly
        ? `${(100 / metrics.kellyCriterion.halfKelly).toFixed(1)}x max leverage implied`
        : null,
    },
    grade: metrics.grade,
    disclaimer: 'Simulated performance. Past results do not guarantee future returns. This report is for informational purposes only.',
  };
}

function interpretRatios(metrics) {
  const lines = [];
  if (metrics.sharpeRatio !== null) {
    if (metrics.sharpeRatio > 2) lines.push('Excellent risk-adjusted returns (Sharpe > 2)');
    else if (metrics.sharpeRatio > 1) lines.push('Good risk-adjusted returns (Sharpe > 1)');
    else if (metrics.sharpeRatio > 0) lines.push('Positive but modest risk-adjusted returns');
    else lines.push('Risk-adjusted returns below risk-free rate');
  }
  if (metrics.profitFactor > 2) lines.push('High profit factor indicates robust edge');
  if (metrics.timeInDrawdownPct > 50) lines.push('Strategy spends significant time in drawdown — consider improving exit criteria');
  return lines;
}

module.exports = {
  computeInstitutionalMetrics,
  generateInstitutionalReport,
  sharpeRatio,
  sortinoRatio,
  calmarRatio,
  profitFactor,
  expectancy,
  kellyCriterion,
  maxDrawdown,
  recoveryFactor,
  valueAtRisk95,
  omegaRatio,
  timeInDrawdown,
};

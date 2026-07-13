/**
 * capitalEfficiency.js — Kukora v1
 *
 * Mejora #4: "Capital efficiency metric".
 * Mejora #6: "Rebalance cost simulator".
 *
 * El modelo pre-funded bilateral (wallets ya fondeadas en los 5 exchanges)
 * es correcto técnicamente, pero esconde una métrica crítica: el ROI real
 * no debe medirse sobre el profit por trade, sino sobre el CAPITAL TOTAL
 * inmovilizado para poder operar. Tener $1.1M USD bloqueados generando
 * $50/día es un retorno anualizado muy distinto a lo que sugiere "ganamos
 * dinero en cada trade". Este módulo calcula esa métrica explícitamente.
 *
 * También cierra el loop del modelo de costos: el modelo pre-funded evita
 * fees de transferencia por trade, pero acumula un desequilibrio entre
 * exchanges con el tiempo (BTC se mueve de "compra" a "venta" exchanges,
 * USDT al revés) que eventualmente requiere rebalanceo. Aquí se proyecta
 * cuándo ocurrirá ese rebalanceo y cuánto costará, en tiempo real, en base
 * a los trades reales ejecutados en la sesión (no un número fijo inventado).
 */

const { WITHDRAWAL_FEES, REBALANCING_INTERVAL_HOURS } = require('./feeConfig');

const ALL_EXCHANGES = ['Binance', 'Kraken', 'Bybit', 'OKX', 'Coinbase'];

/**
 * computeCapitalEfficiency — the headline metric.
 *
 * @param wallets    current balances { BTC: {ex: amt}, USDT: {ex: amt} }
 * @param btcPrice   current best BTC price for USD valuation
 * @param pnlData    output of walletManager.getPnL() — needs totalTrades, realizedPnl
 * @param uptimeMs   how long the bot has been running this session
 */
function computeCapitalEfficiency(wallets, btcPrice, pnlData, uptimeMs) {
  if (!btcPrice || btcPrice <= 0) {
    return { capitalDeployedUSD: null, roiAnnualizedPct: null, infraBreakEvenDays: null, error: 'no_btc_price' };
  }

  const totalBtc  = Object.values(wallets.BTC  || {}).reduce((s, v) => s + (v || 0), 0);
  const totalUsdt = Object.values(wallets.USDT || {}).reduce((s, v) => s + (v || 0), 0);
  const capitalDeployedUSD = totalBtc * btcPrice + totalUsdt;

  const realizedPnl   = pnlData?.realizedPnl ?? pnlData?.totalPnl ?? 0;
  const totalTrades   = pnlData?.totalTrades ?? 0;
  const uptimeHours    = Math.max(uptimeMs / 3_600_000, 1 / 60); // floor at 1 minute to avoid divide-by-near-zero blowups

  // Daily profit rate extrapolated from the session so far. This is explicitly
  // a projection based on observed session performance — NOT a guarantee.
  const profitPerHour  = realizedPnl / uptimeHours;
  const profitPerDayProjected = profitPerHour * 24;
  const profitPerYearProjected = profitPerDayProjected * 365;

  const roiAnnualizedPct = capitalDeployedUSD > 0
    ? (profitPerYearProjected / capitalDeployedUSD) * 100
    : null;

  // Infra break-even: assuming an illustrative fixed monthly infra cost
  // (server + monitoring + API access), how many days of current session
  // performance would it take to cover it. Configurable via env so the
  // person presenting can plug in their real number instead of a guess.
  const MONTHLY_INFRA_COST_USD = parseFloat(process.env.MONTHLY_INFRA_COST_USD || '150');
  const infraBreakEvenDays = profitPerDayProjected > 0
    ? +(MONTHLY_INFRA_COST_USD / profitPerDayProjected).toFixed(1)
    : null;

  return {
    capitalDeployedUSD:      +capitalDeployedUSD.toFixed(2),
    totalBtcHeld:            +totalBtc.toFixed(6),
    totalUsdtHeld:           +totalUsdt.toFixed(2),
    realizedPnlSession:      +realizedPnl.toFixed(4),
    totalTradesSession:      totalTrades,
    profitPerHourProjected:  +profitPerHour.toFixed(4),
    profitPerDayProjected:   +profitPerDayProjected.toFixed(2),
    profitPerYearProjected:  +profitPerYearProjected.toFixed(2),
    roiAnnualizedPct:        roiAnnualizedPct != null ? +roiAnnualizedPct.toFixed(3) : null,
    monthlyInfraCostUSD:     MONTHLY_INFRA_COST_USD,
    infraBreakEvenDays,
    uptimeHours:             +uptimeHours.toFixed(2),
    note: totalTrades < 5
      ? 'Projection based on very few trades — high uncertainty, will improve with more session data.'
      : null,
  };
}

/**
 * computeRebalanceProjection — Mejora #6.
 *
 * Tracks, per exchange, how far the BTC/USDT balance has drifted from its
 * starting point as a result of real executed trades, and projects when a
 * rebalance will be "needed" (defined as: any exchange's BTC or USDT balance
 * has drifted more than REBALANCE_DRIFT_THRESHOLD_PCT from its initial value).
 *
 * This is computed live from the actual wallets vs the actual initial
 * balances passed in — no synthetic drift is assumed.
 */
const REBALANCE_DRIFT_THRESHOLD_PCT = parseFloat(process.env.REBALANCE_DRIFT_THRESHOLD_PCT || '15');

function computeRebalanceProjection(wallets, initialBalances, tradeHistory, btcPrice) {
  const drifts = ALL_EXCHANGES.map(ex => {
    const btcNow  = wallets.BTC?.[ex]  ?? 0;
    const btcInit = initialBalances.BTC?.[ex]  ?? 0;
    const usdtNow  = wallets.USDT?.[ex] ?? 0;
    const usdtInit = initialBalances.USDT?.[ex] ?? 0;

    const btcDriftPct  = btcInit  > 0 ? Math.abs((btcNow  - btcInit)  / btcInit)  * 100 : 0;
    const usdtDriftPct = usdtInit > 0 ? Math.abs((usdtNow - usdtInit) / usdtInit) * 100 : 0;

    return { exchange: ex, btcDriftPct: +btcDriftPct.toFixed(2), usdtDriftPct: +usdtDriftPct.toFixed(2) };
  });

  const maxDrift = drifts.reduce((m, d) => Math.max(m, d.btcDriftPct, d.usdtDriftPct), 0);
  const rebalanceNeeded = maxDrift >= REBALANCE_DRIFT_THRESHOLD_PCT;

  // Project hours-until-rebalance using the drift rate observed so far this
  // session (linear extrapolation from real trade history — not a guess).
  let hoursUntilRebalance = null;
  if (tradeHistory.length >= 3 && !rebalanceNeeded) {
    const firstTs = new Date(tradeHistory[0].ts).getTime();
    const lastTs  = new Date(tradeHistory[tradeHistory.length - 1].ts).getTime();
    const elapsedHours = Math.max((lastTs - firstTs) / 3_600_000, 1 / 60);
    const driftRatePerHour = maxDrift / elapsedHours;
    if (driftRatePerHour > 0) {
      const remainingDrift = REBALANCE_DRIFT_THRESHOLD_PCT - maxDrift;
      hoursUntilRebalance = +(remainingDrift / driftRatePerHour).toFixed(1);
    }
  }

  // Estimated cost of one rebalancing round: withdrawal fees to move BTC back
  // from "sell" exchanges to "buy" exchanges, and USDT the other way. We
  // estimate using the two exchanges with the largest drift (in opposite
  // directions) as the pair that needs rebalancing.
  const sortedByBtcDrift = [...drifts].sort((a, b) => b.btcDriftPct - a.btcDriftPct);
  const candidateA = sortedByBtcDrift[0]?.exchange;
  const candidateB = sortedByBtcDrift[sortedByBtcDrift.length - 1]?.exchange;
  let estimatedRebalanceCostUSD = null;
  if (candidateA && candidateB && candidateA !== candidateB && btcPrice) {
    const wfA = WITHDRAWAL_FEES[candidateA] || { BTC: 0.0003, USDT: 6 };
    const wfB = WITHDRAWAL_FEES[candidateB] || { BTC: 0.0003, USDT: 6 };
    estimatedRebalanceCostUSD = +((wfA.BTC + wfB.BTC) * btcPrice + (wfA.USDT + wfB.USDT)).toFixed(2);
  }

  return {
    drifts,
    maxDriftPct: +maxDrift.toFixed(2),
    rebalanceThresholdPct: REBALANCE_DRIFT_THRESHOLD_PCT,
    rebalanceNeeded,
    hoursUntilRebalance,
    estimatedRebalanceCostUSD,
    rebalancingIntervalHoursDocumented: REBALANCING_INTERVAL_HOURS,
  };
}

module.exports = { computeCapitalEfficiency, computeRebalanceProjection, ALL_EXCHANGES };

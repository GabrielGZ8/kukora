'use strict';
/**
 * rebalanceScheduler.js — Kukora (refinamiento post-Sesión 34, Área 3 —
 * "Gestión de wallets y rebalanceo": ¿el sistema mantiene un balance
 * operativo entre exchanges de forma inteligente y automatizada?)
 *
 * GAP: antes de este módulo, `rebalanceEngine.executeRebalance()` solo era
 * alcanzable desde `POST /api/arbitrage/rebalance/execute` — un humano tenía
 * que abrir el panel, notar el desbalance, y hacer click. El motor ya
 * calculaba sugerencias (`suggestRebalance`) y las exponía en tiempo real,
 * pero nunca actuaba solo. Este scheduler cierra ese gap con una política
 * deliberadamente conservadora:
 *
 *   1. Off por default (`liveConfig.autoRebalanceEnabled`) — mover fondos
 *      reales entre exchanges tiene consecuencias (fees de retiro, ventanas
 *      de iliquidez) que un operador debe habilitar explícitamente.
 *   2. Solo actúa sobre la severidad configurada como piso
 *      (`autoRebalanceMinSeverity`, default 'high') — un desbalance 'low' o
 *      'medium' se sigue mostrando en el panel para revisión manual.
 *   3. Cooldown obligatorio (`autoRebalanceCooldownMs`, default 30 min)
 *      entre ejecuciones automáticas, incluso si el desbalance persiste —
 *      evita “rebalanceo en bucle” si el mercado sigue moviendo fondos de
 *      vuelta al mismo exchange.
 *   4. Cada ejecución automática es tan visible como cualquier alerta
 *      operativa real (`alertWebhookService.alertAutoRebalanceExecuted` +
 *      evento de observabilidad) — nunca un movimiento silencioso.
 *   5. Igual que el resto del sistema (persistenceService, exchangeService),
 *      cualquier fallo en el ciclo se traga de forma no-fatal — un rebalanceo
 *      automático que falla una vez no debe tumbar el proceso ni bloquear
 *      el siguiente ciclo.
 */

const liveConfig = require('../../infrastructure/liveConfig');
const observability = require('../../infrastructure/observabilityService');
const rebalanceEngine = require('./rebalanceEngine');
const alertWebhookService = require('../../infrastructure/alertWebhookService');
const backgroundJobs = require('../../infrastructure/backgroundJobs');

const SEVERITY_RANK = { low: 0, medium: 1, high: 2 };

let _lastAutoExecutionTs = 0;

/**
 * Un solo ciclo del scheduler — expuesto también para tests y para un
 * eventual "ejecutar ahora" manual. No lanza; cualquier error se loggea vía
 * observability y el ciclo simplemente no actúa esta vez.
 * @param {number} btcPrice - precio actual de BTC, para valorar wallets
 */
async function runAutoRebalanceCycle(btcPrice) {
  try {
    if (!liveConfig.get('autoRebalanceEnabled')) return { acted: false, reason: 'disabled' };

    const cooldownMs = liveConfig.get('autoRebalanceCooldownMs');
    const sinceLastMs = Date.now() - _lastAutoExecutionTs;
    if (sinceLastMs < cooldownMs) {
      return { acted: false, reason: 'cooldown', remainingMs: cooldownMs - sinceLastMs };
    }

    const minSeverity = liveConfig.get('autoRebalanceMinSeverity');
    const minRank = SEVERITY_RANK[minSeverity] ?? SEVERITY_RANK.high;

    const { suggestions, analysis } = rebalanceEngine.suggestRebalance(btcPrice);
    // `analysis.imbalances` no viene ordenado por severidad (se llena en
    // orden de detección: USDT concentration primero, luego BTC) — hay que
    // escanear todo el array para encontrar la severidad más alta real, no
    // asumir que el primer elemento es el peor.
    const worstSeverity = (analysis?.imbalances || [])
      .reduce((worst, imb) => (SEVERITY_RANK[imb.severity] ?? -1) > (SEVERITY_RANK[worst] ?? -1) ? imb.severity : worst, null);
    const worstRank = SEVERITY_RANK[worstSeverity] ?? -1;

    if (worstRank < minRank) {
      return { acted: false, reason: 'below_severity_threshold', worstSeverity };
    }

    const topSuggestion = (suggestions || []).find(s => s.viable);
    if (!topSuggestion) {
      return { acted: false, reason: 'no_viable_suggestion', worstSeverity };
    }

    const result = rebalanceEngine.executeRebalance(topSuggestion, btcPrice);
    if (!result.ok) {
      observability.emit('REBALANCE', 'rebalance.auto_execute_failed', { reason: result.reason, suggestion: topSuggestion }, 'warn');
      return { acted: false, reason: result.reason || 'execute_failed' };
    }

    _lastAutoExecutionTs = Date.now();
    observability.emit('REBALANCE', 'rebalance.auto_executed', {
      asset: topSuggestion.asset, from: topSuggestion.from, to: topSuggestion.to,
      amount: topSuggestion.amount, severity: worstSeverity,
    }, 'info');

    alertWebhookService.alertAutoRebalanceExecuted({
      asset: topSuggestion.asset, from: topSuggestion.from, to: topSuggestion.to,
      amount: topSuggestion.amount, feeUSD: topSuggestion.fee, severity: worstSeverity,
      reason: `Automatic imbalance correction (severity: ${worstSeverity})`,
    }).catch(() => {});

    return { acted: true, suggestion: topSuggestion, severity: worstSeverity };
  } catch (e) {
    observability.emit('REBALANCE', 'rebalance.auto_cycle_error', { error: e.message }, 'warn');
    return { acted: false, reason: 'error', error: e.message };
  }
}

/**
 * Arranca el loop periódico. `getBtcPrice` es una función inyectada (mismo
 * patrón que `persistenceService.startPeriodicFlush(getSnapshotFn, ms)`) en
 * vez de importar arbitrage.state directamente, para no crear una
 * dependencia circular entre domain/ y application/.
 *
 * Migrated onto the backgroundJobs framework (server/infrastructure/
 * backgroundJobs.js) so this cycle's status/failures show up in the same
 * /api/ops dashboard as every other job, instead of being an invisible
 * bespoke setInterval. Behavior is unchanged: same cycle function
 * (runAutoRebalanceCycle), same default interval, same idempotent
 * start/stop contract — only the scheduling mechanism moved.
 */
const JOB_NAME = 'rebalance.autoCycle';

function startAutoRebalanceLoop(getBtcPrice, intervalMs = 60_000) {
  if (backgroundJobs.getJobStatus(JOB_NAME)) return; // idempotente
  backgroundJobs.registerJob(JOB_NAME, async () => {
    const btcPrice = typeof getBtcPrice === 'function' ? getBtcPrice() : 50000;
    await runAutoRebalanceCycle(btcPrice || 50000);
  }, { intervalMs, retries: 0, timeoutMs: 15_000 });
}

function stopAutoRebalanceLoop() {
  backgroundJobs.unregisterJob(JOB_NAME);
}

// Test-only seams.
function _resetForTests() { _lastAutoExecutionTs = 0; }
function getLastAutoExecutionTs() { return _lastAutoExecutionTs; }
// Alias kept for the tests already written against this name.
function _getLastAutoExecutionTsForTests() { return _lastAutoExecutionTs; }

module.exports = {
  runAutoRebalanceCycle,
  startAutoRebalanceLoop,
  stopAutoRebalanceLoop,
  getLastAutoExecutionTs,
  _resetForTests,
  _getLastAutoExecutionTsForTests,
};

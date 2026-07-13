"use strict";
/**
 * rebalance.ts — Shared types for rebalanceEngine.js (auditoría de comité
 * 2026-07-08, hoja de ruta #1). Tercero de los 5 motores nombrados
 * explícitamente en la sección 2 del documento como "sin contrato común"
 * en cerrarse (después de MarketRegimeResult y MultiHopCycle).
 *
 * Compiles to server/domain/engines/rebalance.js.
 *
 * rebalanceEngine.js no se migró completo a TypeScript en esta ronda (es
 * el motor más grande de los 4 restantes con lógica de ejecución real de
 * transferencias — un refactor completo a .ts es un cambio de mayor riesgo
 * que merece su propia sesión dedicada, no un pase apurado). En su lugar,
 * este archivo satélite define los 3 contratos de salida que SÍ tienen
 * consumidores externos reales hoy:
 *   - `server/arbitrage/subroutes/config.routes.js` (3 endpoints HTTP)
 *   - `server/domain/engines/rebalanceScheduler.js` (scheduler automático)
 *
 * DISEÑO: cada interfaz cubre exactamente los campos que
 * `analyzeBalance()`/`suggestRebalance()`/`executeRebalance()` construyen
 * hoy — leído contra el código real, no asumido. `BalanceImbalance` es una
 * unión discriminada por `type` (igual que `DrawdownCheckResult` en
 * advancedRiskEngine); `RebalanceSuggestionResult` y
 * `ExecuteRebalanceResult` son uniones discriminadas por `needed`/`ok`
 * respectivamente, siguiendo el mismo patrón ya usado en el resto del
 * dominio.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isBalanceAnalysis = isBalanceAnalysis;
exports.isRebalanceSuggestionResult = isRebalanceSuggestionResult;
exports.isExecuteRebalanceResult = isExecuteRebalanceResult;
function isBalanceAnalysis(obj) {
    if (typeof obj !== 'object' || obj === null)
        return false;
    const a = obj;
    return Array.isArray(a.imbalances)
        && typeof a.healthy === 'boolean'
        && typeof a.highCount === 'number'
        && typeof a.summary === 'object' && a.summary !== null
        && typeof a.summary.totalUSD === 'number'
        && Array.isArray(a.summary.byExchange);
}
function isRebalanceSuggestionResult(obj) {
    if (typeof obj !== 'object' || obj === null)
        return false;
    const r = obj;
    if (typeof r.needed !== 'boolean' || typeof r.reason !== 'string')
        return false;
    if (!isBalanceAnalysis(r.analysis))
        return false;
    if (r.needed === true)
        return Array.isArray(r.suggestions);
    return true;
}
function isExecuteRebalanceResult(obj) {
    if (typeof obj !== 'object' || obj === null)
        return false;
    const r = obj;
    if (typeof r.ok !== 'boolean')
        return false;
    if (r.ok === false)
        return typeof r.reason === 'string';
    return typeof r.id === 'string' && typeof r.entry === 'object' && r.entry !== null;
}

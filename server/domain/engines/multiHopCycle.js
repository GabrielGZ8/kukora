"use strict";
/**
 * multiHopCycle.ts — Shared MultiHopCycle / MultiHopDetectionResult types
 * (auditoría de comité 2026-07-08, hoja de ruta #1, continuación de la
 * ronda que ya cerró `OpportunityLogEntry`, `SimResult` y
 * `MarketRegimeResult`). `multiHopArbitrageEngine.js` es el segundo de los
 * 5 motores nombrados explícitamente en la sección 2 del documento como
 * "sin contrato común" en cerrarse.
 *
 * Compiles to server/domain/engines/multiHopCycle.js.
 *
 * Como con `MarketRegimeResult`, este motor no produce ni consume
 * `Opportunity`/`Trade` — es un algoritmo de grafos (Bellman-Ford sobre un
 * grafo de tasas de cambio entre exchanges) que devuelve su propia forma:
 * un ciclo negativo (ruta + métricas de rentabilidad compuesta) o `null`.
 * Antes de este archivo esa forma era enteramente implícita — el objeto
 * `{ path, hops, totalLogWeight, compoundedMultiplier, compoundedNetPct }`
 * devuelto por `findBestNegativeCycle()` y envuelto por
 * `detectMultiHopArbitrage()` en `{ hasArbitrage, cycle }` no tenía ningún
 * tipo nombrado, pese a ser consumido por
 * `opportunityDetection.js` (`multiHopSignal`).
 *
 * DISEÑO: `MultiHopCycle` cubre exactamente los campos que
 * `findBestNegativeCycle()` construye — ningún consumidor conocido lee
 * menos que esto hoy. `MultiHopDetectionResult` es el wrapper que
 * `detectMultiHopArbitrage()` realmente devuelve (discriminated union:
 * `hasArbitrage:false` siempre trae `cycle:null`).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMultiHopCycle = isMultiHopCycle;
exports.isMultiHopDetectionResult = isMultiHopDetectionResult;
function isMultiHopCycle(obj) {
    if (typeof obj !== 'object' || obj === null)
        return false;
    const c = obj;
    return Array.isArray(c.path)
        && c.path.every((n) => typeof n === 'string')
        && typeof c.hops === 'number'
        && typeof c.totalLogWeight === 'number'
        && typeof c.compoundedMultiplier === 'number'
        && typeof c.compoundedNetPct === 'number';
}
function isMultiHopDetectionResult(obj) {
    if (typeof obj !== 'object' || obj === null)
        return false;
    const r = obj;
    if (typeof r.hasArbitrage !== 'boolean')
        return false;
    if (r.hasArbitrage === false)
        return r.cycle === null;
    return isMultiHopCycle(r.cycle);
}

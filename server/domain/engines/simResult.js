"use strict";
/**
 * simResult.ts — Shared SimResult type (auditoría de comité 2026-07-08,
 * hoja de ruta #1: "definir tipos de dominio únicos e importarlos desde
 * los 10+ motores en vez de que cada uno construya su propio shape").
 *
 * Compiles to server/domain/engines/simResult.js.
 *
 * PROBLEMA QUE CIERRA: `institutionalBacktest.js`
 * (`computeInstitutionalMetrics`/`generateInstitutionalReport`) tiene DOS
 * productores independientes de su parámetro `simResult`, sin ningún
 * contrato común entre ellos:
 *
 *   1. `arbBacktestEngine.simulateRun()` — el productor "real", con
 *      `executions`/`equityCurve`/`totalNetProfit`/`params` MÁS un montón
 *      de campos adicionales (`tradesExecuted`, `sharpeRatio`, `pairStats`,
 *      etc.) que institutionalBacktest.js nunca lee.
 *   2. `performanceReport.generateJsonReport()` — construye un objeto
 *      literal mínimo `{ executions, equityCurve, totalNetProfit, params }`
 *      a mano, derivado de `auditedPnl.getAuditedPnl()`, sin ningún tipo
 *      compartido que garantice que esa forma mínima sigue siendo válida
 *      si `computeInstitutionalMetrics()` cambia qué campos lee.
 *
 * Antes de este tipo, un cambio en cualquiera de los dos productores (o en
 * el consumidor) podía romper el otro lado en silencio — exactamente el
 * patrón de "forma implícita compartida" que motivó `isOpportunity()`/
 * `isTrade()` (domain/opportunity.ts) y `isOpportunityLogEntry()` en
 * sesiones anteriores, ahora aplicado al dominio de backtesting.
 *
 * DISEÑO: el contrato es deliberadamente MÍNIMO — solo los 4 campos que
 * `computeInstitutionalMetrics()`/`generateInstitutionalReport()`
 * realmente leen (ver server/domain/engines/institutionalBacktest.js).
 * Cualquier campo adicional que `simulateRun()` produzca (sharpeRatio,
 * pairStats, tradesExecuted, ...) es válido y se preserva, pero no forma
 * parte del contrato — un tercer productor futuro no necesita replicar
 * TODO lo que `simulateRun()` calcula, solo esta forma mínima.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSimResult = isSimResult;
/**
 * Runtime type guard — checks the minimum fields
 * `computeInstitutionalMetrics()`/`generateInstitutionalReport()` read
 * before calling them, so a shape drift in either producer surfaces as an
 * explicit signal instead of a silent `undefined.length` crash three
 * frames deep in `maxDrawdown()`/`sharpeRatio()`.
 */
function isSimResult(obj) {
    if (typeof obj !== 'object' || obj === null)
        return false;
    const o = obj;
    return (Array.isArray(o['executions']) &&
        Array.isArray(o['equityCurve']) &&
        typeof o['totalNetProfit'] === 'number' &&
        typeof o['params'] === 'object' && o['params'] !== null);
}

"use strict";
/**
 * backtestResult.ts — Shared BacktestStrategyResult/BacktestRunResult types
 * (auditoría de comité 2026-07-08, hoja de ruta #1: "definir tipos de
 * dominio únicos e importarlos desde los 10+ motores en vez de que cada
 * uno construya su propio shape").
 *
 * Compiles to server/domain/engines/backtestResult.js.
 *
 * DESAMBIGUACIÓN (paso 0 obligatorio antes de crear este tipo): existen 3
 * archivos "backtest" en el repo y no son intercambiables:
 *   - `backtestEngine.js`         → simula estrategias técnicas (SMA
 *     crossover / RSI / Bollinger) sobre una serie de precios simple.
 *     Consumido por `datasetService.js` y `crypto.routes.js`
 *     (`/api/crypto/coin/:id/backtest`).
 *   - `arbBacktestEngine.js`      → simula ejecuciones de arbitraje
 *     (`simulateRun()`), productor real de `SimResult` (ver `simResult.ts`).
 *   - `institutionalBacktest.js`  → consume `SimResult` para métricas
 *     institucionales.
 * `backtestEngine.js` NO produce ni consume `SimResult` — no comparte
 * ningún campo con `SimResultExecution`/`SimResultEquityPoint` (no hay
 * `pair`, no hay `netProfit` por ejecución, no hay `totalNetProfit`). Es un
 * dominio genuinamente distinto (curvas de equity + métricas de
 * estrategia técnica vs. ejecuciones de arbitraje), así que reusar
 * `SimResult` acoplaría dos conceptos no relacionados. Este archivo define
 * su propio contrato mínimo en vez de eso.
 *
 * PROBLEMA QUE CIERRA: cada una de las 4 funciones de estrategia
 * (`smaCrossover`, `rsiMeanReversion`, `bollingerBreakout`, `buyAndHold`)
 * y `calcMetrics()` construyen su objeto de retorno a mano, sin ningún
 * contrato que garantice que `runBacktest()`/`runAllStrategies()` siguen
 * devolviendo una forma válida para sus dos consumidores reales
 * (`datasetService.js` lee `btResult.strategy`/`btResult.benchmark`;
 * `crypto.routes.js` hace spread de `result` completo en la respuesta
 * HTTP). Un cambio futuro en cualquier estrategia podría romper ambos
 * consumidores en silencio.
 *
 * DISEÑO: el contrato es deliberadamente MÍNIMO — solo los campos que los
 * 2 consumidores reales leen o que forman el shape estructural mínimo de
 * cada estrategia. Campos adicionales (`params`, `trades`, `open`, etc.)
 * son válidos y se preservan, pero no son parte del contrato.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isBacktestStrategyResult = isBacktestStrategyResult;
exports.isBacktestRunResult = isBacktestRunResult;
/**
 * Runtime type guard for a single strategy result — checks the minimum
 * fields `datasetService.js` (`btResult.strategy`/`btResult.benchmark`)
 * and the frontend (via `crypto.routes.js`'s spread) rely on before
 * treating the object as a valid strategy/benchmark result.
 */
function isBacktestStrategyResult(obj) {
    if (typeof obj !== 'object' || obj === null)
        return false;
    const o = obj;
    return (typeof o['strategy'] === 'string' &&
        Array.isArray(o['equity']) &&
        typeof o['maxDrawdown'] === 'number' &&
        typeof o['totalTrades'] === 'number');
}
/**
 * Runtime type guard for the combined `{ strategy, benchmark }` shape
 * returned by `runBacktest()` — the actual return value consumed by both
 * `datasetService.js` and `crypto.routes.js`.
 */
function isBacktestRunResult(obj) {
    if (typeof obj !== 'object' || obj === null)
        return false;
    const o = obj;
    return isBacktestStrategyResult(o['strategy']) && isBacktestStrategyResult(o['benchmark']);
}

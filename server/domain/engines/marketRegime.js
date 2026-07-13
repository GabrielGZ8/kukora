"use strict";
/**
 * marketRegime.ts — Shared MarketRegimeResult type (auditoría de comité
 * 2026-07-08, hoja de ruta #1, continuación de la ronda que ya cerró
 * `OpportunityLogEntry` y `SimResult`. `marketRegimeEngine.js` es uno de
 * los motores nombrados explícitamente en la sección 2 del documento como
 * "sin contrato común" — este archivo le da un tipo nombrado real).
 *
 * Compiles to server/domain/engines/marketRegime.js.
 *
 * A diferencia de `Opportunity`/`Trade` (que sí comparten forma entre
 * varios motores de arbitraje), `marketRegimeEngine.detectMarketRegime()`
 * opera sobre series de precio crudas, no sobre oportunidades — no tiene
 * sentido forzarle el tipo `Opportunity`. Lo que SÍ necesita, y no tenía
 * hasta ahora, es su PROPIO tipo nombrado para la forma que produce y que
 * consumen `server/routes/crypto.routes.js` y
 * `server/domain/analytics/datasetService.js` — antes de este archivo esa
 * forma era enteramente implícita (un objeto ad-hoc devuelto por
 * `detectMarketRegime()`), exactamente el patrón de deuda que motivó
 * `isOpportunity()` en su momento, aplicado aquí a un motor "satélite"
 * distinto.
 *
 * DISEÑO: el contrato cubre los campos que ambos consumidores conocidos
 * leen — metadata del régimen (`id`/`label`/`color`/`icon`/`description`),
 * más los campos calculados (`confidence`, `signals`, `interpretation`,
 * `breakoutProbability`, `metrics`, `scores`). Ningún consumidor conocido
 * lee menos que esto hoy.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMarketRegimeResult = isMarketRegimeResult;
/**
 * Runtime type guard — self-check en el propio productor
 * (`detectMarketRegime()`/`detectMarketRegimeBatch()` en
 * marketRegimeEngine.js), no en cada consumidor, porque solo hay un
 * productor real de esta forma (a diferencia de `SimResult`, que tenía
 * dos). Verifica los campos que ambos consumidores conocidos
 * (`crypto.routes.js`, `datasetService.js`) leen antes de reenviar el
 * resultado.
 */
function isMarketRegimeResult(obj) {
    if (typeof obj !== 'object' || obj === null)
        return false;
    const o = obj;
    return (typeof o['id'] === 'string' &&
        typeof o['label'] === 'string' &&
        typeof o['confidence'] === 'number' &&
        Array.isArray(o['signals']) &&
        typeof o['interpretation'] === 'string');
}

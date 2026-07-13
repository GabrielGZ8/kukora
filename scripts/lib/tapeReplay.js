'use strict';

/**
 * scripts/lib/tapeReplay.js — Iniciativa 3 del plan competitivo (tape
 * recorder / experiment sweep offline).
 *
 * PROBLEMA: `arbBacktestEngine.parameterSweep()` / `simulateRun()` solo
 * pueden operar sobre `getOpportunityLog()` — el log en memoria que se
 * llena mientras el bot corre EN VIVO contra el mercado real. Eso hace
 * imposible repetir un experimento de parámetros sobre las MISMAS
 * condiciones de mercado dos veces (el mercado ya se movió), o
 * compartir un dataset de prueba reproducible entre sesiones.
 *
 * SOLUCIÓN: grabar snapshots crudos de order books a un archivo (JSON
 * Lines, uno por línea — ver `scripts/tapeRecorder.js`), y luego
 * "reproducir" esa grabación a través del MISMO motor de detección real
 * (`opportunityDetection.detectOpportunities()`, no una reimplementación
 * paralela) para reconstruir un opportunity log determinístico que
 * `parameterSweep()`/`simulateRun()` puedan consumir sin depender de que
 * el mercado esté vivo en ese momento.
 *
 * DISEÑO: este módulo es la lógica PURA y testeable — recibe los
 * snapshots ya parseados y una función `detectOpportunities` inyectada
 * (mismo patrón de inyección de dependencias que
 * `statisticalValidation.validateEdge(opLog, { simulateRun, ... })` usa),
 * así se puede testear con fixtures a mano sin abrir ningún socket ni
 * depender de que el entorno tenga acceso de red a exchanges reales.
 * `scripts/tapeRecorder.js` y `scripts/experimentSweep.js` son los únicos
 * lugares que tocan la red / el filesystem real.
 */

/**
 * Valida que un snapshot tenga la forma mínima esperada: un timestamp y
 * un array de order books (misma forma que devuelve
 * `exchangeService.getOrderBooks()` — cada entrada con al menos
 * `{ exchange, bid, ask }`).
 * @param {any} snapshot
 * @returns {boolean}
 */
function isValidSnapshot(snapshot) {
  return !!snapshot
    && typeof snapshot === 'object'
    && Array.isArray(snapshot.orderBooks)
    && snapshot.orderBooks.length > 0;
}

/**
 * replayTape — alimenta cada snapshot grabado al motor de detección real,
 * uno por uno, en orden. `detectOpportunities` ya tiene el efecto
 * colateral (deliberado, reusado tal cual) de empujar cada oportunidad
 * detectada al opportunity log interno del módulo — este helper no
 * duplica esa lógica, solo orquesta el orden de reproducción y cuenta
 * snapshots inválidos/corruptos en vez de tirar toda la corrida por uno
 * solo malo (honestidad ante datos parciales, mismo criterio que
 * statisticalValidation.js/ADR-019).
 *
 * @param {Array<object>} snapshots - grabaciones ya parseadas (ver parseTapeLine)
 * @param {object} deps
 * @param {(orderBooks: object[], tradeAmount?: number) => ({opportunities: object[]}|object[])} deps.detectOpportunities
 *   - accepts either the real return shape of opportunityDetection.detectOpportunities()
 *   (`{ opportunities, triangularSignal, ... }`) or a bare array (useful for
 *   stubs in tests).
 * @param {number} [deps.tradeAmount] - monto fijo de trade a usar en la reproducción;
 *   si se omite, detectOpportunities cae a liveConfig.get('tradeAmountBTC').
 * @returns {{ processed: number, skipped: number, opportunitiesDetected: number }}
 */
function replayTape(snapshots, { detectOpportunities, tradeAmount } = {}) {
  if (typeof detectOpportunities !== 'function') {
    throw new TypeError('replayTape: se requiere detectOpportunities inyectado');
  }
  if (!Array.isArray(snapshots)) {
    throw new TypeError('replayTape: snapshots debe ser un array');
  }

  let processed = 0;
  let skipped = 0;
  let opportunitiesDetected = 0;

  for (const snapshot of snapshots) {
    if (!isValidSnapshot(snapshot)) { skipped++; continue; }
    const result = detectOpportunities(snapshot.orderBooks, tradeAmount);
    // detectOpportunities returns { opportunities, triangularSignal, ... } —
    // support both that shape and a bare array (in case an injected stub,
    // like the ones in tapeReplay.test.js, returns the array directly).
    const opportunities = Array.isArray(result) ? result : result?.opportunities;
    opportunitiesDetected += Array.isArray(opportunities) ? opportunities.length : 0;
    processed++;
  }

  return { processed, skipped, opportunitiesDetected };
}

/**
 * parseTapeLine — parsea una línea de un archivo JSONL de grabación.
 * Nunca lanza: una línea corrupta (JSON inválido, o sin `orderBooks`)
 * devuelve `null` en vez de tirar la lectura completa del archivo — el
 * mismo principio de tolerancia a datos parciales que el resto del
 * módulo.
 * @param {string} line
 * @returns {object|null}
 */
function parseTapeLine(line) {
  const trimmed = (line || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isValidSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = { replayTape, parseTapeLine, isValidSnapshot };

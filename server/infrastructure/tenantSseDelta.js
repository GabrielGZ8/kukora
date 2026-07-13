'use strict';
/**
 * tenantSseDelta.js — ADR-017, pendiente #1 (SSE por-usuario).
 *
 * CONTEXTO (Sesión 2026-07-07, A1): hoy `stream.routes.js` empuja UN solo
 * payload de tick (snapshot del bot compartido: order books, oportunidades,
 * wallet/P&L/historial DEL BOT COMPARTIDO) a TODOS los clientes SSE
 * conectados, sin importar qué `uid` tiene cada conexión. Este módulo es
 * el primer paso — la FUNCIÓN PURA que arma el "delta por-tenant" (wallet/
 * P&L/bot-status/historial de ESE uid) para superponer sobre el payload
 * compartido — separada del wiring al broadcast en caliente, siguiendo
 * exactamente el mismo criterio que `tenantExecution.js` (selección/armado
 * de payload testeable por separado del loop que lo dispara).
 *
 * ALCANCE DE ESTA SESIÓN — deliberadamente parcial, y por qué (ver
 * CHECKPOINT_07.md para el razonamiento completo de riesgo/tiempo):
 *   - SÍ: esta función pura, cero I/O, 100% testeable, cero riesgo de
 *     runtime porque NO está conectada a ningún broadcast todavía.
 *   - NO (todavía): conectar `buildTenantSseDelta` al loop de 150ms /
 *     `pushToSSE` / `sseClients`. Eso requiere (a) que `sseClients` deje
 *     de ser un `Set<res>` ciego al uid y pase a asociar cada `res` con
 *     el `req.userId` que `requireAuthForStream` ya resuelve (cambio de
 *     estructura de datos en `arbitrage.state.js`, compartido con
 *     `/alerts-stream` y el reset endpoint), y (b) tocar el broadcast en
 *     caliente que la demo compartida usa en vivo — exactamente el tipo
 *     de cambio que ADR-017 (Fase B original) y ADR-016 ya identificaron
 *     como el de mayor riesgo de todo el backlog, ahora a solo 5 días del
 *     deadline. Se prioriza, con la misma disciplina que diefirió Fase B
 *     la primera vez, NO tocar el broadcast compartido esta sesión.
 *   - La función de abajo es aditiva y no tiene ningún efecto hasta que
 *     algo la llame — construirla y probarla ahora reduce el riesgo real
 *     de la sesión que SÍ conecte el wiring (menos cosas nuevas que
 *     escribir bajo presión de deadline, superficie ya verificada).
 */

const tenantBotState = require('./tenantBotState');
const { getBalances, getPnL, getTradeHistory } = require('../domain/wallet/walletManager');

/**
 * buildTenantSseDelta — construye el snapshot por-tenant a superponer
 * sobre el payload de tick compartido. Pura: no escribe a ningún stream,
 * no muta nada, no depende de ningún socket/res. Espeja exactamente los
 * mismos campos que ya expone `GET /stream` (init) para el bot compartido
 * — wallets/pnl/botEnabled/history — pero resueltos para `uid`.
 *
 * @param {string} uid
 * @param {object} [opts]
 * @param {number|null} [opts.bestAskPrice] — para valorar P&L en USD, igual
 *   que el payload compartido (getPnL(bestAskPrice)).
 * @param {number} [opts.historyLimit] — mismo default que el payload
 *   compartido (20, ver stream.routes.js `GET /stream`).
 * @returns {{
 *   uid: string,
 *   botEnabled: boolean,
 *   botStatus: object,
 *   wallets: object,
 *   pnl: object,
 *   history: Array<object>,
 * }}
 */
function buildTenantSseDelta(uid, opts = {}) {
  const { bestAskPrice = null, historyLimit = 20 } = opts;

  const botStatus = tenantBotState.getStatus(uid);

  let wallets = {};
  try { wallets = getBalances(uid); } catch { /* non-fatal — mismo criterio que el payload compartido */ }

  let pnl = { totalPnl: 0, realizedPnl: 0, unrealizedPnl: 0, totalTrades: 0, winRate: 0 };
  try { pnl = getPnL(bestAskPrice, null, uid); } catch { /* non-fatal */ }

  let history = [];
  try { history = getTradeHistory(uid).slice(-historyLimit).reverse(); } catch { /* non-fatal */ }

  return {
    uid,
    botEnabled: botStatus.enabled,
    botStatus,
    wallets,
    pnl,
    history,
  };
}

/**
 * buildTenantSseFrame — envuelve `buildTenantSseDelta` en la MISMA forma de
 * frame `data: {...}\n\n` que usa el resto de `stream.routes.js`
 * (`pushToClients`/`sseSetup`), y superpone sobre un payload compartido ya
 * armado (`sharedPayload`, p. ej. lo que hoy produce `buildTickPayload()`)
 * SIN mutarlo — devuelve un objeto NUEVO. Este es el "adhesivo" aditivo:
 * un cliente sin `uid` (compatibilidad hacia atrás) recibiría exactamente
 * `sharedPayload` tal cual; un cliente CON `uid` recibiría
 * `{ ...sharedPayload, tenant: buildTenantSseDelta(uid, opts) }` — el
 * payload compartido nunca cambia de forma, solo se le añade una clave
 * nueva y opcional.
 *
 * @param {object} sharedPayload — el payload de tick ya armado para todos
 * @param {string|null} uid — null/undefined = cliente sin tenant identificado
 * @param {object} [opts] — ver buildTenantSseDelta
 * @returns {object} un NUEVO objeto, nunca muta `sharedPayload`
 */
function mergeTenantOverlay(sharedPayload, uid, opts = {}) {
  if (!uid) return sharedPayload; // aditivo: sin uid, comportamiento idéntico a hoy
  return { ...sharedPayload, tenant: buildTenantSseDelta(uid, opts) };
}

module.exports = {
  buildTenantSseDelta,
  mergeTenantOverlay,
};

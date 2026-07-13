'use strict';
/**
 * tenantExecution.js — ADR-017, item 1 fase B (multi-tenant real).
 *
 * CONTEXTO: fase A (checkpoint anterior) construyó los primitivos de
 * aislamiento — `tenantConfig` (overrides por-tenant), `tenantBotState`
 * (intención on/off por-tenant) y `walletManager` ya era por-uid desde
 * antes — todos 100% aditivos, sin tocar el loop de 150ms. Esta fase
 * conecta esos primitivos al motor de detección compartido SIN reemplazar
 * ni alterar el bot compartido existente.
 *
 * DISEÑO (ver ADR-017): un único motor de detección compartido + N
 * contextos de tenant que lo CONSUMEN. Este módulo es el "contexto de
 * tenant": para cada uid con su bot encendido (`tenantBotState.activeUids()`),
 * evalúa las MISMAS oportunidades ya detectadas por el tick compartido
 * (no vuelve a golpear los exchanges — el order-book es un dato de
 * mercado, no de usuario) contra la config de ESE tenant
 * (`tenantConfig.getEffective`) y, si corresponde, ejecuta contra el
 * wallet de ESE tenant (`walletManager` con `uid`), dejando el wallet y
 * P&L de cualquier otro tenant — y del bot compartido — completamente
 * intactos.
 *
 * ALCANCE DELIBERADO (lo que este módulo SÍ hace):
 *   - Selección (score/viabilidad/liquidez) contra la config del tenant.
 *   - De-dup de fingerprint POR TENANT *Y POR ASSET POOL* (ver
 *     `_checkTenantFingerprint`) — independiente del Map global de
 *     `arbitrage.state.js`, para que un tenant nunca bloquee a otro ni al
 *     bot compartido, y viceversa. BTC y ETH tienen su propio Map de
 *     fingerprints por tenant (ver A3, Sesión 2026-07-07): un trade BTC de
 *     un tenant nunca puede des-duplicar (ni ser des-duplicado por) un
 *     trade ETH de ese mismo tenant, aun si dos oportunidades de distinto
 *     asset produjeran coincidentalmente la misma huella de precio/spread.
 *   - Ejecución simulada (`executeSimulated`) + persistencia del trade
 *     (`applyTrade(trade, uid)`) contra el wallet aislado de ese tenant.
 *     `executeSimulated` ya resuelve el bucket de wallet (BTC/ETH/XRP) a
 *     partir de `opportunity.asset` (ver ADR-018) — este módulo no
 *     necesita conocer el asset para la ejecución en sí, solo para el
 *     namespacing del fingerprint (selección) y del contador (telemetría).
 *
 * ALCANCE DELIBERADO (lo que este módulo NO hace, y por qué):
 *   - NO pasa por `advancedRiskEngine` (circuit breaker/drawdown),
 *     `tradeStateMachine`, `predictiveRebalance`, `slippageValidator` ni
 *     `alertWebhookService`. Esos sistemas son hoy infraestructura de UN
 *     bot — "un único cerebro de riesgo protegiendo toda la plataforma"
 *     es una decisión de arquitectura defendible para paper-trading (el
 *     circuit breaker global sigue protegiendo el sistema agregado), pero
 *     hacerlos per-tenant es un refactor de alcance mucho mayor (tocan el
 *     hot path en ~15 puntos cada uno) que queda fuera de esta fase — ver
 *     ADR-017 y `docs/ADR-018` para el resto de generalización pendiente.
 *   - NO re-detecta oportunidades ni vuelve a golpear los exchanges: usa
 *     las listas ya detectadas por `detectBtcOpportunities()` en el mismo
 *     tick (BTC y ETH) — cero costo adicional de rate-limit por tenant.
 *   - A3 (Sesión 2026-07-07): el path ETH por-tenant YA está conectado —
 *     ver `runTenantExecutionPass(opportunities, ethOpportunities, now)`.
 *     Por-tenant, igual que el bot compartido (`evaluateAndExecuteEth`),
 *     ETH solo se evalúa si ese MISMO tenant no ejecutó ya un trade BTC
 *     este tick (mismo criterio "lastTrade === null" que el bot
 *     compartido, aplicado por tenant en vez de globalmente) — un tenant
 *     nunca ejecuta dos trades (BTC + ETH) en el mismo tick.
 *   - Solo BTC/ETH (los dos pools que el tick compartido ya detecta hoy).
 *     XRP no tiene spread cross-exchange real que detectar todavía (ver
 *     ADR-018, punto 4 — `exchangeService` solo tiene feeds multi-exchange
 *     para BTC/ETH) — no hay `xrpOpportunities` que consumir aún. El día
 *     que exista, la extensión es el mismo patrón otra vez.
 *
 * FALLA AISLADA: cualquier error evaluando/ejecutando para un uid — en
 * cualquiera de los dos pools — se captura y loguea sin abortar el resto
 * del pase; un tenant con un override de config inválido, por ejemplo,
 * nunca puede tumbar la ejecución de otro tenant ni del bot compartido.
 */

const { createTenantStore } = require('./tenantStore');
const tenantBotState = require('./tenantBotState');
const tenantConfig = require('./tenantConfig');
const tenantRiskGuard = require('./tenantRiskGuard');
const { getBalances, applyTrade } = require('../domain/wallet/walletManager');
const { executeSimulated, _DEFAULT_TRADE_AMOUNT } = require('../domain/engines/opportunityDetection');
const { logger } = require('./logger');

// Mismos valores que el dedup global de arbitrage.state.js (misma
// semántica: no repetir la "misma" oportunidad dentro de la ventana),
// pero en un Map independiente por tenant — ver nota de diseño arriba.
const FINGERPRINT_TTL = 5000;
const FINGERPRINT_MAX = 500;

// A3: un store de fingerprints por-tenant POR POOL DE ASSET. Antes de esta
// sesión solo existía el pool BTC (`_tenantFingerprints` a secas). En vez
// de un solo Map compartido con el asset embebido en la clave (lo que
// dejaría el TTL/MAX compitiendo entre BTC y ETH para el mismo tenant),
// cada pool tiene su propio Map — aislamiento total, mismo criterio que
// wallets/config ya aplican por-tenant.
const _fingerprintStoresByPool = {
  BTC: createTenantStore(() => new Map()),
  ETH: createTenantStore(() => new Map()),
};

function _fingerprintKey(op) {
  return `${op.buyExchange}-${op.sellExchange}-` +
         `${op.buyPrice.toFixed(1)}-${op.sellPrice.toFixed(1)}-` +
         `${(op.spreadPct || 0).toFixed(3)}`;
}

/**
 * De-dup por-tenant, namespaced por pool de asset ('BTC' | 'ETH') — ver
 * cabecera del módulo. Independiente tanto del Map global de
 * arbitrage.state.js como del Map del otro pool para el mismo tenant.
 */
function _checkTenantFingerprint(uid, op, now, pool = 'BTC') {
  const store = _fingerprintStoresByPool[pool] || _fingerprintStoresByPool.BTC;
  const map = store.get(uid);
  const fp = _fingerprintKey(op);
  const lastSeen = map.get(fp);
  if (lastSeen && now - lastSeen < FINGERPRINT_TTL) return false;
  if (map.size >= FINGERPRINT_MAX) {
    map.delete(map.keys().next().value);
  }
  map.set(fp, now);
  return true;
}

/**
 * Selección pura — misma forma que `selectBestOpportunity()` /
 * `selectBestEthOpportunity()` del orquestador (viable, no bloqueado por
 * circuit breaker/liquidez, score >= mínimo), pero el mínimo y el dedup
 * son los de ESE tenant (y, desde A3, los de ESE pool de asset).
 * @param {string} uid
 * @param {Array<object>} opportunities — ya detectadas por el tick compartido
 * @param {number} now
 * @param {'BTC'|'ETH'} [pool] — default 'BTC', retrocompatible con el
 *   comportamiento anterior a A3 para cualquier caller que no lo pase.
 * @returns {object|undefined}
 */
function _selectForTenant(uid, opportunities, now, pool = 'BTC') {
  const minScore = tenantConfig.getEffective(uid, 'minScore');
  return opportunities.find((op) => {
    if (!op || !op.viable || op.circuitBreaker || !op.liquidityOk) return false;
    if ((op.score || 0) < minScore) return false;
    return _checkTenantFingerprint(uid, op, now, pool);
  });
}

/**
 * Ejecuta la oportunidad seleccionada contra el wallet aislado del
 * tenant. No toca risk engine/state machine/alerts — ver cabecera.
 * Genérico en el asset: `executeSimulated` resuelve el bucket de wallet a
 * partir de `opportunity.asset` (BTC por defecto si no viene, igual que el
 * bot compartido) — este helper no necesita bifurcar por pool.
 * @param {string} uid
 * @param {object} opportunity
 * @returns {Promise<{ok: boolean, uid: string, trade?: object, reason?: string}>}
 */
async function _executeForTenant(uid, opportunity) {
  const walletSnapshot = getBalances(uid);
  // Nota (A3): igual que el bot compartido (executeBestOpportunity →
  // _DEFAULT_TRADE_AMOUNT), el tamaño de posición usa hoy la config de
  // tradeAmountBTC también para trades ETH — no existe todavía un
  // tradeAmountETH en liveConfig/tenantConfig (ver ADR-018). No es una
  // limitación introducida aquí; es la misma simplificación ya presente
  // en el bot compartido, preservada para consistencia de comportamiento.
  const tradeSize = tenantConfig.getEffective(uid, 'tradeAmountBTC') ?? _DEFAULT_TRADE_AMOUNT;

  // Pendiente #3 (ADR-017, risk engine per-tenant): drawdown/circuit
  // breaker/tamaño de posición para ESE tenant — ver tenantRiskGuard.js.
  // No pasa por advancedRiskEngine.js (bot compartido, sin cambios).
  const tradeValueUSD = tradeSize * (opportunity.buyPrice || 0);
  const riskCheck = tenantRiskGuard.checkPreTrade(uid, tradeValueUSD);
  if (!riskCheck.ok) {
    return { ok: false, uid, reason: `risk_guard: ${riskCheck.reason}` };
  }

  const result = executeSimulated(opportunity, walletSnapshot, tradeSize);
  if (!result.ok) return { ok: false, uid, reason: result.reason };

  const applyResult = await applyTrade(result.trade, uid);
  if (!applyResult.ok) return { ok: false, uid, reason: applyResult.reason };

  return { ok: true, uid, trade: applyResult.trade };
}

/**
 * runTenantExecutionPass — punto de entrada, llamado una vez por tick
 * desde `arbitrageOrchestrator.js`, DESPUÉS de la ejecución del bot
 * compartido. Itera solo los tenants con el bot encendido; no-op
 * inmediato (sin costo) si no hay ninguno, que es el caso de hoy para
 * cualquier despliegue que no use multi-tenant todavía.
 *
 * A3 (Sesión 2026-07-07): ahora recibe también `ethOpportunities`. Para
 * cada tenant activo, intenta BTC primero; si ese tenant NO ejecutó un
 * trade BTC este tick, intenta ETH — mismo criterio "uno u otro, no
 * ambos, por tick" que ya aplica el bot compartido entre
 * `evaluateAndExecuteBtc`/`evaluateAndExecuteEth`, pero evaluado
 * independientemente PARA CADA TENANT (el tenant A puede ejecutar BTC
 * mientras el tenant B ejecuta ETH en el mismo tick — no compiten entre
 * sí, cada uno compite solo contra sí mismo entre sus dos pools).
 * Retrocompatible: llamar con un solo argumento de oportunidades (o con
 * `ethOpportunities` vacío/omitido) se comporta exactamente igual que
 * antes de A3 — solo pool BTC.
 * @param {Array<object>} opportunities — lista BTC ya detectada este tick
 * @param {Array<object>|number} ethOpportunitiesOrNow — lista ETH ya
 *   detectada este tick; si se pasa un `number` aquí (firma anterior a
 *   A3: `runTenantExecutionPass(opportunities, now)`), se interpreta como
 *   `now` y ETH se omite — retrocompatibilidad total con callers viejos.
 * @param {number} [now]
 * @returns {Promise<Array<{ok: boolean, uid: string, trade?: object, reason?: string}>>}
 */
async function runTenantExecutionPass(opportunities, ethOpportunitiesOrNow, now) {
  // Retrocompatibilidad de firma: callers anteriores a A3 llamaban
  // runTenantExecutionPass(opportunities, now) — dos argumentos, el
  // segundo un timestamp. Si detectamos ese caso (segundo arg es number),
  // lo tratamos como `now` y no evaluamos ETH.
  let ethOpportunities = ethOpportunitiesOrNow;
  if (typeof ethOpportunitiesOrNow === 'number') {
    now = ethOpportunitiesOrNow;
    ethOpportunities = [];
  }

  const uids = tenantBotState.activeUids();
  if (uids.length === 0) return [];

  const btcCandidates = Array.isArray(opportunities) ? opportunities : [];
  const ethCandidates = Array.isArray(ethOpportunities) ? ethOpportunities : [];
  if (btcCandidates.length === 0 && ethCandidates.length === 0) return [];

  const results = [];
  for (const uid of uids) {
    let executedThisTenant = false;

    try {
      if (btcCandidates.length > 0) {
        const bestBtc = _selectForTenant(uid, btcCandidates, now, 'BTC');
        if (bestBtc) {
          const outcome = await _executeForTenant(uid, bestBtc);
          results.push(outcome);
          if (outcome.ok) {
            executedThisTenant = true;
          } else {
            logger.debug('tenantExecution', 'Tenant BTC trade not executed', { uid, reason: outcome.reason });
          }
        }
      }
    } catch (e) {
      // Aislamiento de fallas: un error para UN tenant (en UN pool) nunca
      // debe abortar el resto del pase — ni el ETH de ese mismo tenant, ni
      // el BTC/ETH de otro tenant, ni mucho menos el bot compartido (que
      // ya corrió antes de este pase en el tick).
      logger.warn('tenantExecution', 'Tenant BTC execution error', { uid, err: e.message });
    }

    if (executedThisTenant) continue; // mismo criterio que el bot compartido: uno u otro por tick

    try {
      if (ethCandidates.length > 0) {
        const bestEth = _selectForTenant(uid, ethCandidates, now, 'ETH');
        if (bestEth) {
          const outcome = await _executeForTenant(uid, bestEth);
          results.push(outcome);
          if (!outcome.ok) {
            logger.debug('tenantExecution', 'Tenant ETH trade not executed', { uid, reason: outcome.reason });
          }
        }
      }
    } catch (e) {
      logger.warn('tenantExecution', 'Tenant ETH execution error', { uid, err: e.message });
    }
  }
  return results;
}

module.exports = {
  runTenantExecutionPass,
  _selectForTenant,
  _executeForTenant,
  _checkTenantFingerprint,
};

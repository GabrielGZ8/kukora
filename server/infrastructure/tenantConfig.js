'use strict';
/**
 * tenantConfig.js — ADR-017, item 1 fase A (multi-tenant, config dinámica
 * por-usuario).
 *
 * PROBLEMA: `liveConfig` es un único `_cfg` global — correcto para el bot
 * compartido de hoy, pero el producto real (item 1, decisión de sesión
 * post-checkpoint-03) quiere que cada usuario pueda tener su propio
 * paper-trading account con SU propia configuración (thresholds, sizing,
 * scoring weights) sin afectar a los demás usuarios ni al bot compartido.
 *
 * DISEÑO: capa de overrides por-tenant sobre `liveConfig`, NO un fork del
 * config global. `getEffective(uid, key)` devuelve el override del
 * tenant si existe, si no cae a `liveConfig.get(key)` (el mismo valor
 * global de siempre). Reutiliza `liveConfig.validateOne` para no duplicar
 * las ~40 reglas de validación en un segundo archivo.
 *
 * ALCANCE DE ESTA FASE (deliberado): este módulo es aditivo y NO está
 * conectado al loop de ejecución de 150ms todavía — ver ADR-017 para el
 * razonamiento completo. Construir la capacidad ahora (verificada,
 * testeada) sin cablear el hot path evita el riesgo de tocar el motor de
 * trading en vivo a días del deadline del 12 de julio, y deja el trabajo
 * de "fase B" (arbitrageOrchestrator consultando overrides por-tenant)
 * acotado a un solo punto de integración futuro en vez de un cambio
 * simultáneo de config + loop + SSE.
 *
 * Usa el mismo mecanismo genérico que walletManager: createTenantStore.
 */

const { createTenantStore } = require('./tenantStore');
const liveConfig = require('./liveConfig');

const _tenantOverrides = createTenantStore(() => ({})); // uid -> { key: value }

/**
 * getEffective(uid, key) — valor efectivo para ese tenant: su override si
 * existe, si no el valor global de liveConfig (idéntico al comportamiento
 * de cualquier caller que no pase uid).
 */
function getEffective(uid, key) {
  const overrides = _tenantOverrides.get(uid);
  return Object.prototype.hasOwnProperty.call(overrides, key)
    ? overrides[key]
    : liveConfig.get(key);
}

/**
 * setMany(uid, patch) — aplica overrides por-tenant, validados contra las
 * mismas reglas del config global. Nunca muta `liveConfig` — dos
 * usuarios (o el bot compartido) nunca se pisan entre sí.
 */
function setMany(uid, patch) {
  const overrides = _tenantOverrides.get(uid);
  const applied = [];
  const rejected = [];

  for (const [key, rawVal] of Object.entries(patch || {})) {
    const result = liveConfig.validateOne(key, rawVal);
    if (!result.ok) {
      rejected.push({ key, reason: result.reason || `Invalid value: ${JSON.stringify(rawVal)}`, received: rawVal });
      continue;
    }
    const prev = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : liveConfig.get(key);
    overrides[key] = result.val;
    applied.push({ key, prev, next: result.val });
  }

  return { ok: rejected.length === 0, applied, rejected };
}

/** getOverrides(uid) — solo lo que este tenant sobreescribió (no el merge completo). */
function getOverrides(uid) {
  return { ..._tenantOverrides.get(uid) };
}

/** clearOverride(uid, key) — vuelve ese parámetro al valor global para este tenant. */
function clearOverride(uid, key) {
  const overrides = _tenantOverrides.get(uid);
  delete overrides[key];
}

/** resetAll(uid) — borra todos los overrides de este tenant (vuelve a heredar todo lo global). */
function resetAll(uid) {
  _tenantOverrides.reset(uid);
}

module.exports = { getEffective, setMany, getOverrides, clearOverride, resetAll };

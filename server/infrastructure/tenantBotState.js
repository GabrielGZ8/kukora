'use strict';
/**
 * tenantBotState.js — ADR-017, item 1 fase A (multi-tenant).
 *
 * Registro de la INTENCIÓN de cada usuario sobre su propio paper-trading
 * bot (encendido/apagado) y metadata mínima de su sesión — independiente
 * por completo del `getBotEnabled()/setBotEnabled()` global de
 * `arbitrage/subroutes/state.js`, que sigue gobernando el bot compartido
 * sin ningún cambio.
 *
 * Por qué un módulo separado en vez de extender el `state.js` global:
 * ese archivo es leído en el hot path de 150ms (~15 sitios en
 * arbitrageOrchestrator.js). Esta fase deliberadamente NO toca ese loop
 * (ver ADR-017) — este store existe para que cuando llegue la fase B
 * (el loop iterando tenants activos), el loop pueda preguntar
 * `tenantBotState.isEnabled(uid)` por cada tenant sin haber tenido que
 * rediseñar nada de este archivo.
 */

const { createTenantStore } = require('./tenantStore');

const _tenants = createTenantStore(() => ({
  enabled: false,
  startedAt: null,
  lastToggledAt: null,
}));

function isEnabled(uid) {
  return !!_tenants.get(uid).enabled;
}

function setEnabled(uid, enabled) {
  const state = _tenants.get(uid);
  const wasEnabled = state.enabled;
  state.enabled = !!enabled;
  state.lastToggledAt = new Date().toISOString();
  if (state.enabled && !wasEnabled) state.startedAt = state.lastToggledAt;
  if (!state.enabled) state.startedAt = null;
  return { ...state };
}

function getStatus(uid) {
  return { ..._tenants.get(uid) };
}

/** activeUids() — uids con el bot encendido ahora mismo (para la futura fase B del loop). */
function activeUids() {
  return _tenants.keys().filter((uid) => _tenants.get(uid).enabled);
}

module.exports = { isEnabled, setEnabled, getStatus, activeUids };

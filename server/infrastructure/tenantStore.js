'use strict';
/**
 * tenantStore.js — refinamiento post-checkpoint-02, item 1 (multi-tenant real)
 *
 * PROBLEMA: varios módulos (walletManager, arbitrage.state, etc.) guardaban
 * su estado mutable en variables de módulo (`let wallets = {...}`), una
 * sola instancia para TODO el proceso. Eso está bien para estado que es
 * genuinamente compartido a propósito (el order-book feed, el loop de
 * detección de 150ms — ver la nota en userRiskProfileService.js sobre por
 * qué duplicar detección por usuario no tiene sentido: el mercado es el
 * mismo para todos). Pero para estado que SÍ pertenece a un usuario
 * concreto (saldos de paper trading, historial de trades, on/off de su
 * propio bot), una sola instancia global significa que cualquier usuario
 * autenticado lee/muta el MISMO balance, historial o toggle que cualquier
 * otro — no es un simple bug de UI, es una filtración de datos entre
 * cuentas.
 *
 * SOLUCIÓN: un único factory reutilizable en vez de escribir "Map<uid,
 * estado>" a mano en cada módulo (eso sería la clase de duplicación que la
 * fase de refinamiento pidió eliminar). `createTenantStore(initFn)` regresa
 * `{ get(uid), set(uid, value), reset(uid), keys() }` sobre un Map interno,
 * creando el estado inicial de un uid la primera vez que se pide (lazy),
 * vía `initFn()` (debe devolver un valor NUEVO cada vez — no un objeto
 * compartido — para que dos uids nunca terminen apuntando a la misma
 * referencia mutable).
 *
 * DEFAULT_UID: cuando un caller no tiene sesión de usuario real (scripts,
 * tests viejos, o los procesos internos de un único bot compartido —
 * rebalanceEngine, capitalEfficiency, el loop de detección automático —
 * que deliberadamente siguen operando sobre UNA cuenta canónica, no una
 * por usuario, ver nota en walletManager.ts), todo cae en este bucket. Es
 * exactamente el comportamiento de antes de este refactor para cualquier
 * caller que nunca pasó `uid`.
 *
 * CONVENCIÓN MULTI-BOT (ADR-017, item 1 fase 2): este store nunca
 * interpreta la clave — es un string opaco. Hoy esa clave es siempre el
 * `uid`. El día que un mismo usuario pueda correr más de un bot
 * (estrategias distintas), la clave pasa a ser `resolveTenantKey(uid,
 * botId)` — una simple concatenación `${uid}::${botId}` — sin tocar
 * `createTenantStore` ni ninguno de los stores que ya lo usan
 * (walletManager, tenantConfig, tenantBotState). `botId` por defecto es
 * `DEFAULT_BOT_ID`, así que todo store existente sigue funcionando
 * exactamente igual hasta que un caller futuro decida pasar un botId
 * explícito.
 */

const DEFAULT_UID = 'default';
const DEFAULT_BOT_ID = 'default';

// Part B (Sesión 2026-07-07, auditoría de fugas de memoria): antes de este
// límite, el `Map` interno de CADA store construido con
// `createTenantStore` (tenantConfig, tenantBotState, y — vía
// `walletManager.ts` — el store de wallets/historial/P&L de cada usuario)
// crecía sin límite: cualquier `uid` que alguna vez llamara `get()` quedaba
// para siempre en memoria, sin ningún mecanismo de expiración ni tope,
// a diferencia de otros stores per-usuario ya existentes en este mismo
// proyecto (`userRiskProfileService.js`, `multiPairService.js`), que sí
// tienen un LRU acotado. Con tráfico real de N usuarios reales a lo largo
// del tiempo (cualquiera que haya cargado el dashboard una vez, aunque
// nunca haya vuelto), esto es una fuga de memoria de crecimiento lento
// pero indefinido — el mismo patrón que el fix ya aplicado a
// `tradeHistory` (ver CHANGELOG), ahora encontrado en la capa de
// aislamiento por-tenant misma. Fix: LRU acotado (mismo criterio y mismo
// límite por defecto — 1000 — que `userRiskProfileService.js`), aplicado
// una sola vez en el factory para que los tres stores que ya lo usan (y
// cualquier store futuro) queden protegidos automáticamente sin tener que
// replicar la lógica de eviction en cada uno.
const DEFAULT_MAX_TENANTS = 1000;

/**
 * Construye la clave compuesta uid+bot para stores que en el futuro
 * necesiten distinguir múltiples bots del mismo usuario. No usado por
 * ningún store hoy (cada usuario tiene un único bot) — existe para que
 * ese día no requiera cambiar la forma de los stores, solo la clave que
 * les pasan.
 * @param {string|null|undefined} uid
 * @param {string} [botId]
 */
function resolveTenantKey(uid, botId) {
  const u = (uid === undefined || uid === null || uid === '') ? DEFAULT_UID : String(uid);
  const b = (botId === undefined || botId === null || botId === '') ? DEFAULT_BOT_ID : String(botId);
  return b === DEFAULT_BOT_ID ? u : `${u}::${b}`;
}

/**
 * @param {() => any} initFn — fábrica del estado inicial para un uid nuevo.
 *   Debe devolver un valor fresco (nunca el mismo objeto/array compartido).
 * @param {object} [opts]
 * @param {number} [opts.maxTenants] — tope del LRU (default 1000, ver nota
 *   de diseño arriba). `DEFAULT_UID`/el bot compartido nunca debería ser
 *   el desalojado en la práctica porque es, con altísima probabilidad, el
 *   uid más recientemente usado (el loop de 150ms lo toca constantemente
 *   en despliegues sin multi-tenant) — pero no está exento explícitamente,
 *   por diseño: si algún día deja de usarse, debe poder expirar como
 *   cualquier otro.
 * @param {(key: string) => boolean} [opts.isProtected] — checkpoint 27 fix
 *   (riesgo de escala documentado en TechnicalDueDiligence, Hallazgo 4, y
 *   NO corregido hasta ahora). El problema real que el hallazgo original
 *   describía: un tenant desalojado del Map por el LRU pierde su estado en
 *   memoria y, si todavía tiene el bot encendido, el próximo tick de
 *   `tenantPersistence.persistActiveTenantSnapshots()` (cada 30s) lee de
 *   `walletManager` el wallet/historial YA RECREADO EN BLANCO por el
 *   desalojo — y lo persiste en Mongo, sobrescribiendo silenciosamente el
 *   snapshot real anterior. Es decir: la eviction de un Map en memoria
 *   podía terminar borrando datos durables. `isProtected(key)` es un
 *   predicado opcional: si se provee, `_evictOldestIfFull()` nunca
 *   desaloja una key para la que devuelve `true` — busca la siguiente más
 *   antigua sin protección. Si TODAS las keys están protegidas (caso
 *   patológico: ≥1000 tenants con el bot encendido a la vez), no se
 *   desaloja nada — el Map crece temporalmente por encima de `maxTenants`
 *   en vez de arriesgar el borrado de un tenant activo; es el trade-off
 *   correcto, ya que ese escenario es información real (más tenants
 *   activos que el tope configurado), no un bug. No cambia el
 *   comportamiento de ningún store existente que no pase `isProtected`
 *   (tenantConfig, tenantBotState) — es opt-in.
 */
function createTenantStore(initFn, opts = {}) {
  if (typeof initFn !== 'function') {
    throw new TypeError('createTenantStore(initFn): initFn debe ser una función');
  }
  const maxTenants = (typeof opts.maxTenants === 'number' && opts.maxTenants > 0)
    ? opts.maxTenants : DEFAULT_MAX_TENANTS;
  const isProtected = typeof opts.isProtected === 'function' ? opts.isProtected : null;
  const _map = new Map();

  function _resolveUid(uid) {
    return (uid === undefined || uid === null || uid === '') ? DEFAULT_UID : String(uid);
  }

  // Mueve `key` al final del orden de iteración del Map (más reciente),
  // sin cambiar la referencia del valor — mismo truco que
  // userRiskProfileService.js/_lruSet: delete + set preserva el objeto,
  // solo reordena la clave.
  function _touch(key, value) {
    _map.delete(key);
    _map.set(key, value);
  }

  function _isKeyProtected(key) {
    if (!isProtected) return false;
    try { return !!isProtected(key); } catch { return false; } // predicado defensivo: un throw nunca bloquea el LRU
  }

  function _evictOldestIfFull() {
    if (_map.size < maxTenants) return;
    // Recorre en orden de inserción (más antiguo primero) y desaloja la
    // primera key NO protegida. Sin isProtected, esto es idéntico al
    // comportamiento anterior (siempre desaloja la primera).
    for (const key of _map.keys()) {
      if (!_isKeyProtected(key)) { _map.delete(key); return; }
    }
    // Todas las keys existentes están protegidas — no hay nada seguro para
    // desalojar. El Map crece por encima de maxTenants en este caso
    // excepcional en vez de arriesgar borrar el estado de un tenant activo.
  }

  function get(uid) {
    const key = _resolveUid(uid);
    if (_map.has(key)) {
      const value = _map.get(key);
      _touch(key, value); // acceso = recencia, igual que un LRU real
      return value;
    }
    _evictOldestIfFull();
    const fresh = initFn();
    _map.set(key, fresh);
    return fresh;
  }

  function set(uid, value) {
    const key = _resolveUid(uid);
    if (!_map.has(key)) _evictOldestIfFull();
    _touch(key, value);
    return value;
  }

  function reset(uid) {
    const key = _resolveUid(uid);
    const fresh = initFn();
    if (!_map.has(key)) _evictOldestIfFull();
    _touch(key, fresh);
    return fresh;
  }

  function has(uid) {
    return _map.has(_resolveUid(uid));
  }

  function keys() {
    return [..._map.keys()];
  }

  function deleteTenant(uid) {
    return _map.delete(_resolveUid(uid));
  }

  return { get, set, reset, has, keys, delete: deleteTenant };
}

module.exports = { createTenantStore, DEFAULT_UID, DEFAULT_BOT_ID, resolveTenantKey };

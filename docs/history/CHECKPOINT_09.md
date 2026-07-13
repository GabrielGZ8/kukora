# CHECKPOINT_09 — TenantBotPanel + pase de due diligence dirigido (2 bugs reales corregidos)

Esta sesión tiene dos partes que se retoman de una sesión anterior de
Claude que se quedó sin tokens a mitad del trabajo (el traspaso llegó como
zip con `server/routes/tenantBot.routes.js` ya escrito pero sin ninguna
superficie de frontend que lo usara):

## Parte 1 — TenantBotPanel: la UI que faltaba para el multi-tenant

Los primitivos backend (`tenantBotState`, `tenantConfig`, `tenantRiskGuard`,
`tenantExecution`, ya conectados al loop de 150ms desde ADR-017) llevaban
varias sesiones existiendo sin ningún endpoint HTTP alcanzable por un
usuario real. `server/routes/tenantBot.routes.js` cerró el lado backend;
esta sesión cerró el lado frontend:

- `src/hooks/useTenantBot.js`: cliente para `/api/tenant-bot/*`. Usa un
  `fetch` propio en vez de los helpers genéricos de `src/api.js`, porque
  `requestJson()` descarta el body de la respuesta en cualquier
  `{ok:false}` — incluso en HTTP 200 — y este hook necesita `data.rejected`
  (qué parámetro se rechazó y por qué) para mostrarle algo útil al usuario.
- `src/components/common/TenantBotPanel.jsx`: nueva pestaña
  "🤖 Mi Bot Personal" en ArbitragePage — toggle on/off del bot propio,
  wallet/P&L/win-rate en vivo, risk guard con botón de reset, y 15
  parámetros curados (de los ~40 que expone el schema de `liveConfig`)
  editables como borrador local y aplicados en un solo POST batched — no
  auto-save por campo, porque estas rutas comparten un budget de 10/min
  con el toggle y el reset de riesgo.
- A diferencia de `LiveConfigPanel` (que re-siembra su borrador desde cada
  poll de 5s, descartando ediciones no guardadas), este panel siembra el
  borrador una sola vez y solo se resincroniza con acción explícita del
  usuario ("Descartar cambios" o después de guardar).

## Parte 2 — Due diligence dirigido: 2 bugs reales, 1 gap de cobertura, 2 hallazgos documentados

A petición explícita de auditar el proyecto contra un criterio de comité
técnico senior, se hizo un pase — no una re-auditoría completa de cero,
dado el tamaño del repo (~234 archivos de servidor) y el deadline del 12
de julio, sino un pase profundo en las tres áreas de mayor riesgo:
aislamiento multi-tenant, seguridad de rutas HTTP, y coherencia entre lo
que la UI promete y lo que el backend realmente aplica. Detalle completo
con evidencia archivo:línea en
`docs/TechnicalDueDiligence-2026-07-02.md` (Addendum 2, 2026-07-08).

**Corregido:**
1. `tenantRiskGuard.checkPreTrade` no aplicaba `maxDailyLossUSD` — el
   parámetro se validaba, se guardaba, y se mostraba como editable en el
   propio `TenantBotPanel` de esta misma sesión, pero ningún código lo
   leía. Ahora se calcula el P&L realizado del día desde
   `walletManager.getTradeHistory(uid)` y dispara el circuit breaker
   per-tenant igual que drawdown/rachas de pérdidas.
2. `POST /api/arbitrage/config` y `/config/reset` (mutan `liveConfig`, la
   config global de la que cualquier tenant sin override propio depende
   como fallback) solo exigían `requireAuth` — cualquier usuario
   autenticado podía cambiarla, inconsistente con rutas hermanas del
   mismo archivo que ya exigen `requireRole('admin')`. Corregido; se
   verificó que `ADMIN_EMAILS` sincroniza el rol del dueño del proyecto en
   cada login, así que el gate no bloquea el demo en vivo.
3. Bug menor: `financialControlLimiter` contaba requests `GET` hacia el
   mismo budget de mutaciones de `/api/tenant-bot/*` — el polling de
   solo-lectura del panel nuevo (cada 5s) agotaba en ~50s el budget que
   necesitaba el toggle/guardado real. `skip: (req) => req.method === 'GET'`.
4. `POST /api/tenant-bot/config` devolvía HTTP 400 en rechazos parciales,
   inconsistente con `/api/arbitrage/config` (siempre 200) — rompía el
   patrón de los helpers genéricos del frontend, que descartan el body en
   cualquier respuesta no-2xx.

**Gap de cobertura encontrado (no oculto, documentado):**
`tests/arbitrage.config.routes.test.js` usa un helper `getHandler()` que
extrae solo el último middleware del stack de la ruta y lo llama
directamente — nunca ejercita `requireAuth`/`requireRole`. Esos tests
hubieran seguido en verde con o sin el fix #2 de arriba. Se agregó
`tests/arbitrageConfig.security.e2e.test.js` (supertest contra la app
real) como complemento — no se tocó el archivo original, sigue siendo
válido para lo que sí prueba.

**Documentado, no corregido (alcance mayor al de esta sesión):**
- `tenantStore`'s LRU de 1000 tenants resetea silenciosamente el wallet
  de un usuario si es desalojado y vuelve — `tenantPersistence` restaura
  métricas pero no balances de wallet. Requiere refactor de persistencia,
  no un fix puntual.
- `ArbitragePage.jsx` importa los 19 paneles de tab de forma estática —
  el chunk de build es 495.77 kB. Code-splitting por tab es mecánico pero
  toca 19 imports; se dejó documentado por riesgo/beneficio dado el
  deadline.

## Verificación

- `npx vitest run` → **92 archivos, 1540 tests, 0 fallando** (+416 vs. el
  1124 del `CommitteeReadiness.md` original — cifra ya corregida ahí).
- `npx vitest run --coverage` → 70.11% / 59.77% / 68.17% / 73.31%
  (statements/branches/functions/lines), por encima de los umbrales de
  `vitest.config.js` (67/56/65/70).
- `npx tsc --noEmit` → limpio.
- `npm run build` → limpio.
- `npx eslint` sobre archivos nuevos/tocados → limpio.
- `npm run test:smoke` → 76/76.
- `npm run check:ts-drift` / `check:i18n` → sin drift, sin romper paridad.
- `.env` con credenciales reales (Mongo Atlas, JWT secrets, Firebase,
  ADMIN_TOKEN) seguía presente en el zip recibido — **tercera vez que
  aparece este problema recurrente**. Removido del zip de salida; rotar
  cuanto antes.

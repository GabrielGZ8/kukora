# CHECKPOINT_08 — Cierre de los 5 pendientes reales de ADR-017

Esta sesión continúa directamente el trabajo empaquetado en
`kukora_checkpoint_08_wip3.zip` (una sesión anterior de Claude que se
quedó sin tokens). El código de los 5 puntos ya estaba escrito y
verificado en ese zip; esta sesión verificó el estado real, cerró la
documentación (CHANGELOG, ADR-017, este checkpoint), y corrió la
verificación completa una vez más para confirmar que nada se rompió al
recibir el traspaso.

Los 5 puntos que la sesión anterior dejó como "Lo que falta para un 100":

## 1. SSE por-tenant — el más grande — COMPLETO

Antes: `buildTenantSseDelta`/`mergeTenantOverlay` (`tenantSseDelta.js`)
existían como función pura, probada, pero **nunca conectada** al
broadcast real — todo cliente SSE recibía el mismo payload de tick,
sin importar su `uid`.

Ahora:
- `arbitrage.state.js` trackea el `uid` de cada `res` registrado en
  `sseClients` (`sseClientUid`). `pushToSSE()` sigue calculando el tick
  UNA sola vez por ciclo de 150ms (no hay N cómputos por tenant — eso
  habría sido caro), pero antes de escribir a cada cliente individual
  superpone su delta con `mergeTenantOverlay`.
- `stream.routes.js` (`GET /stream`) registra el `uid` al conectar (ya
  autenticado por el ticket de `requireAuthForStream`), lo limpia en el
  evento `close` del request, y también superpone el overlay sobre el
  payload `init` (el primer snapshot que recibe el cliente al conectar,
  no solo los ticks subsecuentes).
- Sin `uid` (cliente legacy/no identificado): `mergeTenantOverlay`
  retorna la misma referencia del payload compartido, cero cambio de
  forma — mismo contrato que la función pura ya tenía documentado.
- Verificado con tests nuevos en `arbitrage.state.test.js` (dos uids
  reciben datos distintos del mismo `pushToSSE()`) y
  `arbitrage.stream.routes.test.js` (registro/limpieza de
  `sseClientUid`, overlay en `init`), más la suite completa de SSE
  existente (`sseConnection.e2e.test.js`) sin regresión, más boot+SIGTERM
  real antes y después del cambio.

**Resultado**: dos usuarios conectados simultáneamente al stream ahora
ven su propio wallet/P&L/estado de bot en vivo, desde el mismo broadcast
compartido — sin duplicar el cómputo del tick. Esto es lo que convierte
"multi-tenant" de promesa de arquitectura a producto usable por dos
usuarios a la vez.

## 2. Persistencia por-tenant — COMPLETO

Antes: cada tenant vivía solo en memoria (`Map` de `tenantBotState`/
`tenantConfig`/`walletManager`). Reinicio del proceso = pérdida total del
historial de cada tenant activo.

Ahora: `server/infrastructure/tenantPersistence.js` (nuevo) conecta el
primitivo per-usuario que ya existía en `persistenceService.js`
(`persistEngineSnapshot`/`restoreEngineSnapshot`, nunca conectado a
tenants reales) a `tenantBotState.activeUids()`:
- `persistActiveTenantSnapshots()` — guarda el snapshot de cada tenant
  activo; una falla de Mongo para un uid es no-fatal y no bloquea el
  resto (aislamiento de fallas, mismo criterio que `tenantExecution.js`).
- `restoreTenantSnapshot(uid)` — nunca lanza, incluso si la llamada
  subyacente rechaza.
- `startTenantPersistenceFlush`/`stopTenantPersistenceFlush` — flush
  periódico cada 30s, idempotente, arrancado en `_startup()` del
  orquestador junto al flush ya existente del bot compartido, y detenido
  en `stopEngine()`.
- 11 tests nuevos. Verificado con boot real (el log confirma
  `[tenantPersistence] Per-tenant snapshot flush started (every 30s)`).

## 3. Risk engine por-tenant — COMPLETO (complementario, no reemplaza el global)

La decisión de ADR-017 de mantener un solo cerebro de riesgo global para
la plataforma agregada sigue siendo válida y documentada — no se
revirtió. Pero el hallazgo de auditoría era real: un tenant con mala
configuración no tenía protección de riesgo individual.

`server/infrastructure/tenantRiskGuard.js` (nuevo) añade, por tenant:
circuit breaker, límite de drawdown, guard de tamaño de posición —
aditivo y aislado del risk engine compartido. Conectado en
`tenantExecution.js` (`checkPreTrade` antes de `executeSimulated` en
`_executeForTenant`). 8 tests nuevos, incluyendo aislamiento explícito
(un tenant tropieza su breaker, el otro sigue operando).

## 4. Coverage medido — COMPLETO

`vitest run --coverage` corrido por primera vez (antes solo se sabía el
conteo de tests pasando, nunca qué % de ramas cubrían). Resultado
agregado del repo: **~70% statements / ~59-60% branches / ~68% funciones
/ ~73% líneas**.

Los módulos nuevos/modificados esta sesión miden alto:
- `tenantConfig.js` — 100%
- `tenantBotState.js` — 100%
- `tenantSseDelta.js` — 100%
- `tenantRiskGuard.js` — ~98%
- `tenantPersistence.js` — ~95%
- `tenantExecution.js` — ~89%
- `tenantStore.js` — ~85%

Los huecos más grandes están en módulos que esta sesión **no tocó**:
`crypto.routes.js` (~64%), `liveConfig.js` (~63%), `exchangeService.js`
(~47%), `alertWebhookService.js`/`heatmapService.js` (~40-60%). Quedan
identificados y honestamente sin cerrar — no es parte del alcance de
esta sesión (que era específicamente los 5 puntos de ADR-017), pero se
deja anotado para que la próxima sesión no tenga que redescubrirlo.

## 5. Auditoría de seguridad (auth/2FA/rate-limiting) — COMPLETA

Revisión dirigida (no línea-por-línea exhaustiva del repo entero, pero
completa para los 3 sistemas nombrados):

- **`auth.js`**: JWT access (15m)/refresh (7d) con rotación, blacklist de
  `jti` en logout/cambio de contraseña, roles vía `ADMIN_EMAILS` con
  auto-sync, hashing bcrypt constante-en-tiempo en login (incluso cuando
  el usuario no existe o es cuenta Google-only, para no filtrar por
  timing). Diseño sólido, sin hallazgos.
- **2FA (`twoFactor.js` + `totp.js`)**: TOTP RFC 6238 estándar (SHA-1,
  30s, 6 dígitos, ventana ±1 paso), implementado sobre `crypto` nativo
  sin dependencias externas. Proof-of-possession requerido para
  deshabilitar 2FA (una sesión secuestrada no puede bajar la seguridad
  silenciosamente). Sin hallazgos.
- **Rate-limiting**: `apiLimiter` genérico (600/min por uid o IP) sobre
  toda `/api/`, más `financialControlLimiter` (10/min) específico en
  endpoints de control financiero (`/trading/mode`, `/trading/2fa`,
  `/trading/execute`, `/arbitrage/config`, `/arbitrage/reset`).

**Hallazgo real** (no en el código auditado, sino en el código NUEVO de
esta sesión): las rutas de `tenantBot.routes.js` no tenían
`financialControlLimiter` aplicado — quedaban solo bajo el límite
genérico de 600/min, mucho más permisivo que el resto de endpoints de
control financiero del proyecto. Corregido: `financialControlLimiter`
aplicado a `/api/tenant-bot/toggle`, `/config*`, `/risk/reset`. Verificado
con un test e2e nuevo que fuerza 12 requests y confirma un 429 real al
superar el límite (antes de este test, el propio test suite hubiera
fallado por rate-limit si se hubiera corrido contra un uid compartido —
se reescribió para usar un uid único por test, documentando el porqué
en un comentario de cabecera).

## Verificación final de esta sesión

```
vitest run          → 91 archivos / 1529 tests, todos verdes
tsc --noEmit        → limpio
npm run build:ts    → limpio
npm run lint        → limpio
boot + SIGTERM       → arranque limpio, tenantPersistence flush confirmado
                       en logs, shutdown graceful sin errores
```

Subió de 88 archivos/1492 tests (cierre de la sesión de
`CHECKPOINT_07.md`) a 91 archivos/1529 tests.

## Qué NO se hizo esta sesión (honesto, no una garantía)

- No se cerraron los huecos de coverage en módulos no tocados (ver
  punto 4) — quedan identificados, no arreglados.
- No se hizo una auditoría de seguridad línea-por-línea de TODO
  `src/`+`server/` — el alcance fue específicamente auth/2FA/
  rate-limiting, como pedía el punto 5 original.
- El risk engine global sigue siendo compartido por diseño (ver ADR-017)
  — el nuevo `tenantRiskGuard` es un complemento por-tenant, no un
  reemplazo del cerebro de riesgo agregado de la plataforma.
- Persistencia por-tenant usa el mismo mecanismo de snapshot que el bot
  compartido (Mongo, `EngineSnapshot`) — no se diseñó un esquema nuevo
  específico para multi-tenant a escala (particionamiento, TTL por
  plan, etc.), consistente con el alcance "un proceso, N tenants" que
  ADR-017 ya fijó como el modelo de despliegue actual.

## Checkpoints generados

- `kukora_checkpoint_08_wip1.zip` — tras items 2 y 3
- `kukora_checkpoint_08_wip2.zip` — tras items 1, 2, 3
- `kukora_checkpoint_08_wip3.zip` — tras los 5 items completos, antes de
  cerrar documentación (el que se subió a esta conversación)
- `kukora_checkpoint_08_final.zip` — este, con CHANGELOG/ADR-017/este
  checkpoint actualizados y versión bump a 2.12.0

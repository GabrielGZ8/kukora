# CHECKPOINT_07 — ADR-017 pendientes reales (A3/A4 completos, A1 parcial, A2 documentado) + 2 hallazgos de auditoría

Continúa desde `CHECKPOINT_06.md`, que cerró con 4 puntos genuinamente
pendientes (ver ese checkpoint y `ADR-017`, sección "Pendiente real después
de esta sesión"). Esta sesión los aborda en orden de riesgo creciente, tal
como se pidió, y hace además una pasada dirigida (no exhaustiva línea-por-
línea) de auditoría sobre las áreas que la Parte A tocó.

**Deadline recordado**: evaluación el 12 de julio de 2026 (hoy 7 de julio,
5 días). Prioridad explícita seguida en toda la sesión: el bot compartido
(demo) nunca se rompe. Ningún cambio de esta sesión toca el broadcast SSE
en caliente ni el loop de 150ms del bot compartido en su comportamiento
observable — solo se le agregó una llamada adicional, aislada en try/catch,
para el pase de ejecución por-tenant ETH (ya existía el pase BTC desde la
sesión anterior).

## Verificación — estado final

`vitest run` → `tsc --noEmit` → `npm run build:ts` → `vitest run` (otra
vez, tras la reescritura de los `.js` compilados) → `npm run lint` →
arranque real + `SIGTERM` graceful shutdown, verificado tres veces (después
de A4, después de A3, y al final de la sesión).

**Estado final: 88 archivos / 1492 tests** (subió de 86/1471 en
CHECKPOINT_06 — 21 tests nuevos), `tsc` limpio, `eslint` limpio (`src/` +
`server/`), build limpio, arranque/apagado verificado end-to-end las tres
veces.

## Parte A — los 4 pendientes reales del ADR-017

### A4 — Test de regresión para Multi-Hop event-driven: **completo**

Problema real señalado en CHECKPOINT_06: el fix del bug de `multiHopSignal`
ya estaba aplicado, pero no había infraestructura de test para el path
event-driven (el handler vivía como closure anónimo pasado directo a
`priceEmitter.on(...)`, imposible de invocar sin emitir un evento real).

**Qué se hizo**: extraje el handler a una función nombrada
(`_handlePriceUpdate`), exportada como `_handlePriceUpdateForTests` —mismo
criterio que `_resetLoopBackoffForTests`/`_getLoopBackoffStateForTests` ya
usan en el mismo archivo. Cero cambio de comportamiento en runtime:
`_attachEventDriven()` sigue siendo el único punto que la conecta al
emisor real (`priceEmitter.on('priceUpdate', _handlePriceUpdate)`).

`tests/arbitrageOrchestratorEventDriven.test.js` (4 tests nuevos), mismo
patrón de mocking que `arbitrageOrchestrator.test.js` (spies instalados
antes de requerir el orchestrator). Verifica:
- Con `multiHopEnabled=false` (default), Multi-Hop no se evalúa —
  comportamiento sin cambios.
- Con `multiHopEnabled=true` y una señal viable, Multi-Hop SÍ ejecuta.
- Con `multiHopEnabled=true` pero por debajo del mínimo, no ejecuta y no
  explota.
- Con `multiHopSignal=null` (sin señal ese tick), no explota.

**Verificación de que el test realmente prueba la regresión** (no solo que
pasa): reintroduje el bug exacto (quité `multiHopSignal` de la
desestructuración) a mitad de sesión y confirmé que el test nuevo fallaba
con el mismo síntoma documentado en CHECKPOINT_06 (0 ejecuciones de
`execution.multihop_completed` en vez de 1), luego restauré el fix. El
test detecta la regresión real, no un placeholder.

### A3 — Extensión del pase de ejecución por-tenant a ETH: **completo**

`tenantExecution.js` reescrito para aceptar `ethOpportunities` como
segundo argumento de `runTenantExecutionPass`. Por cada tenant activo:
intenta BTC primero; solo si ese tenant no ejecutó BTC este tick, intenta
ETH — mismo criterio "uno u otro por tick" que ya usa el bot compartido
entre `evaluateAndExecuteBtc`/`evaluateAndExecuteEth`, pero resuelto
independientemente por cada tenant (el tenant A puede ejecutar BTC mientras
el tenant B ejecuta ETH en el mismo tick).

Decisiones de diseño (ver comentario de cabecera actualizado del archivo):
- **Fingerprint de-dup namespaced por pool de asset**: en vez de un Map
  compartido con el asset embebido en la clave, cada pool (`BTC`/`ETH`)
  tiene su propio `createTenantStore` de fingerprints por tenant — un
  dedup de un pool nunca contamina al otro para el mismo tenant.
- **`_executeForTenant` se mantiene genérico**: no necesitó bifurcar por
  asset porque `executeSimulated()` ya resuelve el bucket de wallet a
  partir de `opportunity.asset` (fix de ADR-018 de una sesión anterior) —
  la parametrización real estaba solo en selección (fingerprint/pool), no
  en ejecución.
- **Retrocompatibilidad de firma**: `runTenantExecutionPass(opportunities, now)`
  (la firma de dos argumentos anterior a esta sesión) sigue funcionando
  exactamente igual — detección en runtime de si el segundo argumento es
  un `number` (interpretado como `now`, ETH omitido) vs un array
  (`ethOpportunities`).
- **Nota honesta preservada**: el tamaño de trade para ETH usa hoy la
  misma config `tradeAmountBTC` que el bot compartido usa para sus propios
  trades ETH (no existe `tradeAmountETH` en `liveConfig`/`tenantConfig`) —
  no es una limitación introducida aquí, es la misma simplificación ya
  presente en `executeBestOpportunity`, preservada por consistencia.

6 tests nuevos en `tests/tenantExecution.test.js` (describe block `A3 —
extensión ETH`): ejecución ETH aislada, "un trade por tick" cuando ambos
pools son viables, independencia de fingerprint BTC/ETH, dos tenants en
pools distintos el mismo tick, retrocompatibilidad de firma vieja, y
aislamiento de fallas (un tenant con config inválida no bloquea a otro).

### A1 — SSE por-usuario: **parcial, deliberadamente**

Esta era la pieza marcada como mayor riesgo, y la traté como tal.

**Qué se hizo** (según lo pedido — "escribe primero los tests de la
función pura"): `server/infrastructure/tenantSseDelta.js`, con dos
funciones puras:
- `buildTenantSseDelta(uid, opts)` — arma el snapshot por-tenant
  (wallet/P&L/bot-status/historial) espejando exactamente los mismos
  campos que ya expone `GET /stream` para el bot compartido, resueltos
  para `uid`.
- `mergeTenantOverlay(sharedPayload, uid, opts)` — superpone ese delta
  sobre un payload compartido sin mutarlo. Con `uid` ausente, retorna la
  **misma referencia** del payload compartido (verificado con `.toBe()`,
  no `.toEqual()` — cero copia innecesaria y cero cambio de forma para
  clientes sin tenant identificado).

7 tests nuevos en `tests/tenantSseDelta.test.js`, 100% puros (cero I/O,
cero mocks de red/socket) — cubren: tenant sin bot nunca encendido, tenant
con bot encendido, dos tenants con snapshots independientes, límite de
historial (mismo criterio `.slice(-N).reverse()` que `stream.routes.js`),
uid ausente/undefined sin explotar, y las dos garantías de
`mergeTenantOverlay` (referencia idéntica sin uid; objeto nuevo con
`tenant` agregado sin mutar el original con uid).

**Qué NO se hizo, y por qué (decisión explícita de riesgo/tiempo)**: NO
conecté esto al broadcast en caliente. Hacerlo requiere:
1. Cambiar `sseClients` de `Set<res>` (ciego al uid) a una estructura que
   asocie cada conexión con el `req.userId` que `requireAuthForStream` ya
   resuelve — un cambio de forma de datos compartido con `/alerts-stream`
   y el endpoint `/reset`.
2. Tocar el punto exacto donde el loop de 150ms llama `pushToSSE(payload)`
   — el broadcast en vivo que la demo compartida usa ahora mismo.

Esto es exactamente el tipo de cambio que ADR-016 y la propia Fase B
original de ADR-017 ya identificaron como el de mayor riesgo del backlog
— tocar simultáneamente el estado de conexión SSE y el broadcast en
caliente, a 5 días de una evaluación en vivo. Con la misma disciplina que
difirió Fase B la primera vez (y que to Fase B misma reconoció como
"cambios de alto riesgo sobre el motor de ejecución en vivo se posponen
hasta después de la evaluación"), **recomiendo explícitamente diferir el
wiring a la siguiente sesión, sin presión de deadline encima**. La función
pura y sus tests reducen el riesgo real de esa sesión futura (menos
código nuevo que escribir bajo presión), pero el wiring en sí sigue sin
existir — no hay verificación end-to-end con supertest de dos uids
distintos porque no hay nada real que probar todavía. Esto es honesto y
explícito, no un pendiente escondido.

### A2 — Sesiones, replay, analytics por-tenant: **documentado servicio por servicio, un bug real corregido**

Revisión dirigida (no reescritura) de los tres servicios pedidos:

- **`replayService.js` → datos de mercado, correctamente sin tocar.**
  Captura order books + la oportunidad detectada por el tick COMPARTIDO;
  el único "trade ejecutado" que puede adjuntar a un snapshot es el del
  bot compartido (`captureIfNoteworthy` nunca recibe un trade de
  `tenantExecution.js` — ese pase no lo llama). No hay fuga entre
  tenants porque hoy no hay ningún dato de tenant en replay. Clasificación
  correcta, consistente con el propio framework de ADR-017
  ("mercado compartido, no tocar").
- **`persistenceService.js` (sesión/equity/trade legacy + `EngineSnapshot`)
  → de usuario, pero solo implementado para el bot compartido.** El
  primitivo per-usuario `persistEngineSnapshot(snapshot, userId)`/
  `restoreEngineSnapshot(userId)` **ya existía** antes de esta sesión
  (comentario en el propio archivo: "richer, per-user snapshot") pero
  nunca se conectó a tenants reales — solo se llama con
  `userId='default'` desde `arbitrageOrchestrator.js`. No es una fuga
  (ningún tenant persiste nada a Mongo hoy, así que no hay mezcla), pero
  sí un gap real: si el proceso reinicia, el estado de un tenant activo
  (equity curve, trade log) se pierde por completo — solo vive en el
  `Map` en memoria de `walletManager`. Documentado en ADR-017 como
  pendiente real explícito para la siguiente sesión (mismo perfil de
  riesgo que A1: toca código invocado desde el hot path).
- **`walletManager.ts` (`ArbitrageOp`, copia de auditoría Mongo de cada
  trade) → bug real encontrado y corregido esta sesión.** El schema no
  tenía campo `uid` — cualquier trade persistido a Mongo (bot compartido
  O cualquier tenant vía `tenantExecution.js`) caía en el mismo documento
  sin ninguna etiqueta de a quién pertenecía. El estado en memoria
  (per-uid desde antes) nunca tuvo esta fuga; la COPIA persistida en
  Mongo sí mezclaba todo indistinguiblemente. Mismo patrón de bug que el
  bucket de asset BTC/ETH/XRP que ADR-018 ya documentó dos veces, esta
  vez en la capa de persistencia. **Fix**: campo `uid` (opcional, default
  `null`) agregado al schema y al interfaz TS; pasado a través de
  `applyTrade(trade, uid)` → `_applyTradeInternal(trade, state, uid)` →
  `ArbitrageOp.create({ uid, ... })`. Retrocompatible con cualquier
  documento ya escrito (uid ausente = comportamiento de antes de este
  fix) y con el bot compartido (que sigue llamando `applyTrade()` sin
  uid). **Honestidad**: no agregué un test para este write path
  específico — no existe ninguna infraestructura de mock de
  `mongoose.connection.readyState` en `tests/walletManager.test.js` hoy
  (a diferencia de `persistenceService.test.js`, que sí tiene un seam de
  test dedicado, `_setMongooseForTests`), y construir esa infraestructura
  desde cero es un trabajo separado que no alcancé a hacer con la
  confianza necesaria esta sesión. Queda como recomendación explícita
  para la siguiente sesión, no como pendiente oculto.

## Parte B — auditoría: alcance real de esta sesión (léase con cuidado)

**Esto NO fue una auditoría línea-por-línea de todo `src/`+`server/` como
la de CHECKPOINT_06 (item 7).** Dado el tiempo disponible, prioricé una
revisión dirigida sobre: (a) todo lo tocado por la Parte A, (b) los
mecanismos de estado por-tenant nuevos/existentes (los candidatos más
probables a fugas de memoria o cross-tenant, per el propio pedido de la
Parte B), y (c) `npm run lint` sobre el árbol completo (limpio, sin
hallazgos nuevos de `no-undef` ni similares esta vez).

### Hallazgo 1: fuga de memoria en `createTenantStore` — corregido

`server/infrastructure/tenantStore.js` es el factory que usan
`tenantConfig.js`, `tenantBotState.js`, y (vía `walletManager.ts`) el
store de wallets/historial de cada usuario. Su `Map` interno **no tenía
ningún límite ni mecanismo de expiración**: cualquier `uid` que alguna vez
llamara `get()` quedaba para siempre en memoria. Esto contrasta con otros
dos stores per-usuario que YA existían en este mismo proyecto antes de
esta sesión —`userRiskProfileService.js` y `multiPairService.js`— que sí
tienen un LRU acotado (`MAX_USER_PROFILES = 1000` + eviction del menos
recientemente usado). `createTenantStore` era el único de los cuatro
mecanismos per-usuario del proyecto sin ese límite.

**Efecto real**: con tráfico real de N usuarios reales a lo largo del
tiempo (cualquiera que haya cargado el dashboard multi-tenant una vez,
aunque nunca haya vuelto), los tres stores que usan este factory crecen
sin límite — una fuga de memoria de crecimiento lento pero indefinido,
exactamente el patrón que la Parte A4 de esta misma tarea pidió buscar
explícitamente ("especialmente en los stores por-tenant nuevos, que ahora
con N tenants reales podrían acumular memoria de forma distinta").

**Fix**: LRU acotado en el factory (parámetro `maxTenants`, default 1000
— mismo límite que los otros dos stores del proyecto), aplicado una sola
vez para que `tenantConfig`, `tenantBotState`, `walletManager`, y
cualquier store futuro construido con `createTenantStore` (incluyendo el
nuevo `_fingerprintStoresByPool` de A3) queden protegidos
automáticamente. 4 tests de regresión nuevos en `tests/tenantStore.test.js`,
incluyendo uno que reproduce el escenario real (500 uids sintéticos,
confirma que el store nunca excede el tope de 50) y uno que confirma que
`get()` cuenta como acceso (LRU real, no solo FIFO).

### Hallazgo 2: gap de persistencia cross-tenant — ver A2 arriba (`ArbitrageOp.uid`)

Ya documentado en la sección A2 de arriba — se repite aquí porque también
califica como hallazgo de Parte B (money/balances + multi-tenant, dos de
las áreas explícitamente pedidas).

### Lo que NO se hizo esta sesión (alcance honesto de Parte B)

- No se revisó línea por línea `auth.js`, 2FA, Firebase admin, rate
  limiting en busca de bypasses — la Parte A de esta sesión no tocó
  autenticación, así que no había una superficie nueva que auditar ahí, y
  el tiempo se priorizó sobre las áreas que SÍ cambiaron.
- No se revisó `advancedRiskEngine.ts`/`rebalanceEngine.js` en busca de
  off-by-one/redondeos — esos archivos no fueron tocados por la Parte A
  de esta sesión (A3 deliberadamente no pasa por risk engine, ver
  cabecera de `tenantExecution.js`) y ya fueron parte de la auditoría de
  CHECKPOINT_06.
- No se buscaron funciones exportadas sin ningún test que las llame en
  todo el árbol (pedido explícito del punto 4 de Parte A original) — esto
  requeriría una herramienta de cobertura dedicada (`vitest run
  --coverage`, no ejecutado esta sesión) para ser exhaustivo en vez de
  anecdótico.

Si la siguiente sesión quiere una auditoría de Parte B tan exhaustiva como
la de CHECKPOINT_06 (item 7), esa es una sesión propia — no se debe asumir
que esta sesión la reemplaza.

## Documentación actualizada

- `docs/ADR-017-multi-tenant-two-phase-rollout.md`: sección "Pendiente
  real" reescrita con el estado de cada uno de los 4 puntos tras esta
  sesión, más los 2 hallazgos nuevos.
- `CHANGELOG.md`: entrada `[2.11.0]` nueva.
- `package.json`: versión `2.10.0` → `2.11.0` (ya estaba consistente con
  el CHANGELOG antes de esta sesión — este bump refleja el HEAD real tras
  la entrada nueva).

## Verificación de seguridad de secretos (parte de los entregables)

- `server/.secrets/exchange-credentials.enc.json` contiene únicamente
  `{}` (placeholder) — confirmado.
- `.env.example` no contiene ningún valor real, solo comentarios de
  formato (ej. `mongodb+srv://<user>:<password>@...` como plantilla, sin
  credenciales reales).
- `.secrets.baseline` (detect-secrets) presente, sin cambios necesarios.
- `unzip -l` sobre el zip final confirma que no se incluye ningún `.env`
  real (solo `.env.example`) ni ningún archivo bajo `server/.secrets/`
  con contenido real.

## Estado final de los 4 pendientes del ADR-017 (resumen)

| Punto | Estado |
|---|---|
| A1 — SSE por-usuario | **Parcial** — función pura + tests listos; wiring al hot path diferido explícitamente (mayor riesgo, ver arriba). |
| A2 — Sesiones/replay/analytics | **Documentado** servicio por servicio; 1 bug real corregido (`ArbitrageOp.uid`); extensión de `EngineSnapshot` a tenants activos queda pendiente. |
| A3 — Extensión ETH | **Completo** y verificado. |
| A4 — Test de regresión Multi-Hop | **Completo** y verificado (incluyendo confirmación de que el test detecta la regresión real). |

## Pendiente real después de esta sesión (para que la siguiente no tenga que re-descubrirlo)

1. Wiring del broadcast SSE por-tenant (A1) — la pieza de mayor riesgo del
   backlog completo de multi-tenant, recomendado para una sesión sin
   presión de deadline.
2. Conectar `persistEngineSnapshot`/`restoreEngineSnapshot` a
   `tenantBotState.activeUids()` (A2) — mismo perfil de riesgo que el
   punto 1.
3. Test de regresión dedicado para el fix de `ArbitrageOp.uid` (requiere
   construir un seam de mock de `mongoose.connection.readyState` para
   `walletManager.ts` que no existe hoy).
4. Auditoría de Parte B exhaustiva (línea-por-línea, con
   `vitest run --coverage`) si la siguiente sesión la necesita — esta
   sesión hizo una pasada dirigida, no la reemplaza.

Estos 4 puntos son el trabajo real pendiente conocido después de esta
sesión. Todo lo demás (A3, A4, los 2 hallazgos de auditoría) está
completo, verificado tres veces con el estándar de verificación completo,
y documentado.

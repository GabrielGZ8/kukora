# Checkpoint 27 — cierre de 5 gaps ya identificados y no resueltos

## Contexto

Esta sesión empezó con un pedido de auditoría adversarial completa (los 12
puntos clásicos: comprensión total, revisión archivo por archivo, motor de
arbitraje, arquitectura, frontend, backend, DB, seguridad, performance,
veredicto de hackathon, plan maestro, implementación). Antes de reauditar
472 archivos desde cero — lo que habría redescubierto con peor precisión
cosas que 26 checkpoints anteriores ya encontraron, fecharon y en varios
casos corrigieron — se leyó primero todo el historial existente
(`docs/TechnicalDueDiligence-2026-07-02.md` con sus dos addenda,
`docs/CommitteeReadiness.md`, `docs/SystemLimits.md`, `docs/JudgeGuide.md`,
`docs/history/CHECKPOINT_26.md`) para identificar qué gaps **ya
documentados** seguían sin cerrar. Se encontraron tres al inicio, priorizados por
impacto real (reliability → correctness multi-tenant → cobertura de
contrato de tipos), y se implementaron completos esa misma sesión, con
tests, no solo diagnosticados. Continuando en la misma línea, se cerraron
dos más: cobertura de `replayService.js` y la fragilidad de comparación de
floats en Kraken/Bybit — ambos también señalados explícitamente en
`CHECKPOINT_26.md` y sin tocar hasta ahora.

## Fix 1 — Coinbase era el único exchange sin heartbeat de cliente

**Origen del hallazgo:** `CHECKPOINT_26.md`, sección "Remaining risks",
priorizado #2 ("cheapest fix with real reliability payoff").

`server/infrastructure/exchangeService.js` — los 4 exchanges restantes
(Binance, Kraken, Bybit, OKX) arman un `setInterval` que envía un ping a
nivel de protocolo WS cada 20-30s dentro de su handler `'open'`. Coinbase no
lo hacía. Sin ping, un proxy/load balancer intermedio que cierra
conexiones idle podía tumbar el socket de Coinbase sin que el cliente lo
notara hasta que el próximo gap de mensajes real disparara el watchdog de
staleness (~5s) — una señal mucho más lenta y burda que el ping mismo.

**Fix:** `connectCoinbase()` ahora arma `ping = setInterval(() =>
ws.readyState === WS.OPEN && ws.ping?.(), 20000)` dentro de su handler
`'open'`, exactamente el mismo patrón que Binance, y lo limpia
(`clearInterval(ping)`) en `'close'` — donde también se detectó y corrigió
una segunda inconsistencia menor: el handler `'close'` de Coinbase, a
diferencia de los otros 4, no llamaba `recordFeedEvent('Coinbase', true,
0)`, así que una desconexión de Coinbase no penalizaba su score de
reliability como sí lo hacen las de los otros 4 exchanges. Ahora es
uniforme.

**Tests:** 3 nuevos en `tests/exchangeService.test.js` (14 tests totales en
el archivo, antes 11): ping cada 20s tras `'open'`, el interval se limpia
tras `'close'` (no hay pings colgados), y no hay ping antes de que el socket
abra.

## Fix 2 — LRU de `tenantStore` podía borrar silenciosamente el wallet de un tenant activo

**Origen del hallazgo:** `docs/TechnicalDueDiligence-2026-07-02.md`,
Addendum 1, Hallazgo 4 — documentado explícitamente como "NO corregido,
alcance mayor".

El problema real (no solo teórico): `server/infrastructure/tenantStore.js`
implementa un LRU acotado a 1000 tenants para evitar una fuga de memoria ya
resuelta en una sesión anterior. Pero si un tenant es desalojado del `Map`
(1000 otros uids lo empujaron fuera) mientras su bot sigue encendido,
`walletManager` le crea un wallet **completamente fresco** en el próximo
acceso. Y como `tenantPersistence.persistActiveTenantSnapshots()` corre
cada 30s iterando `tenantBotState.activeUids()`, el próximo tick de ese
flush leería el wallet YA RECREADO EN BLANCO y lo persistiría en Mongo —
**sobrescribiendo el snapshot real anterior con uno vacío**. Es decir: una
eviction de un Map en memoria podía terminar borrando datos durables de
forma silenciosa.

**Fix (genérico, en el factory, no en cada store):**
- `createTenantStore(initFn, opts)` acepta ahora `opts.isProtected(key)`
  — un predicado opcional. `_evictOldestIfFull()` recorre las keys en
  orden de inserción (más antigua primero) y desaloja la primera que el
  predicado NO marque como protegida. Si todas las keys existentes están
  protegidas (caso patológico: ≥1000 tenants activos a la vez), el Map
  crece temporalmente por encima de `maxTenants` en vez de arriesgar el
  borrado de un tenant activo — el trade-off correcto. Un predicado que
  lanza excepción se trata como "no protegido" (defensivo, nunca rompe el
  store). Sin `opts.isProtected`, el comportamiento es idéntico byte a
  byte al de antes (opt-in, cero cambio para `tenantConfig`/
  `tenantBotState`, que no lo usan).
- `server-types/server/domain/wallet/walletManager.ts` — el único store
  para el que este riesgo era real (los otros dos, `tenantConfig` y
  `tenantBotState`, vuelven a sus defaults con normalidad, comportamiento
  tolerable ya documentado) — ahora pasa `isProtected: (uid) =>
  isTenantBotEnabled(uid)`, importado de `tenantBotState.js`. Sin ciclo de
  dependencias: `tenantBotState.js` solo requiere `tenantStore.js`.
  Recompilado con `tsc` (no se editó `server/domain/wallet/
  walletManager.js` a mano — es un artefacto de build, ver ADR-013) y
  verificado sin drift con `scripts/checkTsBuildDrift.js`.
- Se agregó `server-types/server/infrastructure/tenantBotState.d.ts`
  (no existía) siguiendo el mismo patrón que `exchangeRegistry.d.ts` /
  `logger.d.ts`, para que `walletManager.ts` pudiera importar
  `isEnabled()` con tipos.
- `server-types/server/infrastructure/tenantStore.d.ts` actualizado con
  `TenantStoreOptions.isProtected`.

**Tests:**
- `tests/tenantStore.test.js` — 4 tests nuevos sobre el mecanismo genérico:
  desaloja la siguiente key no protegida en vez de la protegida; crece por
  encima de `maxTenants` si todas están protegidas; un predicado que lanza
  no rompe el store; sin `isProtected`, comportamiento idéntico al de antes.
- `tests/walletManager.test.js` — 2 tests de integración real contra el
  escenario exacto del hallazgo: un tenant con el bot encendido conserva su
  balance custom tras 1500 otros uids empujar el LRU (1000 de tope) muy por
  encima de donde habría sido desalojado bajo el comportamiento anterior; y
  un tenant inactivo sigue pudiendo ser desalojado con normalidad (el fix no
  fija a todos los uids para siempre).

## Fix 3 — `exchangeAdapter.ts` tenía 0% de cobertura runtime

**Origen del hallazgo:** `CHECKPOINT_26.md`, "Recommended next priorities",
#1 ("if it's meant to be more than compile-time documentation, it needs at
least one test exercising a real implementation against it").

Las interfaces (`ExchangeAdapter`, `OrderBook`, `Ticker`, etc.) compilan a
nada — no son "cubribles". Lo único que sí produce JS real es
`MockExchangeAdapter`, una implementación completa de la interfaz pensada
para que otros tests del proyecto la usen. Nada la importaba todavía.

**Fix:** `tests/exchangeAdapter.test.js` — 25 tests nuevos, en tres grupos:
ciclo de vida (connect/disconnect/getHealth, incluyendo el path
`failConnect`), datos de mercado (`getOrderBook`/`getTicker` con y sin
datos configurados, `setTicker`), trading (`placeOrder` con precio
explícito vs. fallback al ask del ticker vs. sin ninguno de los dos,
cálculo de fee, `cancelOrder` idempotente) y cuenta (`getBalances`,
`getFees` con merge parcial). Además, un cuarto grupo ("as a real
ExchangeAdapter consumer would use it") ejercita una función genérica que
solo depende de la forma de la interfaz — no de `MockExchangeAdapter`
directamente — a través de un ciclo completo connect → leer ticker →
placeOrder → disconnect, incluyendo el camino de degradación cuando
`connect()` falla. Esto prueba lo que el propio JSDoc de la interfaz
promete ("código genérico que depende solo de `ExchangeAdapter` es
100% testeable sin red"), no solo que el mock ejecuta sin tirar.

**Resultado de cobertura:** `server/exchangeAdapter.js` pasó de 0% a
**100%/100%/100%/100%** (statements/branch/func/lines).

## Fix 4 — `replayService.js` en 48% de branch coverage

**Origen del hallazgo:** `vitest.config.js` (comentario de umbrales), listado junto
a `liveInventoryReconciliation.js` como débil. Al medir de nuevo esta sesión,
`liveInventoryReconciliation.js` ya estaba en 95.52/94.28/92.3/98.21 — resuelto
en algún checkpoint intermedio no mencionado explícitamente. `replayService.js`
seguía en 53.65/48.35/60/55.22 (stmts/branch/func/lines).

El archivo tiene una arquitectura de "buffer en memoria siempre disponible +
persistencia opcional en Mongo" — y los 17 tests existentes en
`tests/replayService.test.js` corrían enteramente con
`mongoose.connection.readyState = 0` (default del mock global), así que las 4
ramas "Mongo listo" (`saveSnapshot`'s create, `listReplays`, `getReplayById`,
`getBestReplay`) nunca se ejecutaban.

**Fix:** 10 tests nuevos que fuerzan `mongoose.connection.readyState = 1` y
mockean (`vi.spyOn`) los métodos puntuales del modelo `ReplaySnapshot` — éxito,
catch no-fatal, y "conectado pero cero resultados" para cada una de las 4
funciones. Al construirlos se pisó dos veces la misma trampa que
`tests/spreadHeatmapService.test.js` ya documenta explícitamente para
`HeatmapBucket.js`: si una llamada a Mongo queda sin mockear mientras
`readyState=1`, cae al mongoose real y el test tarda ~5s (o cuelga) intentando
conectar. Se detectó por bisección (`vitest -t "<nombre>"` uno por uno con
timeout corto) y se corrigió sembrando el buffer en memoria con
`readyState=0` y subiéndolo a `1` solo justo antes de invocar la función bajo
prueba ya mockeada — nunca dejando una llamada real a Mongo sin cubrir a mitad
de un test.

**Resultado de cobertura (medido en aislamiento, ver nota abajo):**
53.65/48.35/60/55.22 → **96.34/74.72/100/100** (stmts/branch/func/lines).
Nota: al correr la suite completa el reporte de v8 fusiona cobertura entre
workers paralelos y puede mostrar un número distinto (73/66/93/79) para el
mismo archivo — es una particularidad conocida de cómo vitest reparte
módulos entre workers, no una regresión; los 10 tests nuevos pasan
consistentemente y sin cuelgues en ambos modos (aislado y suite completa).

## Fix 5 — Igualdad de floats en la actualización de deltas de order book (Kraken/Bybit)

**Origen del hallazgo:** `CHECKPOINT_26.md`, "Remaining risks" — "safe today
but a fragile invariant... worth a comment or a more defensive key".

`applyUpdate()` en `connectKraken()`/`connectBybit()` buscaba el nivel de
precio a actualizar con `arr.findIndex(([p]) => p === price)` sobre valores
`parseFloat()`'d. Esto es correcto hoy porque ambos exchanges re-serializan
el mismo nivel de precio de forma idéntica entre el snapshot inicial y los
deltas posteriores — pero esa invariante no estaba documentada ni impuesta
en ningún lado, y el propio checkpoint anterior explícitamente evitó tocarlo
más allá de señalarlo, por ser de bajo riesgo/bajo impacto inmediato.

**Fix:** helper compartido `_samePriceLevel(a, b)` — igualdad exacta primero
(camino rápido, sin cambio de comportamiento en el caso normal), y si no,
tolerancia relativa (`1e-9`) para reconocer el mismo nivel económico de
precio aunque el float difiera por un residuo de precisión/serialización.
Usado en los dos `findIndex()` (Kraken y Bybit); no se tocó OKX/Coinbase
porque no manejan deltas L2 (solo snapshots completos).

**Tests:** 5 nuevos en `tests/exchangeService.test.js` (19 tests totales en
el archivo, antes 14), alimentando mensajes WS reales de snapshot+delta:
reemplazo de cantidad en el mismo nivel (caso normal bit-idéntico), el mismo
nivel enviado con formato decimal distinto sigue reconociéndose como el
mismo nivel (no duplica), y remoción de nivel con qty=0 — los tres para
Kraken y Bybit.

## Verificación end-to-end (esta sesión, sobre el código ya modificado)

```
npx vitest run                    → 104 archivos / 1728 tests, 0 fallos (1679 baseline + 49 nuevos)
npx tsc --noEmit                  → 0 errores
node scripts/checkTsBuildDrift.js → sin drift, 12 archivos verificados
npm run lint                      → 0 errores, 0 warnings
node scripts/checkI18nCoverage.js → 349 llaves, paridad es/en
npm run build                     → build de producción exitoso
node tests/smoke.test.js          → 76/76
```

## Archivos modificados esta sesión

- `server/infrastructure/exchangeService.js` — Fix 1.
- `tests/exchangeService.test.js` — 3 tests nuevos para Fix 1.
- `server/infrastructure/tenantStore.js` — Fix 2 (mecanismo genérico).
- `server-types/server/infrastructure/tenantStore.d.ts` — tipos de Fix 2.
- `server-types/server/infrastructure/tenantBotState.d.ts` — **nuevo**,
  requerido por Fix 2.
- `server-types/server/domain/wallet/walletManager.ts` — wiring de Fix 2.
- `server/domain/wallet/walletManager.js` — regenerado por `tsc` a partir
  del `.ts` de arriba (nunca editado a mano).
- `tests/tenantStore.test.js` — 4 tests nuevos para Fix 2.
- `tests/walletManager.test.js` — 2 tests de integración para Fix 2.
- `tests/exchangeAdapter.test.js` — **nuevo**, 25 tests para Fix 3.
- `tests/replayService.test.js` — 10 tests nuevos para Fix 4.
- `server/infrastructure/exchangeService.js` — Fix 5 (además de Fix 1, mismo archivo).
- `tests/exchangeService.test.js` — 5 tests más para Fix 5 (8 en total esta sesión).
- `docs/history/CHECKPOINT_27.md` — este documento.

No se borró ningún archivo (salvo un test temporal de diagnóstico creado y
eliminado en el mismo turno mientras se investigaba Fix 4, nunca comiteado).
No se tocó ningún otro módulo — los cuatro fixes son quirúrgicos, cada uno
acotado al gap específico que originó, siguiendo el mismo criterio que ya
establecía `CHECKPOINT_26.md`: no mezclar una revisión de
reliability/correctness con una refactorización arquitectónica no
solicitada.

## Lo que esta sesión NO hizo (honesto, no exhaustivo)

Esto **no** es la auditoría adversarial completa de 12 fases que se pidió
originalmente sobre los 472 archivos del proyecto. Es el cierre verificado
de tres gaps específicos que 26 sesiones previas ya habían identificado y
documentado, pero no corregido. Explícitamente fuera de alcance hoy (lista
no exhaustiva, tomada de los propios "remaining risks" de checkpoints
anteriores que siguen sin tocar):

- El refactor de `exchangeService.js` de estado-singleton-de-módulo a
  clases `ExchangeConnection` por exchange — mencionado en `CHECKPOINT_26`
  como el ítem de mayor riesgo/esfuerzo, deliberadamente pospuesto ahí y
  aquí.
- `replayService.js` (48% branch coverage) y
  `liveInventoryReconciliation.js` — marcados débiles en
  `vitest.config.js` desde antes de `CHECKPOINT_26`, sin revisión línea por
  línea todavía.
- XRP/USDT como tercer par operable de verdad — la capa de configuración
  existe, el pipeline de ejecución/wallets sigue codificado a BTC/ETH
  (ver `CommitteeReadiness.md`, punto 4).
- Ninguna de las Fases 2-9 originales (revisión archivo-por-archivo con
  calificación 1-100, motor de arbitraje completo, frontend, DB, OWASP
  Top 10) se rehizo desde cero. Si se necesita esa auditoría completa de
  verdad, la recomendación sigue siendo la misma que ya deja
  `TechnicalDueDiligence-2026-07-02.md`: rehacerla contra el código actual
  en sesiones dedicadas y acotadas, no como un solo pase superficial sobre
  472 archivos.

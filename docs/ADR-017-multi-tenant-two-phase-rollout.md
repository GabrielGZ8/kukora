# ADR-017 — Multi-tenant real (item 1): rollout en dos fases

**Status**: Accepted — Fase A y Fase B implementadas y verificadas. Sesión
2026-07-07 (siguiente): A3 (ETH) y A4 (test regresión Multi-Hop) completos;
A1 (SSE por-usuario) parcial — función pura lista, wiring diferido; A2
(sesiones/replay/analytics) documentado servicio por servicio, un bug real
de persistencia cross-tenant encontrado y corregido. Ver CHECKPOINT_07.md.
**Date**: 2026-07-06 (Fase A) / 2026-07-07 (Fase B) / 2026-07-07 (sesión
siguiente — pendientes reales)

## Contexto

Decisión de producto explícita: cada usuario autenticado (Firebase UID)
debe tener su propio paper-trading account lógico — wallets, P&L,
historial, config, oportunidades, replay, analytics, sesiones — sin
crear un proceso/hilo/instancia por usuario. Un único backend gestiona N
sesiones aisladas. Además, el diseño debe dejar espacio para que un mismo
usuario corra más de un bot (estrategias distintas) en el futuro, aunque
hoy cada usuario tenga exactamente uno.

Estado real del código al tomar esta decisión (`CHECKPOINT_03.md`):
`wallets`/`tradeHistory`/`P&L` ya están aislados por uid
(`walletManager.ts` + `tenantStore.js`, checkpoint anterior). Todo lo
demás — `botEnabled`, config (`liveConfig`), el loop de detección de
150ms, y el broadcast SSE — sigue siendo estado de un único proceso
compartido, leído/escrito desde ~15 puntos del hot path en
`arbitrageOrchestrator.js` y las 3 subrutas de `server/arbitrage/`.

## Decisión de diseño

**Un único motor de detección compartido + N contextos de tenant que lo
consumen.** El order-book y la detección de oportunidades (spread,
liquidez, fill probability) son datos de MERCADO, no de usuario — no
tiene sentido ni es seguro (rate limits) duplicar esos fetches por
usuario. Lo que sí es por-usuario es la DECISIÓN (¿con mi config, mi
wallet, mi riesgo, ejecuto esta oportunidad compartida?) y el RESULTADO
(mi wallet, mi P&L, mi historial cambian — el de nadie más).

Esto es exactamente el patrón que ya existe para Multi-Hop (item 4):
capacidad construida de forma aditiva, gateada, sin cambiar el
comportamiento por defecto hasta que se conecta explícitamente.

La clave de cada store por-tenant sigue siendo hoy el `uid` puro.
`tenantStore.resolveTenantKey(uid, botId)` (nuevo, este ADR) documenta la
extensión a `uid::botId` para cuando exista más de un bot por usuario —
ningún store existente cambia de forma cuando llegue ese día, solo la
clave que reciben.

## Fase A (esta sesión) — construida y verificada

Primitivos nuevos, 100% aditivos, **no conectados al hot path**:

- `tenantStore.resolveTenantKey` / `DEFAULT_BOT_ID` — convención de clave
  para multi-bot futuro (documentación + helper, sin uso real todavía).
- `tenantConfig.js` — overrides de configuración por-tenant sobre
  `liveConfig`, reutilizando `liveConfig.validateOne` (nueva exportación)
  para no duplicar las ~40 reglas de validación. `getEffective(uid, key)`
  cae al valor global si el tenant no tiene override — comportamiento
  idéntico al actual para cualquier caller que no pase `uid`.
- `tenantBotState.js` — intención on/off + metadata de sesión por-tenant,
  independiente del `getBotEnabled()/setBotEnabled()` global de
  `arbitrage/subroutes/state.js` (ese no se tocó).
- Ya existente (checkpoint anterior): `walletManager.ts` por-uid
  (wallets, P&L, historial, mutex).

19 tests nuevos, suite completa 83 archivos / 1448 tests, `tsc --noEmit`
limpio.

## Fase B (recomendada DESPUÉS del 12 de julio) — no implementada aún

Requiere modificar el hot path en vivo:

1. `arbitrageOrchestrator.js`: el tick de 150ms deja de leer
   `getBotEnabled()` global y en su lugar itera
   `tenantBotState.activeUids()`, evaluando las mismas oportunidades
   detectadas contra `tenantConfig.getEffective(uid, ...)` y ejecutando
   contra `walletManager` con ese `uid`.
2. SSE (`stream.routes.js`): el broadcast pasa de "un estado global a
   todos los clientes" a "estado por-uid al cliente correspondiente"
   (datos de mercado compartidos siguen siendo globales; wallets/P&L/bot
   status pasan a ser el snapshot de ESE tenant).
3. Sesiones, replay, analytics, caches: mismo patrón `tenantStore` que
   `walletManager`, aplicado servicio por servicio.

## Por qué se difiere Fase B

Coherente con la política ya establecida en este proyecto (ADR-016, C-3):
los cambios de alto riesgo sobre el motor de ejecución en vivo se
posponen hasta después de la evaluación del 12 de julio. Fase B toca
simultáneamente el loop de trading, el config que ese loop lee en cada
tick, y el broadcast en tiempo real — el tipo de cambio que, si sale mal,
sale mal en producción durante la demo. Fase A entrega toda la capacidad
de aislamiento verificada y sin riesgo; Fase B es un cambio acotado y de
alcance conocido para la siguiente sesión, sin deadline encima.

## Fase B — completada (2026-07-07)

Implementada en `server/infrastructure/tenantExecution.js`, conectada en
`arbitrageOrchestrator.js` justo después de la ejecución del bot
compartido en el tick de 150ms. Ver el comentario de cabecera de ese
archivo para el diseño completo y las decisiones de alcance. Resumen:

- El loop de 150ms SÍ itera ahora `tenantBotState.activeUids()`, pero como
  un PASE ADICIONAL después del bot compartido (que no cambió), no como
  un reemplazo — más simple y más seguro de verificar que "flipear" el
  loop existente.
- Selección/ejecución contra `tenantConfig.getEffective(uid, ...)` y
  `walletManager` con `uid`, con de-dup de fingerprint por-tenant
  (independiente del Map global).
- Deliberadamente NO pasa por risk engine/state machine/predictive
  rebalance/slippage validator/alertas (siguen siendo infraestructura
  compartida — un único cerebro de riesgo para toda la plataforma
  agregada). Alcance BTC únicamente; ETH queda para una sesión futura
  (mismo patrón, sin riesgo adicional de diseño).
- SSE por-usuario y el resto de "Fase B" original (sesiones, replay,
  analytics por-tenant) siguen sin implementar — ver sección siguiente.

## Pendiente real después de esta sesión (actualizado 2026-07-07, sesión siguiente)

Estado actualizado de los 4 puntos que quedaron pendientes en la sesión
anterior — ver `CHECKPOINT_07.md` para el detalle completo de qué se hizo,
qué se verificó, y qué queda genuinamente pendiente.

1. **SSE por-usuario (`stream.routes.js`) — parcialmente resuelto.** Se
   construyó y probó `server/infrastructure/tenantSseDelta.js`
   (`buildTenantSseDelta`/`mergeTenantOverlay`) — la función PURA que arma
   el snapshot por-tenant (wallet/P&L/bot-status/historial) a superponer
   sobre el payload compartido, aditiva por diseño (sin `uid`, retorna la
   misma referencia del payload compartido). **NO se conectó** al
   broadcast en caliente esta sesión — eso requiere que `sseClients` deje
   de ser un `Set<res>` ciego al uid y pase a asociar cada conexión con su
   `req.userId`, tocando el mismo hot path en vivo que la demo usa. Se
   difiere con la misma disciplina que difirió Fase B originalmente (ver
   más abajo) — recomendado para la siguiente sesión, sin presión de
   deadline.
2. **Sesiones, replay, analytics — decisión documentada, no re-arquitecturado.**
   Revisión servicio por servicio (ver `CHECKPOINT_07.md`):
   - `replayService.js`: **datos de mercado, no tocar.** Captura order
     books + la oportunidad detectada por el tick COMPARTIDO; el único
     dato "de ejecución" que guarda es el trade del bot compartido (nunca
     recibe trades de `tenantExecution.js`) — no hay fuga entre tenants
     porque hoy no hay ningún trade de tenant en el replay. Clasificación
     correcta y ya consistente con ADR-017 sin cambios necesarios.
   - `persistenceService.js` (sesión/equity/trade legacy + `EngineSnapshot`):
     **de usuario, pero hoy solo implementado para el bot compartido**
     (`restoreEngineSnapshot('default')`, hardcoded). El primitivo
     per-usuario (`persistEngineSnapshot(snapshot, userId)`) YA EXISTE
     desde antes de esta sesión — nunca se conectó a tenants reales. No es
     una fuga (cada tenant no persiste NADA a Mongo todavía, así que no
     hay mezcla), pero si el proceso reinicia, el estado de un tenant
     activo se pierde por completo (solo vive en el `Map` en memoria de
     `walletManager`/`tenantConfig`/`tenantBotState`). Pendiente real:
     conectar `persistEngineSnapshot`/`restoreEngineSnapshot` a
     `tenantBotState.activeUids()`, igual que `tenantExecution.js` ya hizo
     con la ejecución.
   - `walletManager.ts` (`ArbitrageOp`, la copia de auditoría en Mongo de
     cada trade): **bug real encontrado y corregido esta sesión** — no
     tenía campo `uid`, mezclando trades de todos los tenants en la misma
     colección sin forma de distinguirlos. Fix aplicado (ver CHANGELOG
     [2.11.0]) — campo `uid` opcional agregado, pasado desde
     `applyTrade(trade, uid)`.
3. **Extensión del pase de ejecución a ETH — completo.** Ver CHANGELOG
   [2.11.0] y el comentario de cabecera actualizado de
   `tenantExecution.js`. `runTenantExecutionPass` ahora evalúa BTC y ETH
   por tenant, con fingerprints independientes por pool de asset,
   retrocompatible con la firma anterior a esta sesión.
4. **Test de regresión para Multi-Hop event-driven — completo.** Ver
   CHANGELOG [2.11.0]. `_attachEventDriven()` extraído a
   `_handlePriceUpdate`/`_handlePriceUpdateForTests`;
   `tests/arbitrageOrchestratorEventDriven.test.js` verifica la regresión
   directamente (confirmado reintroduciendo el bug temporalmente durante
   el desarrollo del test y viéndolo fallar).

### Hallazgos adicionales de esta sesión (fuera del alcance de los 4 puntos de arriba)

- **Fuga de memoria en `createTenantStore`** (`tenantStore.js`): el `Map`
  interno de todo store por-tenant crecía sin límite. Corregido con un
  LRU acotado (1000 tenants por defecto) en el factory — ver CHANGELOG
  [2.11.0].

### Pendiente real después de ESTA sesión

1. Wiring del broadcast SSE por-tenant al hot path (punto 1 arriba).
2. Conectar `persistEngineSnapshot`/`restoreEngineSnapshot` a tenants
   activos reales (punto 2 arriba) — el primitivo ya existe, falta el
   wiring, mismo patrón de riesgo que el punto 1 (toca persistencia
   invocada desde el hot path).
3. Verificación end-to-end con supertest de dos conexiones SSE
   concurrentes con uids distintos (bloqueada por el punto 1 — no hay
   wiring real que probar end-to-end todavía, solo la función pura).

## Cierre de los 5 pendientes — sesión siguiente (2026-07-08, [2.12.0])

Ver `CHECKPOINT_08.md` y CHANGELOG `[2.12.0]` para el detalle completo.
Resumen de cómo quedó cada punto:

1. **SSE por-tenant — completo.** `mergeTenantOverlay` (ya escrito y
   probado la sesión anterior) ahora SÍ está conectado: `sseClients` pasa
   a trackear el `uid` de cada conexión (`sseClientUid`), y `pushToSSE()`
   superpone el delta por-tenant antes de escribir a cada `res`
   individual — sigue siendo un solo cómputo de tick por ciclo de 150ms,
   no N cómputos por tenant, solo el overlay final es por-cliente. El
   payload `init` de `GET /stream` también pasa por el overlay. Dos
   usuarios conectados a la vez ahora reciben wallet/P&L propios del
   mismo broadcast — el riesgo que este ADR marcaba como "el más
   peligroso del backlog" se tomó con el mismo cuidado: wiring aislado,
   tests de regresión en `arbitrage.state.test.js`/
   `arbitrage.stream.routes.test.js`, boot+SIGTERM real antes y después.
2. **Persistencia por-tenant — completo.** `tenantPersistence.js` nuevo
   conecta `persistEngineSnapshot`/`restoreEngineSnapshot` (el primitivo
   que ya existía) a `tenantBotState.activeUids()`, con el mismo patrón
   de flush periódico (30s) y aislamiento de fallas por tenant que ya usa
   `tenantExecution.js`. Verificado con boot real.
3. **Risk engine — decisión de ADR-017 (un solo cerebro global) se
   mantiene, pero se añadió una capa por-tenant complementaria.**
   `tenantRiskGuard.js` da a cada tenant su propio circuit breaker/límite
   de drawdown/position-size guard, aditivo sobre el risk engine
   compartido (que sigue siendo la única defensa de riesgo agregado de la
   plataforma — eso no cambió). Cierra el hallazgo de auditoría "un
   tenant con mala config no tiene protección individual real".
4. **Coverage medido.** `vitest run --coverage` corrido por primera vez:
   70.04%/59.45%/68.14%/73.28% (statements/branches/funciones/líneas)
   agregado; módulos nuevos de esta sesión entre 85–100%. Huecos
   identificados en módulos no tocados esta sesión — ver CHECKPOINT_08.
5. **Auditoría de seguridad (auth/2FA/rate-limiting) — completa.** Sin
   hallazgos de vulnerabilidad en el diseño existente; un hallazgo real
   en las rutas NUEVAS de este ciclo (`tenantBot.routes.js` sin
   rate-limiting propio), corregido aplicando `financialControlLimiter`.

## Alternativas consideradas

- **Un proceso por usuario**: descartado explícitamente por el usuario
  (no quiere N instancias) y además multiplica conexiones WebSocket a los
  5 exchanges (ver ADR-016) — inviable a escala.
- **Fork completo del config/loop por usuario ahora mismo**: mismo
  resultado funcional que Fase B pero sin los primitivos de Fase A
  probados primero — mayor riesgo de romper el bot compartido a días del
  deadline, sin ganancia real (nadie usa multi-tenant en la demo del 12).

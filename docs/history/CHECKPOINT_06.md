# CHECKPOINT_06 — Cierre final: items 1(fase B)/2/3/5/6 completos + item 7 (auditoría final)

Continúa desde `CHECKPOINT_05.md` (item 1 fase B recién conectada) y
cierra la sesión con la auditoría final profunda solicitada (item 7).

Verificación en cada bloque: `vitest run` → `tsc --noEmit` → `npm run
build:ts` → `npm run lint` → arranque real (`node server/index.js`) +
`SIGTERM` graceful shutdown. Estado final: **86 archivos / 1471 tests**,
`tsc` limpio, `eslint` limpio (`src/` + `server/`), build limpio,
arranque/apagado verificados end-to-end.

## Estado de todos los items pedidos

| Item | Estado |
|---|---|
| 1 — Multi-tenant real | **Completo** (Fase A + Fase B). Ver ADR-017. |
| 2 — Config dinámica | Completo (sesión anterior, incluido en este zip). |
| 3 — Generalización XRP (parte segura) | Completo (sesión anterior). |
| 4 — Multi-Hop | Completo (checkpoints previos) + **bug real corregido en esta auditoría**. |
| 5 — Mongo Atlas | Completo (checkpoint anterior). |
| 6 — Explainability | Completo (checkpoint anterior). |
| 7 — Auditoría final profunda | Completo — ver abajo. |

## Item 7 — Auditoría final profunda: hallazgos y correcciones

Metodología: `npm run lint` (ESLint 8, config del propio proyecto) sobre
`src/` + `server/` completo — no solo el código tocado esta sesión, todo
el árbol — más revisión manual de cada hallazgo antes de decidir si era
un bug real o ruido estilístico.

### Bug real encontrado y corregido: Multi-Hop nunca ejecutaba vía el path event-driven

`server/application/arbitrageOrchestrator.js`, función interna
`_attachEventDriven()` (el handler de `priceUpdate`, camino de <30ms
latencia): usaba `multiHopSignal` para decidir si ejecutar una
oportunidad Multi-Hop (item 4), pero **nunca lo extraía** del resultado
de `detectOpportunities()` en ese path — la desestructuración solo traía
`{ opportunities, triangularSignal, statArbSignals }`, a diferencia del
path de polling (`detectBtcOpportunities()`), que sí extrae
`multiHopSignal` correctamente.

Efecto real: con `liveConfig.multiHopEnabled = true` (deshabilitado por
defecto — por eso nunca se manifestó en tests ni en demo), cada
`priceUpdate` disparaba un `ReferenceError: multiHopSignal is not
defined`, atrapado por el `try/catch` existente y logueado como warning
(`_warn('[multihop]', ...)`). Resultado: Multi-Hop, cuando se activa,
jamás llega a ejecutar un solo trade por esta vía — la única vía donde
tenía lógica de ejecución (el loop de 150ms solo lo calcula para
telemetría/payload, no ejecuta).

**Fix**: agregar `multiHopSignal` a la desestructuración, en la misma
línea donde ya vivía `triangularSignal` (que sí funcionaba). Un carácter
de causa, efecto real en una feature marcada "completa" en checkpoints
previos. Verificado: `tsc`/`lint`/suite completa limpios tras el fix.

**Nota de honestidad**: no se agregó un test de regresión dedicado para
este path específico (requeriría mockear `priceEmitter`/`getOrderBooks`
para el handler interno no exportado — infraestructura de test que no
existe hoy para el path event-driven). Queda como recomendación explícita
para la siguiente sesión, no como pendiente oculto.

### Hallazgo estilístico corregido (sin efecto de runtime)

`server/index.js`: 3 declaraciones de función (`_onMongoConnected`,
`_scheduleMongoRetry`, `bootRetryConnect`) vivían como
`function foo() {}` dentro de un bloque `if (process.env.MONGODB_URI)`
— válido en la práctica en V8/Node (nunca se invocan antes de su propia
declaración), pero marcado por `no-inner-declarations` porque el
comportamiento de hoisting de function-declarations dentro de bloques no
es 100% uniforme entre entornos JS. Convertidas a `const foo = function
foo() {}` — cero cambio de comportamiento, satisface el lint.

### Consistencia de versionado

`package.json` decía `2.6.0` mientras `CHANGELOG.md` ya documentaba hasta
`[2.9.0]` (desfase pre-existente, no introducido esta sesión). Corregido
a `2.10.0`, que ahora sí refleja el HEAD real del CHANGELOG (incluyendo
la entrada nueva de esta sesión).

## Lo que NO se tocó (alcance real restante, documentado para no perderlo)

Ver `docs/ADR-017-multi-tenant-two-phase-rollout.md`, sección "Pendiente
real después de esta sesión":
1. SSE por-usuario (`stream.routes.js`) — el broadcast del tick sigue
   siendo el snapshot del bot compartido para todos los clientes.
2. Sesiones, replay, analytics por-tenant — mismo patrón `tenantStore`
   que `walletManager`, servicio por servicio, ninguno tocado.
3. Extensión del pase de ejecución por-tenant a ETH (mecánica, bajo
   riesgo — mismo patrón que BTC, otra lista de oportunidades).
4. Un test de regresión dedicado para el path event-driven de Multi-Hop
   (ver nota de honestidad arriba).

Estos 4 puntos son el único trabajo real pendiente conocido en todo el
proyecto a día de hoy. Todo lo demás pedido en esta sesión y las
anteriores está completo, verificado, y documentado.

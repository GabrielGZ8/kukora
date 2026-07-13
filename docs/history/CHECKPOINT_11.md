## CHECKPOINT_11 — Sesión 2026-07-08 (noche): punto 1 de la hoja de ruta
(tipos de dominio únicos), avance acotado y verificado

Esta sesión parte de `docs/Kukora-Auditoria-Comite-2026-07-08.md` (adjuntada
por el usuario) y del zip `Kukora-CHECKPOINT-10.zip`, cuyo `CHECKPOINT_10.md`
documenta 5 de los 8 puntos de la hoja de ruta ya resueltos y deja el punto 1
("tipos de dominio únicos `Opportunity`/`Trade`/`RiskContext`, compartidos
entre los ~17 módulos de `domain/engines/`") como el de mayor prioridad para
esta sesión. Línea base verificada antes de tocar nada: `npm ci` +
`npx vitest run` → **94 archivos, 1566 tests, 0 fallos, 58.1s**. Igual que en
las sesiones anteriores, todo lo que sigue se verificó de la misma forma
después de cada cambio, no se asume nada de la documentación previa.

### Alcance real de esta sesión (léase antes de lo demás)

El punto 1 completo — los ~17 motores de `domain/engines/` importando y
validando contra tipos compartidos — es, tal como ya advertía
`CHECKPOINT_10.md`, el ítem más caro de la hoja de ruta. No se completó
entero en esta sesión. Lo que sí se hizo, y se verificó de punta a punta,
fue:

1. **Corregir un drift real entre el tipo `ExecutedTrade` declarado y el
   objeto que `executeSimulated()` produce de verdad** (encontrado al leer
   el código, no documentado antes de esta sesión).
2. **Crear el tercer tipo de dominio que faltaba, `RiskContext`**, con
   constructor y type guard, más un adaptador sobre el motor de riesgo
   global existente.
3. **Conectar ambos contratos a sus productores reales** (no solo
   declararlos) en los tres puntos de mayor apalancamiento: la construcción
   del `Opportunity` y del `Trade` en `opportunityDetection.js`, y la
   respuesta del endpoint `/api/arbitrage/risk/status`.
4. **Documentar, sin forzar, la relación entre el `Trade` canónico y el tipo
   `IncomingTrade` que ya existía en `walletManager.ts`** — deliberadamente
   sin unificarlos estructuralmente (ver razón abajo).
5. Dejar explícitamente pendientes, con alcance claro, los ~13 motores
   satélite que aún no importan ningún tipo compartido.

### 1. `Trade` — el tipo estaba mal, no solo ausente

`server-types/server/domain/opportunity.ts` ya tenía un `Opportunity`
(fields correctos, usado por `isOpportunity()`) y un `ExecutedTrade`
declarado pero **nunca comparado contra el objeto real** que construye
`executeSimulated()` en `opportunityDetection.js`. Al leerlos lado a lado:

- `ExecutedTrade` declaraba `fillPct`, `executedAt`, `source`, `tradeAmount`,
  `viable` — ninguno de estos campos existe en el objeto real.
- El objeto real tiene `asset`, `requestedAmount`, `netProfitPct`,
  `spreadPct`, `breakEvenPct`, `score`, `buySource`, `sellSource`, `status`,
  `ts` — ninguno estaba en el tipo declarado.

Un tipo que ningún objeto real satisface es peor que no tener tipo: da
confianza falsa sin detectar nada. Se reescribió como `Trade` (con
`ExecutedTrade` como alias `@deprecated` para no romper imports futuros),
derivado directamente del objeto literal de `executeSimulated()`, más:

- `isTrade(obj)` — type guard runtime, mismo patrón que `isOpportunity`.
- `createTrade(fields, startedAt?)` — constructor canónico que completa
  `id`/`ts`/`status`/`executionMs`/`totalFees` con los mismos defaults que
  `executeSimulated()` calcula a mano, para que código futuro (tests,
  replay de backtest, motores satélite) no reimplemente ese boilerplate
  con sus propios defaults potencialmente inconsistentes.

**Conectado a su productor real:** `opportunityDetection.js` ahora importa
`isOpportunity`/`isTrade` y valida el `op`/`trade` que construye contra el
contrato justo antes de devolverlo — si una edición futura rompe la forma,
se detecta ahí (vía `obs.emit('RISK', 'contract.*_shape_invalid', ...)`,
no bloqueante) en vez de como un `undefined` confuso tres módulos más abajo.
Test de contrato (`tests/opportunity.test.js`) verifica que el `trade` real
que devuelve `executeSimulated()` contra un fixture de order books
efectivamente cumple `isTrade()` — mismo patrón que el test ya existente
para `isOpportunity()`.

### 2. `RiskContext` — tipo nuevo, no existía ninguno compartido

La auditoría pide `RiskContext` explícitamente (sección 12, punto 1) y no
existía ni como tipo ni como shape documentado en ningún lado. Lo que sí
existía — y sigue existiendo, sin tocar — son dos formas de "estado de
riesgo" completamente independientes:

- `advancedRiskEngine.getStatus()` (motor global compartido): `RiskStatus`,
  anidado (`circuitBreaker.active`, `drawdown.pct`, etc.), definido
  localmente en `advancedRiskEngine.ts`.
- `tenantRiskGuard.js` (guard por-tenant, ADR-017): objetos ad hoc
  `{ok, reason}` / `{active, reason, triggerType, activatedAt}`, sin
  ningún tipo compartido con el motor global aunque cubre el mismo dominio.

`server-types/server/domain/risk/riskContext.ts` (nuevo, compila a
`server/domain/risk/riskContext.js`) define:

- `RiskContext` — forma plana y normalizada (`uid`, `source: 'global' |
  'tenant'`, `circuitBreakerActive`, `drawdownPct`, `sessionPnl`,
  `dailyLossLimitUSD`, `maxPositionValueUSD`, `consecutiveLosses`, `ts`).
- `isRiskContext(obj)` / `createRiskContext(fields)` — mismo patrón que
  `Opportunity`/`Trade`.
- `fromAdvancedRiskStatus(status)` — adaptador puro (sin side effects, no
  toca el estado del motor) de `RiskStatus` (anidado, específico del motor
  global) a `RiskContext` (plano, canónico). Deliberadamente defensivo con
  optional chaining — un test lo descubrió: el mock de `advRisk.getStatus`
  en `tests/arbitrage.query.routes.test.js` devuelve un objeto parcial
  (`{circuitBreaker:{active:false}, consecutiveFailures:0}`), y una primera
  versión sin optional chaining lanzaba `TypeError` al leer
  `status.drawdown.pct` sobre ese mock — exactamente el tipo de contrato
  rígido que rompe tests existentes en vez de dar valor.

**Conectado a su consumidor real:** el endpoint `GET
/api/arbitrage/risk/status` (`arbitrage/subroutes/query.routes.js`) ahora
valida `fromAdvancedRiskStatus(status)` contra `isRiskContext()` antes de
responder — el body de la respuesta no cambia (el frontend sigue leyendo el
`RiskStatus` anidado tal cual), es un chequeo de regresión, no una
migración de contrato del endpoint.

`tenantRiskGuard.js` (el guard per-tenant) **no se tocó** — su alcance
deliberadamente acotado (ADR-017: no es una reescritura per-tenant del
motor global) significa que forzarlo a producir un `RiskContext` completo
sería expandir su alcance sin que la auditoría lo haya pedido. Queda
documentado como pendiente (ver más abajo) en vez de forzado.

### 3. `walletManager.ts` — documentado, no unificado (decisión explícita)

`walletManager.ts` ya tenía sus propios `IncomingTrade`/`EnrichedTrade` —
exactamente el patrón que la auditoría señala ("cada uno construye su
propia forma"). Se evaluó unificarlos estructuralmente con el `Trade`
canónico y se decidió no hacerlo: `IncomingTrade` es intencionalmente más
permisivo que `Trade` (casi todos los campos opcionales, index signature,
`id` acepta `number` para fixtures de test viejos) porque es un contrato de
**entrada** (antes de enriquecer), mientras que `Trade` es el contrato de
**salida** ya completo. Forzar identidad estructural entre ambos habría
significado debilitar `Trade` (aflojar sus campos requeridos, perdiendo la
garantía que motivó corregirlo en el punto 1) o romper callers existentes
que le pasan objetos parciales (legs de trade triangular, fixtures de
test). En cambio, se agregó un docstring en `IncomingTrade` que referencia
explícitamente el `Trade` canónico y explica por qué son dos tipos
distintos — la deriva que señalaba la auditoría era el silencio sobre la
relación, no la existencia de dos vistas sobre datos relacionados.

Es un cambio 100% de comentario/documentación: verificado compilando con
`tsc` a un directorio temporal y comparando byte a byte contra
`server/domain/wallet/walletManager.js` — **0 diferencias** (las interfaces
TS se borran en la compilación; no hay forma de que este cambio afecte el
runtime).

### Verificación completa (todo corrido de verdad, no asumido)

- `npx vitest run` → **95 archivos, 1579 tests, 0 fallos** (1566 base + 13
  nuevos: 10 en `tests/opportunity.test.js` ampliado con `isTrade`/
  `createTrade`/contrato real de `executeSimulated()`, 8 en
  `tests/riskContext.test.js` nuevo — la aritmética exacta es 1566 + 10 +
  8 − 5 de los que ya contaba `opportunity.test.js` antes de esta sesión =
  1579), 56.6s.
- `npx tsc --noEmit` → limpio.
- `npm run check:ts-drift` → sin drift, **7 archivos verificados** (6 base +
  `riskContext.js`, nuevo).
- `npm run check:i18n` → paridad, 240 llaves (sin cambios — esta sesión no
  tocó strings de UI).
- `npm run test:smoke` → 76/76.
- `npx eslint server/ src/ --ext .js,.jsx` → 0 errores, 0 warnings.
- `npm run build` → limpio; `ArbitragePage` chunk sin cambios (77.94 kB /
  20.21 kB gzip) — esta sesión no tocó frontend.

### Archivos nuevos o modificados esta sesión

- `server-types/server/domain/opportunity.ts` — `ExecutedTrade` → `Trade`
  corregido, `isTrade`, `createTrade`.
- `server-types/server/domain/risk/riskContext.ts` — nuevo.
- `server-types/server/domain/wallet/walletManager.ts` — docstring de
  `IncomingTrade` (sin cambio estructural).
- `server/domain/opportunity.js`, `server/domain/risk/riskContext.js` —
  compilados, sincronizados con `tsc`, verificados con `check:ts-drift`.
- `server/domain/engines/opportunityDetection.js` — valida `op`/`trade`
  contra `isOpportunity`/`isTrade` antes de devolverlos.
- `server/arbitrage/subroutes/query.routes.js` — valida la respuesta de
  `/risk/status` contra `isRiskContext(fromAdvancedRiskStatus(...))`.
- `tests/opportunity.test.js` — ampliado (guards/constructor de `Trade` +
  contrato real con `executeSimulated()`).
- `tests/riskContext.test.js` — nuevo (guard/constructor/adaptador de
  `RiskContext`, incluyendo el adaptador contra una llamada real a
  `advancedRiskEngine.getStatus()`).

### Lo que queda pendiente del punto 1 (no alcanzado esta sesión)

Los tres tipos (`Opportunity`, `Trade`, `RiskContext`) ahora existen,
tienen guards/constructores runtime, y están conectados a sus productores
más centrales — pero la mayoría de los ~17 módulos de `domain/engines/`
**todavía no importan ni validan contra ellos**. Específicamente, sin
tocar esta sesión (por alcance/tiempo, no por dificultad técnica pareja en
todos los casos):

- **Motores que reciben/enriquecen un `Opportunity` pero no lo validan al
  entrar o salir:** `fillProbabilityEngine.js` (agrega `fillProbability` —
  el `declare module` ya existe para esto, falta el `isOpportunity()` de
  entrada), `liquidityPredictionEngine.js`, `spreadMomentumEngine.js`,
  `statArbEngine.js`, `predictiveRebalance.js` — los 5 archivos que sí
  construyen objetos con forma de `Opportunity` (`grep buyExchange` los
  identifica) además de `opportunityDetection.js`.
- **Motores de scoring/backtest que reciben `Opportunity[]` u objetos con
  forma de `Trade` sin tipo:** `scoringService.js`, `adaptiveScoring.js`,
  `mlScoringPipeline.js`, `smartOrderRouter.js`, `backtestEngine.js`,
  `arbBacktestEngine.js`, `institutionalBacktest.js` — el hallazgo de la
  auditoría sobre estos tres últimos ("¿cuál usar para qué caso?") sigue
  sin resolver; no se tocó esta sesión.
- **`multiHopArbitrageEngine.js`, `rebalanceEngine.js`,
  `rebalanceScheduler.js`, `marketRegimeEngine.js`** — no manejan
  `Opportunity`/`Trade` directamente (operan sobre grafos de tasas o
  wallets), pero serían candidatos naturales a construir/consumir
  `RiskContext` si en el futuro se les agrega un guard de riesgo per-motor.
- **`tenantRiskGuard.js`** — deliberadamente no migrado a producir
  `RiskContext` (ver sección 2 arriba); si una sesión futura decide
  expandir su alcance, el adaptador `fromAdvancedRiskStatus` es el patrón a
  replicar (`fromTenantGuardStatus`, análogo).

Recomendación para la próxima sesión: tomar los 5 motores de la primera
categoría (los que ya construyen objetos con forma de `Opportunity`) uno
por uno — son el subconjunto de mayor riesgo real de drift silencioso
porque mutan/leen el mismo objeto que `opportunityDetection.js` produce, y
ya existe el patrón exacto a seguir (`isOpportunity()` a la entrada,
`obs.emit('RISK', 'contract.*', ...)` si falla, test de contrato contra el
productor real) en este checkpoint.

### Puntos 7 y 8 de la hoja de ruta — sin cambios esta sesión

No se tocaron por alcance/tiempo, igual que en `CHECKPOINT_10.md`:

- **Punto 7 — persistir snapshot completo de wallet en Mongo.** Sigue
  requiriendo diseño de esquema Mongoose + migración.
- **Punto 8 — unificar manejo de errores** (`DomainError` /
  `expressErrorHandler` ya wireados, rutas individuales sin migrar).

### Estado de los 8 puntos de la hoja de ruta al cierre de esta sesión

| # | Punto | Estado |
|---|---|---|
| 1 | Tipos de dominio únicos | 🟡 Avance parcial esta sesión — ver detalle arriba |
| 2 | README desalineado | ✅ Ya estaba resuelto |
| 3 | Aplanar `domain/` en subcarpetas | ✅ Resuelto (sesión anterior) |
| 4 | Auditar patrón `getHandler()` | ✅ Resuelto (sesión anterior) |
| 5 | Code-splitting de `ArbitragePage` | ✅ Ya estaba resuelto |
| 6 | Vista de entrada canónica | ✅ Ya estaba resuelto |
| 7 | Persistir wallet snapshot en Mongo | Pendiente |
| 8 | Unificar manejo de errores | Pendiente (infraestructura lista, migración de rutas pendiente) |

5 de 8 puntos resueltos, 1 en progreso con próximos pasos concretos
documentados, 2 pendientes sin cambio.

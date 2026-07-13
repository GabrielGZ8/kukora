## CHECKPOINT_18 — Sesión 2026-07-09 (continuación): `advancedRiskEngine`,
`multiHopArbitrageEngine` y `rebalanceEngine` cierran su contrato de dominio

**Fecha/hora:** 2026-07-09, ~05:32–05:48 UTC (nueva sesión de chat,
retomando desde `CHECKPOINT_17.md` + zip adjunto).

### 0. Hallazgo importante al arrancar esta sesión

Se me adjuntó, además del zip `CHECKPOINT-17` y el propio `CHECKPOINT_17.md`,
una transcripción de una sesión posterior que ya mostraba
`advancedRiskEngine.js` y `multiHopArbitrageEngine.js` cerrados (con guards,
tests, y "100 archivos / 1634 tests" en verde). **Verificado contra el zip
real recibido: ese trabajo NO estaba presente** — `grep isTradeLike`,
`isOpportunityLike` sobre el código real no devolvía nada, y la suite
real arrancaba en 98 archivos / 1621 tests (coincidiendo exactamente con
`CHECKPOINT_17.md`, no con la transcripción). Es decir: se repitió — por
tercera vez — el mismo bug de empaquetado ya documentado en
`CHECKPOINT_15.md`/`CHECKPOINT_16.md` (trabajo real hecho en una sesión que
nunca llegó al zip entregado).

**Consecuencia para esta sesión:** se rehizo desde cero el trabajo de
`advancedRiskEngine.js` y `multiHopArbitrageEngine.js` (releyendo el código
real, no copiando la transcripción a ciegas — aunque el patrón resultó
idéntico al descrito, se verificó cada paso contra el archivo real antes de
escribir) y se avanzó un tercer motor (`rebalanceEngine.js`) en la misma
sesión. Todo lo documentado abajo fue verificado contra el zip que
efectivamente se empaqueta con este checkpoint.

### 1. `advancedRiskEngine.js` (server/domain/risk/, 554 líneas) — CERRADO

El motor de riesgo real (circuit breaker, drawdown, exposición,
pre-trade risk check) ya estaba extensamente tipado en TypeScript
(`server-types/server/domain/risk/advancedRiskEngine.ts`, 762 líneas) con
sus propios discriminated unions (`DrawdownCheckResult`,
`PositionSizeResult`, `EmergencyStopResult`, etc.) — pero definía sus
propios `TradeLike`/`OpportunityLike` inline SIN type guards en runtime, y
sin documentar por qué son deliberadamente distintos de `Trade`/
`Opportunity` canónicos.

- Verificado contra los call-sites reales
  (`server/application/liveExecution.js`,
  `server/application/arbitrageOrchestrator.js`) que ambos tipos son
  **intencionalmente** contratos reducidos (los llamadores pasan objetos
  sintéticos parciales, no un `Opportunity`/`Trade` completo) — forzar el
  tipo canónico habría sido un fix incorrecto.
- Se agregaron `isTradeLike()`/`isOpportunityLike()` (guards mínimos: solo
  validan "es un objeto plano", ya que todos los campos son opcionales) con
  documentación explícita de por qué el contrato reducido es correcto.
- Wireados como self-check no bloqueante en `updateExposure()` (solo
  cuando `trade !== null`, ya que `null` es un valor legítimo) y al inicio
  de `preTradeRiskCheck()`. Emiten `obs.emit('RISK',
  'contract.trade_like_shape_invalid'|'contract.risk_opportunity_shape_invalid',
  {...})` sin lanzar ni alterar el resultado.
- Compilado con `npm run build:ts`, `check:ts-drift` limpio (9 archivos).
- **`tests/advancedRiskEngineContract.test.js` (7 tests nuevos):** guards
  aceptan shapes reales y rechazan null/no-objeto/arrays;
  `preTradeRiskCheck` no emite con datos bien formados, sí emite (sin
  lanzar) con un string en vez de objeto; `checkExposureLimits` (trade=null)
  nunca emite el evento de trade.
- `tests/advancedRiskEngine.test.js` (49 tests preexistentes) sigue en
  verde sin cambios.

### 2. `multiHopArbitrageEngine.js` (server/domain/engines/, 237 líneas) — CERRADO

Algoritmo de grafos (Bellman-Ford) que detecta ciclos negativos de
rentabilidad multi-hop — no consume `Opportunity`/`Trade`, produce su
propia forma implícita (`{ hasArbitrage, cycle }` con `cycle` conteniendo
`path/hops/totalLogWeight/compoundedMultiplier/compoundedNetPct`).

- **Nuevo:** `server-types/server/domain/engines/multiHopCycle.ts` —
  interfaces `MultiHopCycle` + `MultiHopDetectionResult` (discriminated
  union `hasArbitrage:true|false`) + guards `isMultiHopCycle()`/
  `isMultiHopDetectionResult()`.
- Compilado → `server/domain/engines/multiHopCycle.js`. `check:ts-drift`
  limpio (10 archivos, subió de 9).
- Wireado como self-check no bloqueante en `detectMultiHopArbitrage()`
  (único productor de esta forma) — emite `obs.emit('RISK',
  'contract.multi_hop_detection_result_shape_invalid', {...})`.
- **`tests/multiHopCycle.test.js` (8 tests nuevos):** guards aceptan la
  forma real producida por `findBestNegativeCycle()`/
  `detectMultiHopArbitrage()`, rechazan null/no-objeto/shapes incompletos o
  con tipos incorrectos (incluyendo el caso sutil `hasArbitrage:false` con
  `cycle` no-null, y `hasArbitrage:true` con `cycle:null`); el wireo nunca
  emite con datos reales (libros balanceados o vacíos).
- `tests/multiHopArbitrageEngine.test.js` (13 tests preexistentes) sigue
  en verde sin cambios.

### 3. `rebalanceEngine.js` (server/domain/engines/, 455 líneas) — CERRADO

El más grande de los 4 motores restantes nombrados por la auditoría.
**No se migró completo a TypeScript** en esta sesión — es un motor con
lógica de ejecución real de transferencias entre exchanges (mueve saldos
reales vía `walletManager.applyRebalanceTransfer`), y una migración
completa del archivo es un cambio de mayor riesgo que merece su propia
sesión dedicada con tests de regresión exhaustivos, no un pase apurado
dentro de esta ronda. En su lugar, se le dio contrato nombrado a los 3
shapes de salida que SÍ tienen consumidores externos reales hoy
(`server/arbitrage/subroutes/config.routes.js`, 3 endpoints HTTP, y
`server/domain/engines/rebalanceScheduler.js`):

- **Nuevo:** `server-types/server/domain/engines/rebalance.ts` —
  `RebalanceImbalance` (union discriminada `usdt_concentration`|
  `btc_shortage`), `BalanceAnalysis` (retorno de `analyzeBalance()`),
  `RebalanceSuggestionResult` (union discriminada `needed:true|false`,
  retorno de `suggestRebalance()`), `ExecuteRebalanceResult` (union
  discriminada `ok:true|false`, retorno de `executeRebalance()`) — los 3
  leídos línea por línea contra el código real antes de definir el tipo.
- Compilado → `server/domain/engines/rebalance.js`. `check:ts-drift`
  limpio (11 archivos, subió de 10).
- Wireado como self-check no bloqueante en los 3 puntos de retorno finales
  de `analyzeBalance()`, `suggestRebalance()` (ambas ramas,
  `needed:true`/`needed:false`) y `executeRebalance()` (solo la rama
  `ok:true`, ya que las ramas `ok:false` son literales triviales
  `{ok:false, reason:string}` que ya cumplen el contrato por construcción).
  Emiten `obs.emit('REBALANCE', 'contract.<nombre>_shape_invalid', {...})`.
- **`tests/rebalanceContract.test.js` (11 tests nuevos):** guards aceptan
  las 3 formas reales (llamando a `analyzeBalance()`/`suggestRebalance()`/
  `executeRebalance()` con datos reales, incluyendo una transferencia
  genuina vía `applyRebalanceTransfer`), rechazan null/no-objeto/shapes
  incompletos; el wireo nunca emite con datos reales.
- `tests/rebalance.test.js` (12), `tests/rebalanceScheduler.test.js` (10),
  `tests/rebalanceEngine.getTopViableSuggestion.test.js` (4),
  `tests/rebalanceCostRatio.test.js` (7), `tests/predictiveRebalance.test.js`
  (16) — los 49 tests preexistentes sobre este motor y sus consumidores
  siguen en verde sin cambios.

**Nota de nomenclatura:** existe ya `tests/rebalance.test.js` (tests de
regresión de bugs previos de wallets/rebalanceo, sin relación con este
cambio) — el archivo de tests nuevo se llamó deliberadamente
`rebalanceContract.test.js` para no crear confusión ni colisión.

### 4. Estado real de "tipos de dominio compartidos" por archivo de motor/riesgo

```
0 usos: adaptivePositionSizing.js, adversarialScenarios.js,
        backtestEngine.js, rebalanceScheduler.js, slippageValidator.js,
        stressTestService.js, tradingValidation.js,
        userRiskProfileService.js
1 uso:  arbitrageValidation.js, scoringService.js, smartOrderRouter.js
2 usos: adaptiveScoring.js, fillProbabilityEngine.js,
        liquidityPredictionEngine.js, mlScoringPipeline.js,
        multiHopArbitrageEngine.js, predictiveRebalance.js,
        spreadMomentumEngine.js
3 usos: arbBacktestEngine.js, institutionalBacktest.js, marketRegime.js,
        marketRegimeEngine.js, statArbEngine.js
4 usos: opportunityDetection.js, simResult.js
5 usos: multiHopCycle.js, rebalanceEngine.js
7 usos: rebalance.js
8 usos: advancedRiskEngine.js
11 usos: riskContext.js
```

**14 de 27** archivos de motor/riesgo consumen al menos un tipo compartido
nombrado (subió de 11 al cierre de `CHECKPOINT_17`). De los 5 motores
nombrados explícitamente por la auditoría, quedan **1 pendiente**:
`backtestEngine.js` (208 líneas — ambiguo con `arbBacktestEngine.js`/
`institutionalBacktest.js`, ver sección 5 abajo, leer los tres antes de
tocar nada).

### 5. Pendiente restante: `backtestEngine.js`

**No se tocó esta sesión** — se cerraron 3 motores (advancedRiskEngine,
multiHopArbitrageEngine, rebalanceEngine) con toda la verificación
completa después de cada uno, y abordar `backtestEngine.js` con el
contexto que quedaba habría significado hacerlo apurado, justo el riesgo
que las sesiones anteriores ya identificaron como el peor error posible
(dar algo por cerrado sin verificarlo bien). Se prioriza checkpoint en
verde total sobre un cuarto motor a medias.

**Advertencia explícita para la próxima sesión** (ya señalada en
`CHECKPOINT_17.md`, se repite aquí porque sigue vigente): `backtestEngine.js`,
`arbBacktestEngine.js` e `institutionalBacktest.js` coexisten sin que sea
obvio cuál usar para qué. Antes de definir un tipo para
`backtestEngine.js`:
1. Leer los 3 archivos completos (no solo `backtestEngine.js`).
2. Verificar si `arbBacktestEngine.js`/`institutionalBacktest.js` ya
   consumen `SimResult` (ambos aparecen con "3 usos" en la tabla de
   arriba — confirmar cuáles guards son exactamente) y si
   `backtestEngine.js` produce/consume algo compatible con `SimResult`
   antes de crear un cuarto tipo redundante.
3. Confirmar quién llama a `backtestEngine.js` en producción (grep real,
   no asumir) para saber qué consumidor real necesita el contrato.

Una vez cerrado ese motor, el pendiente estructural que queda (señalado en
`CHECKPOINT_17.md`, no numerado en la hoja de ruta de 8 puntos) es el
repositorio único de 315 líneas (`server/repositories/index.js`) — su
propio refactor de mayor riesgo, con tests de regresión por entidad.

### 6. Riesgos conocidos

- Ninguna regresión — suite completa, `tsc`, drift, i18n, smoke, lint y
  build de frontend corrieron limpios después de cada uno de los 3 motores
  (verificado 3 veces de forma independiente, no solo al final).
- Los 3 self-checks nuevos son no bloqueantes (solo emiten un evento RISK/
  REBALANCE) — mismo patrón ya aceptado en sesiones previas (Opportunity/
  Trade, OpportunityLogEntry, SimResult, MarketRegimeResult). Un shape
  drift real no rompe producción, solo se hace visible en observabilidad y
  tests.
- `rebalanceEngine.js` sigue siendo JS puro (no migrado a TypeScript) — el
  contrato nuevo (`rebalance.ts`) es un archivo satélite de tipos que
  `rebalanceEngine.js` importa, no una migración completa. Esto es
  intencional (ver sección 3) pero significa que `rebalanceEngine.js` en
  sí mismo no se beneficia de chequeo de tipos en tiempo de compilación
  para su lógica interna, solo sus 3 shapes de salida están ahora
  validados en runtime.
- Persiste el riesgo de empaquetado ya documentado en 3 checkpoints
  distintos — ver sección 0. Cualquier trabajo futuro debe verificarse
  contra el ZIP QUE REALMENTE SE VA A ENTREGAR, no contra el propio
  CHECKPOINT.md ni contra transcripciones de sesiones previas.

### 7. Verificación completa ejecutada esta sesión

Ejecutada **3 veces** (una vez después de cada motor cerrado), reportando
aquí el resultado final acumulado:

```
npm install               → 790 paquetes (node_modules no viene en el zip
                             por diseño — instalado al arrancar esta sesión)
npx vitest run            → 101 archivos, 1647 tests, 0 fallos (~57s)
npx tsc --noEmit          → 0 errores
npm run check:ts-drift    → ✅ sin drift (11 archivos verificados)
npm run check:i18n        → ✅ es.js/en.js en paridad (242 llaves)
npm run test:smoke        → ✅ 76/76 tests
npm run lint              → ✅ 0 errores/warnings
npm run build             → ✅ build de producción exitoso (~10s)
```

### 8. Archivos modificados/creados esta sesión

**Nuevos:**
- `server-types/server/domain/engines/multiHopCycle.ts`
- `server/domain/engines/multiHopCycle.js` (compilado)
- `server-types/server/domain/engines/rebalance.ts`
- `server/domain/engines/rebalance.js` (compilado)
- `tests/advancedRiskEngineContract.test.js`
- `tests/multiHopCycle.test.js`
- `tests/rebalanceContract.test.js`
- `CHECKPOINT_18.md` (este archivo)

**Modificados:**
- `server-types/server/domain/risk/advancedRiskEngine.ts` (guards
  `isTradeLike`/`isOpportunityLike` + wireo en `updateExposure`/
  `preTradeRiskCheck`)
- `server/domain/risk/advancedRiskEngine.js` (recompilado desde el .ts)
- `server/domain/engines/multiHopArbitrageEngine.js` (require de
  `isMultiHopDetectionResult` + observability, self-check en
  `detectMultiHopArbitrage`)
- `server/domain/engines/rebalanceEngine.js` (require de los 3 guards de
  `rebalance.js` + observability, self-check en `analyzeBalance`,
  `suggestRebalance` y `executeRebalance`)

### 9. Estado estimado respecto a la auditoría de comité 2026-07-08

**~88-90/100** (subiendo desde ~84-86/100 al cierre de `CHECKPOINT_17`).
Avance real: 3 de los 4 motores pendientes cerrados en una sola sesión
(con verificación completa e independiente después de cada uno), dejando
solo `backtestEngine.js` de los 5 motores nombrados explícitamente por la
auditoría, más ~8 archivos adicionales sin contrato propio (ninguno
nombrado explícitamente, menor prioridad). El patrón sigue siendo 100%
repetible y ya se aplicó 6 veces en total a través de las sesiones
(Opportunity/Trade, OpportunityLogEntry, SimResult, MarketRegimeResult,
MultiHopCycle, BalanceAnalysis/RebalanceSuggestionResult/
ExecuteRebalanceResult). No se llega a 100/100: falta el motor de backtest
(con su ambigüedad conocida a resolver con cuidado) y el refactor
estructural del repositorio único de 315 líneas, que la propia auditoría
señala como un cambio de mayor riesgo aparte de la hoja de ruta de 8
puntos.

---

## PROMPT PARA EL PRÓXIMO CHAT (copiar/pegar tal cual, adjuntando el zip
`Kukora-CHECKPOINT-18.zip` que acompaña este checkpoint)

```
Adjunto Kukora-CHECKPOINT-18.zip (estado más reciente, verificado) y
CHECKPOINT_18.md (dentro del zip) con el historial completo.

Contexto: venimos cerrando el pendiente #1 de la hoja de ruta de la
auditoría de comité 2026-07-08 (tipos de dominio compartidos entre
motores satélite). De los 5 motores nombrados explícitamente por la
auditoría, 4 ya están cerrados: Opportunity/Trade (previo),
MarketRegimeResult, MultiHopCycle, y BalanceAnalysis/
RebalanceSuggestionResult/ExecuteRebalanceResult (rebalanceEngine.js).
Queda 1: backtestEngine.js.

ADVERTENCIA CRÍTICA (ya ocurrió 3 veces en sesiones anteriores, documentada
en CHECKPOINT_15/16/17/18.md): verificar SIEMPRE contra el código real
dentro del zip que efectivamente vas a entregar, nunca contra un
CHECKPOINT.md ni contra una transcripción de una sesión anterior — el
empaquetado ha fallado repetidamente en preservar trabajo que se creía
cerrado. Antes de escribir cualquier afirmación en el próximo checkpoint,
confírmala con find/grep/conteo de tests contra el zip real. Al arrancar,
ejecuta primero `npm install` (node_modules no viene en el zip) y luego
`npx vitest run` para confirmar el conteo real de archivos/tests antes de
asumir nada.

Patrón ya probado 6 veces — seguirlo exactamente:
  1. Leer la forma REAL que produce el motor (no asumir, no copiar de
     ningún checkpoint anterior).
  2. Definir la interfaz + type guard en
     server-types/server/domain/engines/<nombre>.ts, documentando en el
     header POR QUÉ ese es el contrato mínimo y quién lo consume hoy
     (grep real de los call-sites).
  3. Compilar con `npm run build:ts`, verificar `npm run check:ts-drift`.
  4. Wirear el guard como chequeo NO BLOQUEANTE (obs.emit('RISK'|'...',
     'contract.<nombre>_shape_invalid', {...}) — nunca throw) en el punto
     correcto: en el productor si solo hay uno, o en el consumidor
     compartido si hay más de un productor.
  5. Tests dedicados en tests/<nombre>Contract.test.js (revisar primero si
     ya existe un tests/<nombre>.test.js con otro propósito, como pasó con
     rebalance.test.js — usar un nombre que no colisione): el guard acepta
     el shape real (llamando a la función real con datos reales), rechaza
     null/undefined/shapes rotos, y el wireo emite (o no emite) RISK
     correctamente.
  6. Verificación completa: npx vitest run (suite completa), npx tsc
     --noEmit, npm run check:ts-drift, npm run check:i18n, npm run
     test:smoke, npm run lint, npm run build. Todo debe quedar en verde
     antes de seguir.

PASO 0 OBLIGATORIO antes de tocar backtestEngine.js — la auditoría señala
que backtestEngine.js, arbBacktestEngine.js e institutionalBacktest.js
coexisten sin que sea obvio cuál usar para qué:
  1. Leer los 3 archivos completos.
  2. arbBacktestEngine.js e institutionalBacktest.js ya aparecen con "3
     usos" en la tabla de tipos compartidos (probablemente consumen
     SimResult/isSimResult — confirmar con grep exacto, no asumir).
  3. Verificar si backtestEngine.js produce/consume algo compatible con
     SimResult antes de crear un tipo redundante — si es compatible,
     quizás el fix correcto es que backtestEngine.js empiece a usar
     isSimResult() en vez de necesitar su propio tipo nuevo.
  4. Confirmar con grep real quién llama a backtestEngine.js en
     producción (no asumir que nadie lo usa solo porque tiene "0 usos" en
     la tabla de tipos).

Una vez cerrado backtestEngine.js (los 5 motores nombrados por la
auditoría estarán completos), actualizar la tabla de "usos por archivo"
en el checkpoint, escribir CHECKPOINT_19.md con el mismo formato que
CHECKPOINT_17/18, empaquetar el zip completo (excluyendo
node_modules/dist/.env) y entregarlo.

El pendiente estructural que queda después de eso (no numerado en la hoja
de ruta de 8 puntos, señalado en la sección de Arquitectura del documento
de auditoría) es el repositorio único de 315 líneas
(server/repositories/index.js) — su propio refactor de mayor riesgo, con
tests de regresión por entidad, no un pase mecánico. Evaluar si abordarlo
es la mejor forma de acercarse a 100/100, o si hay otros hallazgos de la
auditoría (calidad, seguridad, documentación) con mejor relación
impacto/riesgo — releer el documento de auditoría completo (si está
disponible en esa sesión) antes de decidir qué atacar después de
backtestEngine.js.

Si el contexto se acerca al límite antes de terminar, detener el trabajo
en un punto seguro (todo verificado en verde, sin cambios a medio hacer) y
empaquetar igual — nunca dejar la sesión sin un zip actualizado.
```

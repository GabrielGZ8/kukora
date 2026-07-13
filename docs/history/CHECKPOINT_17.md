## CHECKPOINT_17 — Sesión 2026-07-09 (continuación): `MarketRegimeResult`
como segundo motor satélite con tipo de dominio propio

**Fecha/hora:** 2026-07-09, ~05:11–05:18 UTC (continuación directa de
CHECKPOINT_16, misma sesión de usuario, chat nuevo).

**Objetivo de este checkpoint:** continuar el pendiente #1 de la hoja de
ruta de la auditoría ("extender tipos de dominio compartidos a los
motores satélite restantes") avanzando un motor más, verificar todo, y
dejar un checkpoint + prompt de continuación explícito antes de agotar
contexto — instrucción directa del usuario.

### 1. Verificación de punto de partida

Se re-verificó contra el código real (no contra `CHECKPOINT_16.md`) que:
- `simResult.ts`/`.js` y `tests/simResult.test.js` sí estaban presentes
  (a diferencia del episodio de `CHECKPOINT_15`, esta vez el zip se
  empaquetó completo — confirmado por conteo de tests: 97/1616 al
  arrancar esta sesión, coincide con lo documentado).
- `/executive` como landing canónica, nav, i18n y README — todo presente
  y consistente con lo documentado en `CHECKPOINT_16.md`.

No se repitió el bug de empaquetado de sesiones anteriores.

### 2. `MarketRegimeResult` — nuevo tipo de dominio nombrado

Tercer motor en recibir un contrato explícito (después de
`OpportunityLogEntry` y `SimResult`), y el primero de los 5 motores
nombrados explícitamente por la auditoría (`marketRegimeEngine.js`,
`multiHopArbitrageEngine.js`, `rebalanceEngine.js`, `backtestEngine.js`,
`advancedRiskEngine.js`) en cerrarse:

- **`server-types/server/domain/engines/marketRegime.ts`**: interfaz
  `MarketRegimeResult` (+ `MarketRegimeSignal`/`MarketRegimeMetrics`
  auxiliares) + type guard `isMarketRegimeResult()`. A diferencia de
  `Opportunity`/`Trade`, este motor opera sobre series de precio crudas,
  no sobre oportunidades — no tenía sentido forzarle esos tipos; en vez
  de eso se le dio su PROPIO tipo nombrado para la forma que ya producía
  de forma implícita.
- Compilado con `npm run build:ts` → `server/domain/engines/
  marketRegime.js`. `check:ts-drift` limpio, **9 archivos verificados**
  (subió de 8).
- **Wireado como self-check en el propio productor**
  (`marketRegimeEngine.detectMarketRegime()`, no en cada consumidor —
  patrón distinto al de `SimResult`, que tenía dos productores; aquí solo
  hay uno real, así que el chequeo vive donde se construye el objeto, no
  en `crypto.routes.js`/`datasetService.js`). Emite `obs.emit('RISK',
  'contract.market_regime_result_shape_invalid', { regimeId })` sin
  lanzar ni alterar el resultado — mismo patrón no-bloqueante que los dos
  tipos anteriores.
- **`tests/marketRegime.test.js` (5 tests, todos pasan):**
  `isMarketRegimeResult()` acepta el shape real de `detectMarketRegime()`
  tanto en la rama normal como en la rama de datos insuficientes (<15
  precios); rechaza `null`/`undefined`/no-objeto y shapes con campos
  faltantes o de tipo incorrecto; `detectMarketRegime()` no emite RISK con
  un shape correcto (se corrió con datos reales, no mockeados).
- `tests/marketRegimeEngine.test.js` (los 10 tests preexistentes, sin
  tocar) sigue en verde — el contrato nuevo no cambió ninguna forma de
  retorno, solo la valida.

Suite completa tras este cambio: **98 archivos / 1621 tests, 0 fallos.**

### 3. Estado real de "tipos de dominio compartidos" por archivo de motor/riesgo

Repetición del mismo grep de `CHECKPOINT_16.md`, actualizado:

```
0 usos: adaptivePositionSizing.js, advancedRiskEngine.js,
        adversarialScenarios.js, backtestEngine.js,
        multiHopArbitrageEngine.js, rebalanceEngine.js,
        rebalanceScheduler.js, slippageValidator.js,
        stressTestService.js, tradingValidation.js,
        userRiskProfileService.js
1 uso:  arbitrageValidation.js, scoringService.js, smartOrderRouter.js
2 usos: adaptiveScoring.js, fillProbabilityEngine.js,
        liquidityPredictionEngine.js, mlScoringPipeline.js,
        predictiveRebalance.js, spreadMomentumEngine.js
3 usos: arbBacktestEngine.js, institutionalBacktest.js, statArbEngine.js
4 usos: opportunityDetection.js, simResult.js
5 usos: marketRegimeEngine.js  ← nuevo esta sesión
11 usos: riskContext.js
```

**11 de 26** archivos de motor/riesgo consumen al menos un tipo
compartido nombrado (subió de 11 con un archivo distinto — antes
`marketRegimeEngine.js` estaba en "0 usos"). 11 archivos siguen en "0
usos" sin ningún contrato propio todavía. De los 5 motores nombrados
explícitamente por la auditoría, quedan 4 pendientes:
`multiHopArbitrageEngine.js` (237 líneas), `rebalanceEngine.js` (455
líneas), `backtestEngine.js` (208 líneas — cuidado, ambiguo con
`arbBacktestEngine.js`/`institutionalBacktest.js`, ver sección 2 del
documento de auditoría) y `advancedRiskEngine.js` (554 líneas, el más
grande y el que más impacto tendría en "Calidad del dominio" 58/100 según
el propio documento).

### 4. Riesgos conocidos

- Ninguna regresión — suite completa, `tsc`, drift, i18n, smoke, lint y
  build de frontend corrieron limpios después del cambio (ver
  verificación abajo).
- El self-check en `detectMarketRegime()` es no-bloqueante (solo emite un
  evento RISK) — igual que `SimResult`/`OpportunityLogEntry`, un shape
  drift real no rompe producción, solo se hace visible en observabilidad
  y tests. Esto es intencional (mismo patrón ya aceptado en sesiones
  previas), no un descuido.
- No se tocó ningún consumidor (`crypto.routes.js`, `datasetService.js`)
  — el contrato se wireó en el productor, así que no hay riesgo de romper
  ninguna ruta HTTP existente.

### 5. Verificación completa ejecutada esta sesión

```
npx vitest run          → 98 archivos, 1621 tests, 0 fallos (~70s)
npx tsc --noEmit         → 0 errores
npm run check:ts-drift   → ✅ sin drift (9 archivos verificados)
npm run check:i18n       → ✅ es.js/en.js en paridad (242 llaves)
npm run test:smoke       → ✅ 76/76 tests
npm run lint             → ✅ 0 errores/warnings
npm run build            → ✅ build de producción exitoso (~13s)
```

### 6. Archivos modificados/creados esta sesión

**Nuevos:**
- `server-types/server/domain/engines/marketRegime.ts`
- `server/domain/engines/marketRegime.js` (compilado)
- `tests/marketRegime.test.js`
- `CHECKPOINT_17.md` (este archivo)

**Modificados:**
- `server/domain/engines/marketRegimeEngine.js` (require de
  `isMarketRegimeResult` + `observabilityService`, self-check antes de
  cada `return` de `detectMarketRegime()`)

### 7. Estado estimado respecto a la auditoría de comité 2026-07-08

**~84-86/100** (subiendo desde ~82-85/100 al cierre de CHECKPOINT_16).
Avance real pero incremental — un motor más con contrato propio, de los 4
que quedan explícitamente nombrados por la auditoría. El patrón está
probado y repetible (4 motores ya lo usan: opportunity/trade,
OpportunityLogEntry, SimResult, MarketRegimeResult), pero cada motor
restante requiere la misma secuencia completa (leer forma real → definir
tipo → guard → wireo → tests → verificación completa) y no se puede
paralelizar de forma segura dentro de una sola sesión sin arriesgar
calidad. No se llega a 100 — quedan 4 motores nombrados explícitamente
más ~7 archivos adicionales sin contrato (ver sección 3), y el
repositorio único de 315 líneas sigue sin tocar.

---

## PROMPT PARA EL PRÓXIMO CHAT (copiar/pegar tal cual, adjuntando el zip
`Kukora-CHECKPOINT-17.zip` que acompaña este checkpoint)

```
Adjunto Kukora-CHECKPOINT-17.zip (estado más reciente, verificado) y
CHECKPOINT_17.md (dentro del zip) con el historial completo.

Contexto: venimos cerrando el pendiente #1 de la hoja de ruta de la
auditoría de comité 2026-07-08 (tipos de dominio compartidos entre
motores satélite), un motor por sesión, con el patrón ya probado 4 veces
(Opportunity/Trade, OpportunityLogEntry, SimResult, MarketRegimeResult):
  1. Leer la forma REAL que produce el motor (no asumir).
  2. Definir la interfaz + type guard en
     server-types/server/domain/engines/<nombre>.ts (o server/domain/risk/
     si aplica), documentando en el header POR QUÉ ese es el contrato
     mínimo y quién lo consume hoy.
  3. Compilar con `npm run build:ts`, verificar `npm run check:ts-drift`.
  4. Wirear el guard como chequeo NO BLOQUEANTE (obs.emit('RISK',
     'contract.<nombre>_shape_invalid', {...}) — nunca throw) en el punto
     correcto: en el productor si solo hay uno (patrón MarketRegimeResult/
     OpportunityLogEntry), o en el consumidor compartido si hay más de un
     productor (patrón SimResult).
  5. Tests dedicados en tests/<nombre>.test.js: el guard acepta el shape
     real (llamando a la función real con datos reales, no mocks), rechaza
     null/undefined/shapes rotos, y el wireo emite (o no emite) RISK
     correctamente.
  6. Verificación completa: npx vitest run (suite completa), npx tsc
     --noEmit, npm run check:ts-drift, npm run check:i18n, npm run
     test:smoke, npm run lint, npm run build. Todo debe quedar en verde
     antes de seguir.

IMPORTANTE — verificar SIEMPRE contra el código real, no contra el propio
CHECKPOINT_XX.md, antes de asumir que algo está hecho. En dos sesiones
anteriores (documentadas en CHECKPOINT_15.md y CHECKPOINT_16.md) trabajo
que el propio checkpoint decía "cerrado" no había llegado al zip
empaquetado. Antes de escribir cualquier afirmación en el próximo
checkpoint, confírmala con find/grep/conteo de tests contra el zip real
que se va a entregar.

De los 5 motores que la auditoría nombra explícitamente como "sin
contrato común" (sección 2 del documento), 4 siguen pendientes — empezar
por el de mayor impacto:

1. advancedRiskEngine.js (server/domain/risk/, 554 líneas) — el motor de
   riesgo real (circuit breaker, drawdown tracking, exposición). Ya existe
   server/domain/risk/riskContext.js con 11 usos en otros archivos —
   verificar primero si RiskContext le aplica directamente a
   advancedRiskEngine.js o si necesita su propio tipo (probablemente lo
   segundo, dado que RiskContext parece ser un tipo de INPUT/contexto y
   advancedRiskEngine probablemente produce un tipo de OUTPUT distinto —
   leer el archivo primero, no asumir). Es el que más impacto tendría en
   la nota de "Calidad del dominio" (58/100 en el documento).
2. multiHopArbitrageEngine.js (server/domain/engines/, 237 líneas).
3. rebalanceEngine.js (server/domain/engines/, 455 líneas).
4. backtestEngine.js (server/domain/engines/, 208 líneas) — CUIDADO: el
   documento de auditoría señala que backtestEngine.js,
   arbBacktestEngine.js e institutionalBacktest.js coexisten sin que sea
   obvio cuál usar para qué — leer los tres antes de tocar backtestEngine.js
   para no crear un cuarto tipo redundante con SimResult si backtestEngine
   ya produce/consume algo compatible.

Hacer 1 motor (idealmente 2 si el contexto alcanza), verificar todo,
actualizar la tabla de "usos por archivo" en el checkpoint (grep -c
"isOpportunity\|isTrade\|isOpportunityLogEntry\|isSimResult\|
isMarketRegimeResult\|RiskContext" sobre cada archivo de
server/domain/engines/*.js y server/domain/risk/*.js), escribir
CHECKPOINT_18.md con el mismo formato que CHECKPOINT_16/17, empaquetar el
zip completo (excluyendo node_modules/dist/.env) y entregarlo. Si el
contexto se acerca al límite antes de terminar el motor en curso, detener
el trabajo en un punto seguro (todo verificado en verde, sin cambios a
medio hacer) y empaquetar igual — nunca dejar la sesión sin un zip
actualizado.

Una vez cerrados los 5 motores nombrados, el pendiente estructural que
queda (no numerado en la hoja de ruta de 8 puntos, pero señalado en la
sección de Arquitectura) es el repositorio único de 315 líneas
(server/repositories/index.js) — su propio refactor de mayor riesgo, con
tests de regresión por entidad, no un pase mecánico.
```

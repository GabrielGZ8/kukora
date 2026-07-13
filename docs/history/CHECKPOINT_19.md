# CHECKPOINT 19 — Kukora

## 0. Advertencia de empaquetado (leer primero)

Al recibir el zip de CHECKPOINT_18 para esta sesión, se confirmó el MISMO
bug de empaquetado documentado en CHECKPOINT_15/16/17/18: la transcripción
de la sesión anterior (adjunta como
`Kukora-Auditoria-Comite-2026-07-08.md`) mostraba `backtestEngine.js` ya
cerrado (tipo `BacktestStrategyResult`/`BacktestRunResult`, guards
wireados, 9 tests dedicados, suite completa en 102 archivos/1656 tests) —
pero el ZIP real (`Kukora-CHECKPOINT-18.zip`) seguía en el estado exacto
de CHECKPOINT_18: **101 archivos / 1647 tests**, sin `backtestResult.ts`
en `server-types/`, sin ningún wireo en `backtestEngine.js`. Se verificó
con `find`/`grep`/`git status` antes de escribir cualquier afirmación
(este checkpoint sigue esa misma disciplina). Se rehizo el trabajo desde
cero contra el código real del zip, no contra la transcripción.

**Recomendación para el próximo checkpoint**: seguir verificando siempre
contra el zip real antes de asumir que un `CHECKPOINT_XX.md` o una
transcripción de sesión reflejan lo que efectivamente se empaquetó.

## 1. Resumen de esta sesión

Se cerró el motor #5 (y último) de los 5 nombrados explícitamente por la
auditoría de comité 2026-07-08 en su hoja de ruta #1 ("tipos de dominio
únicos importados desde los 10+ motores"): **`backtestEngine.js`**.

Paso 0 obligatorio (desambiguación) ejecutado primero: se leyeron los 3
archivos `*backtest*` completos y se confirmó por grep real que
`backtestEngine.js` NO comparte ningún campo con `SimResult`
(`arbBacktestEngine.js`/`institutionalBacktest.js` sí lo usan, 3 usos cada
uno) — es un dominio genuinamente distinto (curvas de equity de
estrategias técnicas SMA/RSI/Bollinger vs. ejecuciones de arbitraje), así
que se definió un tipo propio (`BacktestStrategyResult`/
`BacktestRunResult`) en vez de forzar `SimResult`.

Trabajo cerrado, siguiendo el mismo patrón usado 7 veces:
- `server-types/server/domain/engines/backtestResult.ts` — interfaces
  `BacktestStrategyResult`/`BacktestRunResult` + guards
  `isBacktestStrategyResult`/`isBacktestRunResult`, documentando por qué
  es un contrato distinto de `SimResult`.
- Compilado (`npm run build:ts`), verificado sin drift.
- Wireado como chequeo NO bloqueante (`observability.emit('ENGINE',
  'contract.backtest_run_result_shape_invalid', ...)`) en `runBacktest()`
  y `runAllStrategies()` — único productor, ambos consumidores
  (`datasetService.js`, `crypto.routes.js`) confirmados por grep real.
- 9 tests dedicados en `tests/backtestResultContract.test.js`: el guard
  acepta el shape real producido por `runBacktest()`/`runAllStrategies()`,
  rechaza null/undefined/shapes con tipos incorrectos, y valida el shape
  combinado `{strategy, benchmark}`.
- Verificación completa (suite entera, tsc, drift, i18n, smoke, lint,
  build) — todo en verde, ver sección 6.

### Estado final de la hoja de ruta #1 (los 5 motores nombrados)

| Motor | Tipo compartido | Estado |
|---|---|---|
| `marketRegimeEngine.js` | `MarketRegimeResult` | ✅ Cerrado (sesión previa) |
| `multiHopArbitrageEngine.js` | `MultiHopCycle`/`MultiHopDetectionResult` | ✅ Cerrado (CHECKPOINT_18) |
| `rebalanceEngine.js` | `BalanceAnalysis`/`RebalanceSuggestionResult`/`ExecuteRebalanceResult` | ✅ Cerrado (CHECKPOINT_18) |
| `advancedRiskEngine.js` | `isTradeLike`/`isOpportunityLike` (guards) | ✅ Cerrado (CHECKPOINT_18) |
| `backtestEngine.js` | `BacktestStrategyResult`/`BacktestRunResult` | ✅ **Cerrado esta sesión** |

**Los 5 de 5 motores nombrados explícitamente por la auditoría están
cerrados y verificados contra el código real.**

## 2. Auditoría de los 7 archivos restantes con "0 usos" (no nombrados
por la auditoría) — decisión de NO aplicar el patrón mecánicamente

Se revisaron los 7 archivos que seguían en "0 usos" de tipos compartidos
(`adaptivePositionSizing.js`, `adversarialScenarios.js`,
`rebalanceScheduler.js`, `slippageValidator.js`, `stressTestService.js`,
`tradingValidation.js`, `userRiskProfileService.js`) para decidir si
cerrarlos también tenía sentido:

- `tradingValidation.js`: son schemas **Zod** de validación de entrada
  HTTP (`ModeBodySchema`, `ExecuteCrossBodySchema`, etc.), no un motor que
  produce un shape de dominio propio — el patrón de "tipo compartido entre
  productores" no aplica genuinamente aquí.
- `adaptivePositionSizing.js`, `adversarialScenarios.js`,
  `rebalanceScheduler.js`, `stressTestService.js`: son servicios con
  **estado mutable singleton** (escenarios activos, multiplicadores de
  fee, scheduler on/off) — un único productor interno, sin el problema de
  "dos productores independientes construyendo el mismo shape implícito
  sin contrato" que motivó `SimResult`/`OpportunityLogEntry`/etc.
- `slippageValidator.js`, `userRiskProfileService.js`: cada uno es el
  **único productor** de su propio shape (estadísticas de calibración,
  perfil de riesgo por usuario) — consumido en varios lugares, pero sin
  un segundo productor independiente que pueda divergir en silencio.

**Conclusión**: forzar guards de tipo en estos 7 archivos sería trabajo
mecánico sin cerrar un riesgo real (no hay drift posible entre
"productores" porque solo hay uno cada vez), y contradiría el espíritu del
propio hallazgo de la auditoría. Se documenta esta decisión explícitamente
en vez de inflar el conteo de "motores con contrato" de forma cosmética.

### Tabla de usos por archivo (actualizada, grep real)

```
11 usos: riskContext.js
 8 usos: advancedRiskEngine.js
 7 usos: rebalance.js
 5 usos: rebalanceEngine.js, multiHopCycle.js, backtestResult.js
 4 usos: simResult.js, opportunityDetection.js
 3 usos: statArbEngine.js, marketRegimeEngine.js, marketRegime.js,
         institutionalBacktest.js, backtestEngine.js, arbBacktestEngine.js
 2 usos: spreadMomentumEngine.js, predictiveRebalance.js,
         multiHopArbitrageEngine.js, mlScoringPipeline.js,
         liquidityPredictionEngine.js, fillProbabilityEngine.js,
         adaptiveScoring.js
 1 uso:  arbitrageValidation.js, smartOrderRouter.js, scoringService.js
 0 usos: userRiskProfileService.js, tradingValidation.js,
         stressTestService.js, slippageValidator.js,
         adversarialScenarios.js, adaptivePositionSizing.js,
         rebalanceScheduler.js (ver sección 2 — decisión de no aplicar el
         patrón, no un pendiente)
```

## 3. Estado real de la hoja de ruta de la auditoría de comité (8 puntos,
sección 12 del documento)

| # | Hallazgo | Estado |
|---|---|---|
| 1 | `Opportunity`/`Trade`/`RiskContext` como tipos únicos, importados desde los 10+ motores | ✅ **Cerrado esta sesión** — los 5 motores nombrados explícitamente ya consumen un tipo compartido; los 7 archivos satélite restantes no tienen el problema de fondo (sección 2) |
| 2 | README con diagrama desactualizado | ✅ Ya resuelto |
| 3 | `domain/` en subcarpetas por responsabilidad | ✅ Ya resuelto |
| 4 | Auditoría de `getHandler()` en `*.routes.test.js` | ✅ Ya resuelto |
| 5 | Code-splitting de `ArbitragePage` (19 paneles) | ✅ Ya resuelto |
| 6 | `ExecutiveDashboard` como landing canónica | ✅ Ya resuelto |
| 7 | Persistencia de snapshot completo de wallet | ✅ Ya resuelto |
| 8 | Jerarquía `DomainError` unificada | ✅ Ya resuelto |

**8 de 8 puntos de la hoja de ruta priorizada están cerrados.**

## 4. Pendiente estructural restante (no numerado, sección de Arquitectura)

**Repositorio único de 315 líneas** (`server/repositories/index.js`) para
15+ entidades. Sigue sin tocarse esta sesión — la propia auditoría lo
señala como un refactor de **mayor riesgo** que amerita tests de
regresión por entidad y su propia sesión dedicada, no un cambio
incremental junto con lo demás. Con los 8 puntos numerados ya cerrados,
este es el hallazgo de mayor impacto restante y candidato natural para la
próxima sesión — pero dado el deadline del 12 de julio, evaluar primero
si el riesgo de tocar la capa de persistencia 3 días antes de la
evaluación es aceptable, o si es mejor dejarlo documentado como deuda
conocida y usar el tiempo restante en estabilidad/demo readiness.

## 5. Riesgos conocidos

- Ninguna regresión detectada — suite completa, `tsc`, drift, i18n,
  smoke, eslint y build de frontend corrieron limpios (sección 6).
- No se encontró ningún `.env` incluido accidentalmente en este zip (el
  bug recurrente de checkpoints anteriores no se repitió esta vez) —
  confirmado con `find` antes de empaquetar.
- Persiste el riesgo de empaquetado (sección 0) — cualquier sesión futura
  debe re-verificar contra el zip real, no contra este documento ni
  contra transcripciones.

## 6. Verificación completa ejecutada esta sesión

```
npm install               → instalado limpio contra el zip real
npx vitest run            → 102 archivos, 1656 tests, 0 fallos (~67s)
npx tsc --noEmit          → 0 errores
npm run check:ts-drift    → ✅ sin drift (12 archivos verificados)
npm run check:i18n        → ✅ es.js/en.js en paridad (242 llaves)
npm run test:smoke        → ✅ 76/76 tests
npm run lint              → ✅ 0 errores/warnings
npm run build             → ✅ build de producción exitoso (~12s)
```

## 7. Archivos modificados/creados esta sesión

**Nuevos:**
- `server-types/server/domain/engines/backtestResult.ts`
- `server/domain/engines/backtestResult.js` (compilado)
- `tests/backtestResultContract.test.js`
- `CHECKPOINT_19.md` (este archivo)

**Modificados:**
- `server/domain/engines/backtestEngine.js` (require de
  `isBacktestRunResult` + `observabilityService`, chequeo de contrato no
  bloqueante en `runBacktest()` y `runAllStrategies()`)

## 8. Estado estimado respecto a la auditoría de comité 2026-07-08

**~92-94/100** (subiendo desde ~88-90/100 al cierre de CHECKPOINT_18). Los
8 puntos numerados de la hoja de ruta priorizada están cerrados y
verificados contra el código real. El único hallazgo estructural que
queda es el repositorio único de 315 líneas (sección 4), señalado por la
propia auditoría como un cambio de mayor riesgo aparte de la hoja de ruta
de 8 puntos — no se llega a 100/100 exacto porque ese ítem sigue sin
resolverse, y porque una nota de comité final depende de una relectura
completa del documento original que no ha vuelto a ocurrir desde
CHECKPOINT_16.

## 9. Pendientes sugeridos para la próxima sesión (orden de prioridad)

1. **Decidir sobre el repositorio único** (sección 4): evaluar el
   riesgo/beneficio de refactorizarlo a 3 días del deadline vs. dejarlo
   documentado como deuda conocida y enfocar el tiempo restante en
   estabilidad de demo, pulido de UI, o cierre de items menores
   (M-3 SSE delta encoding, M-8 a M-11 frontend, i18n de las ~27 páginas
   restantes, según lo señalado en el contexto previo de Kukora).
2. Si hay tiempo después de (1): recuperar acceso a Firebase
   (`kukora.inc@gmail.com` sigue perdido desde el 5 de julio — crear
   proyecto nuevo si no se recupera antes del deadline).
3. Reescaneo final del documento de auditoría completo (si está
   disponible) para confirmar la nota real, ya que la estimación de esta
   sección se basa en el historial de checkpoints, no en una relectura
   directa del documento en esta sesión.

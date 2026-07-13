## CHECKPOINT_12 — Sesión 2026-07-08 (continuación): punto 1 de la hoja
de ruta — los 5 motores de mayor riesgo real de drift silencioso, migrados
y verificados

Esta sesión parte del zip `Kukora-CHECKPOINT-11.zip` y de la recomendación
explícita que cierra `CHECKPOINT_11.md`: de los ~13 motores satélite de
`domain/engines/` que aún no importaban ni validaban contra los tipos
compartidos (`Opportunity`/`Trade`/`RiskContext`), tomar primero los 5 que
ya construyen o mutan objetos con forma de `Opportunity` — el subconjunto
de mayor riesgo real de drift silencioso porque leen/mutan el mismo objeto
que `opportunityDetection.js` produce.

Línea base verificada antes de tocar nada: `npm ci` + `npx vitest run` →
**95 archivos, 1579 tests, 0 fallos, 56.9s** (idéntico a lo reportado al
cierre de `CHECKPOINT_11.md`).

### Alcance real de esta sesión

Se tomaron los 5 motores en el orden sugerido. Al inspeccionar cada uno
antes de tocarlo (no se asumió la categorización previa), 4 de los 5
efectivamente construyen/consumen objetos con forma de `Opportunity` o
`Trade` y se migraron con el patrón ya establecido; el quinto
(`statArbEngine.js`) resultó ser un caso genuinamente distinto y se
documentó esa desviación en vez de forzar el patrón — ver sección 5.

1. **`fillProbabilityEngine.js`** — `enrichWithFillProbability(opportunities, ...)`
   es el punto de entrada real (recibe el array de `Opportunity` que sale
   de `opportunityDetection.js` vía `arbitrageOrchestrator.js`). Se agregó
   `isOpportunity()` por elemento, antes de enriquecer, con
   `obs.emit('RISK', 'contract.opportunity_shape_invalid', {...})` no
   bloqueante — mismo patrón exacto que `opportunityDetection.js`.
   Deliberadamente **no** se tocó `computeFillProbability()` (la función
   pura de más bajo nivel): sus tests existentes la ejercitan con fixtures
   parciales a propósito (para aislar el cálculo del scoring del contrato
   de forma), igual que la lección del adaptador `RiskContext` en
   `CHECKPOINT_11.md` — el chequeo va en la frontera del pipeline, no en
   cada helper interno.
2. **`liquidityPredictionEngine.js`** — mismo patrón en
   `enrichWithLiquidityPrediction(opportunities, ...)`.
3. **`spreadMomentumEngine.js`** — mismo patrón en `enrichOpportunity(opp)`
   (la función singular; `enrichOpportunities()` la llama vía `.map()` así
   que hereda el chequeo gratis).
4. **`predictiveRebalance.js`** — `recordTrade(trade)` es el punto de
   entrada real (recibe `applyResult.trade`, el `Trade` canónico
   construido por `executeSimulated()`, vía
   `arbitrageOrchestrator.js:225`). Se agregó `isTrade()` con
   `obs.emit('RISK', 'contract.trade_shape_invalid', {...})` no
   bloqueante.
5. **`statArbEngine.js` — NO migrado, decisión documentada (desviación del
   plan sugerido).** Al leer `detectStatArb()` antes de tocarlo: no recibe
   ni enriquece un `Opportunity` en ningún punto — construye sus propios
   objetos `signal` (`type: 'stat_arb'`, `logSpread`, `zScore`,
   `ewmaMean`, `halfLife`, `bollinger`, `direction`, `confidence`, ...)
   directamente desde `orderBooks`, con un vocabulario de campos propio de
   estadística de cointegración/mean-reversion, no de fees/slippage/scoring.
   Comparte los nombres `buyExchange`/`sellExchange`/`viable` con
   `Opportunity` por coincidencia de vocabulario, no por forma —
   `isOpportunity()` rechazaría absolutamente todas las señales que este
   motor produce (no tiene `netProfit` ni `spreadPct`), así que agregar el
   chequeo ahí solo generaría ruido de falsos positivos permanente, no
   detectaría drift real. La categorización de `CHECKPOINT_11.md`
   (identificada vía heurística `grep buyExchange`) no se sostuvo al leer
   el código real — se documentó esto como comentario en el propio archivo
   (`server/domain/engines/statArbEngine.js`, justo antes de
   `detectStatArb()`) para que una sesión futura no repita la misma
   heurística y llegue a la misma conclusión equivocada. Recomendación
   dejada ahí: si se quiere un contrato compartido para señales stat-arb,
   debería ser un tipo nuevo (`StatArbSignal`, mismo patrón de creación que
   `RiskContext`), no forzar `Opportunity`.

### Tests de contrato agregados (contra el productor real, no contra fixtures)

Mismo patrón que `tests/opportunity.test.js` de la sesión anterior: cada
test construye order books reales, corre `detectOpportunities()` /
`executeSimulated()` de verdad, y verifica que el objeto real que producen
pasa por el motor migrado sin disparar `contract.*_shape_invalid` (con
`vi.spyOn(observability, 'emit')`), además de confirmar que el campo de
enriquecimiento efectivamente aparece:

- `tests/fillProbabilityEngine.test.js` — 1 test nuevo (16 total).
- `tests/liquidityPredictionEngine.test.js` — 1 test nuevo (18 total).
- `tests/spreadMomentumEngine.test.js` — 1 test nuevo (17 total).
- `tests/predictiveRebalance.test.js` — 1 test nuevo (16 total).

`tests/statArbEngine.test.js` — sin cambios (no se migró el motor, no
aplica un test de contrato).

### Verificación completa (todo corrido de verdad, no asumido)

- `npx vitest run` → **95 archivos, 1583 tests, 0 fallos** (1579 base + 4
  nuevos), 61.9s.
- `npx tsc --noEmit` → limpio.
- `npm run check:ts-drift` → sin drift, 7 archivos verificados (sin
  cambios — esta sesión no tocó ningún build artifact de TypeScript, solo
  `.js` planos en `domain/engines/` y sus tests).
- `npm run check:i18n` → paridad, 240 llaves (sin cambios — esta sesión no
  tocó strings de UI).
- `npm run test:smoke` → 76/76.
- `npx eslint server/ src/ --ext .js,.jsx` → 0 errores, 0 warnings.
- `npm run build` → limpio; `ArbitragePage` chunk sin cambios (77.94 kB /
  20.21 kB gzip) — esta sesión no tocó frontend.

### Archivos nuevos o modificados esta sesión

- `server/domain/engines/fillProbabilityEngine.js` — import de
  `isOpportunity`/`obs`, chequeo de contrato en `enrichWithFillProbability`.
- `server/domain/engines/liquidityPredictionEngine.js` — mismo patrón en
  `enrichWithLiquidityPrediction`.
- `server/domain/engines/spreadMomentumEngine.js` — mismo patrón en
  `enrichOpportunity`.
- `server/domain/engines/predictiveRebalance.js` — import de `isTrade`,
  chequeo de contrato en `recordTrade`.
- `server/domain/engines/statArbEngine.js` — comentario de decisión
  documentando por qué **no** se migra (sin cambio funcional).
- `tests/fillProbabilityEngine.test.js`, `tests/liquidityPredictionEngine.test.js`,
  `tests/spreadMomentumEngine.test.js`, `tests/predictiveRebalance.test.js`
  — test de contrato nuevo contra el productor real en cada uno.

No se tocó `CHANGELOG.md` ni `MIGRATION_CLEANUP_LOG.md` — mismo criterio
que `CHECKPOINT_11.md`: el tracking de esta hoja de ruta vive en los
`CHECKPOINT_NN.md`, esos otros dos archivos pertenecen a un esfuerzo de
limpieza anterior (H-10, migración de páginas i18n) ya cerrado.

### Lo que queda pendiente del punto 1 (no alcanzado esta sesión)

De los ~17 motores de `domain/engines/`, tras esta sesión:

- **Migrados y con test de contrato:** `opportunityDetection.js` (sesión
  anterior), `fillProbabilityEngine.js`, `liquidityPredictionEngine.js`,
  `spreadMomentumEngine.js`, `predictiveRebalance.js` (esta sesión) — 5 de
  17.
- **Evaluado y decidido explícitamente no migrar** (documentado en el
  propio archivo): `statArbEngine.js`.
- **Sin tocar, mismo alcance que `CHECKPOINT_11.md` dejó pendiente:**
  `scoringService.js`, `adaptiveScoring.js`, `mlScoringPipeline.js`,
  `smartOrderRouter.js` (reciben `Opportunity[]`/objetos con forma de
  `Trade` sin tipo), y la ambigüedad `backtestEngine.js` vs
  `arbBacktestEngine.js` vs `institutionalBacktest.js` que señala la
  auditoría (sección 12) sigue sin resolver — no investigada esta sesión,
  no se puede afirmar todavía cuál es la relación real entre los tres.
- **Sin tocar, no manejan `Opportunity`/`Trade` directamente** (mismo
  razonamiento de `CHECKPOINT_11.md`): `multiHopArbitrageEngine.js`,
  `rebalanceEngine.js`, `rebalanceScheduler.js`, `marketRegimeEngine.js`.
- **`tenantRiskGuard.js`** — sin cambios, mismo razonamiento de
  `CHECKPOINT_11.md` (ADR-017, alcance deliberadamente acotado).

Recomendación para la próxima sesión: los 4 motores de scoring/backtest
(`scoringService.js`, `adaptiveScoring.js`, `mlScoringPipeline.js`,
`smartOrderRouter.js`) son el siguiente subconjunto de mayor apalancamiento
— pero antes de tocarlos, investigar primero la relación real entre
`backtestEngine.js`/`arbBacktestEngine.js`/`institutionalBacktest.js`
(leer los tres archivos completos y sus callers reales, no solo grep) para
no migrar tres motores redundantes por separado si en realidad uno de
ellos ya está deprecado o sin caller activo.

### Puntos 7 y 8 de la hoja de ruta — sin cambios esta sesión

- **Punto 7 — persistir snapshot completo de wallet en Mongo.** Sigue
  requiriendo diseño de esquema Mongoose + migración; no se intentó esta
  sesión (no es mecánico, y el tiempo se priorizó en cerrar el punto 1 con
  verificación completa en vez de dejar dos frentes a medio abrir).
- **Punto 8 — unificar manejo de errores** (`DomainError` /
  `expressErrorHandler` ya wireados, rutas individuales sin migrar). Mismo
  motivo — sin cambios.

### Estado de los 8 puntos de la hoja de ruta al cierre de esta sesión

| # | Punto | Estado |
|---|---|---|
| 1 | Tipos de dominio únicos | 🟡 Avance parcial esta sesión — 5/17 motores migrados + 1 evaluado y descartado explícitamente |
| 2 | README desalineado | ✅ Ya estaba resuelto |
| 3 | Aplanar `domain/` en subcarpetas | ✅ Resuelto (sesión anterior) |
| 4 | Auditar patrón `getHandler()` | ✅ Resuelto (sesión anterior) |
| 5 | Code-splitting de `ArbitragePage` | ✅ Ya estaba resuelto |
| 6 | Vista de entrada canónica | ✅ Ya estaba resuelto |
| 7 | Persistir wallet snapshot en Mongo | Pendiente |
| 8 | Unificar manejo de errores | Pendiente (infraestructura lista, migración de rutas pendiente) |

5 de 8 puntos resueltos, 1 en progreso con avance real y próximos pasos
concretos documentados, 2 pendientes sin cambio.

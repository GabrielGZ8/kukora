## CHECKPOINT_13 — Sesión 2026-07-08 (continuación): investigación de los
3 backtest engines (recomendación de CHECKPOINT_12), bug real encontrado
y corregido en `getOpportunityLog()`, y evaluación explícita de los 4
motores de scoring restantes del punto 1

Esta sesión parte del zip `Kukora-CHECKPOINT-12.zip` y de la recomendación
explícita que cierra `CHECKPOINT_12.md`: antes de tocar los 4 motores de
scoring/backtest señalados como siguiente subconjunto de mayor
apalancamiento (`scoringService.js`, `adaptiveScoring.js`,
`mlScoringPipeline.js`, `smartOrderRouter.js`), investigar primero la
relación real entre `backtestEngine.js`, `arbBacktestEngine.js` e
`institutionalBacktest.js` — leyendo los tres archivos completos y sus
callers reales, no solo grep — para no migrar tres motores redundantes
por separado si en realidad uno de ellos ya está deprecado.

Línea base verificada antes de tocar nada: `npm ci` + `npx vitest run` →
**95 archivos, 1583 tests, 0 fallos, 67.5s** (idéntico a lo reportado al
cierre de `CHECKPOINT_12.md`).

### 1. Investigación: los 3 backtest engines NO son redundantes

Se leyeron los tres archivos completos (208 + 232 + 449 líneas) y se
verificaron sus callers reales con grep dirigido a `require(...)`, no
asumido de nombres:

- **`backtestEngine.js`** — motor de análisis técnico genérico
  (SMA Crossover, RSI Mean Reversion, Bollinger Breakout, Buy & Hold)
  sobre la serie de precios de **cualquier moneda** (no específico de
  arbitraje). Wired a `GET /api/crypto/coin/:id/backtest`, consumido por
  `src/pages/BacktestPage.jsx` (ruta `/backtest`, nav `research`) y
  también por `datasetService.js` internamente. No maneja `Opportunity`
  ni `Trade` en ningún punto — opera sobre `prices: number[]` puros.
  **Activo, no deprecado, no redundante** — es un producto genuinamente
  distinto (análisis técnico de un activo cualquiera, no evaluación de la
  estrategia de arbitraje).
- **`arbBacktestEngine.js`** — el reemplazo intencional de
  `backtestEngine.js` **para la estrategia de arbitraje específicamente**
  (el propio archivo lo documenta en su cabecera: "El backtestEngine.js
  original corre SMA/RSI/Bollinger sobre precios de BTC... eso no tiene
  ninguna relación con la estrategia de arbitraje que evalúa el
  challenge"). Hace parameter sweep + walk-forward validation +
  stress scenarios sobre el `opportunityLog` real de sesión. Wired a
  `GET/POST /api/arbitrage/arb-backtest/{summary,sweep,simulate,institutional}`,
  consumido por `src/pages/ArbBacktestPage.jsx` (ruta `/arb-backtest`, nav
  `arb`) — **excepto** el endpoint `/arb-backtest/institutional`, que no
  tiene ningún caller en `src/` (frontend no lo usa hoy; hallazgo nuevo,
  ver sección 4). También consumido por `adaptiveScoring.js` (vía
  `walkForward`).
- **`institutionalBacktest.js`** — no es un tercer backtest paralelo: es
  una capa de métricas institucionales (Sharpe, Sortino, Calmar, Kelly,
  VaR, Omega, etc.) que consume el `simResult` que produce
  `arbBacktestEngine.simulateRun()` como input — layering real, no
  duplicación. Tiene dos productores de `simResult` independientes:
  `query.routes.js` (usa el `simResult` real de `simulateRun()` directo)
  y `performanceReport.js` (construye su propio objeto
  `{ executions, equityCurve, totalNetProfit, params }` a mano desde
  datos de wallet en vivo). Esto es, en menor escala, el mismo patrón de
  "forma implícita compartida sin contrato" que motivó todo el punto 1 —
  un candidato futuro razonable sería nombrar esa forma (`SimResult`) como
  tipo compartido, mismo patrón que `RiskContext`.

**Conclusión:** los tres backtest engines son tres capas legítimas y
activas, no una redundancia de nombres ambigua. No se fusionó ni se
eliminó ninguno.

### 2. Bug real encontrado durante la investigación (no hipotético — confirmado corriendo el código)

Al leer `arbBacktestEngine.js` línea por línea contra el shape real que
produce `getOpportunityLog()` (en vez de asumir que coinciden), se
encontró que `simulateRun()` decide si cada trade se ejecuta con
`op.score >= minScore` (línea 43 de `arbBacktestEngine.js`) — pero el
objeto que `opportunityDetection.js` empuja a `_opportunityLog` (líneas
576-586) **nunca incluía el campo `score`**, a pesar de que `op.score` sí
se calcula unas líneas antes (línea 554-558) para el objeto `Opportunity`
completo.

Se verificó empíricamente (script ad-hoc antes de tocar nada, después
revertido): con el shape real de log de producción, `simulateRun()`
devuelve `tradesExecuted: 0` y `totalNetProfit: 0` **siempre**, sin
importar cuán rentables sean las oportunidades reales — porque
`undefined >= minScore` es `false` para cualquier `minScore`, incluido 0.

**Impacto en producción:** los endpoints `/api/arbitrage/arb-backtest/summary`,
`/sweep`, `/simulate` e `/institutional` (los cuatro consumidos por
`ArbBacktestPage.jsx`, más `adaptiveScoring.js` vía `walkForward`)
reportaban 0 trades ejecutados y $0 de profit para cualquier sesión con
actividad real de mercado. Sin test de contrato (no existía ningún test
para `arbBacktestEngine.js`, `adaptiveScoring.js` ni `institutionalBacktest.js`
antes de esta sesión), este bug no tenía ninguna posibilidad de
detectarse.

**Fix aplicado:** se agregó `score: op.score` al objeto pusheado en
`server/domain/engines/opportunityDetection.js` (con comentario explicando
el bug para que no se repita), y se agregó
`tests/arbBacktestEngine.test.js` con 3 tests que ejercitan el pipeline
real (`detectOpportunities()` real → `getOpportunityLog()` real →
`simulateRun()`/`parameterSweep()` reales, no fixtures a mano). Se
verificó manualmente, antes de restaurar el fix, que el test en efecto
falla sin la corrección (revert temporal del fix → 2 de 3 tests fallan
con `expected 0 to be greater than 0` → se restauró el fix → los 3 tests
pasan).

### 3. Evaluación explícita de los 4 motores de scoring señalados por CHECKPOINT_12

Se leyeron los cuatro completos antes de decidir. Ninguno resultó ser un
candidato real para el patrón `isOpportunity()`/`isTrade()` — pero por
razones distintas en cada caso, documentadas como comentario en el propio
archivo (mismo criterio que `statArbEngine.js` en `CHECKPOINT_12.md`, para
que una sesión futura no repita el análisis):

1. **`scoringService.js`** — scoring de **assets** (Intelligence page,
   market screening), no de oportunidades de arbitraje. El propio archivo
   ya lo declaraba en su comentario de cabecera ("NOT the arbitrage
   opportunity scoring system"). Input/output no comparten ningún campo
   de `Opportunity`. Vocabulario genuinamente distinto — igual que
   `statArbEngine.js`.
2. **`smartOrderRouter.js`** — su único punto de entrada real,
   `decideOrderType(side, referencePrice, opts)`, recibe primitivos, no
   un `Opportunity` ni un `Trade`. No hay objeto de dominio que pueda
   driftear aquí.
3. **`mlScoringPipeline.js`** — este sí recibe algo con forma de
   `Opportunity` (`scoreOpportunity(opportunity, context)`), pero su
   único punto de entrada real es la ruta `POST /api/arbitrage/ml/score`,
   que **ya** valida el body contra `OpportunitySchema` (zod,
   `.passthrough()`) antes de llegar al módulo — un contrato explícito y
   bloqueante (rechaza con 400), más fuerte que el patrón no-bloqueante
   usado en los motores satélite migrados. Agregar `isOpportunity()`
   adentro sería redundante sobre un límite ya protegido. (Nota menor,
   no corregida esta sesión por estar fuera de alcance: `OpportunitySchema`
   solo exige `buyExchange`/`sellExchange`, no `netProfit`/`spreadPct`/
   `viable` — más laxo que `isOpportunity()` — pero el módulo tolera esos
   campos ausentes con defaults seguros, así que no genera un fallo, solo
   una superficie de validación más laxa de lo ideal.)
4. **`adaptiveScoring.js`** — mismo caso que `arbBacktestEngine.js` (del
   cual consume `walkForward`): su punto de entrada real,
   `recalcIfNeeded(oppLog, tradeCount)`, recibe el mismo `oppLog` reducido
   que expone `getOpportunityLog()` — no el `Opportunity` canónico
   completo. `isOpportunity()` rechazaría el 100% de esas entradas por
   diseño (forma deliberadamente más chica, con `pair` como string
   combinado en vez de `buyExchange`/`sellExchange` separados), no por
   drift real. Recomendación dejada en el propio archivo: si se quiere un
   contrato explícito para esta forma, debería ser un tipo nuevo
   (`OpportunityLogEntry`), no forzar `Opportunity`.

**Resultado:** 0 motores migrados al patrón `isOpportunity()`/`isTrade()`
esta sesión — pero los 4 fueron leídos a fondo y la decisión de no
migrarlos quedó documentada en cada archivo, evitando que una sesión
futura repita el mismo análisis. El valor real de la sesión fue el bug
encontrado y corregido en la sección 2, que es exactamente la clase de
drift silencioso que este punto de la hoja de ruta busca prevenir —
solo que en un shape distinto al que se estaba buscando (`OpportunityLogEntry`,
no `Opportunity` en sí).

### 4. Hallazgo adicional (no accionado esta sesión): endpoint sin caller

`GET /api/arbitrage/arb-backtest/institutional` existe, está wired a
lógica real (`institutionalBacktest.computeInstitutionalMetrics/
generateInstitutionalReport`), y no dispara error — pero no se encontró
ningún caller en `src/` (`ArbBacktestPage.jsx` no lo usa). No se investigó
si es una feature planeada aún no conectada al frontend o simplemente
huérfana; queda como nota para una sesión futura, no se tocó código de
producto por estar fuera del alcance de esta sesión (investigación de
punto 1, no auditoría de endpoints huérfanos).

### Tests de contrato agregados

- `tests/arbBacktestEngine.test.js` — **nuevo archivo, 3 tests**. Ejercita
  `detectOpportunities()` real → `getOpportunityLog()` real →
  `simulateRun()`/`parameterSweep()` reales. Verificado manualmente que
  detecta el bug de la sección 2 (falla sin el fix, pasa con el fix).

### Verificación completa (todo corrido de verdad, no asumido)

- `npx vitest run` → **96 archivos, 1586 tests, 0 fallos** (1583 base + 3
  nuevos), 65.6s.
- `npx tsc --noEmit` → limpio.
- `npm run check:ts-drift` → sin drift, 7 archivos verificados (sin
  cambios — el único archivo de producción tocado,
  `opportunityDetection.js`, es un `.js` plano sin fuente `.ts`
  correspondiente en `server-types/`, no uno de los 7 archivos
  TS-trackeados).
- `npm run check:i18n` → paridad, 240 llaves (sin cambios — esta sesión no
  tocó strings de UI).
- `npm run test:smoke` → 76/76.
- `npx eslint server/ src/ --ext .js,.jsx` → 0 errores, 0 warnings.
- `npm run build` → limpio; `ArbitragePage` chunk sin cambios (77.94 kB /
  20.21 kB gzip) — esta sesión no tocó frontend.

### Archivos nuevos o modificados esta sesión

- `server/domain/engines/opportunityDetection.js` — **fix de bug real**:
  agregado `score: op.score` al objeto pusheado a `_opportunityLog`
  (antes faltaba, causando que `arbBacktestEngine.simulateRun()` nunca
  ejecutara trades en producción). Comentario explicando el bug agregado
  junto al fix.
- `server/domain/engines/adaptiveScoring.js` — comentario de decisión
  documentando por qué no se migra (sin cambio funcional) + referencia al
  bug corregido, ya que este módulo depende de la misma forma reducida.
- `server/domain/engines/scoringService.js` — comentario de decisión
  documentando por qué no se migra (sin cambio funcional).
- `server/domain/engines/smartOrderRouter.js` — comentario de decisión
  documentando por qué no se migra (sin cambio funcional).
- `server/domain/engines/mlScoringPipeline.js` — comentario de decisión
  documentando por qué no se migra (sin cambio funcional).
- `tests/arbBacktestEngine.test.js` — nuevo, 3 tests de contrato/regresión
  contra el pipeline real.

No se tocó `CHANGELOG.md` ni `MIGRATION_CLEANUP_LOG.md` — mismo criterio
que sesiones anteriores.

### Lo que queda pendiente del punto 1 (no alcanzado esta sesión)

De los ~17 motores de `domain/engines/`, tras esta sesión:

- **Migrados y con test de contrato (sesiones anteriores):**
  `opportunityDetection.js`, `fillProbabilityEngine.js`,
  `liquidityPredictionEngine.js`, `spreadMomentumEngine.js`,
  `predictiveRebalance.js` — 5 de 17. Sin cambios esta sesión (no se
  migró ninguno nuevo — ver sección 3).
- **Evaluado y decidido explícitamente no migrar** (documentado en el
  propio archivo): `statArbEngine.js` (sesión anterior),
  `scoringService.js`, `adaptiveScoring.js`, `mlScoringPipeline.js`,
  `smartOrderRouter.js` (esta sesión) — 5 motores evaluados y
  descartados con razón explícita.
- **Investigados y confirmados como capas legítimas, no candidatos de
  migración de tipo (consumen `simResult`/`opportunityLog`, no
  `Opportunity` directo), con un bug real corregido en el camino:**
  `arbBacktestEngine.js`, `institutionalBacktest.js`, `backtestEngine.js`
  (este último ni siquiera es del dominio de arbitraje).
- **Sin tocar, no manejan `Opportunity`/`Trade` directamente** (mismo
  razonamiento de sesiones anteriores): `multiHopArbitrageEngine.js`,
  `rebalanceEngine.js`, `rebalanceScheduler.js`, `marketRegimeEngine.js`.
- **`tenantRiskGuard.js`** — sin cambios (ADR-017, alcance
  deliberadamente acotado).

Con esto, de los ~17 motores originales de `domain/engines/`, quedan
efectivamente **0 motores sin evaluar** para el patrón
`Opportunity`/`Trade` — todos fueron migrados, evaluados-y-descartados
con razón explícita, o confirmados fuera de alcance por vocabulario
propio. El punto 1 pasa de "avance parcial" a "cobertura de evaluación
completa": 5 migrados, 6 evaluados y descartados con justificación
documentada, 6 confirmados sin relación directa con el contrato.

**Recomendación para la próxima sesión:**
1. Si se quiere seguir profundizando el punto 1, el siguiente paso natural
   no es más migración de `isOpportunity()` (ya no quedan candidatos
   reales) sino nombrar formalmente la forma reducida que comparten
   `arbBacktestEngine.js`/`adaptiveScoring.js`/`getOpportunityLog()` como
   un tipo propio (`OpportunityLogEntry`), con su propio type guard —
   mismo patrón que `RiskContext`. Esto cerraría la brecha que permitió el
   bug de la sección 2.
2. Investigar el endpoint huérfano `/arb-backtest/institutional` (sección
   4) — ¿feature planeada sin conectar, o código muerto?
3. Revisar si `OpportunitySchema` (zod) debería exigir
   `netProfit`/`spreadPct`/`viable` además de `buyExchange`/`sellExchange`,
   para que el contrato de `/ml/score` sea al menos tan estricto como
   `isOpportunity()`.
4. Los puntos 7 y 8 de la hoja de ruta (persistir wallet snapshot en
   Mongo, unificar manejo de errores) siguen sin tocar — mismo motivo que
   sesiones anteriores, se priorizó cerrar esta investigación con
   verificación completa en vez de abrir un tercer frente a medio hacer.

### Estado de los 8 puntos de la hoja de ruta al cierre de esta sesión

| # | Punto | Estado |
|---|---|---|
| 1 | Tipos de dominio únicos | 🟡 Cobertura de evaluación completa (5 migrados, 6 evaluados y descartados, 6 fuera de alcance) + 1 bug real corregido en el camino |
| 2 | README desalineado | ✅ Ya estaba resuelto |
| 3 | Aplanar `domain/` en subcarpetas | ✅ Resuelto (sesión anterior) |
| 4 | Auditar patrón `getHandler()` | ✅ Resuelto (sesión anterior) |
| 5 | Code-splitting de `ArbitragePage` | ✅ Ya estaba resuelto |
| 6 | Vista de entrada canónica | ✅ Ya estaba resuelto |
| 7 | Persistir wallet snapshot en Mongo | Pendiente |
| 8 | Unificar manejo de errores | Pendiente (infraestructura lista, migración de rutas pendiente) |

5 de 8 puntos resueltos, 1 con cobertura de evaluación completa y un bug
real corregido, 2 pendientes sin cambio.

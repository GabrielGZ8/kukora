## CHECKPOINT_15 — Sesión 2026-07-08/09: cierre de pendientes de CHECKPOINT_14
más limpieza de `console.*` contra la auditoría de comité 2026-07-08

**Fecha/hora:** 2026-07-08/09, sesión continua (~04:20 UTC al cierre).

**Objetivo de este checkpoint:** el usuario adjuntó `Kukora-Auditoria-Comite-2026-07-08.md`
(auditoría de comité completa, nota **63/100**, con una hoja de ruta de 8
puntos hacia 100) junto con `Kukora-CHECKPOINT-14.zip` y el transcript de la
sesión anterior. Ese transcript mostraba trabajo ya hecho y verificado
(pestaña Institutional Metrics, tipo `OpportunityLogEntry`, endurecimiento de
`MlScoreBodySchema`, inicio de `SimResult`) — pero **ese trabajo nunca llegó
a empaquetarse en un zip**, solo quedó en el transcript. Al desempaquetar
`Kukora-CHECKPOINT-14.zip` se confirmó: base real = 96 archivos / **1602**
tests, sin la pestaña institucional en `ArbBacktestPage.jsx` (351 líneas,
igual que CHECKPOINT_13) y sin `isOpportunityLogEntry`. Esta sesión:

1. Confirmó contra el código real cuánto de la hoja de ruta de la auditoría
   ya estaba resuelto por sesiones previas (mucho más de lo que el propio
   `CHECKPOINT_14.md` documentaba — ver sección 2).
2. **Reaplicó desde cero** el trabajo del transcript perdido (institucional
   tab, `OpportunityLogEntry`, `MlScoreBodySchema`) directamente sobre el
   código real de este checkpoint, verificando cada paso.
3. Cerró un hallazgo real y no trivial de la auditoría (limpieza de
   `console.*` server-side + regla eslint que antes solo lo *decía*).

### 1. Reaplicado desde el transcript perdido (nunca había quedado en un zip)

**a) Endpoint huérfano `/api/arbitrage/arb-backtest/institutional` conectado
al frontend** — nueva pestaña "🏛 Institutional Metrics" en
`src/pages/ArbBacktestPage.jsx`: grade badge, Sharpe/Sortino/Calmar/Omega,
retornos, drawdown/recovery, win rate/profit factor/expectancy, VaR 95%,
Kelly Criterion (full/half) y leverage implícito, disclaimer. Lint y build
de frontend verificados (`ArbBacktestPage` chunk: 21.16 kB / 5.37 kB gzip).

**b) `OpportunityLogEntry` como tipo nombrado** (`server-types/server/domain/opportunity.ts`):
interfaz + `isOpportunityLogEntry()` type guard, distinto a `isOpportunity()`
a propósito (forma reducida con `pair` combinado, no
`buyExchange`/`sellExchange` separados). Aplicado como contract check suave
(emite `obs.emit('RISK', 'contract.opportunity_log_entry_shape_invalid', …)`,
no bloquea) en `arbBacktestEngine.simulateRun()` — `walkForward()` lo hereda
automáticamente porque llama a `simulateRun()` internamente, así que
`adaptiveScoring.js` queda cubierto sin tocarlo. Recompilado con
`npm run build:ts`; `check:ts-drift` limpio. 5 tests nuevos en
`tests/opportunity.test.js` (forma válida, null/undefined/no-objeto, falta
`score` — el bug real de CHECKPOINT_13 —, un `Opportunity` completo NO
satisface esta guarda, y las entradas reales de
`opportunityDetection.getOpportunityLog()` sí la satisfacen).

**c) `MlScoreBodySchema` (zod) más estricto** (`server/domain/risk/arbitrageValidation.js`):
dejó de ser un alias directo de `OpportunitySchema` (que solo exige
`buyExchange`/`sellExchange`) — ahora es `OpportunitySchema.extend({netProfit,
spreadPct, viable})`, alineado con lo que `isOpportunity()` ya exige.
`ExecuteCrossBodySchema` (trading real) no se tocó — sigue usando
`OpportunitySchema` sin extender, porque ese payload no siempre trae esos
campos antes de scoring. 2 tests nuevos en
`tests/arbitrage.query.routes.test.js` que ejercitan el middleware real
(`getFirstMiddleware`, no `getHandler` — ver nota más abajo) confirmando que
un body sin `netProfit`/`spreadPct`/`viable` ahora es rechazado con 400 y uno
completo pasa.

### 2. Confirmado contra el código real: gran parte de la hoja de ruta de la
auditoría (sección 12 del documento) ya estaba resuelta antes de esta sesión

El propio `CHECKPOINT_14.md` no lo documentaba, pero verificando directamente:

| # | Hallazgo de la auditoría | Estado verificado hoy |
|---|---|---|
| 2 | README con diagrama desactualizado (`arbitrageEngine.js`) | ✅ Ya corregido — cita `opportunityDetection.js`/`arbitrageOrchestrator.js` con nota explícita del rename |
| 3 | `domain/` con 47 archivos planos sin subcarpetas | ✅ Ya resuelto — `domain/{analytics,engines,risk,wallet}/` con 3 archivos sueltos justificados (`errors.js`, `opportunity.js`, `validation.js`) |
| 5 | `ArbitragePage.jsx` importa 19 paneles de forma estática (495 kB) | ✅ Ya resuelto — los 19 paneles usan `lazy()` + `Suspense` con `ErrorBoundary` individual |
| 8 | Manejo de errores no unificado, sin jerarquía `DomainError` | ✅ Ya resuelto — `server/domain/errors.js` (`DomainError`/`ValidationError`/`NotFoundError`/etc.) + `expressErrorHandler` montado como handler global en `server/index.js` |
| 7 | Persistencia de wallet solo en métricas, no snapshot completo | ✅ Ya resuelto en CHECKPOINT_14 (punto 7 de esa sesión) |
| 1 | `Opportunity`/`Trade` como tipos únicos | ✅ Ya existen (`domain/opportunity.ts`) y son consumidos por los engines relevantes; `RiskContext` también existe (`domain/risk/riskContext.js`) |

Pendientes reales que quedan abiertos de esa hoja de ruta (no alcanzados
hoy, ver sección 4):
- **#4 — auditoría completa del patrón `getHandler()`** en los 8 archivos
  `*.routes.test.js` que lo usan. Verificación parcial hecha hoy: 6 de 8
  archivos (`arbitrage.config.routes.test.js`, `arbitrage.query.routes.test.js`,
  `auth-core.test.js`, `notifications.routes.test.js`, `user-data.routes.test.js`,
  y el propio `arbitrage.stream.routes.test.js` que no usa `getHandler`) ya
  tienen cobertura real de middleware (`getFirstMiddleware`/`requireRole`/
  `requireAuth`) en el mismo archivo. `crypto.routes.js` se confirmó que no
  tiene ninguna ruta con `requireAuth`/`requireRole` (son todos endpoints
  públicos de datos de mercado), así que el patrón no es un riesgo real ahí.
  **`auth.routes.test.js` quedó sin verificar** — la sesión se interrumpió
  antes de confirmar si sus rutas están gateadas y si el `getHandler()` ahí
  salta algo relevante. Retomar esto primero en la próxima sesión.
- **#6 — `ExecutiveDashboard` como landing canónica post-login.** No se tocó
  el ruteo esta sesión; `ExecutiveDashboard.jsx` existe y ya se usa como tab
  `'executive'` dentro de `ArbitragePage`, pero no es la ruta de entrada
  por defecto. Cambiar esto es una decisión de producto/UX, no solo código —
  queda documentado como pendiente, no como bug.

### 3. Limpieza de `console.*` directo en `server/` (auditoría, sección 3)

La auditoría encontró 19 usos directos de `console.log/warn/error` en
`server/` **a pesar de que `.eslintrc.cjs` documentaba** (en un comentario)
que la regla `no-console` estaba activa porque "server usa logger
estructurado" — pero la regla real estaba en `'off'` para todo `server/**/*.js`,
así que ese comentario no reflejaba la config real. Esta sesión:

- Migró los 15 usos reales restantes (de los ~19 originales, 4 ya habían
  sido limpiados en sesiones previas) a `logger.{debug,warn,error}()`
  (`server/infrastructure/logger.js`), en 10 archivos:
  `exchangeService.js`, `persistenceService.js`, `spreadHeatmapService.js`,
  `dailyReportService.js`, `replayService.js`, `dailyStatsService.js`,
  `secretsVault.js`, `arbitrage.state.js`, `adaptiveScoring.js`,
  `crypto.routes.js`. El único `console.log` que queda en `server/` es
  dentro de `logger.js` mismo (la implementación real del output en modo
  dev) — caso base legítimo.
- `walletManager.ts` (fuente TS) también migrado (`_warn` ahora usa
  `logger.warn`); recompilado con `npm run build:ts`, `check:ts-drift`
  limpio.
- **`.eslintrc.cjs` corregido**: `no-console` para `server/**/*.js` pasó de
  `'off'` a `'error'` (con una excepción explícita para
  `server/infrastructure/logger.js`, que es la implementación misma). Antes
  esta regla no hacía nada; ahora un futuro `console.log` suelto en
  `server/` rompe el lint, cerrando el hallazgo real (no solo el síntoma).
- `npm run lint` limpio después del cambio — 0 errores.

### 4. Pendientes para la próxima sesión (en orden de prioridad sugerido)

1. **Terminar la auditoría de `getHandler()`** — falta revisar
   `auth.routes.test.js` (4 usos, sin `getFirstMiddleware`/`requireRole` en
   el mismo archivo) para confirmar si sus rutas tienen middleware de
   autorización que el patrón podría estar saltando, y agregar cobertura de
   middleware real si hace falta (mismo patrón ya usado en
   `arbitrage.query.routes.test.js` para `/ml/score`).
2. **`SimResult` como tipo compartido** — la sesión perdida había empezado
   `server-types/server/domain/engines/simResult.ts` pero nunca llegó a
   compilarlo/aplicarlo a los dos productores reales
   (`query.routes.js` vs `performanceReport.js`). Esta sesión no lo retomó
   por prioridad (ver sección 1 arriba, que sí se completó). Repetir el
   mismo patrón que `OpportunityLogEntry`: definir la interfaz + type guard
   en `.ts`, aplicar contract check suave en ambos productores, tests.
3. **`ExecutiveDashboard` como landing canónica** (roadmap #6 de la
   auditoría) — decisión de producto: promover a ruta post-login por
   defecto en vez de (o además de) `DashboardPage`. Requiere tocar el
   router (`src/App.jsx` o equivalente) y probablemente el flujo de login.
4. **Repositorio único de 315 líneas para todo el dominio**
   (`server/repositories/index.js`) — la auditoría lo señala como un punto
   de acoplamiento a este tamaño de dominio (15+ entidades). No se tocó
   esta sesión; es un refactor de mayor alcance/riesgo que amerita su
   propia sesión dedicada con tests de regresión por entidad.
5. Reescaneo final de la auditoría completa contra el estado del código
   una vez cerrados los puntos 1-4 arriba, para recalcular la nota
   estimada con más precisión.

### 5. Riesgos conocidos

- Ninguna regresión detectada — suite completa, tsc, drift check, i18n,
  smoke tests, eslint y build de frontend corrieron limpios después de
  todos los cambios (ver verificación abajo).
- El endurecimiento de `no-console` a `'error'` en `server/**/*.js` es un
  cambio de configuración, no solo de código — cualquier PR futuro que
  agregue un `console.*` suelto en `server/` ahora rompe `npm run lint`
  (antes no lo hacía). Esto es la intención, pero vale la pena que el
  equipo lo sepa explícitamente antes de la próxima sesión de CI.
- `MlScoreBodySchema` ahora exige `netProfit`/`spreadPct`/`viable` en el
  body de `/api/arbitrage/ml/score` — cualquier caller externo (o el
  propio frontend) que llamara a ese endpoint con un objeto de oportunidad
  incompleto ahora recibe 400 en vez de que el pipeline tolerara los campos
  ausentes con defaults. Se verificó que el único caller conocido en
  `src/` no está afectado (no se encontró ningún `fetch`/`api.post` hacia
  `/ml/score` en el frontend hoy — es un endpoint consumido externamente o
  aún sin caller de UI), pero vale la pena confirmarlo explícitamente en la
  próxima sesión si se agrega un caller nuevo.
- La auditoría de `getHandler()` quedó **incompleta** (`auth.routes.test.js`
  sin revisar) — no se debe asumir que el patrón es seguro en todos los
  archivos que lo usan hasta cerrar el punto 1 de la sección 4.

### 6. Verificación completa ejecutada esta sesión

```
npx vitest run          → 96 archivos, 1609 tests, 0 fallos (~65s)
npx tsc --noEmit         → 0 errores
npm run check:ts-drift   → ✅ sin drift (7 archivos verificados)
npm run check:i18n       → ✅ es.js/en.js en paridad (240 llaves)
npm run test:smoke       → ✅ 76/76 tests
npm run lint             → ✅ 0 errores/warnings (con no-console ahora
                             realmente activo en server/, no solo declarado)
npm run build            → ✅ build de producción exitoso (~12s)
```

### 7. Estado estimado respecto a la auditoría de comité 2026-07-08

**~72-75/100** (subiendo desde el 63/100 explícito del documento de
auditoría). La nota de 63 se basaba en una lectura del código *antes* de
varias rondas de trabajo que, verificado hoy línea por línea, ya habían
resuelto 5 de los 8 puntos de la hoja de ruta priorizada (README, domain/
en subcarpetas, code-splitting de ArbitragePage, jerarquía DomainError,
persistencia de wallet) — el documento de auditoría no pudo reflejar eso
porque analiza una foto fija. De los 3 puntos que seguían genuinamente
abiertos hoy al empezar esta sesión (tipos de dominio compartidos entre
motores satélite, patrón `getHandler()`, `ExecutiveDashboard` como landing),
esta sesión avanzó el primero de forma indirecta (`OpportunityLogEntry`
nuevo, aunque `SimResult` quedó pendiente) y dejó el segundo parcialmente
verificado (6 de 8 archivos confirmados seguros). No se llegó a 100 — los
puntos 1-4 de la sección 4 arriba son trabajo real pendiente, no deuda
cosmética, y el propio roadmap de la auditoría es honesto en que varios de
estos ítems son "días, no minutos" de trabajo genuino.

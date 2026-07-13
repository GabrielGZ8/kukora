## CHECKPOINT_10 — Sesión 2026-07-08 (tarde): cerrando la hoja de ruta de
la Auditoría de Comité

Esta sesión parte de `docs/Kukora-Auditoria-Comite-2026-07-08.md` (adjuntada
por el usuario, no incluida en el repo — ver hoja de ruta, sección 12, con
8 puntos priorizados) y del zip `Kukora-CHECKPOINT-2.zip`. Antes de tocar
nada se corrió la línea base: `npx vitest run` → **93 archivos, 1552 tests,
0 fallos, 55.7s**. Todo lo que sigue se verificó de la misma forma después
de cada cambio, no se asume nada de la documentación.

### Punto de partida: 3 de los 8 ítems ya estaban resueltos

Antes de escribir código se auditó el estado real de cada uno de los 8
puntos de la hoja de ruta contra el código del checkpoint recibido — varios
ya habían sido corregidos en una sesión anterior a la que escribió el
documento de auditoría (o en paralelo a ella):

- **Punto 2 (README desalineado):** ya corregido — el diagrama usa
  `opportunityDetection.js`/`arbitrageOrchestrator.js` con una nota
  explícita fechada 2026-07-08 documentando el rename.
- **Punto 5 (code-splitting de ArbitragePage):** ya corregido — los 19
  paneles de tab ya usan `lazy()` + `Suspense`, con un comentario en el
  propio archivo citando este mismo ítem de la auditoría. Verificado con
  `npm run build`: el chunk de `ArbitragePage` pesa hoy **77.94 kB (20.21
  kB gzip)**, no los 495.77 kB que documentaba el addendum de due diligence.
- **Punto 6 (vista de entrada canónica):** ya existe — `"/"` redirige a
  `/summary`, y `SummaryPage.jsx` ya surface el diferenciador VWAP L2
  ("20 pairs VWAP L2 + StatArb EWMA") en su diagrama de arquitectura.

### Trabajo hecho esta sesión

**1. Punto 4 — auditar el patrón `getHandler()` que salta middleware
(tests/routesAuthMiddleware.security.e2e.test.js, archivo nuevo):**
8 archivos de test (`arbitrage.config/query/stream.routes.test.js`,
`auth.routes.test.js`, `auth-core.test.js`, `crypto.routes.test.js`,
`notifications.routes.test.js`, `user-data.routes.test.js`) comparten un
helper que invoca solo el último middleware de una ruta, saltándose
`requireAuth`/`requireRole` — el mismo patrón que dejó pasar el bug real de
`POST /api/arbitrage/config` sin `requireRole('admin')` (ya corregido en
sesión anterior). Sin tocar esos archivos (siguen siendo válidos para lo
que sí prueban), se agregó un archivo e2e con `supertest` contra la app
real que verifica el gate de auth/rol en los puntos de mayor riesgo:
`GET /api/arbitrage/stats`, `POST /api/arbitrage/risk/circuit-breaker/reset`
(admin), `GET /api/arbitrage/stream`, `GET|POST /api/notifications/*`,
`GET /api/alerts`, `PATCH /api/auth/me`, `POST /api/auth/change-password`,
y confirma que `GET /api/crypto/trending` sigue siendo público a propósito.
**14 tests nuevos, todos verdes.**

**2. Punto 3 — aplanar `domain/` en subcarpetas por responsabilidad
(el ítem más grande de esta sesión):**
`server/domain/` tenía 47 archivos al mismo nivel — el mismo patrón de
deuda que motivó la reorganización `server/` → `domain/infrastructure/
application/`, reaparecido un nivel más adentro (diagnosticado en la
sección 1 de la auditoría). Se movieron los 44 archivos aplicables a
cuatro subcarpetas por bounded context, dejando 3 archivos compartidos
(`errors.js`, `opportunity.js`, `validation.js`) en la raíz de `domain/`:

- `domain/risk/` (8): `advancedRiskEngine`, `slippageValidator`,
  `adaptivePositionSizing`, `userRiskProfileService`, `tradingValidation`,
  `stressTestService`, `adversarialScenarios`, `arbitrageValidation`.
- `domain/wallet/` (5): `walletManager`, `auditedPnl`,
  `capitalEfficiency`, `feeConfig`, `weeklyPnlTracker`.
- `domain/engines/` (17): `opportunityDetection`,
  `multiHopArbitrageEngine`, `statArbEngine`, `spreadMomentumEngine`,
  `backtestEngine`, `arbBacktestEngine`, `institutionalBacktest`,
  `fillProbabilityEngine`, `liquidityPredictionEngine`,
  `marketRegimeEngine`, `rebalanceEngine`, `rebalanceScheduler`,
  `smartOrderRouter`, `predictiveRebalance`, `mlScoringPipeline`,
  `scoringService`, `adaptiveScoring`.
- `domain/analytics/` (14): `analytics`, `anomalyService`,
  `datasetService`, `directionalBiasTracker`, `executionJournal`,
  `explainability`, `forecastService`, `kcsService`, `multiPairService`,
  `opportunityLifecycle`, `performanceReport`, `quant`,
  `simulationService`, `tradeStateMachine`.

Esto tocó **217 `require()`/`import`/`import()` dinámicos** reescritos
mecánicamente (con un script que resuelve cada ruta relativa vieja contra
su ubicación absoluta real y recalcula la ruta correcta desde la nueva
ubicación — tanto para archivos que consumen módulos de `domain/` como
para los propios archivos de `domain/` que ahora están un nivel más
adentro y necesitan un `../` extra hacia `infrastructure/`/`application/`/
`models.js`). Tres clases de referencia necesitaron pasadas manuales
adicionales porque el script inicial solo cubría `require()` con string
literal: `import(...)` dinámico (4 archivos de test), `import ... from
'...'` estático (14 archivos de test), y `require.resolve(...)` dentro de
`tests/smoke.test.js` (excluido del run de vitest, así que un error ahí no
se hubiera visto sin correr `npm run test:smoke` explícitamente — se
corrió y se corrigió).

**2.1 — Consecuencia no obvia: 3 de los archivos movidos son build
artifacts de TypeScript (ADR-013).** `advancedRiskEngine.js`, `feeConfig.js`
y `walletManager.js` no son código fuente — son la salida comiteada a mano
de `tsc` compilando `server-types/server/domain/{advancedRiskEngine,
feeConfig,walletManager}.ts` (`validation.js` y `opportunity.js` también
son build artifacts pero se quedaron en la raíz, sin cambio). Mover solo el
`.js` sin mover el `.ts` fuente rompe el contrato exacto que
`scripts/checkTsBuildDrift.js` verifica — y ese script existe precisamente
porque en la Sesión 3 alguien editó el `.js` a mano y nadie lo notó hasta
que una recompilación futura sobreescribió el fix. Se movieron también los
3 `.ts` (más `analytics.d.ts`, que `advancedRiskEngine.ts` importa) a las
mismas subcarpetas dentro de `server-types/`, se corrigieron sus imports
relativos, se recompiló con `tsc --outDir` a un directorio temporal, se
comparó byte a byte contra los `.js` movidos, y se sincronizó la única
diferencia real (`advancedRiskEngine.js`, que había recibido un fix de
rutas manual que no coincidía carácter por carácter con lo que genera
`tsc`). `npm run check:ts-drift` → **✅ sin drift, 6 archivos verificados**
(igual que la línea base).

**2.2 — Efecto colateral encontrado: el override de ESLint para estos 4
build artifacts (`no-var: off`) apuntaba a las rutas viejas.** Sin el
fix, `npx eslint server/` reportaba 18 errores `no-var` falsos en
`advancedRiskEngine.js`/`walletManager.js` (el output estándar de `tsc`
con `esModuleInterop` usa `var` para sus helpers de interop — no es un
problema real de calidad, es la forma esperada de código generado). Se
actualizaron las 4 rutas en `.eslintrc.cjs` a su nueva ubicación.

**2.3 — Documentación viva actualizada** (no los históricos
`CHANGELOG*.md`/`CHECKPOINT_0X.md`, que documentan el pasado tal como era):
`docs/Architecture.md`, `docs/ADR-013-...md`, `docs/CommitteeReadiness.md`,
`docs/ExecutionEngine.md`, `docs/JudgeGuide.md`,
`docs/RoadmapToProduction.md`, `README.md` y el árbol de directorios de
`docs/DeveloperGuide.md` — todas sus referencias a rutas planas
`domain/<archivo>.js` ahora apuntan a `domain/<categoría>/<archivo>.js`.

### Verificación completa (todo corrido de verdad, no asumido)

- `npx vitest run` → **94 archivos, 1566 tests, 0 fallos** (1552 base +
  14 nuevos de `routesAuthMiddleware.security.e2e.test.js`), 58s.
- `npx tsc --noEmit` → limpio.
- `npm run check:ts-drift` → sin drift, 6 archivos verificados.
- `npm run check:i18n` → paridad, 240 llaves.
- `npm run test:smoke` → 76/76.
- `npx eslint server/ src/ --ext .js,.jsx` → 0 errores, 0 warnings.
- `npm run build` → limpio; `ArbitragePage` chunk confirmado en 77.94 kB
  (20.21 kB gzip).

### Lo que queda pendiente de la hoja de ruta (no alcanzado esta sesión)

1. **Punto 1 — tipos de dominio únicos (`Opportunity`, `Trade`,
   `RiskContext`)** compartidos entre los 10+ motores. `opportunity.ts`
   ya existe como tipo compartido parcial, pero no todos los motores lo
   importan — cada uno sigue construyendo su propia forma del objeto.
   Es el ítem más caro de la lista; requiere revisar los ~17 archivos de
   `domain/engines/` uno por uno. Recomendado como punto de partida de la
   próxima sesión, ahora que viven en una carpeta propia y son más fáciles
   de listar/revisar en conjunto.
2. **Punto 7 — persistir snapshot completo de wallet en Mongo** (hoy
   `tenantStore`'s LRU de 1000 tenants resetea el wallet de un usuario
   inactivo desalojado sin aviso). Requiere diseño de esquema Mongoose +
   migración, no es mecánico — no se tocó por riesgo/alcance dado el
   tiempo restante de esta sesión.
3. **Punto 8 — unificar manejo de errores.** La jerarquía `DomainError` /
   `expressErrorHandler` (`server/domain/errors.js`) ya existe y ya está
   wireada en `server/index.js`, pero la mayoría de rutas individuales
   todavía arman su propio `{ok:false, error}` a mano en vez de lanzar
   `ValidationError`/`NotFoundError`/etc. Migrar rutas existentes una por
   una es de bajo riesgo pero alto volumen (decenas de archivos) — no se
   intentó esta sesión por no dejar un refactor a medias.
4. **Nota menor, no crítica:** la auditoría mencionaba 19 usos de
   `console.*` directo en `server/` "a pesar de que `no-console` está
   activo" — se verificó que `.eslintrc.cjs` en realidad ya tiene
   `no-console: 'off'` para `server/**/*.js` (comentario: "server usa
   logger estructurado, no console"), así que no hay violación de lint
   real hoy. Los usos existentes son casi todos helpers `_log`/`_warn`
   gateados por una constante `_DEBUG` local, no logging de producción sin
   control. Se dejó sin tocar esta sesión por ser de bajo impacto real
   frente a los otros 3 puntos pendientes.

### Estado de los 8 puntos de la hoja de ruta al cierre de esta sesión

| # | Punto | Estado |
|---|---|---|
| 1 | Tipos de dominio únicos | Pendiente |
| 2 | README desalineado | ✅ Ya estaba resuelto |
| 3 | Aplanar `domain/` en subcarpetas | ✅ Resuelto esta sesión |
| 4 | Auditar patrón `getHandler()` | ✅ Resuelto esta sesión (cobertura e2e agregada) |
| 5 | Code-splitting de `ArbitragePage` | ✅ Ya estaba resuelto |
| 6 | Vista de entrada canónica | ✅ Ya estaba resuelto |
| 7 | Persistir wallet snapshot en Mongo | Pendiente |
| 8 | Unificar manejo de errores | Pendiente (infraestructura lista, migración de rutas pendiente) |

5 de 8 puntos resueltos o ya resueltos, 3 pendientes documentados con
alcance claro para la próxima sesión.

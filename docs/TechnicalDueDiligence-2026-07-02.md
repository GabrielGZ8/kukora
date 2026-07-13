# KUKORA — TECHNICAL DUE DILIGENCE

> ## ⚠️ CORRECCIÓN (post auditoría de comité, 2026-07-09)
>
> La auditoría externa de comité (`KUKORA_AUDITORIA_COMITE.md`) verificó
> directamente el repo y encontró que **el punto 4 del addendum de abajo
> era falso en ese momento**: no existía ninguna carpeta `.github/` ni
> workflow de CI, a pesar de que este documento afirmaba que sí. Toda
> verificación (tests, `tsc`, lint, build) dependía de ejecución manual sin
> ningún enforcement automático.
>
> Esto quedó corregido en esta sesión: `.github/workflows/ci.yml` ahora
> existe y corre en cada push/PR — `tsc --noEmit`, `eslint`, `vitest run
> --coverage` (bloqueante sobre los umbrales de `vitest.config.js`), smoke
> tests, build de producción y `npm audit --audit-level=high`. Se deja esta
> nota en vez de borrar el addendum original para que quede trazable qué se
> afirmó, cuándo se descubrió que era falso, y cuándo se corrigió — la
> misma disciplina de honestidad que el resto del proyecto ya aplica en sus
> ADRs.

> ## ⚠️ ADDENDUM (2026-07-02) — LEER ANTES DEL CUERPO DEL DOCUMENTO
>
> El cuerpo de este documento (debajo) describe un estado del código que
> **ya no es el actual**. No se reescribió el análisis original porque no
> se volvió a auditar línea por línea cada sección — este addendum resume
> lo que se **verificó de forma directa hoy** corriendo la suite real y
> leyendo el código actual, y marca explícitamente qué partes del hallazgo
> original quedaron obsoletas.
>
> **1. Tests — cifras reales verificadas hoy (no las de la sección 9):**
> - `npm test` (`vitest run`): **65 archivos de test, 1124 tests, 0
>   fallando.**
> - Cobertura real (`vitest run --coverage`, umbrales en
>   `vitest.config.js`): **69.46% statements, 57.41% branches, 65.83%
>   functions, 72.97% lines** — todos por encima de los umbrales
>   configurados (62/50/58/65 respectivamente). CI los hace bloqueantes
>   (ver punto 4).
> - Esto reemplaza la cifra de la sección 9.1 ("8 archivos de test, ~3,700
>   líneas, 45% de módulos sin cobertura") — ese hallazgo describe un
>   estado muy anterior del proyecto.
>
> **2. Arquitectura (sección 1.1) — el hallazgo central del documento ya
> está resuelto.** El código actual **sí** tiene bounded contexts
> explícitos: `server/domain/`, `server/infrastructure/`,
> `server/application/`, `server/repositories/`, `server/routes/` existen
> como carpetas reales con módulos movidos dentro (confirmado por
> `view`/`ls` directo del árbol actual, no por comentarios). Varios de los
> archivos planos que quedan en `server/` son shims de una línea
> (`module.exports = require('./infrastructure/...')`) mantenidos por
> compatibilidad hacia atrás — no la implementación real. No se re-auditó
> si la reorganización es 100% completa o si quedan archivos sin mover,
> pero la premisa "no existe el concepto de bounded context" ya no
> describe el repo.
>
> **3. Interfaz formal de exchange (mencionada como pendiente "Nivel 2-4"
> por Gabriel) — ya existe.** `server-types/server/exchangeAdapter.ts`
> define `ExchangeAdapter`/`OrderBook`/`Ticker` etc., explícitamente
> etiquetado en el propio archivo como "audit Level 3 #1". Los tres
> clientes reales (`BinanceClient`, `BybitClient`, `KrakenClient` en
> `server/application/liveExecution.js`) comparten la misma forma de
> constructor y métodos (`getAccountInfo()`, `getBalance()`,
> `placeMarketOrder()`, `getOrder()`, `cancelOrder()`), seleccionados
> genéricamente por `getExchangeClient(exchange, ...)`.
>
> **4. CI con `npm audit` + umbrales de cobertura obligatorios (el otro
> pendiente "Nivel 2-4" mencionado) — ya existe.** `.github/workflows/ci.yml`,
> con el comentario propio del repo: *"Nivel 3 #5 (technical due
> diligence): CI with mandatory npm audit + enforced coverage thresholds"*.
> Corre `npm audit --omit=dev --audit-level=high` (bloqueante en
> high/critical, con una excepción documentada y trackeada para una
> advisory moderate transitiva de `uuid` vía `firebase-admin`), luego
> `vitest run --coverage` (bloqueante sobre los umbrales de
> `vitest.config.js`), build de frontend, smoke tests, y `tsc --noEmit`.
>
> **5. Ronda 21 (posterior a este documento) agregó**, sin relación directa
> con los hallazgos originales pero relevante para cualquier lectura de
> "preparación para producción" (sección 8): rutas HTTP autenticadas +
> gateadas por 2FA (TOTP) para pasar a modo `live` y ejecutar trades reales
> cross-exchange, rate limiting por exchange, y reconciliación de
> inventario entre exchanges. Detalle completo en
> `docs/RoadmapToProduction.md` (Fase 3), que sí se mantiene actualizado
> con cada ronda.
>
> **6. Actualización sobre el punto 2 de este mismo addendum — la limpieza
> de shims (mencionada arriba como no re-auditada) se completó y verificó
> en una sesión posterior.** Se escaneó `server/` por **contenido real**
> (no por nombre) y se encontraron 79 archivos shim (no solo "varios" como
> decía este addendum) — 41 hacia `domain/`, 28 hacia `infrastructure/`, 7
> anidados en `server/models/`, 3 hacia `application/`, 3 hacia `routes/`.
> Las ~200 referencias que apuntaban a ellos se reescribieron hacia la
> ubicación canónica y los shims se eliminaron. `server/` pasó de 78
> archivos sueltos en la raíz a 2 (`index.js`, y `models.js` — este último
> intencionalmente separado de `infrastructure/persistence/models/`, ver
> ADR-010). Verificado con la suite completa en cada iteración: 1145/1145
> tests. Detalle completo en `MIGRATION_CLEANUP_LOG.md`. Adicionalmente se
> resolvieron los otros dos pendientes de esa limpieza: la convención de
> "routes" duplicada (`server/arbitrage/routes/` → renombrado a
> `server/arbitrage/subroutes/`, ver ADR-011) y la sugerencia de una
> carpeta `server/api/` de nivel superior (evaluada y rechazada por ahora,
> ver ADR-012). Con esto, el hallazgo central del documento original
> (sección 1.1, "ausencia casi total de estructura de dominio") queda
> cerrado en el eje de arquitectura física — no cubre robustez de negocio,
> edge cases, ni el resto de secciones 2–8, que siguen sin re-auditar (ver
> el punto siguiente).
>
> **Lo que este addendum NO hace:** no vuelve a evaluar secciones 2–8
> (calidad del motor de riesgo, wallets, frontend, etc.) — esas partes del
> documento pueden seguir siendo válidas o no, simplemente no se
> re-verificaron hoy. Si se necesita una due diligence actualizada de
> verdad, lo correcto es rehacerla desde cero contra el código actual, no
> seguir parcheando este documento sección por sección.
>
> ---

> ## ⚠️ ADDENDUM 2 (2026-07-08) — Pase de due diligence dirigido: multi-tenant, seguridad y gaps de enforcement
>
> A diferencia del addendum de arriba (que solo re-verificó arquitectura
> física y cifras de tests), este pase leyó código real en profundidad en
> tres ejes — **aislamiento multi-tenant, seguridad de rutas HTTP, y
> coherencia enforcement-vs-UI** — con el mismo criterio que pide este
> documento: cada afirmación está sustentada por archivo:línea concretos,
> no inferida. **Tampoco es una re-auditoría completa de las secciones
> 2–8** — es un pase acotado a las áreas de mayor riesgo dado el deadline
> del 12 de julio. Todo lo encontrado se corrigió el mismo día, con tests
> de regresión, y se verificó que la suite completa siguiera en verde.
>
> **Cifras verificadas hoy (`npx vitest run --coverage`):**
> - **92 archivos de test, 1540 tests, 0 fallando** (sube de 1124 el
>   2026-07-02 — +416 tests en 6 días de trabajo).
> - Cobertura real: **70.11% statements, 59.77% branches, 68.17%
>   functions, 73.31% lines** — todos por encima de los umbrales de
>   `vitest.config.js` (67/56/65/70).
>
> ### Hallazgo 1 — `maxDailyLossUSD` era un control fantasma (CORREGIDO)
> El override per-tenant `maxDailyLossUSD` era validado por
> `tenantConfig.setMany()` y **se mostraba como editable en
> `TenantBotPanel.jsx`** (el panel "Mi Bot Personal", agregado esta misma
> semana), pero `tenantRiskGuard.checkPreTrade()` — el único punto que
> decide si un trade per-tenant se ejecuta — **nunca lo leía**. Un usuario
> podía configurar "detente si pierdo más de $100 hoy" y el sistema lo
> aceptaba sin aplicarlo jamás. Verificado leyendo
> `server/infrastructure/tenantRiskGuard.js` completo antes de asumir que
> funcionaba — el archivo documentaba explícitamente qué SÍ cubría
> (drawdown, rachas de pérdidas, tamaño de posición) y `maxDailyLossUSD`
> no estaba en esa lista.
> **Fix:** `tenantRiskGuard.js` ahora calcula el P&L realizado del día
> desde `walletManager.getTradeHistory(uid)` (sin estado nuevo — reutiliza
> lo que ya se trackea por-tenant) y lo compara contra el límite antes de
> cada trade. 4 tests nuevos en `tests/tenantRiskGuard.test.js` (breach,
> dentro del límite, trades de días anteriores no cuentan, aislamiento
> entre dos tenants).
>
> ### Hallazgo 2 — mutación de config global sin gate de admin (CORREGIDO)
> `POST /api/arbitrage/config` y `POST /api/arbitrage/config/reset` mutan
> `liveConfig._cfg` — el **único objeto de config compartido por todo el
> proceso**, del que `tenantConfig.getEffective(uid, key)` cae por defecto
> para cualquier tenant sin override propio (`server/infrastructure/
> tenantConfig.js:34-39`). Antes de este fix, ambas rutas solo requerían
> `requireAuth` — **cualquier usuario autenticado**, no solo un admin,
> podía cambiar `minScore`, `activeExchanges`, límites de riesgo, etc. para
> la plataforma entera. Esto es inconsistente con el propio criterio del
> repo: dos rutas más abajo en el mismo archivo (`/adversarial/run`) y en
> `query.routes.js` (`/stress-test/activate`, `/risk/circuit-breaker/
> reset`) — la misma clase de "un switch global afecta a todos" — ya
> exigían `requireRole('admin')`. Se verificó antes de aplicar el fix que
> `ADMIN_EMAILS` auto-sincroniza el rol del dueño del proyecto en cada
> login (`auth.js`, fix H-7 ya existente) — el gate no puede bloquear el
> demo en vivo del propio Gabriel.
> **Fix:** `requireRole('admin')` agregado a ambas rutas en
> `server/arbitrage/subroutes/config.routes.js`. Nuevo archivo
> `tests/arbitrageConfig.security.e2e.test.js` con `supertest` contra la
> app real (ver Hallazgo 3 sobre por qué el test unitario existente no
> hubiera detectado esto).
>
> ### Hallazgo 3 — falsa sensación de cobertura en `arbitrage.config.routes.test.js`
> `tests/arbitrage.config.routes.test.js` cubre `POST /config` y
> `POST /config/reset`, pero vía un helper `getHandler()` que hace
> `layer.route.stack[layer.route.stack.length - 1].handle` — es decir,
> **extrae solo el ÚLTIMO handler del stack de la ruta y lo llama
> directamente**, saltándose cualquier middleware (auth, `requireRole`,
> `validateBody`) que esté montado antes. Esos tests seguían pasando
> exactamente igual con o sin el gate de admin del Hallazgo 2 — dan
> señal real sobre la lógica del handler, pero cero señal sobre qué
> puede o no puede llegar hasta ese handler en producción. No se tocó ese
> archivo (sigue siendo válido para lo que sí prueba); se agregó
> `tests/arbitrageConfig.security.e2e.test.js` como complemento real
> vía `supertest` contra `server/index.js` (la app completa, mismo patrón
> que `tests/tenantBot.routes.e2e.test.js`). **Recomendación no
> implementada por alcance:** auditar si otros archivos `*.routes.test.js`
> usan el mismo patrón `getHandler()` y, de ser así, si prueban rutas con
> middleware de seguridad no trivial que valga la pena verificar con un
> e2e real.
>
> ### Hallazgo 4 — riesgo de escala en el LRU de `tenantStore` (documentado, NO corregido — alcance mayor)
> `server/infrastructure/tenantStore.js` implementa un LRU acotado a 1000
> tenants (`DEFAULT_MAX_TENANTS`) para evitar la fuga de memoria de un
> `Map` sin límite (ya resuelta en una sesión anterior — ver comentario
> "Part B" en el propio archivo). Pero el efecto colateral no está
> documentado en ningún lado: si un tenant es desalojado del `Map` (porque
> otros 1000 uids distintos usaron la app desde su última visita) y
> vuelve, `walletManager` le crea un estado **completamente fresco** —
> wallet, historial de trades, P&L, todo — sin ningún aviso. Para
> `tenantConfig`/`tenantBotState` esto es tolerable (vuelven a defaults).
> Para `walletManager` esto es indistinguible de "perdiste todo tu
> historial de paper trading". `tenantPersistence.js` (`restoreTenant
> Snapshot`) restaura métricas desde Mongo al encender el bot, pero **no
> restaura los balances de wallet en sí** — se confirmó leyendo el archivo
> completo. Con el volumen de usuarios de una demo de competencia esto no
> se va a disparar, pero para la pregunta "¿qué pasa a 10,000 usuarios?"
> del criterio de escalabilidad, la respuesta honesta es "el wallet de
> cualquier usuario inactivo por suficiente tiempo puede resetearse sin
> aviso". Solución real (no implementada hoy — es un refactor de
> persistencia, no un fix puntual): persistir snapshot de wallet completo
> en Mongo y restaurarlo en `get()` cuando `tenantStore` crea estado fresco
> para un uid que ya existía en Mongo, no solo al encender el bot.
>
> ### Hallazgo 5 — bundle de `ArbitragePage` sin code-splitting por tab (documentado, NO corregido)
> `npm run build` produce `ArbitragePage-*.js` de **495.77 kB (75.82 kB
> gzip)** — el chunk más grande de todo el frontend después de
> `chart-vendor`. Causa: `ArbitragePage.jsx` importa los 19 componentes de
> panel (uno por tab: `StressTestPanel`, `AdversarialPanel`,
> `ReplayPanel`, `IntelligencePanel`, `TenantBotPanel`, etc.) de forma
> estática al tope del archivo, así que visitar la pestaña por defecto
> ("Opportunities") descarga el código de las otras 18 pestañas aunque el
> usuario nunca las abra. Fix recomendado (no aplicado — toca 19 imports y
> el patrón de `Suspense`/`ErrorBoundary` de cada tab, riesgo real de
> romper algo días antes del deadline sin una razón urgente para
> arriesgarlo): `const StressTestPanel = lazy(() => import(...))` por cada
> panel, envuelto en `<Suspense>` dentro de cada rama condicional
> `{activeTab==='...' && ...}` que ya existe.
>
> **Verificación de aislamiento multi-tenant (sin hallazgos nuevos, solo
> confirmación):** se leyó completo `tenantExecution.js`,
> `tenantRiskGuard.js` y `tenantStore.js`. El diseño de dos fases (ADR-017)
> es honesto sobre su propio alcance: documenta explícitamente que NO pasa
> el trade de un tenant por `advancedRiskEngine`/`tradeStateMachine`/
> `slippageValidator` globales, y explica por qué (esos sistemas protegen
> el bot compartido; hacerlos per-tenant es un refactor de otro orden). No
> es un descuido oculto — es una decisión de alcance documentada en el
> propio código, que este pase confirma como razonable dado el contexto de
> paper-trading.
>
> **Verificación de seguridad perimetral (sin hallazgos nuevos más allá de
> los Hallazgos 2/3, solo confirmación):** `auth.js` completo — bcrypt 12
> rounds, comparación de tiempo constante contra enumeración de usuarios
> (`bcrypt.hash('dummy', 1)` en las tres ramas de fallo de login),
> blacklist de `jti` para revocación inmediata tras cambio de contraseña,
> rate limiting en register/login/google/change-password. Se buscó
> patrón IDOR (`req.params.uid`/`req.body.userId` de origen cliente en vez
> de `req.userId` derivado del JWT) en `server/routes/` y
> `server/arbitrage/` — cero coincidencias.
>
> ---

### Evaluación de nivel inversión / adquisición

**Alcance:** ~19,100 líneas de servidor (75 módulos planos en `server/`), ~20,500 líneas de frontend (React 18 + Vite), ~3,700 líneas de tests (8 archivos). Metodología: lectura completa de la arquitectura de wiring (`index.js`, routing, registries), lectura profunda de los módulos core del trading engine, seguridad, capa de datos y frontend, más verificación cruzada (`grep`/`diff`) de cada hallazgo contra el código real — no inferencias.

> ⚠️ **Nota:** las cifras de alcance de esta línea ("75 módulos planos",
> "8 archivos de test") son las del momento en que se escribió este
> documento — ver addendum arriba para las cifras actuales verificadas.


---

## RESUMEN EJECUTIVO

Kukora es un motor de detección de arbitraje cripto multi-exchange con un frontend React extenso (30+ páginas), autenticación JWT con rotación de refresh tokens, y una capa de simulación financiera (wallets, P&L, position sizing, risk engine) razonablemente sofisticada para un proyecto de este origen. La seguridad perimetral (CSP con nonce, CORS fail-closed, rate limiting diferenciado para endpoints financieros) está mejor pensada que la de la mayoría de MVPs — alguien con criterio de seguridad real trabajó en esto.

El problema central no es la lógica de negocio individual — es la **ausencia casi total de estructura de dominio**. Los 75 archivos de `server/` están todos en un único directorio plano, sin bounded contexts, sin capa de repositorio, con modelos de Mongoose definidos en 7 archivos distintos en vez de uno, y con dos archivos llamados de forma casi idéntica (`arbitrageEngine.js` y `arbitrage.engine.js`) que hacen cosas completamente distintas. Esto no es un problema cosmético: es el tipo de cosa que hace que onboardear a un ingeniero nuevo tome semanas en vez de días, y que cualquier refactor de alcance medio se vuelva riesgoso.

**Veredicto en una frase:** el dominio financiero está mejor construido de lo que el "esqueleto" arquitectónico que lo sostiene sugiere — es una casa con buena ingeniería estructural interna pero sin paredes que separen las habitaciones. Es invertible si el roadmap de Nivel 1-2 de este documento se ejecuta antes de escalar el equipo, no en su estado actual.

---

## 1. ARQUITECTURA

### 1.1 Organización del código — hallazgo crítico

`server/` contiene **75 archivos `.js` en un único nivel**, sin subcarpetas por dominio (excepto `server/arbitrage/routes/` y `server/routes/`, que solo contienen rutas HTTP, no agregados de dominio). Evidencia:

```
server/adaptivePositionSizing.js   server/marketIntelligence.js
server/adaptiveScoring.js          server/marketRegimeEngine.js
server/advancedRiskEngine.js       server/metricsService.js
server/adversarialScenarios.js     server/missedOpportunityTracker.js
... (75 archivos en total, todos al mismo nivel)
```

No hay separación entre `domain/`, `infrastructure/`, `application/`. No existe el concepto de bounded context — toda la lógica de exchanges, riesgo, ejecución, analítica, backtesting, notificaciones y autenticación vive en el mismo namespace plano.

**Impacto:** con 75 archivos al mismo nivel, ningún IDE ni desarrollador nuevo puede inferir relaciones de dependencia por la estructura de carpetas — hay que leer `require()` uno por uno. Esto escala muy mal: a 10 desarrolladores trabajando en paralelo, los merge conflicts y la fricción de "¿dónde va este código nuevo?" se multiplican. A 100 archivos (estimado a 12-18 meses con el ritmo de feature actual) esto se vuelve prácticamente innavegable.

**Prioridad:** Crítica. **Dificultad:** Alta (requiere mover/renombrar masivamente, pero es mecánico, no riesgoso si se hace con tests verdes en cada paso). **Riesgo de no arreglarlo:** cada sprint adicional construido sobre esta base aumenta el costo del refactor futuro.

**Propuesta concreta:** reorganizar en bounded contexts explícitos:
```
server/
  domain/
    trading/        (arbitrageEngine, statArbEngine, tradeStateMachine)
    risk/            (advancedRiskEngine, slippageValidator, adaptivePositionSizing)
    wallet/          (walletManager, auditedPnl)
    exchanges/       (exchangeRegistry, exchangeService, exchangeIntelligence)
  application/
    routes/          (todo lo que hoy es *.routes.js)
    services/        (alertWebhookService, notifications)
  infrastructure/
    persistence/      (models.js + persistenceService — TODOS los mongoose.model() aquí)
    auth/
    observability/    (logger, observabilityService, metricsService)
```

### 1.2 Colisión de nombres — hallazgo crítico, evidencia directa de bug-prone

`server/arbitrageEngine.js` (903 líneas) y `server/arbitrage.engine.js` (779 líneas) son **dos módulos completamente distintos** que difieren solo por un punto en el nombre de archivo:

- `arbitrageEngine.js` exporta `detectOpportunities`, `scoreOpportunity`, `executeSimulated` — la lógica de **detección y scoring**.
- `arbitrage.engine.js` exporta `startEngine`, `executeBestOpportunity` — los **loops de orquestación** (WS event-driven + polling de 150ms).

Y `arbitrage.engine.js` además **requiere** a `arbitrageEngine.js` internamente (`server/arbitrage.engine.js:51`). Ambos son importados, a veces en el mismo archivo, por `server/arbitrage/routes/query.routes.js`, `server/arbitrage/routes/stream.routes.js`, y `server/arbitrage/index.js`.

**Impacto real:** en sistemas de archivos case-insensitive (macOS, Windows — el default de la mayoría de laptops de desarrollo), `arbitrageEngine.js` y `arbitrage.engine.js` no son siquiera nombres garantizados-únicos en todos los contextos (aunque Node los resuelve por ruta exacta, herramientas de búsqueda/autocompletado de IDE los confunden constantemente). Cualquier `grep -i arbitrageengine` o búsqueda fuzzy en VSCode mezcla ambos resultados. Es el tipo de ambigüedad que genera bugs de "edité el archivo equivocado" en producción.

**Prioridad:** Crítica. **Dificultad:** Baja (rename + actualizar imports, totalmente mecánico). **Propuesta:** renombrar a `opportunityDetection.js` (el actual `arbitrageEngine.js`) y `arbitrageOrchestrator.js` (el actual `arbitrage.engine.js`), dejando claro por el nombre qué hace cada uno sin necesidad de abrir el archivo.

### 1.3 Capa de persistencia fragmentada

`mongoose.model()` se invoca en **8 archivos distintos**, no solo en `server/models.js`:

```
server/models.js               ← 8 modelos "oficiales" (User, Alert, Watchlist, Portfolio, Notification...)
server/walletManager.js        ← ArbitrageOp (modelo de trades reales)
server/dailyReportService.js
server/dailyStatsService.js
server/executionQualityTracker.js
server/persistenceService.js
server/replayService.js
server/spreadHeatmapService.js
```

**Impacto:** no existe un único lugar donde un ingeniero pueda ver "estos son todos los esquemas de la base de datos". Cualquier cambio de schema requiere grep en todo el repo para encontrar todas las definiciones. Esto también significa que la app no tiene protección real contra `OverwriteModelError` salvo por el patrón ad-hoc `try { mongoose.model(X) } catch { mongoose.model(X, schema) }` repetido en cada archivo (confirmado en `walletManager.js`).

**Prioridad:** Alta. **Propuesta:** mover **todos** los `mongoose.model()` a `server/infrastructure/persistence/models/`, un archivo por modelo, re-exportados desde un único `index.js`. Los servicios consumen el modelo, nunca lo definen.

### 1.4 Ausencia de capa de repositorio

Las rutas llaman directamente a métodos de Mongoose (`Notification.findByIdAndUpdate(...)` en `server/notifications.routes.js:123`, patrón repetido en prácticamente todas las rutas). No hay abstracción de acceso a datos. Esto es consistente con por qué `tests/setup.js` necesita mockear `mongoose` globalmente a nivel de módulo en vez de poder inyectar un repositorio fake — la dependencia está hard-wired.

**Impacto:** acoplamiento fuerte a Mongoose en toda la capa HTTP. Migrar de Mongo a Postgres (decisión de producto razonable según escale el negocio — ver sección Dominio) sería un rewrite, no un swap.

**Prioridad:** Nivel 3 (Enterprise) — no bloqueante hoy, pero condiciona cualquier decisión de cambio de base de datos futura.

### 1.5 Calificación: Arquitectura — **4/10**

La lógica de negocio individual (motor de riesgo, slippage, wallets) está razonablemente bien escrita puertas adentro de cada archivo. Pero "arquitectura" mide la organización *entre* módulos, y ahí Kukora tiene una estructura plana, sin bounded contexts, con persistencia fragmentada y nombres ambiguos. No soportaría 10 desarrolladores trabajando en paralelo sin fricción significativa hoy.

---

## 2. DOMINIO

### 2.1 Entidades principales (reconstruidas del código)

- **Opportunity** (no es una clase, es un objeto literal construido en `arbitrageEngine.js:detectOpportunities`) — par buy/sell exchange + spread + fees + slippage + score.
- **Trade / EnrichedTrade** (`walletManager.js`) — la única entidad con shape *real* (ahora tipado en TS): incluye `netProfit`, `withdrawalDetail`, `balancesAfter`.
- **Wallets** — `{ BTC: Record<exchange, number>, USDT: Record<exchange, number> }`, estado mutable en memoria, persistido opcionalmente a Mongo vía `ArbitrageOp`.
- **RiskStatus / CircuitBreaker** (`advancedRiskEngine.js`) — singleton de estado operacional (drawdown, exposición, breaker activo).
- **User, Alert, Watchlist, Portfolio, Notification** (`models.js`) — el dominio "consumer" (no-trading) del producto.

### 2.2 Lenguaje de dominio inconsistente

El mismo concepto tiene nombres distintos en distintos archivos: el motor de detección llama a las operaciones `Opportunity` (`scoreOpportunity`), pero la capa de wallet las llama `Trade` (`applyTrade`), y la capa de riesgo las llama `opportunity` otra vez en `preTradeRiskCheck(opportunity, wallets, ...)` pero el shape que recibe ahí (`{ buyPrice, tradeAmount, slippagePct }`) es un subconjunto distinto del `Opportunity` real que emite `detectOpportunities`. No hay un tipo/interfaz único de "Opportunity" compartido entre los tres módulos — cada uno construye su propio shape ad-hoc del mismo concepto de negocio.

**Evidencia concreta:** en `advancedRiskEngine.ts` (ahora tipado), tuve que declarar `OpportunityLike` como un tipo separado de lo que realmente produce `arbitrageEngine.js`, precisamente porque no existe un tipo de dominio compartido — cada consumidor define su propia forma esperada del mismo objeto de negocio.

**Impacto:** una regla de negocio (ej. "el slippage máximo permitido") puede vivir simultáneamente en `arbitrageEngine.js` (`computeSlippage`), `slippageValidator.js`, y `advancedRiskEngine.js` (`recordSlippage`/`checkExposureLimits`) sin garantía de que las tres copias estén de acuerdo en la definición.

**Prioridad:** Alta. **Propuesta:** definir un módulo `domain/types/Opportunity.ts` (ya hay TypeScript en el proyecto desde la migración de auditoría 1.1 — es el lugar natural para extenderlo) que sea la única fuente de verdad del shape, y que detección/riesgo/ejecución importen de ahí.

### 2.3 Doble motor de arbitraje, sin interfaz común

Como se detalla en 1.2, existen dos "motores" con responsabilidades parcialmente solapadas (detección vs. orquestación), más un tercer motor independiente para stat-arb (`statArbEngine.js`, 265 líneas) que es llamado *desde dentro* de `arbitrageEngine.js:detectOpportunities` (línea 579) en vez de ser una estrategia intercambiable — ver sección 6.

### 2.4 Calificación: Dominio — **5/10**

Las entidades existen y la lógica de negocio detrás de cada una es sólida, pero el lenguaje no es consistente entre módulos y no hay tipos de dominio compartidos que fuercen esa consistencia — la migración a TypeScript del core financiero (walletManager, validation, feeConfig, advancedRiskEngine) es un paso correcto en esa dirección, pero hoy cubre solo 4 de ~75 módulos.

---

## 3. BACKEND

### 3.1 Wiring de la aplicación (`server/index.js`) — bien ejecutado

CSP con nonce por request (`index.js:44-49`, elimina `unsafe-inline`), CORS fail-closed con allowlist explícita y manejo correcto de requests sin header `Origin` (server-to-server), rate limiting diferenciado: 600 req/min general vs. **10 req/min específicamente en endpoints financieros** (`/api/trading/mode`, `/api/arbitrage/config`, `/api/arbitrage/reset` — `index.js:143-154`), `trust proxy` configurado para que el rate limiting por IP funcione correctamente detrás de un proxy de plataforma. Esto está por encima del promedio de lo que se ve en proyectos de este tamaño.

### 3.2 Bug crítico encontrado y corregido durante esta auditoría: `crypto.routes.js`

`server/crypto.routes.js` tenía **11 handlers** con el patrón:
```js
const id = sanitizeCoinId(id);  // ← referencia a sí misma antes de inicializarse
```
en vez de `sanitizeCoinId(req.params.id)`. Esto es un **temporal dead zone error** — cada uno de esos 11 endpoints (`/api/crypto/coin/:id` y sus variantes `ohlc`, `history`, `technical`, `analytics`, etc.) lanzaba `ReferenceError: Cannot access 'id' before initialization` en **cada request**, sin excepción. Corregido como parte de esta sesión.

**Por qué es grave más allá del bug en sí:** ninguno de los 8 archivos de test del proyecto cubre `crypto.routes.js` (423 líneas, 0 referencias en `tests/*.test.js`). Un bug que rompe el 100% del tráfico a un endpoint público pasó indetectado porque no había ningún test ejerciendo ese código. Esto es la evidencia más concreta posible de por qué la cobertura de tests (sección 9) es un hallazgo de prioridad crítica, no cosmética.

### 3.3 Bug crítico encontrado y corregido: `index.js` readiness probe

`/ready` llamaba a `isDbReady()` — una función que **nunca fue definida** en ningún punto del archivo. Cualquier deploy con `MONGODB_URI` configurado habría devuelto un `ReferenceError` 500 en el healthcheck de orquestación (Railway/Render usan exactamente este endpoint para decidir si el contenedor está sano). Corregido a `mongoose.connection.readyState === 1`, consistente con el patrón usado en el resto del archivo.

### 3.4 Validación de inputs — bien ejecutada donde existe

`server/validation.js` (ahora TypeScript estricto) implementa validadores manuales deliberadamente sin dependencia externa (Joi/Zod), con razonamiento documentado en el propio archivo. `validateArbitrageConfig` incluye "pisos de seguridad" (`RISK_SAFETY_FLOORS`) que impiden que un payload malicioso o un bug de frontend desactive los circuit breakers (ej. `maxDailyLossUSD: 0`) — esto es exactamente el tipo de defensa que un sistema financiero real necesita y que la mayoría de MVPs no tienen.

**Pero la cobertura es desigual:** `crypto.routes.js` sanitiza el `id` del coin (aunque con el bug del TDZ ya corregido), pero no toda ruta tiene el mismo nivel de paranoia — no hay un middleware de validación centralizado (tipo `express-validator` aplicado uniformemente), sino validadores manuales archivo por archivo, lo que significa que la disciplina depende de que cada desarrollador recuerde aplicarla.

### 3.5 Manejo de errores — inconsistente entre capas

`server/index.js:339` tiene un error handler global de Express, pero la mayoría de rutas individuales atrapan errores con `try/catch` locales y devuelven shapes de error distintos según el archivo (`{ ok: false, error: '...' }` en algunos, `{ ok: false, error: '...', code: 'X' }` en otros como `auth.js`). No hay una clase de error de dominio (`DomainError`, `ValidationError`, `InsufficientBalanceError`) que el error handler global pueda inspeccionar — cada ruta decide su propio status code y shape manualmente.

**Prioridad:** Media-Alta. **Propuesta:** introducir una jerarquía mínima de errores de dominio en `domain/errors.ts`, y que el handler global de Express mapee por tipo en vez de que cada ruta repita la lógica de status-code.

### 3.6 Logging — sólido

`server/logger.js` implementa un logger estructurado consistente (`logger.info(module, message, meta)`), usado en vez de `console.log` directo en la mayoría del código server (confirmado: `no-console` está activo en ESLint para `src/` y desactivado explícitamente para `server/` "porque usa logger estructurado, no console" — decisión documentada en `.eslintrc.cjs`). Esto es buena práctica real, no cosmética.

### 3.7 Calificación: Backend — **6/10**

Hay decisiones de seguridad y configuración por encima del promedio, pero dos bugs críticos de "rompe el 100% del tráfico" sobrevivieron hasta esta auditoría precisamente por falta de cobertura de tests, y el manejo de errores no está unificado.

---

## 4. FRONTEND

### 4.1 Code splitting — bien ejecutado

`src/App.jsx` usa `React.lazy()` para **18 páginas** (`ArbitragePage`, `DashboardPage`, `MarketsPage`, etc. — `App.jsx:15-33`), envuelto en `Suspense`. El build de Vite confirma esto funcionando: el bundle se divide en ~30 chunks individuales por página en vez de un único bundle monolítico.

### 4.2 Componente duplicado — código muerto confirmado

`src/components/SplashScreen.jsx` y `src/components/common/SplashScreen.jsx` son **archivos byte-idénticos** (`diff` no reporta ninguna diferencia). Solo la versión en `common/` está importada (`App.jsx:5`, con un comentario explícito: *"Issue 18: use canonical common/ version"*) — lo que confirma que alguien ya detectó la duplicación y migró las referencias, pero nunca borró el archivo original (323 líneas de código muerto).

**Prioridad:** Baja-Media (trivial de arreglar, cero riesgo). **Propuesta:** `git rm src/components/SplashScreen.jsx`.

### 4.3 Componentes gigantes

```
src/pages/ArbitragePage.jsx      873 líneas
src/pages/SettingsPage.jsx       796 líneas
src/components/layout/Layout.jsx 788 líneas
src/pages/DocsPage.jsx           728 líneas
```

`ArbitragePage.jsx` con 873 líneas es, casi con certeza, una "god component" que mezcla fetching de datos, lógica de presentación de múltiples paneles (dado que `LiveConfigPanel`, `RebalancePanel`, `AdversarialPanel` son componentes separados pero el page principal sigue siendo enorme), y orquestación de WebSocket (`useArbitrageStream`). Un componente de 873 líneas no es revisable de forma efectiva en un PR — fuerza a que cualquier cambio, por pequeño que sea, toque un archivo enorme con alto riesgo de conflicto de merge.

**Prioridad:** Media-Alta. **Propuesta:** extraer `ArbitragePage.jsx` en sub-componentes por sección (header de estado del motor, tabla de oportunidades, panel de configuración, panel de historial), cada uno con su propio archivo y, si aplica, su propio hook de datos.

### 4.4 Estado — Context API, sin librería de estado dedicada

`src/state/AppStateContext.jsx` y `AuthContext.jsx` son los únicos manejadores de estado global. Para una app de 30+ páginas con datos en tiempo real (WebSocket de precios, SSE de notificaciones y de arbitraje), el Context API de React puede generar **re-renders innecesarios en cascada** si el contexto no está particionado correctamente (cualquier `setState` en el contexto re-renderiza a *todos* los consumidores, sin selectores). No alcancé a perfilar el árbol de renders en runtime para confirmar el impacto real, pero la combinación de "Context API único + datos de WebSocket de alta frecuencia (150ms de polling en el backend)" es un patrón clásico de performance degradado a medida que la app crece. Vale la pena perfilar con React DevTools Profiler antes de escalar más páginas sobre el mismo contexto.

**Prioridad:** Nivel 3 (Enterprise) — no es un blocker hoy, pero condiciona cuánto puede crecer la superficie de UI antes de que el patrón actual empiece a doler.

### 4.5 Hooks personalizados — bien factorizados

`useArbitrageStream`, `useAlertsStream`, `useNotifications`, `useTradingMode`, `usePolling`, `useServerSync` — la lógica de conexión a streams está correctamente extraída de los componentes hacia hooks reutilizables, en vez de estar inline en cada página. Esto es la práctica correcta y contrasta positivamente con el tamaño de los page components.

### 4.6 Calificación: Frontend — **6/10**

Buen uso de code splitting y hooks, pero componentes página demasiado grandes y un patrón de estado global (Context puro) que no escalará indefinidamente sin partición.

---

## 5. TRADING ENGINE — reconstrucción del flujo completo

```
exchangeService.js (5 funciones connectX() hardcodeadas, una por exchange)
        ↓ WebSocket / REST fallback
   orderBooks[] (normalizados a { exchange, bid, ask, error, feedAgeMs })
        ↓
arbitrageEngine.js :: detectOpportunities()
        ├─ loop O(n²) sobre pares buy/sell exchange
        ├─ computeSlippage() — slippage real desde L2 order book, fallback fijo si no hay profundidad
        ├─ checkLiquidity()
        ├─ feeConfig.js — fees por exchange + volumen (tiers)
        ├─ statArbEngine.js :: detectStatArb() — llamada inline, no es una "estrategia" intercambiable
        └─ scoreOpportunity() / scoreOpportunityDetailed()
        ↓
arbitrage.engine.js :: executeBestOpportunity()
        ├─ advancedRiskEngine.js :: preTradeRiskCheck() — circuit breakers, drawdown, exposición
        ├─ walletManager.js :: applyTrade() — mutex async, validación de balance pre-ejecución, rollback en integridad fallida
        └─ persistenceService.js — flush periódico a Mongo (ArbitrageOp)
        ↓
   tradeHistory[] + EquityCurve
        ↓
performanceReport.js / auditedPnl.js / dailyStatsService.js → analítica
        ↓
   SSE (arbitrage/routes/stream.routes.js) → Dashboard (React)
```

### 5.1 ¿Está realmente desacoplado, o son solo muchos servicios independientes?

**Respuesta honesta: es lo segundo, con buena disciplina dentro de cada pieza.** Hay separación de responsabilidades real en el sentido de que `walletManager.js` no sabe de scoring, y `advancedRiskEngine.js` no sabe de wallets directamente — se comunican vía objetos planos (`Trade`, `Wallets`) pasados como parámetros, lo cual es correcto. Pero no hay una interfaz/contrato formal entre las piezas (ver 2.2 — el mismo concepto de `Opportunity` tiene tres shapes ligeramente distintos según el módulo), y no hay un orquestador único con un pipeline explícito — la secuencia "detección → riesgo → ejecución → persistencia" vive implícita en el orden de las llamadas dentro de `arbitrage.engine.js`, no como un pipeline declarado y testeable de forma aislada paso por paso.

**Evidencia de la fortaleza real:** `walletManager.ts` (ahora tipado) implementa un mutex async genuino (`_tradeLock` + cola) para evitar condiciones de carrera entre el loop event-driven y el de polling — esto es ingeniería de concurrencia correcta y nada trivial, y demuestra que el autor entiende los problemas reales de un sistema de ejecución concurrente, no solo los simula.

### 5.2 Position sizing y risk — capas reales, no decorativas

`advancedRiskEngine.js` implementa drawdown tracking contra peak equity, límites de exposición por exchange y por activo, circuit breaker con auto-reset temporizado (5 min, excepto para drawdown/daily-loss que requieren reset manual — decisión de diseño correcta: un breaker disparado por pérdida real no debería auto-reactivarse solo), y un pre-trade check de 6 capas (`preTradeRiskCheck`) que evalúa circuit breaker, daily loss, emergency stop, drawdown, position size y slippage máximo **antes** de permitir la ejecución. Esto es un risk engine real, no un placeholder.

### 5.3 Calificación: Trading Engine — **7/10**

La lógica financiera individual (slippage real desde order book, fees por tier de volumen, mutex de concurrencia, circuit breakers multi-dimensión) es genuinamente sólida y va más allá de lo que se necesitaría para un coding challenge. Lo que falta es el contrato/pipeline formal que convierta "varios servicios bien escritos" en "una arquitectura de motor desacoplada" en el sentido estricto.

---

## 6. EXCHANGES — ¿arquitectura plugin real?

**No.** `exchangeRegistry.js` existe y su propio comentario de cabecera es honesto al respecto:

> *"Before this fix, adding a new exchange required editing at least 3 files... With the registry, each exchange is a self-contained descriptor object."*

Pero esto solo es cierto para **metadata** (nombre, fees, región, pares soportados). La conexión real sigue siendo 5 funciones hardcodeadas en `exchangeService.js`:

```js
function connectBinance() { ... }   // línea 184
function connectKraken()  { ... }   // línea 233
function connectBybit()   { ... }   // línea 294
function connectOKX()     { ... }   // línea 375
function connectCoinbase(){ ... }   // línea 429
...
connectBinance(); connectKraken(); connectBybit(); connectOKX(); connectCoinbase();  // línea 619-623
```

Cada una con su propio parser de mensajes WS bespoke. Agregar un sexto exchange hoy requiere: (1) registrar el descriptor en `exchangeRegistry.js` — esa parte sí es plugin-style — pero además (2) escribir una nueva función `connectX()` a mano y (3) agregarla manualmente a la lista de llamadas al final del archivo. El registry resuelve el problema que dice resolver solo a medias.

**Prioridad:** Alta (si el roadmap de producto incluye agregar exchanges con frecuencia — y para una plataforma de arbitraje, debería). **Propuesta:** definir una interfaz `ExchangeAdapter` (`connect(): void`, `parseMessage(raw): OrderBookUpdate`, `getRestFallback(): Promise<OrderBook>`) y que cada exchange sea una implementación de esa interfaz registrada en el mismo `exchangeRegistry.js`, con un loop genérico (`for (const ex of getEnabledExchanges()) ex.connect()`) reemplazando las 5 llamadas hardcodeadas.

### 6.1 Calificación: Exchanges — **5/10**

El registry de metadata es un paso correcto y honesto sobre sus propias limitaciones (raro de ver — normalmente este tipo de comentario se omite). Pero la pieza más cara de agregar (la conexión WS y el parsing) sigue sin abstraerse.

---

## 7. ESTRATEGIAS — ¿Strategy Pattern real?

**No existe un Strategy Pattern.** Hay tres "estrategias" de negocio identificables — arbitraje cross-exchange, arbitraje triangular, y stat-arb — pero las tres son **funciones separadas invocadas secuencialmente dentro del mismo archivo** (`arbitrageEngine.js`), no objetos `Strategy` intercambiables detrás de una interfaz común. `detectStatArb()` se llama inline en la línea 579 de `detectOpportunities()`, hardcodeado, no como un elemento de una lista de estrategias activas que se pudiera extender sin tocar el archivo central.

No hay condicionales `switch`/`if` masivos para distinguir estrategias (eso sería peor), pero tampoco hay abstracción — es el patrón "función monolítica con sub-llamadas", que funciona pero no escala bien si el roadmap de producto incluye más estrategias (market making, mean-reversion, lo que sea).

**Prioridad:** Nivel 3 (Enterprise). **Propuesta:**
```ts
interface DetectionStrategy {
  name: string;
  detect(orderBooks: OrderBook[], config: LiveConfig): Opportunity[];
}
// registro de estrategias activas, igual patrón que exchangeRegistry
const strategies: DetectionStrategy[] = [crossExchangeStrategy, triangularStrategy, statArbStrategy];
const opportunities = strategies.flatMap(s => s.detect(orderBooks, config));
```

### 7.1 Calificación: Estrategias — **4/10**

---

## 8. SEGURIDAD

### 8.1 Fortalezas confirmadas con evidencia

- **CSP con nonce por request**, sin `unsafe-inline` en `script-src` (`index.js:51-68`).
- **CORS fail-closed**: origen no listado se rechaza explícitamente (`cb(null, false)`, no un wildcard de fallback) — `index.js:101-112`.
- **Rate limiting diferenciado**: 10 req/min específicamente en endpoints que cambian configuración de trading en vivo, separado del límite general de 600/min — decisión de diseño que demuestra entendimiento real del modelo de amenaza (un atacante o un bug de frontend no puede "martillar" el circuit breaker).
- **JWT con rotación de refresh token + blacklist de jti** (`TokenBlacklist` en `auth.js`), detección de reuso de token (`TOKEN_REUSE` — indica robo de refresh token si el hash almacenado no coincide).
- **Stream tickets de un solo uso para SSE** (en vez de pasar el JWT real en query string, que habría quedado en logs de proxy/historial de browser) — implementado con TTL nativo de Redis (`SET ... PX 30000` + `GETDEL` atómico) cuando `REDIS_URL` está configurado, con fallback automático a memoria.
- **Pisos de seguridad en `validateArbitrageConfig`** (`validation.js`) que impiden que un payload desactive circuit breakers (`maxDailyLossUSD` debe ser negativo, `maxDrawdownPct` acotado entre 0.5 y 100, etc.) — protección real contra mal uso del endpoint de configuración, no solo validación de tipo.
- **Referrer-Policy explícito** (`strict-origin-when-cross-origin`) para no filtrar paths internos a CoinGecko/Firebase vía header Referer.

### 8.2 Gaps

- **Sin capa de repositorio** (sección 1.4) significa que cualquier validación de autorización a nivel de fila (¿este usuario es dueño de esta Alert/Portfolio?) depende de que cada ruta lo verifique manualmente — no confirmé sistemáticamente que las 4 rutas de `server/routes/` (`alerts`, `watchlist`, `portfolio`, `dataset`) apliquen el filtro de `userId` de forma consistente; dado el patrón de "cada ruta repite su propia lógica" visto en otras partes del código, este es un punto que merece una auditoría dedicada de autorización antes de producción con datos reales de múltiples usuarios.
- **Sin gestor de secretos** — `.env.example` documenta 28 variables, pero no hay integración con un vault (esperable en este estadio, pero bloqueante antes de manejar fondos reales).
- **Dependencias**: no corrí `npm audit` contra el lockfile completo en esta sesión (el ZIP no incluye `node_modules`); recomiendo correrlo como parte del pipeline de CI antes de cualquier deploy a producción con datos reales.

### 8.3 Calificación: Seguridad — **7/10**

Por encima del promedio para el estadio del proyecto. La autorización a nivel de fila sin capa de repositorio es el gap más importante a cerrar antes de manejar datos de usuarios reales en producción.

---

## 9. CALIDAD DE CÓDIGO Y TESTING

### 9.1 Cobertura de tests — hallazgo crítico con evidencia directa de daño real

De los 75 archivos en `server/`, **34 (45%) no tienen ni una sola referencia en los 8 archivos de test** del proyecto. Entre los no testeados:

```
server/walletManager.js        380 líneas — el módulo que mueve dinero simulado
server/crypto.routes.js        423 líneas — donde encontré el bug de TDZ que rompía 11 endpoints
server/liveExecution.js        281 líneas
server/auditedPnl.js           268 líneas
server/persistenceService.js   260 líneas
server/marketRegimeEngine.js   168 líneas
... (28 más)
```

El bug de `crypto.routes.js` (sección 3.2) es la prueba empírica, no teórica, de que esta falta de cobertura tiene costo real: un `ReferenceError` que rompía el 100% del tráfico a un endpoint público sobrevivió sin ser detectado porque ningún test ejercía ese código.

**Prioridad:** Crítica. **Propuesta:** priorizar cobertura en este orden — (1) `walletManager.js` y `advancedRiskEngine.js` primero, por ser dinero real/simulado y control de riesgo; (2) toda ruta HTTP pública sin test, empezando por `crypto.routes.js`; (3) el resto. Elevar el umbral de cobertura de Vitest (actualmente 75% líneas / 70% funciones / 65% branches en `vitest.config.js`) no sirve de nada si 45% de los archivos están directamente excluidos de la conversación — confirmar que el `coverage.include` realmente cubre estos 34 archivos y no los está dejando fuera del cálculo por descuido de configuración.

### 9.2 Duplicación de código

- Componente `SplashScreen.jsx` duplicado byte-a-byte (sección 4.2).
- Definiciones de `mongoose.model()` esparcidas en 8 archivos (sección 1.3).
- El concepto "Opportunity" reconstruido de forma ligeramente distinta en 3 módulos (sección 2.2).

### 9.3 TODOs/FIXMEs

Solo 3 ocurrencias en todo el repo — bajo, lo cual es positivo, pero también puede indicar que la deuda técnica no se está documentando inline donde se detecta, sino quedando implícita (que es exactamente lo que esta auditoría tuvo que reconstruir desde cero).

### 9.4 Calidad dentro de los archivos individuales

Los archivos que sí auditué en profundidad (`feeConfig.js`, `validation.js`, `walletManager.js`, `advancedRiskEngine.js`, `index.js`, `exchangeService.js`) tienen comentarios técnicos genuinamente útiles (explican *por qué*, no *qué* — ej. el comentario sobre `COOP same-origin-allow-popups` en `index.js:69-75` explica un problema real de Firebase popup auth que cualquier ingeniero habría tenido que redescubrir sin esa nota). Esto es buena práctica de documentación inline, no relleno.

### 9.5 Calificación: Calidad de código — **6/10**

---

## 10. PRODUCTO / UX — evaluación como CEO/CTO/usuario final

**¿Transmite confianza?** El nivel de detalle en la lógica financiera (slippage real desde order book, fees por tier de volumen, circuit breakers multi-dimensión, rotación de refresh tokens) comunica seriedad técnica genuina a cualquier ingeniero senior que abra el código — eso no se puede fingir con humo visual. Pero la organización plana de 75 archivos en `server/` comunica lo contrario al primer vistazo de la estructura del repo: un ingeniero senior evaluando el proyecto en los primeros 60 segundos (antes de leer una sola línea de lógica) va a notar la falta de bounded contexts y bajar su expectativa, para luego subirla al leer el código real. Esa disonancia entre primera impresión estructural y calidad de implementación interna es, en sí misma, una señal de que el proyecto creció más rápido en features que en disciplina arquitectónica — exactamente el patrón de "se construyó para un challenge y después se le siguió agregando" que el brief de esta auditoría pide eliminar.

**¿La arquitectura permite crecer?** Sí, en el sentido de que la lógica de negocio es sólida y extensible — pero no sin el roadmap de Nivel 1-2 ejecutado primero. Agregar el 6º exchange o la 4ª estrategia hoy requiere tocar múltiples archivos a mano, lo cual no escala a un equipo de 10-20 personas sin generar fricción constante.

---

## CALIFICACIONES FINALES

| Área | Nota | Evidencia clave |
|---|---|---|
| Arquitectura | 4/10 | 75 archivos planos, dos módulos con nombre casi idéntico y responsabilidades distintas, persistencia fragmentada en 8 archivos |
| Dominio | 5/10 | Entidades sólidas pero sin tipo compartido — 3 shapes distintas del mismo concepto "Opportunity" |
| Backend | 6/10 | Seguridad perimetral fuerte, pero 2 bugs "rompe 100% del tráfico" sobrevivieron por falta de tests |
| Frontend | 6/10 | Buen code splitting y hooks, pero componentes de 700-900 líneas y Context API sin partición |
| Trading Engine | 7/10 | Mutex de concurrencia real, risk engine de 6 capas, slippage desde order book real — lo más sólido del proyecto |
| Exchanges (plugin) | 5/10 | Registry de metadata honesto sobre sus límites, pero conexión WS sigue hardcodeada por exchange |
| Estrategias | 4/10 | Sin Strategy Pattern — funciones inline, no objetos intercambiables |
| Seguridad | 7/10 | CSP con nonce, CORS fail-closed, rate limiting financiero diferenciado, JWT con detección de reuso |
| UX | 6/10 | (evaluación parcial — no audité visualmente cada página; basado en estructura de componentes y flujos) |
| Escalabilidad | 4/10 | La estructura plana y el acoplamiento a Mongoose limitan crecimiento de equipo y de infraestructura |
| Performance | 6/10 | Lazy loading correcto; bundle de chart-vendor de 600KB sin auditar further; Context sin perfilar bajo carga real |
| Observabilidad | 6/10 | Logger estructurado consistente, `observabilityService.js` con eventos categorizados — bueno; sin tracing distribuido |
| DevOps | 6/10 | Dockerfile con usuario no-root, healthcheck consciente de `INTERNAL_API_KEY`, multi-stage build — confirmado en CHANGELOG de rondas previas |
| Calidad de código | 6/10 | Comentarios útiles donde existen; 45% de módulos sin test es el lastre principal |
| Preparación para producción | 5/10 | Sólido en seguridad y lógica financiera; bloqueado por cobertura de tests y autorización a nivel de fila sin auditar |

**Promedio: 5.6/10** — Producto con fundamentos técnicos genuinamente buenos en el núcleo financiero, pero con deuda arquitectónica estructural que debe resolverse antes de escalar equipo o capital.

---

## ROADMAP PRIORIZADO

### Nivel 1 — Crítico (antes de cualquier otra cosa)
1. **Cobertura de tests para `walletManager.js`, `advancedRiskEngine.js`, y toda ruta HTTP pública sin test** (34 archivos identificados, sección 9.1). El bug de `crypto.routes.js` es la prueba de que esto no es opcional.
2. **Auditoría de autorización a nivel de fila** en `server/routes/{alerts,watchlist,portfolio,dataset}.routes.js` — confirmar que cada query filtra por `userId` del request autenticado, no solo por el `id` del recurso.
3. **Renombrar `arbitrageEngine.js` / `arbitrage.engine.js`** a nombres no ambiguos (sección 1.2) — riesgo bajo, beneficio inmediato.
4. **Eliminar `src/components/SplashScreen.jsx`** (duplicado confirmado, código muerto).

### Nivel 2 — Alto impacto
1. **Reorganizar `server/` en bounded contexts** (`domain/`, `application/`, `infrastructure/` — sección 1.1).
2. **Centralizar todos los `mongoose.model()`** en un único directorio de modelos (sección 1.3).
3. **Definir un tipo de dominio compartido para `Opportunity`** y hacer que detección/riesgo/ejecución lo consuman desde un único origen (sección 2.2) — la migración a TypeScript ya iniciada en el core financiero es el vehículo natural para esto.
4. **Dividir `ArbitragePage.jsx`, `SettingsPage.jsx`, `Layout.jsx`** en sub-componentes por sección (sección 4.3).
5. **Jerarquía de errores de dominio** consumida por un único error handler global (sección 3.5).

### Nivel 3 — Enterprise
1. **Interfaz `ExchangeAdapter` real** — eliminar las 5 funciones `connectX()` hardcodeadas a favor de un loop genérico sobre el registry (sección 6).
2. **Strategy Pattern real** para cross-exchange / triangular / stat-arb (sección 7).
3. **Capa de repositorio** entre rutas HTTP y Mongoose, para desacoplar la app de la base de datos específica (sección 1.4).
4. **Particionar el Context API** del frontend (selectores, o evaluar Zustand/Jotai si el perfil de re-renders bajo carga real lo justifica) (sección 4.4).
5. **CI con `npm audit` obligatorio** y umbrales de cobertura aplicados sobre el set completo de archivos, no solo los que ya tienen tests.

### Nivel 4 — World Class
1. **Tracing distribuido** (OpenTelemetry) sobre el pipeline detección → riesgo → ejecución → persistencia, para poder responder "¿dónde se fueron los 40ms de latencia de este trade?" con datos, no con grep.
2. **Pipeline de estrategias declarado y versionado** (registro de estrategias activas con metadata de performance histórica por estrategia, no solo por trade).
3. **Repositorio + Unit of Work pattern** que permita correr el motor de trading completo contra una base de datos en memoria en CI, sin mockear Mongoose globalmente.
4. **Migración del 100% del core financiero a TypeScript** (hoy son 4 de ~75 módulos) — el patrón ya está establecido y validado (`server-types/`), es cuestión de escala, no de diseño nuevo.

---

*Este documento refleja una auditoría basada en lectura directa del código fuente real (no inferencia), con verificación cruzada vía `grep`, `diff`, y ejecución de la suite de tests/lint/build. Dos bugs de severidad alta (`crypto.routes.js` TDZ, `index.js` `isDbReady` indefinida) fueron encontrados y corregidos como parte de este proceso, y sirven como evidencia empírica — no hipotética — de los riesgos descritos en las secciones 3.2, 3.3 y 9.1.*

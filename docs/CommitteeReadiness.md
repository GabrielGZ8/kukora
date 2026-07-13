# Committee Readiness — Fase Final (Coding Challenge México)

> **Nota (2026-07-08, due diligence):** la cifra de la Sección 6
> ("80 archivos de test, 1375 tests") quedó desactualizada — verificado
> hoy con `npx vitest run --coverage`: **92 archivos de test, 1540 tests,
> 0 fallando**, cobertura 70.11%/59.77%/68.17%/73.31%
> (statements/branches/functions/lines), todos por encima de los umbrales
> de `vitest.config.js`. El resto de este documento (mapeo respuesta→código
> por sección 1-5) no se re-verificó línea por línea en este pase — ver
> `docs/TechnicalDueDiligence-2026-07-02.md` (Addendum 2) para el detalle
> de lo que sí se auditó a fondo hoy.

Este documento mapea, **respuesta por respuesta**, lo que se dijo al comité en
la Fase 1 contra la ubicación exacta en el código que lo implementa hoy. El
objetivo es que puedas navegar en vivo sin buscar, y saber con precisión
dónde el código respalda la respuesta al 100%, y dónde la respuesta original
fue más ambiciosa que la implementación — para no repetir esa distancia en
la videollamada.

Generado como parte de la auditoría de consistencia de Sesión 30. Cada
afirmación de este documento fue verificada leyendo el código, no asumida.

---

## 1. Partial fills en 3 tramos (>80% / 50-80% / <50%)

**Lo que dijiste:** manejo partial fills en 3 tramos — >80% acepta el fill
parcial y registra slippage adicional; 50-80% completa el resto con una
orden market inmediata; <50% cierra la pierna ejecutada de inmediato como
pérdida controlada.

**ACTUALIZACIÓN (post Sesión 30): implementado tal cual, de verdad — ya no
es un umbral único.** El sistema real ahora tiene los 3 tramos exactos que
describiste, con dos umbrales configurables en `liveConfig`
(`minimumFillRatio` = 0.50, `highFillRatioThreshold` = 0.80):

- `server/domain/analytics/tradeStateMachine.js` — `classifyFillTier(fillRatio)`
  clasifica en `'high'` (≥0.80), `'mid'` (0.50–0.80) o `'low'` (<0.50).
  `evaluatePartialFill()` usa esa clasificación para devolver `continue`
  (tier high — acepta el fill parcial), `hedge` (tier mid — completa el
  residual con market inmediata) o `close_immediately` (tier low — cierra
  la pierna ejecutada ahora como pérdida controlada), salvo que el residual
  sea menor a `minimumTransferAmount`, en cuyo caso no hay nada accionable
  y se cancela.
- `server/application/liveExecution.js` — `executeCrossExchangeLive()` ya
  no trata cada pata como fill-or-fail binario. `_placeAndConfirm()` ahora
  captura la cantidad y precio de un fill parcial genuino en lugar de
  descartarlos, y el motor de ejecución calcula la **exposición neta**
  (`buyQty - sellQty`) en vez de asumir que toda la pata llena quedó
  expuesta. Esto también corrigió un bug real: antes, si la pata de venta
  se llenaba solo parcialmente, el código aplanaba (`_emergencyFlatten`) la
  **cantidad completa** de la pata de compra — sobre-cubriendo la porción
  que la venta parcial ya había cubierto. Ahora solo aplana el residuo no
  cubierto.
  - Tier `high`: exposición residual pequeña, se aplana igual (sigue
    siendo dinero real sin cubrir) pero sin intentar completar nada más.
  - Tier `mid`: intenta **una** orden market inmediata para completar el
    residuo antes de recurrir a aplanar — si esa orden se llena, el trade
    se reporta como éxito a tamaño completo con precio de venta/compra
    ponderado (`residualCompleted: true`, `partialTier: 'mid'`).
  - Tier `low`: aplana el residuo de inmediato como pérdida controlada, sin
    intentar completarlo — igual que antes, pero ahora con la cantidad
    correcta (el residuo, no el total).
- `server/infrastructure/liveConfig.js` — `highFillRatioThreshold` (0.80)
  se agregó junto al ya existente `minimumFillRatio` (0.50), ambos
  hot-reloadable desde la UI, con schema propio.

Tests dedicados: `tests/tradeStateMachine.test.js` (`classifyFillTier` +
`evaluatePartialFill` en los 3 tramos) y
`tests/liveExecutionCrossExchange.test.js` (dos escenarios de fill parcial
genuino con mocks de Binance/Bybit: uno tier `low` que verifica que solo se
aplana el residuo — no el total — y uno tier `mid` que verifica la orden de
completado y el resultado exitoso a tamaño completo).

**Qué responder si te preguntan esto en vivo:** el sistema de 3 tramos
existe y está probado con los umbrales exactos que describiste (80%/50%),
incluyendo la corrección de un bug de sobre-cobertura que solo se
manifiesta con fills parciales genuinos — no simulados. Puedes mostrar
`classifyFillTier` y los dos tests de `liveExecutionCrossExchange.test.js`
en vivo si te piden profundizar.

---

## 2. Rebalanceo: umbral reactivo (~20%) + capa predictiva por sesgo direccional

**Lo que dijiste:** rebalanceo reactivo ~20% del capital asignado + capa
predictiva que detecta si un exchange ha sido consistentemente
comprador/vendedor en las últimas N ejecuciones.

**Lo que el código hace — VEREDICTO: la capa predictiva SÍ coincide
exactamente. El umbral reactivo es compatible, pero mide otra cosa
("concentración", no "caída de 20%").**

- `server/domain/engines/rebalanceEngine.js:78` — `analyzeBalance()` lee
  `liveConfig.get('rebalanceThresholdPct')` (default `0.70`) como
  **concentración máxima de USDT en un solo exchange**, no como "caída de
  20%". El propio schema lo documenta como `'USDT concentration trigger'`
  (`liveConfig.js:285`). Tu propia intuición en la respuesta al comité
  ("puede referirse a concentración, no a caída") era correcta.
- `server/domain/analytics/directionalBiasTracker.js:46,91` —
  `computeBias()` / `getBiasSignals()`. Esto **es exactamente** el
  mecanismo que describiste: ventana de las últimas N ejecuciones (default
  20, `DEFAULT_WINDOW`), clasifica cada exchange como `buyer`/`seller`/
  `neutral` según cuántas veces fue el lado de compra vs venta, y expone
  señales cuando el sesgo es consistente (`|biasScore| >= 0.7` con al menos
  8 muestras). Está conectado al flujo real en
  `server/application/liveInventoryReconciliation.js:133`.
- `server/domain/engines/predictiveRebalance.js:64,110` — capa adicional distinta
  (consumo/depleción de balance por tasa observada), complementaria al
  sesgo direccional, no contradictoria.

**No se necesitó ningún cambio de código aquí** — la capa predictiva ya
existía completa y conectada de una sesión anterior. Verificado, no
asumido.

---

## 3. Costo acumulado de rebalanceo como % de ganancias (alerta 15-20%)

**Lo que dijiste:** monitoreo el costo acumulado de rebalanceo como % de
las ganancias del período, y si supera 15-20% es señal de alerta.

**Veredicto antes de esta sesión: NO EXISTÍA.** `rebalanceEngine.js`
trackeaba `totalFeesSpent` (el numerador), pero no había ratio contra
profit ni umbral de alerta en ningún lado del código.

**Implementado esta sesión** — `server/domain/engines/rebalanceEngine.js:326`,
`getRebalanceCostRatio()`:
- Lee `totalFeesSpent` del historial real de rebalanceos.
- Lee `realizedPnl` en vivo de `walletManager.getPnL()` (misma fuente de
  verdad que el resto de la app).
- Umbral de alerta configurable vía `liveConfig.get('rebalanceCostAlertPct')`
  (default `18`, dentro de tu rango 15-20 — ver `liveConfig.js`).
- Devuelve `{ totalRebalanceCostUSD, periodRealizedPnlUSD, ratioPct,
  alertThresholdPct, alert }`. Si aún no hay profit realizado, `ratioPct`
  es `null` (no `0`) para no sugerir falsamente que rebalancear es gratis.
- Integrado en `getRebalanceSummary()` (usado por
  `GET /api/arbitrage/rebalance/history`) bajo la clave `costRatio`.
- Badge visual agregado en `src/components/common/RebalancePanel.jsx` que
  muestra el ratio y se pone en alerta (rojo) cuando se cruza el umbral.

**Test suite:** `tests/rebalance.test.js` y `tests/capitalEfficiency.test.js`
siguen en verde. **ACTUALIZACIÓN (post Sesión 30):** se agregó
`tests/rebalanceCostRatio.test.js` — 7 tests dedicados que cubren
exactamente los casos que quedaron pendientes: `ratioPct` null con profit
cero, `ratioPct` null con profit negativo, el cálculo `totalCost /
realizedPnl * 100` en un caso normal, el cruce exacto del umbral de alerta
(con umbral default y con uno custom vía `liveConfig.setMany`), acumulación
de costo a través de múltiples eventos de rebalanceo en el mismo período, y
que `getRebalanceSummary().costRatio` expone exactamente los mismos valores
que `getRebalanceCostRatio()` directamente.

---

## 4. Selección de activos: "elegiría XRP/LTC/SOL/LINK antes que BTC/ETH puro"

**Lo que dijiste:** en un entorno real elegirías XRP, LTC, SOL o LINK antes
que BTC/ETH puro, por liquidez fragmentada y persistencia de la
ineficiencia. Hoy Kukora opera BTC/ETH.

**Lo que encontré — dos capas con madurez muy distinta:**

- `server/domain/analytics/multiPairService.js:15` — `SUPPORTED_PAIRS` **ya incluye
  XRP/USDT** (junto con SOL/USDT y BNB/USDT) con mapeo completo de símbolo
  por exchange (Binance, Kraken, Bybit, Coinbase, OKX) y límites de trade
  amount. Esta capa de configuración está lista y probada
  (`tests/multiPairService.test.js`, 17 tests, todos pasan).
- **Pero** el pipeline real de detección/ejecución/wallets está codificado
  a solo BTC/ETH:
  - `server/domain/engines/opportunityDetection.js:711` —
    `const asset = opportunity.asset === 'ETH' ? 'ETH' : 'BTC';` — si se
    seleccionara XRP hoy, esta línea lo trataría silenciosamente **como
    BTC**, exponiendo el bot al activo equivocado.
  - `server/domain/wallet/walletManager.js:204` — el mismo patrón binario
    BTC/ETH, y los wallets iniciales (`INITIAL_BALANCES`) solo tienen
    buckets `BTC`/`ETH`/`USDT` — no hay bucket XRP.
  - El P&L, el rebalanceo, y los feeds de order book en vivo también
    asumen BTC/ETH en varios puntos.

**Qué decidí y por qué no lo implementé completo:** conectar XRP de
verdad requiere tocar wallets, ruteo de asset en ejecución, P&L, y feeds
de L2 por exchange — no es una extensión de 5 minutos, es un cambio
transversal con superficie de riesgo real, a días de la entrega. Forzarlo
ahora sin poder probarlo a fondo es exactamente el tipo de decisión que la
robustez (criterio #2) penaliza.

**Qué responder al comité:** sé preciso y muestra las dos capas por
separado — es una respuesta que demuestra más madurez que fingir que XRP
ya opera:

> "La capa de configuración para XRP/USDT ya existe completa —
> `multiPairService.SUPPORTED_PAIRS`, con mapeo de símbolo por cada uno de
> los 5 exchanges. Lo que falta es conectar esa configuración al pipeline
> de ejecución real (wallets, P&L, ruteo de asset), que hoy está
> codificado a BTC/ETH en 2-3 puntos específicos que ya identifiqué. No lo
> apuré esta semana a propósito: es un cambio transversal y prefiero
> entregar BTC/ETH sólido y probado que un tercer par a medio conectar el
> día de la demo."

---

## 5. Profundidad y parametrización — constantes que pasaron a ser hot-reloadable

Antes de esta sesión, además de los ~32 parámetros ya expuestos, existían
**constantes de estrategia core hardcodeadas** en el dominio, invisibles
para `liveConfig` y para la UI:

| Antes (constante fija) | Archivo | Ahora (liveConfig, hot-reload) |
|---|---|---|
| `LIQUIDITY_MIN_FILL = 0.50` | `opportunityDetection.js` | `liquidityMinFillPct` |
| `SCORE_WEIGHTS` (profit 35 / liquidity 20 / persistence 15 / latency 15 / confidence 10) | `opportunityDetection.js` | `detailedScoreWeights` — y ahora escala de verdad la fórmula de cada componente, no solo la etiqueta del breakdown |
| `WINDOW_SIZE = 120` | `statArbEngine.js` | `statArbWindowSize` |
| `EWMA_LAMBDA = 0.94` | `statArbEngine.js` | `statArbEwmaLambda` |
| `Z_THRESHOLD = 2.0` | `statArbEngine.js` | `statArbZThreshold` |
| `Z_STRONG = 2.5` | `statArbEngine.js` | `statArbZStrong` |
| `MIN_SAMPLES = 30` | `statArbEngine.js` | `statArbMinSamples` |
| `MAX_HALF_LIFE = 200` | `statArbEngine.js` | `statArbMaxHalfLife` |

Todos los valores por defecto se mantuvieron idénticos — es un cambio de
parametrización puro, sin cambio de comportamiento hasta que alguien mueva
un slider en la UI. `statArbEngine.js` exporta `Z_THRESHOLD`, `Z_STRONG`,
`MAX_HALF_LIFE`, `EWMA_LAMBDA` como *live getters* (no snapshots), así que
código y tests que ya leían esas propiedades siguen funcionando sin
cambios — verificado con la suite completa de `tests/statArbEngine.test.js`.

**Nota honesta:** durante la auditoría noté que `liveConfig.scoringWeights`
(usado por `mlScoringPipeline.js`, un modelo de scoring ML separado) y el
nuevo `detailedScoreWeights` (usado por `scoreOpportunityDetailed`, el
score determinístico 0-100) son **dos sistemas de scoring distintos que
coexisten intencionalmente** — no es una duplicación accidental, pero si
el comité pregunta "¿cómo se calcula el score?", ten claro cuál de los dos
estás mostrando en pantalla en ese momento.

---

## 5b. Smart Order Router (IOC / Post-Only), cifrado de API keys en reposo, y predicción de liquidez (beta)

Estos tres no eran parte de la Fase 1 original — salieron de un ejercicio
de auditar Kukora contra una lista genérica de "qué tiene un bot
profesional". Se implementaron en una sesión de seguimiento porque cerraban
gaps reales, no por completitud cosmética.

**Smart Order Router** (`server/domain/engines/smartOrderRouter.js`) — hasta ahora
Kukora solo enviaba órdenes MARKET. Ahora existen 3 políticas
(`liveConfig.orderExecutionPolicy`, default `market_taker` — comportamiento
anterior sin cambios):
- `ioc_protected`: LIMIT con `timeInForce=IOC` a un precio protegido por
  `maxSlippagePct` — toma inmediatamente pero nunca a un precio peor al
  tolerado, y cancela el resto en vez de dejarlo en el libro.
- `post_only_maker`: `LIMIT_MAKER`/`PostOnly` — nunca toma, solo aporta
  liquidez. Con un guardrail explícito: nunca se usa en la pata urgente de
  un arbitraje cross-exchange (podría no llenarse nunca y dejar la otra
  pata desnuda), solo en entradas de una sola pata sin urgencia.
- Implementado en los 3 exchange clients (Binance, Bybit, Kraken) vía un
  método `placeOrder()` genérico, y conectado en `executeCrossExchangeLive`
  usando el precio de la oportunidad como referencia.
- Tests: `tests/smartOrderRouter.test.js` (10 tests de la lógica de
  decisión) + un test de integración end-to-end en
  `tests/liveExecutionCrossExchange.test.js` que confirma que con
  `ioc_protected` sí se envía `LIMIT_IOC` con el precio protegido correcto,
  no un market order.

**Cifrado de API keys en reposo** (`server/infrastructure/secretsVault.js`)
— antes las keys vivían exclusivamente en variables de entorno planas.
Ahora hay un vault opcional con AES-256-GCM (IV aleatorio por secreto, auth
tag verificado en cada `decrypt` — una manipulación del archivo se detecta,
no se acepta en silencio). `getCredentials()` prueba primero el vault
cifrado y cae a las variables de entorno si no hay nada vaulted — ningún
despliegue existente se rompe. La master key viene de `KUKORA_MASTER_KEY`
(64 hex = 32 bytes, `openssl rand -hex 32`); en producción el vault se
niega a arrancar sin ella. Honestidad para el jurado: esto no es un
reemplazo de Vault/KMS — la master key sigue viviendo en una variable de
entorno, el mismo problema de bootstrap que tiene cualquier cifrado
simétrico sin raíz de confianza en hardware. Lo que sí resuelve: las keys
ya no están en texto plano en disco. Tests: `tests/secretsVault.test.js`
(14 tests: round-trip, detección de manipulación, prioridad vault-sobre-env,
que el archivo en disco nunca contiene texto plano).

**Predicción de liquidez (beta)** (`server/domain/engines/liquidityPredictionEngine.js`)
— antes existían `fillProbabilityEngine.js` (score determinístico de la
oportunidad actual) y `slippageValidator.js` (calibración post-hoc de lo
modelado vs. lo realizado), pero nada que *prediga* condiciones de liquidez
futuras. Este módulo es un modelo estadístico ligero y honestamente
etiquetado como tal (no es una red neuronal): doble EWMA (corto/largo
plazo) + estacionalidad por hora del día + promedios condicionados por
tamaño de operación, con *shrinkage* hacia el prior poblacional cuando hay
pocas muestras — la práctica estándar para evitar sobre-confianza con datos
insuficientes. Cada predicción devuelve `confidence` y `sampleCount`
explícitos; en cold-start declara `confidence: 0` en vez de inventar un
número. Conectado a `arbitrageOrchestrator.js` en el mismo punto que
`fillProbabilityEngine` (aprende de cada oportunidad real que pasa por el
pipeline). Tests: `tests/liquidityPredictionEngine.test.js` (17 tests:
cold-start, convergencia del EWMA, detección de tendencia, estacionalidad
por hora, condicionamiento por tamaño, y el wrapper de enriquecimiento).

**Superficie en UI:**
- El selector de `orderExecutionPolicy` aparece automáticamente en
  `LiveConfigPanel.jsx` — el panel ya era 100% schema-driven (cualquier
  clave nueva en `liveConfig.js` con su `schema` entry se renderiza sola,
  agrupada correctamente), así que no hizo falta tocar el frontend para
  esto.
- Se agregó un badge de "Liquidez" en `OpportunityHero.jsx` junto a
  `P(fill)`, mostrando el fill esperado, la tendencia (▲/▬/▼) y la
  confianza del modelo. Con `confidence: 0` (cold-start) el badge
  simplemente no se muestra — evita mostrar una tendencia sin evidencia
  detrás.
- `arbitrageOrchestrator.js` conecta `enrichWithLiquidityPrediction` en el
  loop real que alimenta el SSE stream (`detectBtcOpportunities` →
  `buildTickPayload` → `pushToSSE`), no en un camino muerto — cada
  oportunidad que llega al dashboard ya entrenó y consultó el modelo.

---

## 6. Resultado de la suite completa (tests + lint + tsc + build)

Ejecutado al final de la sesión de seguimiento (implementación del sistema
de 3 tramos, reconciliación de exposición neta, y tests de
`getRebalanceCostRatio`), sobre el código ya modificado:

- **`npx vitest run`** → **80 archivos de test, 1375 tests, todos pasan.**
  Incluye los módulos nuevos de esta sesión de seguimiento:
  `smartOrderRouter.test.js` (10), `secretsVault.test.js` (14),
  `liquidityPredictionEngine.test.js` (17), además del test de integración
  IOC agregado a `liveExecutionCrossExchange.test.js`.
  Incluye explícitamente los módulos tocados: `tradeStateMachine.test.js`
  (con `classifyFillTier` + los 3 tramos de `evaluatePartialFill`),
  `liveExecutionCrossExchange.test.js` (con los 2 escenarios nuevos de fill
  parcial genuino, tier `low` y tier `mid`), y el nuevo
  `rebalanceCostRatio.test.js` (7 tests dedicados).
- **`npm run lint`** (eslint sobre `src/` y `server/`) → **0 errores, 0
  warnings.**
- **`npm run build:ts`** (`tsc`) → **sin errores.**
- **`npm run build`** (`vite build`) → **build de producción exitoso**,
  964 módulos transformados.

---

## Resumen — qué se alineó, qué se agregó, qué sigue siendo idea sin implementar

**Se alineó (la respuesta ya era precisa, solo faltaba la cita exacta):**
- Capa predictiva de rebalanceo por sesgo direccional (`directionalBiasTracker.js`).
- El umbral `rebalanceThresholdPct` mide concentración, como sospechabas.

**Se agregó (cerraba un gap real):**
- `rebalanceEngine.getRebalanceCostRatio()` + badge de alerta en UI, con 7
  tests unitarios dedicados (punto 3 — cerrado por completo).
- 8 parámetros de estrategia core movidos de constante fija a `liveConfig`
  hot-reloadable (punto 5), incluyendo que `detailedScoreWeights` ahora
  afecta el cálculo real, no solo el label del breakdown.
- **El sistema real de partial fills en 3 tramos** (`classifyFillTier` +
  `evaluatePartialFill` con tiers `high`/`mid`/`low`), integrado en
  `executeCrossExchangeLive()` con reconciliación de exposición neta —
  incluyendo la corrección de un bug de sobre-cobertura pre-existente
  (punto 1 — cerrado por completo, con tests).

**Sigue siendo una idea sin implementar — decide tú si la mencionas:**
- XRP/USDT como tercer par operable de verdad: la configuración existe,
  el pipeline de ejecución/wallets no está conectado (punto 4). Este sigue
  siendo un cambio transversal (wallets, P&L, ruteo de asset) y la
  recomendación de la Sesión 30 se mantiene: es más seguro entregar
  BTC/ETH sólido que un tercer par a medio conectar el día de la demo.


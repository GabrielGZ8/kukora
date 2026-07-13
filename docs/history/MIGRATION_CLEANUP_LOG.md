# Kukora — Changelog: cierre de la migración domain/application/infrastructure

Fecha: sesión actual, antes de continuar en Antigravity.

## Qué se detectó

El audit externo (ChatGPT) tenía razón: existía una migración arquitectónica incompleta.
Al escanear por **contenido real** (no solo por nombre de archivo) se encontraron
**79 archivos "shim"** en la raíz de `server/` — archivos de 1 a 19 líneas cuyo único
propósito era reexportar la implementación real que ya vivía en `server/domain/`,
`server/application/` o `server/infrastructure/`:

```js
module.exports = require('./domain/analytics');
```

Esto NO era código duplicado con lógica divergente (buena noticia: no había que
resolver conflictos de versiones), pero sí era deuda de migración real:
- 41 shims → `domain/`
- 3 shims → `application/`
- 28 shims → `infrastructure/`
- 3 shims → `routes/`
- 7 shims → `infrastructure/persistence/models/` (dentro de `server/models/`)

En total, **198+ referencias** en el código (rutas, tests, otros módulos de dominio,
incluso módulos de `domain/` que se llamaban entre sí a través del shim de la raíz)
apuntaban a las rutas viejas en vez de a la ubicación canónica.

## Qué se hizo

1. Se escribió un script (Python, AST-free pero con resolución de rutas exacta —
   no coincidencia de texto) que:
   - Detecta cualquier archivo `.js` bajo `server/` cuyo cuerpo completo sea
     `module.exports = require('<ruta relativa>')` apuntando a otro archivo real.
   - Resuelve, para cada `require(...)`, `import(...)` dinámico y `require.resolve(...)`
     en **todo el repo** (server, tests, application, domain, infrastructure, routes),
     si apunta exactamente al archivo shim (por ruta absoluta resuelta, no por nombre).
   - Reescribe esa referencia para apuntar directamente al archivo canónico.
   - Borra el shim.
   - Repite hasta convergencia (0 shims nuevos encontrados) — esto fue necesario
     porque `server/models/index.js` era a su vez un shim hacia
     `server/infrastructure/persistence/models/index.js`, que solo se reveló
     después de limpiar la primera capa.

2. Se corrigieron a mano 5 referencias con `require.resolve(...)` que el regex
   automático no capturó en la primera pasada (`require.resolve` no es `require(`
   seguido directamente de comilla), en `tests/models.test.js` y `tests/smoke.test.js`.

3. Se verificó en cada iteración:
   - `npx vitest run` → **1145/1145 tests pasando** (0 fallos).
   - `npx eslint src/ server/ --ext .js,.jsx` → limpio, 0 warnings/errores.
   - `node server/index.js` arranca correctamente (fallback in-memory sin Mongo,
     tal como está diseñado) y responde a SIGTERM con shutdown ordenado.

## Resultado

`server/` pasó de **78 archivos sueltos en la raíz** a **2**:
- `server/index.js` — punto de entrada legítimo.
- `server/models.js` — schema real de Mongoose (User), separado intencionalmente
  de `server/infrastructure/persistence/models/` (que contiene los modelos
  operacionales: HeatmapBucket, DailyReportDoc, ExecutionRecord, ReplaySnapshot,
  DailyStatsDoc, SessionDoc). Esta separación es razonable (auth/user vs métricas
  operacionales) pero **queda como decisión a validar/documentar explícitamente**
  en un ADR — no se tocó en esta sesión para no mezclar refactors sin verificación
  cruzada.

Todos los shims residuales, incluyendo los "escondidos" (nombres distintos al
target, ej. `riskEngine.js` → `domain/advancedRiskEngine.js`, o
`domainErrors.js` → `domain/errors.js`) fueron eliminados.

## Pendientes reales para la siguiente sesión (estado original de este log)

Esto **no** es la auditoría completa de robustez/edge-cases que pide el comité —
es específicamente el cierre de la migración arquitectónica. Al cierre de la
sesión que escribió este log, seguía pendiente:

1. ~~**ADR-002**: documentar por qué `server/models.js` (User) vive separado de
   `server/infrastructure/persistence/models/`~~ — **RESUELTO** en la sesión
   siguiente: ver `docs/ADR-010-user-models-separate-from-persistence-models.md`.
   Decisión: mantener la separación (auth/cuenta vs modelos operacionales del
   motor), ya era la intención de diseño original — solo faltaba formalizarla.
2. ~~Confirmar si `server/arbitrage/routes/` debería fusionarse con
   `server/routes/`~~ — **RESUELTO**: ver
   `docs/ADR-011-routes-vs-arbitrage-subroutes.md`. Decisión: no fusionar (son
   dos niveles distintos de la misma jerarquía, no dos convenciones
   compitiendo), pero sí renombrar `server/arbitrage/routes/` →
   `server/arbitrage/subroutes/` para eliminar la colisión de nombres que
   causaba la percepción de inconsistencia. Rename verificado con
   1145/1145 tests.
3. Toda la lista de edge cases, robustez, parametrización, wallets/rebalanceo y
   documentación del `kukora_master_prompt_opus.md` original — **sigue
   pendiente**, fuera de alcance de esta sesión también. La limpieza de shims
   y las ADR-010/011/012 solo resuelven el eje de "arquitectura física /
   consistencia", que era UNO de los cinco factores, no los cinco.
4. ~~Revisar si conviene mover todo bajo una carpeta `server/api/` de nivel
   superior~~ — **RESUELTO (decisión: no, por ahora)**: ver
   `docs/ADR-012-no-top-level-server-api-folder.md`. `server/routes/` ya
   cumple ese rol; envolver todo bajo `api/` tocaría cada `require` del
   proyecto por un beneficio puramente terminológico.

## Sesión de continuación — cierre de los pendientes 1, 2 y 4

Fecha: sesión posterior a la de arriba.

Con esto, los tres pendientes de arquitectura física identificados en la
sesión anterior quedan resueltos (documentados con ADR, y en el caso del
rename de `arbitrage/routes` → `arbitrage/subroutes`, también aplicado y
verificado). Verificación final de esta sesión: `npx vitest run` →
**1145/1145 tests**, `npm run lint` limpio, arranque de `node server/index.js`
verificado. El único pendiente real que queda de este log es el punto 3
— la auditoría de robustez/edge-cases/wallets/documentación del prompt
maestro original — que es un eje completamente distinto (no arquitectura
física) y no se abordó aquí para no mezclar objetivos sin verificación
cruzada dedicada a cada uno.

## Sesión 3 — robustez de wallets/rebalanceo (cierre parcial del punto 3)

Fecha: sesión posterior a la de continuación de arriba. Retoma el trabajo de
una sesión anterior que se quedó sin tokens a mitad de una regresión que ella
misma había introducido (ver contexto abajo) y lo deja verificado y empaquetado.

### Contexto: qué se recibió al empezar esta sesión

El zip recibido como punto de partida (`kukora_migration_resolved.zip`) estaba
en el estado de la sesión de continuación de arriba (shims + ADR-010/011/012),
**sin** los fixes de wallets/rebalanceo todavía aplicados al código — esos
fixes habían sido diseñados y mostrados como snippets en una sesión posterior
que se agotó antes de poder empaquetar el resultado. Se aplicaron aquí a
partir de esos snippets, verificando cada uno contra el código real en vez de
copiarlos a ciegas (lo cual encontró un bug adicional no documentado — ver
punto 4 abajo).

### Fixes aplicados y verificados

1. **`rebalanceEngine.js` — lista de exchanges hardcodeada.** `ALL_EXCHANGES`
   era un literal (`['Binance', 'Kraken', 'Bybit', 'OKX', 'Coinbase']`) que no
   se actualizaba si se registraba un 6º exchange vía `exchangeRegistry.js`
   (la fuente única de verdad que ya usan `liveConfig.js`, `walletManager.js`
   y `arbitrageOrchestrator.js`). Cambiado a
   `getEnabledExchangeNames()`.

2. **`executeRebalance()` — firma desalineada con su único caller real.** La
   función esperaba `(suggestion, wallets, _btcPrice)`, pero
   `POST /api/arbitrage/rebalance/execute` la llama con
   `executeRebalance(suggestion, btcPrice)` — 2 argumentos. `wallets` recibía
   en silencio un `number` (el precio de BTC), así que
   `wallets[asset]?.[from] || 0` siempre daba `0` y el endpoint solo podía
   devolver "insufficient balance". Nunca movió capital real, ni una sola vez,
   desde que existe.

3. **Aunque la firma se hubiera arreglado, no había dónde persistir el
   transfer.** `getBalances()` devuelve `JSON.parse(JSON.stringify(wallets))`
   — una copia descartable — así que mutar un `wallets` recibido como
   argumento nunca se habría reflejado en el estado real del módulo. Se
   agregó `applyRebalanceTransfer(asset, from, to, amount, feeInAssetUnits)`
   en `walletManager.ts` (mismo patrón que `_applyTradeInternal`: valida,
   muta el estado real, verifica integridad con rollback si algo da
   negativo) y `executeRebalance()` ahora la llama.

4. **Endurecimiento contra input no confiable.** `config.routes.js` cae a
   `req.body.suggestion` cuando no hay un id de suggestion trackeado en el
   servidor — así que `executeRebalance()` es alcanzable con un objeto
   `suggestion` armado por el cliente, y `suggestion.viable` es un campo de
   ESE objeto, no algo que el motor calculó. No es una autorización confiable
   por sí sola. Se agregó validación independiente de `asset` (solo
   BTC/USDT), `from`/`to` (deben estar en `ALL_EXCHANGES` y ser distintos) y
   `amount` (número finito positivo) antes de tocar cualquier balance, y el
   withdrawal fee ahora se recalcula server-side en vez de confiar en
   `suggestion.fee` (que además está denominado en USD para el caso BTC, no
   en unidades del activo).

5. **Bug adicional encontrado durante esta sesión, no presente en los
   snippets recibidos: imports obsoletos en dos archivos `.ts` fuente.**
   `server-types/server/domain/advancedRiskEngine.ts` importaba
   `'../liveConfig'`, `'../observabilityService'` y `'../analytics'` — rutas
   que apuntan a `server/liveConfig.js`, etc., que no existen desde la
   reorganización a `server/infrastructure/` y `server/domain/`. El
   `server/domain/advancedRiskEngine.js` COMPILADO tenía las rutas correctas
   (`../infrastructure/liveConfig`, etc.) porque alguien lo había parcheado a
   mano en algún momento — pero **sin actualizar el `.ts` fuente**, que es el
   archivo que se supone hay que editar (`server/domain/*.js` son artefactos
   generados; el header de cada uno lo dice explícitamente: "Never edit
   ... directly — it is a generated build artifact; edit this file and run
   `tsc`"). El mismo patrón apareció en `walletManager.ts` (`'../logger'`,
   `'../exchangeRegistry'` en vez de `'../infrastructure/logger'`,
   `'../infrastructure/exchangeRegistry'`). Esto es exactamente lo que causó
   la regresión que le hizo perder el hilo a la sesión anterior: en cuanto
   corrió `npx tsc` (para compilar su propio fix de `walletManager.ts`),
   TypeScript recompiló *todos* los `.ts` de `server-types/`, incluyendo
   `advancedRiskEngine.ts`, y sobrescribió el `.js` parcheado a mano con uno
   que tenía las rutas rotas otra vez → 16 tests fallando con
   `Cannot find module '../liveConfig'`.

   Causa raíz real: los stubs de declaración de tipos
   (`server-types/server/*.d.ts` — `liveConfig.d.ts`, `logger.d.ts`,
   `exchangeRegistry.d.ts`, `observabilityService.d.ts`, `analytics.d.ts`,
   `executionStrategy.d.ts`) seguían en las rutas planas viejas
   (`server-types/server/liveConfig.d.ts`), así que un import en el `.ts`
   fuente que usara la ruta *correcta* en runtime (`../infrastructure/...`)
   fallaba en tiempo de compilación con `TS2307: Cannot find module`. La
   solución real no era parchear el `.js` compilado (eso es lo que generó el
   drift) sino mover los `.d.ts` a las rutas que reflejan la ubicación actual
   de los módulos reales (`server-types/server/infrastructure/*.d.ts`,
   `server-types/server/domain/analytics.d.ts`,
   `server-types/server/domain/executionStrategy.d.ts`) y corregir los
   imports en los `.ts` fuente para que apunten ahí. Con eso, `.ts` fuente,
   `.d.ts` stub y `.js` compilado quedan alineados y `npx tsc` ya no puede
   volver a introducir esta regresión.

6. **`.eslintrc.cjs` — mismo tipo de drift, un archivo más.** El override
   que apaga `no-var`/`prefer-const` para los 4 archivos generados por `tsc`
   (`no-var: off`, ya que el output de `tsc` con `esModuleInterop` usa `var`
   para sus helpers, y eso no es un problema de calidad) seguía listando las
   rutas planas viejas (`server/feeConfig.js`, `server/walletManager.js`,
   etc.) en vez de `server/domain/feeConfig.js`, etc. Corregido.

7. **Test de regresión nuevo:** `tests/rebalance.test.js` (12 tests) cubre
   específicamente: `applyRebalanceTransfer` persiste en el estado real y
   rechaza exchange desconocido / fee mayor al monto / balance insuficiente /
   montos no positivos o no finitos; `executeRebalance` llamado exactamente
   como lo llama la ruta real (`(suggestion, btcPrice)`, 2 argumentos) mueve
   capital de punta a punta; rechaza `suggestion` con `to` fuera de la lista
   de exchanges aunque `viable: true`; rechaza asset no soportado, `from ===
   to`, y `viable: false`; registra el history entry correcto; y
   `analyzeBalance().summary.byExchange` cubre exactamente los exchanges que
   `EXCHANGES` reporta (no una lista hardcodeada aparte).

### Verificación final de esta sesión

- `npx tsc` → compila limpio, 0 errores.
- `npx eslint src/ server/ --ext .js,.jsx` → limpio, 0 errores.
- `npx vitest run` → **1157/1157 tests** (1145 preexistentes + 12 nuevos de
  `tests/rebalance.test.js`), 67 archivos de test.
- `node server/index.js` arranca limpio (puerto 5000, watchdog inicializado)
  y responde a `SIGTERM` con shutdown ordenado (`SIGTERM — graceful shutdown
  initiated` → handlers de watchdog → estado guardado).

### Lo que sigue pendiente del punto 3 original (no tocado en esta sesión)

Este cierre es acotado a wallets/rebalanceo — el pedazo del punto 3 que tenía
forma de bug concreto y verificable. Sigue sin tocar, del `kukora_master_prompt_opus.md`
original (que sigue sin estar disponible en ningún zip recibido, así que no
hay checklist contra el cual auditar directamente):

- Cobertura de tests de `predictiveRebalance.js` (6.87% statements al momento
  de escribir esto) y del resto de `rebalanceEngine.js` más allá de los 12
  tests nuevos — quedan varias ramas de `suggestRebalance()` (ej. cuando no
  hay exchange fuente/destino viable) sin cubrir directamente.
- Todo lo de infraestructura externa, tiempo en mercado, y custodio real de
  wallets mencionado en la sesión anterior — no es código, es alcance de
  negocio/tiempo, no algo resoluble en una sesión de edición de código.
- Edge cases de robustez en otros módulos con coverage bajo detectados por el
  reporte (`predictiveRebalance.js`, `arbitrageOrchestrator.js`,
  `opportunityDetection.js`, `quantumEngine.js`, entre otros — ver el output
  de `npx vitest run --coverage` para el desglose completo por archivo).

## Archivos de referencia de esta sesión (Sesión 3)

Los originales antes de esta sesión (por si hace falta comparar) quedaron en:
- `/tmp/walletManager.ts.orig`, `/tmp/rebalanceEngine.js.orig` — versión sin
  el fix de `applyRebalanceTransfer` / firma de `executeRebalance`.
- `/tmp/advancedRiskEngine.ts.bak` — versión con los imports `.ts` obsoletos
  que causaban el `TS2307`/`Cannot find module` al recompilar.

Estos backups NO están incluidos en el zip entregado (son solo referencia de
esta sesión de trabajo, no parte del proyecto).


---

## Sesión 3 — Cierre de predictiveRebalance.js (continuación tras corte por límite de tokens)

La sesión anterior había diagnosticado y resuelto en memoria, pero no llegó a
empaquetar, el trabajo sobre `server/domain/predictiveRebalance.js` (motor
detrás de `/api/arbitrage/rebalance` y el dashboard de eficiencia de capital,
que estaba en 6.87% de cobertura de statements sin archivo de test dedicado).//
Esta sesión retomó exactamente ese estado final (sin rehacer nada) y lo cerró:

1. **`_resetForTests()` agregado a `predictiveRebalance.js`**, siguiendo el
   mismo patrón ya establecido en `walletManager.resetBalances()` — el módulo
   mantiene `_tradeHistory` y `_utilizationHistory` en estado de closure sin
   forma de resetearlo entre tests.
2. **Se descartó `vi.resetModules()` como estrategia de aislamiento entre
   tests.** Confirmado con una reproducción mínima: en este proyecto,
   `vi.resetModules()` no limpia de forma confiable el `require.cache` real
   de Node para módulos CJS cargados con `require()` plano (no vía `import`
   transformado por Vite). Esto es información relevante para cualquier test
   futuro sobre otro módulo con estado en closure — usar un export
   `_resetForTests()` explícito, no `resetModules()`.
3. **`tests/predictiveRebalance.test.js` creado — 15 tests nuevos**, cubriendo:
   - `computeConsumptionRates`: tasas cero + `Infinity`/`null` sin historial,
     cálculo de tasa de consumo BTC/USDT separada por exchange, exclusión de
     trades fuera de la ventana temporal (con fake timers, no con
     `windowMs=0`, que producía un test frágil dependiente del reloj real).
   - `generatePredictiveRecommendations`: niveles de urgencia
     (critical/high/medium), filtro por `minimumTransferAmount`, no-viabilidad
     cuando el costo de transferencia excede el límite configurado, orden por
     urgencia, y el evento de observabilidad emitido en urgencia crítica
     (verificado con `vi.spyOn`, no solo `toBeDefined()`).
   - `computeCapitalEfficiency`: guard de capital cero, cálculo de ROI/
     utilización/P&L proyectado, floor de `uptimeHours` a 1 minuto (con la
     tolerancia correcta: la función redondea internamente a 2 decimales,
     así que el test compara contra esa misma precisión, no contra el valor
     exacto sin redondear), detección de exchanges inactivos, e historial de
     utilización acotado a 100 entradas internamente / 10 en la respuesta.
   - `computeOptimalDistribution`: piso de 10% de asignación sin actividad
     de trades, y ponderación hacia exchanges con más actividad de compra/venta.

**Verificación final de esta sesión:**
- `npx vitest run` → **1172/1172 tests pasando** (1157 previos + 15 nuevos).
- `npx eslint src/ server/ --ext .js,.jsx` → limpio.
- `npx tsc --noEmit` → limpio.
- `node server/index.js` arranca, cae a modo in-memory sin Mongo (comportamiento
  esperado), y responde a SIGTERM con shutdown ordenado.

### Pendiente real, sin tocar (alcance evaluado y descartado a propósito)

Llevar el resto de módulos con cobertura baja (`backtestEngine`,
`exchangeIntelligenceService`, `healthService`, etc.) al mismo nivel de
`predictiveRebalance.js` es un trabajo de varias sesiones dedicadas por
módulo — no es razonable ni deseable comprimirlo en una sola sesión sin
verificar cada caso con el mismo rigor que aquí (tests apurados solo para
subir el número de cobertura son peor que no tenerlos). Se prioriza calidad
de test sobre porcentaje de cobertura total.

Tampoco es competencia de esta sesión (ni de ninguna sesión de código):
tiempo en mercado real, infraestructura externa de producción, ni la
relación con un custodio/exchange real — eso es responsabilidad operativa
fuera del alcance de un repositorio de código.

---

## Sesión 4 — M-2 (IDs de trade con crypto.randomUUID()) y H-8 (snapshots
## congelados de liveConfig en opportunityDetection.js)

Fecha: sesión posterior a la de predictiveRebalance.js. Retoma el trabajo
directamente desde el zip recibido (estado: Sesión 3 completa, 1172/1172
tests) y cierra dos issues concretos y acotados del `implementation_plan.md`
que no requerían decisiones de producto pendientes (a diferencia de H-10,
Q1-Q5, etc.), priorizando dejar el proyecto verificado y empaquetado antes
de agotar el contexto de la sesión.

### M-2 — IDs de trade generados con `Math.random().toString(36)`

**Problema real**: `Math.random().toString(36).slice(2, 6-7)` da ~1.7M
combinaciones para el sufijo. Combinado con `Date.now()` (resolución de 1ms),
dos trades ejecutados en el mismo milisegundo tienen una probabilidad de
colisión no despreciable a la escala que el motor apunta a operar. No es
criptográficamente aleatorio.

**Fix aplicado**: reemplazado por `crypto.randomUUID()` (nativo desde Node 16,
ya usado en `liveExecution.js`) en los 8 puntos de generación de IDs:
- `server/application/liveExecution.js` — `live-*`, `xlive-*`
- `server/domain/executionStrategy.js` — `dryrun-*` (se agregó `require('crypto')`)
- `server/domain/tradeStateMachine.js` — `trade-*` (se agregó `require('crypto')`)
- `server/domain/rebalanceEngine.js` — `rebal-*` (se agregó `require('crypto')`)
- `server/domain/opportunityDetection.js` — `trade-*`, `tri-leg1-*`, `tri-leg2-*`
  (se agregó `require('crypto')`)

Se verificó primero que los tests solo assertan el **prefijo** del ID
(`toMatch(/^live-/)`, `startsWith('trade-')`, etc.), nunca el formato exacto
del sufijo — así que el cambio no rompe ningún test existente y no requirió
tocarlos.

### H-8 — `DEFAULT_TRADE_AMOUNT` / `USE_MAKER_FEES` / `MIN_NET_PROFIT` como
### constantes de módulo congeladas en `opportunityDetection.js`

**Problema real** (confirmado leyendo el archivo, no solo el plan): las tres
constantes se calculaban una sola vez al cargar el módulo
(`liveConfig.get('tradeAmountBTC')` etc. evaluado en la línea 16-18, en
tiempo de `require()`). El resto del archivo ya seguía correctamente el
patrón de leer `liveConfig.get(...)` en cada ciclo — **excepto** 8 sitios que
usaban estas tres constantes: la inyección sintética de `DEMO_MODE` (2 usos),
el cálculo de `viabilityThresholdPct` del flujo normal (1 uso), el fallback
de `feeMode` en `executeSimulated()` (1 uso), el umbral de viabilidad
triangular (1 uso), y el `feeMode` de ambos legs triangulares (2 usos). El
resultado: cambiar `tradeAmountBTC`, `feeMode` o `minNetProfitUSD` en caliente
vía `liveConfig.set()` (la razón de ser de `liveConfig.js` — hot reload sin
reiniciar el proceso) no tenía efecto en estos 8 sitios hasta un reinicio del
proceso, silenciosamente.

Cabe notar que los getters `_DEFAULT_TRADE_AMOUNT`, `_USE_MAKER_FEES`,
`_MIN_NET_PROFIT` exportados al final del archivo (para tests/compatibilidad)
**ya leían liveConfig en vivo correctamente** — el bug estaba solo en el uso
interno de las constantes de módulo, no en la superficie pública ya expuesta.

**Fix aplicado**: eliminadas las 3 constantes de módulo; los 8 call sites
ahora llaman `liveConfig.get('tradeAmountBTC')`, `liveConfig.get('feeMode')`
o `liveConfig.get('minNetProfitUSD')` directamente, mismo patrón que el resto
del archivo. Los getters de compatibilidad al final del archivo no se
tocaron (ya eran correctos).

### Verificación de esta sesión

- `npx vitest run` → **1172/1172 tests pasando** (sin cambios de conteo —
  ningún test nuevo hacía falta para estos dos fixes, y ninguno se rompió).
- `npx eslint src/ server/ --ext .js,.jsx` → limpio, 0 errores/warnings.
- `npx tsc --noEmit` → limpio, 0 errores.
- `npm run build` (`vite build`) → build de producción limpio, 973 módulos
  transformados.
- `node server/index.js` arranca (puerto 5000, watchdog inicializado, fallback
  in-memory sin Redis/Mongo tal como está diseñado) y responde a `SIGTERM`
  con shutdown ordenado.
- `npm audit --omit=dev --audit-level=high` → exit 0 (0 vulnerabilidades
  high/critical; quedan 8 moderadas, todas transitivas de la cadena
  `firebase-admin → @google-cloud/firestore → google-gax`, preexistentes y
  fuera del alcance de estos dos fixes).

### Pendiente real para la siguiente sesión

Del `implementation_plan.md` original, sin tocar en esta sesión (evaluados y
descartados a propósito por alcance/tamaño, no por dificultad):

- **H-1** (validación con Zod/Joi/AJV), **H-3** (request ID propagation —
  aunque el log de `middlewares.test.js` en esta sesión ya muestra
  `"requestId":"13b359c0-..."` en las líneas HTTP, así que puede que esté más
  avanzado de lo que el plan original asumía; **verificar antes de asumir
  que sigue pendiente**), **H-9** (prefijo `/api/v1/`), **H-10** (Spanish →
  English en todo el código) — cada uno es multi-archivo y de alcance grande,
  no algo para comprimir al final de una sesión ya con cambios sin probar.
- **Q1-Q5** (Open Questions del plan) siguen sin respuesta del usuario —
  son decisiones de producto/arquitectura (TypeScript sí/no, plataforma de
  deploy única, `DEMO_MODE` sí/no, si hay usuarios en producción, alcance de
  producto de las 28 páginas) que no se pueden resolver escribiendo código;
  bloquean H-9, H-10, L-4 y C-5 hasta que se respondan.
- El resto de M-1, M-3 a M-7, L-1 a L-5 — sin tocar, mismo criterio de
  sesiones anteriores: priorizar fixes verificables de principio a fin sobre
  avanzar parcialmente varios a la vez.

## Sesión 5 — Verificación de H-3, y cierre de M-1 (backoff del loop) y M-4
## (límite de conexiones SSE)

### Baseline

- `npm ci` limpio.
- `npx vitest run` → **1172/1172 tests pasando** antes de tocar nada, tal
  como se esperaba. Se procedió.

### H-3 — Request ID propagation: **verificado, confirmado resuelto**

La sesión anterior ya sospechaba esto (ver nota al final de la Sesión 4) y
el usuario lo señaló de nuevo al abrir esta sesión. Se verificó leyendo el
código, no asumiendo:

- `server/infrastructure/requestMiddleware.js` genera un UUID vía
  `crypto.randomUUID()`, lo asigna a `req.requestId` y lo setea como header
  `X-Request-ID` en **cada** respuesta (`res.setHeader(...)` corre antes de
  que cualquier handler o el error handler se ejecuten, y nada lo borra
  después).
- El logger recibe `requestId` en cada línea de log HTTP (confirmado en
  logs reales de esta sesión, ej. `"requestId":"faccc9ee-2882-..."`).
- El error handler central (`server/domain/errors.js`, función
  `expressErrorHandler`) también incluye `requestId` en ambas llamadas al
  logger (tanto el camino de `AppError` como el fallback 500 genérico).
- El **body JSON** de las respuestas de error (`err.toResponse()` / el
  fallback 500) **no** incluye `requestId` — pero como el header
  `X-Request-ID` ya está presente en toda respuesta, incluidas las de error
  (verificado con `curl -v`), el requisito del plan original ("Include in
  all error responses") queda cubierto por el header, que es el mecanismo
  estándar de correlación (mismo patrón que AWS `x-amzn-RequestId`, etc.).

**Conclusión**: H-3 está completo. No se tocó código para esto — solo se
confirma y se cierra el ítem. Si en el futuro se quiere que el `requestId`
también viva en el body JSON de error (más cómodo para debugging desde
Postman/curl sin mirar headers), es un cambio trivial de una línea en
`errors.js`, pero no es necesario para considerar el ítem resuelto.

### M-1 — Circuit breaker / backoff en el loop de 150ms: **cerrado**

**Problema real** (confirmado leyendo `arbitrageOrchestrator.js`, no solo el
plan): `serialLoop()` llamaba `setTimeout(serialLoop, 150)` incondicionalmente,
sin importar si el tick anterior tuvo éxito o falló. El `catch` que rodea el
cuerpo de `run()` solo logueaba vía `_warn()`, que es **silencioso en
producción** (gateado por `DEBUG_KUKORA=1`). Si `run()` empezaba a fallar en
cada tick (ej. un null dereference, o el feed de un exchange caído), el
resultado era ~6.7 errores/segundo indefinidamente, sin backoff y sin
visibilidad en producción — exactamente el escenario descrito en el plan.

**Fix aplicado** en `server/application/arbitrageOrchestrator.js`:

- Nuevo estado de módulo `_consecutiveLoopErrors`, reseteado a 0 en cada
  tick exitoso.
- `_computeLoopDelay(consecutiveErrors)` (función pura, exportada para
  tests): mantiene el cadence normal de 150ms por debajo de
  `LOOP_BACKOFF_THRESHOLD` (5 fallas consecutivas), y luego escala
  exponencialmente (`150 * 2^n`) con un tope duro de `LOOP_MAX_BACKOFF_MS`
  (30s) — el loop nunca deja de reintentar, solo espacía los reintentos.
- `_recordLoopOutcome(success, errMessage)`: se llama en los dos puntos
  reales donde `run()` puede fallar (el `catch` de `getOrderBooks()` que ya
  hacía `return` temprano, y el `catch` externo que envuelve todo el cuerpo
  de `run()`). Al **cruzar** el umbral (no en cada falla posterior) emite
  `logger.error(...)` + `obs.emit('SYSTEM', 'loop.backoff_engaged', ...)`;
  al recuperarse tras haber estado en backoff emite `logger.warn(...)` +
  `obs.emit('SYSTEM', 'loop.recovered', ...)`. Se usó el mismo canal
  `obs.emit('SYSTEM', ...)` que ya usa `stream.routes.js` para
  `internal.error`, en vez de inventar un tipo de alerta nuevo — y
  deliberadamente **no** se reutilizó `alertCircuitBreakerActivated()` de
  `alertWebhookService.js`, porque esa función ya tiene un significado
  específico y distinto (circuit breaker del *risk engine*, con su propio
  endpoint de reset manual) y reutilizarla aquí habría sido confuso.
- `serialLoop()` ahora llama `setTimeout(serialLoop, _computeLoopDelay(...))`
  en vez de `150` fijo.
- Se exportaron helpers test-only (`_computeLoopDelay`, `_recordLoopOutcome`,
  `_resetLoopBackoffForTests`, `_getLoopBackoffStateForTests`) — el loop real
  (`arbitrageLoop`/`serialLoop`) sigue sin exportarse (usa I/O real de
  exchanges vía `setTimeout` recursivo), así que se testeó la lógica pura
  de backoff directamente en vez de intentar manejar el loop real. Ver H-5
  (0% cobertura del orchestrator) para la refactorización de testabilidad
  más amplia — fuera de alcance de este fix puntual.

**Tests añadidos** en `tests/arbitrageOrchestrator.test.js` (nuevo describe
`M-1: loop error backoff`, 9 tests): cadence base bajo el umbral, escalada
exponencial, tope de 30s, reset del contador en éxito, no-reset prematuro,
y verificación exacta de que `logger.error`/`logger.warn` +
`obs.emit(...)` se disparan **solo** al cruzar el umbral / al recuperarse
(no en cada tick).

### M-4 — Límite de conexiones SSE: **cerrado (gap real encontrado)**

**Hallazgo**: al revisar el código para verificar el estado de M-4, se
confirmó que `MAX_SSE_CLIENTS` y `MAX_ALERT_SSE_CLIENTS` **ya estaban
implementados** en `server/arbitrage/subroutes/stream.routes.js` (rutas
`/stream` y `/alerts-stream`, ambas devuelven 503 al llegar al tope) — el
plan original estaba desactualizado en este punto, igual que pasó con H-3.

Sin embargo, existe un **tercer** pool de conexiones SSE de larga duración
que el plan no mencionaba explícitamente y que sí tenía el gap real: el
stream de notificaciones del bell icon, `GET /api/notifications/stream` en
`server/routes/notifications.routes.js`, que agrega conexiones a
`notificationClients` (un `Set` compartido, mismo patrón que `sseClients` /
`alertsClients`) **sin ningún límite** — un usuario abriendo muchas pestañas
podía agotar ese pool igual que el plan describía para `/stream`.

**Fix aplicado**: mismo patrón exacto que las otras dos rutas —
`MAX_NOTIFICATION_SSE_CLIENTS` (env var, default 200, misma convención de
nombre que `MAX_SSE_CLIENTS`), chequeado al inicio del handler de `/stream`
antes de `res.setHeader(...)`/`notificationClients.add(...)`, devolviendo
503 con el mismo shape de respuesta (`{ ok: false, error: '...' }`) que las
otras rutas SSE.

**Tests añadidos** en `tests/notifications.routes.test.js` (nuevo describe
`M-4: connection limit enforcement`, 3 tests): acepta y registra la
conexión bajo el tope, rechaza con 503 sin registrar la conexión ni setear
headers SSE al llegar exactamente a 200, y vuelve a aceptar conexiones una
vez que el pool baja de nuevo bajo el tope.

### Verificación final de esta sesión

- `npx vitest run` → **1184/1184 tests pasando** (1172 baseline + 9 de M-1
  + 3 de M-4; ningún test existente se rompió o se modificó).
- `npx eslint src/ server/ --ext .js,.jsx` → limpio, 0 errores/warnings.
- `npx tsc --noEmit` → limpio, 0 errores.
- `npm run build` (`vite build`) → build de producción limpio, 973 módulos
  transformados.
- Arranque/shutdown real del servidor:
  `PORT=5099 JWT_SECRET=... NODE_ENV=production node server/index.js`
  arranca limpio (in-memory, sin Redis/Mongo, tal como está diseñado),
  responde `401` a `/api/notifications/stream` sin ticket (auth corre antes
  que cualquier lógica de negocio), `200` en `/healthz` y `/api/health`, y
  al recibir `SIGTERM` corre el watchdog de shutdown (`bot_state` handler,
  "Saving final state...") y el proceso termina limpio sin necesidad de
  `SIGKILL`.

### Pendiente real para la siguiente sesión

- **H-1** (validación con Zod/Joi/AJV), **H-9** (prefijo `/api/v1/`,
  bloqueado por Q2), **H-10** (Spanish → English, multi-archivo grande) —
  sin tocar, mismo criterio que sesiones anteriores: alcance grande, no
  comprimibles al final de una sesión.
- **M-3, M-5, M-6, M-7** — sin tocar. En particular M-5 (persistencia
  fire-and-forget con `.catch(() => {})`, riesgo real de pérdida silenciosa
  de trades si MongoDB cae) es probablemente el candidato más importante
  para priorizar en la próxima sesión dado que es un sistema financiero,
  aunque requiere diseñar un WAL/retry queue — más grande que M-1/M-4, no
  se intentó aquí a propósito.
- **L-1 a L-5** — sin tocar (polish).
- **Q1-Q5** (Open Questions) siguen sin respuesta del usuario — siguen
  bloqueando H-9, H-10, L-4 y C-5.
- Nota para la próxima sesión: antes de asumir que cualquier ítem del plan
  sigue pendiente, verificar el código primero — esta sesión y la anterior
  encontraron dos casos (H-3, y la mitad de M-4) donde el plan original
  estaba desactualizado respecto al estado real del código.

## Sesión 6 — L-2 (Redis health/readiness) y M-5 (retry queue de persistencia)

### Baseline

- `npm ci` limpio.
- `npx vitest run` → **1184/1184 tests pasando** antes de tocar nada.

### L-2 — `/health` y `/api/readiness` nunca reportaban el estado de Redis

**Problema real**: `auth.js` ya mantenía internamente `_redis`/`_redisReady`
(usado por los stream tickets), pero no exponía esa información. `/health`
solo chequeaba MongoDB, y `/api/readiness` no tenía ningún check de Redis —
un Redis configurado pero caído (fallback silencioso a memoria, rompiendo
el sharing de tickets entre instancias horizontalmente escaladas) no era
visible en ningún endpoint de monitoreo.

**Fix aplicado**:
- `server/infrastructure/auth.js`: nueva función `getRedisStatus()` exportada,
  devuelve `{ configured: !!REDIS_URL, connected: !!(_redis && _redisReady) }`
  — mismo patrón "configured vs connected" que ya existía para MongoDB.
- `server/infrastructure/healthService.js`: `buildHealthPayload()` ahora
  incluye el campo `redis` en la respuesta, usando `require('./auth')`
  perezoso (para no arrastrar el setup de Redis de auth.js solo por
  importar healthService.js en tests).
- `server/index.js`, endpoint `GET /api/readiness`: nuevo check `redis` en
  el objeto `checks`. Si `REDIS_URL` no está configurado, in-memory es el
  modo soportado de una sola instancia → `ready` (igual que el patrón ya
  usado para `db`). Si `REDIS_URL` SÍ está configurado pero Redis está
  inalcanzable, `checks.redis = false` → 503, porque eso rompe de verdad el
  sharing de tickets en despliegues multi-instancia.

**Tests añadidos**: 2 en `tests/health.test.js` (propiedad `redis` en el
payload, y `configured:false` cuando no hay `REDIS_URL`), 2 en
`tests/auth-core.test.js` (`getRedisStatus` describe block: shape correcto
sin `REDIS_URL`, y que el objeto es serializable a JSON).

### M-5 — Persistencia fire-and-forget sin retry (`persistTrade`/`persistEquityPoint`)

**Problema real** (confirmado leyendo `arbitrageOrchestrator.js` y
`persistenceService.js`, no solo el plan): cada call site de
`persistTrade(...)` y `persistEquityPoint(...)` en el motor terminaba en
`.catch(() => {})` sin ningún reintento. Si MongoDB caía por unos segundos
durante un trade real (deploy, blip de red, failover de replica set), la
copia de auditoría/replay de ese trade se perdía para siempre, en silencio,
sin ninguna señal de que había pasado. El estado in-memory (wallet, trade
history) sigue siendo la fuente de verdad — esto es una copia secundaria de
auditoría/replay — así que un WAL completo respaldado en disco sería una
decisión arquitectónica mayor y separada; lo que sí se podía y debía hacer
de forma barata: una cola acotada en memoria para reintentar en un flush
periódico.

**Fix aplicado** en `server/infrastructure/persistenceService.js`:
- Nueva cola en memoria `_retryQueue` (acotada a `MAX_RETRY_QUEUE_SIZE=500`,
  con `MAX_RETRY_ATTEMPTS=10` por ítem antes de darse por vencido con
  `logger.error(...)`, siempre visible, no gateado por `DEBUG_KUKORA`).
- `_enqueueRetry(type, payload)`: si `MONGODB_URI` nunca fue configurado,
  NO encola — ese es el modo in-memory-only intencional (mismo criterio que
  `healthService.js`/L-2), no una caída real.
- `persistTrade`/`persistEquityPoint` ahora encolan en el `catch` (y también
  cuando `readyState !== 1` de entrada, en vez de solo devolver sin más).
- `_flushRetryQueue()`: drena la cola completa en batch cuando Mongo está
  arriba; los ítems que vuelven a fallar se re-encolan con `attempts++`
  (snapshot-and-clear del array para no correr con encolados concurrentes
  durante el propio flush).
- `startPersistenceRetryFlush(15_000)` / `stopPersistenceRetryFlush()`:
  mismo patrón idempotente que `startPeriodicFlush`/`startEngineSnapshotFlush`
  ya existentes.
- Wireado en `arbitrageOrchestrator.js` → `_startup()`: se llama
  `startPersistenceRetryFlush(15_000)` junto a los otros flushes periódicos
  que ya se arrancan ahí.
- Helpers test-only exportados: `_getRetryQueueSizeForTests`,
  `_resetRetryQueueForTests`, `_flushRetryQueueForTests`.

**Tests añadidos** en `tests/persistenceService.test.js` (nuevo describe
`M-5: persistence retry queue`, 7 tests, 5 pasando + 2 `it.skip`
documentadas):
- No encola si `MONGODB_URI` nunca se configuró (modo in-memory intencional).
- Encola un trade fallido cuando `MONGODB_URI` está configurado pero Mongo
  está caído.
- Encola un equity-point fallido cuando el propio write a Mongo lanza
  (Mongo arriba, write falla).
- `_flushRetryQueueForTests` es no-op mientras Mongo sigue inalcanzable
  (no toca ni limpia la cola).
- `startPersistenceRetryFlush`/`stopPersistenceRetryFlush` no lanzan y son
  idempotentes.
- **2 tests quedan como `it.skip`**, documentados en el propio archivo con
  un comentario extenso: requieren que `mongoose.connection.readyState`
  se lea como `1` desde dentro del `require('mongoose')` interno de
  `persistenceService.js` en el momento exacto en que corre
  `_flushRetryQueue()` (guard de early-return). Se confirmó por revisión
  manual de código que la lógica de reintento/abandono dentro de
  `_flushRetryQueue()` es correcta (mismo patrón ya cubierto por el test
  "is a no-op..." con `readyState=0`), pero el aislamiento de estado
  mockeado del singleton `mongoose.connection` entre este describe block y
  el resto del archivo no reprodujo de forma confiable en este setup de
  Vitest. **Pendiente real para la próxima sesión**: agregar un seam
  test-only a `persistenceService.js` (ej. un check de `readyState`
  inyectable, o mongoose inyectado por parámetro) en vez de seguir
  peleando contra el mock compartido.

### Verificación final de esta sesión

- `npx vitest run` → **1192 passed | 2 skipped (1194 total)** — 1184
  baseline + 3 de L-2 (2 en auth-core, 1 en health) + 7 de M-5 (5 passing,
  2 skip documentados) = 1194. Ningún test existente se rompió.
- `npx eslint src/ server/ --ext .js,.jsx` → limpio, 0 errores/warnings.
- `npx tsc --noEmit` → limpio, 0 errores.
- `npm run build` (`vite build`) → build de producción limpio.
- Arranque/shutdown real:
  `PORT=5099 JWT_SECRET=... JWT_REFRESH_SECRET=... NODE_ENV=production node server/index.js`
  arranca limpio; `GET /health` ahora incluye
  `"redis":{"configured":false,"connected":false}`; `GET /api/readiness`
  devuelve 503 (esperado en este entorno sin feeds de exchange reales
  conectados — comportamiento sin cambios respecto a antes de este fix);
  `SIGTERM` corre el watchdog de shutdown y el proceso termina limpio.

### Pendiente real para la siguiente sesión

- **Terminar M-5 de verdad**: resolver el seam de testing descrito arriba
  para poder des-skipear los 2 tests de `_flushRetryQueueForTests`. Es la
  única deuda de testing real dejada por esta sesión — la lógica de
  producción ya está escrita, wireada y verificada por revisión manual,
  pero falta la cobertura automática de esos dos casos específicos.
- **H-1** (validación con Zod/Joi/AJV), **H-9** (prefijo `/api/v1/`,
  bloqueado por Q2), **H-10** (Spanish → English, multi-archivo grande) —
  sin tocar, mismo criterio de sesiones anteriores.
- **M-3, M-6, M-7** — sin tocar.
- **L-1, L-3, L-4, L-5** — sin tocar (polish). L-2 se cerró en esta sesión.
- **Q1-Q5** (Open Questions) siguen sin respuesta del usuario — siguen
  bloqueando H-9, H-10, L-4 y C-5.
- Nota para la próxima sesión: seguir verificando el código antes de asumir
  que un ítem del plan sigue pendiente — este proyecto ya tuvo varios casos
  (H-3, mitad de M-4) donde el plan estaba desactualizado.

## Sesión 7 — Cierre real de M-5 (des-skip de los 2 tests de retry-queue)

### Baseline

- `npm ci` limpio.
- `npx vitest run` → **1192 passed | 2 skipped (1194 total)** — coincide
  exactamente con lo esperado.

### Investigación: la teoría de la Sesión 6 era incorrecta

La Sesión 6 documentó el problema como una "ventana async" entre
`setReadyState(1)` y el `await` de `_flushRetryQueueForTests()`, y afirmó
haber verificado por marcador de identidad que el `mongoose` ESM del test
y el `require('mongoose')` interno de `persistenceService.js` eran la
misma instancia mockeada.

Se investigó empíricamente (con tests de sonda descartables, borrados al
terminar) antes de tocar el approach, tal como pedía el handoff. Resultado:
**esa verificación de identidad era incorrecta**. En este setup de Vitest:

- `import mongoose from 'mongoose'` (ESM, en el test) y
  `require('mongoose')` (CJS, dentro de `persistenceService.js`) resuelven
  a **dos instancias distintas** — confirmado con `mongoose !== require('mongoose')`.
- Dos `require('mongoose')` consecutivos sí devuelven el mismo objeto (el
  cache de `require` funciona bien) — el problema es específicamente
  ESM-import vs CJS-require del mismo specifier bajo `vi.mock('mongoose', ...)`.
- Esto explica por qué los tests de "enqueue" (readyState=0) pasaban
  igual: el `readyState` interno de `persistenceService.js` también
  arranca en `0` por defecto, así que ambas instancias coincidían "por
  casualidad" cada vez que el test quería `readyState=0`. Solo se
  rompía cuando un test necesitaba que `readyState=1` fuera visible del
  lado de producción — exactamente los 2 tests skippeados.
- Segundo hallazgo, al arreglar el primero: con `readyState` ya
  reportando `1` correctamente, `_flushRetryQueue()` llega de verdad a
  `SessionDoc.create()`. Ese `SessionDoc.js` también hace
  `require('mongoose')` internamente — y esa cadena de `require()`
  resuelve al **mongoose real (sin mockear)**, con un modelo sin conexión
  viva. Sin un spy activo, `.create()` se queda colgado indefinidamente
  (buffering de comandos esperando conexión) en vez de resolver o
  rechazar. Esto también estaba enmascarado antes porque los tests que sí
  pasaban siempre espiaban `SessionDoc.create` antes de necesitarlo.

### Fix aplicado

**`server/infrastructure/persistenceService.js`**: se agregó el seam
test-only sugerido en el handoff — no un parámetro inyectado en cada
función pública (hubiera tocado todos los call sites en
`arbitrageOrchestrator.js` y ampliado el alcance innecesariamente), sino
una referencia interna reasignable:
- `_mongooseRef` (por defecto el `require('mongoose')` de siempre).
- `_readyState()` — helper que centraliza la lectura de
  `_mongooseRef.connection.readyState`; reemplazó las 9 lecturas directas
  de `mongoose.connection.readyState` dispersas en el archivo (mismo
  comportamiento en producción, cero cambio funcional).
- `_setMongooseForTests(m)` / `_resetMongooseForTests()` — exportados
  solo para tests, permiten que un test apunte el módulo a su propia
  instancia mockeada de `mongoose` en vez de depender de que ambas
  coincidan por casualidad.

**`tests/persistenceService.test.js`** (describe `M-5`):
- `beforeEach` ahora llama `persistenceService._setMongooseForTests(mongoose)`
  (el `mongoose` ESM del propio archivo de test) y agrega un
  `vi.spyOn(SessionDoc, 'create').mockResolvedValue(...)` por defecto, para
  que cualquier llamada real a `_flushRetryQueue()` que llegue hasta el
  write nunca golpee el mongoose real sin mockear. Los tests que necesitan
  simular un fallo siguen sobreescribiendo con `mockRejectedValueOnce`.
- `afterEach` agrega `persistenceService._resetMongooseForTests()`.
- **Los 2 `it.skip` se des-skipearon** y ahora pasan por la razón correcta
  (no por casualidad de estado por defecto).
- Los comentarios largos que documentaban la teoría incorrecta de la
  Sesión 6 se reemplazaron por la explicación real, para que la próxima
  sesión no tenga que re-investigar esto.

Cambio acotado a `persistenceService.js` y su test — no se tocó
`arbitrageOrchestrator.js` ni ningún otro call site, tal como pedía el
handoff.

### Verificación final de esta sesión

- `npx vitest run` → **1194 passed | 0 skipped (1194 total)**. Los 1192
  tests previos siguen pasando sin cambios; los 2 que estaban en skip
  ahora pasan de verdad. Ningún test existente se rompió.
- `npx eslint src/ server/ --ext .js,.jsx` → limpio, 0 errores/warnings.
- `npx tsc --noEmit` → limpio, 0 errores.
- `npm run build` (`vite build`) → build de producción limpio (973
  módulos, sin warnings nuevos).
- Arranque/shutdown real:
  `PORT=5099 JWT_SECRET=test JWT_REFRESH_SECRET=test2 NODE_ENV=production node server/index.js`
  arranca limpio; `GET /health` responde `"redis":{"configured":false,"connected":false}`
  igual que antes; `GET /api/readiness` devuelve 503 (esperado en este
  entorno sin feeds de exchange reales conectados, sin cambios respecto a
  la Sesión 6); `SIGTERM` termina el proceso limpiamente (verificado: sin
  proceso colgado tras la señal).

### Pendiente real para la siguiente sesión

- **M-5 está cerrado de verdad ahora** — 0 tests en skip, cobertura real
  de los 2 casos (drain exitoso y re-queue tras fallo durante flush).
- **M-3, M-6, M-7** — sin tocar.
- **H-1** (validación con Zod/Joi/AJV), **H-9** (prefijo `/api/v1/`,
  bloqueado por Q2), **H-10** (Spanish → English, multi-archivo grande) —
  sin tocar, mismo criterio de sesiones anteriores.
- **L-1, L-3, L-4, L-5** — sin tocar (polish).
- **Q1-Q5** (Open Questions) siguen sin respuesta del usuario — siguen
  bloqueando H-9, H-10, L-4 y C-5.
- Nota general para futuras sesiones sobre este mismo archivo: si se
  vuelve a tocar `persistenceService.js` o su test, tener en cuenta que
  **ESM `import` y CJS `require()` del mismo módulo mockeado no son
  necesariamente la misma instancia** en este setup de Vitest — no asumir
  identidad compartida sin verificarla primero (como pasó en la Sesión 6).

## Sesión 8 — M-7 parcial (integration tests HTTP reales: auth flow + SSE auth gate)

### Baseline

- `npm ci` limpio.
- `npx vitest run` → **1194 passed | 0 skipped (1194 total)** — coincide
  exactamente con el cierre de la Sesión 7. Se procedió sin re-investigar
  nada del M-5 ya cerrado.

### M-7 — Integration tests HTTP → response cycle real

El plan original pedía específicamente tests de integración basados en
supertest para: auth flow, trading mode switch, y conexión SSE. Al
revisar el código (no asumir), se confirmó que **trading mode switch ya
estaba cubierto de punta a punta** por `tests/twoFactorTradingGate.e2e.test.js`
(supertest contra la `app` real exportada por `server/index.js`, mismo
patrón que este código ya establece). Los otros dos — auth flow y SSE —
no tenían ningún test que pegara HTTP real contra la `app`.

**Archivos nuevos:**

1. **`tests/authFlow.e2e.test.js`** (8 tests) — contra la `app` real vía
   supertest:
   - `POST /api/auth/register`: rechaza email inválido y password corto
     con 400 **antes** de tocar la DB (probado con Mongo desconectado, así
     que si estos tests dieran 503 en vez de 400 significaría que la
     validación no corre primero); y devuelve `503 {code:'DB_UNAVAILABLE'}`
     para input por lo demás válido cuando Mongo no está conectado (este
     entorno) — mismo mecanismo de degradación que H-4 pide, verificado
     aquí en la frontera HTTP real en vez de solo a nivel de módulo.
   - `POST /api/auth/login`: mismo patrón (400 de validación, 503
     DB_UNAVAILABLE).
   - Rutas protegidas sin token (`GET /me`, `POST /logout`) → 401 a través
     de la cadena real de middlewares (cookies, CORS, body parsing, rate
     limiting), no solo probando `requireAuth` como función aislada.
   - Nota de alcance explícita en el header del archivo: el happy path
     completo de registro/login (creación real de usuario, hash de
     password, emisión de JWT) requiere Mongo real y no se puede probar
     end-to-end en este entorno sandbox sin base de datos — sí está
     cubierto a nivel unitario en otros archivos de test existentes.

2. **`tests/sseConnection.e2e.test.js`** (5 tests) — contra la `app` real:
   - `GET /api/arbitrage/stream` y `/alerts-stream` rechazan con 401 sin
     ticket o con un ticket inválido.
   - `POST /api/auth/stream-ticket` requiere autenticación (401 sin
     bearer).
   - Un usuario autenticado puede obtener un ticket real vía HTTP, y el
     ticket es un string opaco no vacío.
   - **Decisión de alcance, documentada en el propio archivo**: se
     intentó también abrir la conexión SSE real (`GET
     /api/arbitrage/stream` con un ticket válido) y verificar
     `200`/`text/event-stream`, primero esperando el evento `'response'`
     de superagent y abortando el socket después. Se descartó tras
     confirmarlo empíricamente: el handler de `/stream` llama
     `getOrderBooks()`/`detectOpportunities()` antes de escribir el primer
     evento, y sin feeds de exchange reales conectados en este sandbox esa
     inicialización no resuelve dentro de un timeout de test razonable
     (se probó con 4s, sin éxito) — exactamente el mismo tipo de
     rabbit hole de test colgado que ya costó una sesión completa (Sesión
     7, ver arriba) por una razón distinta. Perseguir esto más no vale la
     cobertura marginal adicional; lo que sí importa de "SSE connection"
     para M-7 — el gate de autenticación de punta a punta — ya está
     cubierto por los otros 4 tests del archivo.

### Verificación final de esta sesión

- `npx vitest run` → **1207 passed | 0 skipped (1207 total)** — 1194
  previos + 13 nuevos (8 de `authFlow.e2e.test.js` + 5 de
  `sseConnection.e2e.test.js`). Ningún test existente se rompió ni se
  modificó. Corrido también en aislamiento (`vitest run
  tests/authFlow.e2e.test.js tests/sseConnection.e2e.test.js`) para
  confirmar que no hay orden de ejecución accidental del que dependan.
- `npx eslint src/ server/ --ext .js,.jsx` → limpio, 0 errores/warnings
  (mismo alcance de lint que todas las sesiones anteriores — `tests/`
  nunca estuvo incluido en este comando en ninguna sesión previa; correrlo
  también contra `tests/` da falsos positivos `no-undef` para
  `describe`/`it`/`expect` en *todos* los archivos de test existentes, no
  solo los nuevos, porque esos globals de Vitest no están declarados para
  ese comando — no es una regresión introducida aquí).
- `npx tsc --noEmit` → limpio, 0 errores.
- `npm run build` (`vite build`) → build de producción limpio, 973 módulos.
- Arranque/shutdown real:
  `PORT=5099 JWT_SECRET=test JWT_REFRESH_SECRET=test2 NODE_ENV=production node server/index.js`
  arranca limpio; `GET /health` y `GET /api/readiness` responden igual que
  en la Sesión 7 (sin cambios de comportamiento — esta sesión solo agregó
  tests, no tocó código de producción); `SIGTERM` termina el proceso
  limpiamente.

### Pendiente real para la siguiente sesión

- **M-7 queda parcialmente cerrado**: las 3 rutas explícitamente nombradas
  en el plan (auth flow, trading mode switch, SSE) ya tienen integration
  tests HTTP reales. Lo que el plan pedía más ampliamente ("integration
  tests for critical routes") sigue abierto para otras rutas críticas no
  nombradas explícitamente (ej. `/api/arbitrage/config`, `/api/arbitrage/reset`,
  rutas de wallets/rebalance) — evaluar cuáles son suficientemente
  críticas para justificar más tests de este tipo, sin intentar cubrir
  las ~30+ rutas del proyecto en una sola sesión.
- **M-3** (payload SSE de ~50+ campos en cada tick, sin deltas ni canales
  separados) — sin tocar. Es un cambio de forma de datos con impacto en
  el frontend (`src/hooks/useArbitrageStream.js` y todo lo que consume el
  evento `'init'`/`'tick'`), no acotado a backend — requiere decidir
  primero si se hace un rediseño incremental (mantener el shape actual
  pero solo enviar el delta) o un cambio de protocolo más grande
  (canales/topics). Recomendado abrir como su propia sesión dedicada, no
  combinarlo con otros pendientes.
- **M-6** (subir umbrales de cobertura — actualmente lines:65,
  functions:58, branches:50, statements:62 — a 80/70) — sin tocar. Antes
  de subir los umbrales hay que escribir tests reales para los archivos
  que el propio plan señala en 0%/bajo coverage
  (`arbitrageOrchestrator.js`, `exchangeService.js`, partes de
  `liveExecution.js`); subir el umbral primero sin eso solo rompe el CI.
  Candidato natural para la próxima sesión si se prioriza robustez de
  tests sobre nuevos features.
- **H-1** (validación con Zod/Joi/AJV), **H-9** (prefijo `/api/v1/`,
  bloqueado por Q2), **H-10** (Spanish → English, multi-archivo grande) —
  sin tocar, mismo criterio de sesiones anteriores: alcance grande,
  requieren su propia sesión dedicada para no mezclar cambios grandes sin
  verificación cruzada completa.
- **L-1** (revisar si `server-types/` debería documentarse/integrarse
  formalmente al build en vez de solo funcionar) — parcialmente ya
  abordado de facto en la Sesión 3 (se corrigieron los `.d.ts`/imports
  para que `tsc` compile limpio), pero falta el ADR explícito que el plan
  pide. Bajo costo, buen candidato rápido para abrir la próxima sesión.
- **L-3** (CHANGELOG.md de 32KB, contenido histórico de "rondas" no
  claramente real vs generado) — **deliberadamente no tocado esta
  sesión**: es un cambio de contenido/juicio editorial sobre historial del
  proyecto (qué mantener, qué resumir, qué borrar), no un fix de código
  verificable con tests — mayor riesgo de pérdida de información real si
  se hace apurado al final de una sesión. Recomendado que el usuario
  revise qué "rondas" quiere conservar antes de que una sesión de código
  las recorte unilateralmente.
- **L-4** (limpiar configs de deploy redundantes: Procfile/railway/render/vercel)
  — sigue bloqueado por Q2 (plataforma de producción real), como en
  sesiones anteriores.
- **L-5** (estrategia de migraciones de DB) — sin tocar, alcance grande.
- **Q1-Q5** (Open Questions) siguen sin respuesta del usuario — siguen
  bloqueando H-9, H-10, L-4 y C-5. No son resolubles escribiendo código;
  si el usuario no las responde, seguir saltándolas y trabajar en lo que
  sí se puede avanzar, como se ha hecho en todas las sesiones anteriores.
- Nota general: en esta sesión, igual que en la 6/7, el instinto correcto
  ante un test que empieza a colgarse (el intento inicial de SSE abierta)
  fue **cortar por lo sano y documentar la decisión de alcance**, en vez
  de seguir persiguiéndolo — no todo lo que el plan pide vale la pena
  perseguir hasta el final si el costo de tiempo/riesgo de un test frágil
  supera el valor de la cobertura marginal.

## Sesión 9 — L-1 (ADR de `server-types/`) + investigación de M-6

### Baseline

- `npm ci` limpio (sandbox reutilizado de la Sesión 8 en la misma
  conversación — mismo `node_modules`).
- `npx vitest run` → **1207 passed | 0 skipped (1207 total)** — coincide
  exactamente con el cierre de la Sesión 8.

### L-1 — ADR de la relación `server-types/` ↔ `server/*.js` compilado

**Investigación** (no asumida): se leyó `tsconfig.json`,
`package.json` y `.github/workflows/ci.yml` para confirmar la mecánica
real antes de escribir la ADR:
- `tsconfig.json` (`rootDir: server-types`, `outDir: "."`) mapea cada
  `server-types/server/<ruta>.ts` a `server/<ruta>.js`.
- `package.json` tiene dos comandos distintos: `typecheck` (`tsc --noEmit`,
  no escribe nada) y `build:ts` (`tsc` sin `--noEmit`, sí sobreescribe).
- CI (`.github/workflows/ci.yml`) solo corre `tsc --noEmit` — **ningún
  pipeline automatizado corre `build:ts`**. Ni `server-types/` ni los
  `.js` generados están en `.gitignore` — ambos (fuente y artefacto
  compilado) se comitean juntos a git.
- Conclusión: los `.js` compilados que corren en producción son
  artefactos comiteados a mano, regenerados manualmente por quien edita
  el `.ts`. CI solo verifica que el `.ts` siga compilando (red de
  seguridad), no regenera nada.

**Archivo nuevo**: `docs/ADR-013-server-types-build-relationship.md` —
documenta esta mecánica, referencia el incidente real de la Sesión 3
(edición a mano de un `.js` compilado que causó una regresión al correr
`tsc` en otro archivo), y fija 4 reglas explícitas (nunca editar los
`.js` generados a mano; correr la suite completa después de
`build:ts`; CI se mantiene intencionalmente solo como type-check;
`.d.ts` deben reflejar la ubicación real de los módulos). Mismo formato
que ADR-010/011/012 ya existentes. Cambio puramente declarativo — cero
código tocado.

### M-6 — investigado, no iniciado (decisión explícita)

Se corrió `npx vitest run --coverage` para tener el estado real (el plan
original cita 65/58/50/62 — desactualizado, como ya pasó con otros
ítems). Estado real al cierre de esta sesión:

- **Totales**: statements 63.95%, branches 53.51%, functions 60.44%,
  lines 67.48% — similar al plan original, ligera mejora por los tests
  de sesiones recientes.
- **`arbitrageOrchestrator.js`**: 62.01% statements — **no 0% como decía
  el plan original**. Ya tiene cobertura real de M-1 (backoff del loop) y
  otros fixes de sesiones anteriores. Otro caso de plan desactualizado,
  igual que H-3 y la mitad de M-4 en sesiones previas — anotarlo para que
  la próxima sesión no vuelva a asumir 0%.
- **`liveExecution.js`**: 86.11% statements — ya bien cubierto, tampoco
  necesita trabajo prioritario.
- **`exchangeService.js`**: el más débil de los tres que el plan señala —
  33.87% statements, 11.51% branches. Al revisar el archivo (646 líneas),
  el motivo real de la cobertura baja es el mismo problema que documenta
  **C-1** del plan: el módulo abre conexiones WebSocket reales al momento
  de `require()`. No existe en este proyecto ningún patrón ya establecido
  de mock para el módulo `ws` (se buscó en `tests/` y `vitest.config.js` —
  nada). Escribir tests reales y útiles (no solo tests que suban el
  número sin valor, criterio que este proyecto ya rechazó explícitamente
  en la Sesión 3 para `predictiveRebalance.js`) requeriría diseñar ese
  mock desde cero, potencialmente en conjunto con resolver C-1
  (desacoplar la conexión WS del `require()` del módulo) para que el
  archivo sea testeable de forma limpia en primer lugar.

**Decisión de esta sesión**: no escribir tests apurados para
`exchangeService.js` solo por avanzar el número de M-6. Es exactamente el
tipo de "fix a medias" que las reglas de sesión de este proyecto piden
evitar. Queda como el primer paso real de la próxima sesión dedicada a
M-6, con el diagnóstico ya hecho (qué archivo, por qué está bajo, qué
falta) para no repetir esta investigación.

### Verificación final de esta sesión

- `npx vitest run` → **1207 passed | 0 skipped (1207 total)**, sin
  cambios — esta sesión no tocó ningún archivo de `server/` ni `tests/`,
  solo agregó `docs/ADR-013-...md`.
- `npx eslint src/ server/ --ext .js,.jsx` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run build` → limpio, 973 módulos.
- Arranque/shutdown real (`PORT=5099 ... NODE_ENV=production node server/index.js`)
  → `GET /health` responde `ok:true` con el mismo shape que en sesiones
  anteriores; `SIGTERM` termina el proceso limpiamente.

### Pendiente real para la siguiente sesión

- **M-6**: ahora con diagnóstico completo, sin iniciar. Punto de entrada
  sugerido: diseñar un mock de `ws` (module-level) que permita instanciar
  `exchangeService.js` en tests sin abrir sockets reales — considerar si
  conviene resolver primero **C-1** (mover la conexión WS fuera de
  `require()`-time a una función `start()` explícita) porque simplifica
  mucho el mock necesario y además cierra un ítem de severidad más alta
  (🔴 Critical) al mismo tiempo. Evaluar como una sola sesión combinada
  C-1 + inicio de M-6, no como dos esfuerzos separados.
- **M-3** (payload SSE) — sin tocar, sigue recomendado como sesión propia
  dedicada por el riesgo de romper el frontend (ver Sesión 8).
- **H-1, H-9, H-10, L-3, L-4, L-5, Q1-Q5** — sin tocar, mismo estado y
  mismos criterios que la Sesión 8.
- **L-1 queda cerrado** — ADR-013 documenta la relación completa.

## Sesión 10 — C-4 (graceful shutdown coordinator) cerrado y verificado

### Baseline

- `npm ci` limpio, `npx vitest run` → **1207 passed | 0 skipped (1207 total)**
  — coincide exactamente con el cierre de la Sesión 9.
- Esta sesión partió de una revisión externa del estado real del proyecto
  (no del handoff de la Sesión 9 directamente) que encontró, leyendo código
  fuente, que **C-1, C-2, C-3, C-4, C-5 (los 5 críticos del plan original)
  seguían intactos sin que ninguna sesión lo hubiera reportado así de claro**,
  y que **H-2 (auth en el stream SSE principal) en realidad ya estaba
  resuelto** sin que ninguna sesión lo marcara como cerrado. Ver el análisis
  completo en la conversación previa a esta sesión.

### Investigación previa a tocar código (para no repetir el error de asumir)

Antes de decidir qué cerrar, se investigó el alcance real de dos candidatos:

- **H-6 (ETH bypassa `executeBestOpportunity()`)**: se leyó
  `executeSimulated()` en `opportunityDetection.js` y se confirmó que está
  **hardcodeada para BTC** (`wallets.BTC`, `wallets.USDT`, `getLastKnownBtcPrice()`
  dentro de `preTradeRiskCheck`). Rutear ETH a través de
  `executeBestOpportunity()` sin antes hacer `executeSimulated()`
  asset-aware produciría un fix a medias con alto riesgo de romper el
  cálculo de balance/riesgo para ambos activos. **Decisión: no tocar en
  esta sesión** — requiere su propia sesión dedicada a generalizar
  `executeSimulated()`/`preTradeRiskCheck()` por asset antes de poder
  unificar el path de ejecución de forma segura. Documentado como
  pendiente real, no como "cerrado a medias".
- **H-7 (RBAC)**: el único mecanismo de admin existente hoy es
  `ADMIN_TOKEN` en `stream.routes.js` (un solo endpoint). Agregar un
  middleware `requireRole('admin')` sin aplicarlo a ninguna ruta real no
  aporta protección real (queda como infraestructura sin uso) y decidir
  a qué rutas aplicarlo es una decisión de producto que no está
  especificada en el plan. **Decisión: no tocar** — dejar documentado
  para que el usuario decida qué rutas requieren rol admin antes de
  implementar el middleware.

### C-4 — Graceful shutdown coordinator: **cerrado y verificado end-to-end**

**Problema real** (confirmado leyendo `server/index.js` antes del fix): el
handler de `SIGTERM`/`SIGINT` solo hacía `server.close()`. No detenía el
loop de 150ms, no cerraba ninguna de las 5 conexiones WebSocket a
exchanges reales, no forzaba un flush de la cola de retry de persistencia
(M-5), no drenaba clientes SSE, y no cerraba la conexión de MongoDB
explícitamente.

**Fix aplicado** (3 archivos):

1. `server/application/arbitrageOrchestrator.js`: se agregó una bandera
   `_shuttingDown` y se export una función `stopEngine()`. El
   `serialLoop()` ahora chequea la bandera antes y después de cada
   `run()` y deja de reprogramarse a sí mismo con `setTimeout` una vez
   que `stopEngine()` fue llamado.
2. `server/infrastructure/exchangeService.js`: se agregó la misma
   bandera `_shuttingDown`, se guardó el ID del `setInterval` del
   watchdog (`_watchdogInterval`), y se agregó `closeAll()`: limpia el
   watchdog, marca `_shuttingDown = true` (lo que hace que
   `scheduleReconnect()` no haga nada — evita el problema de que
   `ws.terminate()` dispare una reconexión automática justo cuando el
   proceso está saliendo), y llama `.terminate()` en los 5 WebSockets
   activos.
3. `server/infrastructure/persistenceService.js`: se agregó un alias
   público `flushRetryQueueNow` (antes solo existía
   `_flushRetryQueueForTests`, marcado explícitamente como solo-test) para
   que el shutdown de producción pueda forzar un último intento de
   escribir lo que quedó en la cola de retry (M-5) antes de salir.
4. `server/index.js`: el handler de `shutdown(sig)` ahora es async y
   ejecuta, en orden, con cada paso en su propio try/catch (una falla en
   un paso no bloquea los siguientes ni el exit final):
   1. `arbitrageOrchestrator.stopEngine()`
   2. `exchangeService.closeAll()`
   3. `persistenceService.flushRetryQueueNow()` + detener los 3 timers
      periódicos de persistencia
   4. Drenar `sseClients`/`alertsClients`/`notificationClients`
      (`res.end()` en cada cliente conectado)
   5. `mongoose.connection.close()` si había una conexión activa
   6. `server.close()` → `process.exit(0)`
   Se mantiene el failsafe de forzar `process.exit(1)` a los 5s si algo
   se cuelga.

**Verificación real, no solo lectura de código**:
- `npx vitest run` → **1207/1207**, sin cambios — ningún test existente
  dependía del comportamiento viejo del shutdown.
- `npx eslint` limpio, `npx tsc --noEmit` limpio, `npm run build` limpio.
- **Arranque y shutdown real end-to-end**: se levantó el servidor con
  `NODE_ENV=production`, se confirmó `/health` respondiendo `ok:true`
  con el loop corriendo (`engine.running:true`), se envió `SIGTERM` al
  proceso real, y se verificó en el log:
  - `"SIGTERM — graceful shutdown initiated"` (nuestro log)
  - `[watchdog] Graceful shutdown initiated (SIGTERM)...` seguido de
    `[watchdog] Shutdown complete in 7ms` (el watchdog interno del
    proyecto, ya existente, sigue funcionando en paralelo sin conflicto)
  - **Cero errores** en ninguno de los 5 pasos del coordinator (se
    verificó explícitamente que no aparece ningún log `"shutdown: ...
    failed"`)
  - El proceso terminó (`kill -0` confirmó que ya no existía) sin
    necesidad de que el failsafe de 5s lo forzara.
  - Tras el `SIGTERM` no se vieron más intentos de reconexión de
    ninguno de los 5 exchanges (antes del fix, el watchdog + reconnect
    seguían intentando conectar indefinidamente incluso después de que
    el proceso empezara a salir).

### Verificación final de esta sesión

- `npx vitest run` → **1207 passed | 0 skipped (1207 total)**.
- `npx eslint src/ server/ --ext .js,.jsx` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run build` → limpio.
- Arranque/shutdown real confirmado como se describe arriba (no solo
  arranque — esta vez también se verificó el shutdown completo, que las
  sesiones anteriores no habían probado con SIGTERM real a un proceso
  con el loop y los WebSockets corriendo).

### Pendiente real para la siguiente sesión

- **C-1** (`exchangeService.js` conecta WS reales a `require()`-time):
  intacto. Es el desbloqueador de mayor apalancamiento — de él depende
  también M-6 en `exchangeService.js`.
- **C-2** (rutas de trading inline en `server/index.js`): intacto.
- **C-3** (estado mutable global disperso): intacto.
- **C-5** (`advancedRiskEngine.js` como artefacto TS compilado
  hand-editado): intacto, bloqueado además por Q1 sin responder.
- **H-1, H-4, H-5, H-9, H-10**: intactos, sin tocar.
- **H-6**: investigado esta sesión, diagnóstico completo (ver arriba),
  decisión explícita de no tocar hasta generalizar `executeSimulated()`
  por asset.
- **H-7**: investigado esta sesión, diagnóstico completo (ver arriba),
  necesita decisión de producto (qué rutas son admin-only) antes de
  implementar el middleware.
- **M-3, M-6, M-8, M-9, M-10, M-11**: sin tocar, mismo estado que
  Sesión 9.
- **L-3, L-4, L-5**: sin tocar, L-4 sigue bloqueado por Q2.
- **Q1-Q5**: siguen sin respuesta del usuario.

## Sesión 21 — Smoke test HTTP real confirmado (pendiente de Sesión 20); H-6 remainder (tracking de precio ETH) cerrado y verificado; H-5 NO iniciado (queda para la siguiente sesión)

### Smoke test HTTP real (pendiente explícito de la Sesión 20)

La Sesión 20 no había podido correr el arranque/shutdown HTTP real por
inestabilidad puntual del sandbox. Esta sesión lo corrió con éxito:

- Arranque real (`node server/index.js`, `NODE_ENV=production`,
  `JWT_SECRET`/`JWT_REFRESH_SECRET` reales) → `/health` responde
  `engine.running: true`.
- **Verificación en vivo de H-7 (RBAC de la Sesión 20)**: se firmaron JWTs
  reales con el mismo secreto del servidor (`role:'user'` y
  `role:'admin'`) y se golpeó `POST /stress-test/activate` con ambos —
  `role:'user'` → `403 INSUFFICIENT_ROLE`, `role:'admin'` → `200 ok:true`.
  Confirma que `requireRole` funciona en producción, no solo en tests
  mockeados.
- `GET /api/arbitrage/eth-books` respondió sin 500 (los exchanges
  devolvieron 403 por ser IPs de sandbox sin whitelistear, pero el
  endpoint en sí no rompió).
- `SIGTERM` → shutdown graceful confirmado en el log (`watchdog: Shutdown
  complete in 7ms`), sin procesos huérfanos después.

### H-6 remainder (gap documentado en la Sesión 20) — CERRADO

La Sesión 20 había dejado explícitamente anotado que `_capitalUSD` dentro
de `executeBestOpportunity()` solo sumaba BTC + USDT porque no existía
tracking de precio ETH. Esta sesión:

- Agregó `getLastKnownEthPrice()` / `setLastKnownEthPrice()` en
  `arbitrage.state.js`, mismo patrón exacto que
  `getLastKnownBtcPrice`/`setLastKnownBtcPrice` (fallback `$2500`, setter
  ignora valores no positivos).
- `arbitrageOrchestrator.js`: el bloque de detección ETH (cada tick par,
  ~300ms) ahora extrae el mejor ask de Binance (o el primero disponible)
  del `ethBooks` y llama `setLastKnownEthPrice(ethPrice)` — mismo patrón
  que el bloque BTC ya existente.
- `_capitalUSD` en `executeBestOpportunity()` ahora suma
  `ETH_holdings * getLastKnownEthPrice()` además de BTC y USDT.
- `GET /risk/status` (query.routes.js) actualizado igual, para
  consistencia — usaba la misma fórmula incompleta.

**Verificación:**
- 3 tests nuevos en `arbitrage.state.test.js` (fallback, update, ignora
  no-positivos — mismo patrón que los tests BTC existentes).
- 1 test nuevo en `arbitrageOrchestrator.test.js` confirmando que
  `preTradeRiskCheck` recibe un `capitalUSD` que incluye la contribución
  de ETH.
- 1 test nuevo en `arbitrage.query.routes.test.js` confirmando lo mismo
  para `advRisk.getStatus` en `/risk/status`.
- Suite completa: **1261 passed | 0 failed**. Lint limpio. `tsc --noEmit`
  limpio. `check:ts-drift` sin drift (este cambio no toca ningún archivo
  TS compilado — `arbitrage.state.js` y `arbitrageOrchestrator.js` son JS
  puro, no generados desde `server-types/`).
- Smoke test HTTP real repetido después del cambio: arranque OK,
  `engine.running: true`, shutdown graceful OK.

### H-5 — NO iniciado esta sesión

Por presupuesto de tiempo/tokens, esta sesión se enfocó en cerrar el
pendiente explícito de la Sesión 20 (smoke test + gap de H-6) con la
misma rigurosidad de verificación, en vez de empezar apurado un refactor
grande. **H-5 (partir `arbitrageLoop()`, ~798 líneas, 0% cobertura
directa) sigue intacto** y es el pendiente más grande y de mayor riesgo
que queda. Ver la Sesión 20 para la recomendación de abordaje (extraer
sub-funciones puras de a una: detección → scoring → selección →
ejecución → housekeeping, verificando cada extracción con tests +
arranque real antes de seguir).

### Pendiente real para la siguiente sesión (mismo orden que Sesión 20, sin cambios)

1. **H-5**: partir `arbitrageLoop()` — ver guía de abordaje arriba y en
   Sesión 20. Es el ítem prioritario ahora que el gap de H-6 está cerrado.
2. Robustez y parametrización en general.
3. M-8/M-9/M-10/M-11 (frontend).
4. L-3 (`CHANGELOG.md`): sigue bloqueado — **necesita que el usuario
   indique qué "rondas" históricas conservar** antes de tocarlo.
5. C-3 (estado mutable global disperso) y H-9 (bloqueado por Q2): intactos.
6. H-10 (multi-idioma real) al final, después de todo lo demás.



### Contexto de arranque

Esta sesión retoma un chat anterior que se quedó sin tokens a mitad de un
diagnóstico de H-6. Ese chat había producido (pero no empaquetado) tres
archivos ya corregidos: `server-types/server/domain/walletManager.ts`,
`server/arbitrage/subroutes/query.routes.js` y
`tests/arbitrage.query.routes.test.js`. El zip que el usuario tenía a mano
(`kukora_session19.zip`) seguía siendo el estado de la Sesión 19 (verificado
con `grep` — el `query.routes.js` del zip no tenía `validateBody` aplicado
todavía). Primer paso de esta sesión: reconciliar — integrar esos 3 archivos
sobre el zip de Sesión 19, y verificar antes de asumir que estaban completos.

### Ítem #16 (Sesión 19, pendiente) — CERRADO

Los 3 schemas Zod ya escritos en `arbitrageValidation.js`
(`StressTestActivateBodySchema`, `ArbBacktestSimulateBodySchema`,
`MlScoreBodySchema`) se aplicaron con `validateBody(...)` a
`POST /stress-test/activate`, `POST /arb-backtest/simulate` y
`POST /ml/score` en `query.routes.js`, preservando el chequeo manual
existente en `/ml/score` como defensa en profundidad (los tests unitarios
llaman al handler final directamente, saltándose el middleware a
propósito). Se agregaron tests de integración reales contra el middleware
(no solo contra el handler) para los 3 endpoints.

### H-6 — bug real más profundo de lo que el plan original describía

El plan decía "rutear la ejecución de ETH por `executeBestOpportunity()`
para paridad de risk-checks". Al investigar el código real (no asumir),
apareció algo más grave: **`_applyTradeInternal` (walletManager) y
`executeSimulated` (opportunityDetection) estaban hardcodeados a
`wallets.BTC`**, sin importar qué dijera `trade.asset`. El campo
`asset: 'ETH'` se adjuntaba al trade *después* de que ambas funciones ya
habían operado — nunca se leía. Consecuencia real: **todo trade "ETH" en
producción debitaba/acreditaba el wallet de BTC bajo una etiqueta falsa**,
y ni siquiera existía un bucket `ETH` en `INITIAL_BALANCES`. Los números de
P&L reportados como "ETH" eran en realidad movimientos del balance BTC
mal etiquetados — un bug de contabilidad financiera, no solo de risk-checks
faltantes.

`walletManager.js` es un artefacto TS compilado (`server-types/.../
walletManager.ts` → `server/domain/walletManager.js`, ver ADR-013). El fix
se hizo en el `.ts` fuente y se regeneró con `npx tsc` (build:ts real, no
solo `--noEmit`), verificado después con `npm run check:ts-drift` (sin
drift) para no repetir el incidente de la Sesión 3.

**Cambios:**
- `Wallets` ahora tiene un bucket `ETH` (`WALLET_ETH` env var, default 40
  ETH/exchange — notional comparable a 1 BTC con precios de referencia
  usados en el proyecto).
- `IncomingTrade.asset?: 'BTC' | 'ETH'` es parte del contrato de entrada.
- `_applyTradeInternal` elige `wallets[asset]` en vez de `wallets.BTC`
  hardcodeado — default `'BTC'` preserva el comportamiento exacto para
  todo caller existente que nunca puso `asset`.
- `executeSimulated` (opportunityDetection.js) generalizado igual: el
  chequeo de saldo del lado cripto ahora usa `wallets[asset]`, y el trade
  que produce incluye `asset` desde el origen (no se adjunta después).
- `getPnL` acepta un segundo parámetro opcional `currentEthPrice` para que
  el P&L no realizado también refleje drift de ETH — retrocompatible
  (default `null`, 0 contribución, idéntico al comportamiento anterior).
- `arbitrageOrchestrator.js`: el bloque de ejecución de ETH en
  `arbitrageLoop()` ya NO llama `executeSimulated`/`applyTrade`
  directamente — pasa por `executeBestOpportunity()`, la misma ruta
  unificada que BTC (risk check, state machine, audited P&L, alertas).

**Límite de alcance documentado explícitamente:** `_capitalUSD` dentro de
`executeBestOpportunity()` sigue calculando capital solo con BTC + USDT —
no incluye el valor en USD de las tenencias de ETH porque no existe
todavía un `getLastKnownEthPrice()` (no hay tracking de precio ETH en
`arbitrage.state.js`). Esto significa que el risk engine subestima
ligeramente el capital total cuando hay posición en ETH. Añadir esto es un
cambio pequeño y bien acotado — pendiente real para la siguiente sesión
(ver abajo).

**Verificación:**
- Sanity check real (no solo tests): `node -e` ejecutando `applyTrade` con
  `asset:'ETH'` y confirmando que el wallet BTC queda *byte-a-byte*
  intacto mientras el ETH se mueve correctamente.
- Tests nuevos: 4 en `walletManager.test.js` (bucket ETH, aislamiento
  BTC/ETH, default legacy a BTC, rechazo por saldo ETH insuficiente,
  `getPnL` con `currentEthPrice`), 2 en `arbitrageOrchestrator.test.js`
  (paridad de ejecución ETH vía `executeBestOpportunity`, partial fill
  acotado al saldo ETH real, no BTC).
- `npx tsc --noEmit` limpio antes del build real.
- `npm run build:ts` (tsc real) regeneró `server/domain/walletManager.js`.
- `npm run check:ts-drift` → sin drift.
- Suite completa, lint, tsc, build: todo limpio (ver cierre de sesión).

### H-7 — RBAC real, con la precaución de no romper el demo en vivo

La Sesión 19 había dejado esto bloqueado por "necesita decisión de
producto". Se investigó el código real antes de implementar: el campo
`role` (`enum: ['user','admin']`, default `'user'`) existe en el User
model desde el principio y ya viaja dentro del JWT (`generateAccessToken`
ya incluía `role: user.role`) — pero **no existía NINGÚN camino** (seed
script, endpoint, flag de registro) para que un usuario real terminara
con `role: 'admin'`. Si se hubiera gateado cualquier endpoint detrás de
`requireRole('admin')` sin resolver esto primero, **nadie —incluyendo al
dueño del proyecto— habría podido usar esos endpoints nunca**, rompiendo
el demo en vivo para los jueces. Este es exactamente el tipo de error que
sesiones anteriores evitaron pausando H-7 en vez de implementarlo a
medias.

**Solución de dos partes:**
1. `requireRole(...allowedRoles)` — middleware nuevo en
   `server/infrastructure/auth.js`. Debe montarse siempre después de
   `requireAuth` (lee `req.user.role`, poblado desde el JWT). 401 si no
   hay `req.user`, 403 (`code: INSUFFICIENT_ROLE`) si el rol no está en la
   lista permitida.
2. `ADMIN_EMAILS` (env var, coma-separado, case-insensitive) — la fuente
   de verdad para quién es admin. `_resolveRole(email)` + `_syncRole(user)`
   se llaman en **register, login y Google OAuth**: si el email del
   usuario está en `ADMIN_EMAILS`, se promueve automáticamente en su
   próximo login (sin migración de DB, sin tocar Mongo a mano). Documentado
   en `.env.example`.

**Endpoints gateados con `requireRole('admin')`** (criterio: acciones de
"ops/chaos engineering", no configuración normal de trading — para no
bloquear el flujo principal del demo a un usuario autenticado normal):
- `POST /risk/circuit-breaker/reset`
- `POST /stress-test/activate` y `POST /stress-test/deactivate`
- `POST /adversarial/run`

**Deliberadamente NO gateados** (cualquier usuario autenticado los sigue
usando igual que antes): `POST /config`, `POST /config/reset`,
`POST /mode`, `POST /pairs`, `POST /rebalance/execute` — son la
funcionalidad central de trading que el demo necesita que cualquier
usuario logueado pueda tocar directamente.

**Verificación:**
- Tests nuevos: 5 en `auth-core.test.js` (401 sin `req.user`, 403 con rol
  no permitido, next() con rol correcto, múltiples roles permitidos,
  default a `'user'` cuando falta el campo — nunca admin por omisión) +
  1 test de promoción real vía `ADMIN_EMAILS` en el flujo de registro.
  Tests de rechazo 403 agregados para los 4 endpoints gateados en
  `arbitrage.query.routes.test.js` y `arbitrage.config.routes.test.js`,
  con los tests existentes de `validateBody` corregidos para el nuevo
  orden de middleware (`requireRole` → `validateBody` → handler).

### Verificación final de esta sesión

- `npx vitest run` → **1256 passed | 0 failed (1256 total)**.
- `npx eslint src/ server/ --ext .js,.jsx` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run check:ts-drift` → sin drift (6 archivos verificados).
- `npm run build` → limpio (Vite build completo).
- **No se repitió el smoke test de arranque/shutdown HTTP real** (a
  diferencia de sesiones anteriores) — un intento de backgrounding causó
  inestabilidad en el sandbox de esta sesión (el proceso backgroundeado
  colgó al tool de bash). En su lugar se verificó el fix crítico (wallet
  ETH) con una invocación real de la función vía `node -e` (ver arriba),
  que es evidencia funcional equivalente para ese caso puntual. **Se
  recomienda que la siguiente sesión sí corra el smoke test HTTP completo**
  antes de dar por buena esta entrega para producción.

### Pendiente real para la siguiente sesión (en el orden de prioridad del usuario)

1. **H-5**: partir `arbitrageLoop()` (~798 líneas, 0% cobertura directa)
   en funciones testeables. Es el ítem más grande y riesgoso que queda —
   toca el loop principal de trading en producción. Recomendación: NO
   apurarlo; diseñar primero qué sub-funciones puras se pueden extraer
   (detección → scoring → selección → ejecución → housekeeping) antes de
   tocar código, y verificar cada extracción con el server real
   arrancando (smoke test HTTP, no solo vitest) antes de seguir a la
   siguiente.
2. **Gap menor de H-6 documentado arriba**: agregar tracking de precio ETH
   (`getLastKnownEthPrice` en `arbitrage.state.js`, poblado igual que
   `setLastKnownBtcPrice`) y sumarlo a `_capitalUSD` en
   `executeBestOpportunity()` para que el risk engine no subestime el
   capital total cuando hay posición en ETH.
3. **Robustez y parametrización** en general (profundidad de
   configuración, comportamiento ante fallos) — sigue siendo la prioridad
   de negocio declarada por el usuario.
4. **M-8/M-9/M-10/M-11** (frontend).
5. **L-3** (`CHANGELOG.md`, 32KB): sigue bloqueado por juicio editorial —
   **necesita que el usuario indique qué "rondas" históricas conservar**,
   no es una decisión que deba tomarse unilateralmente.
6. **C-3** (estado mutable global disperso) y **H-9** (prefijo
   `/api/v1/`, bloqueado por Q2 sin responder): intactos, mismo estado.
7. **H-10** (multi-idioma real) va al final, después de todo lo demás, tal
   como pidió el usuario.



### Contexto: por qué esta sesión empieza reconciliando en vez de asumiendo

El chat anterior había dejado H-4 (validación con Zod en `repositories/index.js`,
ver Sesión 18) completo y verificado en su propia conversación (1230 tests,
lint/tsc/build limpios), pero el ZIP entregado a esta sesión seguía siendo el
snapshot previo a ese fix — los `.catch(() => [])`/`.catch(() => null)`
seguían presentes en `server/repositories/index.js`. Antes de tocar nada más
se integró literalmente el código ya verificado (mismo `index.js`, mismo
`tests/repositories-real.test.js`) para no perder ese trabajo ni repetirlo
con variaciones.

### Baseline tras integrar H-4

- `npm ci` limpio.
- `npx vitest run` → **1231 passed | 0 skipped (1231 total)**.
- `npx eslint src/ server/ --ext .js,.jsx` → limpio.

### H-7 — evidencia de la Sesión 18 verificada contra el código real: **incorrecta, corregida**

La Sesión 18 registró como "evidencia nueva para H-7": *"/api/arbitrage/mode
y /pairs no tienen requireAuth"*. Antes de tocar código se releyó
`server/routes/arbitrage.routes.js` completo (no solo `config.routes.js`
en aislamiento, que es probablemente de donde salió la lectura original) y
se encontró un middleware a nivel de router padre:

```js
router.use((req, res, next) => {
  if (req.path === '/stream' || req.path === '/alerts-stream') return next();
  if (req.path === '/alerts/history' || req.path === '/trading-mode') return next();
  return requireAuth(req, res, next);
});
```

Este middleware se aplica a **todas** las rutas de `/api/arbitrage/*`
excepto las 4 explícitamente exceptuadas (documentadas con su propia razón:
SSE no puede mandar header Authorization, y esos 2 endpoints de solo lectura
los llama `SystemStatusBar` antes de tener token). `/mode` y `/pairs` no
están en la lista de excepciones, así que sí heredan `requireAuth`.

**Verificación real** (no solo lectura de código, mismo criterio que todas
las sesiones anteriores): se levantó el servidor completo
(`PORT=5150 NODE_ENV=production node server/index.js`) y se hicieron
requests HTTP reales sin token:

- `GET /api/arbitrage/mode` → **401**
- `GET /api/arbitrage/pairs` → **401**
- `POST /api/arbitrage/mode` → **401**
- `GET /health` → **200** (control, confirma que el servidor sí respondía)

**Conclusión**: la afirmación de la Sesión 18 estaba desactualizada o se
basó en leer `config.routes.js` sin ver el middleware del router padre que
lo monta — mismo patrón de "el plan/log dice X pero el código real dice Y"
ya documentado varias veces en este log (conteos de rutas en C-2, cobertura
de M-6, etc.). **No se agregó ningún `requireAuth` nuevo** porque no había
ningún gap real que cerrar en estos dos endpoints — agregar autenticación
redundante hubiera sido ruido, no un fix. H-7 sigue abierto (el problema de
fondo — el campo `role` del User model nunca se chequea en ningún lado, no
hay `requireRole('admin')` — sigue intacto), pero la "evidencia nueva"
concreta que citaba la Sesión 18 queda retirada del backlog por ser
incorrecta.

### Bug real encontrado y corregido: `POST /api/arbitrage/adversarial/run`

Mientras se auditaba el gap de validación mencionado en la Sesión 18
("gaps menores en config.routes.js/query.routes.js") para cerrarlo con el
middleware Zod ya existente (`validateRequest.js`), se encontró que
`config.routes.js` llamaba:

```js
const result = await adversarial.runScenario(req.body || {});
```

pero la firma real es `runScenario(type, orderBooks)` — **dos argumentos**.
El objeto completo del body se pasaba como `type`, y como el switch interno
compara `type` contra strings literales (`'mid_flight_failure'`, etc.), un
objeto nunca matchea ningún case: el endpoint **siempre** devolvía
`{ ok:false, reason:'Escenario desconocido: [object Object]' }` sin
ejecutar ningún escenario real, sin importar qué mandara el cliente. Esto
es exactamente la demo de "Robustez ante escenarios adversos" que cita el
`JudgeGuide.md` (tab 💥 Adversarial) — estaba rota en este endpoint
específico desde antes de esta sesión, sin que ningún test lo hubiera
detectado (no existía ningún test para esta ruta).

**Fix aplicado**: se extrae `type` del body y se pasan los order books
reales (`getOrderBooks()`, con el mismo fallback a `[]` que ya usan las
otras rutas de este archivo) como segundo argumento.

**Test nuevo** (`tests/arbitrage.config.routes.test.js`): verifica que
`runScenario` se llama con `('mid_flight_failure', [])` — dos argumentos
separados, no el body completo — y separadamente que el middleware de
validación (ver abajo) rechaza un `type` desconocido con 400 antes de
llegar al handler.

### Validación Zod cerrada en `config.routes.js` (ítem #16 del log — parcial, ver pendiente)

Nuevo archivo `server/domain/arbitrageValidation.js` (mismo patrón que
`tradingValidation.js`, misma librería, mismo criterio de documentar junto
a cada campo qué gap real cierra):

- `RebalanceExecuteBodySchema` — aplicado a `POST /rebalance/execute`.
  `rebalanceEngine.executeRebalance()` ya tenía defensa en profundidad
  (valida asset/from/to contra listas conocidas — comentario propio en el
  archivo ya lo documentaba), pero un `amount`/`fee` no numérico llegaba
  sin dar un 400 claro antes.
- `AdversarialRunBodySchema` — aplicado a `POST /adversarial/run`, junto
  con el fix del bug de arriba. `type` ahora se restringe a los 3 valores
  reales que `runScenario()` reconoce.
- `PairsBodySchema` (ya existía, definido en `tradingValidation.js` para
  `/api/trading/pairs`) — reusado para `POST /api/arbitrage/pairs`, que
  antes solo tenía un chequeo manual de `Array.isArray`. **Se preservó el
  chequeo manual dentro del handler como defensa en profundidad** (mismo
  criterio que ya usa `rebalanceEngine.executeRebalance`) porque los tests
  unitarios existentes de este router (`tests/arbitrage.config.routes.test.js`)
  invocan el handler final directamente vía un helper `getHandler()` que
  toma `route.stack[route.stack.length - 1].handle` — es decir, **se saltan
  el middleware de validación a propósito** (es un test de unidad del
  handler, no de integración HTTP completa). Quitar el chequeo manual
  hubiera roto 2 tests existentes (`pairs: 'not-array'` y `pairs: []`)
  sin ninguna ganancia real, ya que Zod cubre el mismo caso en producción.
- `tradingValidation.js`: se exportó `OpportunitySchema` (antes interno)
  para que `arbitrageValidation.js` pudiera reusarlo en vez de duplicarlo.

### Pendiente real de este mismo ítem, sin tocar (honesto, no se inventó que estaba cerrado)

Los otros 3 endpoints que la Sesión 18 identificó dentro del mismo ítem #16
**no se llegaron a tocar esta sesión** (se agotó el tiempo/tokens
verificando lo de arriba con el mismo nivel de rigor que exige este log):

- `POST /api/arbitrage/stress-test/activate` (query.routes.js) — schema
  `StressTestActivateBodySchema` ya está **escrito y exportado** en
  `arbitrageValidation.js`, pero **no está importado ni aplicado** en
  `query.routes.js` todavía.
- `POST /api/arbitrage/arb-backtest/simulate` (query.routes.js) — mismo
  caso: `ArbBacktestSimulateBodySchema` ya escrito, no aplicado.
- `POST /api/arbitrage/ml/score` (query.routes.js) — mismo caso:
  `MlScoreBodySchema` (= `OpportunitySchema` reusado) ya escrito, no
  aplicado. **Ojo al aplicar este**: ya existe
  `tests/arbitrage.query.routes.test.js` con 2 tests para esta ruta
  (`POST /ml/score — 400 sin buyExchange/sellExchange` y
  `— ok:true con oportunidad válida`) que llaman al handler directamente
  (mismo patrón `getHandler` que config.routes.js) — **hay que preservar
  el chequeo manual `if (!opportunity.buyExchange || !opportunity.sellExchange)`
  dentro del handler** igual que se hizo con `/pairs` arriba, no
  reemplazarlo, o esos 2 tests existentes se rompen.

### Verificación final de esta sesión

- `npx vitest run` → **1233 passed | 0 skipped (1233 total)** (1231 + 2
  tests nuevos de `/adversarial/run`).
- `npm run lint` (`eslint src/ server/ --ext .js,.jsx`, el comando real del
  proyecto — no `eslint server/ tests/` a mano, que trae ruido de reglas
  de entorno de test no configuradas para lint directo) → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run build` → limpio.
- No se corrió arranque/shutdown real de servidor de nuevo para el fix de
  `/adversarial/run` en sí (sí se corrió antes, para verificar H-7) —
  pendiente sugerido para la próxima sesión antes de dar esto por cerrado
  al 100%: un `curl -X POST /api/arbitrage/adversarial/run -d
  '{"type":"mid_flight_failure"}'` contra un servidor real para confirmar
  el log de fases (`INIT`, `DETECT`, etc.) con datos de mercado reales, no
  solo el spy mockeado del test.

### Pendiente real para la siguiente sesión (lista completa, sin recortar)

1. **Terminar el ítem #16**: aplicar `StressTestActivateBodySchema`,
   `ArbBacktestSimulateBodySchema` y `MlScoreBodySchema` (ya escritos en
   `arbitrageValidation.js`) a `query.routes.js`, preservando los chequeos
   manuales existentes como defensa en profundidad (ver nota de arriba
   sobre los tests de `/ml/score`).
2. **H-5**: `arbitrageOrchestrator.js` (798 líneas, `arbitrageLoop()` hace
   demasiado — 0% cobertura confirmada en comentarios de `vitest.config.js`).
   Extraer en funciones testeables (`buildTickPayload()`,
   `evaluateAndExecute()`, `enrichWithIntelligence()`, `broadcastToSSE()`).
   Sin bloqueos de decisión — el usuario ya autorizó proceder.
3. **H-6**: ejecución de ETH bypasea `executeBestOpportunity()` (líneas
   563-586 de `arbitrageOrchestrator.js`), sin risk checks/state
   machine/audited P&L/slippage validation que sí tiene BTC. El usuario
   autorizó generalizar `executeSimulated()` por asset — implementar.
4. **H-7** (RBAC real): el campo `role` del User model sigue sin
   chequearse en ningún lado. Implementar `requireRole('admin')` real o
   decidir formalmente remover el campo (documentar la decisión). La
   evidencia específica de rutas sin auth de la Sesión 18 quedó descartada
   esta sesión (ver arriba) — este ítem ahora es puramente sobre RBAC de
   verdad, no sobre gaps de auth puntuales.
5. **M-8**: componentes gigantes del frontend (`ArbitragePage.jsx` 50KB,
   `DocsPage.jsx` 52KB, `AnalyzePage.jsx` 26KB, `AboutPage.jsx` 24KB) — sin
   tocar. Extraer componentes reusables (Card, DataTable, MetricCard).
6. **M-9**: TypeScript en frontend — sin empezar, alcance grande.
7. **M-10**: `src/api.js` (11KB de fetch crudo) — sin abstracción de
   cliente HTTP con retry/interceptors.
8. **M-11**: sin tests E2E (Playwright/Cypress) — sin empezar.
9. **L-3**: `CHANGELOG.md` (32KB) — sin decidir qué "rondas" conservar.
10. **C-3** (estado mutable global disperso): pospuesto por decisión
    consciente de CTO (Sesión 15), no por bloqueo técnico — revisar si el
    usuario quiere reabrirlo antes o después del 12 de julio.
11. **H-9** (`/api/v1/` prefix): pospuesto a propósito (riesgo de romper
    el demo en vivo para jueces, sin valor de evaluación antes del
    deadline) — el usuario pidió dejar cosas de bajo-riesgo-alto-valor
    primero; revisar después del 12 de julio.
12. **H-10** (traducción ES→EN, multi-idioma real con i18n): el usuario
    pidió explícitamente dejarlo para el final — no tocar hasta que el
    resto esté cerrado.
13. **DEMO_MODE → feature flag** (Q3): identificado, no numerado en el
    plan original, sin empezar.
14. **Q5** (expansión de producto, visión "Bloomberg Terminal"): visión de
    largo plazo, fuera de alcance para las sesiones pre-12-de-julio.
15. **M-3** (payload SSE sin deltas): investigado y pospuesto por decisión
    consciente (Sesión 17) — sigue disponible para retomar.



### Baseline

- `npm ci` limpio, `npx vitest run` → **1214 passed | 0 skipped** — igual a
  la Sesión 17.
- `npx vitest run --coverage` → exit code 0 con los umbrales de la Sesión 16
  (lines:66, functions:59, branches:51, statements:63).
- `npm run check:ts-drift` → sin drift (6 archivos).
- Los tres verificados antes de tocar nada, tal como pedía el prompt de
  arranque de esta sesión.

### H-1 (validación con Zod/Joi/AJV) — investigado a fondo antes de asumir alcance

**Auditoría real** (no se asumió que H-1 seguía abierto solo porque ninguna
sesión lo había cerrado — se verificó contra el código):

- `server/domain/validation.js` (compilado desde `server-types/.../validation.ts`)
  ya cubre **alerts, watchlist, portfolio y arbitrage config** (`POST
  /api/arbitrage/config`) con un validador manual, deliberadamente sin
  dependencia externa — decisión documentada en el propio archivo: *"la
  superficie de validación aquí es pequeña y estable... si el schema
  surface crece sustancialmente, revisar"*. Esa decisión se respeta tal
  cual — este ítem NO toca esos 4 endpoints ni ese archivo.
- El resto de las rutas mutantes (`server/routes/`, `server/arbitrage/subroutes/`)
  se auditaron una por una contra el código real. La mayoría ya tenía
  chequeos manuales razonables (`dataset.routes.js`, `notifications.routes.js`,
  `stream.routes.js` POST `/bot`/`/reset`, `config.routes.js` POST `/mode`
  vía `setUserMode()` interno). El gap real y sin proteger está concentrado
  en **`server/routes/trading.routes.js`** — el módulo de mayor riesgo
  financiero del repo:
  - `POST /execute/cross`: `amount` solo se chequeaba con `if (!amount)`.
    Un `amount` no numérico (ej. `"100"` como string) produce `NaN` en
    `requiredUSDT = amount * opportunity.buyPrice` dentro de
    `liveExecution.preflightCheck()`, y en JS `usdtBalance < NaN * 1.02` es
    `false` — **el chequeo de "saldo insuficiente" quedaba silenciosamente
    deshabilitado en vez de fallar**. Un `amount` negativo tiene el mismo
    problema. Esto no es hipotético: se confirmó leyendo `preflightCheck()`
    línea por línea, no se asumió.
  - `opportunity` no tenía validación de forma — cualquier objeto (o sin
    `buyExchange`/`sellExchange` del tipo correcto) llegaba hasta
    `executeCrossExchangeLive()`.
  - `POST /test-connection`: `exchange`/`apiKey`/`apiSecret` solo se
    chequeaban por verdad (truthy) — un objeto o array pasaba ese chequeo.
  - `POST /mode`, `2fa/confirm`, `2fa/disable`, `POST /pairs`: sin gap de
    seguridad real (`liveExecution.setUserMode()` y
    `twoFactor.verifyToken()`/`multiPairService.setUserConfig()` ya validan
    internamente y devuelven error controlado), pero con mensajes de error
    genéricos en vez de indicar qué campo está mal — se cerraron también
    porque el costo marginal era bajo una vez montada la infraestructura.

**Decisión de alcance**: se cierra H-1 para `trading.routes.js` completo (8
endpoints) de forma completa y verificada, en vez de tocar superficialmente
los ~15 endpoints adicionales encontrados en `config.routes.js`/`query.routes.js`
que tienen gaps menores (sin riesgo financiero directo — cosas como
`stress-test/activate` o `arb-backtest/simulate`, que no mueven fondos
reales). Ver "Pendiente real" abajo — quedan documentados para no tener que
re-auditar desde cero.

**Fix aplicado**:

1. **`server/infrastructure/validateRequest.js`** (nuevo): middleware
   genérico `validateBody(schema)` — parsea `req.body` con un schema Zod,
   responde 400 con `{ ok:false, error }` si falla, o reemplaza `req.body`
   por el valor limpio si pasa. Documenta explícitamente por qué esta
   superficie sí justifica Zod mientras que alerts/watchlist/portfolio no
   lo necesitan (ver comentario en el archivo).
2. **`server/domain/tradingValidation.js`** (nuevo): schemas Zod para los 6
   bodies reales de `trading.routes.js` (`mode`, `test-connection`,
   `execute/cross`, `2fa/confirm`+`2fa/disable` comparten schema, `pairs`).
   `opportunity` usa `.passthrough()` deliberadamente — no se le exige una
   forma exacta (tiene ~50+ campos, el mismo payload de streaming que
   documenta M-3) más allá de `buyExchange`/`sellExchange` como strings no
   vacíos, que es lo único que `executeCrossExchangeLive()` realmente usa
   antes de tocar dinero.
3. **`server/routes/trading.routes.js`**: `validateBody(...)` insertado
   después de `requireAuth` en los 6 POST relevantes; se eliminaron los
   chequeos manuales redundantes (`if (!opportunity || !amount)`, etc.) que
   ahora hace el schema.
4. **`package.json`**: nueva dependencia `zod` (`^4.4.3`).

**Verificación**:

- `npx vitest run` → **1230 passed | 0 skipped** (1214 + 16 tests nuevos en
  `tests/tradingValidation.e2e.test.js`, que cubren exactamente los gaps de
  arriba — incluyendo el caso `amount: "100"` como regresión explícita del
  bug de `NaN` descrito arriba).
- `tests/twoFactorTradingGate.e2e.test.js` (preexistente) sigue pasando sin
  modificar — se verificó que el orden de middlewares (`requireAuth` →
  `validateBody` → 2FA gate → handler) no cambia el comportamiento para
  clientes bien formados.
- `npx eslint src/ server/ scripts/ --ext .js,.jsx` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run check:ts-drift` → sin drift (los archivos nuevos son JS plano,
  consistente con el resto de `server/routes/` y `server/arbitrage/subroutes/`
  — no son parte del subconjunto de 6 archivos compilados desde
  `server-types/`, así que no aplica ni corresponde tocar ese pipeline).
- `npx vitest run --coverage` → exit code 0 con los umbrales vigentes
  (`trading.routes.js` subió de 57.7%→65.8% líneas gracias a los tests
  nuevos, sin necesidad de tocar los umbrales de `vitest.config.js`).
- `npm run build` → limpio.
- Arranque real (`PORT=5103 NODE_ENV=production node server/index.js`,
  proceso desacoplado de la sesión de shell con `setsid` para que
  sobreviviera entre comandos): `/health` → `ok:true`,
  `engine.running:true`. Se hicieron requests HTTP reales (no solo tests)
  contra `POST /api/trading/mode` (mode inválido → 400 con mensaje
  específico; mode válido → 200), `POST /api/trading/execute/cross`
  (`amount:"100"` → 400, confirmando en vivo que el gap está cerrado) y
  `POST /api/trading/pairs` (`pairs` no-array → 400). `SIGTERM` real:
  `[watchdog] Shutdown complete in 2ms`, log confirma
  `"SIGTERM — graceful shutdown initiated"` y el handler `bot_state`
  corrió antes de salir.

### Pendiente real para la siguiente sesión

- **Gaps menores de validación encontrados pero NO cerrados esta sesión**
  (sin riesgo financiero directo — no mueven fondos reales, a diferencia de
  `trading.routes.js`): `server/arbitrage/subroutes/config.routes.js`
  (`POST /rebalance/execute` — `suggestion` sin validar forma; `POST
  /adversarial/run` — body sin validar; `POST /pairs` — valida `pairs`
  pero no `allocation`) y `server/arbitrage/subroutes/query.routes.js`
  (`POST /stress-test/activate` — `type`/`exchange`/`multiplier`/`dropPct`
  sin type-check antes de `activateScenario()`; `POST /arb-backtest/simulate`
  — `minScore`/`cooldownMs`/`feeMultiplier` sin límites, podría aceptar un
  `cooldownMs` absurdo; `POST /ml/score` — solo chequea 2 de los campos de
  `opportunity`). Candidato natural para una sesión de seguimiento corta,
  reusando `validateRequest.js` ya creado — es mecánico una vez que existe
  el middleware, no requiere re-investigar el patrón.
- Se observó (no se tocó, fuera de alcance de H-1): `GET/POST /api/arbitrage/mode`
  y `GET/POST /api/arbitrage/pairs` en `config.routes.js` **no tienen
  `requireAuth`**, a diferencia de sus equivalentes en `trading.routes.js`
  que sí lo tienen. Esto es H-7 (qué rutas son admin-only), no H-1 — se
  deja anotado para cuando el usuario decida ese criterio, tal como pide el
  log de sesiones anteriores.
- **H-4, H-5**: sin detalle registrado más allá del código de ítem — sigue
  requiriendo `implementation_plan.md`/`kukora_master_prompt_opus.md` del
  usuario, o investigación contra código si el usuario prefiere eso.
- **H-6, H-7**: sin cambios, siguen requiriendo decisión de producto del
  usuario (generalizar `executeSimulated()` por asset / qué rutas son
  admin-only — ver el hallazgo de arriba, es evidencia nueva para esa
  decisión).
- **M-3, L-3, M-8-M-11, C-3, H-9, H-10, DEMO_MODE (Q3), expansión Q5**: sin
  cambios, siguen pospuestos por la misma decisión de CTO de las Sesiones
  14-17.

## Sesión 17 — M-3 investigado y pospuesto (decisión consciente), L-5 (estrategia de migraciones de DB) cerrado vía ADR-014

### Baseline

- `npm ci` limpio, `npx vitest run` → **1214 passed | 0 skipped**, sin
  cambios respecto a la Sesión 16.

### M-3 (payload SSE ~50+ campos sin deltas) — investigado, pospuesto a propósito

Se leyó el código real de punta a punta: `server/arbitrage/subroutes/stream.routes.js`
(evento `'init'`, una vez por conexión) y
`server/application/arbitrageOrchestrator.js` (evento `'tick'`, vía
`pushToSSE()` en `arbitrage.state.js`, que hace `res.write()` a cada
cliente en `sseClients`). Confirmado: el payload de `'tick'` tiene ~50+
campos, se reconstruye completo en cada iteración del loop
(`detectionMode: 'event_driven_ws + loop_150ms'` — cada ~150ms) y se
envía completo a cada cliente conectado, sin deltas ni separación por
canal/tópico. El propio código ya throttlea los sub-objetos más caros
vía `tickCount % N` (5/7/8/10/15) — no es que nadie haya pensado en el
costo, es una mitigación parcial ya existente.

**Se evaluaron 2 alternativas de bajo riesgo y se descartaron ambas para
esta sesión**:
- Compresión HTTP (`compression` middleware) sobre el endpoint SSE: no
  hay compresión instalada hoy (confirmado, cero referencias en
  `package.json`/`server/index.js`). Agregar `compression()` a un
  stream SSE en vivo típicamente requiere configurar `flush` explícito
  para no introducir latencia por buffering — es exactamente el tipo de
  cambio con efectos secundarios sutiles sobre un stream que además es
  el corazón del demo, a días de la evaluación.
- Saltear el broadcast si el tick es idéntico al anterior: cambiaría el
  comportamiento observable del stream (el frontend podría depender de
  recibir un tick continuo como señal de vida, más allá del `: ping`
  de heartbeat) sin que ninguna sesión haya confirmado ese contrato con
  el consumidor.

**Decisión de CTO**: el rediseño real (deltas o canales/tópicos) sigue
siendo, tal como decían las sesiones anteriores, una decisión de
producto que toca `src/hooks/useArbitrageStream.js` y todo lo que
consume `'init'`/`'tick'` — no se fuerza antes del 12 de julio. Se
recomienda que el usuario decida el enfoque (delta incremental vs.
canales) en una sesión dedicada después de la evaluación, con la
investigación de esta sesión como punto de partida (no hay que
reinvestigar desde cero).

### L-5 (estrategia de migraciones de DB) — cerrado vía ADR nueva

**Auditoría real**: cero migraciones existentes, cero dependencia de
migración instalada, los 7 schemas del proyecto evolucionaron siempre de
forma aditiva (campos con `default`/opcionales) — nunca un rename/cambio
de tipo/eliminación. No hay ninguna migración real pendiente hoy; el
ítem pedía una *estrategia*, no una migración concreta.

**Fix aplicado**:

1. **`docs/ADR-014-db-migration-strategy.md`** (nueva, mismo formato que
   ADR-001 a ADR-013): decisión de adoptar un runner de migraciones
   mínimo, casero, sin dependencia externa nueva por ahora (no se
   justifica volumen); convención `up`/`down` por archivo numerado;
   regla de proceso clara sobre cuándo hace falta migración formal
   (rename/tipo/eliminación/backfill) vs. cuándo no (aditivo, patrón ya
   en uso).
2. **`server/infrastructure/persistence/migrations/README.md`** (nuevo):
   scaffold concreto de la convención — carpeta creada, sin ninguna
   migración real todavía (no hay ninguna pendiente).

Cambio puramente documental/estructural — cero código de producción
tocado, cero dependencias nuevas.

**Verificación**:

- `npx vitest run` → **1214 passed | 0 skipped** — sin cambios
  (esperado: no se tocó ningún archivo ejecutable).
- `npx eslint src/ server/ scripts/ --ext .js,.jsx` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run check:ts-drift` → sin drift.
- `npm run build` → limpio.
- No se corrió arranque real esta sesión — no se tocó ningún archivo
  que afecte el arranque del servidor (solo `docs/` y una carpeta nueva
  sin código ejecutable); se dejó constancia aquí para que la próxima
  sesión no asuma que se verificó algo que no aplicaba.

### Pendiente real para la siguiente sesión

- **M-3**: pospuesto a propósito hasta después del 12 de julio,
  investigación completa disponible arriba para no repetirla.
- **L-3** (CHANGELOG.md): sigue requiriendo que el usuario indique qué
  "rondas" conservar antes de tocarlo.
- **M-8, M-9, M-10, M-11**: sin descripción real disponible, sin
  cambios respecto a la Sesión 16.
- **C-3, H-9, H-10, DEMO_MODE (Q3), expansión Q5**: sin cambios, siguen
  pospuestos por la decisión de CTO de la Sesión 14.
- De la lista larga original, quedan realmente abiertos y sin bloqueo
  de decisión de usuario: **H-1** (validación Zod/Joi/AJV), **H-4, H-5**
  (sin detalle registrado más allá del código de ítem, requieren
  recontar contra el plan maestro o el código), **H-6, H-7**
  (investigados en sesiones previas, decisión explícita de no tocar
  hasta generalizar `executeSimulated()` por asset / decisión de qué
  rutas son admin-only).

## Sesión 16 — M-6 (umbrales de cobertura) cerrado y verificado — seguimiento explícito de la Sesión 12

### Contexto

La Sesión 12 cerró M-6 solo para `exchangeService.js` (el módulo más
débil de los 3 que señalaba el plan) y dejó explícitamente pendiente
"correr `--coverage` de nuevo... antes de asumir cualquier número" como
primer paso de la siguiente sesión dedicada. M-8 a M-11 se revisaron
también: **no tienen ninguna descripción en este log más allá de
aparecer agrupados en listas genéricas de "sin tocar"** — su contenido
real solo existe en `implementation_plan.md`/`kukora_master_prompt_opus.md`,
no disponibles en este repo. Se decidió no adivinar su alcance y dejarlos
intactos hasta que el usuario aporte ese documento, en vez de inventar
qué podrían ser.

### Baseline

- `npm ci` limpio, `npx vitest run` → **1214 passed | 0 skipped**, sin
  cambios respecto a la Sesión 15.

### M-6 (umbrales de cobertura) — cerrado y verificado

Se corrió `npx vitest run --coverage` para tener el número real (no el
65/58/50/62 citado por el plan original, que el propio log ya venía
señalando como desactualizado desde la Sesión 9):

- **Real medido**: statements 64.68%, branches 53.66%, functions 61.44%,
  lines 68.1%.
- Todos por encima de los umbrales configurados entonces (62/50/58/65) —
  hay margen real, no solo teórico, para subirlos sin arriesgar el CI.

**Fix aplicado**: `vitest.config.js` — umbrales subidos a
`lines:66, functions:59, branches:51, statements:63` (≈2pt por debajo de
lo medido, mismo criterio de buffer que ya usaba el comentario "Round
20" anterior — no se sube al número exacto medido para no generar
falsos rojos por fluctuación normal entre corridas). Comentario del
archivo actualizado con los gaps reales restantes
(`healthService.js` 11%, `spreadHeatmapService.js` 18%,
`liveInventoryReconciliation.js` 33-37%, `replayService.js` 55-60%) en
vez de la lista vieja (algunos de esos archivos ya mejoraron en
sesiones posteriores al comentario original). Meta de largo plazo sin
cambios: 75/70/65/75.

**Verificación**:

- `npx vitest run --coverage` → exit code 0 con los nuevos umbrales
  (confirmado explícitamente, no solo lectura del reporte).
- `npx vitest run` (sin coverage) → **1214 passed | 0 skipped**.
- `npx eslint src/ server/ scripts/ --ext .js,.jsx` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run check:ts-drift` → sin drift.
- `npm run build` → limpio.
- Arranque real (`PORT=5101 NODE_ENV=production node server/index.js`):
  `/health` → `ok:true`. `SIGTERM` real: shutdown ordenado, exit limpio.

### Pendiente real para la siguiente sesión

- **M-8, M-9, M-10, M-11**: contenido real desconocido — se necesita
  `implementation_plan.md` o `kukora_master_prompt_opus.md` para
  desbloquear con precisión. Sin ese documento, no se puede verificar
  contra código fuente lo que no está descrito en ningún lado.
- **M-3** (payload SSE ~50+ campos, sin deltas): sigue recomendado como
  sesión propia dedicada — toca frontend y backend juntos, no es un fix
  acotado de una sesión de cierre rápido.
- **L-1**: ya cerrado de facto por ADR-013 (Sesión 15 lo confirma
  indirectamente al usarlo como referencia central).
- **L-3** (CHANGELOG.md, juicio editorial): sin tocar, mismo criterio —
  requiere que el usuario decida qué conservar antes de recortar.
- **L-5** (estrategia de migraciones de DB): sin tocar, alcance grande.
- **C-3, H-9, H-10, DEMO_MODE (Q3), expansión de producto (Q5)**: sin
  cambios, siguen pospuestos hasta después del 12 de julio por la misma
  decisión de CTO de las Sesiones 14-15.

## Sesión 15 — C-3 auditado y pospuesto (decisión explícita), C-5 cerrado y verificado (guard de drift TS/JS)

### C-3 (estado mutable global disperso) — auditado, NO forzado esta sesión

Antes de tocar código se hizo un inventario real (no de memoria): ~30
archivos de `server/` tienen estado a nivel de módulo (`let _foo = ...`).
Se revisaron los candidatos de mayor riesgo aparente
(`server/domain/walletManager.js`: `wallets`, `tradeHistory`) y se
confirmó que **ya están correctamente encapsulados** — nunca se exportan
directamente, solo vía funciones (`getBalances()`, `getTradeHistory()`),
y esas funciones ya devuelven copias defensivas
(`JSON.parse(JSON.stringify(wallets))`, `[...tradeHistory]`), no
referencias mutables. Se buscó también el anti-patrón real (mutación
externa directa de las propiedades exportadas de otro módulo,
`require(x).campo = valor`) con `grep` en todo `server/` — **cero
resultados**.

**Decisión de CTO**: lo que existe es un patrón real (estado disperso en
~30 singletons de módulo en vez de una capa de estado centralizada), pero
no es un bug de corrección — es una preferencia arquitectónica de mayor
esfuerzo y alcance cruzado (tocaría virtualmente todos los módulos de
`server/`). Consolidarlo ahora, a días de la evaluación del 12 de julio,
es exactamente el tipo de apuesta de alto riesgo que esta sesión (y la
14) ya decidieron posponer para H-9/H-10/Q3/Q5. **C-3 queda
explícitamente pospuesto a después de la evaluación** — no por falta de
tiempo para investigar (ya se investigó, ver arriba), sino por una
decisión de riesgo consciente. Se aprovechó el resto de la sesión en
C-5, que sí es acotado y cerrable con verificación real.

### C-5 (`advancedRiskEngine.js` como artefacto TS compilado hand-editado) — cerrado y verificado

**Hallazgo real** (no asumido del log): se corrió `npm run build:ts`
(sobre una copia — `server/` y `server-types/` respaldados antes) y se
comparó con `diff -rq` contra el estado comiteado. **Resultado: cero
diferencias.** El `.js` comiteado de `advancedRiskEngine.js` (y los otros
5 archivos generados desde `server-types/`) ya es exactamente lo que
`tsc` generaría a partir del `.ts` fuente actual — no hay drift real hoy.
El hallazgo original que motivó C-5 en el plan (edición a mano del `.js`
compilado) es el mismo incidente que ya documenta
`docs/ADR-013-server-types-build-relationship.md` (Sesión 3) — ya
corregido entonces, pero **sin ninguna verificación automatizada que
impidiera que volviera a pasar**.

**Fix aplicado** (siguiendo Q1: TypeScript como fuente única de verdad,
nunca duplicar lógica — esto es exactamente lo que garantiza el fix):

1. **`scripts/checkTsBuildDrift.js`** (nuevo): compila `server-types/*.ts`
   a un directorio temporal (nunca escribe en el repo — respeta la
   decisión explícita de ADR-013 de no correr `build:ts` real en CI) y
   compara byte a byte contra los `.js` comiteados bajo `server/`. Falla
   con mensaje claro apuntando a la ADR si hay drift.
2. Verificado que el script **detecta drift real**: se simuló una edición
   a mano de `advancedRiskEngine.js` (línea extra), el script falló
   correctamente señalando el archivo exacto; se revirtió y volvió a
   pasar limpio.
3. **`.github/workflows/ci.yml`**: nuevo step "TypeScript build-drift
   check (C-5 / ADR-013)" justo después del `tsc --noEmit` existente —
   mismo job, sin costo adicional de infraestructura.
4. **`package.json`**: nuevo script `check:ts-drift`.
5. **`.eslintrc.cjs`**: override nuevo para `scripts/**/*.js` (mismo
   criterio que el override ya existente para `server/**/*.js` —
   `no-console: off`, porque es output de CLI intencional, no logging de
   producción).

**Verificación**:

- `npx vitest run` → **1214 passed | 0 skipped (1214 total)** — sin
  cambios.
- `npx eslint src/ server/ scripts/ --ext .js,.jsx` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run check:ts-drift` → **✅ sin drift (6 archivos verificados)**.
- `npm run build` → limpio.
- Arranque real (`PORT=5100 NODE_ENV=production node server/index.js`):
  `/health` respondió `ok:true`. `SIGTERM` real: shutdown ordenado, exit
  limpio.

### Pendiente real para la siguiente sesión

- **C-3**: pospuesto explícitamente a después del 12 de julio (ver
  razón arriba) — no requiere más investigación, requiere una decisión
  de si vale la pena antes o después de la evaluación.
- **H-9, H-10, `DEMO_MODE`→feature flag (Q3), expansión de producto
  (Q5)**: sin cambios, siguen pospuestos por la misma razón que la
  Sesión 14.
- **H-1, H-4, H-5, H-6, H-7, M-3, M-8, M-9, M-10, M-11, L-3, L-5**: sin
  tocar, mismo estado.
- Con C-2, C-4, C-1 ya cerrados en sesiones previas, y C-5 cerrado esta
  sesión, de los "5 críticos" del plan original **solo C-3 queda
  abierto**, y está pospuesto por decisión consciente, no por bloqueo
  técnico.

## Sesión 14 — Q1-Q5 respondidas por el usuario (decisiones de CTO) + L-4 (configs de deploy redundantes) cerrado y verificado

### Q1-Q5 — respondidas por el usuario, registradas textualmente para las siguientes sesiones

El usuario respondió las 5 Open Questions del plan original citadas en la
Sesión 4 de este log ("TypeScript sí/no, plataforma de deploy única,
`DEMO_MODE` sí/no, si hay usuarios en producción, alcance de producto de
las 28 páginas"). Se confirmó la correspondencia leyendo el log completo
antes de aplicar nada — no se asumió sin verificar.

- **Q1 (TypeScript)**: TS es la dirección permanente. No mantener
  implementaciones paralelas JS/TS. Fuente única de verdad, sin duplicar
  lógica. **Desbloquea C-5** (`advancedRiskEngine.js` como artefacto TS
  compilado hand-editado) — pendiente para próxima sesión, requiere diff
  cuidadoso `.ts` vs `.js` antes de fusionar, no se hizo en esta sesión
  para no mezclarlo con L-4.
- **Q2 (Deployment)**: Railway primario, Docker secundario. Portable, sin
  asunciones específicas de Railway, configuración dirigida por variables
  de entorno. **Desbloquea L-4** — cerrado esta sesión (ver abajo).
- **Q3 (DEMO_MODE)**: no se elimina, se refactoriza a feature flag
  propiamente dicho, centralizado, sin fugar a lógica de negocio en
  producción. Pendiente — no se tocó esta sesión, es un ítem separado no
  numerado en el plan original; se sugiere abrirlo como ítem nuevo en una
  sesión futura.
- **Q4 (Breaking changes)**: no hay usuarios de producción reales que
  proteger. Priorizar arquitectura sobre compatibilidad cuando el cambio
  mejore mantenibilidad/consistencia/corrección de forma significativa.
  **Desbloquea H-9** (prefijo `/api/v1/`) — decisión explícita de **no
  aplicarlo antes del 12 de julio** (evaluación del hackathon) aunque esté
  desbloqueado: es un cambio que toca todas las rutas activas, incluido el
  frontend que las consume, y el riesgo de romper el demo en vivo para los
  jueces no tiene contrapartida de valor de evaluación. Se pospone a
  después de la evaluación.
- **Q5 (Alcance de producto)**: Kukora no es solo un bot de arbitraje —
  evoluciona hacia una plataforma de inteligencia de arbitraje de Bitcoin
  de nivel institucional (market intelligence, calidad de ejecución,
  ciclo de vida de oportunidades, confiabilidad de exchanges, riesgo,
  simulación, analytics, reporting, observabilidad, investigación de
  estrategia — "Bloomberg Terminal + ejecución institucional cripto").
  Visión de largo plazo registrada; **explícitamente fuera de alcance
  antes del 12 de julio** por la misma razón que H-9: es una expansión de
  producto grande y de alto valor, pero de alto riesgo de estabilidad si
  se empieza a 9 días de la evaluación. Se retoma después.

**Decisión de secuenciación de CTO para esta ventana de 9 días** (no
pedida por ningún ítem numerado del plan, documentada para que las
próximas sesiones no la repitan innecesariamente): priorizar el cierre
del backlog ya identificado y de bajo/medio riesgo (C-3, C-5, L-4 — este
último cerrado ya) antes de la evaluación; posponer H-9, H-10, el
refactor de `DEMO_MODE` (Q3), la migración completa a TS más allá de C-5,
y la expansión de producto de Q5 hasta después del 12 de julio.

### Baseline

- `npm ci` limpio, `npx vitest run` → **1214 passed | 0 skipped (1214
  total)** — coincide exactamente con el cierre de la Sesión 13.

### L-4 — limpiar configs de deploy redundantes: cerrado y verificado

**Investigación previa**: se encontraron `Procfile`, `railway.json`,
`railway.toml`, `render.yaml` y `vercel.json` coexistiendo. `render.yaml`
y `vercel.json` ya estaban marcados como "Legacy configuration" en su
propio contenido (decisión de plataforma ya intuida antes de que el
usuario la confirmara formalmente). Se confirmó que Railway usa
`railway.json` y **ignora `railway.toml`** cuando ambos existen — es
decir, `railway.toml` era config muerta: alguien había puesto
`healthcheckTimeout = 30` ahí sin efecto real, porque `railway.json` no
lo tenía. Se encontró además una asunción específica de Railway fuera de
config: `server/infrastructure/dailyReportService.js` tenía la cadena
literal `"Railway"` hardcodeada en el pie del reporte diario (violación
directa de "sin asunciones específicas de Railway" de Q2).

**Fix aplicado**:

1. `railway.json`: se agregó `healthcheckTimeout: 30` (recuperado de
   `railway.toml` antes de borrarlo, para no perder esa configuración).
2. Eliminados: `railway.toml` (redundante/ignorado), `render.yaml`,
   `vercel.json`, `Procfile` (Railway usa `railway.json` directamente vía
   Nixpacks, no necesita `Procfile`).
3. `server/infrastructure/dailyReportService.js`: quitada la cadena
   `"Railway"` hardcodeada del pie del reporte — verificado que ningún
   test asertaba ese texto exacto (`grep` en `tests/`).
4. Documentación actualizada para no referenciar archivos eliminados:
   `README.md`, `docs/DeveloperGuide.md`, `docs/Architecture.md` (ahora
   documenta explícitamente que `railway.json` es la fuente única de
   verdad y por qué se quitó el `.toml`). `docs/RoadmapToProduction.md`
   tenía además una afirmación incorrecta preexistente ("PM2 cluster
   mode" atribuido al `Procfile`, que en realidad solo hacía
   `web: npm start` sin PM2) — corregida para reflejar la realidad
   (reinicio a nivel de proceso vía `restartPolicyType` de `railway.json`
   y el `HEALTHCHECK` del `Dockerfile`).
5. `GIT_SHA`/`RAILWAY_GIT_COMMIT_SHA` en `logger.js` **no se tocó** — es
   un comentario documentando un ejemplo de CI, no una asunción de
   plataforma; la variable en sí ya es genérica (`process.env.GIT_SHA`
   con fallback `null`).

**Verificación**:

- `npx vitest run` → **1214 passed | 0 skipped (1214 total)** — sin
  cambios.
- `npx eslint src/ server/ --ext .js,.jsx` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run build` → limpio.
- `railway.json` validado como JSON parseable tras el merge.
- Arranque real (`PORT=5099 NODE_ENV=production node server/index.js`):
  `/health` respondió `ok:true`, `engine.running:true`. `SIGTERM` real:
  shutdown ordenado (`watchdog` corrió su handler `bot_state`, "Shutdown
  complete"), exit status 0.

### Pendiente real para la siguiente sesión

- **C-3** (estado mutable global disperso): intacto, sin bloqueos —
  siguiente candidato natural.
- **C-5** (`advancedRiskEngine.js`): **desbloqueado por Q1**, pendiente de
  ejecución — requiere diff `.ts` fuente vs `.js` compilado antes de
  fusionar en una sola fuente de verdad.
- **H-9** (`/api/v1/`): desbloqueado por Q4, **pospuesto a propósito**
  hasta después del 12 de julio (ver razón arriba).
- **H-10** (traducción ES→EN): sin tocar, mismo criterio que sesiones
  anteriores (alcance grande, sin valor de evaluación antes del
  deadline).
- **DEMO_MODE → feature flag** (Q3): identificado como trabajo real
  nuevo, no numerado en el plan original — sugerido para después del 12
  de julio salvo que el usuario lo priorice antes.
- **Expansión de producto** (Q5, visión "Bloomberg Terminal"): registrada
  como dirección de largo plazo, explícitamente fuera de alcance antes de
  la evaluación.
- **H-1, H-4, H-5, H-6, H-7, M-3, M-8, M-9, M-10, M-11, L-3, L-5**: sin
  tocar, mismo estado que sesiones anteriores.

## Sesión 13 — C-2 (rutas de trading inline → `server/routes/trading.routes.js`) cerrado y verificado

### Contexto: por qué esta sesión no intentó "todos los pendientes" a la vez

El pedido de arranque fue continuar con **todo** lo que quedaba pendiente.
Antes de tocar código se decidió explícitamente no hacerlo así, por el
mismo criterio que ya viene aplicando este proyecto desde la Sesión 3 (y
que cada sesión posterior repite en su cierre): priorizar 1-2 ítems
completos y verificados end-to-end sobre avanzar parcialmente varios. La
lista de pendientes reales (C-2, C-3, C-5, H-1, H-4, H-5, H-9, H-10, M-3,
M-8, M-9, M-10, M-11, L-3, L-4, L-5) no cabe en una sesión sin repetir
exactamente el tipo de "fix a medias sin verificación cruzada" que este
log lleva 12 sesiones evitando. Motivo adicional concreto: **C-5, H-9 y
L-4 están bloqueados por Q1/Q2** — preguntas abiertas del plan maestro
original (`kukora_master_prompt_opus.md`) cuyo *contenido* no está en este
repo (solo se referencian por número en el log), así que no se pueden
resolver sin que el usuario las responda o adjunte ese documento.

Se tomó por lo tanto el ítem sugerido como siguiente paso sin bloqueos:
**C-2**.

### Baseline

- `npm ci` limpio, `npx vitest run` → **1214 passed | 0 skipped (1214
  total)** — coincide exactamente con el cierre de la Sesión 12 (1207 +
  los 7 tests de `exchangeService.test.js`).

### Investigación previa a tocar código

- El plan describe C-2 como "14 rutas de trading inline en
  `server/index.js`". Se contaron directamente en el código antes de
  mover nada: **13**, no 14 (`GET/POST /mode`, `GET /audit`,
  `POST /test-connection`, `POST /execute/cross`, `GET /rate-limits`,
  `GET /reconciliation`, `POST /2fa/setup`, `POST /2fa/confirm`,
  `GET /2fa/status`, `POST /2fa/disable`, `GET/POST /pairs`). Mismo patrón
  de plan ligeramente desactualizado que H-3, mitad de M-4 y el estado de
  `arbitrageOrchestrator.js` en M-6 — anotado para no repetir el número
  equivocado en el futuro.
- Se revisó la convención ya establecida para extracciones de rutas
  previas ("Audit fix 2.5": `alerts.routes.js`, `watchlist.routes.js`,
  `portfolio.routes.js`, `dataset.routes.js`, más los routers de dominio
  ya existentes desde antes: `crypto.routes.js`, `arbitrage.routes.js`,
  `notifications.routes.js`) para replicar exactamente el mismo patrón
  (`express.Router()`, `module.exports = router`, mismo estilo de
  comentarios de cabecera) en vez de inventar uno nuevo.
- Se verificó que el rate-limiting específico
  (`financialControlLimiter` en `/api/trading/mode`, `/api/trading/2fa`,
  `/api/trading/execute`) sigue funcionando sin tocarlo: son
  `app.use(path, middleware)` registrados directamente en `index.js`,
  ejecutados por Express en orden de registro antes de que la request
  llegue al router nuevo montado más abajo — moverlos hubiera sido un
  segundo cambio innecesario.
- Se mapearon los 4 tests que ejercitan estas rutas vía HTTP real contra
  `require('../server/index.js').app` + supertest
  (`authFlow.e2e.test.js`, `sseConnection.e2e.test.js`,
  `twoFactorTradingGate.e2e.test.js`, y las suites unitarias de
  `liveExecution`/`multiPairService`/`twoFactor`/
  `liveInventoryReconciliation` que no pasan por HTTP) — todos ejercitan
  paths HTTP públicos, no implementación interna, así que una extracción
  pura de organización de código no debería romper ninguno.

### Fix aplicado

1. **Archivo nuevo**: `server/routes/trading.routes.js` — las 13 rutas
   movidas tal cual (mismo cuerpo, mismo orden, mismos middlewares
   `requireAuth`), solo con los paths relativos al mount point
   (`/mode` en vez de `/api/trading/mode`, etc.) y los `require()` de
   `liveExecution`/`multiPairService`/`twoFactor`/
   `liveInventoryReconciliation`/`requireAuth` ajustados a `../` (un nivel
   más profundo que `server/index.js`).
2. **`server/index.js`**: las 13 definiciones inline reemplazadas por
   `app.use('/api/trading', tradingRoutes)`, montado en el mismo bloque
   de routers de dominio (`/api/auth`, `/api/crypto`, `/api/arbitrage`,
   `/api/notifications`). Se quitaron los 4 `require()` que solo
   alimentaban esas rutas (`liveExecution`, `multiPairService`,
   `twoFactor`, `liveInventoryReconciliation`) y `requireAuth` del
   destructure de `./infrastructure/auth` (ya no se usa en `index.js`
   directamente — `hybridAuth` y `authRouter` sí se quedan, se siguen
   usando). `server/index.js` pasó de 563 a 433 líneas.

Cambio puramente de organización de código — mismos paths, mismo
comportamiento observable, cero lógica tocada.

### Verificación final de esta sesión

- `npx vitest run` → **1214 passed | 0 skipped (1214 total)** — sin
  cambios, confirmando que ningún test dependía de que las rutas fueran
  inline.
- `npx eslint src/ server/ --ext .js,.jsx` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run build` → limpio.
- Arranque/shutdown real (`PORT=5098 DEBUG_KUKORA=1 NODE_ENV=production
  node server/index.js`):
  - `/health` respondió `ok:true`, `engine.running:true`.
  - `GET /api/trading/mode` y `GET /api/trading/pairs` sin sesión
    devolvieron `401` (mismo comportamiento que antes de mover las
    rutas — `requireAuth` sigue aplicado correctamente desde el router
    nuevo).
  - `SIGTERM` real: shutdown ordenado, sin reconexiones WS nuevas después
    de la línea de SIGTERM, exit status 0 — mismo patrón que las
    Sesiones 11 y 12 (confirma que C-2 no interfiere con C-1/C-4).

### Pendiente real para la siguiente sesión

- **C-3** (estado mutable global disperso): intacto — siguiente candidato
  natural sin bloqueos conocidos, no se llegó a él porque C-2 se tomó
  completo con su verificación end-to-end.
- **C-5** (`advancedRiskEngine.js`): intacto, **bloqueado por Q1** — el
  contenido real de Q1 no está en este repo, solo el número de referencia
  en el log. Se necesita que el usuario responda la pregunta o adjunte
  `kukora_master_prompt_opus.md` (u otro documento con las Open Questions
  originales) para poder desbloquearlo.
- **H-9** (prefijo `/api/v1/`): intacto, **bloqueado por Q2** (mismo
  problema de contenido faltante que Q1).
- **L-4**: intacto, bloqueado por Q2 también.
- **H-1** (validación con Zod/Joi/AJV), **H-4, H-5** (sin detalle
  registrado en este log más allá del código de ítem — recontar contra el
  plan maestro si se recupera, o contra el código si no), **H-10**
  (Spanish → English, multi-archivo grande): sin tocar.
- **H-6, H-7**: mismo estado que Sesión 10 (investigados, decisión
  explícita de no tocar).
- **M-3, M-8, M-9, M-10, M-11**: sin tocar, mismo estado que Sesión 10.
- **L-3, L-5**: sin tocar.
- **Q1-Q5**: siguen sin respuesta del usuario — bloquean C-5, H-9, L-4 (y
  potencialmente otros si el documento original las referenciaba
  también). **Recomendación concreta para desbloquear más ítems en la
  próxima sesión**: adjuntar `kukora_master_prompt_opus.md` (o responder
  Q1-Q5 directamente) junto con el próximo ZIP.

## Sesión 12 — M-6 (mock de `ws` para `exchangeService.js`) cerrado y verificado

### Baseline

- `npm ci` limpio, `npx vitest run` → **1207 passed | 0 skipped (1207 total)**
  — coincide exactamente con el cierre de la Sesión 11.
- Se verificó línea por línea que C-1 seguía cerrado tal como describe el
  log de la Sesión 11, sin cambios: las 5 llamadas `connectX()` siguen
  dentro de `init()` (líneas 660-668 de `exchangeService.js`), y
  `arbitrage.routes.js` sigue llamando `exchangeService.init()` justo antes
  de `startEngine()` (línea 49). Confirmado por lectura directa del código
  antes de tocar nada, no asumido por el log.

### Investigación previa a tocar código: por qué `vi.mock('ws', ...)` no alcanza

El plan sugería `vi.mock('ws', ...)` como punto de entrada. Antes de
construir la suite completa sobre ese approach, se escribió un test de
sonda descartable (`tests/_probe_ws_mock.test.js`, borrado al terminar la
investigación) para verificarlo empíricamente en vez de asumir que
funcionaría solo porque `ws` es un paquete de `node_modules` (a diferencia
de los `require()` internos a módulos *locales* del proyecto, para los que
`tests/arbitrageOrchestrator.test.js` ya documentaba que `vi.mock()` no
alcanza).

Resultado de la sonda: **0 instancias del mock construidas** —
`exchangeService.js` terminó cargando el paquete `ws` real (no lanzó
excepción porque `new WebSocket(url)` real no falla sincrónicamente; solo
inicia una conexión asíncrona). Mismo diagnóstico de fondo que el caso ya
documentado para módulos locales: `getWSClass()` hace `require('ws')`
dentro de una función invocada sincrónicamente desde `connectX()` una vez
que el módulo CJS ya está cargado — ese `require()` lo resuelve Node
directamente, sin pasar por el grafo ESM de Vite/Vitest, así que
`vi.mock('ws', ...)` nunca lo intercepta. (El caso de `mongoose` en
`tests/setup.js` **no** es un contraejemplo real: la Sesión 7 ya documentó
que ESM-import y CJS-require del mismo specifier mockeado resuelven a dos
instancias *distintas* del mock — es decir, ahí sí hay alguna forma de
intercepción para ambos caminos, solo que produce identidades divergentes;
acá la sonda mostró directamente cero intercepción, el paquete real).

**Decisión**: en vez de forzar `vi.mock('ws')` con workarounds fragiles
(manipular `require.cache` a mano, por ejemplo — descartado por ser mucho
más frágil y menos legible que la alternativa), se replicó el mismo patrón
ya usado y verificado en este proyecto para el problema análogo de
`persistenceService.js`/`mongoose` en la Sesión 7: un seam test-only
explícito (`_mongooseRef` allá, `_WSOverride` acá) — una referencia interna
reasignable con la dependencia real como default.

### Fix aplicado (1 archivo)

`server/infrastructure/exchangeService.js`:

1. `getWSClass()` ahora consulta primero una referencia interna
   `_WSOverride` (default `null`) antes de caer a `require('ws')`. Sin
   overrides activos, comportamiento idéntico a antes (producción no
   cambia).
2. Nuevo export test-only `_setWSClassForTests(WSClass)` — inyecta una
   clase WS falsa (o `null` para restaurar la real).
3. Nuevo export test-only `_resetForTests()` — resetea `_initialized`,
   `_shuttingDown`, `_state`/`_stateETH` (por-exchange) y los caches
   (`_cache`/`_cacheEth`), ya que `exchangeService.js` es un singleton de
   módulo compartido entre todos los `it()` de un mismo archivo de test
   (Vitest no re-ejecuta el cuerpo del módulo CJS entre tests del mismo
   archivo) — sin esto, el segundo test en adelante heredaría
   `_initialized=true` del primero y `init()` sería un no-op.

**Archivo nuevo**: `tests/exchangeService.test.js` — 7 tests, todos usando
el seam de arriba en vez de mockear el módulo `ws`:

- `init()` construye exactamente 5 instancias falsas, una por exchange
  (verificado por URL, no solo por conteo).
- `init()` es idempotente (llamarlo dos veces no duplica sockets).
- Disparar `'open'` en un socket falso solo cambia `wsStatus()` de *ese*
  exchange, no de los demás.
- Un mensaje `'message'` con payload real de Binance bookTicker actualiza
  el feed y `getFreshness()` lo reporta fresco, sin depender de que los
  otros 4 exchanges también reciban datos (evita HTTP fallback real en el
  test).
- `scheduleReconnect()`: un `'close'` programa exactamente un reintento
  tras el backoff esperado (verificado con `vi.useFakeTimers()` +
  `vi.advanceTimersByTime()`, no con timers reales).
- `closeAll()`: termina todos los sockets abiertos, pone `wsReady=false`
  en todos, y **bloquea** reintentos posteriores (se avanzan 35s de timers
  falsos tras `closeAll()` y se verifica que no aparece una 6ª instancia) —
  cubre la misma garantía de C-4 (no reconectar durante shutdown) pero
  ahora con cobertura automatizada en vez de solo verificación manual de
  logs.
- Backoff exponencial agotado (12 reintentos): la 13ª reconexión pasa a
  slow-poll de 5 minutos en vez de abandonar el exchange permanentemente
  (cubre el fix "Issue 22" ya existente en el código, antes sin test).

Se verificó además, corriendo `tests/exchangeService.test.js` junto con
los 3 archivos de test que ya requerían `exchangeService.js` directamente
(`arbitrage.stream/config/query.routes.test.js`), que no hay contaminación
de estado entre archivos — el aislamiento de módulos por archivo de
Vitest ya se encarga de esto, confirmado empíricamente en vez de asumido.

### Verificación final de esta sesión

- `npx vitest run` → **1214 passed | 0 skipped (1214 total)** — 1207 + 7
  tests nuevos, sin romper ninguno existente.
- `npx eslint src/ server/ --ext .js,.jsx` → limpio (incluye el archivo de
  test nuevo).
- `npx tsc --noEmit` → limpio.
- `npm run build` → limpio, mismo output que sesiones anteriores.
- Arranque/shutdown real (`PORT=5097 DEBUG_KUKORA=1 NODE_ENV=production
  node server/index.js`, en un solo proceso de shell):
  - `/health` respondió `ok:true` con `engine.running:true`.
  - Se vieron los 5 intentos reales de conexión WS (403 del proxy de
    egress del sandbox, comportamiento sin cambios respecto a la Sesión
    11 — confirma que el seam nuevo no afecta el camino de producción,
    ya que `_WSOverride` es `null` por default).
  - `SIGTERM` real: shutdown ordenado, `"Shutdown complete in 1ms"`, sin
    ningún intento de reconexión nuevo después de la línea de SIGTERM
    (solo el cierre de un socket OKX a medio conectar, igual patrón que
    la Sesión 11).
  - Exit status 0.

### Pendiente real para la siguiente sesión

- **M-6**: cerrado para `exchangeService.js` (el módulo más débil de los 3
  que señalaba el plan). No se corrió `--coverage` de nuevo en esta sesión
  para actualizar los porcentajes exactos — sugerido como primer paso
  rápido de verificación de la próxima sesión antes de asumir cualquier
  número.
- **C-2** (rutas de trading inline en `server/index.js`, ~494 líneas):
  intacto — sigue siendo la alternativa sin bloqueos sugerida para esta
  sesión, no se llegó a ella porque M-6 se tomó completo.
- **C-3** (estado mutable global disperso): intacto.
- **C-5** (`advancedRiskEngine.js`): intacto, bloqueado por Q1.
- **H-1, H-4, H-5, H-9, H-10**: intactos, sin tocar.
- **H-6, H-7**: mismo estado que Sesión 10 (investigados, decisión
  explícita de no tocar).
- **M-3, M-8, M-9, M-10, M-11**: sin tocar, mismo estado que Sesión 10.
- **L-3, L-4, L-5**: sin tocar, L-4 sigue bloqueado por Q2.
- **Q1-Q5**: siguen sin respuesta del usuario.

## Sesión 11 — C-1 (WebSockets reales conectan a `require()`-time) cerrado y verificado

### Baseline

- `npm ci` limpio, `npx vitest run` → **1207 passed | 0 skipped (1207 total)**
  — coincide exactamente con el cierre de la Sesión 10.
- Se verificó línea por línea en `server/infrastructure/exchangeService.js`
  que las 5 llamadas `connectBinance()/connectKraken()/connectBybit()/
  connectOKX()/connectCoinbase()` seguían a nivel de módulo (líneas
  648-652), sin cambios respecto al audit original — H-6 y H-7 se
  reconfirmaron como investigados-pero-no-tocados en la Sesión 10 (sin
  cambios, no se volvieron a tocar esta sesión).

### Investigación previa a tocar código

- Se mapearon todos los `require('.../exchangeService')` del repo (9
  archivos de `server/` + 4 de `tests/`). Los tests que requieren el
  módulo directamente (`arbitrage.config.routes.test.js`,
  `arbitrage.query.routes.test.js`, `arbitrage.stream.routes.test.js`,
  `smoke.test.js`) todos usan `vi.spyOn()`/mocks sobre las funciones que
  consumen (`getOrderBooks`, `wsStatus`, `getFreshness`, `calcVwapSlippage`)
  y ninguno depende de `wsStatus()`/`isWsConnected()` reales sin mockear —
  confirmado con `grep` que no hay ningún uso de esas dos funciones sin
  `spyOn` en `tests/`.
- Se confirmó que `smoke.test.js` (excluido de `vitest run`, se corre
  aparte con `node tests/smoke.test.js`) ya tenía un comentario explícito
  documentando este mismo problema: el `setInterval` del watchdog a nivel
  de módulo mantenía el proceso vivo indefinidamente en contexto de test,
  forzando un `process.exit(0)` manual al final del smoke test como
  workaround. Esto confirma independientemente el diagnóstico de C-1 del
  plan original.
- Se confirmó que `tests/health.test.js` ya evita deliberadamente
  importar `server/index.js` completo por esta misma razón (comentario
  existente en el archivo, sin relación con esta sesión — se cita solo
  como confirmación adicional del problema).
- Se revisó `server/routes/arbitrage.routes.js:40`, donde ya se llama
  `startEngine()` como efecto secundario de `require()` de ese archivo
  (mismo patrón que el plan sugiere para alojar el nuevo `init()` de
  `exchangeService`). Se decidió replicar ese mismo patrón en vez de
  introducir uno nuevo, para mantener consistencia con cómo el proyecto
  ya arranca el resto del motor.

### C-1 — WebSockets reales conectan a `require()`-time: **cerrado y verificado end-to-end**

**Fix aplicado** (2 archivos):

1. `server/infrastructure/exchangeService.js`: las 5 llamadas
   `connectBinance()/connectKraken()/connectBybit()/connectOKX()/
   connectCoinbase()` que corrían a nivel de módulo se movieron dentro de
   una función exportada `init()`, con una bandera `_initialized` para
   que sea idempotente (llamar `init()` dos veces no abre sockets
   duplicados). La asignación de `_connectFns` (usada por el watchdog
   para reconectar) se dejó a nivel de módulo sin cambios — son solo
   referencias a funciones, no abren sockets, así que no forman parte del
   problema que C-1 describe.
2. `server/routes/arbitrage.routes.js`: se agregó
   `const exchangeService = require('../infrastructure/exchangeService')`
   y una llamada explícita `exchangeService.init()` justo antes de
   `startEngine()` (línea 40), documentado inline como el punto de
   arranque real del servidor — igual que sugería el plan.

**Nota de alcance**: el `setInterval` del watchdog (línea 119,
`_watchdogInterval`) sigue creándose a nivel de módulo, sin cambios. El
problema que describe C-1 en el plan es específicamente sobre abrir los 5
sockets reales, no sobre el watchdog en sí — con las conexiones movidas a
`init()`, el watchdog corre pero no encuentra ningún `st.wsReady` en
`true` hasta que `init()` se llama, así que no hace nada (confirmado:
`isFeedStale` solo actúa sobre exchanges con `wsReady:true`). No se tocó
el watchdog para mantener el fix acotado a lo que C-1 pedía y no
introducir un segundo cambio de comportamiento sin verificar por
separado.

**Verificación real, no solo lectura de código**:

- `npx vitest run` → **1207/1207**, sin cambios — ningún test dependía
  del efecto secundario de conexión al `require()`.
- `npx eslint src/ server/ --ext .js,.jsx` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run build` → limpio, mismo output que sesiones anteriores.
- **Confirmación aislada de que `init()` es lo que dispara las
  conexiones** (no solo lectura de código): se corrió
  `node -e "require(exchangeService); wsStatus() → todo false; luego
  init(); tras 2s → intentos de conexión reales (403 del proxy de
  egress del sandbox, no acceso a binance.com/kraken.com/etc — es la
  restricción de red del entorno, no un fallo del fix) confirmados por
  log con `DEBUG_KUKORA=1`. Sin llamar `init()`, cero intentos de
  conexión incluso después de esperar.
- **Arranque y shutdown real end-to-end** (`PORT=5094 DEBUG_KUKORA=1
  NODE_ENV=production node server/index.js`, en un solo proceso de shell
  para evitar que el sandbox mate el proceso entre llamadas):
  - `/health` respondió `ok:true` con `engine.running:true`.
  - Se vieron los 5 intentos reales de conexión WS (`[Binance WS]`,
    `[Kraken WS v2]`, `[Bybit WS]`, `[Coinbase WS]`, `[OKX WS]`) —
    confirmando que `init()` sí dispara las conexiones desde el arranque
    real del servidor, igual que antes del fix (mismo comportamiento
    observable, solo que ahora es explícito en vez de un efecto
    secundario del `require()`).
  - Se envió `SIGTERM` real al proceso. El log mostró
    `"SIGTERM — graceful shutdown initiated"`, los 5 pasos del
    coordinator de C-4 corriendo sin ningún `"shutdown: ... failed"`, y
    **cero intentos nuevos de reconexión** después de esa línea — el
    único evento WS post-SIGTERM fue el cierre de un socket OKX que
    estaba a medio conectar, disparado por `closeAll()`, no un nuevo
    intento de reconexión.
  - El proceso terminó con exit status 0 sin necesitar el failsafe de 5s.
  - Esto confirma que C-1 y C-4 siguen coordinando correctamente juntos:
    mover las conexiones a `init()` no rompió nada del coordinator de
    shutdown de la Sesión 10.

### Verificación final de esta sesión

- `npx vitest run` → **1207 passed | 0 skipped (1207 total)**.
- `npx eslint src/ server/ --ext .js,.jsx` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run build` → limpio.
- Arranque/shutdown real confirmado como se describe arriba (arranque
  real con conexiones WS reales + SIGTERM real, no solo arranque).

### Pendiente real para la siguiente sesión

- **M-6**: ahora desbloqueado en teoría (`exchangeService.js` ya no
  conecta al `require()`, así que un test puede requerir el módulo sin
  abrir sockets y luego decidir si llama `init()` o no). **No se escribió
  ningún test de cobertura para `exchangeService.js` en esta sesión** —
  eso sigue siendo trabajo real pendiente (diseñar un mock de `ws` sigue
  haciendo falta para testear las funciones `connectX()` en sí mismas,
  aunque ya no haga falta para simplemente importar el módulo). Punto de
  entrada sugerido: ahora que `init()` existe, escribir tests que
  importen el módulo, mockeen `require('ws')` (por ejemplo con
  `vi.mock('ws', ...)`, verificando con un marcador de identidad si hace
  falta, según la Regla 5 de sesión), llamen `init()`, y verifiquen el
  comportamiento de `connectX()`/`scheduleReconnect()`/`closeAll()` sin
  red real.
- **C-2** (rutas de trading inline en `server/index.js`, ~494 líneas):
  intacto.
- **C-3** (estado mutable global disperso): intacto.
- **C-5** (`advancedRiskEngine.js`): intacto, bloqueado por Q1.
- **H-1, H-4, H-5, H-9, H-10**: intactos, sin tocar.
- **H-6, H-7**: mismo estado que Sesión 10 (investigados, diagnóstico
  completo documentado ahí, decisión explícita de no tocar).
- **M-3, M-8, M-9, M-10, M-11**: sin tocar, mismo estado que Sesión 10.
- **L-3, L-4, L-5**: sin tocar, L-4 sigue bloqueado por Q2.
- **Q1-Q5**: siguen sin respuesta del usuario.


## Sesión 22 — H-5 (partición de `arbitrageLoop()` en funciones testeables): cerrado y verificado

### Punto de partida real (no confiar en el plan sin verificar)

Esta sesión retomó un trabajo de H-5 ya **iniciado en una sesión de chat
anterior que se cortó por límite de tokens** (no reflejado todavía en este
log — el zip de partida (`kukora_session21.zip`) tenía H-5 sin empezar, pero
el usuario adjuntó las 2 versiones de archivo en progreso: `arbitrageOrchestrator.js`
ya con las funciones extraídas, y `arbitrageOrchestrator.test.js` con la
cobertura nueva pero **3 tests fallando** sin resolver). Se verificó el
estado real corriendo la suite antes de asumir nada del historial de chat
pegado:

- `npx vitest run tests/arbitrageOrchestrator.test.js` → **2 tests
  fallando** de los 3 reportados en el historial (el tercero, `volBlocked`,
  ya pasaba — probablemente dependía de un orden de ejecución de tests
  ligeramente distinto entre la sesión de chat cortada y este entorno).

### Diseño ya aplicado (heredado de la sesión cortada, verificado contra el código)

`arbitrageLoop()` (~798 líneas originales) ya estaba partido en las
siguientes funciones puras/testeables, todas extraídas **verbatim** (sin
cambio de comportamiento) y exportadas para tests directos:

- `selectBestOpportunity(opportunities, now)` / `selectBestEthOpportunity(ethOpportunities)`
  — selección pura de la mejor oportunidad ejecutable (BTC con
  fingerprint check, ETH sin él — mismo comportamiento pre-extracción).
- `emitSystemicAlerts(tickCount)` — alertas throttled de daily-stop
  (cada 20 ticks) y exchange-degraded (cada 60 ticks).
- `checkExecutionGuards(tickCount)` — los 3 guards de pre-ejecución
  (weekly loss/target, daily target, filtro de volatilidad) con sus logs
  throttled.
- `detectEthOpportunities(tickCount)` — detección bilateral ETH (GAP 4),
  auto-gateada a ticks pares, nunca propaga errores (feed ETH no debe
  frenar el loop BTC).
- `detectBtcOpportunities(orderBooks, tickCount)` — detección principal
  por tick, orquesta también `detectEthOpportunities()`.
- `evaluateAndExecuteBtc(...)` / `evaluateAndExecuteEth(...)` — decisión
  de ejecución completa (gates + selección + `executeBestOpportunity()`
  real), con la garantía H-6 de que ETH pasa por el mismo camino
  unificado que BTC.
- `trackMissedOpportunities(opportunities, tickCount)` — housekeeping de
  oportunidades no ejecutadas, throttled a ticks pares.
- `buildEnrichmentData(...)` / `buildTickPayload(...)` — enriquecimiento
  de inteligencia (throttled por distintas cadencias: 3/5/7/10 ticks) y
  ensamblado del payload SSE final.

`arbitrageLoop()` en sí quedó como un orquestador delgado que llama a
estas funciones en secuencia — mismo comportamiento observable, ahora con
cobertura directa en vez de solo indirecta vía `executeBestOpportunity()`.

### Bug real encontrado y corregido: `vi.restoreAllMocks()` rompía spies globales entre bloques `describe`

Los 2 tests que seguían fallando (`evaluateAndExecuteBtc`/`evaluateAndExecuteEth`
— "ejecuta la mejor oportunidad BTC/ETH") tenían síntoma `lastTrade: null`
cuando se esperaba un trade ejecutado. Diagnóstico:

1. El bloque `describe('H-5: emitSystemicAlerts', ...)` y el bloque
   `describe('H-5: evaluateAndExecuteBtc / evaluateAndExecuteEth', ...)`
   tenían un `afterEach(() => { vi.restoreAllMocks(); ... })`.
   `vi.restoreAllMocks()` no es local al `describe` — restaura **todos**
   los spies del archivo, incluidos los creados a nivel de módulo antes de
   `require(orchestrator)` (`preTradeRiskCheckSpy`, `tsm.transition`,
   `walletMgr.applyTrade`, etc., ver cabecera del archivo de test sobre por
   qué esos deben crearse antes del require). Una vez restaurados, esos
   spies quedan **desconectados** del objeto módulo real: llamar
   `.mockReturnValue(...)` sobre el spy huérfano ya no afecta lo que
   `advancedRiskEngine.preTradeRiskCheck(...)` ejecuta de verdad dentro del
   orchestrator.
2. El resultado: en cualquier test que corriera **después** de uno de esos
   dos bloques, `executeBestOpportunity()` invocaba el `preTradeRiskCheck`
   **real** (no mockeado) contra estado de riesgo acumulado por docenas de
   trades simulados de tests previos — y ese risk check real a veces
   rechazaba la operación, dejando `evaluateAndExecuteBtc`/`Eth` con
   `lastTrade: null`.

**Fix aplicado** (solo en el archivo de test, sin tocar
`arbitrageOrchestrator.js`): reemplazar `vi.restoreAllMocks()` por el
patrón de "spies locales" ya usado correctamente en el bloque
`H-5: checkExecutionGuards` (un array `localSpies` poblado solo por
`vi.spyOn()` hechos dentro de ese `describe`, restaurado con
`s.mockRestore()` uno por uno). Este patrón ya estaba documentado como la
forma correcta en un comentario del propio archivo — solo faltaba
aplicarlo a los otros 2 bloques.

### Segundo bug real encontrado: fixture de test con exchange inventado

El test "ejecuta la mejor oportunidad BTC y devuelve el trade en
`lastTrade`" seguía fallando tras el fix de arriba. Con logging temporal
se confirmó que `evaluateAndExecuteBtc` sí encontraba la oportunidad y
llamaba a `executeBestOpportunity()`, pero el `executeSimulated()` **real**
(intencionalmente no mockeado en este bloque, ver nota en la cabecera del
archivo) fallaba: la oportunidad usaba `buyExchange: 'X', sellExchange: 'Y'`
— nombres inventados para evitar colisión de fingerprint con otros tests
— pero el wallet mockeado (`getBalancesSpy`) solo define saldos para
`Binance`/`Kraken`. Contra un exchange desconocido, la simulación real de
ejecución no tiene de dónde tomar/depositar fondos y falla por diseño
(comportamiento correcto del código de producción, no un bug del
orchestrator). Fix: usar `buyExchange: 'Binance', sellExchange: 'Kraken'`
(que sí existen en el wallet mockeado) y mantener la unicidad de
fingerprint únicamente vía `buyPrice`/`sellPrice`/`spreadPct` distintos —
el fingerprint ya incluye esos 3 campos, así que no hacía falta inventar
nombres de exchange.

**Ningún bug de producción encontrado en `arbitrageOrchestrator.js` en
esta sesión** — los 3 tests que fallaban eran, en los 3 casos, problemas
del propio arnés de test (que ya venían parcialmente diagnosticados por
la sesión de chat cortada, mencionados en su comentario de cabecera).

### Verificación final de esta sesión

- `npx vitest run tests/arbitrageOrchestrator.test.js` → **72/72** (antes:
  2 fallando de 72).
- `npx vitest run` (suite completa) → **1289 passed | 0 failed
  (1289 total)**, sin regresiones en ningún otro archivo.
- `npx eslint src/ server/ --ext .js,.jsx` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run build` → limpio (mismo output que sesiones anteriores, 961
  módulos).
- `npm run check:ts-drift` → sin drift (6 archivos verificados).
- **Arranque/shutdown real end-to-end**, en un solo bloque de shell (para
  evitar que el sandbox mate el proceso en segundo plano entre llamadas —
  lección ya documentada en la Sesión 11):
  - `PORT=5098 JWT_SECRET=... JWT_REFRESH_SECRET=... NODE_ENV=production
    node server/index.js` → `/health` respondió `engine.running:true`
    (motor arrancado con el `arbitrageLoop()` ya particionado corriendo
    normalmente).
  - `SIGTERM` real → log mostró `"SIGTERM — graceful shutdown initiated"`,
    el handler `bot_state` del watchdog corriendo, y
    `"Shutdown complete in 0ms"`. El proceso terminó (`kill -0` confirmó
    que ya no existía) sin necesitar el failsafe.

### Cobertura de H-5 (estado final)

`arbitrageOrchestrator.test.js` ahora tiene bloques de test dedicados y
**directos** (no solo indirectos vía `executeBestOpportunity()`) para:
`selectBestOpportunity`/`selectBestEthOpportunity`, `checkExecutionGuards`,
`emitSystemicAlerts`, `trackMissedOpportunities`, `detectEthOpportunities`,
`detectBtcOpportunities`, `evaluateAndExecuteBtc`/`evaluateAndExecuteEth`,
y `buildEnrichmentData`/`buildTickPayload`. `arbitrageLoop()` (el
orquestador delgado que las llama en secuencia) sigue sin un test que
ejercite el `setTimeout` recursivo real end-to-end — eso requeriría
control de temporizadores falsos (`vi.useFakeTimers()`) contra un loop que
hace I/O real de exchanges, y se consideró fuera de alcance de H-5 (que
pedía testear las funciones puras extraídas, no el wrapper del loop en
sí). Si se quiere esa cobertura adicional en el futuro, es un ítem nuevo,
no una deuda de H-5.

### Pendiente real para la siguiente sesión

- **H-5**: cerrado.
- Con margen de tokens, el orden sugerido por el usuario para continuar es:
  1. Robustez y parametrización general (profundidad de configuración,
     comportamiento ante fallos).
  2. M-8/M-9/M-10/M-11 (frontend).
  3. L-3 (`CHANGELOG.md`) — **preguntar al usuario** qué "rondas"
     históricas conservar antes de tocarlo (juicio editorial, no técnico).
  4. C-3 (estado mutable global disperso) y H-9 (bloqueado por Q2) si el
     tiempo alcanza.
  5. H-10 (multi-idioma real) al final de todo.
- **C-2, C-3, C-5, H-1, H-4, H-9, H-10, M-3, M-6, M-8-M-11, L-3, L-4, L-5,
  Q1-Q5**: sin cambios respecto al estado de la Sesión 21 (ver arriba).

## Sesión 23 — Reconciliación C-2/H-1/H-4 (el plan estaba desactualizado, igual que con H-3/M-4 en sesiones previas) + M-6 (healthService.js) + L-3 (CHANGELOG.md) cerrados y verificados

### Punto de partida: verificación directa contra el código, no contra el log

Antes de tocar nada, se auditó el estado real de C-2, H-1 y H-4 leyendo el
código fuente directamente (mismo criterio que ya encontró desactualizaciones
del plan en H-3 y M-4). Resultado: **los 3 ítems ya estaban cerrados en
rondas anteriores no reflejadas en la última entrada de "pendiente real" de
este log**:

- **C-2**: `server/index.js` (432 líneas) ya no tiene lógica de negocio
  inline — solo wiring de Express y 3 endpoints operacionales internos
  (`/health`, `/api/readiness`, `/api/metrics`, todos con `internalOnly`).
  Todas las rutas de negocio (`trading`, `arbitrage`, `crypto`,
  `notifications`, `alerts`, `watchlist`, `portfolio`, `dataset`) viven en
  `server/routes/*.routes.js` montadas vía `app.use()`. **Cerrado,
  verificado por lectura completa de `server/index.js`.**
- **H-1**: se auditaron los endpoints mutantes (`POST`/`PATCH`/`DELETE`) de
  las 7 rutas restantes (`alerts`, `watchlist`, `portfolio`, `dataset`,
  `notifications`) — todos tienen validación real: manual vía
  `server/domain/validation.js` (alerts/watchlist/portfolio) o chequeos de
  forma/tamaño explícitos (`dataset.routes.js`, límite de 10,000 filas).
  `trading.routes.js` ya tiene Zod completo. **Cerrado.**
- **H-4**: `server/repositories/index.js` ya tiene el fix documentado
  (distingue error real de Mongo vs. "sin resultados"). Los 8
  `.catch(() => [])` restantes en el repo son de `getOrderBooks()`
  (caché en memoria del feed WS, no MongoDB) — fuera del alcance real de
  H-4, que era específicamente sobre errores de conexión a Mongo.
  **Cerrado.**

**Nota para las siguientes sesiones**: parece que un tramo de trabajo entre
la Sesión 13 (donde se ve "C-2: rutas de trading... extraídas") y la Sesión
21 no quedó documentado en este log con el mismo detalle que el resto —
mismo patrón de log desactualizado ya visto 2 veces antes (H-3, mitad de
M-4). Vale la pena, en la próxima sesión con margen, revisar si hay más
ítems en esta misma situación antes de asumir que algo "sigue abierto"
solo porque la última entrada de este log lo dice.

### M-6 — healthService.js: de 11.5% a 88.46% de líneas

`server/infrastructure/healthService.js` era el gap de cobertura más grande
y más fácil de cerrar sin red real (diagnosticado en la Sesión 9). Se
agregó `tests/healthService.test.js` (7 tests): DB conectada/no conectada,
ping de Mongo exitoso/fallido, shape del payload (engine/redis/feeds/memory),
sin necesitar Mongo/Redis/motor reales.

**Límite encontrado (mismo fenómeno ya documentado en
`tests/exchangeService.test.js` para `require('ws')`)**: `healthService.js`
hace `require('../application/arbitrageOrchestrator')` y `require('./auth')`
de forma perezosa dentro del cuerpo de la función. `vi.doMock()` no
intercepta esos `require()` internos a módulos locales del proyecto, así
que los tests ejercitan las ramas try/catch con los módulos reales (que sí
cargan sin red) en vez de forzar artificialmente la rama catch de esos 2
bloques — sigue siendo cobertura real, solo que no cubre el caso
"arbitrageOrchestrator no disponible" de forma aislada. Si se quiere esa
cobertura específica en el futuro, haría falta el mismo patrón de seam
test-only (`_setWSClassForTests`) ya usado en `exchangeService.js`.

Cobertura global subió de 66.42/55.93/63.61/69.79 (líneas/branches/
funciones/statements) a **70.02/56.21/63.67/66.59** (ver nota sobre orden
de columnas del reporte v8 en `vitest.config.js`). Umbrales subidos con
margen (~2pt por debajo de lo medido, mismo criterio que rondas
anteriores): `lines:68, functions:61, branches:54, statements:64`.

**Pendiente real de M-6** (no cerrado del todo — gaps grandes que quedan,
diagnóstico honesto): `spreadHeatmapService.js` (18%), `crypto.service.js`
(16%), `exchangeService.js` (47%, cobertura parcial ya existente de
`connectX()`/`init()`, faltan más ramas de `scheduleReconnect()`/
`closeAll()`), `liveInventoryReconciliation.js`/`replayService.js` (55-60%).

### L-3 — CHANGELOG.md condensado (32KB → resumen por entrada + archivo separado)

Sin instrucción editorial explícita del usuario sobre qué "rondas"
conservar (bloqueante original de L-3), se tomó la decisión más segura:
**no borrar nada**. Se copió el archivo completo a `CHANGELOG_ARCHIVE.md`
(497 líneas, intacto) y se reescribió `CHANGELOG.md` con un resumen de 2-4
bullets por entrada de las rondas más verbosas (19, 20, 22, 23 — las
entradas de versiones numeradas 2.x/1.x ya eran concisas y se dejaron tal
cual). `CHANGELOG.md` quedó en 287 líneas, con una nota al inicio que
enlaza al archivo completo y a `MIGRATION_CLEANUP_LOG.md`.

### Verificación final de esta sesión

- `npx vitest run` → **1296 passed | 0 failed (1296 total)** — 73 archivos
  (72 + `healthService.test.js`), 7 tests nuevos, cero regresiones.
- `npx vitest run --coverage` → thresholds nuevos pasan limpio.
- `npx eslint server/ src/ --ext .js,.jsx` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run build` → limpio.
- Arranque/shutdown real end-to-end (`PORT=5099 NODE_ENV=production node
  server/index.js`, bloque único de shell): `/health` respondió
  `engine.running:true`; `SIGTERM` real disparó
  `"SIGTERM — graceful shutdown initiated"`, el handler `bot_state` del
  watchdog, y `"Shutdown complete in 1ms"`; proceso confirmado terminado
  (`kill -0` negativo) sin necesitar el failsafe.

### Pendiente real para la siguiente sesión

- **C-3** (estado mutable global disperso): investigado a fondo esta
  sesión (no solo asumido) — la mayoría de los archivos con `let _foo` a
  nivel de módulo (`arbitrage.state.js`, `advancedRiskEngine.js`,
  `opportunityDetection.js`, etc.) **ya usan el patrón correcto**: estado
  privado del módulo, expuesto solo vía funciones getter/setter/reset, no
  variables crudas accedidas directamente desde otros módulos. Esto es un
  patrón de singleton de módulo razonable y ya testeado (1296 tests lo
  ejercitan sin problema) — no el caos sin encapsular que el plan original
  describía. El costo real que queda (no una corrección, sino una
  limitación de diseño): un singleton de módulo no permite múltiples
  instancias independientes (ej. multi-tenant, o correr 2 bots en el mismo
  proceso para tests de integración más realistas). **Decisión sugerida**:
  no atacar esto como un refactor de emergencia — es riesgoso tocar el
  motor de trading en vivo sin una razón de producto concreta. Dejarlo
  documentado como deuda arquitectónica aceptada a propósito, y solo
  revisitarlo si Q5 (expansión de producto) llega a requerir multi-tenancy
  real.
- **C-5** (`advancedRiskEngine.js` como artefacto TS compilado
  hand-editado): sigue intacto — desbloqueado por Q1 desde la Sesión 14,
  pendiente de implementación real (fusionar `.ts`/`.js` o generar el `.js`
  desde el `.ts` en build).
- **M-6**: parcialmente cerrado (ver arriba) — `spreadHeatmapService.js`,
  `crypto.service.js`, resto de `exchangeService.js` siguen bajos.
- **H-9** (`/api/v1/` prefix): desbloqueado por Q4, sigue pospuesto a
  propósito (riesgo de romper el frontend/28 páginas sin necesidad real
  antes del 12 de julio).
- **H-10** (traducción ES→EN completa, multi-archivo): sin tocar.
- **M-3** (payload SSE sin deltas), **M-8 a M-11** (frontend: componentes
  gigantes, sin TS, sin abstracción de API, sin E2E): sin tocar, mismo
  estado que sesiones anteriores.
- **L-5** (estrategia de migraciones de DB): sin tocar.

## Sesión 24 — M-6 continuado: crypto.service.js y spreadHeatmapService.js

### crypto.service.js: 16% → 91.02% de líneas

Se agregó `tests/cryptoService.test.js` (7 tests): `getMarkets()` (fetch +
`computeMetrics()` — gainers/losers/volatility_score + slicing por límite),
cache con TTL (`cached()`), cola secuencial anti-429 vía `retry()`, manejo
de 429 con y sin cache stale, error no-OK sin cache, y construcción de URLs
para `getCoinDetail`/`getOHLC`/`getPriceHistory`. `global.fetch` mockeado
con `vi.stubGlobal`; el módulo se re-requiere (`require.cache` limpio) en
cada test porque mantiene caches a nivel de módulo (`_memCache`, `cache`
Map, `_queue`).

### spreadHeatmapService.js: 18% → cobertura parcial de las rutas en memoria

Se agregó `tests/spreadHeatmapService.test.js` (6 tests): `record()`
(acumulación + rechazo de spreads no numéricos/no finitos), `getHeatmap()`/
`getHeatmapSimple()` en memoria (avgSpread/maxSpread/viableRate/bestHour),
`flush()` no-op (sin datos sucios, sin Mongo listo), y `startPeriodicFlush()`.

**Se investigó y se descartó, con honestidad, la rama "Mongo listo"** de
`flush()`/`getHeatmap()` (mutando `mongoose.connection.readyState = 1` vía
el mock global de `tests/setup.js`): los 2 tests candidatos tardaban ~10s
cada uno — sospechosamente igual al `serverSelectionTimeoutMS` por defecto
de Mongoose real, indicio de que en ese punto se toca el driver real en vez
del mock (posible artefacto de cómo `HeatmapBucket.js` cachea su modelo
antes de que el mock de `mongoose` aplique para ese archivo específico). No
se dejaron esos 2 tests en el suite — más vale una cobertura ligeramente
menor que 2 tests lentos y potencialmente flaky en CI. Queda como item
propio para una futura sesión de M-6 si se quiere cerrar del todo.

### Verificación final de esta sesión

- `npx vitest run` → **1309 passed | 0 failed (1309 total)** — 75 archivos
  (73 + 2 nuevos), 13 tests nuevos sobre la Sesión 23, cero regresiones.
- `npx vitest run --coverage` → **statements 68.04% / branches 57.26% /
  functions 66.45% / lines 71.2%** (subiendo desde 66.59/56.21/63.67/70.02
  de la Sesión 23). Umbrales subidos con margen:
  `lines:70, functions:65, branches:56, statements:67`.
- `npx eslint server/ --ext .js` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run build` → limpio.
- Arranque/shutdown real end-to-end (`PORT=5100`, bloque único de shell):
  `/health` con `engine.running:true`, `SIGTERM` real →
  `"Shutdown complete in 2ms"`, proceso confirmado terminado.

### Pendiente real para la siguiente sesión

- **M-6**: sigue parcialmente cerrado. Quedan bajos: `exchangeService.js`
  (47%), la rama "Mongo listo" de `spreadHeatmapService.js` (ver
  diagnóstico arriba), `liveInventoryReconciliation.js`/`replayService.js`
  (55-60%).
- **C-3, C-5, H-9, H-10, M-3, M-8 a M-11, L-5**: sin cambios respecto a la
  Sesión 23 (ver esa entrada para el detalle completo de cada uno).

## Sesión 25 — C-5 y L-5 ya estaban cerrados (otra vez el log desactualizado) + H-9 cerrado de verdad + M-3 investigado y descartado con honestidad

### C-5: ya resuelto — no encontrado por el log, encontrado por auditoría directa

Se verificó `server/domain/advancedRiskEngine.js` directamente: **es un
artefacto compilado por `tsc`** (`outDir:"."`, `rootDir:"server-types"` en
`tsconfig.json` — compila `server-types/server/domain/advancedRiskEngine.ts`
→ `server/domain/advancedRiskEngine.js`), y ya existe
`scripts/checkTsBuildDrift.js` (`npm run check:ts-drift`), **ya integrado
en CI** (`.github/workflows/ci.yml`, paso "TypeScript build-drift check
(C-5 / ADR-013)"). Se corrió el check: `✅ Sin drift: los .js comiteados
coinciden con lo que tsc generaría (6 archivos verificados)`. **C-5 estaba
cerrado desde antes de la Sesión 24** — otra vez el mismo patrón de log
desactualizado (C-2/H-1/H-4 en la Sesión 23, ahora C-5). Recomendación para
la próxima sesión: antes de asumir CUALQUIER ítem del plan como abierto,
buscar primero si ya existe un ADR o script relacionado (`docs/ADR-*.md`,
`scripts/`) — parece que varias sesiones cerraron ítems documentándolos
como ADR en vez de como entrada de este log, y esa pista se perdió.

### L-5: también ya resuelto — `docs/ADR-014-db-migration-strategy.md`

Ya existe una ADR completa (fechada 2026-07-04) que audita el estado real
(0 carpetas de migración, 0 dependencias de migración, evolución de schema
históricamente solo aditiva) y adopta un runner casero mínimo sin
dependencia externa: convención `server/infrastructure/persistence/migrations/NNNN_descripcion.js`
con `{up, down}`, ejecución manual (mismo criterio que ADR-013 para no
automatizar nada que toque producción sin revisión humana). La carpeta ya
existe con su `README.md`. **L-5 cerrado, verificado.**

### H-9: cerrado de verdad esta sesión (no era un falso positivo del log — sí seguía abierto)

A diferencia de C-5/L-5, se verificó que H-9 **sí** seguía genuinamente
abierto (`grep` confirmó cero menciones de `/api/v1` en todo `server/`).
Se implementó como alias puramente aditivo — ver
`docs/ADR-015-api-versioning.md` para el detalle completo de la decisión:

- Las mismas instancias de router para `auth`, `crypto`, `arbitrage`,
  `notifications`, `trading`, `alerts`, `watchlist`, `portfolio`, `dataset`
  ahora se montan en `['/api/xxx', '/api/v1/xxx']` simultáneamente.
- `apiLimiter` y `financialControlLimiter` extendidos de la misma forma
  (arrays de paths) — `/api/v1/...` tiene exactamente las mismas
  protecciones que `/api/...`, no una superficie nueva sin guardrails.
- Los endpoints operacionales (`/health`, `/api/readiness`, `/api/metrics`)
  quedan fuera del versionado a propósito (no son parte del contrato de
  negocio).
- **Cero cambios en `src/`** — el frontend sigue usando `/api/...` sin
  ningún cambio de código ni de comportamiento.

**Verificación real end-to-end** (servidor vivo en `PORT=5101`):
`/api/crypto/global` y `/api/v1/crypto/global` devolvieron el mismo 503
(sin red en este sandbox — comportamiento idéntico en ambos prefijos es lo
que importa); `/api/watchlist` y `/api/v1/watchlist` devolvieron el mismo
401 (mismo middleware `requireAuth` aplicado igual en ambos). `SIGTERM`
real → shutdown limpio.

### M-3: investigado a fondo, descartado por esta sesión con razón concreta

Se localizó el payload real de ~50+ campos: `buildTickPayload()` en
`server/application/arbitrageOrchestrator.js`, emitido cada tick (~150ms)
vía `pushToSSE()`. Ya tiene una mitigación parcial existente que el plan
original no mencionaba: varios campos pesados (`journalSummary`,
`statArbSummary`, `missedSummary`, `reliabilityScores`,
`adaptiveRecommendation`, `history`, `equityCurve`, `lifecycleHistory`,
`auditedPnl`) solo se incluyen cada N ticks (`tickCount % 5/8/10/15 === 0`),
no en cada tick. Lo que queda sin throttle real es `orderBooks`,
`opportunities`, `wallets`, `pnl`, `wsStatus`, `feedFreshness` — el core
"caliente" del feed.

**Por qué no se implementó en esta sesión**: convertir esto a deltas reales
requiere cambiar el contrato del feed en 2 lados a la vez — el backend
(diffing contra el payload anterior) y el consumidor del frontend (que
hoy espera reemplazar su estado completo con cada `tick`, no mergear un
delta). Es un cambio de comportamiento real de un sistema de trading en
vivo, y no se puede verificar de forma confiable en este entorno sin un
consumidor SSE real corriendo en un browser contra datos de mercado en
vivo — exactamente el tipo de cambio a medias que las reglas de esta
sesión piden evitar. Queda documentado como el siguiente candidato natural
de M-3 para una sesión con acceso a probarlo end-to-end con el frontend
real.

### Verificación final de esta sesión

- `npx vitest run` → **1309 passed | 0 failed** (sin cambios de conteo —
  H-9 no agrega tests nuevos, es un cambio de wiring verificado
  manualmente contra un servidor real, ver arriba).
- `npm run check:ts-drift` → limpio (0 drift, 6 archivos).
- `npx eslint server/ --ext .js` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run build` → limpio.
- Arranque/shutdown real end-to-end con verificación específica de ambos
  prefijos de API (`PORT=5101`, bloque único de shell) — ver detalle
  arriba.

### Estado real y honesto al cierre de la Sesión 25

**Cerrados y verificados**: C-1, C-2, C-4, C-5, H-1, H-2, H-3, H-4, H-5,
H-6, H-7, H-9, L-1, L-2, L-3, L-4, L-5, M-1, M-2, M-4, M-5, M-6 (parcial —
ver detalle de gaps restantes en Sesión 24).

**Genuinamente pendientes** (verificados como abiertos, no por descuido de
lectura del log):
- **H-10** (traducción ES→EN completa, multi-archivo con i18n real):
  scope grande, no evaluado a fondo esta sesión por presupuesto de tiempo.
- **M-3** (deltas reales en el payload SSE): investigado a fondo, requiere
  cambio coordinado backend+frontend verificable solo con un consumidor
  real — ver análisis arriba.
- **M-8 a M-11** (frontend: TS, abstracción de API, E2E, componentes
  gigantes): sin tocar, mismo estado que sesiones anteriores.
- **C-3**: deuda arquitectónica aceptada a propósito (ver Sesión 23) — no
  es un pendiente en el sentido de "hay que cerrarlo", es una decisión ya
  tomada.

Con esto, de los 8 ítems que quedaban listados al inicio de esta sesión,
**3 ya estaban cerrados sin que el log lo reflejara (C-5, L-5, y M-6 fue
parcial ya reportado)** y **1 se cerró de verdad hoy (H-9)**. Quedan 4
genuinamente abiertos: H-10, M-3, M-8-M-11 (y C-3 como deuda aceptada, no
pendiente activo).

## Sesión 26 — H-10 rescopeado por decisión explícita del usuario, implementado y verificado (con QA visual pendiente por parte de Gabriel)

### Decisión de alcance (antes de tocar código)

Se preguntó explícitamente antes de empezar, porque el H-10 original
("estandarizar TODO a inglés — código, comentarios, labels de UI") entra
en conflicto directo con cómo está escrito el 100% del proyecto hasta
hoy (comentarios en español en las 25 sesiones previas, por decisión del
propio Gabriel). Decisión tomada por Gabriel para esta sesión:

- **NO tocar comentarios ni nombres de variables en el código** — quedan
  en español como están.
- **Sí implementar i18n real para lo que ve el usuario** — español como
  idioma por defecto de la plataforma, inglés disponible como alternativa.

Esto reescala H-10 de "reescribir ~15,000 líneas" a "construir la
infraestructura de i18n + traducir los labels visibles ya identificados"
— mucho más acotado, verificable, y coherente con el resto del proyecto.

### Qué se implementó

1. **`src/i18n/dictionaries/es.js` / `en.js`** — diccionarios espejo
   (mismo árbol de llaves en los dos, ver `nav`, `navTip`, `common`,
   `triangular`). Español es el default.
2. **`src/i18n/I18nContext.jsx`** — `I18nProvider` + hook `useTranslation()`.
   Sin dependencia externa (mismo criterio que ADR-013/ADR-014: no meter
   `react-i18next` hasta que la necesidad real lo justifique — con 2
   idiomas, un lookup por objeto alcanza). Persiste la preferencia en
   `localStorage` bajo `kukora_lang` (mismo patrón ya usado en el proyecto
   para el tema claro/oscuro). Si falta una llave en el idioma activo,
   cae a español antes que mostrar la key cruda — nunca un string roto
   visible.
3. **`scripts/checkI18nCoverage.js`** (+ `npm run check:i18n`, + paso en
   `.github/workflows/ci.yml`) — mismo espíritu que
   `checkTsBuildDrift.js` (C-5): falla si `es.js` y `en.js` alguna vez
   tienen conjuntos de llaves distintos. Corrido: **✅ 68 llaves en
   paridad.**
4. **`src/App.jsx`** — `I18nProvider` agregado al árbol de providers.
5. **`src/components/layout/navConfig.js`** — los 24 items del nav ahora
   usan `labelKey`/`tipKey` en vez de strings fijos.
6. **`src/components/layout/NavItem.jsx`** y **`Layout.jsx`** — resuelven
   las llaves vía `t()`; se agregó un botón selector de idioma (ES/EN) en
   el header, junto al toggle de tema, mismo estilo visual.
7. **`src/components/common/TriangularPanel.jsx`** — el caso concreto que
   el plan original citaba ("Profit neto" mezclado con inglés) ahora pasa
   por i18n de punta a punta: título, descripción, y los 6 headers de la
   tabla de rutas.

### Qué NO se tocó (a propósito, y por qué)

El resto de los 28 páginas (~8,266 líneas de JSX) probablemente tienen
más strings de UI en español o mezclados sin pasar por i18n todavía —
**no se auditaron ni se tocaron esta sesión**. Extender la cobertura
requiere revisar página por página qué es texto visible al usuario (para
mover a los diccionarios) vs. qué es dato dinámico/nombre técnico (que no
debe traducirse) — ese es un trabajo de juicio, no mecánico, y hacerlo sin
poder ver la UI renderizada real habría sido apurar exactamente el tipo de
cambio a medias que se busca evitar.

### Verificación de esta sesión

- `npm run build` (Vite) → limpio, 964 módulos, sin errores.
- `npx eslint src/ --ext .js,.jsx` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run check:i18n` → ✅ 68 llaves en paridad.
- `npm run check:ts-drift` → ✅ sin drift (no afectado por esta sesión,
  confirmado de nuevo por completitud).
- `npx vitest run` → **1314 passed | 0 failed** (1309 + 5 tests nuevos de
  `tests/i18n.test.js` — cobertura de los diccionarios y la función de
  lookup/fallback; no hay tests de componentes React montados porque
  `vitest.config.js` usa `environment:'node'` sin jsdom, ver M-9/M-10 más
  abajo — se documentó la razón dentro del propio archivo de test).
- Arranque/shutdown real end-to-end (`PORT=5102`) → `/health` responde,
  `SIGTERM` → shutdown limpio.

**Lo que Gabriel necesita probar en su máquina (no verificable desde
aquí sin browser real)**:
1. `npm run dev` → confirmar que el botón ES/EN en el header cambia
   idioma visualmente sin errores en consola.
2. Confirmar que el nav completo (24 items + tooltips) se ve bien en
   español (default) y en inglés.
3. Ir a la página del engine en vivo (Arbitrage) y revisar el panel de
   arbitraje triangular — confirmar que título/descripción/tabla se ven
   bien en ambos idiomas y que el layout no se rompe con textos más
   largos en español.
4. Confirmar que la preferencia de idioma persiste al recargar la página
   (localStorage).

### Estado real y honesto al cierre de la Sesión 26

**H-10 rescopeado: cerrado para el alcance decidido** (infraestructura +
nav + TriangularPanel). **Abierto**: extender la misma infraestructura al
resto de las 28 páginas — trabajo de juicio página por página, candidato
natural para las próximas sesiones, ya con el patrón establecido y
verificado (dictionaries + `t()` + `check:i18n` en CI).

**Genuinamente pendientes** (sin cambios respecto a la Sesión 25):
- **M-3** (deltas SSE): investigado a fondo en la Sesión 25, no
  implementado — requiere cambio coordinado backend+frontend verificable
  solo con un consumidor real.
- **M-8 a M-11** (frontend: TS, abstracción de API en `src/api.js`, tests
  E2E, split de componentes gigantes): sin tocar.
- **H-10 (resto)**: extender i18n a las 28 páginas restantes.
- **C-3**: deuda arquitectónica aceptada a propósito (Sesión 23) — no es
  un pendiente activo.

## Sesión 27 — H-10 (resto): 3 de 28 páginas migradas a i18n (NotFoundPage, SettingsPage, MarketsPage); trabajo página-por-página en progreso, sesión cortada a propósito para permitir QA visual incremental

### Contexto de arranque

Gabriel priorizó explícitamente **H-10 (resto)** entre los 3 frentes abiertos
al cierre de la Sesión 26 (H-10 resto / M-3 / M-8-M-11) — no se asumió,
se preguntó primero, como pide la regla del proyecto.

Antes de tocar nada se verificó contra el código real (no contra el
resumen del log, por la misma razón que en C-2/H-1/H-4 en la Sesión 23 y
C-5/L-5 en la Sesión 25 el resumen había quedado desactualizado):
- 28 páginas en `src/pages/`, 8,266 líneas totales — coincide con lo
  documentado en la Sesión 26.
- `src/i18n/I18nContext.jsx` y `src/i18n/dictionaries/{es,en}.js` intactos,
  patrón `useTranslation()` + `t('seccion.llave')` confirmado leyendo
  `src/components/common/TriangularPanel.jsx` (el único componente ya
  migrado).
- Baseline `npx vitest run` → **1314/1314 passed** antes de cualquier cambio.

### Decisión de alcance (explícita, para que quede escrita)

Esta sesión tocó **únicamente los archivos de `src/pages/*.jsx`**, no los
componentes hijos que algunas páginas importan (ej. `SettingsPage.jsx`
delega texto a `src/components/settings/ProfileSection.jsx` y otras 5
secciones — esos archivos NO se tocaron). El pendiente 1 de la Sesión 26
habla específicamente de "las ~27 páginas restantes de `src/pages/`", y
las ~8,266 líneas mencionadas son exactamente el total de esa carpeta —
así que se interpretó el alcance como los archivos de página en sí,
no un descenso recursivo a todos sus componentes hijos. Si Gabriel quiere
que la cobertura baje también a los componentes de sección, es una
extensión de alcance a decidir explícitamente, no algo que se asumió acá.

### Qué se hizo (3 páginas, criterio: empezar por las más chicas/aisladas)

1. **`NotFoundPage.jsx`** (61 líneas → 4 llaves nuevas, `notFound.*`):
   título, descripción, y los 2 botones. Sin datos dinámicos en esta
   página — todo era texto estático hardcodeado en inglés a pesar de que
   el resto de la plataforma ya tiene español por defecto (nav, footer,
   etc.) — exactamente el tipo de inconsistencia que H-10 busca cerrar.

2. **`SettingsPage.jsx`** (70 líneas → llaves `settings.title`,
   `settings.subtitle`, `settings.tabs.*` — 8 llaves nuevas): título,
   subtítulo, y las 6 etiquetas de pestañas (Profile/Trading/API
   Keys/Security/Audit Log/System). Nota técnica: el array `TABS` original
   usaba `label` con el string ya resuelto; se cambió a `labelKey` +
   `t(tab.labelKey)` en el render, y se renombró la variable del `.map()`
   de `t` a `tab` porque colisionaba con el nombre del hook `t()` de
   `useTranslation()` — sin este rename, `eslint`/`tsc` no lo habrían
   marcado (es JS válido, solo shadowing), pero habría sido un bug
   confuso de detectar más adelante.

3. **`MarketsPage.jsx`** (75 líneas → 6 llaves nuevas, `markets.*`):
   título, el separador "Top 100 · Actualizado/Loading", el placeholder
   del buscador, y el botón + tooltip de exportar CSV. Esta página tenía
   la mezcla de idiomas más notoria (`"Search moneda..."`,
   `"Export table completa como CSV"` — español e inglés en la misma
   frase). Dato importante: `t()` en este proyecto **no soporta
   interpolación de variables** (revisar `I18nContext.jsx` — es un lookup
   plano por llave), así que la descripción con la hora dinámica
   (`ts.toLocaleTimeString(...)`) se resolvió concatenando 2-3 llaves
   estáticas alrededor del valor dinámico en vez de intentar una sola
   llave con placeholder. Mismo patrón a repetir en el resto de páginas
   que muestren timestamps o conteos dinámicos en su descripción.

Total: **86 llaves en paridad** en `es.js`/`en.js` (eran 72 al cierre de
la Sesión 26; +14 esta sesión), confirmado con `npm run check:i18n`
después de cada página, no solo al final.

### Qué NO se tocó (a propósito)

Las **25 páginas restantes** de `src/pages/` (~7,900 líneas) siguen sin
auditar/migrar: `WatchlistPage`, `AnalyticsPage`, `ErrorPage`, `LoginPage`,
`IntelligencePage`, `RegisterPage`, `HeatmapPage`, `ForecastPage`,
`TechnicalAnalysisPage`, `AlertsPage`, `BacktestPage`, `MarketRegimePage`,
`PortfolioPage`, `CorrelationGalaxyPage`, `RiskPage`, `ComparePage`,
`ArbBacktestPage`, `SummaryPage`, `ProfilePage`, `AnalyzePage`,
`DashboardPage`, `MonteCarloPage`, `AboutPage`, `DocsPage` (728 líneas,
la más grande después de Arbitrage) y `ArbitragePage` (740 líneas, la más
grande de todas). Se decidió cortar la sesión aquí a propósito en vez de
apurar las páginas grandes sin margen para hacerlo con el mismo nivel de
cuidado — mismo criterio de "no forzar para cerrar todo de un jalón" que
se usó en Sesión 26.

### Verificación de esta sesión (bloque único, regla 3)

- `npx vitest run` → **1314 passed | 0 failed** (sin cambios en el número
  de tests — H-10 resto es trabajo de UI/i18n, no toca lógica de negocio
  ni agrega tests nuevos esta sesión).
- `npx eslint src/ server/ --ext .js,.jsx` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run check:i18n` → ✅ 86 llaves en paridad (verificado también
  incrementalmente después de cada una de las 3 páginas).
- `npm run check:ts-drift` → ✅ sin drift (no afectado por esta sesión).
- `npm run build` (Vite) → limpio, sin errores ni warnings nuevos.
- Arranque real (`node server/index.js`) + `SIGTERM` → shutdown limpio
  confirmado (`[watchdog] Shutdown complete in 1ms`), sin afectar en nada
  al backend ya que esta sesión fue 100% frontend/i18n.

### Lo que Gabriel necesita probar en su máquina

1. `npm run dev`, ir a una ruta inexistente (ej. `/asdf`) → confirmar que
   la página 404 se ve bien en español (default) y en inglés, y que los
   botones "← Volver" / "Ir al panel" funcionan.
2. Ir a Configuración (`/settings`) → confirmar que el título, subtítulo,
   y las 6 pestañas se ven bien en ambos idiomas, y que cambiar de pestaña
   sigue funcionando igual que antes (el rename de `label`→`labelKey` no
   debería cambiar comportamiento, pero es la clase de cambio que vale la
   pena confirmar visualmente).
3. Ir a Mercados (`/markets`) → confirmar en ambos idiomas: el título, el
   texto "Top 100 · Actualizado [hora]" (y el estado de carga inicial
   antes de que llegue el primer dato), el placeholder del buscador, y el
   botón de exportar CSV (label + tooltip al hacer hover).
4. Confirmar que cambiar el idioma en estas 3 páginas y luego navegar a
   otra parte de la app (nav, TriangularPanel) no rompe nada — es la
   primera vez que conviven 4 superficies distintas usando el mismo
   `I18nContext`.

### Estado real y honesto al cierre de la Sesión 27

**H-10 (resto): en progreso, 3/28 páginas cerradas y verificadas**
(NotFoundPage, SettingsPage, MarketsPage). **Quedan 25 páginas** — trabajo
de juicio página por página, mismo patrón ya probado en 4 superficies
distintas ahora (nav, TriangularPanel, y estas 3). Candidato natural para
continuar en la Sesión 28, empezando por las siguientes más chicas
(`WatchlistPage` 132 líneas, `AnalyticsPage` 153 líneas) una vez Gabriel
confirme visualmente que estas 3 no rompieron nada.

**Genuinamente pendientes** (sin cambios respecto a la Sesión 26):
- **H-10 (resto)**: 25 páginas de `src/pages/` sin migrar (ver lista
  arriba), más la decisión abierta de si los componentes hijos (ej.
  `src/components/settings/*`) entran o no en el alcance.
- **M-3** (deltas SSE): sin tocar esta sesión — Gabriel no lo priorizó.
- **M-8 a M-11** (frontend: TS, abstracción de API en `src/api.js`, tests
  E2E, split de componentes gigantes): sin tocar esta sesión.
- **C-3**: deuda arquitectónica aceptada a propósito (Sesión 23) — sigue
  sin ser un pendiente activo.

## Sesión 27 (continuación) — auditoría completa del plan original de due-diligence (`implementation_planf.md`, pre-Sesión 1) contra el código real + M-8 (api.js) cerrado por auditoría + M-3 implementado (preparado, pendiente de prueba real con Gabriel) + H-10 ampliado a componentes hijos de Settings (3 secciones más) + M-11 explícitamente pospuesto por decisión de Gabriel

### Por qué esta entrada existe

Gabriel adjuntó el `implementation_planf.md` original — el audit de "Distinguished Engineer" de antes de la Sesión 1 — y pidió: (1) verificar contra el código real qué de ese plan sigue pendiente de verdad, (2) ampliar el alcance de H-10 a los componentes hijos, y (3) avanzar todo lo posible del resto de pendientes. Esta es la due-diligence más grande hecha en una sola sesión desde la Sesión 23, así que se documenta con el mismo nivel de detalle.

### Auditoría del plan original — 26 ítems verificados contra código, no contra el plan

**Confirmados CERRADOS con evidencia real** (el plan de hace 26 sesiones ya
no describe el estado actual del código):

| Ítem | Evidencia verificada esta sesión |
|---|---|
| C-1 | `exchangeService.js` tiene `function init()` explícito — ya no conecta WS en `require()`. |
| C-2 | `server/index.js` quedó en 439 líneas, solo 4 rutas inline (wiring puro). |
| C-4 | `SIGTERM` real probado dos veces esta sesión → shutdown limpio confirmado. |
| C-5 | `check:ts-drift` limpio — `.ts` y `.js` compilado no divergen. |
| H-1 | Zod instalado (`"zod": "^4.4.3"`) + `server/infrastructure/validateRequest.js` + schemas de validación en `server/domain/`. |
| H-2 | `requireAuthForStream` gatea `/stream` y `/alerts-stream` — no hay SSE sin ticket. |
| H-4 | Los repos ya no tragan errores con `catch(() => [])` genérico (verificado, no auditado a fondo línea por línea esta sesión — bajo riesgo de regresión dado que H-4 fue reconciliado explícitamente en Sesión 23). |
| H-7 | `requireRole('admin')` real, usado en rutas de stress-test y reset de circuit breaker. |
| H-9 | `/api/v1/` ya es un alias real sobre las rutas críticas (rate limiters lo incluyen explícitamente). |
| M-1 | Backoff exponencial real en `_computeLoopDelay()`, con `logger.error()` + evento de observabilidad al entrar en backoff (no solo `_warn()` silencioso). |
| M-2 | `crypto.randomUUID()` en `opportunityDetection.js` y `tradeStateMachine.js`. |
| M-4 | `MAX_SSE_CLIENTS` enforced de verdad (503 al llegar al límite) en `stream.routes.js`. |
| M-5 | `persistTrade()`/`persistEquityPoint()` encolan a un retry queue interno (`_enqueueRetry`) cuando Mongo no está listo, con flush periódico (`startPersistenceRetryFlush`) — el `.catch(() => {})` en el call-site es inofensivo porque la función ya nunca rechaza para ese caso. |
| M-7 | 4 archivos `*.e2e.test.js` con supertest real (auth flow, SSE, 2FA gate, validación de trading). |
| L-2 | `/api/readiness` chequea Redis de verdad vía `getRedisStatus()`, no solo Mongo. |
| L-4 | Un solo `railway.json` — sin Procfile, sin render.yaml, sin vercel.json. |
| L-5 | ADR-014 + `server/infrastructure/persistence/migrations/` — estrategia de migraciones real, no implícita. |
| **M-8** (numeración de esta sesión — corresponde a M-10 del plan original) | **Auditado hoy, cerrado.** `src/api.js` (248 líneas) YA tiene una capa de abstracción real: `requestJson()` centralizado con timeout vía `AbortController`, retry con backoff exponencial en 5xx y errores de red, `ApiError` normalizado, inyección de auth, y namespaces organizados por dominio (`alerts`, `watchlist`, `portfolio`, `trading`, `profile`, `notifications`, `system`, `arb`). Los 3 usos de `fetch()` directo fuera de `api.js` (`AnalyzePage.jsx` para un dataset de ejemplo estático, `useNotifications.js` para el stream-ticket de SSE, `SplashScreen.jsx` para un healthcheck pre-auth) están justificados por diseño — mismo patrón ya documentado en el propio `api.js` para por qué `useArbitrageStream` tampoco pasa por `requestJson()` (EventSource no puede mandar headers `Authorization`). **El plan original decía "raw fetch calls con no abstracción" — otra vez desactualizado, como C-2/H-1/H-4 en Sesión 23 y C-5/L-5 en Sesión 25.** |

**Genuinamente pendientes** (confirmado con código, no heredado del plan viejo):
- **C-3**: deuda de estado mutable global — sigue aceptada a propósito (Sesión 15/23), no tocada.
- **H-10**: rescopeado a i18n por Gabriel (no "todo a inglés" como decía el plan) — en progreso, ver abajo.
- **M-3**: implementado esta sesión (ver detalle abajo), preparado pero no probado contra exchanges reales.
- **M-6**: coverage en 70/65/56/67 — meta original del plan (80/70) no alcanzada, quedó como meta de largo plazo documentada en `vitest.config.js` desde antes.
- **M-8 (numeración del plan original)**: `DocsPage.jsx` (728 líneas) y `ArbitragePage.jsx` (740 líneas) siguen siendo monolitos — nadie los partió. (Ojo: este es el M-8 del plan *original*, distinto del M-8 de esta sesión que es la auditoría de `api.js` — la numeración se reusó entre el plan viejo y las sesiones posteriores; queda anotado acá para no confundir a quien lea este log en el futuro.)
- **M-9**: 0 archivos `.tsx` — TypeScript del frontend sin empezar.
- **M-11**: sin Playwright/Cypress — **pospuesto explícitamente por Gabriel esta sesión** (se le preguntó cuál framework prefería antes de instalar una dependencia grande nueva, como exige la regla del proyecto; eligió dejarlo fuera).

### H-10 — 3 páginas más de contexto anterior + 3 secciones de Settings (alcance ampliado por decisión explícita de Gabriel)

Gabriel confirmó que los componentes hijos de página SÍ entran en el
alcance de H-10 (pregunta que quedó abierta al cierre de la sección
anterior de esta misma sesión). Se migraron:

- `src/components/settings/SystemInfoSection.jsx`: título, subtítulo,
  pill "Required", y el texto de referencia a `.env.example`. **Decisión
  de juicio documentada en el propio componente**: las descripciones de
  cada env var (`MongoDB connection string`, etc.) quedan en inglés a
  propósito — son documentación técnica dirigida a quien despliega el
  servidor, no copy de UI para el usuario final, mismo criterio que
  nombres de variables/código bajo H-10.
- `src/components/settings/SecuritySection.jsx`: título, subtítulo,
  "Active Sessions", el label por defecto de la sesión actual, el pill
  "Active", y el botón de cerrar todas las sesiones.
- `src/components/settings/AuditLogSection.jsx`: título, subtítulo, botón
  de refresh (reutiliza `common.refresh`), estado vacío, mensaje de error,
  y las 6 columnas de la tabla.

**Bug propio introducido y corregido en la misma sesión** (transparencia
total): al editar `AuditLogSection.jsx` con `str_replace`, el `old_str`
matcheó solo una porción del bloque original y dejó un `<tbody>...</table>`
duplicado después del `export` — lo detectó `eslint`/`npm run build`
inmediatamente (`Parsing error: Adjacent JSX elements must be wrapped in
an enclosing tag`) en el bloque de verificación de la regla 3, exactamente
para eso está la regla. Se corrigió truncando el archivo a las 102 líneas
correctas y se re-corrió el bloque completo de verificación desde cero.

**Quedan sin tocar** de `src/components/settings/`: `ApiKeysSection.jsx`
(97 líneas), `ProfileSection.jsx` (106 líneas), `TradingConfigSection.jsx`
(252 líneas, la más grande) y `settingsHelpers.jsx` (99 líneas, probable-
mente sin texto de usuario — son helpers de estilo/componentes, a
confirmar). Y las **25 páginas de `src/pages/`** ya documentadas como
pendientes al cierre de la sección anterior de esta sesión.

Total i18n: **107 llaves en paridad** (86 → 107 esta sub-sesión).

### M-3 — implementado (backend + frontend), NO probado contra exchanges reales

Antes de tocar el backend se leyó `src/hooks/useArbitrageStream.js` como
exige el pendiente documentado en la Sesión 26: el hook hacía
`setData(msg)` — reemplazo total del estado en cada mensaje SSE, sin
ningún merge. Esto significa que cualquier campo ausente de un mensaje
futuro desaparecería del estado de React, no que "se mantiene igual".
Ese era el obstáculo real para poder omitir campos sin romper el frontend.

**Hallazgo importante que cambió el diseño**: `router.get('/stream', ...)`
en `server/arbitrage/subroutes/stream.routes.js` ya manda un mensaje
`type: 'init'` con el estado completo (`orderBooks`, `opportunities`,
`wallets`, `pnl`, etc.) a **cada cliente individualmente** al conectarse,
ANTES de empezar a recibir el broadcast compartido de `pushToSSE()`. Esto
es clave: como `pushToSSE()` manda el mismo payload a TODOS los clientes
conectados (`server/application/arbitrage.state.js:121`), un diff cache
global (a nivel de módulo, no por cliente) sería incorrecto si un cliente
nuevo se conectara después de que el cache ya tiene datos — recibiría un
tick sin `orderBooks` sin haber tenido nunca el valor base. Pero como el
`init` por-cliente ya cubre exactamente ese caso (y no pasa por
`buildTickPayload()`, así que no lo toca el diff), el diseño con cache
global es seguro: cada cliente arranca con su `init` completo, y de ahí en
adelante recibe los `tick` diffed sabiendo que ya tiene la base.

**Cambios**:
1. `server/application/arbitrageOrchestrator.js` — cache de diff a nivel
   de módulo (`_lastSentOrderBooksJSON`, `_lastSentOpportunitiesJSON`,
   `_lastSentWalletsJSON`, `_lastSentPnlJSON`) comparado vía
   `JSON.stringify` (mismo trabajo de serialización que ya se iba a hacer
   para mandar por SSE, sin agregar una dependencia de deep-equal). Si un
   campo no cambió desde el tick anterior, se omite del payload — mismo
   patrón `...(cond && {campo})` que ya usa el archivo para los campos
   throttled por `tickCount % N`. Todo tick ahora trae `_delta: true`
   como contrato explícito con el cliente.
2. `src/hooks/useArbitrageStream.js` — `setData(msg)` →
   `setData(prev => ({ ...(prev || {}), ...msg }))`. Retrocompatible: si
   el backend algún día vuelve a mandar el payload completo siempre, el
   merge se comporta idéntico a un reemplazo.
3. `tests/arbitrageOrchestrator.test.js` — se agregó
   `_resetTickDiffCacheForTests()` (mismo criterio que
   `_resetLoopBackoffForTests` ya existente) llamado en un `beforeEach`
   del describe de `buildTickPayload`, porque el cache es estado de
   módulo y persiste entre tests del mismo archivo — sin el reset, el
   test ya existente ("campos siempre presentes") se hubiera roto al
   toparse con un cache ya poblado por un test anterior. Se agregaron 3
   tests nuevos: `_delta:true` siempre presente, omisión real de los 4
   campos cuando no cambian entre dos ticks consecutivos, y reinclusión
   de `orderBooks` cuando sí cambia.

**Lo que esto NO es todavía** (regla del proyecto, aplicada literal): esto
está **preparado, no cerrado**. Nunca se corrió contra el motor real
conectado a exchanges de verdad — solo contra los tests unitarios (que
usan datos sintéticos) y un arranque/`SIGTERM` de humo. Antes de dar esto
por bueno, Gabriel necesita correr el motor en modo real (o al menos con
el feed de exchanges activo) y confirmar:
1. Que el panel de arbitraje (`ArbitragePage.jsx`) sigue actualizando
   order books, oportunidades, wallet, y P&L con la cadencia esperada —
   el `_delta`/merge no debería introducir ningún retraso visible, pero
   es la clase de regresión que solo se ve con datos reales moviéndose.
2. Que una desconexión de red real (no solo cerrar la pestaña) seguida de
   reconexión no deja el estado "pegado" en un valor viejo — el diseño
   depende de que el `init` por cliente siempre llegue primero, y eso
   nunca se probó con una reconexión real, solo se leyó el código.
3. Idealmente, medir con las devtools de red cuánto bajó el tamaño
   promedio de cada mensaje SSE en un mercado tranquilo vs. uno volátil —
   la ganancia real de ancho de banda es la razón de ser de M-3 y todavía
   no se midió con tráfico real.

### Verificación de esta sub-sesión (bloque único, regla 3)

- `npx vitest run` → **1317 passed | 0 failed** (1314 + 3 tests nuevos de
  M-3). Se corrió dos veces: la primera corrida de `eslint`/`build` (no
  vitest) reveló el bug de JSX duplicado en `AuditLogSection.jsx`
  descrito arriba; tras corregirlo se re-corrió el bloque completo desde
  cero, no solo el paso que había fallado.
- `npx eslint src/ server/ --ext .js,.jsx` → limpio (tras el fix).
- `npx tsc --noEmit` → limpio.
- `npm run check:i18n` → ✅ 107 llaves en paridad.
- `npm run check:ts-drift` → ✅ sin drift.
- `npm run build` → limpio (tras el fix).
- Arranque real (`node server/index.js`) + `SIGTERM` → shutdown limpio,
  confirmado dos veces en esta sub-sesión (antes y después del fix de
  `AuditLogSection.jsx`).

### Estado real y honesto al cierre de esta sub-sesión

**Auditoría del plan original: completa.** De 26 ítems, ~18 ya estaban
genuinamente cerrados (confirmado contra código), 1 se cerró hoy por
auditoría (M-8/api.js), 1 se implementó hoy pendiente de prueba real
(M-3), 1 se amplió pero sigue en progreso (H-10), y el resto (C-3, M-6,
M-8 del plan original/componentes gigantes, M-9, M-11) siguen genuinamente
pendientes y documentados arriba con honestidad, sin inflar el estado.

**No se intentó** en esta sesión, a propósito, para no repetir el error
que el propio proceso del proyecto viene evitando desde hace 26 sesiones
(forzar frentes de naturaleza distinta en una sola tanda sin poder
verificarlos con el mismo rigor):
- Migración completa de TypeScript al frontend (M-9): es un cambio de 101
  archivos, candidato a su propia serie de sesiones incrementales, no a
  una sola tanda.
- E2E con Playwright/Cypress (M-11): pospuesto explícitamente por Gabriel
  esta sesión tras preguntársele.
- Split de `DocsPage.jsx`/`ArbitragePage.jsx` en componentes más chicos
  (M-8 del plan original): no priorizado esta sesión, queda documentado
  como pendiente real.

**Genuinamente pendientes al cierre**:
- **H-10**: `ApiKeysSection.jsx`, `ProfileSection.jsx`,
  `TradingConfigSection.jsx`, `settingsHelpers.jsx` (componentes de
  Settings), + las 25 páginas de `src/pages/` ya listadas en la entrada
  anterior de esta misma sesión.
- **M-3**: implementado, pendiente de la prueba real de Gabriel descrita
  arriba antes de considerarlo cerrado.
- **M-6, M-8 (plan original), M-9, M-11**: sin tocar, como se documentó.
- **C-3**: deuda arquitectónica aceptada a propósito — sigue sin ser un
  pendiente activo.

## Sesión 28 — H-10: `src/components/settings/` cerrado 6/6 + 4 páginas de `src/pages/` migradas (Watchlist, Analytics, Error, Login); sesión cortada a propósito para dejar QA incremental a Gabriel

Al arrancar, Gabriel priorizó explícitamente H-10 (resto) + los pendientes
que no fueran M-3 ni M-9 (dejando M-3 para su propia prueba real y M-9 sin
arrancar, como ya estaba acordado). Se corrió el baseline antes de tocar
nada: `npx vitest run` → **1317/1317**, igual al esperado.

### H-10 — `src/components/settings/` queda 6/6 (100%)

Se auditó primero `settingsHelpers.jsx` (99 líneas) contra el criterio de
la Sesión 27: son solo estilos compartidos (`card`, `cardHeader`, `input`,
etc.) y dos componentes de estructura (`SectionTitle`, `StatusPill`) que
reciben `title`/`subtitle`/`children` como props desde afuera — no tienen
ningún texto de usuario hardcodeado propio. **No requirió cambios**,
confirmado por lectura completa del archivo, no asumido.

Se migraron los 3 componentes que quedaban:

- `src/components/settings/ApiKeysSection.jsx` (97 líneas): título,
  subtítulo, el banner de advertencia completo (partido en
  `warningIntro`/`warningStrong`/`warningMid`/`warningOutro` para poder
  mantener `<strong>` y los `<code>` de `BINANCE_API_KEY`/
  `BINANCE_API_SECRET` sin traducir — mismo criterio de nombres de env
  vars técnicos que `SystemInfoSection.jsx`), labels y placeholders de
  ambos campos, botón de test y sus 3 mensajes de resultado. Se agregó
  `common.and` a ambos diccionarios (bug propio detectado durante el
  trabajo: un `t('common.and') || 'and'` no tenía sentido porque `t()`
  nunca devuelve falsy — devuelve la key cruda si falta en ambos
  diccionarios — así que el fallback nunca se hubiera disparado; se
  corrigió agregando la key real en vez de dejar el fallback roto).
- `src/components/settings/ProfileSection.jsx` (106 líneas): título,
  subtítulo, labels de nombre/email, placeholder, botón de guardar (con
  estado "Saving..."), y los 2 mensajes de resultado. El rol del usuario
  (`user?.role || 'user'`) se dejó sin traducir a propósito — es un valor
  de datos del backend, no copy de UI, mismo criterio de "no traducir
  dato dinámico/técnico" ya aplicado en sesiones anteriores.
- `src/components/settings/TradingConfigSection.jsx` (252 líneas, la más
  grande de settings): título, subtítulo, badges LIVE/PAPER, label de
  modo de ejecución, textos de las opciones Live/Paper Trading, el aviso
  completo de cómo habilitar live trading (separado en 3 partes para
  mantener `LIVE_TRADING_ENABLED`/`BINANCE_API_KEY`/`BINANCE_API_SECRET`
  sin traducir), mensajes de estado de cambio de modo, el diálogo nativo
  `window.confirm` de confirmación de LIVE, el error de "al menos un par
  activo", label de pares activos, label + sufijos de asignación de
  capital, y los 3 estados del botón de guardar. Los nombres de los pares
  (`BTC/USDT`, etc.) se dejaron sin traducir — son datos/tickers, no copy.

Total i18n al cierre de este bloque: **154 llaves en paridad** (107 → 154).

### H-10 — 2 páginas chicas más de `src/pages/`: WatchlistPage y AnalyticsPage

Ambas páginas migradas tenían texto mezclado español/inglés inconsistente
de antes de que existiera el sistema de i18n (ej. "Tus actives favoritos
· update cada 30s", "Search y add…", "Add a watchlist", "actives en
tracking"). Se tomó la decisión de juicio de limpiar el texto a español
correcto real (no traducir literalmente el Spanglish) al escribir la key
`es`, y traducir esa versión limpia al inglés — no traducir el Spanglish
tal cual quedaría raro en ambos idiomas.

- `src/pages/WatchlistPage.jsx` (132 líneas): título, descripción,
  placeholder de búsqueda, título de sección "agregar", contador de
  activos en seguimiento, botón de limpiar todo, estado vacío completo
  (título/descripción/acción), y los 2 toasts de agregar/quitar. El badge
  `MongoDB`/`Local` se dejó sin traducir — son nombres/estados técnicos
  iguales en ambos idiomas.
- `src/pages/AnalyticsPage.jsx` (153 líneas): título, subtítulo, sufijo
  "histórico"/"historical" y label de "retorno"/"return" en el header del
  gráfico, las 4 stat cards (labels + subs), y las 2 secciones de
  métricas avanzadas / datos de mercado en vivo (8 labels en total). Los
  símbolos de moneda (BTC/ETH/SOL/...) y los períodos (7d/30d/90d) se
  dejaron sin traducir — son datos/tickers, no copy de UI. El término
  "spread" en el sub de rango de precio se dejó igual en ambos idiomas
  (término financiero usado igual en español).

Total i18n tras este bloque: **189 llaves en paridad** (154 → 189).

### H-10 — 2 páginas más: ErrorPage y LoginPage

- `src/pages/ErrorPage.jsx` (179 líneas): `ERROR_CONFIGS` era un objeto a
  nivel de módulo con los 3 textos de error (500/503/default) hardcodeados
  en inglés — no se puede llamar `useTranslation()` (hook) a nivel de
  módulo, así que se convirtió en una función `buildErrorConfigs(t)`
  invocada dentro del componente. Se migraron los 3 títulos/descripciones,
  el badge de estado, y los botones "Try again"/"Go back"/"Back to
  dashboard" — estos 2 últimos reutilizan las keys ya existentes
  `notFound.goBack`/`notFound.backToDashboard` en vez de duplicarlas,
  porque el texto es idéntico.
- `src/pages/LoginPage.jsx` (179 líneas): mismo problema de función a
  nivel de módulo con `googleErrorMessage(err)`, que ahora recibe `t` como
  segundo parámetro. Se creó el namespace `auth` (nuevo, compartido a
  futuro con `RegisterPage.jsx` cuando se migre) con 3 sub-secciones:
  `auth.validation` (3 mensajes de validación de formulario),
  `auth.googleErrors` (6 mensajes de error de Google Sign-In), y
  `auth.login` (13 keys: eyebrow, título, subtítulo, labels, placeholder,
  checkbox de recordarme, olvidé mi contraseña, toast de reset de
  contraseña no disponible, estados del botón de submit, botón de Google,
  y el link de crear cuenta). El mensaje de error genérico de login
  (`err.message` del catch de `handleSubmit`) se dejó sin tocar — viene
  del backend, es dato dinámico, no copy de UI hardcodeado.

Total i18n al cierre de esta sub-sesión: **221 llaves en paridad**
(189 → 221).

### Verificación de esta sub-sesión (bloque único, regla 3)

- `npx vitest run` → **1317 passed | 0 failed**, sin cambios respecto al
  baseline (H-10/i18n no toca lógica de negocio, solo copy de UI).
- `npx eslint src/ server/ --ext .js,.jsx` → limpio.
- `npx tsc --noEmit` → limpio.
- `npm run check:i18n` → ✅ 221 llaves en paridad.
- `npm run check:ts-drift` → ✅ sin drift.
- `npm run build` → limpio, 964 módulos transformados.
- Arranque real (`node server/index.js`) + `SIGTERM` → log confirma
  `[index] SIGTERM — graceful shutdown initiated` → watchdog →
  `Shutdown complete in 1ms`. (Nota operativa de esta sesión: el primer
  intento de este paso se ejecutó sin `timeout` y sin backgrounding
  correcto, lo que hizo que el bloque de shell colgara y se cortara por
  límite de tiempo, dejando un proceso `node server/index.js` huérfano;
  se mató con `pkill` y se repitió el paso con `timeout 8` + backgrounding
  explícito, confirmando el shutdown limpio. No afectó al código, solo al
  proceso de verificación en sí.)

### Estado real y honesto al cierre de esta sub-sesión

**H-10**: `src/components/settings/` queda **100% cerrado (6/6)**. De las
28 páginas originales de `src/pages/`, quedan migradas **7 de 28**
(NotFoundPage, SettingsPage, MarketsPage de Sesión 27 + WatchlistPage,
AnalyticsPage, ErrorPage, LoginPage de esta sesión). **Quedan 21 páginas**
por migrar, empezando por las más chicas que siguen (`RegisterPage.jsx`,
179 líneas, comparte el namespace `auth` recién creado con LoginPage;
después `IntelligencePage.jsx`, 182 líneas).

**Cortada a propósito** (mismo patrón que la Sesión 27, decisión explícita
de Gabriel): no se siguió con más páginas para permitir QA visual
incremental de lo ya migrado antes de acumular más superficie sin probar.
Gabriel pidió específicamente documentar y empaquetar en este punto.

**No tocado esta sesión, a propósito**: M-3 (sigue esperando la prueba
real de Gabriel documentada en la Sesión 27, sin cambios de código), M-6
(coverage), M-8 del plan original (split de DocsPage/ArbitragePage), M-9
(TypeScript), M-11 (E2E, pospuesto por Gabriel), C-3 (deuda aceptada).

**Genuinamente pendiente al cierre**:
- **H-10**: 21 páginas de `src/pages/` — ver lista completa de tamaños en
  el resultado de `wc -l src/pages/*.jsx` de esta sesión: RegisterPage
  (179L), IntelligencePage (182L), HeatmapPage (211L), ForecastPage
  (223L), TechnicalAnalysisPage (266L), AlertsPage (272L), BacktestPage
  (281L), MarketRegimePage (300L), PortfolioPage (304L),
  CorrelationGalaxyPage (319L), RiskPage (321L), ComparePage (340L),
  ArbBacktestPage (351L), SummaryPage (374L), ProfilePage (386L),
  AnalyzePage (388L), DashboardPage (401L), MonteCarloPage (404L),
  AboutPage (433L), DocsPage (728L), ArbitragePage (740L) — las últimas 2
  también son las mismas que M-8 (plan original) quiere partir en
  componentes más chicos antes o después de su migración a i18n, a
  decidir con Gabriel cuando se llegue a ellas.
- **M-3, M-6, M-8 (plan original), M-9, M-11, C-3**: sin cambios, estado
  idéntico al documentado al cierre de la Sesión 27.

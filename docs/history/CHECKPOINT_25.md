# CHECKPOINT 25 — cierre de la hoja de ruta de auditoría (KUKORA_AUDITORIA_COMITE.md §12)

**Fecha:** 09 julio 2026

Esta sesión retomó el trabajo desde `Kukora-CHECKPOINT-23-partial.zip` (que ya
traía el ítem #5 — i18n de Dashboard/Risk — completo, pero se había guardado
*antes* de que el ítem #9 llegara a buen puerto en la sesión anterior). Se
verificó cada uno de los 9 puntos de la hoja de ruta contra el código real
(no contra lo que un checkpoint anterior afirmaba) y se cerraron los que
seguían pendientes.

## Estado final de los 9 puntos de la hoja de ruta

| # | Ítem | Estado | Evidencia |
|---|---|---|---|
| 1 | CI/CD real (`.github/workflows/ci.yml`) | ✅ Ya existía en este checkpoint | tsc, lint, drift, i18n, coverage con umbrales, smoke, build y `npm audit` bloqueante en cada push/PR |
| 2 | Eliminar duplicación en `liveExecution.js` | ✅ Ya existía en este checkpoint | `ExchangeClientBase` + 5 subclases (`BinanceClient`, `BybitClient`, `KrakenClient`, `OKXClient`, `CoinbaseClient`) en vez de 5 implementaciones paralelas |
| 3 | Adopción de `DomainError` en las 12 rutas | ✅ Ya existía en este checkpoint | `grep -rl "Object.assign(new Error" server/routes server/arbitrage` → 0 resultados; los 12 archivos usan `ValidationError`/`RateLimitError`/etc. |
| 4 | Consolidar dashboards (`/executive`, `/summary`, `/dashboard`, `/arbitrage`) | ✅ Se completó esta sesión (enfoque de bajo riesgo) | `/executive` ya es el landing canónico post-login (`App.jsx`: `path="/" → Navigate to="/executive"`, badge "LIVE" + tooltip "Vista de entrada canónica"). Esta sesión añadió el `navTip` que faltaba para `/dashboard` para que su propósito (mercado cripto general, no el motor de arbitraje) quede explícito en el nav en vez de competir en silencio con las otras tres. No se fusionaron/eliminaron páginas — hacerlo habría sido el cambio de mayor riesgo de toda la hoja de ruta y no era necesario para resolver la ambigüedad real, que era de *comunicación*, no de existencia de las páginas. |
| 5 | Terminar i18n en Dashboard/Risk | ✅ Ya venía completo en el zip de partida | `DashboardPage.jsx` y `RiskPage.jsx` usan `useTranslation()`; 349 llaves en paridad es/en |
| 6 | Limpiar residuos (`persistence/repositories/` vacío, `riskEngine.js` en vitest config, mover `CHECKPOINT_XX.md`) | ✅ Ya existía en este checkpoint | Directorio fósil ausente; `vitest.config.js` sin referencia a `riskEngine.js`; los 20 `CHECKPOINT_XX.md` ya viven en `docs/history/` |
| 7 | `.env.example` | ✅ Ya existía en este checkpoint | `.env.example` presente en la raíz |
| 8 | Aclarar en documentación de producto que ML/régimen son analíticos, no insumos de ejecución | ✅ Se completó esta sesión | Nueva sección "What actually decides a trade vs. what's analytical-only" en `README.md`, justo después de "What Kukora does" (lo primero que lee un evaluador). Se verificó contra el código (`mlScoringPipeline.js` línea 13) antes de citarlo. Se añadió también el sufijo "superficie analítica, no alimenta la decisión de ejecución del motor" a los `navTip` de Regime, Monte Carlo, Correlation Galaxy y Forecast en ambos idiomas, para que la aclaración aparezca también en el punto de uso, no solo en el README. |
| 9 | Subir branch coverage en `crypto.routes.js` y ramas de error de los engines | ✅ Se completó esta sesión | `crypto.routes.js`: 66.15%→**95.73%** statements, 55.61%→**87.24%** branch, 63.49%→**93.65%** functions, 65.61%→**98.02%** lines. Cobertura global del repo: 72.69% stmts / **62.6% branch** / 70.99% func / 75.76% lines — por encima de los 4 umbrales configurados (70/56/65/67). |

## Detalle del ítem #9 (el de mayor esfuerzo esta sesión)

Se agregó `tests/cryptoRoutesCoverage.test.js` (19 tests nuevos, todos en
verde) dirigido específicamente a las ramas que el reporte de cobertura
marcaba como no ejercitadas:

- **`handle()`**: error legado con `{status}` ad-hoc, detección de rate-limit
  por mensaje (no por tipo), fallback genérico a 503, y las dos ramas
  `DomainError` (`RateLimitError`/`UpstreamServiceError`) serializadas con
  `.toResponse()`.
- **`cachedCall()` — circuit breaker**: hit fresco servido sin llamar al
  servicio de nuevo; atajo "rate-limited + hay cache" sirviendo datos
  obsoletos sin reintentar; rechazo con `RateLimitError` cuando no hay cache
  y el circuito está abierto; apertura del circuito tras
  `OUTAGE_FAIL_THRESHOLD` (3) fallos consecutivos no-429, sirviendo stale
  data en el intento que dispara el trip.
- **`/anomalies`**: cache de ruta (5 min) servido en la segunda llamada sin
  refetch, y fallback por-id cuando `getPriceHistory` falla para un activo.
- **`/scores`, `/correlation`, `/regime`, `/kcs`**: el patrón
  `try { ... } catch { push fallback vacío }` de cada loop, más el parseo de
  `weights` como JSON en `/scores`.
- **`/overview`**: las cuatro combinaciones de longitud de sparkline (≥30
  puntos → trend real; 5-29 → solo anomalía real; <5 → ambos fallback
  "sideways"/"low"; sin sparkline en absoluto).

**Nota de aislamiento de módulos** (el obstáculo real de esta parte): 
`crypto.routes.js` guarda el estado del circuit breaker (`_cache`,
`_rateLimitedUntil`, `_consecutiveFails`, `_anomaliesCache`) en closures a
nivel de módulo. `vi.resetModules()` de Vitest solo limpia el grafo ESM de
Vite — como este archivo usa `require()` (CommonJS), ese estado sobrevivía
entre tests y hacía que el orden de ejecución cambiara los resultados. La
solución fue un helper `freshRouterAndService()` que borra manualmente las
entradas de `require.cache` para el router y el servicio antes de cada test
que depende de estado limpio, y vuelve a `require()`-arlos en el mismo
orden en que el router los pide internamente, para que el mock quede
enganchado a la instancia correcta.

## Verificación end-to-end de esta sesión

```
npx vitest run                    → 103 archivos / 1675 tests, 0 fallos
npx vitest run --coverage         → 72.69% / 62.6% / 70.99% / 75.76% (stmts/branch/func/lines), umbrales OK
npx tsc --noEmit                  → 0 errores
npx eslint (archivos tocados)     → 0 errores, 0 warnings
node scripts/checkI18nCoverage.js → 349 llaves, es/en en paridad
node scripts/checkTsBuildDrift.js → sin drift, 12 archivos verificados
npm run build                     → compila OK
node tests/smoke.test.js          → 76/76
```

## Lo que NO se tocó y por qué

- No se eliminaron ni fusionaron páginas de navegación (parte de la
  redacción original del ítem #4). El riesgo de romper rutas, tests de
  integración o enlaces internos era desproporcionado frente al problema
  real señalado por la auditoría, que era de claridad de propósito, no de
  redundancia funcional — cada una de las cuatro páginas sirve datos
  distintos. Se resolvió con navegación más clara en vez de una
  reestructuración de superficie.
- No se tocó `docs/TechnicalDueDiligence-2026-07-02.md` (el documento que
  afirmaba un CI inexistente en su momento) — el CI ya existe hoy, así que
  la inconsistencia que señalaba la auditoría ya no aplica; no se editó el
  documento histórico para no reescribir un registro de auditoría pasado.

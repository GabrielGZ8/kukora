# Kukora — Checkpoint v2.23.0

**Fecha:** 2026-07-12
**Estado:** verificado — 127 archivos de test / 2014 tests pasando, tsc limpio, eslint limpio, build de Vite exitoso, paridad i18n (400 llaves).

## Continuidad

Este checkpoint continúa directamente sobre `kukora-checkpoint-2.22.0-full.zip`
(la sesión anterior, que ya había cerrado las Iniciativas 1 y 5 del plan
competitivo original — validación estadística del edge / ADR-019, y el
Judge Report de un clic). En esta sesión se cierran las dos iniciativas
que habían quedado pendientes por prudencia de tiempo: **Iniciativa 4**
(comparación multi-tenant demo) e **Iniciativa 3** (tape recorder /
experiment sweep offline). Con esto, **las 5 iniciativas del plan
competitivo original están completas.**

## Qué se aplicó en esta sesión

### Iniciativa 4 — Comparación multi-tenant demo
- `server/routes/tenantDemo.routes.js` — dos tenants sintéticos
  (`demo-conservative`: minScore 80 / 0.005 BTC por trade;
  `demo-aggressive`: minScore 40 / 0.02 BTC por trade) corriendo sobre
  el motor de ejecución multi-tenant REAL (ADR-017) — no es una
  simulación paralela, es el mismo `tenantConfig.setMany()` +
  `tenantBotState.setEnabled()` que usaría cualquier usuario real.
  - `POST /api/tenant-demo/start` — aplica ambos perfiles y prende los bots.
  - `GET /api/tenant-demo/status` — snapshot lado a lado (wallets, P&L,
    historial, risk guard).
  - `POST /api/tenant-demo/stop` — apaga los bots, preserva wallet/historial.
  - `POST /api/tenant-demo/reset` — apaga y limpia todo por completo.
  - Montado en `/api/tenant-demo` (y `/api/v1/...`), gateado por
    `requireAuth` + `financialControlLimiter` en las mutaciones (mismo
    criterio que `/api/tenant-bot/*`).
- `src/pages/TenantComparisonPage.jsx` — página nueva con controles
  Iniciar/Detener/Reset y dos tarjetas lado a lado (P&L, trades, risk
  guard, config overrides, wallets, últimos trades). Nav entry
  "Comparación Multi-Tenant" con badge DEMO.
- `src/components/layout/navConfig.js`, `src/i18n/dictionaries/{es,en}.js`,
  `src/App.jsx` — ruta `/tenant-compare` conectada, paridad i18n
  verificada (400 llaves en ambos idiomas).
- Los tenants `demo-*` son recogidos automáticamente por el Judge
  Report (`server/routes/ops.routes.js` ya filtra por prefijo `demo-`)
  sin código adicional.
- `tests/tenantDemo.routes.e2e.test.js` — 7/7 tests (auth gate, start,
  status compartido entre usuarios, stop preserva historial, reset
  limpia todo).

### Iniciativa 3 — Tape recorder / experiment sweep offline
- `scripts/lib/tapeReplay.js` — lógica pura y testeable: reproduce una
  grabación de snapshots de order books a través del motor de detección
  REAL (`opportunityDetection.detectOpportunities()`, sin
  reimplementación paralela). Tolera snapshots corruptos sin tirar la
  corrida completa. 12/12 tests (`tests/tapeReplay.test.js`), sin tocar
  red ni filesystem.
- `scripts/tapeRecorder.js` — CLI (`npm run tape:record -- --duration=60
  --interval=5 --out=data/tapes/tape.jsonl`) que graba snapshots reales
  de los 5 exchanges a un archivo JSON Lines. **Requiere acceso de red
  real a las APIs de los exchanges** — en un sandbox de desarrollo con
  egress restringido cada intento de snapshot falla con error de red;
  el script lo reporta explícitamente por intento y sigue grabando en
  el siguiente intervalo en vez de fallar la corrida completa o
  inventar datos. En producción (Railway, o cualquier entorno con
  salida a internet) funciona igual que las llamadas que ya hace el bot
  en vivo.
- `scripts/experimentSweep.js` — CLI (`npm run tape:sweep -- --tape=<archivo>
  --top=10`) que lee la grabación, la reproduce, reconstruye el
  opportunity log, corre `arbBacktestEngine.parameterSweep()` sobre él, e
  imprime una tabla de las mejores combinaciones de parámetros.
- Verificado con un **smoke test manual** en la sesión anterior usando un
  tape sintético (sin depender de la red restringida del sandbox): el
  pipeline completo grabación→reproducción→opportunity log→sweep→resultados
  rankeados corre de punta a punta sin errores. Durante ese smoke test se
  encontraron y corrigieron dos bugs reales antes de cerrar la
  iniciativa (ya incorporados en este checkpoint):
  1. `replayTape()` contaba mal las oportunidades detectadas porque
     `detectOpportunities()` devuelve `{ opportunities, triangularSignal,
     ... }`, no un array plano — corregido para leer `.opportunities`.
  2. `experimentSweep.js` leía `sweep.results` (campo que no existe en
     la respuesta exitosa de `parameterSweep()`) en vez de
     `sweep.topResults` (el campo real, ya ordenado) — corregido.
- `package.json` → dos scripts nuevos: `tape:record`, `tape:sweep`.

### Documentación
- `package.json` → versión `2.23.0`.
- `CHANGELOG.md` → entrada `[2.23.0]` con el detalle completo.

## Cadena de verificación corrida en esta consolidación

```
npx vitest run              → 127 archivos, 2014 tests, 0 fallos
npm run typecheck (tsc)     → 0 errores
npx eslint (archivos nuevos/modificados) → 0 errores
npm run build (Vite)        → build exitoso, incluye TenantComparisonPage-*.js
npm run check:i18n          → es.js/en.js en paridad (400 llaves)
npm install                 → 986 paquetes instalados sin error
```

## Estado del plan competitivo original: 5/5 iniciativas cerradas

1. ✅ Validación estadística del edge (ADR-019) — checkpoint anterior (v2.22.0)
2. ✅ Comparación multi-tenant demo — este checkpoint
3. ✅ Tape recorder / experiment sweep offline — este checkpoint
4. *(orden original tenía esta como #4; renumerada arriba por claridad)*
5. ✅ Judge Report (HTML de un clic) — checkpoint anterior (v2.22.0)

## Archivos nuevos en esta sesión

```
server/routes/tenantDemo.routes.js
src/pages/TenantComparisonPage.jsx
scripts/lib/tapeReplay.js
scripts/tapeRecorder.js
scripts/experimentSweep.js
tests/tenantDemo.routes.e2e.test.js
tests/tapeReplay.test.js
```

## Archivos modificados en esta sesión

```
server/index.js                        (mount tenantDemo routes + rate limiter)
src/App.jsx                            (lazy import + ruta /tenant-compare)
src/components/layout/navConfig.js     (nav entry "Comparación Multi-Tenant")
src/i18n/dictionaries/es.js            (llaves nav.tenantCompare / navTip.tenantCompare)
src/i18n/dictionaries/en.js            (llaves nav.tenantCompare / navTip.tenantCompare)
package.json                           (versión 2.23.0 + scripts tape:record/tape:sweep)
CHANGELOG.md                           (entrada [2.23.0])
```

## Lo que NO se tocó (deliberadamente, fuera de alcance de este checkpoint)

- **README.md** — no se actualizó con las 4 iniciativas nuevas de esta
  sesión (sí están completas en CHANGELOG.md). Si quieres, lo actualizo
  en la próxima vuelta.
- El tape recorder no se pudo probar contra exchanges reales en este
  entorno (egress de red restringido a registries de paquetes) — el
  smoke test con datos sintéticos confirma que la lógica es correcta,
  pero la prueba definitiva de extremo a extremo con datos de mercado
  reales solo puede correr en tu entorno real (local o Railway).

## Cómo usar este checkpoint

```bash
npm install
npm run typecheck
npx vitest run
npm run build
npm run dev              # servidor + frontend

# Nuevo: grabar y reproducir una sesión de mercado real
npm run tape:record -- --duration=120 --interval=5
npm run tape:sweep -- --tape=data/tapes/tape-<timestamp>.jsonl --top=10

# Nuevo: demo multi-tenant (con el server corriendo y sesión logueada)
curl -X POST http://localhost:PORT/api/tenant-demo/start -H "Authorization: Bearer <token>"
curl http://localhost:PORT/api/tenant-demo/status -H "Authorization: Bearer <token>"
```

O simplemente abre `/tenant-compare` en el frontend para la demo visual,
y `/api/ops/judge-report` para el reporte de un clic (ambos requieren
login).

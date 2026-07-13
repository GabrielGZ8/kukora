# Checkpoint 28 — integración de 3 sesiones paralelas sobre el mismo checkpoint base

## Contexto

Este checkpoint es distinto a los anteriores: no es el cierre de una sola
sesión, es la **integración de 3 sesiones asíncronas independientes** que
partieron todas del mismo `CHECKPOINT-27-v2-FINAL.zip` al mismo tiempo, sin
verse entre sí. Cada una escribió su propio borrador de `CHECKPOINT_28.md`
y su propio ZIP final. Este documento reemplaza a los tres borradores y
describe el resultado ya fusionado en un solo proyecto.

Las tres sesiones, identificadas por lo que tocaron:

- **Sesión "seguridad + accesibilidad"** (`Kukora-CHECKPOINT-28-delogin.zip`)
- **Sesión "motor core"** (`Kukora-CHECKPOINT-28-pendiente2.zip`)
- **Esta sesión** (código/arquitectura/UX del bot — replay + estado de
  conexión SSE)

**Verificación previa a integrar:** antes de mezclar nada, se diffeó cada
ZIP contra el `CHECKPOINT-27-v2-FINAL.zip` original para obtener la lista
exacta de archivos tocados por cada sesión. Resultado: **cero solapamiento
de archivos entre las tres** (fuera de los tres `CHECKPOINT_28.md`
independientes, que este documento reemplaza). La integración fue una copia
directa de los archivos de cada sesión sobre la base común, sin necesidad
de resolver conflictos línea por línea.

## Sesión "seguridad + accesibilidad" — 3 fixes

**Fix S1 — `POST /api/auth/login` sin type-check de `email`/`password`.**
A diferencia de `/register`, `/login` no validaba `typeof email/password ===
'string'` antes de llamar `.toLowerCase()`/`bcrypt.compare()`. Hoy
degradaba a un 500 vía el `try/catch` circundante (no era un bypass de
auth), pero es una inconsistencia real. Fix: mismo patrón de validación que
`/register`, devuelve 400. 2 tests nuevos.

**Fix S2 — falta de logging de seguridad en eventos sensibles.** Ni el
reuso de refresh token (`TOKEN_REUSE`, señal de robo de token) ni los
intentos de login fallidos dejaban rastro en logs. Fix: ambos ahora
generan un `logger.warn` estructurado. 3 tests nuevos, más un bug de
mocking de `bcryptjs` (interop ESM/CJS) encontrado y corregido al escribir
los tests.

**Fix S3 — 4 elementos clicables sin acceso por teclado.** `ScoreCard`
(componente compartido, reusado en varias páginas) y 2 instancias en
`IntelligencePage.jsx`, más `AdversarialPanel.jsx`, usaban `<div
onClick>` sin rol/tabIndex/manejo de teclado — inaccesibles para
navegación por teclado o lectores de pantalla. Fix: helper compartido
nuevo (`src/utils/a11y.js`) aplicado a los 4 sitios. Esta sesión también
montó la **primera infraestructura de tests de componente** que tuvo el
proyecto (jsdom + `@testing-library/react`, `tests/setupJsdom.js`) —
10 tests nuevos, incluyendo uno de extremo a extremo probando que
`ScoreCard` es activable por teclado.

**Archivos:** `server/infrastructure/auth.js`,
`src/components/common/{AdversarialPanel,ScoreCard}.jsx`,
`src/pages/IntelligencePage.jsx`, `src/utils/a11y.js` (nuevo),
`tests/a11y.test.js` (nuevo), `tests/components/` (nuevo),
`tests/setupJsdom.js` (nuevo), `tests/auth.routes.test.js`,
`tests/authFlow.e2e.test.js`, `package.json` (+`jsdom`,
`@testing-library/{react,jest-dom,user-event}`), `vitest.config.js`
(environment jsdom para archivos `.test.jsx`, setup file adicional).

## Sesión "motor core" — 3 bugs reales

**Fix M1 — `stressTestService.js`: multiplicador de fees pegado.** Activar
el escenario `fee_spike` y luego cambiar a otro (`flash_crash`,
`exchange_down`) sin desactivar primero dejaba el multiplicador de fees
aplicado indefinidamente — el motor de detección real seguía viendo fees
infladas aunque el escenario activo en UI ya no fuera `fee_spike`.
Cobertura del archivo: 58.53% → 86.04%.

**Fix M2 — `dailyStatsService.js` + `dailyReportService.js`: stats "del
día" en realidad acumuladas de todo el historial.** El más grave de los
tres bugs de esta sesión. Ambos módulos calculaban las estadísticas
"diarias" usando el buffer completo de `getTradeHistory()` (hasta 500
trades acumulados), sin filtrar por fecha — confirmado inyectando un trade
de 2020 y viéndolo contado como "de hoy". En cualquier operación de más de
un día, esto corrompía silenciosamente el reporte de medianoche y cada
snapshot diario persistido en Mongo. `captureRate` quedó honestamente
re-etiquetado como "(sesión)" en vez de forzar un fix más invasivo a
`missedOpportunityTracker.js` que no era necesario para cerrar el bug
principal.

**Fix M3 — `adaptivePositionSizing.js`: texto de reasoning engañoso.**
Cuando `trend==='opening'` con `confidence<=50`, el factor aplicado
quedaba correctamente en 1.0x, pero el texto de explicación (la feature de
transparencia que se muestra por cada trade) decía "momentum stable" — el
número siempre fue correcto, el texto mentía sobre la razón. Esta sesión
también escribió la primera suite de tests para este archivo (no existía
ninguna pese a que sizea cada trade en vivo): 44 tests nuevos.

**Archivos:** `server/domain/risk/{adaptivePositionSizing,
stressTestService}.js`, `server/infrastructure/{dailyReportService,
dailyStatsService}.js`, `tests/{adaptivePositionSizing,
dailyReportService,dailyStatsService,stressTestService}.test.js`,
`tests/smoke.test.js` (fixture con campo `ts` realista, requerido por el
fix M2).

## Esta sesión — código/arquitectura/UX del bot de arbitraje

**Fix A1 — `replayService.js`: `getReplayById()` devolvía el snapshot
equivocado.** Los IDs `mem-N` se derivaban de la posición del snapshot en
el buffer rotativo, y `getReplayById()` invertía mal esa fórmula (índice
espejado — pedías el más reciente, te devolvía el más viejo). Reproducido
de forma aislada antes de tocar nada. Fix: cada snapshot recibe un número
de secuencia estable e inmutable al crearse; IDs y búsquedas se basan en
eso, no en la posición — inmune también a la rotación del buffer
(`shift()` al pasar de `MAX_MEMORY_REPLAYS`). 2 tests nuevos.

**Fix A2 — UX: una caída de la conexión SSE era casi invisible.** El hook
de streaming mergea datos por delta; si la conexión se caía, el único
indicador era un punto de 5×5px cambiando de color, mientras los números
en pantalla se quedaban congelados viéndose "en vivo" — riesgo real de que
una caída de 20-30s pasara inadvertida en una demo. Fix: banner explícito
("Conexión en vivo perdida — datos congelados") tras 3s de desconexión
sostenida. Lógica de temporización extraída a una función pura
(`createStaleTracker` en `src/hooks/useStaleAfter.js`) para poder
testearla con `vi.useFakeTimers()` sin instalar `jsdom`/testing-library —
en el momento de escribir este fix, la sesión de seguridad/a11y estaba
montando esa infraestructura en paralelo y una instalación duplicada
habría generado conflictos de `package.json` al integrar. 6 tests nuevos.

**Archivos:** `server/infrastructure/replayService.js`,
`src/hooks/useStaleAfter.js` (nuevo), `src/pages/ArbitragePage.jsx`,
`tests/{replayService,useStaleAfter}.test.js`.

**Revisado sin encontrar bugs:** `liveInventoryReconciliation.js`,
`directionalBiasTracker.js` (línea por línea completo), estado vacío del
frontend (`ScanningPulseWidget` ya da feedback útil, no pantalla en
blanco).

**Hallazgo documentado, no corregido:** patrón de estado global de
proceso (no por tenant) replicado en 37 módulos bajo `server/` —
confirmado en `arbitrage.state.js` (`_botEnabled`, `_botStarted`, precios
cacheados), pese a que el proyecto ya tiene infraestructura de tenants
(`tenantStore`, `tenantBotState`). Mismo tipo de riesgo que
`exchangeService.js`, a escala de todo el dominio. No es un bug activo hoy
(demo single-tenant); deuda arquitectónica para sesión dedicada futura, no
un fix quirúrgico.

**Observación de producto, no bug:** 18 tabs en `ArbitragePage.jsx` —
cobertura de features técnicamente impresionante, pero como narrativa de
demo con tiempo acotado diluye la propuesta de valor central. Queda como
recomendación de storytelling, no se tocó código.

## Verificación end-to-end del proyecto integrado

Corrida completa sobre el merge de las 3 sesiones, `npm ci` desde cero:

```
npx vitest run                    → 110 archivos / 1828 tests, 0 fallos
                                     (104 baseline + 2 delogin + 3 motor-core + 1 esta sesión)
npx tsc --noEmit                  → 0 errores
node scripts/checkTsBuildDrift.js → sin drift, 12 archivos verificados
npm run lint                      → 0 errores, 0 warnings
npm run build                     → build de producción exitoso (ArbitragePage 79.01 kB)
node tests/smoke.test.js          → 76/76
node scripts/checkI18nCoverage.js → 349 llaves, paridad es/en
```

No hubo que resolver ningún conflicto real de merge — las tres sesiones
tocaron conjuntos de archivos completamente disjuntos.

## Lo que ninguna de las 3 sesiones tocó (heredado, sigue pendiente)

- El refactor de `exchangeService.js` — `CHECKPOINT_26.md` pide
  explícitamente no emprenderlo sin sesión dedicada.
- XRP/USDT como tercer par operable — `CommitteeReadiness.md` recomienda
  explícitamente no conectarlo cerca del demo.
- El patrón de estado global no-tenant en 37 módulos (ver arriba).
- `observabilityService.js` y `alertWebhookService.js` — cobertura baja,
  señalados en el checkpoint de la sesión "motor core" como próxima
  prioridad.
- Reordenar/reducir las 18 tabs del dashboard — decisión de producto, no
  ejecutada.

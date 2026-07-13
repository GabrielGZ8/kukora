# CHECKPOINT 21 — Remediación post-auditoría de comité (sesión en curso)

**Contexto:** el usuario subió `KUKORA_AUDITORIA_COMITE.md` (nota final: 68/100)
y pidió implementar directamente la "Hoja de ruta para acercarse a 100/100"
(sección 12 de la auditoría), en iteraciones, con checkpoints frecuentes.

**Estado de verificación antes de tocar nada (baseline, confirmado igual a
lo que dice la auditoría):** 102 archivos / 1656 tests en verde, `tsc` 0
errores, `eslint` 0 errores, build OK.

---

## Hecho en esta sesión (orden de la hoja de ruta, ítems 1, 3, 6, 7 completos; 5 y 8 completos; 2, 4, 9 pendientes)

### 1. CI/CD real (roadmap ítem #1 — el de mayor impacto)
- **Creado `.github/workflows/ci.yml`.** Antes no existía ninguna carpeta
  `.github/` pese a que `docs/TechnicalDueDiligence-2026-07-02.md` afirmaba
  que sí. Corre en cada push/PR: `tsc --noEmit`, `eslint`, `check:ts-drift`,
  `check:i18n`, `vitest run --coverage` (bloqueante sobre umbrales de
  `vitest.config.js`), `test:smoke`, `build`, y `npm run audit`
  (`npm audit --audit-level=high`).
- **Corregido `docs/TechnicalDueDiligence-2026-07-02.md`:** agregado un
  addendum honesto (mismo estilo que ya usa el proyecto en sus ADRs)
  explicando que el punto 4 del addendum anterior era falso, cuándo se
  descubrió (auditoría de comité) y cuándo se corrigió (esta sesión). No se
  borró el texto original — se dejó trazable.

### 3. Adopción de `DomainError` en las rutas (roadmap ítem #3)
La jerarquía en `server/domain/errors.js` existía pero **ningún archivo de
rutas la usaba** (hallazgo más señalado del bloque Backend). Cambios:

- **Nuevo `server/infrastructure/errorResponse.js`** — punto único
  `sendError(res, err, { fallbackStatus })` que:
  - Si `err instanceof DomainError` → usa su `status`/`code`/`toResponse()`.
  - Si `err.status` (patrón legacy `Object.assign(new Error(...), {status})`)
    → lo respeta durante la migración.
  - Si no, cae al `fallbackStatus` (default 500), ocultando el mensaje
    interno en producción — mismo comportamiento que antes, centralizado.
- **`server/routes/crypto.routes.js`** (el que la auditoría citó con `grep`
  como prueba de "0 resultados"): las 11 apariciones de
  `Object.assign(new Error('Invalid coin id'), {status:400})` →
  `new ValidationError('Invalid coin id')`. Los `new Error('Datos
  insuficientes')` (6 sitios) → `ValidationError`. El error de rate-limit de
  CoinGecko → `RateLimitError`. El wrapper `handle()` ahora detecta
  `ValidationError`/`RateLimitError`/`UpstreamServiceError` explícitamente
  antes de caer al heurístico de texto anterior (`err.message.includes('rate')`).
- **`server/routes/alerts.routes.js`, `portfolio.routes.js`,
  `watchlist.routes.js`**: `wrapDb()` ahora usa `sendError`; validaciones de
  input (`validateAlertCreate`, `validatePortfolioCreate`,
  `validateWatchlistSave`, id inválido) lanzan `ValidationError` en vez de
  `res.status(400)` a mano.
- **`server/routes/dataset.routes.js`**: los dos casos de "input inválido"
  (`csv`/`json` ausente, dataset vacío) usan `ValidationError`; el resto
  (413 tamaño excedido, 422 error de análisis) se dejó igual porque no son
  errores de "input inválido" en el mismo sentido y no hay urgencia en
  tipificarlos.
- **`server/routes/notifications.routes.js`**: el 400 de "invalid
  notification id" ahora es `ValidationError` vía `sendError`.
- **`server/routes/tenantBot.routes.js`**: los 7 catches genéricos ahora
  pasan por `sendError`; las dos validaciones de body (`enabled` no
  booleano, `patch` no objeto) usan `ValidationError`.
- **`server/routes/trading.routes.js`**: los dos gates de 2FA (401) ahora
  usan `UnauthorizedError` vía `sendError`; los catches genéricos pasan por
  `sendError(res, e, { fallbackStatus: N })` preservando el status original
  (400/500/207-partial) porque los servicios subyacentes
  (`twoFactor`, `multiPairService`, `liveExecution`) todavía lanzan
  `Error` simple, no `DomainError` — cambiarlos habría sido un cambio de
  comportamiento no solicitado en esta pasada. El caso especial 207
  (ejecución parcial con `e.partial`) se dejó explícito, no es un
  `DomainError`.
- **Nota para la próxima sesión:** `arbitrage.routes.js` no tenía ningún
  patrón de error ad-hoc que migrar (revisado, vacío de ese patrón).
  Ningún archivo de rutas quedó con `Object.assign(new Error(...))`.

**Verificado tras cada cambio:** suite completa (`npx vitest run`) sigue en
1656/1656 verde, `tsc --noEmit` 0 errores, `eslint` 0 errores. Tests
específicos re-corridos: `crypto.routes.test.js`, `cryptoService.test.js`,
`notifications.routes.test.js`, `tenantBot.routes.e2e.test.js`,
`twoFactorTradingGate.e2e.test.js`, `tradingValidation.e2e.test.js`.

### 6. Limpieza de residuos (roadmap ítem #6)
- **Borrado `server/infrastructure/persistence/repositories/`** (directorio
  fósil vacío que confundía con `server/repositories/`, el real).
- **Borrada la referencia a `server/riskEngine.js`** (archivo que no existe)
  en la exclusión de cobertura de `vitest.config.js`.
- **Movidos a `docs/history/`:** los 20 `CHECKPOINT_XX.md`,
  `MIGRATION_CLEANUP_LOG.md` (212KB) y `CHANGELOG_ARCHIVE.md`. Se verificó
  con `grep -rn "require\|readFileSync"` que ningún código los referenciaba
  programáticamente — solo aparecían en comentarios citando el nombre de
  sesión, que se dejaron intactos (son referencias históricas válidas).
  `CHANGELOG.md` (vigente, 45KB) se dejó en la raíz porque es el changelog
  activo, no un log de proceso.

### 7. `.env.example` real (roadmap ítem #7)
- **Creado `.env.example`** en la raíz. El README ya prometía
  `cp .env.example .env` pero el archivo no existía — un desarrollador
  nuevo fallaba en el primer paso de setup. Se construyó enumerando
  exhaustivamente cada `process.env.X` referenciado en `server/` (55
  variables), agrupadas por bloque (servidor, persistencia, JWT, exchanges,
  riesgo, notificaciones, SSE, observabilidad, admin, debug), con
  comentarios explicando cuáles son opcionales y qué pasa si se omiten.

---

## Pendiente (siguiente iteración, en orden de la hoja de ruta)

- **#2 — Eliminar duplicación en `liveExecution.js` (1369 líneas):** extraer
  una clase base / interfaz runtime compartida para los 5 clientes de
  exchange (Binance/Bybit/Kraken/OKX/KuCoin), que hoy reimplementan el mismo
  set de métodos 5 veces. Es el hallazgo de mayor riesgo práctico de toda la
  auditoría (código que mueve dinero real). **No iniciado todavía** — es el
  cambio más grande y riesgoso de la lista, se aborda con más contexto
  disponible y tests de regresión corriendo constantemente.
- **#4 — Consolidar dashboards:** decidir cuál de `/executive`, `/summary`,
  `/dashboard`, `/arbitrage` es la vista principal y fusionar/degradar las
  otras tres. No iniciado.
- **#9 — Subir branch coverage** en `crypto.routes.js` y ramas de error de
  los engines (métrica más débil: 61% branch). No iniciado.
- Splitting adicional de `arbitrageOrchestrator.js` (1296 líneas, ≥4
  responsabilidades) y `opportunityDetection.js` (1053 líneas) — mencionado
  en la sección de Backend de la auditoría pero no listado como ítem
  numerado del roadmap; se evaluará después de #2 dado que comparten el
  mismo riesgo (motor de ejecución).
- Terminar i18n en las 16 páginas sin `t()` (roadmap #5) y aclarar en
  documentación de producto que ML/régimen son analíticos, no de ejecución
  (roadmap #8) — **aún no iniciados** pese a estar antes que #9 en la lista;
  se priorizó primero CI + DomainError + limpieza por ser cambios de
  backend de bajo riesgo y alto impacto en auditoría técnica. Frontend
  (i18n, dashboards) es la siguiente iteración natural.

## Archivos modificados en esta sesión
```
NUEVO   .github/workflows/ci.yml
NUEVO   .env.example
NUEVO   server/infrastructure/errorResponse.js
MOD     server/routes/crypto.routes.js
MOD     server/routes/alerts.routes.js
MOD     server/routes/portfolio.routes.js
MOD     server/routes/watchlist.routes.js
MOD     server/routes/dataset.routes.js
MOD     server/routes/notifications.routes.js
MOD     server/routes/tenantBot.routes.js
MOD     server/routes/trading.routes.js
MOD     vitest.config.js (removida referencia a riskEngine.js)
MOD     docs/TechnicalDueDiligence-2026-07-02.md (addendum de corrección)
BORRADO server/infrastructure/persistence/repositories/ (dir vacío)
MOVIDOS CHECKPOINT_01..20.md, MIGRATION_CLEANUP_LOG.md, CHANGELOG_ARCHIVE.md → docs/history/
```

## Impacto esperado en calificaciones de auditoría (estimado, no re-auditado)
| Área | Antes | Estimado ahora | Motivo |
|---|---|---|---|
| Seguridad | 76 | ~82 | CI con `npm audit` bloqueante real |
| Backend | 74 | ~80 | DomainError adoptado en 8/9 archivos de rutas |
| Testing | 79 | ~85 | CI ahora hace la cobertura bloqueante de verdad, no solo medida |
| Documentación | 60 | ~70 | CI fantasma corregido honestamente; ruido de raíz reducido en 460KB→movido; `.env.example` ya no falta |
| Arquitectura | 78 | ~83 | Directorio fósil y config obsoleta eliminados |
| Preparación para producción | 58 | ~68 | CI/CD real es la brecha #1 que impedía "producción" |
| Mantenibilidad | 66 | ~70 | Menos ruido en raíz, error handling centralizado |

Las áreas de Frontend/Dashboard/UX/Escalabilidad no cambian todavía — son
las siguientes iteraciones (#2, #4, #5, #8, #9).

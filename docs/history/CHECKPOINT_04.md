# CHECKPOINT_04 — continuación de la sesión de refinamiento (post-checkpoint-03)

Retoma exactamente donde quedó `CHECKPOINT_03.md`: items 1 (parcial), 4
(completo), 5 y 6 (pendientes), 2 y 3 (no iniciados). Alcance de esta
sesión: items 1, 5, 6. Item 7 sigue explícitamente fuera de alcance.

Verificación en cada bloque: `vitest run` → `tsc --noEmit` → `npm run
build:ts` → arranque real (`node server/index.js`) + `SIGTERM` graceful
shutdown confirmado. Estado final: **84 archivos / 1454 tests**, `tsc`
limpio, build limpio, arranque/apagado verificados.

## Item 1 — Multi-tenant real: decisión tomada, Fase A completa

Decisión de producto (tomada en esta sesión): **sí** quiere N cuentas de
paper-trading independientes por usuario, en un único backend (no un
proceso por usuario), con espacio para multi-bot por usuario en el
futuro. Ver `docs/ADR-017-multi-tenant-two-phase-rollout.md` para el
diseño completo.

**Construido y verificado (Fase A, cero riesgo, no toca el hot path):**
- `tenantStore.resolveTenantKey(uid, botId)` — convención de clave para
  multi-bot futuro.
- `tenantConfig.js` — config por-tenant, aditivo sobre `liveConfig`.
- `tenantBotState.js` — intención on/off + sesión por-tenant.
- Ya existente de checkpoint-02: `walletManager.ts` por-uid (wallets,
  P&L, historial, mutex).

**Pendiente, recomendado DESPUÉS del 12 de julio (Fase B, ver ADR-017):**
- `arbitrageOrchestrator.js`: el tick de 150ms debe iterar
  `tenantBotState.activeUids()` en vez de leer `getBotEnabled()` global.
- `stream.routes.js`: SSE debe volverse por-usuario (mercado sigue
  compartido; wallet/P&L/bot-status pasan a ser el snapshot del tenant).
- Sesiones, replay, analytics, caches: mismo patrón `tenantStore` que
  `walletManager`, servicio por servicio.

Por qué se difiere: toca simultáneamente el loop de trading en vivo, el
config que ese loop lee en cada tick, y el broadcast en tiempo real —
exactamente el tipo de cambio que este proyecto ya viene posponiendo
hasta después de la evaluación (ver ADR-016, decisión C-3 de sesiones
anteriores). Nadie necesita multi-tenant funcionando de punta a punta
para la demo del 12 — sí necesita que el bot compartido siga
funcionando sin sobresaltos.

## Item 5 — Mongo Atlas: completo

- Retry con backoff exponencial en la conexión inicial (1s→30s), no
  bloqueante — el resto de la app funciona en-memory mientras reintenta.
- Índice agregado en `ExecutionRecord.ts` (única colección de alto
  volumen sin índice en el campo por el que se ordena).
- `.env.example` con guía real de Atlas (network access, database
  access, por qué los índices no requieren setup manual).
- Repositorios / capa de persistencia ya existían de checkpoints
  anteriores (`server/repositories/index.js`,
  `server/infrastructure/persistence/`) — no se tocaron, ya cumplían.

## Item 6 — Explainability: completo

`server/domain/explainability.js` unifica en `opportunity.explain`:
score breakdown, fill probability breakdown, fees en USD, slippage,
liquidez predicha, contexto de volatilidad, snapshot de riesgo
(solo lectura — no muta circuit-breaker/drawdown tracking) y la
política de ejecución que se usaría por pata. Conectado en los dos
puntos donde el orquestador arma `opportunities`. 6 tests nuevos.

## Items 2 (config dinámica) y 3 (generalización XRP): no iniciados

Sin tocar en esta sesión por presupuesto de tiempo/riesgo. La sesión
anterior ya había marcado el item 3 como "alto riesgo/alcance" — sigue
siendo válido. El item 2 tiene overlap parcial con item 1 (los overrides
por-tenant construidos hoy son en sí mismos config dinámica, solo que
por-usuario en vez de global) — una auditoría completa de constantes
hardcodeadas restantes en el motor queda para la siguiente sesión.

## Recomendación para la siguiente sesión

1. Si el tiempo lo permite antes del 12 de julio: revisar item 2 (audit
   de constantes hardcodeadas) — bajo riesgo, alto valor de consistencia.
2. Fase B de item 1 y item 3 (XRP): después del 12 de julio, sin presión
   de deadline.
3. Item 7 (refactorización final) sigue reservado para el final, como
   pediste.

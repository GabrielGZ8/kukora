# Kukora — Avance de la sesión (Fase institucional)

Estado: **1976/1976 tests pasando** (123 archivos). Cero regresiones sobre el código existente.

## ✅ Implementado y probado

### 1. Observability + OpenTelemetry (`server/infrastructure/telemetry.js`)
- SDK de OTel real (NodeSDK), auto-instrumentación de HTTP/Express/Mongo.
- **Zero-cost cuando está apagado** (`OTEL_ENABLED=false` por default).
- Exporta a OTLP o consola. Spans manuales en `arbitrage.tick`, `fetchOrderBooks`, `detectOpportunities`, `evaluateAndExecute.{btc,eth}`.
- 8 tests · `tests/telemetry.test.js`

### 2. Feature Flags (`server/infrastructure/featureFlags.js`)
- boolean / percentage (rollout con bucketing determinístico por tenant) / enum.
- Overrides por tenant, historial de auditoría, catálogo cerrado.
- **Kill switch real** integrado en `executeBestOpportunity()`, con categoría RCA propia (`KILL_SWITCH_ACTIVE`).
- 14 tests · `tests/featureFlags.test.js`

### 3. RBAC (`server/infrastructure/rbac.js`) — **nuevo esta ronda**
- 3 roles: `user` / `operator` / `admin` (User model + JWT ya tenían `role`; se agregó `operator` al enum).
- Capa de permisos (`flags:read`, `flags:write`, `flags:kill_switch`, `jobs:read`, `jobs:run`, `ops:read`, `trades:replay`) en vez de checks de rol dispersos — la matriz rol→permiso vive en un solo lugar.
- **El kill switch requiere permiso admin-only** (`flags:kill_switch`); el resto de flags solo necesita `operator`. Gate más estricto para la acción de mayor blast radius.
- `OPERATOR_EMAILS` (env var) sigue el mismo patrón self-healing que `ADMIN_EMAILS` ya existente.
- Conectado de verdad en `featureFlags.routes.js` y `ops.routes.js` — no quedó como código muerto.
- 9 tests · `tests/rbac.test.js`

### 4. Background Jobs (`server/infrastructure/backgroundJobs.js`)
- Registro con intervalo fijo **o** horario diario (`runAt: 'HH:mm' UTC`) — agregado esta ronda para poder migrar `dailyReportService` sin perder su semántica de "una vez a medianoche".
- Reintentos (backoff lineal), timeout, garantía de no-overlap, métricas por job.
- **`rebalanceScheduler` y `dailyReportService` migrados de verdad** al framework (antes documentados como pendientes) — mismo comportamiento externo (contrato idempotente start/stop verificado por los tests existentes), ahora visibles en `/api/ops`.
- 2 jobs adicionales: `wallet.reconciliation`, `featureFlags.killSwitchAudit`.
- 17 tests · `tests/backgroundJobs.test.js`

### 5. Plugin Architecture para exchanges (`server/infrastructure/exchangeAdapters/`)
- 5 exchanges como archivos `*.adapter.js` autocontenidos + loader con validación.
- `exchangeRegistry.js` consume el loader — misma API pública, comportamiento verificado idéntico.
- **Alcance real, sin cambios esta ronda**: sigue siendo plugin a nivel de *descriptor*. Se intentó dar el siguiente paso (que `exchangeService.js` lea `wsUrl` desde el adapter en vez de un literal duplicado) pero se descartó a medio camino — ver sección de abajo.

### 6. Event Sourcing parcial (`server/infrastructure/eventStore.js`)
- Log inmutable por trade, conectado de verdad a `executeBestOpportunity()`.
- 11 tests · `tests/eventStore.test.js`

### 7. Operational Dashboard (`server/routes/ops.routes.js`)
- Agrega jobs, kill switches, tracing, eventos recientes. Ahora con RBAC real por endpoint.

## ⚠️ Pendiente / decisión consciente de no implementar

- **`exchangeService.js` como plugins completos (connect + parseMessage por exchange)**: no se hizo. Es el archivo más crítico del sistema (feed de precios en vivo) y este entorno de desarrollo **no tiene acceso de red a los exchanges reales** (allowlist de egress solo permite npm/GitHub) — no hay forma de validar un refactor de esa lógica contra tráfico WS real antes de entregar. Se dejó un intento de que el `wsUrl` de conexión saliera del adapter descriptor (ya sincronizado con el literal real en los 5 archivos `*.adapter.js`) pero el `require` correspondiente en `exchangeService.js` no se completó — el archivo quedó **intacto y sin editar a medias** (verificado con `node -c`). Es la pieza más segura de dejar para una sesión con acceso de red real para probar contra los exchanges.
- **API Versioning formal**: ya existía parcialmente (`/api/x` + `/api/v1/x` en paralelo); no se tocó.

## Cómo verificar
```bash
npm install
npm test                    # 1976 tests
OTEL_ENABLED=true npm start # activa tracing
```

## Nuevas dependencias añadidas
`@opentelemetry/sdk-node`, `@opentelemetry/api`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/sdk-trace-node`, `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/sdk-metrics`.

## Nuevas env vars opcionales
`OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OPERATOR_EMAILS`.


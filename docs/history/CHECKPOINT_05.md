# CHECKPOINT_05 — Item 1 Fase B completa (multi-tenant real, ejecución conectada)

Continúa desde `CHECKPOINT_04.md` / `kukora_checkpoint_06_intermedio.zip`,
retomando exactamente donde la sesión anterior se quedó sin tokens: el
diseño de Fase B ya estaba decidido y auditado (ver transcripción previa),
faltaba construir el módulo, conectarlo y verificar.

Verificación: `vitest run` → `tsc --noEmit` → arranque real
(`node server/index.js`) + `SIGTERM` graceful shutdown. Estado final:
**86 archivos / 1471 tests**, `tsc` limpio, arranque/apagado verificados.

## Item 1 — Fase B: completa

Nuevo módulo `server/infrastructure/tenantExecution.js`, conectado en
`arbitrageOrchestrator.js` justo después de la ejecución del bot
compartido (aditivo — el bot compartido no cambió una sola línea de su
propio flujo).

**Diseño (ver comentario de cabecera del archivo + ADR-017 actualizado):**
- Un único motor de detección compartido (sin cambios) + el pase nuevo
  itera `tenantBotState.activeUids()` sobre las MISMAS oportunidades ya
  detectadas ese tick — cero fetches/rate-limit adicional por tenant.
- Selección: `tenantConfig.getEffective(uid, 'minScore')` + de-dup de
  fingerprint **por-tenant** (Map independiente del Map global del bot
  compartido — un tenant nunca bloquea a otro ni al bot compartido).
- Ejecución: `executeSimulated()` (puro, sin cambios) + `applyTrade(trade,
  uid)` — ya era tenant-aware desde el checkpoint anterior. Wallet/P&L/
  historial de cada tenant quedan completamente aislados; verificado con
  test explícito de no-interferencia entre dos uids concurrentes.
- **Deliberadamente NO toca**: risk engine, trade state machine,
  predictive rebalancer, slippage validator, alertas — esos siguen siendo
  infraestructura compartida (un único "cerebro de riesgo" protegiendo
  toda la plataforma agregada). Documentado como decisión de arquitectura,
  no como limitación descubierta tarde.
- **Alcance BTC únicamente** en esta fase — el path ETH por-tenant es la
  misma extensión mecánica para una sesión futura sin presión de tiempo.
- Aislamiento de fallas: un error evaluando/ejecutando para un uid nunca
  aborta el resto del pase (try/catch por-tenant + try/catch alrededor de
  toda la llamada en el tick, para que tampoco pueda afectar al bot
  compartido que ya corrió antes en el mismo tick).

8 tests nuevos en `tests/tenantExecution.test.js`: no-op sin tenants
activos, no-op sin oportunidades, aislamiento de wallet entre tenants,
de-dup por-tenant dentro del TTL, dos tenants ejecutando en el mismo tick,
tenant bloqueado por su propio minScore sin afectar a otros, fallo de
saldo insuficiente sin excepción, y fallo de un tenant sin bloquear al
resto.

## Pendiente para continuar (siguiente paso de esta misma sesión)

1. Auditoría final profunda (item 7) — pendiente, es el cierre solicitado.
2. Revisar si además de BTC conviene extender el pase a ETH antes de
   cerrar (bajo riesgo, mecánico) — a evaluar según tiempo/tokens
   disponibles.
3. Empaquetar zip final una vez cerrado el item 7.

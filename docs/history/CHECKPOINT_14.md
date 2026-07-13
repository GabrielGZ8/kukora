## CHECKPOINT_14 — Sesión 2026-07-09: cierre del punto 7 de la hoja de
ruta (persistencia de balances de wallet)

**Fecha/hora:** 2026-07-09, ~03:22 UTC.

**Objetivo de este checkpoint:** esta sesión retoma exactamente desde
`Kukora-CHECKPOINT-13.zip` (la sesión anterior había hecho este mismo
trabajo pero el proceso terminó antes de poder empaquetar un zip nuevo —
solo quedó el transcript. Este checkpoint reaplica esos cambios
verificados sobre el código real de CHECKPOINT_13 y los deja empaquetados
por primera vez).

Línea base verificada antes de tocar nada: `npm ci` + `npx vitest run` →
**96 archivos, 1586 tests, 0 fallos** (idéntico al cierre de
`CHECKPOINT_13.md`).

### 1. Punto 7 — Persistencia de balances de wallet (auditoría comité, sección 12) — CERRADO

**Problema:** `EngineSnapshot` (el mecanismo de persistencia que ya
sobrevive `equityCurve`/`dailyPnl`/`totalTrades`/`tradeLog`/`counters` a
través de reinicios del proceso) no incluía los balances reales de
wallet. Un reinicio de Railway (deploy, crash, idle timeout) restauraba
el historial y el P&L reportado, pero los balances de cada exchange
volvían silenciosamente al valor inicial — inconsistente con el P&L ya
restaurado.

**Fix aplicado (7 archivos):**

1. **`server/models.js`** — campo `wallets` (Mixed, default `null`)
   agregado a `EngineSnapshotSchema`, documentado con nota sobre por qué
   no es un sub-schema estricto (el shape lo define `walletManager.Wallets`).
2. **`server-types/server/domain/wallet/walletManager.ts`** (fuente TS —
   nunca se edita el `.js` compilado):
   - `isValidWalletsShape(obj)` — guarda estructural liviana: rechaza
     `null`/no-objeto/array, exige los 4 buckets (`BTC`/`ETH`/`XRP`/`USDT`),
     exige que cada valor de cada bucket sea un `number` no-`NaN`.
   - `setBalances(wallets, uid)` — aplica un blob restaurado sobre el
     estado vivo de un tenant. Valida con `isValidWalletsShape` antes de
     aplicar (retorna `false` y no toca nada si la forma es inválida);
     guarda una copia profunda (mismo criterio que `getBalances`/
     `resetBalances`).
   - Recompilado con `npm run build:ts`; `npm run check:ts-drift` limpio.
3. **`server/infrastructure/persistenceService.js`**:
   - `persistEngineSnapshot`: `wallets` es opcional en el input — solo se
     incluye en el `$set` de Mongo si el caller efectivamente lo proveyó,
     para no pisar un valor previamente persistido con `null` cuando un
     caller legacy todavía no pasa balances.
   - `restoreEngineSnapshot`: devuelve `wallets: snap.wallets || null`.
   - Test seam nuevo: `_setEngineSnapshotModelForTests` /
     `_resetEngineSnapshotModelForTests` (mismo patrón que ya existía
     para `PendingExecution`) — necesario porque el mock de mongoose de
     `tests/setup.js` resuelve una instancia distinta según si el móduo
     la importa por `require` (CJS) o por `import` (ESM); sin este seam,
     un `vi.spyOn` sobre el modelo real nunca se dispara.
4. **`server/infrastructure/tenantPersistence.js`** (persistencia
   per-tenant, ADR-017): `_buildSnapshotForTenant` ahora incluye
   `wallets: getBalances(uid)`; `restoreTenantSnapshot` aplica el blob
   restaurado vía `setBalances(snap.wallets, uid)` si viene presente
   (con log de advertencia, no fatal, si la forma es inválida).
5. **`server/application/arbitrageOrchestrator.js`** (bot compartido):
   el flush periódico de `EngineSnapshot` (cada 30s) ahora captura
   `wallets: getBalances()`; el restore de arranque aplica
   `setBalances(engineSnap.wallets)` si el snapshot restaurado lo trae.

**Tests nuevos (17 tests, 3 archivos):**
- `tests/walletManager.test.js` — 8 tests: `isValidWalletsShape` (forma
  válida, `null`/`undefined`/no-objeto, bucket faltante, bucket con
  array o valores no-numéricos) y `setBalances` (aplica correctamente,
  rechaza blob malformado sin tocar el wallet, guarda copia profunda —
  mutar el input después no afecta el tenant, aislamiento real por uid).
- `tests/persistenceService.test.js` — 4 tests: round-trip completo de
  `persistEngineSnapshot`/`restoreEngineSnapshot` para el campo
  `wallets` usando el nuevo test seam (forwards wallets cuando se provee,
  NO lo incluye en `$set` cuando el caller lo omite, restore devuelve el
  blob persistido, restore devuelve `null` para un documento legacy sin
  el campo).
- `tests/tenantPersistence.test.js` — 5 tests: `_buildSnapshotForTenant`
  incluye los balances reales del tenant; `restoreTenantSnapshot` aplica
  un blob válido al estado vivo, deja el wallet intacto si el blob es
  inválido, no intenta aplicar nada si el snapshot restaurado no trae
  `wallets` (documento legacy).

**Resultado:** el punto 7 de la hoja de ruta queda completamente cerrado
— un reinicio del proceso (bot compartido o cualquier tenant activo)
ahora restaura balances de wallet consistentes con el historial/P&L ya
restaurado, con una guarda de validación de forma que evita que un
documento corrupto o legacy corrompa el estado en memoria.

### 2. Alcance de esta sesión

Dado que la sesión anterior había investigado y decidido explícitamente
sobre los puntos 1-6 y las recomendaciones de `CHECKPOINT_13` (los 3
backtest engines, el bug de `score` en `getOpportunityLog()`, los 4
motores de scoring restantes), y que el trabajo de esa sesión nunca llegó
a empaquetarse en un zip, esta sesión priorizó:

1. Reaplicar y verificar el punto 7 (arriba) — el único cambio de código
   real pendiente de la sesión anterior que no había quedado persistido
   en ningún zip.
2. Empaquetar este checkpoint de inmediato para no perder el avance,
   por pedido explícito del usuario, antes de continuar con el resto de
   las recomendaciones abiertas de `CHECKPOINT_13`.

### 3. Pendientes para la próxima sesión (en orden de prioridad sugerido)

1. **Recomendación #2 de CHECKPOINT_13 — endpoint huérfano
   `/api/arbitrage/arb-backtest/institutional`**: existe y funciona
   (produce Sharpe/Sortino/Calmar/Kelly/VaR/Omega reales sobre
   `simResult`), pero no tiene ningún caller en `src/` — el frontend no
   lo usa. La sesión anterior había empezado a conectarlo como una nueva
   pestaña "Institutional Metrics" en `ArbBacktestPage.jsx`; ese trabajo
   de frontend no llegó a verificarse ni a quedar en ningún zip y debe
   rehacerse desde cero en la próxima sesión (revisar
   `computeInstitutionalMetrics`/`generateInstitutionalReport` en
   `server/domain/engines/institutionalBacktest.js` para el shape exacto
   de datos disponible).
2. **`OpportunityLogEntry` como tipo nombrado**: recomendación explícita
   dejada en `adaptiveScoring.js`/`arbBacktestEngine.js` por
   `CHECKPOINT_13` — la forma reducida que expone
   `getOpportunityLog()` (con `pair` combinado en vez de
   `buyExchange`/`sellExchange` separados) no tiene hoy un contrato
   explícito propio; forzar `isOpportunity()` sobre ella rechazaría el
   100% de las entradas por diseño, no por drift real.
3. **`OpportunitySchema` (zod) más estricto en `mlScoringPipeline`**:
   nota menor de `CHECKPOINT_13` — hoy solo exige
   `buyExchange`/`sellExchange`, más laxo que `isOpportunity()` (que
   también exige `netProfit`/`spreadPct`/`viable`). No causa fallos hoy
   (el módulo tolera los campos ausentes con defaults seguros) pero es
   una superficie de validación más laxa de lo ideal.
4. **`SimResult` como tipo compartido**: `institutionalBacktest.js` tiene
   dos productores independientes de `simResult`
   (`query.routes.js` vs `performanceReport.js`) sin un contrato común —
   mismo patrón de "forma implícita compartida" que motivó el trabajo de
   `isOpportunity()`/`isTrade()` en sesiones anteriores.
5. Reescaneo general de la auditoría adjunta
   (`Kukora-Auditoria-Comite-2026-07-08.md`) contra el estado actual del
   código para identificar cualquier hallazgo no cubierto por los puntos
   1-7 ya trabajados, dado que esta sesión se concentró exclusivamente en
   cerrar el punto 7 y empaquetar antes de perder el avance.

### 4. Riesgos conocidos

- Ninguna regresión detectada — la suite completa, tsc, drift check,
  i18n, smoke tests, eslint y build de frontend corrieron limpios
  después de todos los cambios (ver sección de verificación abajo).
- El campo `wallets` en `EngineSnapshot` es `Mixed` sin validación de
  schema de Mongoose — la única validación de forma ocurre en
  `isValidWalletsShape()` del lado de la aplicación, al momento de
  `setBalances()`. Esto es intencional (mismo criterio que el resto de
  los campos de `EngineSnapshot`) pero significa que un documento
  corrupto puede persistirse sin error; solo se rechaza al intentar
  *aplicarlo*, nunca al guardarlo.

### 5. Verificación completa ejecutada esta sesión

```
npx vitest run          → 96 archivos, 1602 tests, 0 fallos (65s)
npx tsc --noEmit         → 0 errores
npm run check:ts-drift   → ✅ sin drift (7 archivos verificados)
npm run check:i18n       → ✅ es.js/en.js en paridad (240 llaves)
npm run test:smoke       → ✅ 76/76 tests
npm run lint             → ✅ 0 errores/warnings
npm run build            → ✅ build de producción exitoso (17.3s)
```

### 6. Estado estimado respecto a la auditoría

**~97/100.** El punto 7 (persistencia de wallets), que era el único
hallazgo de severidad media-alta explícitamente pendiente al cierre de
`CHECKPOINT_13`, queda cerrado y verificado con cobertura de tests
dedicada. Los puntos restantes (sección 3 arriba) son de menor impacto —
un endpoint sin usar en el frontend, dos recomendaciones de tipado más
estricto ya documentadas como decisión consciente en el propio código, y
un reescaneo de cierre — y no representan bugs activos en producción.

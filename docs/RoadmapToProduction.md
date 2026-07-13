# RoadmapToProduction — Ruta gradual a despliegue real

> Cómo llevaría Kukora de sistema de demostración a sistema de producción real. Sin humo.

---

## Fase 0 — Estado actual (✅ completo)

- [x] Market data real vía WebSockets (5 exchanges)
- [x] Motor de detección O(n²) con VWAP L2
- [x] Scoring compuesto multicriteria
- [x] Sistema de riesgo: circuit breakers, daily loss, drawdown
- [x] Rebalanceo automático con costo real
- [x] StatArb con log-spread estacionario
- [x] Interfaz completa con audit trail

---

## Fase 1 — Paper Trading (1-2 meses) — tooling completo, falta la corrida real

**Objetivo**: validar que slippage modelado ≈ slippage real.

```
Acción                                  Herramienta                          Estado
────────────────────────────────────────────────────────────────────────────────────
Conectar APIs de exchange (solo read)   exchangeService.js — WS en vivo,     completo
                                         5 exchanges, sin ccxt (clientes
                                         WS nativos por exchange)
Registrar: precio detectado vs          executionJournal.js                  completo
precio que habría conseguido
Medir divergencia slippage              server/domain/risk/slippageValidator.js:  completo —
                                         recordSample()/getCalibrationStats  conectado desde
                                         llamado desde                       arbitrageOrchestrator,
                                         arbitrageOrchestrator.js en cada     expuesto en
                                         ejecución simulada                  GET /api/arbitrage/config
Ajustar modelo si divergencia > 20%     liveConfig hot-reload +              completo
                                         auto-ajuste en slippageValidator
```

**Riesgo**: ninguno — sin capital real.
**Criterio de éxito**: slippage modelado dentro del 25% del real en >80% de oportunidades.
**Lo único pendiente**: dejar el sistema corriendo 1-2 meses en modo paper y leer
`getCalibrationStats()` (o `GET /api/arbitrage/config`) para confirmar que se
cumple el criterio con datos de mercado reales — es tiempo transcurrido en el
mercado, no código por escribir.

---

## Fase 2 — Shadow Mode (1 mes) — tooling completo (3/3 exchanges), falta la corrida real

**Objetivo**: ejecutar trades reales en exchange pero en cuenta de paper (fondos virtuales).

`server/application/liveExecution.js` ya no reconoce solo `'binance'` — las
tres integraciones están implementadas y comparten la misma interfaz de
cliente (`constructor(apiKey, apiSecret, opts)`, `_sign()`,
`getAccountInfo()`, `getBalance()`, `placeMarketOrder()`, `getOrder()`,
`cancelOrder()`), seleccionada genéricamente por `getExchangeClient(exchange, ...)`
tanto en `executeLive()` (vía `opportunity.buyExchange`) como en
`testExchangeConnection(exchange, ...)`:

- **Binance** — `BINANCE_TESTNET=true` enruta a `testnet.binance.vision`
  (testnet oficial). Sin cambios respecto a la ronda anterior.
- **Bybit** — `BYBIT_TESTNET=true` enruta a `api-testnet.bybit.com`
  (testnet oficial de Bybit, API v5 unified-account). Firma HMAC-SHA256
  sobre `timestamp+apiKey+recvWindow+payload`, headers `X-BAPI-*`. Fondos
  virtuales reales, mismo pre-flight/audit-log que producción.
- **Kraken** — implementado con el esquema de auth real de producción
  (HMAC-SHA512 sobre `path + SHA256(nonce+postdata)`, header `API-Sign`).
  **Caveat honesto**: Kraken no publica un sandbox de Spot oficial (a
  diferencia de Binance/Bybit). `KrakenClient` acepta `KRAKEN_SANDBOX=true`,
  pero solo tiene efecto si además se define `KRAKEN_SANDBOX_URL` apuntando
  a un mock propio o a un entorno equivalente — si `KRAKEN_SANDBOX=true` y
  `KRAKEN_SANDBOX_URL` no está definida, el cliente **rechaza ejecutar** en
  vez de caer silenciosamente a `api.kraken.com` con dinero real. Sin
  `KRAKEN_SANDBOX_URL`, Kraken solo puede usarse en mainnet real (Fase 3+).

**Cómo activarlo (ejemplo con Binance; Bybit es análogo)**:
```
LIVE_TRADING_ENABLED=true
BINANCE_TESTNET=true
BINANCE_API_KEY=<key de testnet.binance.vision>
BINANCE_API_SECRET=<secret de testnet.binance.vision>
```
Luego `POST /api/arbitrage/mode` con `{ "mode": "live" }` por usuario activa
la ejecución real contra testnet. `executeLive()` elige el exchange y las
variables de entorno correctas según `opportunity.buyExchange`
(`BINANCE_*` / `BYBIT_*` / `KRAKEN_*`), por lo que no requiere cambios
adicionales de código para operar contra cualquiera de los tres.

**Riesgo**: bajo — entornos sandbox reales para Binance y Bybit, fondos
virtuales. Kraken queda en mainnet real hasta que se configure un sandbox
propio vía `KRAKEN_SANDBOX_URL`.
**Criterio de éxito**: Sharpe > 1.5 en 30 días de shadow mode.
**Lo único pendiente para cerrar esta fase por completo** (tiempo
transcurrido en mercado, no código): dejar el sistema corriendo 30 días
contra Binance/Bybit Testnet para medir el Sharpe real. Nota de alcance:
`executeLive()` sigue ejecutando una sola pierna (compra) por diseño —
ejecución real de dos piernas simultáneas en dos exchanges distintos es
alcance de Fase 3 (ver abajo), no de shadow mode.

---

## Fase 3 — Capital pequeño real (3-6 meses)

**Objetivo**: validar la estrategia con dinero real mínimo.

```
Capital inicial sugerido: $2,000–5,000 USD total
Distribución: $400–1,000 por exchange (5 exchanges)
Tamaño máximo de trade: $200 por leg
```

**Estado (Ronda 20)**: el adapter de ejecución de dos piernas está
implementado y probado — `executeCrossExchangeLive()` en
`server/application/liveExecution.js`. Compra en `opportunity.buyExchange`
y vende en `opportunity.sellExchange` de forma concurrente (`Promise.all`),
asumiendo balances pre-fondeados en ambos exchanges (moneda quote en el
lado compra, activo base ya en inventario en el lado venta — una
transferencia inter-exchange en el mismo bloque es demasiado lenta para
timing de arbitraje).

**Manejo de partial fills (ya no pendiente)**: si exactamente una pierna
se llena, la posición se cierra de inmediato en el mismo exchange
(`CLOSE_NOW` — vender la compra que quedó "naked long", o recomprar la
venta que quedó "naked short"), reflejando la misma política que ya
documentaba el escenario adversarial `mid_flight_failure` para el motor
simulado (`server/domain/risk/adversarialScenarios.js`). El error resultante
trae `.partial = true` y `.recovery` para que el caller distinga "el trade
simplemente no ocurrió" de "el trade ocurrió a medias y se aplanó
automáticamente — revisar el audit log". 10 tests nuevos en
`tests/liveExecutionCrossExchange.test.js` cubren: ambas piernas llenas,
una pierna llena (recovery exitoso), ninguna pierna llena, y validaciones
de pre-flight (exchanges iguales, credenciales faltantes, inventario
insuficiente en el lado venta).

**Cambios técnicos que siguen pendientes**:
1. ~~Exponer `executeCrossExchangeLive()` / `executeLive()` / `setUserMode()`
   vía rutas HTTP~~ — **hecho (Ronda 21)**. `POST /api/trading/mode`,
   `POST /api/trading/execute/cross`, `GET /api/trading/mode`,
   `GET /api/trading/audit`, `POST /api/trading/test-connection` en
   `server/index.js`, todas detrás de `requireAuth`. El cambio a
   `mode: 'live'` y la ejecución en `execute/cross` además exigen un TOTP
   válido (`server/application/twoFactor.js` + `server/infrastructure/totp.js`)
   una vez que el usuario habilitó 2FA vía `POST /api/trading/2fa/setup` →
   `POST /api/trading/2fa/confirm` — usuarios que nunca se inscribieron
   pueden seguir cambiando de modo sin token (2FA no es obligatorio a la
   fuerza, solo gatea una vez que está activo). Verificado end-to-end con
   `tests/twoFactorTradingGate.e2e.test.js` (supertest contra la app real,
   sin mockear la ruta): setup → confirm con un TOTP real → `mode=live` sin
   token da 401 → con token inválido da 401 → con token válido pasa; mismo
   gate replicado y verificado en `execute/cross`.
2. ~~Rate limit management por exchange~~ — **hecho (Ronda 21)**.
   `server/infrastructure/exchangeRateLimiter.js` (token bucket por
   exchange, override vía `EXCHANGE_RATE_LIMIT_<EXCHANGE>`), expuesto en
   `GET /api/trading/rate-limits`.
3. ~~Alertas a Telegram/Slack en tiempo real~~ — **ya estaba hecho antes de
   Ronda 21** (v17, `server/infrastructure/alertWebhookService.js`): envío a
   Telegram vía Bot API + webhook genérico (compatible con Slack/Discord/n8n/
   Zapier) para 9 tipos de evento operacional, con cooldown por evento y
   persistencia a `Notification` + push SSE. Ronda 21 lo conectó además al
   nuevo camino de ejecución live de dos piernas: `alertLivePartialFailure()`
   se dispara desde `executeCrossExchangeLive()` (`server/application/liveExecution.js`)
   tanto si el flatten automático de una pierna parcial se recupera como si
   no — este evento no tiene cooldown/de-dup a propósito, cada ocurrencia es
   de bajo volumen y requiere revisión humana. Esta nota corrige al roadmap
   anterior, que listaba el ítem como pendiente sin haber verificado que ya
   existía.
4. Backup MongoDB en la nube con replicación — **sigue pendiente, y es un
   ítem de infraestructura/operación, no de código de la aplicación**. El
   backend ya soporta `MONGODB_URI` apuntando a cualquier cluster (Atlas u
   otro) vía `mongoose.connect()` estándar, y corre en modo in-memory sin
   él (ver `docs/DeveloperGuide.md`); lo que falta es aprovisionar un
   cluster de MongoDB Atlas (o equivalente) con replica set y backups
   automáticos habilitados y apuntar `MONGODB_URI` a él — una tarea de
   configuración de infraestructura/cuenta, no algo que se resuelva
   agregando código a este repo.
5. ~~Reconciliación de inventario entre exchanges~~ — **hecho (Ronda 21)**.
   `server/application/liveInventoryReconciliation.js`: solo lectura
   (`getBalance` por exchange vía el mismo `liveExecution.getExchangeClient`
   que usa la ejecución real), nunca inicia una transferencia — devuelve
   sugerencias de rebalanceo cuando un exchange concentra >65% de la
   moneda quote y el excedente supera `MIN_TRANSFER_USD`. Expuesto en
   `GET /api/trading/reconciliation`. 9 tests en
   `tests/liveInventoryReconciliation.test.js`.

**Riesgo**: pérdida máxima acotada por daily loss limit (ya implementado). Con $5,000 y daily limit de 2% = máximo -$100/día de pérdida posible.

---

## Fase 4 — Hardening operacional (ongoing)

**Observabilidad**:
- Métricas a Prometheus/Grafana (watchdog.js ya expone datos)
- Alertas PagerDuty si sistema cae > 30s
- Dashboard de salud separado del dashboard de trading

**Resiliencia**:
- Auto-restart a nivel de proceso ya cubierto por `railway.json`
  (`restartPolicyType: ON_FAILURE`, hasta 3 reintentos) y por el
  `HEALTHCHECK` del Dockerfile en el path Docker. ~~PM2 cluster mode
  sigue siendo trabajo real pendiente si se necesita multi-proceso en
  una sola instancia~~ — **resuelto**: ver
  `docs/ADR-016-pm2-single-instance-constraint.md` y
  `ecosystem.config.js`. Deliberadamente **no** es cluster mode — el
  motor de arbitraje es un singleton por proceso (5 conexiones WS reales,
  estado de SSE/riesgo en memoria), así que `instances: 1` en modo fork es
  la única configuración segura sin antes partir el proceso en
  engine/réplicas vía pub/sub (documentado como trabajo futuro en el ADR,
  no hecho en esta ronda porque no hay necesidad real de más de un core
  con 5 exchanges y un loop de 150ms).
- Reconexión automática WS con backoff exponencial (ya implementado en exchangeService.js)
- Fallback a REST polling si WS cae (ya implementado)

**Compliance**:
- Registro de todas las órdenes para reporting fiscal
- Separación de wallets por estrategia
- Rate limit monitoring para evitar suspensiones de cuenta

---

## Fase 5 — Escala (6-12 meses post-validación)

Solo si Fase 3 muestra Sharpe > 2.0 sostenido:

- Agregar más pares (ETH/USDT, ETH/BTC, SOL/USDT)
- Expandir a más exchanges (Bitfinex, Gate.io)
- Position sizing dinámico basado en volatilidad realizada
- Triangular arb en producción (módulo ya existe en demo)

---

## Lo que YA está listo para producción

| Módulo | Estado |
|--------|--------|
| Motor de detección | ✅ Producción-ready |
| Sistema de riesgo | ✅ Producción-ready |
| Rebalanceo | ✅ Producción-ready |
| Audit trail / P&L | ✅ Producción-ready |
| Execution adapter | ⚠️ Simulado — necesita adapter real |
| Wallets reales | ⚠️ Simulados — necesita integración custodio |

---

## Conexión con la respuesta al comité

> *"¿Lo llevarías al mundo real?"*

Sí, pero gradualmente. El sistema ya tiene la arquitectura correcta para producción. Lo que falta no es rediseñar — es sustituir el módulo de ejecución simulada por llamadas reales a exchange APIs, validar en paper trading que el modelo de slippage es preciso, y arrancar con capital mínimo para medir performance real vs simulada. El riesgo es acotado porque el sistema de riesgo (circuit breakers, daily loss limit, drawdown) ya funciona correctamente.

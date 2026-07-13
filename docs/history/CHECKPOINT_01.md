# Kukora — Checkpoint 01 (Auditoría motor de arbitraje, 4 implementaciones solicitadas)

Estado del repo: **build/tests OK — 1412/1412 tests pasando, 79 archivos de test.**

## Completado en este checkpoint

### ✅ Item #3 — Live trading real en los 5 exchanges (antes solo 3 de 5)
- `server/application/liveExecution.js`: nuevas clases `OKXClient` y `CoinbaseClient`
  con el mismo contrato que `BinanceClient`/`BybitClient`/`KrakenClient`
  (`getAccountInfo`, `getBalance`, `getOrderBook`, `placeMarketOrder`, `placeOrder`,
  `getOrder`, `cancelOrder`), firmas HMAC reales por exchange (OKX: base64
  HMAC-SHA256 sobre timestamp+method+path+body con OK-ACCESS-*; Coinbase
  Advanced Trade: hex HMAC-SHA256 con CB-ACCESS-*).
- `getExchangeClient()` y `EXCHANGE_ENV_KEYS` actualizados para las 5 exchanges.
- OKX requiere una tercera credencial (passphrase) — validada explícitamente
  antes de ejecutar, con mensaje de error claro en vez de un 401 opaco de OKX.
- `.env.example` documentado con las nuevas vars (`OKX_API_KEY/SECRET/PASSPHRASE`,
  `OKX_DEMO_TRADING`, `COINBASE_API_KEY/SECRET`), incluyendo advertencias honestas
  sobre las limitaciones reales de sandbox de cada exchange (ninguna exageración).
- `tests/liveExecutionOkxCoinbase.test.js` (nuevo, 12 tests) + 2 tests
  preexistentes actualizados en `liveExecution.test.js`,
  `liveExecutionCrossExchange.test.js` y `liveInventoryReconciliation.test.js`
  que asumían el límite viejo de 3 exchanges.

### ✅ Item #2 — Slippage stddev por exchange, no global
- `server/domain/opportunityDetection.js`: el array global `_slippageHistory`
  fue reemplazado por un `Map` por exchange (`_slippageHistoryByExchange`),
  con fallback a un pool global solo para arranque en frío (<5 muestras).
- Nueva función `combinedSlippageStdDev(buyExchange, sellExchange)` —
  combina las dos varianzas independientes (`Var(buy-sell) = Var(buy)+Var(sell)`)
  en vez de reusar un solo número compartido entre exchanges con perfiles
  de liquidez muy distintos (ej. Kraken vs Binance).
- El intervalo de confianza `profitLow`/`profitHigh` de cada oportunidad ahora
  usa `combinedSlippageStdDev()` en vez del global anterior.
- Nueva función de observabilidad `getSlippageStatsByExchange()` (exportada,
  lista para exponer en el dashboard).

## Pendiente (siguiente iteración)
- **Item #1** — Calibración estadística de los pesos del scoring (actualmente
  constantes mágicas) contra el backtest institucional existente.
- **Item #4** — Motor de detección multi-hop (Bellman-Ford sobre grafo de
  exchanges) para ir más allá del arbitraje bilateral actual.
- Tests dedicados para la nueva lógica de slippage por exchange
  (los existentes ya pasan, pero faltan tests que ejerciten directamente
  `combinedSlippageStdDev`/`getSlippageStatsByExchange`).

Ningún archivo quedó a medio editar; el repo compila y todos los tests pasan.

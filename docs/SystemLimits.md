# SystemLimits — Qué simula Kukora vs qué sería producción real

> Transparencia técnica. Este documento es intencionalmente honesto.

---

## Lo que SÍ hace Kukora (con datos reales)

| Capacidad | Implementación real |
|-----------|-------------------|
| **Market data** | WebSockets nativos a 5 exchanges reales: Binance, Kraken, Bybit, OKX, Coinbase |
| **Order books L2** | Bids/asks reales con volumen, actualizados en cada tick |
| **Latencia de detección** | Real — medida end-to-end desde tick WS hasta oportunidad detectada (típico < 30ms) |
| **Fees** | Calculados con tasas reales por exchange y modo maker/taker |
| **Slippage** | Modelado sobre L2 real — VWAP calcula precio real para tamaño dado |
| **Circuit breakers** | Implementados y activos — daily loss limit, max drawdown, exchange penalty |
| **Rebalanceo** | Cálculo real de costo (withdrawal fee + spread) sobre fees reales de cada exchange |
| **StatArb** | Log-spread real, EWMA con λ=0.94, AR(1) half-life sobre datos históricos reales |

---

## Lo que es simulado / simplificado

| Aspecto | Qué se hace | Qué faltaría en producción |
|---------|-------------|---------------------------|
| **Ejecución de órdenes** | Simulada: fill instantáneo al precio VWAP calculado | API real de exchange, manejo de partial fills reales, re-try logic, rate limits |
| **Latencia de red** | No modelada entre detección y "ejecución" | Latencia real a data center del exchange (típico 5-50ms) |
| **Slippage de mercado** | Modelado sobre L2 snapshot, no sobre tape real | El order book puede moverse entre detección y ejecución |
| **Wallets** | Pre-funded simulados con balances iniciales configurables | Balances reales, KYC/compliance, custodia |
| **Competencia** | No hay otros arbitrageurs en la simulación | En producción, los spreads se cierran en ms por competencia |
| **Riesgo de contraparte** | No simulado | Riesgo de quiebra/hack de exchange |
| **MongoDB persistencia** | Opcional — el sistema funciona en memoria si no hay MongoDB | En producción, persistencia crítica para audit trail |

---

## Tests y MongoDB

La suite completa (1656 tests, 102 archivos) pasa en un entorno sin MongoDB: la capa de
persistencia usa mocks en memoria por defecto cuando `MONGODB_URI` no está configurada, y el
resto del sistema (detección, ejecución simulada, riesgo, rebalanceo, backtesting) no depende de
una base de datos real para operar ni para testear. Si `MONGODB_URI` sí está configurada, algunos
tests de persistencia ejercitan la conexión real en lugar del mock — ambos caminos están
cubiertos.

---

## Supuestos del modelo

1. **Fills instantáneos**: asumimos que al detectar una oportunidad podemos ejecutar ambos lados inmediatamente. En producción, habría latencia de red y riesgo de que el precio cambie.

2. **Capital infinitamente divisible**: el position sizing puede elegir tamaños fraccionales. En producción, los exchanges tienen lot sizes mínimos.

3. **Withdrawal fees fijos**: usamos una tabla de fees estática. En producción, los fees varían con el congestionamiento de la red.

4. **Sin impacto de mercado**: nuestros trades no mueven el precio. Cierto para tamaños pequeños; falso para trades institucionales grandes.

5. **Spread observable = spread ejecutable**: el bid/ask que vemos en el WS podría no ser el que conseguimos en ejecución real (latencia, front-running).

---

## ¿Por qué $110K USDT + 1 BTC por exchange y no $10K?

No es un número arbitrario, son dos decisiones de diseño explícitas:

1. **Sizing institucional para señal significativa.** Con capital retail (ej. $5K), la mayoría de las oportunidades viables quedan por debajo del mínimo operable en varios exchanges, y el sistema pasaría la mayor parte del tiempo sin nada que mostrar — malo para demostrar el motor de detección. $110K/exchange asegura que el bilateral engine, el StatArb y el rebalanceo tengan suficiente profundidad para producir señal constante.
2. **Es 100% configurable, no hardcodeado.** El sizing vive en `.env` / `liveConfig.js` (`tradeAmountBTC`, balances iniciales de `walletManager.js`), no en el motor de scoring. Bajarlo a capital retail no rompe nada — solo reduce la frecuencia de oportunidades viables, exactamente como pasaría en la vida real.

Si quieres ver el sistema con capital retail: cambia `WALLET_BTC=0.05` y `WALLET_USDT=5000` en tu `.env` y reinicia (ver `walletManager.js:INITIAL_BALANCES`). El motor de scoring, riesgo y rebalanceo siguen funcionando exactamente igual — solo verás menos oportunidades sobre el umbral de viabilidad, que es justamente la diferencia real entre operar con capital institucional vs retail.

---

## Honestidad sobre el valor del sistema

Kukora demuestra que **la arquitectura, la detección y la lógica de riesgo son correctas y robustas**. 

Lo que necesitaría para producción real es principalmente:
- Adaptar el módulo de ejecución para llamar APIs reales de exchange
- Paper trading con capital mínimo para validar slippage real vs modelado
- Manejo de rate limits y errores de red reales

El núcleo del sistema (detección, scoring, riesgo, rebalanceo) ya está a nivel producción.

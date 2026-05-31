
# kukora — Bitcoin Arbitrage Intelligence Platform
<img width="87" height="87" alt="favicon" src="https://github.com/user-attachments/assets/e5cead08-aace-4eaa-8577-72bea4626dc2" />

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![Deploy](https://img.shields.io/badge/deploy-Railway-purple)
![Exchanges](https://img.shields.io/badge/exchanges-5-blue)
![Detection](https://img.shields.io/badge/detection-event--driven%20WS-orange)
![Data](https://img.shields.io/badge/data-100%25%20real%20market-green)

> Detección y ejecución simulada de arbitraje de Bitcoin en tiempo real.
> Event-driven <30ms · **Statistical Arbitrage (Z-Score)** · **Triangular 3-Leg Sync** · VWAP L2 slippage real · Score compuesto 7 factores · 5 exchanges simultáneos · Equity curve 100% real.

## 🚀 Live Demo

**URL:** [https://kukora-production.up.railway.app/arbitrage](https://kukora-production.up.railway.app/arbitrage)
**Admin Reset:** Requiere `ADMIN_TOKEN` en headers.

## 📸 Preview

> [!TIP]
> Aquí puedes ver el sistema operando en tiempo real con 5 exchanges simultáneos.

| Dashboard Principal | Analytics & Risk |
|:---:|:---:|
| <img width="1878" height="1016" alt="image" src="https://github.com/user-attachments/assets/03c54ec0-c8f3-4668-8ebc-61b24f4e6786" />
 | <img width="1869" height="1026" alt="image" src="https://github.com/user-attachments/assets/156766c7-b62d-482f-89a7-71e5b6424724" />
|
| *Monitoreo en tiempo real y equity curve* | *Métricas cuantitativas y perfiles de riesgo* |

---

---

## El Sistema

Kukora monitorea 5 exchanges simultáneamente via WebSocket, detecta divergencias de precio en tiempo real y simula la ejecución de operaciones de arbitraje con un modelo de costos completo: fees reales de cada exchange, slippage VWAP calculado desde el order book L2 en vivo, y circuit breakers de 4 niveles.

Todas las oportunidades detectadas y operaciones ejecutadas provienen exclusivamente de datos de mercado reales. No hay spreads sintéticos ni inyecciones artificiales.

---

## Arquitectura de Detección — Event-Driven

### Por qué importa

La mayoría de sistemas de arbitraje usan polling cada N segundos. Kukora dispara la detección en cada mensaje WebSocket entrante:

```
Polling tradicional:
  Mensaje WS → esperar ciclo (hasta 800ms) → detectar → ejecutar
  Latencia total: 800ms – 1800ms

Kukora (event-driven):
  Mensaje WS → emit('priceUpdate') → detectar → ejecutar
  Latencia total: < 30ms
```

### Flujo

```
exchangeService.js
  ↓ ws.on('message') → markUpdated() → priceEmitter.emit('priceUpdate')
arbitrage.routes.js
  ↓ priceEmitter.on('priceUpdate') → detectOpportunities() → executeSimulated()
SSE loop (150ms)
  → solo actualiza la UI, no bloquea la detección
```

### Inteligencia de Mercado — Multi-Estrategia

Kukora no solo busca spreads bilaterales simples; implementa un stack de inteligencia cuantitativa:

1. **Arbitraje Estadístico (StatArb)**: Monitorea el spread relativo entre exchanges y calcula el **Z-Score** sobre una ventana deslizante de 100 periodos. Identifica oportunidades de reversión a la media incluso cuando el spread actual es bajo.
2. **Arbitraje Triangular (3-Leg)**: Escanea ciclos (ej. BTC → USDT → ETH → BTC) a través de múltiples mercados para capturar ineficiencias circulares de liquidez.
3. **Regime Detection**: Clasifica el microambiente de mercado (Liquidity Compression, Volatile Uncertainty) para ajustar agresividad de ejecución.
4. **Predictive Fill Probability**: Estima la probabilidad de llenado de una orden *Taker* basándose en la profundidad del libro y latencia histórica.

---

## Modelo de Ejecución — Bilateral Pre-funded

Kukora implementa el modelo **bilateral pre-funded**, que es el **estándar operativo de firmas institucionales de arbitraje** (Jump Trading, Cumberland, Wintermute). La razón es simple y técnica:

> **Transferir fondos entre exchanges tarda minutos, no milisegundos.** Una transferencia de BTC entre Binance y Kraken toma 10–30 minutos en confirmarse on-chain. Ningún sistema de arbitraje competitivo puede depender de transferencias en tiempo real; la oportunidad desaparece en segundos.

**Cómo funciona:**
- Wallets pre-funded con BTC y USDT en los 5 exchanges simultáneamente
- Cada trade ejecuta **dos operaciones atómicas en paralelo**: compra BTC en exchange A + venta BTC en exchange B, sin movimiento de fondos entre exchanges
- **Withdrawal fees** = costo de **rebalanceo periódico** (~cada 24h cuando los balances se desequilibran), **no deducido por trade**
- Los saldos iniciales (~1 BTC + $110k USDT por exchange) cubren ~20 trades de 0.05 BTC antes de necesitar rebalanceo
- Este modelo replica exactamente el ejemplo del challenge (comprar en A, vender en B simultáneamente)

### Fórmula P&L

```
netProfit = grossProfit − buyFee − sellFee − slippageCost

grossProfit  = (bidB − askA) × amount
buyFee       = askA  × amount × feeExchangeA
sellFee      = bidB  × amount × feeExchangeB
slippageCost = VWAP L2 cuando hay order book disponible, fallback 0.05%/lado
```

### Ejemplo del challenge (replicado exactamente)

```
Exchange A (Kraken): Comprar Ask $70,000 + fee $70   = costo $70,070
Exchange B (Binance): Vender Bid $70,250 − fee $70.25 = ingreso $70,179.75
Ganancia neta: $109.75 USD
```

---

## Score Compuesto de Oportunidades (0–100)

Cada oportunidad recibe un score antes de decidir si ejecutarla. El sistema prioriza oportunidades de mayor score cuando hay múltiples viables simultáneas.

| Factor        | Máx pts | Fórmula                                          |
|---------------|---------|--------------------------------------------------|
| Rentabilidad  | 35      | `log1p(netProfitPct×500)×5.5`, techo en 35       |
| Liquidez      | 20      | `max(0, 20×(1−slipRatio×1.5))`                   |
| Persistencia  | 15      | Zona óptima 0.10%–0.80% de spread                |
| Latencia      | 15      | 15 si ambos WS, degrada con ms de HTTP           |
| Confianza     | 10      | Fuente WS (6 pts) + método VWAP (4 pts)          |
| Penalización  | −3 pts  | Feed con antigüedad > 3s                         |
| Penalización  | −5 pts  | Coinbase (fee 0.60% vs 0.10% en otros)           |

---

## Circuit Breakers — 5 Niveles

| Control               | Valor        | Descripción                                              |
|-----------------------|--------------|----------------------------------------------------------|
| `MIN_NET_PROFIT`      | $0.05        | Ganancia neta mínima (escala con 0.05 BTC × trade size)  |
| `MIN_SPREAD_PCT`      | 0.005%       | Spread mínimo — rechaza ruido de mercado                 |
| `MAX_SPREAD_PCT`      | 3.0%         | Spread máximo — indica datos obsoletos                   |
| `MAX_DAILY_LOSS`      | −$500        | Stop-loss diario — el bot se detiene automáticamente     |
| `FINGERPRINT_TTL`     | 5,000ms      | Deduplicación — mismo nivel de precio no se repite       |
| `MIN_EXEC_INTERVAL`   | 300ms        | Tiempo mínimo entre ejecuciones                          |
| Validación de balance | pre-check    | Balances verificados antes de ejecutar, rollback si falla|
| Liquidez L2           | 50% fill min | Ejecuta parcial si 50–99% disponible; rechaza <50%       |
| Triangular mínimo     | 0.05% neto   | Auto-ejecuta triangular solo si netPct ≥ 0.05%           |

---

## Slippage VWAP Real

Para los exchanges con order book L2 en vivo (Binance, Kraken, Bybit, OKX), el slippage se calcula recorriendo los niveles del libro hasta llenar el volumen de la orden:

```javascript
// VWAP walk through L2 levels
let remaining = tradeAmount;
for (const [price, qty] of levels) {
  const fill = Math.min(remaining, qty);
  totalCost += fill * price;
  remaining -= fill;
  if (remaining <= 0) break;
}
const avgPrice    = totalCost / tradeAmount;
const slippagePct = Math.abs((avgPrice - topPrice) / topPrice) * 100;
```

Si el order book no está disponible (Coinbase o feed caído), se usa fallback conservador de 0.05% por lado.

---

## Exchanges y Feeds

| Exchange  | Protocolo      | Datos recibidos                        | Fee taker |
|-----------|---------------|----------------------------------------|-----------|
| Binance   | WebSocket      | bookTicker + depth5@100ms              | 0.10%     |
| Kraken    | WebSocket v2   | ticker + book depth 10 (incremental)   | 0.26%     |
| Bybit     | WebSocket      | tickers + orderbook.50                 | 0.10%     |
| OKX       | WebSocket      | books5 + tickers                       | 0.10%     |
| Coinbase  | WebSocket      | Advanced Trade ticker público          | 0.60%     |

Los 4 primeros exchanges mantienen order book L2 sincronizado con actualizaciones incrementales. Coinbase se usa solo para detección de precio (no para L2 slippage).

Un **watchdog** monitorea cada 8s si algún feed lleva >5s sin actualizar y fuerza reconexión automática con backoff exponencial (máximo 30s).

---

## Señal Triangular (informacional)

El sistema evalúa también rutas de 3 exchanges (`A → B → C`) buscando oportunidades multi-leg. Cuando encuentra una con netPct positivo neto de fees y slippage, la muestra en la UI como señal informacional. No se ejecuta automáticamente.

```
netPct = ((1 + s1) × (1 + s2) − 1) × 100 − feesPct − slippageFallback
```

---

## 🧭 Guía de Funcionalidades (Tour por Kukora)

Kukora no es solo un bot de ejecución; es un sistema de inteligencia de mercado completo de 20 páginas:

### 1. 🤖 Arbitraje Live (Core)
*   **Monitoreo 5x**: Vista consolidada de 5 exchanges con latencia real (WS vs HTTP).
*   **Audit Modal**: Haz clic en cualquier trade para ver el desglose matemático: bruto, neto, fees detallados y método de slippage usado.
*   **Filtros Inteligentes**: Ajusta el `Score Mínimo` en tiempo real para filtrar ruido de mercado.

### 2. 🧠 Intelligence & Analytics
*   **Predictive Ranking**: Algoritmo que predice qué pares son más propensos a abrir oportunidades basándose en volatilidad histórica.
*   **Market Regime**: Clasificación automática del entorno (Trending, Ranging, Volatile) para ajustar la agresividad.
*   **Fill Probability**: Probabilidad estadística de que una orden se complete basada en la profundidad del libro.

### 3. 🛡️ Risk Management
*   **Risk Engine**: Reportes detallados por asset con métricas VaR (Value at Risk), Sharpe, Sortino y correlación de Pearson.
*   **Circuit Breakers**: Visualiza qué controles de riesgo están deteniendo operaciones (Liquidez insuficiente, Spread inconsistente, etc).

### 4. 📊 Portfolio & Backtest
*   **Equity Curve**: Seguimiento en tiempo real de la rentabilidad acumulada.
*   **Monte Carlo Simulation**: Proyección de escenarios de riesgo para el portafolio basado en caminata aleatoria.
*   **Correlation Galaxy**: Mapa visual de interdependencia entre activos para evitar sobre-exposición.

---

## Stack

| Capa       | Tecnología                                        |
|------------|---------------------------------------------------|
| Frontend   | React 18 + Vite + Recharts                        |
| Backend    | Node.js + Express                                 |
| Realtime   | SSE (cliente) + EventEmitter (servidor)           |
| WS feeds   | Binance, Kraken, Bybit, OKX (4× concurrentes)     |
| HTTP feed  | Coinbase Advanced Trade (fallback REST)           |
| Base datos | MongoDB Atlas (opcional, fallback en memoria)     |
| Deploy     | Railway                                           |

---

## Setup Local

```bash
# Instalar dependencias
npm install

# Configurar entorno
cp .env.example .env
# Editar .env: ajustar PORT, MONGODB_URI (opcional), ADMIN_TOKEN

# Desarrollo (servidor + Vite en paralelo)
npm run dev

# Ejecutar smoke tests
npm test
```

### Variables de entorno

| Variable           | Default       | Descripción                                          |
|--------------------|---------------|------------------------------------------------------|
| `PORT`             | `5000`        | Puerto del servidor                                  |
| `NODE_ENV`         | `development` | `production` sirve el frontend compilado             |
| `MONGODB_URI`      | —             | MongoDB Atlas (opcional — usa memoria si no se define)|
| `ADMIN_TOKEN`      | —             | Protege el endpoint `POST /api/arbitrage/reset`      |
| `WALLET_BTC`       | `1`           | BTC inicial por exchange                             |
| `WALLET_USDT`      | `110000`      | USDT inicial por exchange (cubre ~20 trades 0.05 BTC)|
| `TRADE_AMOUNT_BTC` | `0.05`        | Tamaño de operación en BTC (5× vs v6)                |
| `FORCE_MAKER_FEES` | `false`       | Usa maker fees en lugar de taker fees                |

---

## Tests

```bash
npm test
# → ✓ All tests passed — Kukora smoke test OK
```

Los tests cubren: valores de fee config, cálculo VWAP slippage, detección con spread viable, activación de circuit breaker, ejecución de trade, rango de score, y correctitud del modelo bilateral pre-funded.

---

## API Endpoints

| Endpoint                       | Descripción                                    |
|--------------------------------|------------------------------------------------|
| `GET /api/arbitrage/stream`    | SSE stream en tiempo real (primario)           |
| `GET /api/arbitrage/live`      | Snapshot REST (fallback)                       |
| `GET /api/arbitrage/stats`     | Stats detallados del sistema + contadores      |
| `GET /api/arbitrage/history`   | Historial de trades ejecutados                 |
| `GET /api/arbitrage/wallets`   | Saldos actuales por exchange                   |
| `POST /api/arbitrage/bot`      | Activar/desactivar bot, ajustar minScore       |
| `POST /api/arbitrage/reset`    | Reset wallets + equity curve (requiere token)  |
| `GET /health`                  | Health check del servidor                      |

---

## Deploy en Railway

```toml
# railway.toml — ya configurado
[build]
builder = "nixpacks"

[deploy]
startCommand = "node server/index.js"
```

El `Procfile` y `railway.toml` están incluidos. Railway detecta automáticamente Node.js y ejecuta `npm run build` + `node server/index.js`.

Variables de entorno a configurar en Railway:
- `NODE_ENV=production`
- `MONGODB_URI` (opcional pero recomendado para persistir historial de trades)
- `ADMIN_TOKEN` (para proteger el endpoint de reset)

---

## Decisiones Técnicas

**¿Por qué event-driven y no polling?**
El polling introduce latencia proporcional al intervalo configurado. Con event-driven, la detección ocurre en el mismo tick del loop de Node.js en que llega el dato del exchange. En arbitraje, cada milisegundo cuenta.

**¿Por qué pre-funded bilateral?**
El modelo alternativo (transferir activos entre exchanges por cada trade) es inviable en práctica: los tiempos de confirmación on-chain son de minutos, no milisegundos. El modelo pre-funded es el estándar en firms como Jump Trading, Cumberland y DRW para trading de crypto institucional.

**¿Por qué VWAP L2 y no precio mid?**
El precio mid ignora el impacto de mercado. Con 0.01 BTC a $100k, el slippage real es mínimo (~$0.50). Pero con 0.1 BTC o en exchanges con menor liquidez, el VWAP walk puede cambiar la viabilidad de una operación. Calcularlo desde el order book en vivo es la única forma precisa.

**¿Por qué score compuesto y no simple rentabilidad?**
Una oportunidad con spread de 0.80% en un exchange con feed de 4s de antigüedad es mucho menos confiable que una de 0.30% con ambos feeds WS frescos. El score penaliza staleness, latencia, y exchanges de alto fee, priorizando operaciones con mayor probabilidad de ejecución exitosa.

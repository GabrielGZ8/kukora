# JudgeGuide — Cómo evaluar Kukora en 5 minutos

> Guía directa para evaluadores técnicos. Sin relleno.

---

## 1. Abre el sistema (30 segundos)

```bash
npm install && npm run dev
# abre http://localhost:5173
```

Verás el banner **"SISTEMA LISTO"** en verde cuando ≥4 exchanges estén conectados vía WebSocket y todos los feeds estén frescos. Si ves "CALENTANDO", espera ~10 segundos.

---

## 2. Tab NÚCLEO: el corazón del sistema

### ⚡ Oportunidades (tab por defecto)

Esto es lo que debes mirar primero:

- **Tabla de oportunidades detectadas**: cada fila muestra par, exchange buy/sell, spread bruto, fees estimados, spread neto, score compuesto, fill probability
- **Columna "Motivo de descarte"**: muestra exactamente por qué cada oportunidad fue rechazada — no es una caja negra
- **Sección "Scoring breakdown"**: desglose del score en 5 componentes con pesos configurables
- **Contadores en tiempo real**: detectadas / viables / ejecutadas este tick

**Qué demuestra**: detección O(n²) bilateral, VWAP L2 real (no midprice), scoring multicriteria, trazabilidad completa.

### 📈 Trades & Ejecución

- Lista de todos los trades ejecutados con latencia e2e, fill ratio, gross spread, fees, net P&L
- Click en cualquier trade → **Trade Drilldown**: audit trail completo del ciclo de vida

### 💰 P&L Auditado

- Reconciliación contable: P&L realizado + mark-to-market de BTC abierto = P&L total
- Botones de descarga: CSV (para auditoría) y HTML (para presentación)
- Cada centavo es trazable hasta el trade individual

---

## 3. Tab INVENTARIO: capital y riesgo

### ⚖️ Inventario & Wallets

Demuestra: el sistema mantiene capital pre-funded en 5 exchanges simultáneamente. Cuando un exchange se desbalancea:
1. El detector lo identifica automáticamente
2. Calcula el movimiento óptimo con costo real (withdrawal fee + slippage)
3. Muestra urgencia (ALTO / MEDIO / BAJO)
4. Ejecución simulada con efecto inmediato en wallets

Esto es sobre el modelo de wallets simulado. Para las cuentas reales de exchange (`GET
/api/trading/reconciliation`), el sistema añade una capa predictiva por sesgo direccional que
anticipa el desbalance antes de que la concentración cruce el umbral reactivo — ver
[Rebalancing.md](Rebalancing.md#live-inventory-reconciliation--a-second-distinct-rebalancing-system).

### 🛡 Riesgo & Salud

- **Circuit breakers** activos: daily loss limit, max position size, exchange penalty
- **Feeds**: cualquier exchange con data stale aparece aquí en rojo
- **Drawdown actual** vs límite configurado
- **Alertas históricas**: todo queda loggeado con severity y timestamp

---

## 4. Tab OPERACIONAL: configuración en vivo

### ⚙️ Parámetros

Cambia cualquier parámetro sin reiniciar el servidor:
- `minScore` — umbral de ejecución
- `maxTradeSize` — tamaño máximo por trade  
- `feeMode` — maker vs taker
- `rebalanceThresholdPct` — cuándo activar rebalanceo
- `dailyLossLimit` — circuit breaker global

Los cambios se aplican en el siguiente tick de detección (~150ms).

### 🧪 Stress Test + 💥 Adversarial

- **Stress**: simula fee shock, liquidez crunch, slippage extremo sobre datos reales en vivo
- **Adversarial**: mid-flight failure (buy OK, sell falla), timeout, API outage — el sistema muestra su estrategia de recovery paso a paso

---

## 4.1 Latencia end-to-end (cifra agregada citable)

Los números de latencia por trade ya se ven en el tab **Trades & Ejecución**. Para una cifra
agregada (p50/p95/p99 sobre las últimas 500 muestras, con desglose por exchange), el sistema
expone:

```
GET /api/arbitrage/e2e-latency
GET /api/arbitrage/e2e-latency?samples=100   # incluye las últimas N muestras crudas
```

Implementado en `server/infrastructure/e2eLatencyTracker.js` — buffer circular de 500 muestras,
percentiles calculados on-demand por interpolación lineal. Cada muestra se registra en
`arbitrageOrchestrator.js` en cada tick de detección real (no es un mock).

**Nota de honestidad técnica**: este endpoint no tiene una cifra fija documentada aquí a propósito
— los percentiles solo son significativos después de correr el sistema contra market data real
el tiempo suficiente para llenar el buffer (recomendado: 30–60 min de sesión en vivo antes de la
evaluación). Correr `curl http://localhost:5000/api/arbitrage/e2e-latency | jq .data.e2e` después
de esa ventana y citar el resultado real, no un número inventado de antemano.

---

## 5. Corre los tests (60 segundos)

```bash
npm test
```

Verás 1656 tests en verde (102 archivos). Ver [SystemLimits.md](SystemLimits.md) para el detalle de qué queda fuera del alcance de los mocks en memoria (persistencia cross-session con MongoDB real).

---

## Lo que NO hace Kukora (honestidad técnica)

Ver [SystemLimits.md](SystemLimits.md) para detalle completo.

En resumen: la ejecución es simulada sobre market data real. Las fills son instantáneas sin latencia de red real. El slippage se modela pero no se mide contra una ejecución real de exchange.

---

## Preguntas frecuentes de evaluación

**¿Por qué VWAP y no midprice?**  
Midprice asume fills infinitos al mejor precio. VWAP L2 calcula el precio real ponderado por volumen disponible en el order book. Ver [ADR-001](ADR-001-vwap-l2-vs-midprice.md).

**¿Por qué log-spread y no diferencia absoluta?**  
El spread absoluto no es estacionario — el log-spread sí lo es para pares cointegrados. Esto es fundamental para el modelo AR(1) de half-life. Ver [ADR-002](ADR-002-log-spread-stationarity.md).

**¿El sistema funcionaría en producción?**  
Con adaptadores de ejecución reales y paper trading primero, sí. Ver [RoadmapToProduction.md](RoadmapToProduction.md).

**¿Cómo maneja el sistema la incertidumbre del slippage cuando no hay profundidad de order book completa?**  
`computeSlippage()` en `server/domain/engines/opportunityDetection.js` no asume una calidad de dato
uniforme: cada estimado se etiqueta con `slippageMethod` según cuánta profundidad real del order
book pudo usar — `'real'` (VWAP completo sobre L2, confianza alta), `'partial'` (profundidad
incompleta, confianza media) o `'fallback'` (sin datos de profundidad, estimado conservador,
confianza baja). Esa etiqueta se propaga al score de la oportunidad, así que el sistema nunca
presenta un estimado de baja confianza con la misma seguridad que uno medido directamente contra
el libro real.

**¿Cómo anticipa el sistema desequilibrios de inventario antes de que ocurran?**  
Dos mecanismos independientes, documentados en detalle en [Rebalancing.md](Rebalancing.md):
(1) sobre el modelo de wallets simulado, `predictiveRebalance.js` proyecta la tasa de consumo
BTC/USDT por exchange y dispara una recomendación antes de que se agote el balance; (2) sobre las
cuentas reales en `GET /api/trading/reconciliation`, `directionalBiasTracker.js` rastrea el sesgo
comprador/vendedor de las últimas 20 ejecuciones cross-exchange y dispara una sugerencia
predictiva (`trigger: 'predictive'`) cuando un exchange ha sido consistentemente el lado vendedor
y su concentración ya está en tendencia hacia el umbral reactivo — antes de cruzarlo.

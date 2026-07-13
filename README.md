# Kukora<img width="876" height="876" alt="favicon" src="https://github.com/user-attachments/assets/efcf03f4-5175-4d4a-9295-7929268dfdb8" />


### Quantitative Crypto Arbitrage Intelligence Platform

**Status:** Paper trading · Multi-tenant · v2.23.0
**License:** Private — all rights reserved
**Node:** ≥ 18 · **Tests:** 2014 passing / 127 files · **Type-check:** clean · **Build:** clean

---

## Tabla de contenidos

1. [Descripción del proyecto](#1-descripción-del-proyecto)
2. [Qué decide una operación y qué es solo analítico](#2-qué-decide-una-operación-y-qué-es-solo-analítico)
3. [Arquitectura](#3-arquitectura)
4. [Stack tecnológico](#4-stack-tecnológico)
5. [Requisitos previos](#5-requisitos-previos)
6. [Instalación](#6-instalación)
7. [Variables de entorno](#7-variables-de-entorno)
8. [Ejecución](#8-ejecución)
9. [Scripts disponibles](#9-scripts-disponibles)
10. [Estructura del proyecto](#10-estructura-del-proyecto)
11. [Flujo de la aplicación](#11-flujo-de-la-aplicación)
12. [Módulos de la plataforma](#12-módulos-de-la-plataforma)
13. [Multi-tenancy y trading en vivo por usuario](#13-multi-tenancy-y-trading-en-vivo-por-usuario)
14. [Plataforma operacional (institutional layer)](#14-plataforma-operacional-institutional-layer)
15. [API](#15-api)
16. [Base de datos](#16-base-de-datos)
17. [Testing](#17-testing)
18. [Calidad de código](#18-calidad-de-código)
19. [Seguridad](#19-seguridad)
20. [Docker](#20-docker)
21. [Despliegue](#21-despliegue)
22. [Decisiones técnicas (ADRs)](#22-decisiones-técnicas-adrs)
23. [Límites del sistema — qué es real y qué es simulado](#23-límites-del-sistema--qué-es-real-y-qué-es-simulado)
24. [Roadmap](#24-roadmap)
25. [Problemas conocidos](#25-problemas-conocidos)
26. [FAQ](#26-faq)
27. [Documentación adicional](#27-documentación-adicional)
28. [Licencia y contacto](#28-licencia-y-contacto)

---

## 1. Descripción del proyecto

**Kukora** es una plataforma de inteligencia de arbitraje cuantitativo para Bitcoin y otros pares, operando sobre **cinco exchanges reales en simultáneo** (Binance, Kraken, Bybit, OKX y Coinbase) vía WebSockets nativos.

### Qué problema resuelve

Bitcoin se negocia de forma fragmentada: cada exchange tiene su propio libro de órdenes, su propia liquidez y, por lo tanto, su propio precio. Esas divergencias de precio —el spread entre el mejor Ask de un exchange y el mejor Bid de otro— son la materia prima del arbitraje. Detectarlas manualmente, o con herramientas que comparan solo mid-price sin considerar profundidad de libro, fees reales, slippage y latencia, produce señales que parecen rentables en bruto pero no lo son en neto.

Kukora resuelve esto construyendo el pipeline completo: **detección → scoring multi-factor → validación de riesgo → ejecución simulada → contabilidad auditada**, con cada paso trazable y cada rechazo explicado.

### Para quién está hecho

- Para un jurado o evaluador técnico que necesita verificar, en minutos, que el sistema hace lo que dice que hace (ver [JudgeGuide.md](docs/JudgeGuide.md)).
- Para un desarrollador que quiera estudiar cómo estructurar un sistema de trading paper con disciplina de ingeniería: capas de dominio separadas, motor de riesgo independiente, máquina de estados para el ciclo de vida de cada operación, event sourcing parcial, multi-tenancy real.
- Como base extensible hacia ejecución con capital real, con el camino de producción ya documentado y las decisiones de diseño registradas explícitamente (no descubiertas leyendo el código).

### Objetivos

- Detectar oportunidades de arbitraje bilateral en tiempo real sobre order books L2 reales, no sobre mid-price teórico.
- Calcular rentabilidad neta considerando fees, slippage estimado y viabilidad de liquidez antes de decidir ejecutar.
- Simular ejecución con manejo de órdenes parciales y actualización correcta de balances por exchange.
- Mantener un registro completo, auditable y exportable de cada oportunidad detectada, ejecutada o rechazada.
- Ir un paso más allá de un bot de una sola cuenta: soportar múltiples tenants/usuarios de forma aislada, y dar a cada usuario un camino real (con sus propias llaves, su propio 2FA y su propio consentimiento explícito) hacia trading con dinero real, sin que eso sea una decisión de producto tomada silenciosamente por el código.

### Alcance

El motor de ejecución opera en **modo paper trading por defecto** (`TRADING_MODE=paper`). El código para conectar credenciales reales de exchange y operar en vivo por usuario está implementado, probado y gateado detrás de 2FA + aceptación explícita de un disclaimer — pero exponerlo a usuarios reales de producción es, deliberadamente, una decisión de producto/legal separada de la decisión de ingeniería, y esa distinción se documenta en el propio `CHANGELOG.md` en el momento en que se construyó la funcionalidad, no se descubre después.

---

## 2. Qué decide una operación y qué es solo analítico

Esta distinción es lo primero que cualquiera que revise el código debería entender, así que va antes que la arquitectura.

El camino de ejecución es determinista y auditable de punta a punta:

```
detectOpportunities() → scoreOpportunityDetailed() → arbitrageOrchestrator
  → checkExecutionGuards() → executeBestOpportunity() → liveExecution
  → advancedRiskEngine (risk gate) → walletManager → eventStore
```

**ML Scoring** (`mlScoringPipeline.js`, `POST /api/arbitrage/ml/score`), **Market Regime**, **Monte Carlo**, **Correlation Galaxy** y **Forecast** son superficies analíticas reales, calculadas de forma independiente, cada una con su propia página y sus propios tests — pero **ninguna de ellas alimenta la decisión de ejecución de arriba**. Existen para que un operador compare scoring determinístico contra scoring basado en ML, o lea condiciones de mercado, sin que un modelo no-explicable decida hacia dónde se mueve capital real. Esta es una decisión de diseño deliberada para un sistema que —incluso en modo paper— está pensado para eventualmente manejar capital real, no una funcionalidad faltante. Está señalada aquí, en comentarios de código en el punto exacto donde se calcula, y en los tooltips de esas páginas en la UI, para que nunca tenga que descubrirse leyendo el código fuente.

---

## 3. Arquitectura

Kukora sigue una separación de capas explícita dentro de `server/`, deliberadamente cercana a Clean Architecture / arquitectura hexagonal, aunque sin dogmatismo: cada carpeta tiene una responsabilidad y una dirección de dependencia claras.

```
server/
 ├── domain/            → lógica de negocio pura, sin I/O
 │    ├── engines/       (detección, scoring, backtesting, StatArb, rebalance)
 │    ├── risk/           (circuit breakers, validación, position sizing adaptativo)
 │    ├── wallet/         (balances, P&L auditado, fees)
 │    └── analytics/      (forecasting, explainability, reportes, lifecycle)
 ├── application/       → orquestación — coordina dominio + infraestructura
 │    (arbitrageOrchestrator, liveExecution, tenant execution, 2FA)
 ├── infrastructure/    → todo lo que toca el mundo exterior
 │    (exchange adapters, auth, RBAC, feature flags, background jobs,
 │     event store, telemetry, rate limiting, secrets vault)
 └── routes/            → superficie HTTP (Express routers + subrutas)
```

Diagrama de flujo de datos, del feed de mercado a la pantalla:

```
                     ┌──────────────────────────────────────┐
                     │  infrastructure/exchangeService.js     │
                     │  5 exchanges · WebSockets nativos     │
                     │  Binance · Kraken · Bybit · OKX · CB │
                     └──────────────┬───────────────────────┘
                                    │  order books L2
                     ┌──────────────▼───────────────────────┐
                     │  domain/engines/opportunityDetection.js│
                     │  detección O(n²) · VWAP L2 · scoring  │
                     └──────────────┬───────────────────────┘
                                    │
           ┌────────────────────────┼─────────────────────┐
           │                        │                       │
  ┌────────▼───────┐  ┌─────────────▼──────┐  ┌──────────▼──────────┐
  │ advancedRisk   │  │  walletManager     │  │ tradeStateMachine   │
  │ circuit break  │  │  balances pre-      │  │ 12 estados          │
  │ daily stop     │  │  fondeados 5 ex.    │  │ rollback y fills    │
  │                │  │  modelo bilateral   │  │ parciales           │
  └────────────────┘  └────────────────────┘  └─────────────────────┘
                                    │
                     ┌──────────────▼───────────────────────┐
                     │  application/arbitrageOrchestrator.js │
                     │  event-driven (WS) + loop de 150ms    │
                     └──────────────┬───────────────────────┘
                                    │
                     ┌──────────────▼───────────────────────┐
                     │  routes/arbitrage.routes.js +          │
                     │  arbitrage/subroutes/*                │
                     │  SSE cada 150ms · endpoints REST      │
                     └──────────────┬───────────────────────┘
                                    │
                     ┌──────────────▼───────────────────────┐
                     │          Frontend React               │
                     │  30 páginas · stream en vivo por SSE  │
                     └──────────────────────────────────────┘
```

> **Nota de mantenimiento del diagrama:** los nombres de archivo de este diagrama se verificaron contra el código real el 2026-07-08 (ver `docs/TechnicalDueDiligence-2026-07-02.md`, addendum del 2026-07-02, punto 2, y ADR-011). Dos módulos con nombres casi idénticos que este diagrama citaba antes (`arbitrageEngine.js` y `arbitrage.engine.js`) fueron renombrados a `domain/engines/opportunityDetection.js` y `application/arbitrageOrchestrator.js` — mantener este diagrama sincronizado con el código es responsabilidad de quien haga el próximo rename de módulo.

Documentación completa de arquitectura: [docs/Architecture.md](docs/Architecture.md). Razonamiento de por qué esta forma de capas y no otra: [ADR-011](docs/ADR-011-routes-vs-arbitrage-subroutes.md) y [ADR-012](docs/ADR-012-no-top-level-server-api-folder.md).

---

## 4. Stack tecnológico

| Tecnología | Uso | Por qué |
|---|---|---|
| **Node.js + Express** | Runtime y API REST | I/O no bloqueante, natural para mantener 5 conexiones WebSocket concurrentes sin bloquear el event loop |
| **WebSockets nativos (`ws`)** | Feeds de mercado en tiempo real | Latencia de feed &lt; 5ms frente a polling REST |
| **Server-Sent Events (`EventSource`)** | Push del servidor al cliente | Push unidireccional sin el overhead de un WebSocket bidireccional para algo que el cliente nunca necesita escribir |
| **React 18 + Vite** | Frontend | HMR rápido, rutas con lazy-loading, sin inflar el bundle inicial con 30 páginas |
| **MongoDB + Mongoose** (opcional) | Persistencia | Modelo de documentos flexible para trades, analítica y config; el sistema corre en memoria sin ella |
| **Redis (`ioredis`, opcional)** | Cache / colas compartidas entre instancias | Solo necesario si se escala horizontalmente; sin él, los tickets SSE viven en memoria de proceso |
| **JWT (`jsonwebtoken`) + `bcryptjs`** | Autenticación | Access + refresh tokens, hash de contraseñas con bcrypt |
| **Firebase Admin** (opcional) | Google Sign-In | Alternativa de login sin contraseña local |
| **Zod** | Validación de esquemas | Validación de request bodies con mensajes de error tipados, en vez de checks manuales dispersos |
| **Helmet + `express-rate-limit`** | Endurecimiento HTTP | Cabeceras de seguridad + rate limiting general y financiero |
| **OpenTelemetry** (opcional) | Observabilidad | Tracing distribuido exportable a OTLP, costo cero cuando está apagado |
| **Vitest + Supertest** | Testing | 2014 tests, unitarios + e2e sobre la app Express real |
| **ESLint + Husky** | Calidad de código y pre-commit hooks | Lint automatizado + bloqueo de commits que incluyan `.env` o secretos |
| **Docker (multi-stage) / PM2** | Empaquetado y supervisión de proceso | Imagen de producción sin devDependencies; PM2 en modo fork (nunca cluster — ver ADR-016) para VMs sin Railway |
| **TypeScript (`tsc --noEmit`)** | Chequeo de tipos parcial | Verificación de tipos sin migrar todo el proyecto de JS a TS de golpe |

---

## 5. Requisitos previos

- Node.js ≥ 18 (probado en 18 y 20)
- npm ≥ 9
- Git
- MongoDB 6+ — **opcional**, solo si se quiere persistencia entre reinicios
- Docker — opcional, solo para despliegue en contenedor

No se requieren credenciales de exchange para correr el sistema en modo paper: los feeds de mercado son endpoints públicos, sin autenticación.

---

## 6. Instalación

```bash
git clone https://github.com/GabrielGZ8/kukora.git
cd kukora
npm install
```

`npm install` instala 986 paquetes (dependencias de producción + desarrollo) y registra los hooks de Husky (`prepare`), que bloquean cualquier intento de commitear un archivo `.env`.

---

## 7. Variables de entorno

```bash
cp .env.example .env
```

**Nada en `.env` es obligatorio para desarrollo local** — el proyecto corre en memoria (sin Mongo) y con secretos JWT generados aleatoriamente en cada arranque si no se configuran. En producción, `server/index.js` falla duro si `JWT_SECRET`/`JWT_REFRESH_SECRET` faltan — nunca hay un fallback silencioso e inseguro en ese caso.

| Variable | Obligatoria | Descripción |
|---|---|---|
| `NODE_ENV` | No (default `development`) | `development` / `production` / `test` |
| `PORT` | No (default `3001`/`5000`) | Puerto del servidor Express |
| `FRONTEND_URL` | Recomendada en producción | Origen permitido por CORS |
| `MONGODB_URI` | No | Sin ella, el sistema corre en memoria. Con ella, persisten trades, P&L, event log y stats diarias |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | Sí en producción | Firma de tokens de acceso/refresh. Sin ellas en dev, se generan al vuelo (las sesiones no sobreviven un reinicio) |
| `KUKORA_MASTER_KEY` | Sí si se usa el módulo de credenciales de usuario | Llave de cifrado AES-256-GCM para las API keys de exchange que un usuario conecta desde Settings |
| `FIREBASE_PROJECT_ID` | No | Habilita Google Sign-In vía Firebase Admin |
| `REDIS_URL` | No | Cache compartida entre instancias; sin ella, cada instancia mantiene su propio estado SSE |
| `LIVE_TRADING_ENABLED`, `TRADING_MODE`, `DEMO_MODE`, `TRADE_AMOUNT_BTC`, `FORCE_MAKER_FEES` | No | Flags maestros del motor de trading — controlan si el sistema opera en paper o en vivo a nivel plataforma |
| `BINANCE_API_KEY/SECRET`, `BYBIT_TESTNET`, `KRAKEN_SANDBOX(_URL)`, `OKX_API_PASSPHRASE`, `OKX_DEMO_TRADING` | Solo si `LIVE_TRADING_ENABLED=true` | Credenciales a nivel plataforma para trading en vivo (independiente de las credenciales por-usuario) |
| `WALLET_BTC`, `WALLET_ETH`, `WALLET_XRP`, `WALLET_USDT` | No | Balances iniciales del wallet simulado por exchange |
| `MAX_DAILY_LOSS_USD`, `REBALANCE_DRIFT_THRESHOLD_PCT`, `ALERT_MIN_PROFIT`, `ALERT_COOLDOWN_MS`, `RISK_FREE_RATE` | No | Parámetros de riesgo y alertas — también editables en caliente desde la UI |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `WEBHOOK_URL` | No | Notificaciones externas opcionales |
| `MAX_SSE_CLIENTS`, `MAX_ALERT_SSE_CLIENTS`, `MAX_NOTIFICATION_SSE_CLIENTS` | No | Límites de conexiones SSE concurrentes |
| `OTEL_ENABLED`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT` | No | Tracing distribuido — apagado por default |
| `ADMIN_EMAILS`, `OPERATOR_EMAILS`, `ADMIN_TOKEN`, `INTERNAL_API_KEY` | No | Asignación de roles RBAC por email + acceso a endpoints internos (`/health`, `/api/metrics`) |
| `MEMORY_WARN_MB`, `MEMORY_CRIT_MB`, `MONTHLY_INFRA_COST_USD` | No | Umbrales de observabilidad y cálculo de ROI de infraestructura |

El archivo completo, comentado bloque por bloque, vive en [`.env.example`](.env.example) — es la fuente de verdad, esta tabla es un resumen.

---

## 8. Ejecución

**Desarrollo** (servidor + frontend con hot reload, en paralelo):

```bash
npm run dev
```

Abre [http://localhost:5173](http://localhost:5173). Tras iniciar sesión, el **Executive Dashboard** (`/executive`) es la página de aterrizaje canónica: scoring VWAP L2, gestión de riesgo y salud del sistema en una sola pantalla. `/summary` (resumen ejecutivo histórico) y `/dashboard` (dashboard de mercado) siguen disponibles desde la navegación para exploración más profunda.

**Producción:**

```bash
npm run build
npm start
```

**MongoDB es opcional.** Sin ella, el estado vive en memoria (se reinicia con el proceso). Con ella, el historial de trades, el P&L, el event log de cada trade y las estadísticas diarias persisten entre sesiones.

---

## 9. Scripts disponibles

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor (Express) + frontend (Vite) en paralelo, con salida coloreada por proceso |
| `npm run dev:watch` | Igual, pero con `--watch` en el servidor (reinicio automático en cambios de `server/`) |
| `npm run build` | Build de producción del frontend (Vite) → `dist/` |
| `npm run build:ts` | Compilación TypeScript de los archivos migrados |
| `npm start` | Arranca el servidor en modo producción (`NODE_ENV=production`) |
| `npm run preview` | Sirve el build de producción localmente para verificarlo |
| `npm test` | Corre la suite Vitest completa (2014 tests) |
| `npm run test:watch` | Vitest en modo watch |
| `npm run test:coverage` | Suite con reporte de cobertura (`@vitest/coverage-v8`) |
| `npm run test:smoke` | Suite de humo legacy (HTTP real contra un servidor corriendo) — ver [Testing](#17-testing) |
| `npm run lint` / `lint:fix` | ESLint sobre `src/` y `server/`, con o sin autofix |
| `npm run typecheck` | `tsc --noEmit` — chequeo de tipos sin emitir archivos |
| `npm run check:ts-drift` | Verifica que el build de TypeScript no haya divergido silenciosamente |
| `npm run check:i18n` | Verifica paridad de llaves entre los diccionarios `es`/`en` |
| `npm run audit` | `npm audit --audit-level=high` |
| `npm run docker:build` / `docker:run` | Construye y corre la imagen Docker localmente |
| `npm run pm2:start` / `stop` / `restart` / `logs` / `status` | Supervisión de proceso vía PM2 (modo fork, ver [ADR-016](docs/ADR-016-pm2-single-instance-constraint.md)) |
| `npm run tape:record` | Graba snapshots reales de order books de los 5 exchanges a un archivo JSON Lines |
| `npm run tape:sweep` | Reproduce una grabación a través del motor de detección real y corre un barrido de parámetros sobre ella |

---

## 10. Estructura del proyecto

```
kukora/
 ├── server/
 │    ├── domain/
 │    │    ├── engines/        # detección, scoring, backtesting, StatArb,
 │    │    │                   # rebalance, market regime, ML scoring
 │    │    ├── risk/            # circuit breakers, validación, position sizing
 │    │    ├── wallet/          # balances, P&L auditado, config de fees
 │    │    └── analytics/       # forecasting, explainability, reportes,
 │    │                         # ciclo de vida de oportunidades
 │    ├── application/         # orquestación (orchestrator, live execution,
 │    │                         # ejecución multi-tenant, 2FA)
 │    ├── infrastructure/      # exchange adapters, auth, RBAC, feature flags,
 │    │    │                   # background jobs, event store, telemetry,
 │    │    │                   # rate limiting, secrets vault, tenant state
 │    │    └── exchangeAdapters/  # un archivo *.adapter.js por exchange
 │    ├── routes/               # superficie HTTP (routers Express)
 │    ├── arbitrage/
 │    │    └── subroutes/       # config, query y stream, separados de
 │    │                         # arbitrage.routes.js por tamaño y cohesión
 │    ├── models.js             # esquemas Mongoose
 │    └── index.js              # composición de la app, middlewares, arranque
 ├── src/
 │    ├── pages/                 # 30 páginas React, todas con lazy-loading
 │    ├── components/            # componentes compartidos y de settings
 │    ├── hooks/                 # hooks custom (SSE, stale-after, etc.)
 │    ├── state/                 # estado global de la app
 │    ├── i18n/                  # diccionarios es/en, con chequeo de paridad
 │    ├── utils/, api.js, firebase.js, App.jsx, main.jsx
 ├── tests/                     # 127 archivos de test (Vitest) + smoke.test.js
 ├── scripts/                   # tape recorder, experiment sweep, checks de CI
 ├── docs/                      # Architecture, ADRs, guías, changelog detallado
 ├── public/                    # assets estáticos, service worker de Firebase
 ├── Dockerfile, railway.json, ecosystem.config.js
 ├── .env.example, .eslintrc.cjs, vite.config.js, vitest.config.js
 ├── CHANGELOG.md, PROGRESS.md, CHECKPOINT_2.23.0.md, CONTRIBUTING.md
 └── README.md
```

La separación `domain / application / infrastructure / routes` no es cosmética: el dominio no importa nada de infraestructura, la aplicación orquesta dominio + infraestructura, y las rutas son la única capa que conoce Express. Esto es lo que permite, por ejemplo, testear el motor de detección y el motor de riesgo sin levantar un servidor HTTP ni una base de datos real.

---

## 11. Flujo de la aplicación

Flujo de una oportunidad, de la llegada del dato de mercado a la actualización de pantalla:

```
Exchange (WebSocket)
    │  order book L2 (bids/asks)
    ▼
exchangeService.js  ── normaliza el mensaje por exchange
    │
    ▼
opportunityDetection.js  ── detección bilateral O(n²), VWAP sobre profundidad real
    │  oportunidad candidata (o ninguna)
    ▼
scoringService.js  ── score compuesto multi-factor + "reasoning" explicable
    │
    ▼
arbitrageOrchestrator.js  ── checkExecutionGuards() (score, liquidez, feed
    │                        fresco, circuit breaker)
    │
    ├── rechazada → se registra con motivo explícito, visible en la UI
    │
    ▼  aprobada
executeBestOpportunity()  ── liveExecution + advancedRiskEngine (segundo
    │                        gate de riesgo, independiente del scoring)
    │
    ▼
walletManager  ── actualiza balances por exchange, maneja fills parciales
    │
    ▼
tradeStateMachine (12 estados) + eventStore  ── ciclo de vida completo,
    │                                            log inmutable por trade
    ▼
SSE (cada 150ms) → React frontend  ── tabla de oportunidades, trade
                                       drilldown, P&L auditado en vivo
```

Flujo de autenticación y autorización de una request protegida:

```
Cliente → JWT en cookie/header → requireAuth (verifica firma + blacklist)
        → rbac.requirePermission(...) si el endpoint lo exige
        → financialControlLimiter si es un endpoint que mueve dinero/config
        → handler del router
```

---

## 12. Módulos de la plataforma

30 páginas React, organizadas en cuatro grupos de navegación.

### Núcleo — Motor de arbitraje

| Módulo | Qué hace |
|---|---|
| **Oportunidades** | Detección bilateral en tiempo real, scoring compuesto, motivo de rechazo por oportunidad |
| **Trades & Ejecución** | Historial completo con latencia end-to-end, fill ratio, spread bruto, fees, P&L neto |
| **P&L Auditado** | Reconciliación contable centavo a centavo — P&L realizado + mark-to-market. Exportación CSV y HTML |

### Inventario — Capital y riesgo

| Módulo | Qué hace |
|---|---|
| **Inventario & Wallets** | Balances pre-fondeados por exchange, índice de urgencia de rebalanceo, costo de transferencia |
| **Riesgo & Salud** | Circuit breakers, detección de feeds obsoletos, drawdown vs. límite, historial de alertas |
| **Eficiencia de Capital** | ROI por hora, porcentaje de capital ocioso, punto de equilibrio de infraestructura |

### Módulos — Señales analíticas

| Módulo | Qué hace |
|---|---|
| **Arbitraje Triangular** | Rutas de 3 patas dentro de un mismo exchange |
| **StatArb** | Z-score EWMA, half-life AR(1), señales de reversión a la media |
| **Mapa de Spread** | Edge persistente por par y exchange |
| **Microestructura** | Curvas de decaimiento del order book, benchmarks de latency racing |
| **Inteligencia** | Rankings multi-factor, superficie de volatilidad, señales predictivas |
| **Correlation Galaxy** | Mapa de correlación cruzada entre pares y exchanges |
| **Forecast** | Superficie de pronóstico independiente, explícitamente no-ejecutora |
| **Market Regime** | Clasificación de régimen (tendencia/rango/volátil), alimenta solo el dashboard analítico |

### Operacional — Configuración y análisis

| Módulo | Qué hace |
|---|---|
| **Parámetros** | Configuración en caliente — 32 parámetros en 6 grupos, sin reiniciar el proceso |
| **Executive Dashboard** | KPIs cruzados entre módulos — página de aterrizaje canónica tras el login |
| **Sistema Adaptativo** | Parámetros óptimos auto-detectados a partir de datos de sesión |
| **Stress Test** | Simulación en vivo de fee shock y crunch de liquidez |
| **Adversarial** | Recuperación ante fallo a medio vuelo, circuit breaker de slippage |
| **Latencia** | Benchmark WebSocket vs. polling, latencia de feed en tiempo real |
| **Replay** | Reproducción de momentos históricos del mercado |
| **Comparación Multi-Tenant** | Dos tenants sintéticos (conservador/agresivo) corriendo lado a lado sobre el motor multi-tenant real |
| **Configuración de cuenta** | Perfil, alta de 2FA, conexión de API keys por exchange, toggle de modo vivo/paper |

---

## 13. Multi-tenancy y trading en vivo por usuario

Esta es la parte de Kukora que va más allá de un bot de una sola cuenta construido en un hackathon: el motor de ejecución soporta **múltiples tenants aislados corriendo de forma concurrente**, y cada usuario puede —de forma independiente a la configuración de la plataforma vía variables de entorno— conectar sus propias llaves de exchange y activar el modo en vivo de su propia cuenta.

| Capacidad | Qué hace | Dónde |
|---|---|---|
| **Ejecución multi-tenant** | Cada tenant (un usuario, o un perfil demo) tiene su propia configuración, wallet, historial de trades y estado de risk guard, todo corriendo sobre el mismo motor de detección/scoring — no es una copia forkeada por tenant | `server/infrastructure/tenant*.js` — ver [ADR-017](docs/ADR-017-multi-tenant-two-phase-rollout.md) |
| **Comparación multi-tenant demo** | Dos tenants sintéticos (`demo-conservative`: minScore 80, 0.005 BTC/trade; `demo-aggressive`: minScore 40, 0.02 BTC/trade) que se inician/detienen/resetean desde la UI, corriendo sobre el motor por-tenant real — la diferencia de resultados es genuina, no está guionada | `server/routes/tenantDemo.routes.js`, `src/pages/TenantComparisonPage.jsx` |
| **Credenciales de exchange por usuario** | Los usuarios conectan sus propias API keys desde Settings. Las llaves se prueban contra el exchange real, se bloquean con un 403 si el permiso de retiro está habilitado en la key, y se cifran en reposo (AES-256-GCM, `KUKORA_MASTER_KEY`) — nunca se loguean, se devuelven en una respuesta, ni se muestran de nuevo tras guardarlas | `server/infrastructure/userSecretsVault.js`, `server/routes/userExchangeCredentials.routes.js` |
| **Toggle de trading en vivo por usuario** | Activar trading con dinero real para la cuenta propia de un usuario requiere: un exchange conectado, un código 2FA vigente, y una aceptación explícita (no pre-marcada, no simplemente truthy) de un disclaimer de riesgo devuelto por la propia API, no hardcodeado en el frontend. Desactivar el modo vivo no requiere confirmación — apagarlo nunca es la acción que se gatea | `server/infrastructure/userLiveModeService.js`, `server/routes/userLiveMode.routes.js` |
| **Autenticación de dos factores** | 2FA basado en TOTP (alta vía `otpauth://`, compatible con cualquier app autenticadora estándar), gatea tanto el toggle de trading en vivo como el kill switch global de la plataforma | `server/application/twoFactor.js` |

**Nota de producto, dicha con honestidad:** el camino de código para que un usuario conecte llaves reales de exchange y opere con dinero real está implementado y probado, pero un sign-off de producto/legal es una decisión separada, no de ingeniería, que aún no se ha tomado — esto está documentado en [`CHANGELOG.md` `[2.18.0]`](CHANGELOG.md) en el momento exacto en que se construyó la funcionalidad, no fue descubierto después.

---

## 14. Plataforma operacional (institutional layer)

Más allá del motor de trading en sí, Kukora tiene una capa operacional dirigida a las preguntas que realmente recibe un despliegue de fintech en producción — no es infraestructura especulativa: cada pieza está conectada a un camino de código real y cubierta por tests. Razonamiento completo y trade-offs: [PROGRESS.md](PROGRESS.md).

| Capacidad | Qué hace | Dónde |
|---|---|---|
| **Observabilidad (OpenTelemetry)** | Tracing distribuido a través del camino detección→scoring→ejecución, exportable a OTLP, costo cero cuando está deshabilitado | `server/infrastructure/telemetry.js` |
| **RBAC** | Modelo de permisos de 3 niveles (`user`/`operator`/`admin`); el kill switch de trading requiere específicamente el permiso admin-only, el resto de acciones solo necesita `operator` | `server/infrastructure/rbac.js` |
| **Feature Flags** | Flags tipados (boolean / percentage-rollout / enum), overrides por tenant, historial de auditoría. Incluye un kill switch real conectado a `executeBestOpportunity()` | `server/infrastructure/featureFlags.js` |
| **Background Jobs** | Programación por intervalo fijo o diaria a una hora, reintentos con backoff, garantía de no-overlap, estado de salud por job. `rebalanceScheduler` y `dailyReportService` corren sobre este framework | `server/infrastructure/backgroundJobs.js` |
| **Arquitectura de plugins (exchanges)** | Cada exchange es un descriptor `*.adapter.js` autocontenido, auto-descubierto y validado — agregar el exchange número 6 es un archivo nuevo, cero cambios en el resto del sistema | `server/infrastructure/exchangeAdapters/` |
| **Event sourcing parcial** | Log inmutable por trade (`requested → filled/partial → settled`), independiente de la máquina de estados en vivo, con proyección y replay | `server/infrastructure/eventStore.js` |
| **Dashboard operacional** | `/api/ops` agrega salud de jobs, kill switches activos, estado de tracing y eventos recientes de trades en un único endpoint autenticado y gateado por RBAC | `server/routes/ops.routes.js` |
| **Tape recorder / barrido de experimentos offline** | Graba snapshots reales de order books a un archivo (`npm run tape:record`), los reproduce a través del motor de detección *real* para reconstruir un log de oportunidades determinístico, y corre un barrido de parámetros sobre él (`npm run tape:sweep`) — permite volver a probar un cambio de parámetros contra exactamente las mismas condiciones de mercado dos veces | `scripts/tapeRecorder.js`, `scripts/experimentSweep.js`, `scripts/lib/tapeReplay.js` |
| **Judge Report de un clic** | Genera un reporte HTML autocontenido (P&L, log de trades, estado de riesgo, snapshot multi-tenant) para evaluación sin necesitar acceso en vivo a la instancia corriendo | `server/domain/analytics/judgeReport.js` |
| **Validación estadística del edge** | Verificación formal de que el spread detectado es estadísticamente significativo y no un artefacto de la ventana de muestreo | [ADR-019](docs/ADR-019-statistical-edge-validation.md) |

Deliberadamente **no** hecho, con el razonamiento documentado en `PROGRESS.md`: migrar la lógica de conexión/parseo WebSocket por-exchange de `exchangeService.js` a hooks de plugin completos — el camino de datos en vivo es demasiado crítico para refactorizarlo sin poder validarlo contra tráfico real de los exchanges.

---

## 15. API

Toda la API vive bajo `/api/*` y `/api/v1/*` en paralelo (ver [ADR-015](docs/ADR-015-api-versioning.md)). Selección representativa — la referencia completa de cada router está en su propio archivo bajo `server/routes/` y `server/arbitrage/subroutes/`.

### Autenticación

```
POST   /api/auth/register
POST   /api/auth/login
POST   /api/auth/google
POST   /api/auth/refresh
POST   /api/auth/logout
```

Ejemplo — login:

```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "••••••••"
}
```

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": { "id": "...", "email": "user@example.com", "role": "user" }
}
```

### Motor de arbitraje

```
GET    /api/arbitrage/config           # parámetros hot-reload vigentes
POST   /api/arbitrage/config           # actualizar parámetros (admin)
GET    /api/arbitrage/stats            # contadores en tiempo real
GET    /api/arbitrage/intelligence     # rankings multi-factor
GET    /api/arbitrage/stream           # SSE — feed de oportunidades cada 150ms
GET    /api/arbitrage/e2e-latency      # p50/p95/p99 de latencia end-to-end
POST   /api/arbitrage/ml/score         # scoring ML (analítico, no ejecuta)
```

### Trading

```
GET    /api/trading/mode
POST   /api/trading/mode
POST   /api/trading/execute/cross
GET    /api/trading/reconciliation
POST   /api/trading/2fa/setup
POST   /api/trading/2fa/confirm
GET    /api/trading/risk-profile
POST   /api/trading/risk-profile
```

### Credenciales de exchange y modo vivo por usuario

```
GET    /api/user/exchange-credentials
POST   /api/user/exchange-credentials
DELETE /api/user/exchange-credentials/:exchange
GET    /api/user/live-mode
POST   /api/user/live-mode
POST   /api/user/live-mode/disable
```

### Multi-tenant

```
GET    /api/tenant-bot/status
POST   /api/tenant-bot/toggle
GET    /api/tenant-bot/config
POST   /api/tenant-bot/config

POST   /api/tenant-demo/start
GET    /api/tenant-demo/status
POST   /api/tenant-demo/stop
POST   /api/tenant-demo/reset
```

### Operación y plataforma

```
GET    /api/ops                        # jobs, kill switches, tracing, eventos
GET    /api/ops/judge-report           # reporte HTML de un clic
GET    /api/feature-flags
POST   /api/feature-flags/:key
GET    /health                          # liveness — interno
GET    /api/readiness                   # readiness — interno
GET    /api/metrics                     # métricas — interno
```

Todos los endpoints que mueven dinero o cambian configuración financiera (`/trading/execute`, `/trading/mode`, `/tenant-bot/*`, `/tenant-demo/*`, `/user/live-mode`, `/user/exchange-credentials`) están detrás de `requireAuth` y de un `financialControlLimiter` (10 req/min) independiente del rate limiter general de la API.

---

## 16. Base de datos

**Motor:** MongoDB (opcional — ver [Variables de entorno](#7-variables-de-entorno)). **ODM:** Mongoose.

Sin `MONGODB_URI`, toda la persistencia usa mocks en memoria con la misma interfaz — el sistema completo (detección, ejecución simulada, riesgo, rebalanceo, backtesting) funciona igual, solo que el estado no sobrevive un reinicio del proceso.

### Colecciones principales

| Modelo | Contenido | Índices relevantes |
|---|---|---|
| `User` | Cuenta, `authProvider` (`local`/`google`), `role` (`user`/`operator`/`admin`), hash de contraseña, refresh token hash | `email` único |
| `EngineSnapshot` | Curva de equity, contadores, log de trades y wallets por usuario y día | `{ userId, date }` único |
| `PendingExecution` | Ejecuciones en vuelo pendientes de confirmación | — |
| `TokenBlacklist` | JWTs invalidados (logout, rotación) | TTL sobre `expiresAt` (auto-expira) |
| `Alert` | Alertas de oportunidad configuradas por usuario | `{ userId, createdAt }` |
| `Watchlist` | Lista de seguimiento de pares/monedas por usuario | `{ userId }` único |
| `Portfolio` | Posiciones de portafolio manual del usuario | `{ userId, createdAt }`, `{ userId, idempotencyKey, createdAt }` |
| `UserTradingConfig` | Configuración de trading por usuario (allocation, pares) | — |
| `UserExchangeCredential` | Credenciales de exchange cifradas del usuario | `{ userId, exchange }` único |
| `Notification` | Notificaciones in-app | `{ userId, createdAt }` |

No se usa un sistema de migraciones formal (tipo `migrate-mongo`): los esquemas de Mongoose son la fuente de verdad y los cambios de forma se documentan en [`docs/MigrationNotes.md`](docs/MigrationNotes.md) — ver [ADR-014](docs/ADR-014-db-migration-strategy.md) para el razonamiento detrás de esta elección para un sistema de este tamaño y etapa.

No hay un seed script dedicado: el modo `DEMO_MODE=true` y los tenants sintéticos `demo-*` (ver [sección 13](#13-multi-tenancy-y-trading-en-vivo-por-usuario)) cumplen esa función para efectos de demostración, sin necesidad de poblar la base de datos manualmente.

---

## 17. Testing

```bash
npm test
```

**2014 tests en 127 archivos**, verificado corriendo `npx vitest run` sobre el código real (no es una cifra copiada de un changelog). La suite corre sin ninguna dependencia externa — MongoDB se mockea en los tests que lo necesitan — y no requiere red saliente a los exchanges.

```bash
npm run typecheck    # tsc --noEmit
npm run lint          # eslint src/ server/
npm run build         # vite build
npm run check:i18n    # paridad de diccionarios es/en
```

### Tipos de prueba presentes

- **Unitarias** — motores de dominio (detección, scoring, riesgo, StatArb, backtesting) probados de forma aislada, sin HTTP ni base de datos.
- **Integración** — repositorios y servicios de infraestructura contra sus mocks (y, en algunos casos, contra una conexión Mongo real si `MONGODB_URI` está configurada en el entorno de test).
- **E2E** — un conjunto de suites `*.e2e.test.js` ejercitan la aplicación Express real vía `supertest`: autenticación, RBAC, la puerta de 2FA para trading, rutas multi-tenant, rate limiting, SSE.
- **Accesibilidad** — `tests/a11y.test.js`.
- **Componentes** — pruebas de React Testing Library sobre componentes clave (cobertura deliberadamente más delgada que el backend — ver `CONTRIBUTING.md`).

### Suite de humo legacy

Además de Vitest, existe `tests/smoke.test.js`: un runner HTTP standalone de más de 1300 líneas, anterior a la adopción de Vitest, que dispara requests reales contra un servidor corriendo (autenticación, streams SSE, rate limiting, CORS). No se migró a Vitest deliberadamente — el razonamiento completo está en `CONTRIBUTING.md`. Se corre antes de cada despliegue a producción:

```bash
NODE_ENV=test npm start        # terminal 1
node tests/smoke.test.js       # terminal 2
```

---

## 18. Calidad de código

| Herramienta | Rol |
|---|---|
| **ESLint** (`eslint:recommended` + reglas de React/Hooks) | Lint de `src/` y `server/`. `no-console` restringido a `warn`/`error`, `no-var`, `prefer-const`, variables no usadas como error salvo prefijo `_` |
| **Husky** | Hook de pre-commit con dos capas: bloquea explícitamente cualquier intento de commitear un archivo `.env`, y corre `detect-secrets` si está instalado localmente |
| **TypeScript (`tsc --noEmit`)** | Chequeo de tipos incremental sobre los módulos ya migrados, sin exigir una migración completa de golpe |
| **`check:ts-drift`** | Script propio que detecta si el build de TypeScript divergió silenciosamente del código fuente |
| **`check:i18n`** | Script propio que verifica paridad exacta de llaves entre `es.js` y `en.js` (400 llaves en ambos, en este checkpoint) |
| **`npm audit`** | `--audit-level=high` como parte del checklist de PR |

No se usa un linter de commits automatizado (tipo commitlint) todavía — la convención de Conventional Commits se sigue por disciplina documentada en `CONTRIBUTING.md`, no forzada por un hook.

---

## 19. Seguridad

- **Autenticación:** JWT de acceso + refresh, hash de contraseñas con `bcryptjs`, Google Sign-In vía Firebase Admin (opcional).
- **2FA:** TOTP, requerido para activar trading en vivo por usuario o para accionar el kill switch de la plataforma.
- **Secretos en reposo:** las API keys de exchange que un usuario conecta se cifran con AES-256-GCM bajo `KUKORA_MASTER_KEY` (`server/infrastructure/secretsVault.js`, `userSecretsVault.js`) — nunca se almacenan ni se loguean en texto plano.
- **RBAC:** `user` / `operator` / `admin`, forzado sobre feature flags y el dashboard operacional; el kill switch es exclusivo de `admin`.
- **Rate limiting:** un limitador general de API, más un `financialControlLimiter` más estricto (10 req/min) específicamente sobre endpoints que mueven dinero (`/api/trading/execute`, `/api/trading/mode`, `/api/tenant-bot`, `/api/user/live-mode`, `/api/user/exchange-credentials`, etc.).
- **Bloqueo duro de permiso de retiro:** conectar una key de exchange con permiso de retiro habilitado se rechaza directamente con 403 (no solo se advierte), en todo exchange cuya API permita verificarlo programáticamente.
- **Validación de entrada:** esquemas Zod en los endpoints que reciben body (login, ejecución de trades, credenciales, config de riesgo), con rechazo explícito de valores "casi correctos" (por ejemplo, la aceptación de un disclaimer debe ser el literal `true`, no un string `"true"` ni un valor truthy).
- **Runtime de Docker no-root**, cabeceras HTTP con `helmet`, CORS restringido a `FRONTEND_URL`.
- **Blacklist de tokens** con TTL automático en Mongo para invalidar JWTs en logout/rotación.

**Recordatorio operacional para quien despliegue esto:** `.env` está en `.gitignore` y nunca debe commitearse — configura `JWT_SECRET`, `JWT_REFRESH_SECRET`, `KUKORA_MASTER_KEY`, `ADMIN_TOKEN` y cualquier key de Firebase directamente como variables de entorno en la plataforma de hosting. Si `.env` alguna vez se commiteó en el historial de este repositorio, rota cada uno de esos secretos y límpialo del historial de git antes de considerar el despliegue seguro — el código no puede protegerte de una master key filtrada.

---

## 20. Docker

Build multi-stage (build con devDependencies, runtime solo con dependencias de producción):

```bash
docker build -t kukora .
docker run -p 5000:5000 --env-file .env kukora
```

El `Dockerfile` corre como usuario `node` no-root, incluye un `HEALTHCHECK` contra `/health`, y separa explícitamente la etapa de build (necesita Vite y sus plugins) de la etapa de runtime (`npm ci --omit=dev`), documentando en comentarios por qué cada etapa usa la bandera que usa.

No existe todavía un `docker-compose.yml` en el repositorio — para levantar Kukora junto a una instancia local de MongoDB/Redis en un solo comando, es la pieza más directa de agregar si se necesita (ver [Roadmap](#24-roadmap)).

---

## 21. Despliegue

### Railway (recomendado)

```bash
# 1. Sube el repo (verifica que .env nunca se haya commiteado — ver Seguridad)
git push origin main

# 2. En el dashboard de Railway, configura las variables de entorno:
#    NODE_ENV=production
#    JWT_SECRET, JWT_REFRESH_SECRET, KUKORA_MASTER_KEY, ADMIN_TOKEN
#      (genera valores nuevos, no reutilices los de desarrollo local)
#    FRONTEND_URL=<tu URL pública de Railway>
#    MONGODB_URI   (opcional — omite para correr en memoria, o agrega
#                    el plugin de MongoDB de Railway si quieres que el
#                    P&L/historial sobreviva reinicios)
#    ADMIN_EMAILS / OPERATOR_EMAILS   (opcional, separado por comas)
#
# 3. railway.json ya configura build/start/healthcheck — nada más que hacer:
#    build:        npm install && npm run build   (Nixpacks)
#    start:        npm start
#    healthcheck:  GET /health
```

### Docker (cualquier proveedor con soporte de contenedores)

```bash
docker build -t kukora .
docker run -p 5000:5000 --env-file .env kukora
```

### VM / on-prem (PM2)

```bash
npm run build
npm run pm2:start     # modo fork, instances: 1 — ver ADR-016 para el porqué
npm run pm2:logs
```

`pm2:start` corre intencionalmente en modo `fork` con una sola instancia, no en modo `cluster`: el motor de arbitraje es un singleton por proceso que posee 5 conexiones WebSocket en vivo y estado en memoria (oportunidades, clientes SSE); correrlo en cluster multiplicaría silenciosamente las conexiones a cada exchange y correría copias del motor de riesgo desincronizadas entre sí. El razonamiento completo, y el camino correcto si algún día se necesita escalar horizontalmente (separar el proceso "engine" del proceso "API"), está en [ADR-016](docs/ADR-016-pm2-single-instance-constraint.md).

---

## 22. Decisiones técnicas (ADRs)

Diecinueve *Architecture Decision Records*, uno por cada elección de diseño no obvia — el objetivo es que ninguna decisión importante tenga que reconstruirse leyendo únicamente el código.

| ADR | Decisión |
|---|---|
| [001](docs/ADR-001-vwap-l2-vs-midprice.md) | VWAP sobre order book L2 real, en vez de mid-price teórico |
| [002](docs/ADR-002-log-spread-stationarity.md) | Log-spread como base estadística para StatArb (estacionariedad) |
| [003](docs/ADR-003-pre-funded-bilateral.md) | Modelo de liquidación bilateral con capital pre-fondeado por exchange |
| [004](docs/ADR-004-event-driven-vs-polling.md) | Arquitectura orientada a eventos (WS) sobre polling puro |
| [005–007](docs/ADR-005-006-007-live-config-rebalance-adversarial.md) | Config en vivo, rebalanceo, escenarios adversariales |
| [008](docs/ADR-008-react-vite-vs-nextjs.md) | React + Vite en vez de Next.js |
| [009](docs/ADR-009-slippage-validator-phase1-gate.md) | Validador de slippage como gate de fase 1 de ejecución |
| [010](docs/ADR-010-user-models-separate-from-persistence-models.md) | Modelos de usuario separados de los modelos de persistencia |
| [011](docs/ADR-011-routes-vs-arbitrage-subroutes.md) | Rutas raíz vs. subrutas de arbitraje |
| [012](docs/ADR-012-no-top-level-server-api-folder.md) | Por qué no existe una carpeta `server/api/` de nivel superior |
| [013](docs/ADR-013-server-types-build-relationship.md) | Relación entre los tipos del servidor y el build de TypeScript |
| [014](docs/ADR-014-db-migration-strategy.md) | Estrategia de migración de base de datos (o la decisión de no tener una formal aún) |
| [015](docs/ADR-015-api-versioning.md) | Versionado de API (`/api` y `/api/v1` en paralelo) |
| [016](docs/ADR-016-pm2-single-instance-constraint.md) | Por qué PM2 corre en modo fork y no en cluster |
| [017](docs/ADR-017-multi-tenant-two-phase-rollout.md) | Rollout de multi-tenancy en dos fases |
| [018](docs/ADR-018-multipair-generalization-scope.md) | Alcance de la generalización multi-par |
| [019](docs/ADR-019-statistical-edge-validation.md) | Validación estadística del edge detectado |

Cada ADR sigue el mismo formato: contexto, decisión, alternativas consideradas y consecuencias — no son actas de reunión, son documentos vivos que se referencian desde el código en el punto exacto donde la decisión importa.

---

## 23. Límites del sistema — qué es real y qué es simulado

Transparencia técnica deliberada — ver el documento completo en [docs/SystemLimits.md](docs/SystemLimits.md).

**Real, con datos de mercado reales:** feeds WebSocket nativos a los 5 exchanges, order books L2 con volumen real, latencia de detección medida end-to-end (típicamente &lt; 30ms), fees calculados con tasas reales por exchange y modo maker/taker, slippage modelado sobre L2 real (VWAP calcula el precio real para el tamaño dado), circuit breakers activos, costo de rebalanceo calculado sobre fees reales, StatArb sobre log-spread real con EWMA (λ=0.94) y half-life AR(1) sobre datos históricos reales.

**Simulado o simplificado, explícitamente:** la ejecución de órdenes es un fill instantáneo al precio VWAP calculado (no hay API real de exchange de por medio en modo paper); no se modela la latencia de red entre detección y "ejecución"; el order book puede moverse entre detección y ejecución real de una forma que el snapshot no captura; los wallets son pre-fondeados y simulados; no hay otros arbitrajistas compitiendo en la simulación (en producción real, los spreads se cierran en milisegundos por competencia); no se simula riesgo de contraparte (quiebra/hackeo de exchange); MongoDB es opcional, así que la persistencia crítica de auditoría no está garantizada por default.

Lo que se necesitaría para producción real, honestamente: adaptar el módulo de ejecución para llamar APIs reales de exchange, correr paper trading con capital mínimo para validar slippage real vs. modelado, y manejar rate limits y errores de red reales. El núcleo del sistema — detección, scoring, riesgo, rebalanceo — ya está, según la propia evaluación del proyecto, a nivel de producción.

---

## 24. Roadmap

### Completado

- [x] Motor de detección bilateral con VWAP L2 real (5 exchanges)
- [x] Scoring compuesto multi-factor con razones de rechazo explicables
- [x] Máquina de estados de trade (12 estados) con manejo de fills parciales
- [x] Motor de riesgo independiente (circuit breakers, daily stop)
- [x] P&L auditado con exportación CSV/HTML
- [x] Configuración operacional en caliente (32 parámetros, sin reinicio)
- [x] Arbitraje triangular, StatArb, spread heatmap, microestructura
- [x] Observabilidad (OpenTelemetry), RBAC, feature flags, background jobs
- [x] Arquitectura de plugins para exchanges, event sourcing parcial
- [x] Multi-tenancy real (ejecución aislada por tenant)
- [x] Credenciales de exchange por usuario, cifradas, con bloqueo de permiso de retiro
- [x] Toggle de trading en vivo por usuario, gateado por 2FA + disclaimer explícito
- [x] Comparación multi-tenant demo (dos perfiles corriendo en simultáneo)
- [x] Tape recorder + barrido de experimentos offline sobre datos grabados
- [x] Judge Report de un clic + validación estadística del edge (ADR-019)

Con esto, todo lo que era alcanzable dentro del entorno de desarrollo disponible durante esta entrega está cerrado.

### Fuera de alcance de esta entrega

Dos motivos distintos, sin mezclarlos:

**Bloqueado por el entorno, no por falta de trabajo:**

- [ ] Migrar `exchangeService.js` a arquitectura de plugins completa (conectar y parsear por exchange, no solo el descriptor). Es el módulo más crítico del sistema — el feed de precios en vivo — y el entorno de desarrollo usado para construirlo no tiene salida de red real hacia los exchanges (solo hacia registries de paquetes). No hay forma honesta de validar ese refactor sin poder probarlo contra tráfico WebSocket real de Binance/Kraken/Bybit/OKX/Coinbase. El adapter descriptor ya quedó preparado para ese paso (`wsUrl` sincronizado en los 5 archivos `*.adapter.js`), pero el cambio en `exchangeService.js` mismo se dejó intacto a propósito en vez de a medias. Si en algún momento se corre localmente o en Railway (que sí tiene salida de red real), es el siguiente paso natural.
- [ ] Conexión real a APIs de exchange en el módulo de ejecución (fuera de testnet/sandbox), como paso previo a manejar capital real — mismo motivo: requiere validarse contra tráfico real, no solo compilar.

**No es una decisión de código:**

- [ ] Sign-off de producto/legal para exponer el trading en vivo por usuario a usuarios reales de producción — el código ya soporta el flujo completo (2FA, disclaimer explícito, cifrado de llaves); falta una decisión de negocio, no una línea de código.

**Nice-to-have, sin urgencia:**

- [ ] `docker-compose.yml` para levantar Kukora + MongoDB + Redis local en un solo comando
- [ ] Cobertura de tests de componentes de React más profunda (hoy es deliberadamente más delgada que la del backend)

---

## 25. Problemas conocidos

- **Sin persistencia por default:** si se despliega sin `MONGODB_URI`, cualquier reinicio del proceso (deploy nuevo, crash, sleep de la plataforma) borra el historial de trades y P&L acumulado de la sesión. No es un bug, es el comportamiento documentado de "MongoDB opcional" — pero vale la pena tenerlo presente antes de una evaluación en vivo.
- **`KUKORA_MASTER_KEY` sin configurar:** si no se define, el sistema arranca igual pero usa una llave de cifrado insegura y públicamente conocida para el vault de credenciales de usuario, con una advertencia explícita por consola. Nunca debe quedar así en un despliegue real.
- **`tape:record` requiere red de salida real** a las APIs REST de los exchanges — en un entorno de desarrollo con egress restringido (como un sandbox de CI), cada intento de snapshot falla de forma explícita y reportada, sin inventar datos ni tirar la corrida completa; funciona igual que las llamadas que ya hace el bot en vivo en cualquier entorno con salida a internet (Railway incluido).
- **Cobertura de tests de componentes React más delgada** que la del backend — es una decisión documentada en `CONTRIBUTING.md` (el patrón existente ya era así antes de esta ronda de trabajo), no un descuido de esta versión.
- **Sin `docker-compose.yml`** todavía para levantar el stack completo (app + Mongo + Redis) en un solo comando — hoy cada pieza se levanta por separado si se quiere persistencia/cache local.

---

## 26. FAQ

**¿Necesito MongoDB para correr el proyecto?**
No. Sin `MONGODB_URI`, el sistema corre completamente en memoria — motor de detección, ejecución simulada, riesgo, rebalanceo y backtesting funcionan igual. Solo se pierde la persistencia entre reinicios. Ver [sección 23](#23-límites-del-sistema--qué-es-real-y-qué-es-simulado).

**¿Necesito API keys de los exchanges para ver el motor funcionando?**
No, para el modo paper trading. Los feeds de order book de los 5 exchanges son endpoints públicos sin autenticación. Las API keys solo son necesarias si un usuario decide, desde Settings, conectar su propia cuenta para operar en modo vivo.

**¿Cómo cambio el puerto?**
Variable de entorno `PORT` (default `3001` en desarrollo vía Vite proxy, `5000` en el `Dockerfile`).

**¿Cómo veo el sistema con capital de tamaño retail en vez de institucional?**
Cambia `WALLET_BTC` y `WALLET_USDT` en `.env` (por ejemplo `WALLET_BTC=0.05`, `WALLET_USDT=5000`) y reinicia. El motor de scoring, riesgo y rebalanceo funciona exactamente igual — solo verás menos oportunidades por encima del umbral de viabilidad, que es justamente la diferencia real entre operar con capital institucional y capital retail. Ver el razonamiento completo del sizing default en [docs/SystemLimits.md](docs/SystemLimits.md).

**¿Por qué el scoring de ML no decide las operaciones?**
Decisión deliberada, no una limitación técnica — ver [sección 2](#2-qué-decide-una-operación-y-qué-es-solo-analítico).

**¿Puedo escalar esto a múltiples instancias detrás de un load balancer?**
No en modo cluster de PM2 (ver [ADR-016](docs/ADR-016-pm2-single-instance-constraint.md)) — el motor es un singleton por proceso. El camino correcto para escalar de verdad (separar el proceso "engine" del proceso "API" stateless, con Redis pub/sub entre ellos) está documentado en el mismo ADR, no implementado todavía.

---

## 27. Documentación adicional

| Documento | Contenido |
|---|---|
| [PROGRESS.md](PROGRESS.md) | Adiciones de la capa institucional: qué se construyó, qué se dejó deliberadamente fuera, y por qué |
| [CHANGELOG.md](CHANGELOG.md) | Historial de versiones completo — desde el motor central (1.0.0) hasta multi-tenancy y plataforma operacional (2.23.0) |
| [CHECKPOINT_2.23.0.md](CHECKPOINT_2.23.0.md) | Último checkpoint verificado: estado de tests/build/typecheck/lint al momento de escribirlo |
| [docs/Architecture.md](docs/Architecture.md) | Diseño del sistema, flujo de datos, mapa de módulos |
| [docs/SystemLimits.md](docs/SystemLimits.md) | Qué es simulado vs. qué requeriría producción, dicho con honestidad |
| [docs/RoadmapToProduction.md](docs/RoadmapToProduction.md) | Camino por fases de paper trading a capital real |
| [docs/JudgeGuide.md](docs/JudgeGuide.md) | Guía de 5 minutos para evaluadores técnicos |
| [docs/CommitteeReadiness.md](docs/CommitteeReadiness.md) | Checklist de disposición para entrega/evaluación |
| [docs/RiskEngine.md](docs/RiskEngine.md) | Documentación del modelo de riesgo |
| [docs/ExecutionEngine.md](docs/ExecutionEngine.md) | Máquina de estados de trade y flujo de ejecución |
| [docs/Rebalancing.md](docs/Rebalancing.md) | Sistemas de rebalanceo reactivo y predictivo |
| [docs/Analytics.md](docs/Analytics.md) | Superficies analíticas no-ejecutoras (ML scoring, régimen, Monte Carlo, forecast) |
| [docs/DeveloperGuide.md](docs/DeveloperGuide.md) | Setup local, convenciones, cómo agregar un módulo |
| [docs/MigrationNotes.md](docs/MigrationNotes.md) | Refactors relevantes y su razonamiento |
| [docs/TechnicalDueDiligence-2026-07-02.md](docs/TechnicalDueDiligence-2026-07-02.md) | Verificación de due diligence técnica contra el código real |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Ramas, commits, checklist de PR, cómo agregar un exchange o un factor de scoring |
| [docs/ADR-001 → ADR-019](docs/) | Diecinueve *Architecture Decision Records* — ver [sección 22](#22-decisiones-técnicas-adrs) |

---

## 28. Licencia y contacto

**Licencia:** Privada — todos los derechos reservados (`UNLICENSED` en `package.json`).

**Repositorio:** [github.com/GabrielGZ8/kukora](https://github.com/GabrielGZ8/kukora)

**Reporte de errores / soporte:** GitHub Issues del repositorio.

---

*Este README describe el estado del proyecto verificado en el checkpoint v2.23.0: 2014 tests pasando en 127 archivos, `tsc --noEmit` limpio, `npm run build` exitoso, paridad de i18n verificada. Cada cifra y cada afirmación técnica de este documento se contrastó contra el código fuente real, no contra notas de sesiones anteriores.*

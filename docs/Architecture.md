# Kukora v2.0 — Architecture Guide

## Overview

Kukora is a quantitative cryptocurrency arbitrage platform built on a Node.js backend
with a React frontend. The platform delivers real-time bilateral arbitrage detection across
5 exchanges with institutional-grade risk management, a full trade audit trail, and a
modular analytics suite covering regime detection, statistical arbitrage, and Monte Carlo
simulation.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (React/Vite)                   │
│  ArbitragePage · SummaryPage · RiskPage · ArbBacktestPage      │
└────────────────────────────┬────────────────────────────────────┘
                             │ SSE / REST API
┌────────────────────────────▼────────────────────────────────────┐
│                     Express API Server                           │
│         server/routes/{arbitrage,crypto}.routes.js               │
└──┬──────────────┬──────────────┬─────────────────┬─────────────┘
   │              │              │                 │
   ▼              ▼              ▼                 ▼
┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌────────────────┐
│Arbitrage │ │Exchange  │ │ Risk Engine  │ │  Observability │
│Orchestra-│ │ Service  │ │  (Advanced)  │ │   Service      │
│tor       │ │ (WS/REST)│ │              │ │                │
│(applica- │ │(infra-   │ │ drawdown     │ │ emit()         │
│tion)     │ │structure)│ │ circuitBreak │ │ recordReject   │
│executeS  │ │          │ │ exposure     │ │ recordExecQual │
└──┬───────┘ └──────────┘ └──────────────┘ └────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Trade Lifecycle (State Machine)                │
│  OPPORTUNITY_DETECTED → SCORING → APPROVED → ORDER_CREATED      │
│  → ORDER_SUBMITTED → [PARTIALLY_FILLED] → FILLED → SETTLING     │
│  → COMPLETED / FAILED / ROLLED_BACK / EMERGENCY_EXIT            │
└──────────────────────────────────────────────────────────────────┘
   │
   ├──► walletManager.js         (pre-funded bilateral balance model)
   ├──► predictiveRebalance.js   (depletion forecasting + pre-emptive capital realloc)
   ├──► rebalanceEngine.js       (reactive + predictive rebalancing)
   ├──► statArbEngine.js         (EWMA Z-score, AR(1) half-life, mean-reversion)
   └──► observabilityService.js  (structured event emission, root-cause analysis)
```

`mlScoringPipeline.js` is deliberately absent from this list — see the
honesty note under "Data Flow: Opportunity Detection" below for why.

---

## Module Map

Since the Nivel 2 #1 audit (bounded-context reorg), modules live
under `server/domain/` (pure business logic), `server/infrastructure/` (I/O,
Mongo, exchanges, JWT/session), or `server/application/` (orchestration / use
cases) rather than flat in `server/`. The old flat re-export shims
(`server/<name>.js`) that used to exist for backward compatibility were
fully removed in a later cleanup pass (see `MIGRATION_CLEANUP_LOG.md`) —
`server/` now contains only `index.js` (entry point) and `models.js` (User
schema, kept separate by design; see ADR-010). All ~200 references that
used to point at the flat shim paths were rewritten to import directly from
the paths below.

| Module                      | File                                              | Layer          | Responsibility |
|-----------------------------|----------------------------------------------------|----------------|----------------|
| Arbitrage Orchestrator      | `server/application/arbitrageOrchestrator.js`      | application    | Detection loops, unified opportunity execution, equity curve |
| Opportunity Detection       | `server/domain/engines/opportunityDetection.js`            | domain         | Bilateral/triangular detection, scoring, simulated execution |
| Exchange Service            | `server/infrastructure/exchangeService.js`         | infrastructure | WebSocket feeds, order book snapshots, VWAP |
| Advanced Risk Engine        | `server/domain/risk/advancedRiskEngine.js`              | domain         | Drawdown, circuit breakers, exposure tracking |
| Trade State Machine         | `server/domain/analytics/tradeStateMachine.js`               | domain         | 12-state FSM, partial fill management, rollback |
| Observability Service       | `server/infrastructure/observabilityService.js`    | infrastructure | Structured events, rejection log, execution quality |
| ML Scoring Pipeline         | `server/domain/engines/mlScoringPipeline.js`               | domain         | Experimental scoring surface, `POST /api/arbitrage/ml/score` only — **not** consulted by the real execution decision (see Data Flow honesty note below) |
| StatArb Engine              | `server/domain/engines/statArbEngine.js`                   | domain         | EWMA Z-score, AR(1), cointegration signals |
| Predictive Rebalancer       | `server/domain/engines/predictiveRebalance.js`             | domain         | Wallet depletion forecast, pre-emptive realloc |
| Wallet Manager              | `server/domain/wallet/walletManager.js`                   | domain         | Pre-funded bilateral balances, trade settlement |
| Live Config                 | `server/infrastructure/liveConfig.js`              | infrastructure | Hot-reloadable parameters without process restart |
| Watchdog                    | `server/infrastructure/watchdog.js`                | infrastructure | System health monitoring, auto-recovery |
| Spread Heatmap              | `server/infrastructure/spreadHeatmapService.js`    | infrastructure | Persistent edge tracking by pair and exchange |
| Fill Probability Engine     | `server/domain/engines/fillProbabilityEngine.js`           | domain         | Order fill likelihood based on depth/latency |
| Replay Service              | `server/infrastructure/replayService.js`           | infrastructure | Historical moment capture and replay |
| Execution Journal           | `server/domain/analytics/executionJournal.js`                | domain         | Per-trade audit log with 4-phase attribution |
| Audited P&L                 | `server/domain/wallet/auditedPnl.js`                      | domain         | Cent-accurate reconciliation, CSV/HTML export |
| Backtest Service            | `server/domain/backtestService.js`                 | domain         | Facade: arb sweep, strategy sim, institutional metrics |
| Anomaly Engine              | `server/domain/anomalyEngine.js`                   | domain         | Statistical detection + adversarial scenario runner |
| Auth                        | `server/infrastructure/auth.js`                    | infrastructure | JWT/session issuance, bcrypt, Firebase Sign-In bridge |
| Slippage Validator          | `server/domain/risk/slippageValidator.js`               | domain         | Fase 1: modeled-vs-real slippage divergence tracking |
| Arbitrage State             | `server/application/arbitrage.state.js`            | application    | Shared mutable bot state (equity curve, fingerprints, counters) |
| Live Execution              | `server/application/liveExecution.js`              | application    | Live (non-simulated) trade execution mode — Binance, Bybit, Kraken (mainnet + sandbox/testnet where the exchange offers one) (Fase 2) |

---

## Data Flow: Opportunity Detection

```
Exchange WebSocket feeds
        │
        ▼
   exchangeService.js          ← L2 order books, VWAP computation        [infrastructure]
        │
        ▼
   opportunityDetection.js     ← O(n²) bilateral detection, deterministic multi-component
        │                        scoring (`scoreOpportunityDetailed()` — profit × liquidity ×
        │                        persistence × latency × confidence). THIS is the score the
        │                        UI shows and the score `arbitrageOrchestrator.js` gates
        │                        execution on. See the honesty comment at
        │                        `opportunityDetection.js` lines ~197-210.
        ▼
   arbitrageOrchestrator.js    ← detection loops, unified execution      [application]
        │
        ▼
   advancedRiskEngine.js       ← Pre-trade checks: drawdown, exposure, circuit breakers  [domain]
        │
        ▼
   tradeStateMachine.js        ← Create trade record, advance through states  [domain]
        │
        ├──► walletManager.js         ← Apply settlement, update balances       [domain]
        ├──► observabilityService.js  ← Emit structured event                   [infrastructure]
        ├──► executionJournal.js      ← Record execution audit                  [domain]
        ├──► slippageValidator.js     ← Record modeled-vs-real divergence       [domain]
        └──► alertWebhookService.js   ← Trigger user alerts                     [infrastructure]
```

**Nota de honestidad de arquitectura (roadmap ítem #8, auditoría de comité
julio 2026):** `mlScoringPipeline.js` y `marketRegimeEngine` **no aparecen
en el diagrama de arriba a propósito** — no participan en la decisión de
ejecución real. `mlScoringPipeline.js` es una superficie experimental
aparte, expuesta solo vía `POST /api/arbitrage/ml/score` (ver
`server/arbitrage/subroutes/query.routes.js`), con su propio set de pesos
independiente del scoring real; no alimenta la tabla de oportunidades ni
el gate de riesgo. `marketRegimeEngine` alimenta únicamente su propia
vista analítica (`RiskPage`/`MarketRegimePage`) y no es consultado por
`arbitrageOrchestrator.js` ni por `opportunityDetection.js`. Un diagrama
anterior de este documento las mostraba en el camino de decisión — era
inexacto y quedó corregido en esta sesión. Igual honestidad que ya
practica el código: ver el comentario en `opportunityDetection.js`
(líneas ~197-210) que declara explícitamente cuál función es la "fuente
de verdad" del score. Monte Carlo, Correlation Galaxy y Forecast son, por
el mismo motivo, superficies analíticas paralelas — ninguna es un insumo
del motor de ejecución.

All paths above are relative to `server/<layer>/`; see the Module Map for
the full path of each. The old flat `server/<name>.js` shim paths were
removed entirely in a later cleanup pass (see `MIGRATION_CLEANUP_LOG.md`) —
they no longer exist, and every caller now imports directly from the
canonical path.

---

## Key Design Decisions

See `docs/ADR-*.md` for full rationale on each decision.

| ADR     | Decision |
|---------|----------|
| ADR-001 | VWAP L2 depth for fill modeling instead of theoretical mid-price |
| ADR-002 | Log-spread for stationarity properties in StatArb engine |
| ADR-003 | Pre-funded bilateral settlement eliminates counterparty risk |
| ADR-004 | Dual-path detection: WebSocket events + 150ms polling fallback |
| ADR-005 | Hot-reloadable live configuration via `liveConfig.js` |
| ADR-006 | Predictive vs reactive rebalancing — depletion forecasting |
| ADR-007 | Adversarial scenario suite for resilience testing |
| ADR-008 | React + Vite over Next.js for the frontend |
| ADR-009 | SlippageValidator as the Phase 1 production gate |
| ADR-010 | `server/models.js` (User) kept separate from `infrastructure/persistence/models/` (operational models) |
| ADR-011 | `server/routes/` (per-feature wiring) vs `server/arbitrage/subroutes/` (internal split of one oversized feature) |
| ADR-012 | No top-level `server/api/` wrapper folder — `server/routes/` already fills that role |

---

## Path to Production (Fase 1 / Fase 2 / Fase 3)

See `docs/RoadmapToProduction.md` for the full plan. Summary of what's code-complete
today vs. what still requires real elapsed time in live markets:

| Fase | Objective | Code status | Still needed |
|------|-----------|--------------|---------------|
| Fase 1 — Paper Trading | Validate modeled slippage ≈ real slippage | ✅ Tooling complete: live WS feeds (`exchangeService.js`), `slippageValidator.js`, `executionJournal.js`, hot-reload calibration | 1–2 months of live paper-trading data collection (real time, not code) |
| Fase 2 — Shadow Mode | Execute real orders against sandbox/testnet accounts | ✅ `liveExecution.js` implements Binance, Bybit, and Kraken clients behind a common interface, selected generically via `getExchangeClient()`. `BINANCE_TESTNET`/`BYBIT_TESTNET=true` route to official testnets with zero real-capital risk; Kraken has no official Spot sandbox, so `KRAKEN_SANDBOX=true` only activates once `KRAKEN_SANDBOX_URL` points at a mock (otherwise it refuses to run rather than risking real funds) | 30 days of shadow-mode operation against Binance/Bybit testnet to hit the Sharpe > 1.5 success criterion (real elapsed time, not code) |
| Fase 3 — Small real capital | Real dual-leg cross-exchange execution with real (small) money | ✅ `executeCrossExchangeLive()` places both legs concurrently across `opportunity.buyExchange`/`sellExchange`, with automatic single-leg flatten (`CLOSE_NOW`) on partial fills — see `tests/liveExecutionCrossExchange.test.js` | HTTP route exposure (currently unreachable outside tests — deliberately, pending a security review of the mode-switch/execute endpoints), rate-limit management per exchange, live Telegram/Slack alerting, cross-exchange inventory reconciliation |

---

## Deployment

- **Docker**: two-stage build (builder + runtime), Alpine-based, `HEALTHCHECK` via `/health`
- **Railway**: `railway.json` for one-command deployment (single source of truth — Railway ignores `railway.toml` when both are present, so the redundant `.toml` was removed to avoid config drift)
- **Environment**: see `.env.example` for all configurable parameters
- **CI**: GitHub Actions (`.github/workflows/ci.yml`) — `npm ci` → `npm audit` (production deps, high+ blocking) → `vitest run --coverage` (enforces the thresholds in `vitest.config.js`) → `vite build` → smoke tests → `tsc --noEmit`, on every push/PR to `main`

---

## Performance Targets

| Metric                   | Target       | Measured |
|--------------------------|--------------|----------|
| Feed latency             | < 5ms        | ✓ |
| Opportunity detection    | < 30ms       | ✓ |
| API response (P50)       | < 20ms       | ✓ |
| SSE push cycle           | 150ms        | ✓ |
| Memory footprint (RSS)   | < 256MB      | ✓ |

/**
 * liveConfig.js — Kukora v17
 *
 * Full hot-reloadable configuration framework.
 * All parameters are validated, versioned, and auditable.
 * No application restart required for any parameter change.
 *
 * Architecture:
 *   - Single _cfg object centralizes all mutable parameters
 *   - Modules call get(key) on each cycle — never cache the value
 *   - POST /api/arbitrage/config calls setMany(patch) and records to _history
 *   - History persists in memory (last 100 changes) — visible in UI
 *   - Every change emits a structured event for observability
 *
 * Parameter groups:
 *   EXECUTION   — slippage, latency, order lifecycle, retry
 *   RISK        — loss limits, drawdown, circuit breakers, exposure
 *   CAPITAL     — allocation, reserve, per-trade sizing
 *   SCORING     — weights for the composite scoring pipeline
 *   REBALANCING — thresholds, prediction windows, transfer limits
 */

'use strict';

const EventEmitter = require('events');
const configEvents = new EventEmitter();

// I-2 fix: ALL_EXCHANGES derived from the exchange registry — single source of truth.
// Adding a 6th exchange requires only a registerExchange() call in exchangeRegistry.js.
// Previously this was a hardcoded array that diverged from the registry silently.
const { getEnabledExchangeNames } = require('./exchangeRegistry');
const ALL_EXCHANGES = getEnabledExchangeNames();

const _defaults = {
  // Core trading
  minScore:             10,
  tradeAmountBTC:       parseFloat(process.env.TRADE_AMOUNT_BTC   || '0.05'),
  feeMode:              process.env.FORCE_MAKER_FEES === 'true' ? 'maker' : 'taker',
  minSpreadPct:         process.env.FORCE_MAKER_FEES === 'true' ? 0.001 : 0.005,
  maxDailyLossUSD:      -500,
  cooldownMs:           300,
  minTriangularNetPct:  0.05,
  // Item 4 (refinamiento post-checkpoint-02): Multi-Hop (Bellman-Ford,
  // N-hop cycles — ver multiHopArbitrageEngine.js) es una estrategia
  // AVANZADA, apagada por defecto. Con multiHopEnabled=false el
  // comportamiento es idéntico al de antes (multiHopSignal se calcula y se
  // expone en el SSE, pero nunca se ejecuta). Con multiHopEnabled=true,
  // arbitrageOrchestrator también intenta ejecutar el mejor ciclo
  // detectado, con el mismo mecanismo/cooldown/circuit-breakers que
  // triangular. Ver nota de impacto (latencia/CPU/APIs) junto al bloque de
  // ejecución en arbitrageOrchestrator.js.
  multiHopEnabled:      false,
  minMultiHopNetPct:    0.05,
  activeExchanges:      [...ALL_EXCHANGES],
  minNetProfitUSD:      process.env.FORCE_MAKER_FEES === 'true' ? 0.30 : 0.05,
  maxSpreadPct:         3.0,

  // Execution parameters (Section 1)
  maxSlippagePct:         0.15,
  maxExecutionLatencyMs:  2000,
  orderTimeoutMs:         5000,
  allowPartialFills:      true,
  minimumFillRatio:       0.50,
  // Upper tier boundary for the 3-tier partial-fill decision (Fase 1
  // committee answer, now actually implemented — see
  // tradeStateMachine.classifyFillTier / evaluatePartialFill):
  //   fillRatio >= highFillRatioThreshold        → tier 'high': accept as-is
  //   minimumFillRatio <= fillRatio < high        → tier 'mid':  complete residual with an immediate market order
  //   fillRatio < minimumFillRatio                → tier 'low':  abandon residual, close executed leg now (controlled loss)
  highFillRatioThreshold: 0.80,
  maxOrderRetries:        3,
  retryBackoffMs:         500,
  exchangeCooldownMs:     1000,

  // Smart Order Router policy (Fase 1 "Smart Execution Engine" answer —
  // decide IOC / Post-Only / Market, not just market-only). See
  // server/domain/engines/smartOrderRouter.js for the full decision logic.
  //   'market_taker'    — plain market order, no price protection (prior behavior).
  //   'ioc_protected'   — immediate-or-cancel limit at a maxSlippagePct-protected price.
  //   'post_only_maker' — resting maker order (non-urgent legs only).
  orderExecutionPolicy:   'market_taker',

  // Risk parameters (Section 1)
  maxDrawdownPct:           10.0,
  maxExposurePerExchange:   0.40,
  maxExposurePerAsset:      0.60,
  maxPositionValueUSD:      10000,
  maxConsecutiveFailures:   5,
  emergencyStopThreshold:   -1000,

  // Capital parameters (Section 1)
  capitalAllocationMode:  'equal',
  reserveCapitalPct:      0.10,
  maxCapitalPerTrade:     0.05,
  capitalPerStrategy: {
    cross_exchange: 0.60,
    triangular:     0.20,
    stat_arb:       0.15,
    funding_rate:   0.05,
  },
  capitalPerExchange: {
    Binance:  0.25,
    Kraken:   0.20,
    Bybit:    0.20,
    OKX:      0.20,
    Coinbase: 0.15,
  },

  // Scoring weights (Section 1)
  scoringWeights: {
    liquidity:   0.20,
    spread:      0.25,
    volatility:  0.10,
    execution:   0.20,
    reliability: 0.15,
    latency:     0.10,
  },

  // Rebalancing parameters (Section 1)
  rebalanceThresholdPct:     0.70,
  rebalancePredictionWindow: 3600,
  rebalanceCostLimit:        50,
  minimumTransferAmount:     100,
  // Alert threshold for cumulative rebalance cost as a % of period profit
  // (see capitalEfficiency.getRebalanceCostRatio). Committee answer (Fase 1):
  // "monitoreo el costo acumulado de rebalanceo como % de las ganancias del
  // período, y si supera 15-20% es señal de alerta" — 18 sits mid-band.
  rebalanceCostAlertPct:     18,
  // Automatización del disparo de rebalanceo (refinamiento post-Sesión 34,
  // Área 3 — "gestión de wallets y rebalanceo"). ANTES: executeRebalance()
  // solo era alcanzable desde POST /rebalance/execute — un operador tenía
  // que notar manualmente el desbalance y disparar la transferencia él
  // mismo. Off by default (autoRebalanceEnabled: false): mover fondos
  // reales entre exchanges es una acción con consecuencias (fees de retiro,
  // ventanas de iliquidez temporal) que no debería activarse sola sin que
  // un operador la habilite explícitamente.
  autoRebalanceEnabled:      false,
  autoRebalanceCooldownMs:   30 * 60 * 1000, // 30 min entre auto-ejecuciones
  autoRebalanceMinSeverity:  'high', // 'high' | 'medium' — analyzeBalance() severity floor to act on

  // Strategy-core parameters (Section 2 audit — previously hardcoded module
  // constants in opportunityDetection.js / statArbEngine.js, invisible to
  // liveConfig and un-hot-reloadable). Values match the prior hardcoded
  // defaults exactly, so this is a pure parametrization change with no
  // behavior shift until someone actually adjusts them from the UI.
  liquidityMinFillPct:       0.50,   // checkLiquidity(): min fraction of book depth required
  detailedScoreWeights: {
    profit:      35,
    liquidity:   20,
    persistence: 15,
    latency:     15,
    confidence:  10,
  },
  statArbWindowSize:         120,    // rolling log-spread window (periods)
  statArbEwmaLambda:         0.94,   // EWMA decay factor (RiskMetrics standard)
  statArbZThreshold:         2.0,    // |Z| above this = signal
  statArbZStrong:            2.5,    // |Z| above this = high-confidence signal
  statArbMinSamples:         30,     // min samples before Z-score is trusted
  statArbMaxHalfLife:        200,    // half-life (periods) above which pair is "trending", not mean-reverting

  // Volatility filter (v14 addition)
  // Halt new trades when realized BTC volatility (1h rolling) exceeds this threshold.
  // High-volatility regimes invalidate spread assumptions — spreads widen faster
  // than the engine can react, increasing slippage risk. Set to null to disable.
  maxVolatilityPct:         null,   // % — null = disabled, e.g. 3.0 = halt above 3% 1h vol

  // Dynamic thresholds — regime-aware spread adjustment (v14 addition)
  // In crisis regimes (see marketRegimeEngine.js), raise minNetProfitUSD automatically
  // to compensate for wider spreads and higher slippage risk.
  regimeAwareThresholds:    false,  // boolean — when true, uses regime to scale minScore

  // Weekly and profit stops (v14 addition)
  maxWeeklyLossUSD:         -2000,  // Halt for the week if accumulated loss exceeds this
  weeklyProfitTargetUSD:    null,   // null = no target; positive USD = auto-pause on hit
  dailyProfitTargetUSD:     null,   // null = no target; positive USD = auto-pause on hit

  // Item 2 (refinamiento post-checkpoint-04): constantes de motor que vivían
  // como módulo-level const en 8 archivos distintos, invisibles a liveConfig
  // y sin poder ajustarse sin tocar código. Todos los valores por-default
  // son idénticos a las constantes que reemplazan — parametrización pura,
  // cero cambio de comportamiento hasta que alguien los ajuste desde la API.
  slippageDivergenceThresholdPct: 0.25,   // slippageValidator: Phase 1 production gate
  adaptiveScoringRecalcIntervalMs: 30_000, // adaptiveScoring: min time between recalculations
  momentumPredictMs:        500,          // spreadMomentumEngine: prediction window
  postOnlyOffsetPct:        0.0005,       // smartOrderRouter: post-only limit offset from mid
  circuitBreakerResetMs:    5 * 60 * 1000, // advancedRiskEngine: circuit-breaker auto-reset delay
  opportunityExpiryTtlMs:   2000,         // opportunityLifecycle: TTL before an unseen op expires
  directionalBiasThreshold: 0.7,          // directionalBiasTracker: |bias| >= this = "consistent"
  latencyRacingWindowMs:    400,          // latencyRacing: round window for correlated updates
  latencyRacingMinPriceChangePct: 0.005,  // latencyRacing: ignore micro-noise below this %

  // Simulation / paper / live mode flags (v14 — surfaced from env as live config)
  // These cannot be changed at runtime without security implications.
  // They are read-only from the API — only LIVE_TRADING_ENABLED env changes live mode.
  // Exposed here for observability (UI can show current mode).
  tradingMode:              process.env.LIVE_TRADING_ENABLED === 'true' ? 'live'
                            : process.env.DEMO_MODE === 'true' ? 'demo'
                            : 'paper',

  // ── ADR-019: Multi-Factor Decision Engine (Hallazgo 5) ──────────────────
  // Each signal below has its own on/off switch and defaults to ON with a
  // conservative starting threshold (see ADR-019 "Open questions" — not
  // empirically fit yet, safe to tune from real data as it accumulates).
  // Setting an *Enabled flag to false reproduces exact pre-ADR-019 behavior
  // for that signal — no code path removed, only bypassed.

  // §1 Fill Probability — execution gate (selectBestOpportunity)
  fillProbabilityGateEnabled: true,
  minFillProbability:         40,   // 0-100; op.fillProbability below this → not viable

  // §2 Liquidity Prediction — position-size factor (adaptivePositionSizing), ≤1.0x only
  liquidityFactorEnabled:     true,
  minLiquidityConfidence:     0.3,  // below this, prediction is untrusted → neutral 1.0x

  // §3 Exchange Intelligence — extends the existing feed-health reliability
  // penalty (exchangeReliabilityDynamic.getDynamicPenalty) with a real
  // execution-outcome penalty (exchangeIntelligence success/failure history).
  // Combined via Math.max (worst-of), never summed — see ADR-019 Part A §1.
  executionPenaltyEnabled:    true,
  minExecutionSamples:        10,   // below this many trades on an exchange, penalty = 0

  // §5 Execution Quality / Slippage — same Math.max reliability penalty,
  // fed by realized slippage bias instead of success/fail (self-healing:
  // rolling window ages out old records automatically, no manual reset).
  slippagePenaltyEnabled:     true,

  // §4 Market Regime — periodic (not per-tick) defensive threshold shift.
  // All multipliers are <= 1.0 for size and >= 1.0 for minScore — tightens
  // or holds, never loosens beyond baseline. Setting every entry to 1.0 is
  // equivalent to marketRegimeEnabled: false.
  marketRegimeEnabled:        true,
  marketRegimeRefreshMs:      60_000,
  marketRegimeScoreMultipliers: {
    LIQUIDITY_COMPRESSION: 1.10,
    BULLISH_EXPANSION:     1.00,
    BEARISH_CONTRACTION:   1.00,
    DISTRIBUTION:          1.05,
    ACCUMULATION:          1.00,
    VOLATILE_UNCERTAINTY:  1.15,
  },
  marketRegimeSizeMultipliers: {
    LIQUIDITY_COMPRESSION: 1.00,
    BULLISH_EXPANSION:     1.00,
    BEARISH_CONTRACTION:   0.75,
    DISTRIBUTION:          1.00,
    ACCUMULATION:          1.00,
    VOLATILE_UNCERTAINTY:  0.60,
  },

  // Part C: recovery classification layer ahead of _emergencyFlatten
  // (Hallazgo 7). false = skip classification, call _emergencyFlatten
  // directly (today's exact behavior, zero added code in the hot path).
  recoveryClassificationEnabled: true,
};

const _validators = {
  minScore:            v => ({ ok: typeof v === 'number' && v >= 0 && v <= 100, val: Math.max(0, Math.min(100, Number(v))) }),
  tradeAmountBTC:      v => ({ ok: typeof v === 'number' && v >= 0.001 && v <= 0.5, val: Math.max(0.001, Math.min(0.5, Number(v))) }),
  feeMode:             v => ({ ok: v === 'taker' || v === 'maker', val: v }),
  minSpreadPct:        v => ({ ok: typeof v === 'number' && v >= 0.0001 && v <= 5, val: Math.max(0.0001, Math.min(5, Number(v))) }),
  maxDailyLossUSD:     v => ({ ok: typeof v === 'number' && v <= 0 && v >= -100000, val: Math.min(0, Math.max(-100000, Number(v))) }),
  cooldownMs:          v => ({ ok: typeof v === 'number' && v >= 50 && v <= 30000, val: Math.max(50, Math.min(30000, Number(v))) }),
  minTriangularNetPct: v => ({ ok: typeof v === 'number' && v >= 0.001 && v <= 2, val: Math.max(0.001, Math.min(2, Number(v))) }),
  multiHopEnabled:     v => ({ ok: typeof v === 'boolean', val: Boolean(v) }),
  minMultiHopNetPct:   v => ({ ok: typeof v === 'number' && v >= 0.001 && v <= 2, val: Math.max(0.001, Math.min(2, Number(v))) }),
  activeExchanges:     v => {
    if (!Array.isArray(v)) return { ok: false };
    const valid = v.filter(e => ALL_EXCHANGES.includes(e));
    return { ok: valid.length >= 1, val: valid };
  },
  minNetProfitUSD:     v => ({ ok: typeof v === 'number' && v >= 0 && v <= 100, val: Math.max(0, Math.min(100, Number(v))) }),
  maxSpreadPct:        v => ({ ok: typeof v === 'number' && v >= 0.5 && v <= 20, val: Math.max(0.5, Math.min(20, Number(v))) }),
  maxSlippagePct:         v => ({ ok: typeof v === 'number' && v >= 0 && v <= 5, val: Math.max(0, Math.min(5, Number(v))) }),
  maxExecutionLatencyMs:  v => ({ ok: typeof v === 'number' && v >= 100 && v <= 30000, val: Math.max(100, Math.min(30000, Number(v))) }),
  orderTimeoutMs:         v => ({ ok: typeof v === 'number' && v >= 500 && v <= 60000, val: Math.max(500, Math.min(60000, Number(v))) }),
  allowPartialFills:      v => ({ ok: typeof v === 'boolean', val: Boolean(v) }),
  minimumFillRatio:       v => ({ ok: typeof v === 'number' && v >= 0.1 && v <= 1, val: Math.max(0.1, Math.min(1, Number(v))) }),
  highFillRatioThreshold: v => ({ ok: typeof v === 'number' && v >= 0.1 && v <= 1, val: Math.max(0.1, Math.min(1, Number(v))) }),
  maxOrderRetries:        v => ({ ok: typeof v === 'number' && v >= 0 && v <= 10, val: Math.max(0, Math.min(10, Number(v))) }),
  retryBackoffMs:         v => ({ ok: typeof v === 'number' && v >= 100 && v <= 10000, val: Math.max(100, Math.min(10000, Number(v))) }),
  exchangeCooldownMs:     v => ({ ok: typeof v === 'number' && v >= 100 && v <= 60000, val: Math.max(100, Math.min(60000, Number(v))) }),
  orderExecutionPolicy:   v => ({ ok: ['market_taker', 'ioc_protected', 'post_only_maker'].includes(v), val: v }),
  maxDrawdownPct:           v => ({ ok: typeof v === 'number' && v >= 0.1 && v <= 100, val: Math.max(0.1, Math.min(100, Number(v))) }),
  maxExposurePerExchange:   v => ({ ok: typeof v === 'number' && v >= 0.05 && v <= 1, val: Math.max(0.05, Math.min(1, Number(v))) }),
  maxExposurePerAsset:      v => ({ ok: typeof v === 'number' && v >= 0.05 && v <= 1, val: Math.max(0.05, Math.min(1, Number(v))) }),
  maxPositionValueUSD:      v => ({ ok: typeof v === 'number' && v >= 100 && v <= 1000000, val: Math.max(100, Math.min(1000000, Number(v))) }),
  maxConsecutiveFailures:   v => ({ ok: typeof v === 'number' && v >= 1 && v <= 50, val: Math.max(1, Math.min(50, Number(v))) }),
  emergencyStopThreshold:   v => ({ ok: typeof v === 'number' && v <= 0, val: Math.min(0, Number(v)) }),
  capitalAllocationMode:    v => ({ ok: ['equal', 'weighted', 'dynamic'].includes(v), val: v }),
  reserveCapitalPct:        v => ({ ok: typeof v === 'number' && v >= 0 && v <= 0.5, val: Math.max(0, Math.min(0.5, Number(v))) }),
  maxCapitalPerTrade:       v => ({ ok: typeof v === 'number' && v >= 0.001 && v <= 0.5, val: Math.max(0.001, Math.min(0.5, Number(v))) }),
  capitalPerStrategy:       v => ({ ok: typeof v === 'object' && v !== null, val: v }),
  capitalPerExchange:       v => ({ ok: typeof v === 'object' && v !== null, val: v }),
  scoringWeights: v => {
    if (typeof v !== 'object' || v === null) return { ok: false };
    const keys = ['liquidity', 'spread', 'volatility', 'execution', 'reliability', 'latency'];
    const hasAll = keys.every(k => typeof v[k] === 'number');
    if (!hasAll) return { ok: false, reason: 'Missing required weight keys' };
    const total = keys.reduce((s, k) => s + v[k], 0);
    if (Math.abs(total - 1.0) > 0.01) return { ok: false, reason: `Weights must sum to 1.0 (got ${total.toFixed(3)})` };
    return { ok: true, val: v };
  },
  rebalanceThresholdPct:     v => ({ ok: typeof v === 'number' && v >= 0.3 && v <= 1, val: Math.max(0.3, Math.min(1, Number(v))) }),
  rebalancePredictionWindow: v => ({ ok: typeof v === 'number' && v >= 300 && v <= 86400, val: Math.max(300, Math.min(86400, Number(v))) }),
  rebalanceCostLimit:        v => ({ ok: typeof v === 'number' && v >= 0 && v <= 10000, val: Math.max(0, Math.min(10000, Number(v))) }),
  minimumTransferAmount:     v => ({ ok: typeof v === 'number' && v >= 10 && v <= 100000, val: Math.max(10, Math.min(100000, Number(v))) }),
  rebalanceCostAlertPct:     v => ({ ok: typeof v === 'number' && v >= 1 && v <= 100, val: Math.max(1, Math.min(100, Number(v))) }),
  autoRebalanceEnabled:      v => ({ ok: typeof v === 'boolean', val: Boolean(v) }),
  autoRebalanceCooldownMs:   v => ({ ok: typeof v === 'number' && v >= 60_000 && v <= 24 * 60 * 60 * 1000, val: Math.max(60_000, Math.min(24 * 60 * 60 * 1000, Number(v))) }),
  autoRebalanceMinSeverity:  v => ({ ok: v === 'high' || v === 'medium', val: v }),
  liquidityMinFillPct:       v => ({ ok: typeof v === 'number' && v >= 0.05 && v <= 1, val: Math.max(0.05, Math.min(1, Number(v))) }),
  detailedScoreWeights: v => {
    if (typeof v !== 'object' || v === null) return { ok: false };
    const keys = ['profit', 'liquidity', 'persistence', 'latency', 'confidence'];
    const hasAll = keys.every(k => typeof v[k] === 'number' && v[k] >= 0);
    if (!hasAll) return { ok: false, reason: 'Missing required weight keys' };
    const total = keys.reduce((s, k) => s + v[k], 0);
    if (Math.abs(total - 100) > 1) return { ok: false, reason: `Weights must sum to 100 (got ${total.toFixed(1)})` };
    return { ok: true, val: v };
  },
  statArbWindowSize:         v => ({ ok: typeof v === 'number' && v >= 20 && v <= 1000, val: Math.round(Math.max(20, Math.min(1000, Number(v)))) }),
  statArbEwmaLambda:         v => ({ ok: typeof v === 'number' && v >= 0.5 && v <= 0.999, val: Math.max(0.5, Math.min(0.999, Number(v))) }),
  statArbZThreshold:         v => ({ ok: typeof v === 'number' && v >= 0.5 && v <= 5, val: Math.max(0.5, Math.min(5, Number(v))) }),
  statArbZStrong:            v => ({ ok: typeof v === 'number' && v >= 0.5 && v <= 6, val: Math.max(0.5, Math.min(6, Number(v))) }),
  statArbMinSamples:         v => ({ ok: typeof v === 'number' && v >= 5 && v <= 500, val: Math.round(Math.max(5, Math.min(500, Number(v)))) }),
  statArbMaxHalfLife:        v => ({ ok: typeof v === 'number' && v >= 10 && v <= 2000, val: Math.round(Math.max(10, Math.min(2000, Number(v)))) }),
  maxVolatilityPct:          v => ({ ok: v === null || (typeof v === 'number' && v >= 0.1 && v <= 50), val: v === null ? null : Math.max(0.1, Math.min(50, Number(v))) }),
  regimeAwareThresholds:     v => ({ ok: typeof v === 'boolean', val: Boolean(v) }),
  maxWeeklyLossUSD:          v => ({ ok: typeof v === 'number' && v <= 0 && v >= -1000000, val: Math.min(0, Math.max(-1000000, Number(v))) }),
  weeklyProfitTargetUSD:     v => ({ ok: v === null || (typeof v === 'number' && v >= 0), val: v === null ? null : Math.max(0, Number(v)) }),
  dailyProfitTargetUSD:      v => ({ ok: v === null || (typeof v === 'number' && v >= 0), val: v === null ? null : Math.max(0, Number(v)) }),
  slippageDivergenceThresholdPct: v => ({ ok: typeof v === 'number' && v > 0 && v <= 5, val: Math.max(0.001, Math.min(5, Number(v))) }),
  adaptiveScoringRecalcIntervalMs: v => ({ ok: typeof v === 'number' && v >= 1000 && v <= 600000, val: Math.max(1000, Math.min(600000, Number(v))) }),
  momentumPredictMs:         v => ({ ok: typeof v === 'number' && v >= 50 && v <= 10000, val: Math.max(50, Math.min(10000, Number(v))) }),
  postOnlyOffsetPct:         v => ({ ok: typeof v === 'number' && v >= 0 && v <= 0.05, val: Math.max(0, Math.min(0.05, Number(v))) }),
  circuitBreakerResetMs:     v => ({ ok: typeof v === 'number' && v >= 10000 && v <= 3600000, val: Math.max(10000, Math.min(3600000, Number(v))) }),
  opportunityExpiryTtlMs:    v => ({ ok: typeof v === 'number' && v >= 200 && v <= 60000, val: Math.max(200, Math.min(60000, Number(v))) }),
  directionalBiasThreshold:  v => ({ ok: typeof v === 'number' && v >= 0.1 && v <= 1, val: Math.max(0.1, Math.min(1, Number(v))) }),
  latencyRacingWindowMs:     v => ({ ok: typeof v === 'number' && v >= 50 && v <= 10000, val: Math.max(50, Math.min(10000, Number(v))) }),
  latencyRacingMinPriceChangePct: v => ({ ok: typeof v === 'number' && v >= 0 && v <= 1, val: Math.max(0, Math.min(1, Number(v))) }),
  tradingMode:               v => ({ ok: false, reason: 'tradingMode is read-only — set via LIVE_TRADING_ENABLED / DEMO_MODE env variables', val: v }),

  // ── ADR-019 validators ──────────────────────────────────────────────────
  fillProbabilityGateEnabled: v => ({ ok: typeof v === 'boolean', val: Boolean(v) }),
  minFillProbability:         v => ({ ok: typeof v === 'number' && v >= 0 && v <= 100, val: Math.max(0, Math.min(100, Number(v))) }),
  liquidityFactorEnabled:     v => ({ ok: typeof v === 'boolean', val: Boolean(v) }),
  minLiquidityConfidence:     v => ({ ok: typeof v === 'number' && v >= 0 && v <= 1, val: Math.max(0, Math.min(1, Number(v))) }),
  executionPenaltyEnabled:    v => ({ ok: typeof v === 'boolean', val: Boolean(v) }),
  minExecutionSamples:        v => ({ ok: typeof v === 'number' && v >= 1 && v <= 1000, val: Math.round(Math.max(1, Math.min(1000, Number(v)))) }),
  slippagePenaltyEnabled:     v => ({ ok: typeof v === 'boolean', val: Boolean(v) }),
  marketRegimeEnabled:        v => ({ ok: typeof v === 'boolean', val: Boolean(v) }),
  marketRegimeRefreshMs:      v => ({ ok: typeof v === 'number' && v >= 5000 && v <= 600000, val: Math.max(5000, Math.min(600000, Number(v))) }),
  marketRegimeScoreMultipliers: v => {
    if (typeof v !== 'object' || v === null) return { ok: false };
    const keys = ['LIQUIDITY_COMPRESSION', 'BULLISH_EXPANSION', 'BEARISH_CONTRACTION', 'DISTRIBUTION', 'ACCUMULATION', 'VOLATILE_UNCERTAINTY'];
    const hasAll = keys.every(k => typeof v[k] === 'number' && v[k] >= 1 && v[k] <= 3);
    if (!hasAll) return { ok: false, reason: 'Missing/invalid regime keys — all must be numbers in [1, 3] (score multipliers only ever tighten, never loosen)' };
    return { ok: true, val: v };
  },
  marketRegimeSizeMultipliers: v => {
    if (typeof v !== 'object' || v === null) return { ok: false };
    const keys = ['LIQUIDITY_COMPRESSION', 'BULLISH_EXPANSION', 'BEARISH_CONTRACTION', 'DISTRIBUTION', 'ACCUMULATION', 'VOLATILE_UNCERTAINTY'];
    const hasAll = keys.every(k => typeof v[k] === 'number' && v[k] > 0 && v[k] <= 1);
    if (!hasAll) return { ok: false, reason: 'Missing/invalid regime keys — all must be numbers in (0, 1] (size multipliers can only reduce exposure)' };
    return { ok: true, val: v };
  },
  recoveryClassificationEnabled: v => ({ ok: typeof v === 'boolean', val: Boolean(v) }),
};

let _cfg = JSON.parse(JSON.stringify(_defaults));
const _history = [];
const MAX_HISTORY = 100;

function get(key) {
  return _cfg[key] !== undefined ? _cfg[key] : _defaults[key];
}

function getAll() {
  return {
    current:     JSON.parse(JSON.stringify(_cfg)),
    defaults:    JSON.parse(JSON.stringify(_defaults)),
    history:     [..._history],
    changedKeys: Object.keys(_cfg).filter(k =>
      JSON.stringify(_cfg[k]) !== JSON.stringify(_defaults[k])
    ),
    schema: getSchema(),
  };
}

function setMany(patch, source = 'api') {
  const applied  = [];
  const rejected = [];

  for (const [key, rawVal] of Object.entries(patch)) {
    if (!_validators[key]) {
      rejected.push({ key, reason: 'Unknown parameter', received: rawVal });
      continue;
    }
    const result = _validators[key](rawVal);
    if (!result.ok) {
      rejected.push({ key, reason: result.reason || `Invalid value: ${JSON.stringify(rawVal)}`, received: rawVal });
      continue;
    }
    const prev = JSON.parse(JSON.stringify(_cfg[key] !== undefined ? _cfg[key] : _defaults[key]));
    _cfg[key] = result.val;
    applied.push({ key, prev, next: result.val });
  }

  if (applied.length > 0) {
    const entry = { ts: new Date().toISOString(), source, changes: applied };
    _history.unshift(entry);
    if (_history.length > MAX_HISTORY) _history.pop();
    process.stdout.write(
      `[liveConfig] ${applied.map(c => `${c.key}: ${JSON.stringify(c.prev)} → ${JSON.stringify(c.next)}`).join(', ')} (source: ${source})\n`
    );
    configEvents.emit('change', { ts: entry.ts, source, changes: applied, state: JSON.parse(JSON.stringify(_cfg)) });
  }

  return { ok: rejected.length === 0, applied, rejected, state: JSON.parse(JSON.stringify(_cfg)) };
}

function reset(source = 'api') {
  const prev = JSON.parse(JSON.stringify(_cfg));
  _cfg = JSON.parse(JSON.stringify(_defaults));
  const changes = Object.keys(_defaults)
    .filter(k => JSON.stringify(prev[k]) !== JSON.stringify(_defaults[k]))
    .map(k => ({ key: k, prev: prev[k], next: _defaults[k] }));

  if (changes.length > 0) {
    _history.unshift({ ts: new Date().toISOString(), source, changes, type: 'reset' });
    if (_history.length > MAX_HISTORY) _history.pop();
    configEvents.emit('reset', { source, changes });
  }

  return { ok: true, reset: changes, state: JSON.parse(JSON.stringify(_cfg)) };
}

/**
 * validateOne — expone la validación de un único parámetro sin mutar
 * ningún estado. Existe para que capas por-encima de liveConfig (p.ej.
 * tenantConfig.js, ADR-017) puedan validar overrides por-tenant contra
 * exactamente las mismas reglas que el config global, sin duplicar el
 * mapa `_validators` (~40 entradas) en un segundo archivo.
 */
function validateOne(key, rawVal) {
  if (!_validators[key]) return { ok: false, reason: 'Unknown parameter' };
  return _validators[key](rawVal);
}

function isExchangeActive(name) {
  const active = _cfg.activeExchanges;
  if (!Array.isArray(active) || active.length === 0) return true;
  return active.includes(name);
}

function getSchema() {
  return {
    minScore:                { type: 'number', min: 0, max: 100, step: 1, unit: 'pts', group: 'core', desc: 'Minimum composite score to execute a trade' },
    tradeAmountBTC:          { type: 'number', min: 0.001, max: 0.5, step: 0.001, unit: 'BTC', group: 'core', desc: 'Position size per trade' },
    feeMode:                 { type: 'enum', options: ['taker', 'maker'], group: 'core', desc: 'Fee tier' },
    minSpreadPct:            { type: 'number', min: 0.0001, max: 5, step: 0.0001, unit: '%', group: 'core', desc: 'Minimum spread % to consider an opportunity' },
    maxDailyLossUSD:         { type: 'number', min: -100000, max: 0, step: 50, unit: 'USD', group: 'risk', desc: 'Daily loss limit before halting' },
    cooldownMs:              { type: 'number', min: 50, max: 30000, step: 50, unit: 'ms', group: 'execution', desc: 'Minimum time between executions' },
    minTriangularNetPct:     { type: 'number', min: 0.001, max: 2, step: 0.001, unit: '%', group: 'core', desc: 'Min net profit % for triangular arb' },
    multiHopEnabled:         { type: 'boolean', group: 'strategy', desc: 'Advanced: enable execution of Multi-Hop (N-hop Bellman-Ford) cycles. Off by default — see multiHopArbitrageEngine.js for latency/CPU/API impact notes' },
    minMultiHopNetPct:       { type: 'number', min: 0.001, max: 2, step: 0.001, unit: '%', group: 'strategy', desc: 'Min compounded net profit % for a Multi-Hop cycle to execute (only used when multiHopEnabled)' },
    activeExchanges:         { type: 'multiselect', options: ALL_EXCHANGES, group: 'core', desc: 'Enabled exchanges' },
    minNetProfitUSD:         { type: 'number', min: 0, max: 100, step: 0.01, unit: 'USD', group: 'core', desc: 'Minimum net profit per trade in USD' },
    maxSpreadPct:            { type: 'number', min: 0.5, max: 20, step: 0.1, unit: '%', group: 'core', desc: 'Circuit breaker: reject if spread > this' },
    maxSlippagePct:          { type: 'number', min: 0, max: 5, step: 0.01, unit: '%', group: 'execution', desc: 'Maximum acceptable slippage %' },
    maxExecutionLatencyMs:   { type: 'number', min: 100, max: 30000, step: 100, unit: 'ms', group: 'execution', desc: 'Reject if execution takes longer' },
    orderTimeoutMs:          { type: 'number', min: 500, max: 60000, step: 500, unit: 'ms', group: 'execution', desc: 'Cancel order if not filled within this' },
    allowPartialFills:       { type: 'boolean', group: 'execution', desc: 'Allow partial fills on thin books' },
    minimumFillRatio:        { type: 'number', min: 0.1, max: 1, step: 0.05, group: 'execution', desc: 'Minimum fill ratio for partial fills (low-tier boundary)' },
    highFillRatioThreshold:  { type: 'number', min: 0.1, max: 1, step: 0.05, group: 'execution', desc: '3-tier partial fill: accept as-is above this ratio (high-tier boundary)' },
    maxOrderRetries:         { type: 'number', min: 0, max: 10, step: 1, group: 'execution', desc: 'Max retry attempts on transient failures' },
    retryBackoffMs:          { type: 'number', min: 100, max: 10000, step: 100, unit: 'ms', group: 'execution', desc: 'Base retry backoff (exponential)' },
    exchangeCooldownMs:      { type: 'number', min: 100, max: 60000, step: 100, unit: 'ms', group: 'execution', desc: 'Per-exchange cooldown after failure' },
    orderExecutionPolicy:    { type: 'enum', options: ['market_taker', 'ioc_protected', 'post_only_maker'], group: 'execution', desc: 'Smart Order Router policy: market / IOC-protected limit / post-only maker' },
    maxDrawdownPct:          { type: 'number', min: 0.1, max: 100, step: 0.1, unit: '%', group: 'risk', desc: 'Halt if drawdown exceeds this' },
    maxExposurePerExchange:  { type: 'number', min: 0.05, max: 1, step: 0.05, group: 'risk', desc: 'Max capital fraction on any exchange' },
    maxExposurePerAsset:     { type: 'number', min: 0.05, max: 1, step: 0.05, group: 'risk', desc: 'Max capital fraction in any asset' },
    maxPositionValueUSD:     { type: 'number', min: 100, max: 1000000, step: 100, unit: 'USD', group: 'risk', desc: 'Max USD value per position' },
    maxConsecutiveFailures:  { type: 'number', min: 1, max: 50, step: 1, group: 'risk', desc: 'Circuit breaker: halt after N failures' },
    emergencyStopThreshold:  { type: 'number', min: -1000000, max: 0, step: 50, unit: 'USD', group: 'risk', desc: 'Emergency stop P&L threshold' },
    capitalAllocationMode:   { type: 'enum', options: ['equal', 'weighted', 'dynamic'], group: 'capital', desc: 'Capital allocation strategy' },
    reserveCapitalPct:       { type: 'number', min: 0, max: 0.5, step: 0.01, group: 'capital', desc: 'Reserve capital fraction (not deployed)' },
    maxCapitalPerTrade:      { type: 'number', min: 0.001, max: 0.5, step: 0.001, group: 'capital', desc: 'Max capital fraction per trade' },
    capitalPerStrategy:      { type: 'weights', keys: ['cross_exchange', 'triangular', 'stat_arb', 'funding_rate'], min: 0, max: 1, step: 0.01, group: 'capital', desc: 'Capital split across strategies (should sum to ~1.0)' },
    capitalPerExchange:      { type: 'weights', keys: ALL_EXCHANGES, min: 0, max: 1, step: 0.01, group: 'capital', desc: 'Capital split across exchanges (should sum to ~1.0)' },
    scoringWeights:          { type: 'weights', keys: ['liquidity', 'spread', 'volatility', 'execution', 'reliability', 'latency'], min: 0, max: 1, step: 0.01, group: 'scoring', desc: 'Composite score component weights — must sum to exactly 1.0' },
    rebalanceThresholdPct:   { type: 'number', min: 0.3, max: 1, step: 0.05, group: 'rebalancing', desc: 'USDT concentration trigger' },
    rebalancePredictionWindow:{ type: 'number', min: 300, max: 86400, step: 300, unit: 's', group: 'rebalancing', desc: 'Predictive rebalancing look-ahead' },
    rebalanceCostLimit:      { type: 'number', min: 0, max: 10000, step: 10, unit: 'USD', group: 'rebalancing', desc: 'Max rebalance cost before skipping' },
    minimumTransferAmount:   { type: 'number', min: 10, max: 100000, step: 10, unit: 'USD', group: 'rebalancing', desc: 'Minimum transfer to trigger rebalance' },
    rebalanceCostAlertPct:   { type: 'number', min: 1, max: 100, step: 1, unit: '%', group: 'rebalancing', desc: 'Alert when cumulative rebalance cost exceeds this % of period profit' },
    autoRebalanceEnabled:    { type: 'boolean', group: 'rebalancing', desc: 'Automatically execute a rebalance when a HIGH-severity imbalance is detected (off by default)' },
    autoRebalanceCooldownMs: { type: 'number', min: 60000, max: 86400000, step: 60000, unit: 'ms', group: 'rebalancing', desc: 'Minimum time between automatic rebalance executions' },
    autoRebalanceMinSeverity:{ type: 'enum', options: ['high', 'medium'], group: 'rebalancing', desc: 'Minimum analyzeBalance() severity that triggers an automatic rebalance' },
    liquidityMinFillPct:     { type: 'number', min: 0.05, max: 1, step: 0.05, group: 'strategy', desc: 'Pre-trade liquidity gate: min fraction of requested size the L2 book must cover' },
    detailedScoreWeights:    { type: 'weights', keys: ['profit', 'liquidity', 'persistence', 'latency', 'confidence'], min: 0, max: 100, step: 1, group: 'strategy', desc: 'Composite opportunity score (0-100) component weights — must sum to 100' },
    statArbWindowSize:       { type: 'number', min: 20, max: 1000, step: 10, unit: 'ticks', group: 'strategy', desc: 'StatArb rolling log-spread window size' },
    statArbEwmaLambda:       { type: 'number', min: 0.5, max: 0.999, step: 0.001, group: 'strategy', desc: 'StatArb EWMA decay factor for mean/variance' },
    statArbZThreshold:       { type: 'number', min: 0.5, max: 5, step: 0.1, group: 'strategy', desc: 'StatArb: |Z-score| above this triggers a signal' },
    statArbZStrong:          { type: 'number', min: 0.5, max: 6, step: 0.1, group: 'strategy', desc: 'StatArb: |Z-score| above this is a high-confidence signal' },
    statArbMinSamples:       { type: 'number', min: 5, max: 500, step: 1, group: 'strategy', desc: 'StatArb: minimum samples before trusting the Z-score' },
    statArbMaxHalfLife:      { type: 'number', min: 10, max: 2000, step: 10, unit: 'ticks', group: 'strategy', desc: 'StatArb: half-life above which a pair is trending, not mean-reverting' },
    maxVolatilityPct:        { type: 'number', min: 0.1, max: 50, step: 0.1, unit: '%', group: 'risk', desc: 'Halt new trades when 1h BTC volatility exceeds this (null = disabled)', nullable: true },
    regimeAwareThresholds:   { type: 'boolean', group: 'risk', desc: 'Raise minScore in crisis market regimes automatically' },
    maxWeeklyLossUSD:        { type: 'number', min: -1000000, max: 0, step: 100, unit: 'USD', group: 'risk', desc: 'Weekly loss limit — halts trading for the week if breached' },
    weeklyProfitTargetUSD:   { type: 'number', min: 0, max: 1000000, step: 50, unit: 'USD', group: 'risk', desc: 'Auto-pause when weekly profit reaches this target (null = no target)', nullable: true },
    dailyProfitTargetUSD:    { type: 'number', min: 0, max: 100000, step: 10, unit: 'USD', group: 'risk', desc: 'Auto-pause when daily profit reaches this target (null = no target)', nullable: true },
    slippageDivergenceThresholdPct: { type: 'number', min: 0.001, max: 5, step: 0.01, unit: '%', group: 'execution', desc: 'Max relative divergence between estimated and real slippage before flagging (Phase 1 production gate)' },
    adaptiveScoringRecalcIntervalMs: { type: 'number', min: 1000, max: 600000, step: 1000, unit: 'ms', group: 'scoring', desc: 'Minimum time between adaptive scoring weight recalculations' },
    momentumPredictMs:       { type: 'number', min: 50, max: 10000, step: 50, unit: 'ms', group: 'strategy', desc: 'Spread momentum: look-ahead prediction window' },
    postOnlyOffsetPct:       { type: 'number', min: 0, max: 0.05, step: 0.0001, unit: '%', group: 'execution', desc: 'Post-only maker order offset from mid-price' },
    circuitBreakerResetMs:   { type: 'number', min: 10000, max: 3600000, step: 10000, unit: 'ms', group: 'risk', desc: 'Delay before an auto-reset of a tripped circuit breaker' },
    opportunityExpiryTtlMs:  { type: 'number', min: 200, max: 60000, step: 100, unit: 'ms', group: 'strategy', desc: 'Opportunity lifecycle: TTL before an unseen opportunity is expired from tracking' },
    directionalBiasThreshold:{ type: 'number', min: 0.1, max: 1, step: 0.05, group: 'strategy', desc: '|bias score| at/above which a direction is considered consistent' },
    latencyRacingWindowMs:   { type: 'number', min: 50, max: 10000, step: 50, unit: 'ms', group: 'strategy', desc: 'Latency racing: window within which updates are treated as the same market move propagating' },
    latencyRacingMinPriceChangePct: { type: 'number', min: 0, max: 1, step: 0.001, unit: '%', group: 'strategy', desc: 'Latency racing: ignore price changes below this % as noise' },
    tradingMode:             { type: 'enum', options: ['paper', 'demo', 'live'], group: 'core', desc: 'Trading mode (read-only — set via env)', readOnly: true },

    // ── ADR-019 schema entries ────────────────────────────────────────────
    fillProbabilityGateEnabled: { type: 'boolean', group: 'decision-engine', desc: 'ADR-019 §1: reject opportunities whose fillProbability is below minFillProbability' },
    minFillProbability:      { type: 'number', min: 0, max: 100, step: 1, unit: 'pts', group: 'decision-engine', desc: 'ADR-019 §1: fill-probability gate threshold' },
    liquidityFactorEnabled:  { type: 'boolean', group: 'decision-engine', desc: 'ADR-019 §2: scale position size down (never up) using liquidityPredictionEngine' },
    minLiquidityConfidence:  { type: 'number', min: 0, max: 1, step: 0.05, group: 'decision-engine', desc: 'ADR-019 §2: below this confidence, liquidity prediction is treated as neutral (1.0x)' },
    executionPenaltyEnabled: { type: 'boolean', group: 'decision-engine', desc: 'ADR-019 §3: extend the reliability penalty with real execution success-rate history' },
    minExecutionSamples:     { type: 'number', min: 1, max: 1000, step: 1, group: 'decision-engine', desc: 'ADR-019 §3/§5: minimum trades on an exchange before its execution/slippage penalty applies' },
    slippagePenaltyEnabled:  { type: 'boolean', group: 'decision-engine', desc: 'ADR-019 §5: extend the reliability penalty with realized slippage-bias history per exchange' },
    marketRegimeEnabled:     { type: 'boolean', group: 'decision-engine', desc: 'ADR-019 §4: apply defensive minScore/size multipliers based on detected market regime' },
    marketRegimeRefreshMs:   { type: 'number', min: 5000, max: 600000, step: 5000, unit: 'ms', group: 'decision-engine', desc: 'ADR-019 §4: how often the cached market regime is recomputed' },
    marketRegimeScoreMultipliers: { type: 'weights', keys: ['LIQUIDITY_COMPRESSION', 'BULLISH_EXPANSION', 'BEARISH_CONTRACTION', 'DISTRIBUTION', 'ACCUMULATION', 'VOLATILE_UNCERTAINTY'], min: 1, max: 3, step: 0.01, group: 'decision-engine', desc: 'ADR-019 §4: per-regime minScore multiplier (>= 1.0 only — tightens or holds)' },
    marketRegimeSizeMultipliers:  { type: 'weights', keys: ['LIQUIDITY_COMPRESSION', 'BULLISH_EXPANSION', 'BEARISH_CONTRACTION', 'DISTRIBUTION', 'ACCUMULATION', 'VOLATILE_UNCERTAINTY'], min: 0.01, max: 1, step: 0.01, group: 'decision-engine', desc: 'ADR-019 §4: per-regime position-size multiplier (<= 1.0 only — never increases risk)' },
    recoveryClassificationEnabled: { type: 'boolean', group: 'risk', desc: 'ADR-019 Part C: log a recovery-action classification + EV comparison before _emergencyFlatten (false = call _emergencyFlatten directly)' },
  };
}

module.exports = {
  get,
  getAll,
  setMany,
  reset,
  validateOne,
  isExchangeActive,
  events: configEvents,
  ALL_EXCHANGES,
  _defaults,
};

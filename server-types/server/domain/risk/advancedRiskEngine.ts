/**
 * advancedRiskEngine.ts — Kukora v17 (TypeScript — audit fix 1.1, final module)
 *
 * Section 7: Advanced risk engine.
 *   - Real-time drawdown monitoring
 *   - Exposure limits per exchange, asset, strategy
 *   - Multi-dimensional circuit breakers
 *   - Position concentration tracking
 *   - P&L attribution
 *
 * Integrates with the existing riskEngine.js (portfolio/asset risk scores)
 * by adding the operational risk layer needed for live trading.
 *
 * Architecture:
 *   - Singleton with in-memory state updated on every trade
 *   - All circuit breakers are hot-configurable via liveConfig
 *   - Emits structured events via observabilityService
 *   - Returns machine-readable risk status on every check
 *
 * MIGRATION NOTE (audit 1.1): this is the last of the four financial-core
 * modules migrated to TypeScript. Compiles to the exact same
 * server/advancedRiskEngine.js CommonJS output — server/riskEngine.js,
 * server/crypto.routes.js, server/arbitrageOrchestrator.js and
 * server/arbitrage/routes/query.routes.js all keep doing plain
 * require('./advancedRiskEngine') unchanged. Never edit
 * server/advancedRiskEngine.js directly — it is a generated build artifact;
 * edit this file and run `tsc`.
 *
 * RELOCATION NOTE (Nivel 2 #1 bounded-context reorg, round 12): this file
 * moved from server-types/server/advancedRiskEngine.ts to
 * server-types/server/domain/advancedRiskEngine.ts so it now compiles to
 * server/domain/advancedRiskEngine.js instead. server/advancedRiskEngine.js
 * (and the server/riskEngine.js shim chained on top of it) are now
 * backward-compatible re-export shims. Never edit
 * server/domain/advancedRiskEngine.js directly — it is a generated
 * build artifact; edit this file and run `tsc`.
 */

'use strict';

// PATH FIX (kukora wallets/rebalance robustness session): these two imports
// pointed at '../liveConfig' and '../observabilityService', which resolve
// to server/liveConfig.js and server/observabilityService.js — neither
// exists post shim-cleanup; both modules live under server/infrastructure/.
// The compiled server/domain/advancedRiskEngine.js had been hand-patched at
// some point to require the correct infrastructure/ paths directly, so
// tests passed as long as nobody re-ran `tsc` from this source. That's a
// landmine: the .ts source (the thing you're supposed to edit) silently
// drifted from the .js (the thing that actually runs). Fixed at the source
// so the two can never diverge again.
import * as liveConfig from '../../infrastructure/liveConfig';
import * as observability from '../../infrastructure/observabilityService';
import {
  percentageChange, stdDev, sharpe, sortino, calmarRatio,
  valueAtRisk, drawdown,
  correlation, clean, last,
} from '../analytics/analytics';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExposureEntry {
  USDT: number;
  BTC: number;
  btcUSD: number;
  totalUSD: number;
}

export interface TradeLike {
  type?: string;
  netProfit?: number;
  [key: string]: unknown;
}

// `TradeLike` is intentionally NOT the canonical `Trade` from
// domain/opportunity.ts. `updateExposure()` only ever reads `.type` and
// `.netProfit` (both optional, both read with `||` fallback) to bucket
// exposure by strategy — it never needs a full Trade. Forcing the full
// canonical Trade contract here would reject legitimate partial callers
// for no functional gain. Because every field is optional, the only thing
// that can actually be "wrong" about an incoming value is that it isn't a
// plain object at all (e.g. a string, array, or number passed by mistake)
// — that's exactly what this guard checks, no more.
export function isTradeLike(obj: unknown): obj is TradeLike {
  return typeof obj === 'object' && obj !== null && !Array.isArray(obj);
}

export interface WalletsLike {
  USDT?: Record<string, number>;
  BTC?: Record<string, number>;
}

export interface DrawdownCheckOk {
  ok: true;
  drawdownPct: number;
  maxDrawdownPct: number;
  headroomPct: number;
}
export interface DrawdownCheckFail {
  ok: false;
  drawdownPct: number;
  maxDrawdownPct: number;
  reason: string;
}
export type DrawdownCheckResult = DrawdownCheckOk | DrawdownCheckFail;

export interface ExposureViolation {
  type: 'exchange_concentration' | 'asset_concentration';
  exchange?: string;
  asset?: string;
  ratio: number;
  limit: number;
  excessUSD: number;
}

export interface ExposureLimitsResult {
  ok: boolean;
  violations: ExposureViolation[];
  exposureByExchange: Record<string, ExposureEntry>;
  exposureByAsset: Record<string, number>;
}

export interface PositionSizeOk {
  ok: true;
  tradeValueUSD: number;
  maxPositionValueUSD: number;
}
export interface PositionSizeFail {
  ok: false;
  reason: string;
  limit: number;
  actual: number;
}
export type PositionSizeResult = PositionSizeOk | PositionSizeFail;

export interface CircuitBreakerResetResult {
  ok: boolean;
  reason?: string;
  source?: string;
}

export interface CircuitBreakerActivateResult {
  ok: boolean;
  alreadyActive: boolean;
  reason?: string | null;
  triggerType?: string;
  activatedAt?: string | null;
}

export interface TradeOutcomeResult {
  circuitBreakerActive: boolean;
  consecutiveFailures?: number;
  maxFailures?: number;
}

export interface EmergencyStopOk {
  ok: true;
  sessionPnl: number;
  threshold: number;
  headroom: number;
}
export interface EmergencyStopFail {
  ok: false;
  reason: string;
  sessionPnl: number;
  threshold: number;
}
export type EmergencyStopResult = EmergencyStopOk | EmergencyStopFail;

export interface RiskCheckEntry {
  check: string;
  ok: boolean;
  reason?: string;
  [key: string]: unknown;
}

export interface PreTradeRiskCheckResult {
  ok: boolean;
  checks: RiskCheckEntry[];
  blockedBy: string | null;
  timestamp: string;
}

export interface OpportunityLike {
  buyPrice?: number;
  tradeAmount?: number;
  slippagePct?: number;
  // AUDIT FINDING 2 fix: explicit type for the field
  // `adaptivePositionSizing.getPositionSizeForOpportunity()` attaches — see
  // the fix note above `tradeSizeBTC` in `preTradeRiskCheck()` for why this
  // must take precedence over `tradeAmount` when present.
  positionSizing?: { size?: number };
  [key: string]: unknown;
}

// Also intentionally NOT the canonical `Opportunity`. Real callers pass
// genuinely different richness here: arbitrageOrchestrator.js passes a
// fully-sized real opportunity, while liveExecution.js deliberately builds
// a synthetic `{ buyPrice, tradeAmount, slippagePct }` object just for this
// risk check — neither is wrong, both are legitimate reduced views over a
// real opportunity for the sole purpose of `preTradeRiskCheck()`. As with
// `TradeLike`, every field is optional, so the only structural failure
// mode is not being a plain object at all.
export function isOpportunityLike(obj: unknown): obj is OpportunityLike {
  return typeof obj === 'object' && obj !== null && !Array.isArray(obj);
}

// Per-user overrides consumed by preTradeRiskCheck (refinamiento post-Sesión
// 34, "Profundidad y parametrización" — ver userRiskProfileService.js para
// el porqué completo). Deliberadamente NO incluye drawdown/circuit-breaker:
// esos gobiernan estado compartido global (_peakEquity, _circuitBreakerActive)
// y dejarlos per-user permitiría que el límite más estricto de un usuario
// disparara el circuit breaker GLOBAL para todos los demás — un bug de
// aislamiento, no una función. Solo se exponen los tres límites que son
// genuinamente evaluables de forma aislada por ejecución individual.
export interface RiskProfileOverrides {
  maxPositionValueUSD?: number | null;
  maxDailyLossUSD?: number | null;
  maxSlippagePct?: number | null;
}

export interface RiskStatus {
  circuitBreaker: {
    active: boolean;
    reason: string | null;
    since: string | null;
  };
  consecutiveFailures: number;
  lastFailureTs: string | null;
  maxConsecutiveFailures: number;
  drawdown: {
    pct: number | null;
    peakEquity: number | null;
    currentEquity: number | null;
    maxAllowedPct: number;
  };
  sessionPnl: number;
  dailyLossLimit: number;
  emergencyThreshold: number;
  exposure: Record<string, ExposureEntry>;
  slippageHistory: number[];
  config: {
    maxDrawdownPct: number;
    maxConsecutiveFailures: number;
    maxSlippagePct: number;
    maxPositionValueUSD: number;
  };
}

export interface AssetRiskScore {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D';
  components: {
    volatility?: number;
    drawdown?: number;
    var95?: number;
    skewPenalty?: number;
  };
  raw?: {
    vol: number;
    drawdown: number;
    var95: number | null;
    skew: number;
    sharpe: number | null;
    sortino: number | null;
    calmar: number | null;
  };
}

export interface PortfolioPosition {
  coinId: string;
  quantity: number;
  entryPrice: number;
  prices?: number[];
}

export interface PortfolioRiskResult {
  totalValue: number;
  weights: { coinId: string; weight: number }[];
  metrics: { volatility: number; sharpe: number | null; sortino: number | null };
  returns: number[];
}

// ─── State ────────────────────────────────────────────────────────────────
let _peakEquity: number | null          = null;  // for drawdown calculation
let _sessionStartEquity: number | null  = null;
let _consecutiveFailures                = 0;
let _lastFailureTs: string | null       = null;
let _circuitBreakerActive               = false;
let _circuitBreakerReason: string | null = null;
let _circuitBreakerTs: string | null    = null;
const _slippageHistory: { ts: number; value: number }[] = [];
const _latencyHistory: { ts: number; value: number }[]  = [];
let _exposureByExchange: Record<string, ExposureEntry> = {};   // exchange → { USDT, BTC, btcUSD, totalUSD }
let _exposureByAsset: Record<string, number>           = {};   // asset → totalUSD
const _exposureByStrategy: Record<string, number>      = {};   // strategy → totalUSD

// Auto-reset circuit breaker after 5 minutes (configurable)
// CIRCUIT_BREAKER_RESET_MS: ver liveConfig.get('circuitBreakerResetMs') (item 2, config dinámica).
// Default idéntico (5 min) — parametrización pura, sin cambio de comportamiento.

// ─── Initialization ───────────────────────────────────────────────────────

export function init(currentEquityUSD: number): void {
  _peakEquity         = currentEquityUSD;
  _sessionStartEquity = currentEquityUSD;
  observability.emit('RISK', 'risk_engine.initialized', { equity: currentEquityUSD });
}

export function updateEquity(currentEquityUSD: number): void {
  if (_sessionStartEquity === null) _sessionStartEquity = currentEquityUSD;
  if (_peakEquity === null || currentEquityUSD > _peakEquity) {
    _peakEquity = currentEquityUSD;
  }
}

// ─── Drawdown check ───────────────────────────────────────────────────────

export function getDrawdownPct(currentEquityUSD: number): number {
  if (_peakEquity === null || _peakEquity === 0) return 0;
  return ((_peakEquity - currentEquityUSD) / _peakEquity) * 100;
}

export function checkDrawdown(currentEquityUSD: number): DrawdownCheckResult {
  const drawdownPct    = getDrawdownPct(currentEquityUSD);
  const maxDrawdownPct = liveConfig.get('maxDrawdownPct');

  if (drawdownPct >= maxDrawdownPct) {
    const reason = `Drawdown ${drawdownPct.toFixed(2)}% exceeds maximum ${maxDrawdownPct}%`;
    activateCircuitBreaker(reason, 'drawdown');
    return { ok: false, drawdownPct, maxDrawdownPct, reason };
  }

  return { ok: true, drawdownPct: +drawdownPct.toFixed(2), maxDrawdownPct, headroomPct: +(maxDrawdownPct - drawdownPct).toFixed(2) };
}

// ─── Exposure checks ───────────────────────────────────────────────────────

export function updateExposure(trade: TradeLike | null, wallets: WalletsLike, btcPrice: number): void {
  // Recompute from wallets (source of truth)
  _exposureByExchange = {};
  _exposureByAsset    = { BTC: 0, USDT: 0 };

  const allExchanges = liveConfig.ALL_EXCHANGES;
  for (const ex of allExchanges) {
    const usdt   = wallets.USDT?.[ex] || 0;
    const btc    = wallets.BTC?.[ex]  || 0;
    const btcUSD = btc * btcPrice;
    const total  = usdt + btcUSD;
    _exposureByExchange[ex] = { USDT: usdt, BTC: btc, btcUSD, totalUSD: total };
    _exposureByAsset.USDT += usdt;
    _exposureByAsset.BTC  += btcUSD;
  }

  // Track by strategy type
  if (trade) {
    // Soft contract check (non-blocking — see isTradeLike() above). `null`
    // is a legitimate, expected value (checkExposureLimits() calls this
    // with trade=null); only a non-null value of the wrong shape signals a
    // real caller bug.
    if (!isTradeLike(trade)) {
      observability.emit('RISK', 'contract.trade_like_shape_invalid', { receivedType: typeof trade });
    }
    const strategy = trade.type || 'cross_exchange';
    _exposureByStrategy[strategy] = (_exposureByStrategy[strategy] || 0) + Math.abs(trade.netProfit || 0);
  }
}

export function checkExposureLimits(wallets: WalletsLike, btcPrice: number, currentEquityUSD: number): ExposureLimitsResult {
  updateExposure(null, wallets, btcPrice);

  const maxPerExchange = liveConfig.get('maxExposurePerExchange');
  const maxPerAsset    = liveConfig.get('maxExposurePerAsset');
  const violations: ExposureViolation[] = [];

  // Exchange concentration check
  for (const [ex, exp] of Object.entries(_exposureByExchange)) {
    const ratio = currentEquityUSD > 0 ? exp.totalUSD / currentEquityUSD : 0;
    if (ratio > maxPerExchange) {
      violations.push({
        type:       'exchange_concentration',
        exchange:   ex,
        ratio:      +ratio.toFixed(3),
        limit:      maxPerExchange,
        excessUSD:  +((ratio - maxPerExchange) * currentEquityUSD).toFixed(2),
      });
    }
  }

  // Asset concentration check
  const totalUSD = Object.values(_exposureByAsset).reduce((s, v) => s + v, 0);
  for (const [asset, valueUSD] of Object.entries(_exposureByAsset)) {
    const ratio = totalUSD > 0 ? valueUSD / totalUSD : 0;
    if (ratio > maxPerAsset) {
      violations.push({
        type:     'asset_concentration',
        asset,
        ratio:    +ratio.toFixed(3),
        limit:    maxPerAsset,
        excessUSD: +((ratio - maxPerAsset) * totalUSD).toFixed(2),
      });
    }
  }

  if (violations.length > 0) {
    observability.emit('RISK', 'risk.exposure_violation', { violations }, 'warn');
  }

  return {
    ok:                violations.length === 0,
    violations,
    exposureByExchange: _exposureByExchange,
    exposureByAsset:    _exposureByAsset,
  };
}

// ─── Position size check ──────────────────────────────────────────────────

export function checkPositionSize(tradeValueUSD: number, maxPositionValueUSDOverride?: number | null): PositionSizeResult {
  const maxPositionValueUSD = maxPositionValueUSDOverride ?? liveConfig.get('maxPositionValueUSD');

  if (tradeValueUSD > maxPositionValueUSD) {
    return {
      ok:     false,
      reason: `Position value $${tradeValueUSD.toFixed(2)} exceeds maximum $${maxPositionValueUSD}`,
      limit:  maxPositionValueUSD,
      actual: tradeValueUSD,
    };
  }

  return { ok: true, tradeValueUSD, maxPositionValueUSD };
}

// ─── Circuit breakers ─────────────────────────────────────────────────────
// Trigger types que NUNCA se auto-resetean por timeout: requieren
// intervención explícita (POST /risk/circuit-breaker/reset). 'drawdown' y
// 'daily_loss' ya estaban excluidos porque son señales de que hay dinero
// real en juego; 'manual' se agregó en la auditoría del comité (Sesión 34,
// P0 #2) — un kill switch que un operador dispara a mano y que el propio
// sistema revierte solo 5 minutos después, sin que nadie lo pida, no es un
// kill switch: es un retraso cosmético. Si un humano lo apagó, un humano
// debe volver a encenderlo.
const NON_AUTO_RESET_TRIGGERS = new Set(['drawdown', 'daily_loss', 'manual']);

export function activateCircuitBreaker(reason: string, triggerType: string = 'manual'): CircuitBreakerActivateResult {
  if (_circuitBreakerActive) {
    // Ya estaba activo (posiblemente por otro trigger): no lo pisamos,
    // pero le devolvemos al caller el estado real en vez de `undefined`
    // silencioso — un kill switch manual que responde "ok" sin decir
    // que el sistema ya estaba detenido por otra razón es confuso para
    // el operador que lo está disparando.
    return { ok: true, alreadyActive: true, reason: _circuitBreakerReason, activatedAt: _circuitBreakerTs };
  }

  _circuitBreakerActive = true;
  _circuitBreakerReason = reason;
  _circuitBreakerTs     = new Date().toISOString();

  observability.emit('RISK', 'risk.circuit_breaker.activated', {
    reason,
    triggerType,
    ts: _circuitBreakerTs,
    consecutiveFailures: _consecutiveFailures,
  }, 'error');

  // Schedule auto-reset — salvo para triggers en NON_AUTO_RESET_TRIGGERS,
  // que se quedan activos hasta un reset explícito.
  setTimeout(() => {
    if (_circuitBreakerActive && !NON_AUTO_RESET_TRIGGERS.has(triggerType)) {
      resetCircuitBreaker('auto_timeout');
    }
  }, liveConfig.get('circuitBreakerResetMs'));

  return { ok: true, alreadyActive: false, reason, triggerType, activatedAt: _circuitBreakerTs };
}

export function resetCircuitBreaker(source: string = 'manual'): CircuitBreakerResetResult {
  if (!_circuitBreakerActive) return { ok: false, reason: 'Circuit breaker not active' };

  const prevReason = _circuitBreakerReason;
  _circuitBreakerActive = false;
  _circuitBreakerReason = null;
  _circuitBreakerTs     = null;
  _consecutiveFailures  = 0;

  observability.emit('RISK', 'risk.circuit_breaker.reset', { source, previousReason: prevReason });
  return { ok: true, source };
}

export function recordTradeOutcome(success: boolean, _context: Record<string, unknown> = {}): TradeOutcomeResult {
  if (success) {
    _consecutiveFailures = 0;
    return { circuitBreakerActive: _circuitBreakerActive };
  }

  _consecutiveFailures++;
  _lastFailureTs = new Date().toISOString();

  const maxFailures = liveConfig.get('maxConsecutiveFailures');
  if (_consecutiveFailures >= maxFailures) {
    activateCircuitBreaker(
      `${_consecutiveFailures} consecutive failures (limit: ${maxFailures})`,
      'consecutive_failures'
    );
  }

  return {
    consecutiveFailures:  _consecutiveFailures,
    circuitBreakerActive: _circuitBreakerActive,
    maxFailures,
  };
}

// ─── Slippage circuit breaker ─────────────────────────────────────────────

export function recordSlippage(slippagePct: number | null | undefined): void {
  if (slippagePct == null || isNaN(slippagePct)) return;
  _slippageHistory.push({ ts: Date.now(), value: slippagePct });
  if (_slippageHistory.length > 50) _slippageHistory.shift();

  const maxSlippage = liveConfig.get('maxSlippagePct');
  const recentHigh  = _slippageHistory.slice(-5).filter(s => s.value > maxSlippage);

  if (recentHigh.length >= 3) {
    activateCircuitBreaker(
      `Excessive slippage: ${recentHigh.length}/5 recent trades exceeded ${maxSlippage}% limit`,
      'excessive_slippage'
    );
  }
}

// ─── Latency circuit breaker ──────────────────────────────────────────────

export function recordLatency(latencyMs: number): void {
  _latencyHistory.push({ ts: Date.now(), value: latencyMs });
  if (_latencyHistory.length > 20) _latencyHistory.shift();

  const maxLatency = liveConfig.get('maxExecutionLatencyMs');
  const recentHigh = _latencyHistory.slice(-5).filter(l => l.value > maxLatency);

  if (recentHigh.length >= 3) {
    observability.emit('RISK', 'risk.high_latency', {
      recentCount: recentHigh.length,
      maxLatency,
      avgRecent: recentHigh.reduce((s, l) => s + l.value, 0) / recentHigh.length,
    }, 'warn');
  }
}

// ─── Emergency stop ───────────────────────────────────────────────────────

export function checkEmergencyStop(sessionPnl: number): EmergencyStopResult {
  const threshold = liveConfig.get('emergencyStopThreshold');
  if (sessionPnl <= threshold) {
    const reason = `Emergency stop: session P&L ${sessionPnl.toFixed(2)} USD fell below threshold ${threshold} USD`;
    activateCircuitBreaker(reason, 'emergency_stop');
    return { ok: false, reason, sessionPnl, threshold };
  }
  return { ok: true, sessionPnl, threshold, headroom: +(sessionPnl - threshold).toFixed(2) };
}

// ─── Comprehensive pre-trade risk check ──────────────────────────────────

/**
 * Run all risk checks before a trade executes.
 * Returns { ok, checks, blockedBy } — ok=false halts the trade.
 */
export function preTradeRiskCheck(
  opportunity: OpportunityLike,
  _wallets: WalletsLike,
  currentEquityUSD: number | null,
  sessionPnl: number,
  overrides: RiskProfileOverrides = {}
): PreTradeRiskCheckResult {
  const checks: RiskCheckEntry[] = [];
  let blocked  = false;
  let blockedBy: string | null = null;

  // Soft contract check (non-blocking — see isOpportunityLike() above and
  // its documented reduced contract). All fields on OpportunityLike are
  // optional, so the only real structural failure is not being an object
  // at all.
  if (!isOpportunityLike(opportunity)) {
    observability.emit('RISK', 'contract.risk_opportunity_shape_invalid', { receivedType: typeof opportunity });
  }

  // 1. Circuit breaker (siempre global — ver nota en RiskProfileOverrides)
  if (_circuitBreakerActive) {
    checks.push({ check: 'circuit_breaker', ok: false, reason: _circuitBreakerReason || undefined });
    blocked   = true;
    blockedBy = 'circuit_breaker';
  }

  // 2. Daily loss — el usuario puede fijar un límite más estricto que el
  // global (nunca más laxo; userRiskProfileService ya lo recorta antes de
  // que llegue aquí, pero se re-clampea también localmente por defensa en
  // profundidad).
  const dailyLossCheck: RiskCheckEntry = { check: 'daily_loss', ok: true };
  const globalMaxDailyLoss = liveConfig.get('maxDailyLossUSD');
  const maxDailyLoss = overrides.maxDailyLossUSD != null
    ? Math.max(overrides.maxDailyLossUSD, globalMaxDailyLoss)
    : globalMaxDailyLoss;
  if (sessionPnl <= maxDailyLoss) {
    dailyLossCheck.ok     = false;
    dailyLossCheck.reason = `Daily loss ${sessionPnl.toFixed(2)} USD exceeds limit ${maxDailyLoss} USD`;
    if (!blocked) { blocked = true; blockedBy = 'daily_loss_limit'; }
  }
  checks.push(dailyLossCheck);

  // 3. Emergency stop (siempre global)
  const emergencyCheck = checkEmergencyStop(sessionPnl);
  if (!emergencyCheck.ok) {
    checks.push({ check: 'emergency_stop', ok: false, reason: emergencyCheck.reason });
    if (!blocked) { blocked = true; blockedBy = 'emergency_stop'; }
  } else {
    checks.push({ check: 'emergency_stop', ok: true, headroom: emergencyCheck.headroom });
  }

  // 4. Drawdown (siempre global — muta _peakEquity/circuit breaker compartidos)
  if (currentEquityUSD !== null) {
    const ddCheck = checkDrawdown(currentEquityUSD);
    if (!ddCheck.ok) {
      checks.push({ check: 'drawdown', ok: false, reason: ddCheck.reason, drawdownPct: ddCheck.drawdownPct });
      if (!blocked) { blocked = true; blockedBy = 'drawdown'; }
    } else {
      checks.push({ check: 'drawdown', ok: true, drawdownPct: ddCheck.drawdownPct });
    }
  }

  // 5. Position size — per-user override soportado (clampeado al global)
  //
  // AUDIT FINDING 2 fix (CRITICAL): `arbitrageOrchestrator.js`'s
  // `getPositionSizeForOpportunity()` returns `{ ...opp, positionSizing }` —
  // the ORIGINAL pre-adjustment `opportunity.tradeAmount` survives untouched
  // on the same object, alongside the real, adjusted size in
  // `positionSizing.size` (which is what actually gets executed downstream,
  // both in paper trading and — via `amount` — in live execution). Reading
  // `opportunity.tradeAmount` here checked the wrong number: adaptive sizing
  // can scale a trade up to 3x (high score/momentum), so a trade that should
  // have been blocked by `maxPositionValueUSD` could pass using its smaller,
  // stale pre-adjustment value. `positionSizing.size` must win whenever
  // present; `tradeAmount` remains the fallback for callers that never went
  // through adaptive sizing at all (e.g. `liveExecution.js`'s synthetic
  // `riskOpportunity`, which only ever sets `tradeAmount` to the real
  // requested amount and has no `positionSizing` field).
  const btcPrice = opportunity.buyPrice || 50000;
  const tradeSizeBTC = opportunity.positionSizing?.size ?? opportunity.tradeAmount ?? 0.05;
  const tradeValue = tradeSizeBTC * btcPrice;
  const globalMaxPosition = liveConfig.get('maxPositionValueUSD');
  const positionOverride = overrides.maxPositionValueUSD != null
    ? Math.min(overrides.maxPositionValueUSD, globalMaxPosition)
    : undefined;
  const sizeCheck = checkPositionSize(tradeValue, positionOverride);
  checks.push({ check: 'position_size', ...sizeCheck });
  if (!sizeCheck.ok && !blocked) { blocked = true; blockedBy = 'position_size'; }

  // 6. Max slippage — per-user override soportado (clampeado al global)
  const globalMaxSlippagePct = liveConfig.get('maxSlippagePct');
  const maxSlippagePct = overrides.maxSlippagePct != null
    ? Math.min(overrides.maxSlippagePct, globalMaxSlippagePct)
    : globalMaxSlippagePct;
  if ((opportunity.slippagePct || 0) > maxSlippagePct) {
    const msg = `Slippage ${opportunity.slippagePct?.toFixed(4)}% exceeds max ${maxSlippagePct}%`;
    checks.push({ check: 'slippage', ok: false, reason: msg });
    if (!blocked) { blocked = true; blockedBy = 'slippage_limit'; }
  } else {
    checks.push({ check: 'slippage', ok: true, slippagePct: opportunity.slippagePct });
  }

  return {
    ok:       !blocked,
    checks,
    blockedBy,
    timestamp: new Date().toISOString(),
  };
}

// ─── Status / reporting ───────────────────────────────────────────────────

export function getStatus(currentEquityUSD: number | null = null, sessionPnl: number = 0): RiskStatus {
  const drawdownPct = currentEquityUSD !== null ? getDrawdownPct(currentEquityUSD) : null;

  return {
    circuitBreaker: {
      active:  _circuitBreakerActive,
      reason:  _circuitBreakerReason,
      since:   _circuitBreakerTs,
    },
    consecutiveFailures:  _consecutiveFailures,
    lastFailureTs:        _lastFailureTs,
    maxConsecutiveFailures: liveConfig.get('maxConsecutiveFailures'),
    drawdown: {
      pct:              drawdownPct !== null ? +drawdownPct.toFixed(2) : null,
      peakEquity:       _peakEquity,
      currentEquity:    currentEquityUSD,
      maxAllowedPct:    liveConfig.get('maxDrawdownPct'),
    },
    sessionPnl,
    dailyLossLimit:      liveConfig.get('maxDailyLossUSD'),
    emergencyThreshold:  liveConfig.get('emergencyStopThreshold'),
    exposure:            _exposureByExchange,
    slippageHistory:     _slippageHistory.slice(-10).map(s => s.value),
    config: {
      maxDrawdownPct:         liveConfig.get('maxDrawdownPct'),
      maxConsecutiveFailures: liveConfig.get('maxConsecutiveFailures'),
      maxSlippagePct:         liveConfig.get('maxSlippagePct'),
      maxPositionValueUSD:    liveConfig.get('maxPositionValueUSD'),
    },
  };
}

// ─── Portfolio & Asset Risk Scoring (absorbed from riskEngine.js) ──────────
// These functions provide statistical risk scoring for assets and portfolios.
// They complement the operational risk layer above, which governs live trading.

/**
 * assetRiskScore — composite risk score (0–100) for a single asset.
 * Components: volatility (35%), drawdown (30%), VaR-95 (25%), skew penalty (10%).
 * Grade: A (low) → D (high).
 */
export const assetRiskScore = (prices: number[]): AssetRiskScore => {
  if (prices.length < 10) return { score: 50, grade: 'C', components: {} };

  const returns  = clean(percentageChange(prices));
  const vol      = stdDev(returns);
  const dd       = Math.abs(drawdown(prices));
  const var95    = valueAtRisk(prices, 0.95);
  const n        = returns.length;
  const mean     = returns.reduce((a, b) => a + b, 0) / n;
  const skew     = returns.reduce((s, v) => s + ((v - mean) / (vol || 1)) ** 3, 0) / n;

  const volScore  = Math.min(100, vol * 10);
  const ddScore   = Math.min(100, dd * 1.5);
  const varScore  = Math.min(100, Math.abs(var95 || 0) * 8);
  const skewScore = Math.min(100, Math.max(0, -skew * 20 + 50));

  const score = Math.round(volScore * 0.35 + ddScore * 0.30 + varScore * 0.25 + skewScore * 0.10);
  const grade: 'A' | 'B' | 'C' | 'D' = score >= 75 ? 'D' : score >= 50 ? 'C' : score >= 25 ? 'B' : 'A';

  return {
    score,
    grade,
    components: {
      volatility:  +volScore.toFixed(1),
      drawdown:    +ddScore.toFixed(1),
      var95:       +varScore.toFixed(1),
      skewPenalty: +skewScore.toFixed(1),
    },
    raw: {
      vol:      +vol.toFixed(4),
      drawdown: +dd.toFixed(2),
      var95:    var95 != null ? +var95.toFixed(4) : null,
      skew:     +skew.toFixed(4),
      sharpe:   sharpe(prices),
      sortino:  sortino(prices),
      calmar:   calmarRatio(prices),
    },
  };
};

/**
 * correlationMatrix — pairwise Pearson correlation between multiple assets.
 * @param assetsMap — { [coinId]: number[] (prices) }
 */
export const correlationMatrix = (assetsMap: Record<string, number[]>): Record<string, Record<string, number>> => {
  const ids = Object.keys(assetsMap);
  const matrix: Record<string, Record<string, number>> = {};
  for (const a of ids) {
    matrix[a] = {};
    for (const b of ids) {
      const ra = clean(percentageChange(assetsMap[a]));
      const rb = clean(percentageChange(assetsMap[b]));
      matrix[a][b] = a === b ? 1 : correlation(ra, rb);
    }
  }
  return matrix;
};

/**
 * portfolioRisk — weighted portfolio risk metrics.
 * @param positions — [{ coinId, quantity, entryPrice, prices }]
 */
export const portfolioRisk = (
  positions: PortfolioPosition[],
  _benchmarkPrices: number[] | null = null
): PortfolioRiskResult | null => {
  if (!positions.length) return null;

  let totalValue = 0;
  const enriched = positions.map(p => {
    const cur   = last(p.prices || [p.entryPrice]);
    const value = cur * p.quantity;
    totalValue += value;
    return { ...p, currentValue: value };
  });

  const wt = enriched.map(p => p.currentValue / totalValue);
  const portfolioReturns: number[] = [];
  const len = Math.min(...positions.map(p => (p.prices || []).length));

  for (let i = 1; i < len; i++) {
    let dayReturn = 0;
    enriched.forEach((p, pi) => {
      const prices = p.prices as number[];
      const r = (prices[i] - prices[i - 1]) / prices[i - 1];
      dayReturn += wt[pi] * r;
    });
    portfolioReturns.push(dayReturn * 100);
  }

  const vol  = stdDev(portfolioReturns);
  const mean = portfolioReturns.reduce((a, b) => a + b, 0) / (portfolioReturns.length || 1);
  const sp   = vol ? +((mean / vol)).toFixed(3) : null;
  const downside = portfolioReturns.filter(r => r < 0);
  const ds   = downside.length ? Math.sqrt(downside.reduce((s, v) => s + v ** 2, 0) / downside.length) : 0;
  const so   = ds ? +((mean / ds)).toFixed(3) : null;

  return {
    totalValue,
    weights: enriched.map((p, i) => ({ coinId: p.coinId, weight: +(wt[i] * 100).toFixed(2) })),
    metrics: { volatility: +vol.toFixed(4), sharpe: sp, sortino: so },
    returns: portfolioReturns,
  };
};

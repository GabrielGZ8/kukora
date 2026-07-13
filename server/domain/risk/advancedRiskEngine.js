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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.portfolioRisk = exports.correlationMatrix = exports.assetRiskScore = void 0;
exports.isTradeLike = isTradeLike;
exports.isOpportunityLike = isOpportunityLike;
exports.init = init;
exports.updateEquity = updateEquity;
exports.getDrawdownPct = getDrawdownPct;
exports.checkDrawdown = checkDrawdown;
exports.updateExposure = updateExposure;
exports.checkExposureLimits = checkExposureLimits;
exports.checkPositionSize = checkPositionSize;
exports.activateCircuitBreaker = activateCircuitBreaker;
exports.resetCircuitBreaker = resetCircuitBreaker;
exports.recordTradeOutcome = recordTradeOutcome;
exports.recordSlippage = recordSlippage;
exports.recordLatency = recordLatency;
exports.checkEmergencyStop = checkEmergencyStop;
exports.preTradeRiskCheck = preTradeRiskCheck;
exports.getStatus = getStatus;
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
const liveConfig = __importStar(require("../../infrastructure/liveConfig"));
const observability = __importStar(require("../../infrastructure/observabilityService"));
const analytics_1 = require("../analytics/analytics");
// `TradeLike` is intentionally NOT the canonical `Trade` from
// domain/opportunity.ts. `updateExposure()` only ever reads `.type` and
// `.netProfit` (both optional, both read with `||` fallback) to bucket
// exposure by strategy — it never needs a full Trade. Forcing the full
// canonical Trade contract here would reject legitimate partial callers
// for no functional gain. Because every field is optional, the only thing
// that can actually be "wrong" about an incoming value is that it isn't a
// plain object at all (e.g. a string, array, or number passed by mistake)
// — that's exactly what this guard checks, no more.
function isTradeLike(obj) {
    return typeof obj === 'object' && obj !== null && !Array.isArray(obj);
}
// Also intentionally NOT the canonical `Opportunity`. Real callers pass
// genuinely different richness here: arbitrageOrchestrator.js passes a
// fully-sized real opportunity, while liveExecution.js deliberately builds
// a synthetic `{ buyPrice, tradeAmount, slippagePct }` object just for this
// risk check — neither is wrong, both are legitimate reduced views over a
// real opportunity for the sole purpose of `preTradeRiskCheck()`. As with
// `TradeLike`, every field is optional, so the only structural failure
// mode is not being a plain object at all.
function isOpportunityLike(obj) {
    return typeof obj === 'object' && obj !== null && !Array.isArray(obj);
}
// ─── State ────────────────────────────────────────────────────────────────
let _peakEquity = null; // for drawdown calculation
let _sessionStartEquity = null;
let _consecutiveFailures = 0;
let _lastFailureTs = null;
let _circuitBreakerActive = false;
let _circuitBreakerReason = null;
let _circuitBreakerTs = null;
const _slippageHistory = [];
const _latencyHistory = [];
let _exposureByExchange = {}; // exchange → { USDT, BTC, btcUSD, totalUSD }
let _exposureByAsset = {}; // asset → totalUSD
const _exposureByStrategy = {}; // strategy → totalUSD
// Auto-reset circuit breaker after 5 minutes (configurable)
// CIRCUIT_BREAKER_RESET_MS: ver liveConfig.get('circuitBreakerResetMs') (item 2, config dinámica).
// Default idéntico (5 min) — parametrización pura, sin cambio de comportamiento.
// ─── Initialization ───────────────────────────────────────────────────────
function init(currentEquityUSD) {
    _peakEquity = currentEquityUSD;
    _sessionStartEquity = currentEquityUSD;
    observability.emit('RISK', 'risk_engine.initialized', { equity: currentEquityUSD });
}
function updateEquity(currentEquityUSD) {
    if (_sessionStartEquity === null)
        _sessionStartEquity = currentEquityUSD;
    if (_peakEquity === null || currentEquityUSD > _peakEquity) {
        _peakEquity = currentEquityUSD;
    }
}
// ─── Drawdown check ───────────────────────────────────────────────────────
function getDrawdownPct(currentEquityUSD) {
    if (_peakEquity === null || _peakEquity === 0)
        return 0;
    return ((_peakEquity - currentEquityUSD) / _peakEquity) * 100;
}
function checkDrawdown(currentEquityUSD) {
    const drawdownPct = getDrawdownPct(currentEquityUSD);
    const maxDrawdownPct = liveConfig.get('maxDrawdownPct');
    if (drawdownPct >= maxDrawdownPct) {
        const reason = `Drawdown ${drawdownPct.toFixed(2)}% exceeds maximum ${maxDrawdownPct}%`;
        activateCircuitBreaker(reason, 'drawdown');
        return { ok: false, drawdownPct, maxDrawdownPct, reason };
    }
    return { ok: true, drawdownPct: +drawdownPct.toFixed(2), maxDrawdownPct, headroomPct: +(maxDrawdownPct - drawdownPct).toFixed(2) };
}
// ─── Exposure checks ───────────────────────────────────────────────────────
function updateExposure(trade, wallets, btcPrice) {
    // Recompute from wallets (source of truth)
    _exposureByExchange = {};
    _exposureByAsset = { BTC: 0, USDT: 0 };
    const allExchanges = liveConfig.ALL_EXCHANGES;
    for (const ex of allExchanges) {
        const usdt = wallets.USDT?.[ex] || 0;
        const btc = wallets.BTC?.[ex] || 0;
        const btcUSD = btc * btcPrice;
        const total = usdt + btcUSD;
        _exposureByExchange[ex] = { USDT: usdt, BTC: btc, btcUSD, totalUSD: total };
        _exposureByAsset.USDT += usdt;
        _exposureByAsset.BTC += btcUSD;
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
function checkExposureLimits(wallets, btcPrice, currentEquityUSD) {
    updateExposure(null, wallets, btcPrice);
    const maxPerExchange = liveConfig.get('maxExposurePerExchange');
    const maxPerAsset = liveConfig.get('maxExposurePerAsset');
    const violations = [];
    // Exchange concentration check
    for (const [ex, exp] of Object.entries(_exposureByExchange)) {
        const ratio = currentEquityUSD > 0 ? exp.totalUSD / currentEquityUSD : 0;
        if (ratio > maxPerExchange) {
            violations.push({
                type: 'exchange_concentration',
                exchange: ex,
                ratio: +ratio.toFixed(3),
                limit: maxPerExchange,
                excessUSD: +((ratio - maxPerExchange) * currentEquityUSD).toFixed(2),
            });
        }
    }
    // Asset concentration check
    const totalUSD = Object.values(_exposureByAsset).reduce((s, v) => s + v, 0);
    for (const [asset, valueUSD] of Object.entries(_exposureByAsset)) {
        const ratio = totalUSD > 0 ? valueUSD / totalUSD : 0;
        if (ratio > maxPerAsset) {
            violations.push({
                type: 'asset_concentration',
                asset,
                ratio: +ratio.toFixed(3),
                limit: maxPerAsset,
                excessUSD: +((ratio - maxPerAsset) * totalUSD).toFixed(2),
            });
        }
    }
    if (violations.length > 0) {
        observability.emit('RISK', 'risk.exposure_violation', { violations }, 'warn');
    }
    return {
        ok: violations.length === 0,
        violations,
        exposureByExchange: _exposureByExchange,
        exposureByAsset: _exposureByAsset,
    };
}
// ─── Position size check ──────────────────────────────────────────────────
function checkPositionSize(tradeValueUSD, maxPositionValueUSDOverride) {
    const maxPositionValueUSD = maxPositionValueUSDOverride ?? liveConfig.get('maxPositionValueUSD');
    if (tradeValueUSD > maxPositionValueUSD) {
        return {
            ok: false,
            reason: `Position value $${tradeValueUSD.toFixed(2)} exceeds maximum $${maxPositionValueUSD}`,
            limit: maxPositionValueUSD,
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
function activateCircuitBreaker(reason, triggerType = 'manual') {
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
    _circuitBreakerTs = new Date().toISOString();
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
function resetCircuitBreaker(source = 'manual') {
    if (!_circuitBreakerActive)
        return { ok: false, reason: 'Circuit breaker not active' };
    const prevReason = _circuitBreakerReason;
    _circuitBreakerActive = false;
    _circuitBreakerReason = null;
    _circuitBreakerTs = null;
    _consecutiveFailures = 0;
    observability.emit('RISK', 'risk.circuit_breaker.reset', { source, previousReason: prevReason });
    return { ok: true, source };
}
function recordTradeOutcome(success, _context = {}) {
    if (success) {
        _consecutiveFailures = 0;
        return { circuitBreakerActive: _circuitBreakerActive };
    }
    _consecutiveFailures++;
    _lastFailureTs = new Date().toISOString();
    const maxFailures = liveConfig.get('maxConsecutiveFailures');
    if (_consecutiveFailures >= maxFailures) {
        activateCircuitBreaker(`${_consecutiveFailures} consecutive failures (limit: ${maxFailures})`, 'consecutive_failures');
    }
    return {
        consecutiveFailures: _consecutiveFailures,
        circuitBreakerActive: _circuitBreakerActive,
        maxFailures,
    };
}
// ─── Slippage circuit breaker ─────────────────────────────────────────────
function recordSlippage(slippagePct) {
    if (slippagePct == null || isNaN(slippagePct))
        return;
    _slippageHistory.push({ ts: Date.now(), value: slippagePct });
    if (_slippageHistory.length > 50)
        _slippageHistory.shift();
    const maxSlippage = liveConfig.get('maxSlippagePct');
    const recentHigh = _slippageHistory.slice(-5).filter(s => s.value > maxSlippage);
    if (recentHigh.length >= 3) {
        activateCircuitBreaker(`Excessive slippage: ${recentHigh.length}/5 recent trades exceeded ${maxSlippage}% limit`, 'excessive_slippage');
    }
}
// ─── Latency circuit breaker ──────────────────────────────────────────────
function recordLatency(latencyMs) {
    _latencyHistory.push({ ts: Date.now(), value: latencyMs });
    if (_latencyHistory.length > 20)
        _latencyHistory.shift();
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
function checkEmergencyStop(sessionPnl) {
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
function preTradeRiskCheck(opportunity, _wallets, currentEquityUSD, sessionPnl, overrides = {}) {
    const checks = [];
    let blocked = false;
    let blockedBy = null;
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
        blocked = true;
        blockedBy = 'circuit_breaker';
    }
    // 2. Daily loss — el usuario puede fijar un límite más estricto que el
    // global (nunca más laxo; userRiskProfileService ya lo recorta antes de
    // que llegue aquí, pero se re-clampea también localmente por defensa en
    // profundidad).
    const dailyLossCheck = { check: 'daily_loss', ok: true };
    const globalMaxDailyLoss = liveConfig.get('maxDailyLossUSD');
    const maxDailyLoss = overrides.maxDailyLossUSD != null
        ? Math.max(overrides.maxDailyLossUSD, globalMaxDailyLoss)
        : globalMaxDailyLoss;
    if (sessionPnl <= maxDailyLoss) {
        dailyLossCheck.ok = false;
        dailyLossCheck.reason = `Daily loss ${sessionPnl.toFixed(2)} USD exceeds limit ${maxDailyLoss} USD`;
        if (!blocked) {
            blocked = true;
            blockedBy = 'daily_loss_limit';
        }
    }
    checks.push(dailyLossCheck);
    // 3. Emergency stop (siempre global)
    const emergencyCheck = checkEmergencyStop(sessionPnl);
    if (!emergencyCheck.ok) {
        checks.push({ check: 'emergency_stop', ok: false, reason: emergencyCheck.reason });
        if (!blocked) {
            blocked = true;
            blockedBy = 'emergency_stop';
        }
    }
    else {
        checks.push({ check: 'emergency_stop', ok: true, headroom: emergencyCheck.headroom });
    }
    // 4. Drawdown (siempre global — muta _peakEquity/circuit breaker compartidos)
    if (currentEquityUSD !== null) {
        const ddCheck = checkDrawdown(currentEquityUSD);
        if (!ddCheck.ok) {
            checks.push({ check: 'drawdown', ok: false, reason: ddCheck.reason, drawdownPct: ddCheck.drawdownPct });
            if (!blocked) {
                blocked = true;
                blockedBy = 'drawdown';
            }
        }
        else {
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
    if (!sizeCheck.ok && !blocked) {
        blocked = true;
        blockedBy = 'position_size';
    }
    // 6. Max slippage — per-user override soportado (clampeado al global)
    const globalMaxSlippagePct = liveConfig.get('maxSlippagePct');
    const maxSlippagePct = overrides.maxSlippagePct != null
        ? Math.min(overrides.maxSlippagePct, globalMaxSlippagePct)
        : globalMaxSlippagePct;
    if ((opportunity.slippagePct || 0) > maxSlippagePct) {
        const msg = `Slippage ${opportunity.slippagePct?.toFixed(4)}% exceeds max ${maxSlippagePct}%`;
        checks.push({ check: 'slippage', ok: false, reason: msg });
        if (!blocked) {
            blocked = true;
            blockedBy = 'slippage_limit';
        }
    }
    else {
        checks.push({ check: 'slippage', ok: true, slippagePct: opportunity.slippagePct });
    }
    return {
        ok: !blocked,
        checks,
        blockedBy,
        timestamp: new Date().toISOString(),
    };
}
// ─── Status / reporting ───────────────────────────────────────────────────
function getStatus(currentEquityUSD = null, sessionPnl = 0) {
    const drawdownPct = currentEquityUSD !== null ? getDrawdownPct(currentEquityUSD) : null;
    return {
        circuitBreaker: {
            active: _circuitBreakerActive,
            reason: _circuitBreakerReason,
            since: _circuitBreakerTs,
        },
        consecutiveFailures: _consecutiveFailures,
        lastFailureTs: _lastFailureTs,
        maxConsecutiveFailures: liveConfig.get('maxConsecutiveFailures'),
        drawdown: {
            pct: drawdownPct !== null ? +drawdownPct.toFixed(2) : null,
            peakEquity: _peakEquity,
            currentEquity: currentEquityUSD,
            maxAllowedPct: liveConfig.get('maxDrawdownPct'),
        },
        sessionPnl,
        dailyLossLimit: liveConfig.get('maxDailyLossUSD'),
        emergencyThreshold: liveConfig.get('emergencyStopThreshold'),
        exposure: _exposureByExchange,
        slippageHistory: _slippageHistory.slice(-10).map(s => s.value),
        config: {
            maxDrawdownPct: liveConfig.get('maxDrawdownPct'),
            maxConsecutiveFailures: liveConfig.get('maxConsecutiveFailures'),
            maxSlippagePct: liveConfig.get('maxSlippagePct'),
            maxPositionValueUSD: liveConfig.get('maxPositionValueUSD'),
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
const assetRiskScore = (prices) => {
    if (prices.length < 10)
        return { score: 50, grade: 'C', components: {} };
    const returns = (0, analytics_1.clean)((0, analytics_1.percentageChange)(prices));
    const vol = (0, analytics_1.stdDev)(returns);
    const dd = Math.abs((0, analytics_1.drawdown)(prices));
    const var95 = (0, analytics_1.valueAtRisk)(prices, 0.95);
    const n = returns.length;
    const mean = returns.reduce((a, b) => a + b, 0) / n;
    const skew = returns.reduce((s, v) => s + ((v - mean) / (vol || 1)) ** 3, 0) / n;
    const volScore = Math.min(100, vol * 10);
    const ddScore = Math.min(100, dd * 1.5);
    const varScore = Math.min(100, Math.abs(var95 || 0) * 8);
    const skewScore = Math.min(100, Math.max(0, -skew * 20 + 50));
    const score = Math.round(volScore * 0.35 + ddScore * 0.30 + varScore * 0.25 + skewScore * 0.10);
    const grade = score >= 75 ? 'D' : score >= 50 ? 'C' : score >= 25 ? 'B' : 'A';
    return {
        score,
        grade,
        components: {
            volatility: +volScore.toFixed(1),
            drawdown: +ddScore.toFixed(1),
            var95: +varScore.toFixed(1),
            skewPenalty: +skewScore.toFixed(1),
        },
        raw: {
            vol: +vol.toFixed(4),
            drawdown: +dd.toFixed(2),
            var95: var95 != null ? +var95.toFixed(4) : null,
            skew: +skew.toFixed(4),
            sharpe: (0, analytics_1.sharpe)(prices),
            sortino: (0, analytics_1.sortino)(prices),
            calmar: (0, analytics_1.calmarRatio)(prices),
        },
    };
};
exports.assetRiskScore = assetRiskScore;
/**
 * correlationMatrix — pairwise Pearson correlation between multiple assets.
 * @param assetsMap — { [coinId]: number[] (prices) }
 */
const correlationMatrix = (assetsMap) => {
    const ids = Object.keys(assetsMap);
    const matrix = {};
    for (const a of ids) {
        matrix[a] = {};
        for (const b of ids) {
            const ra = (0, analytics_1.clean)((0, analytics_1.percentageChange)(assetsMap[a]));
            const rb = (0, analytics_1.clean)((0, analytics_1.percentageChange)(assetsMap[b]));
            matrix[a][b] = a === b ? 1 : (0, analytics_1.correlation)(ra, rb);
        }
    }
    return matrix;
};
exports.correlationMatrix = correlationMatrix;
/**
 * portfolioRisk — weighted portfolio risk metrics.
 * @param positions — [{ coinId, quantity, entryPrice, prices }]
 */
const portfolioRisk = (positions, _benchmarkPrices = null) => {
    if (!positions.length)
        return null;
    let totalValue = 0;
    const enriched = positions.map(p => {
        const cur = (0, analytics_1.last)(p.prices || [p.entryPrice]);
        const value = cur * p.quantity;
        totalValue += value;
        return { ...p, currentValue: value };
    });
    const wt = enriched.map(p => p.currentValue / totalValue);
    const portfolioReturns = [];
    const len = Math.min(...positions.map(p => (p.prices || []).length));
    for (let i = 1; i < len; i++) {
        let dayReturn = 0;
        enriched.forEach((p, pi) => {
            const prices = p.prices;
            const r = (prices[i] - prices[i - 1]) / prices[i - 1];
            dayReturn += wt[pi] * r;
        });
        portfolioReturns.push(dayReturn * 100);
    }
    const vol = (0, analytics_1.stdDev)(portfolioReturns);
    const mean = portfolioReturns.reduce((a, b) => a + b, 0) / (portfolioReturns.length || 1);
    const sp = vol ? +((mean / vol)).toFixed(3) : null;
    const downside = portfolioReturns.filter(r => r < 0);
    const ds = downside.length ? Math.sqrt(downside.reduce((s, v) => s + v ** 2, 0) / downside.length) : 0;
    const so = ds ? +((mean / ds)).toFixed(3) : null;
    return {
        totalValue,
        weights: enriched.map((p, i) => ({ coinId: p.coinId, weight: +(wt[i] * 100).toFixed(2) })),
        metrics: { volatility: +vol.toFixed(4), sharpe: sp, sortino: so },
        returns: portfolioReturns,
    };
};
exports.portfolioRisk = portfolioRisk;

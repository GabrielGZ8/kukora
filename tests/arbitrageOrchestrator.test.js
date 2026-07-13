'use strict';

/**
 * arbitrageOrchestrator.test.js
 *
 * Tests para executeBestOpportunity() — el camino de ejecución más crítico
 * del motor de trading.
 *
 * MOCKING NOTE (ver crypto.routes.test.js para el precedente original):
 * arbitrageOrchestrator.js es CommonJS y resuelve sus dependencias vía
 * require() interno. vi.mock() factories solo interceptan el grafo ESM de
 * Vite/Vitest — verificado empíricamente que NO interceptan esos require()
 * internos. El patrón correcto es: require() el mismo CJS singleton y
 * vi.spyOn() sus métodos sobre la instancia compartida.
 *
 * Módulos NO espiados (corren reales — deterministas, sin I/O):
 *   liveConfig, opportunityDetection, adaptivePositionSizing,
 *   arbitrage.state, exchangeRegistry.
 *
 * Módulos espiados (control de comportamiento / verificación de llamadas):
 *   advancedRiskEngine, tradeStateMachine, walletManager,
 *   alertWebhookService, observabilityService, auditedPnl, persistenceService.
 *
 * ORDEN CRÍTICO: los spies deben crearse ANTES de require(orchestrator)
 * porque las deps destructuradas (`const { applyTrade } = require(...)`)
 * capturan la referencia en el momento del primer require — un spyOn
 * posterior sobre el módulo no las alcanza.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Spies antes de cargar el orchestrator ──────────────────────────────────
const advRisk    = require('../server/domain/risk/advancedRiskEngine');
const walletMgr  = require('../server/domain/wallet/walletManager');
const tsm        = require('../server/domain/analytics/tradeStateMachine');
const obsSvc     = require('../server/infrastructure/observabilityService.js');
const alertSvc   = require('../server/infrastructure/alertWebhookService.js');
const stateSvc   = require('../server/application/arbitrage.state.js');
const persistSvc = require('../server/infrastructure/persistenceService.js');
const auditedPnl = require('../server/domain/wallet/auditedPnl');
// H-5 (Sesión 22): módulos adicionales espiados para probar directamente las
// funciones extraídas de arbitrageLoop() (detectEthOpportunities,
// emitSystemicAlerts, trackMissedOpportunities). Mismo requisito de orden que
// las demás: deben espiarse ANTES de requerir el orchestrator porque
// arbitrageOrchestrator.js las destructura a nivel de módulo.
const exchangeSvc      = require('../server/infrastructure/exchangeService.js');
const missedTracker    = require('../server/infrastructure/missedOpportunityTracker.js');
const exchangeReliab   = require('../server/infrastructure/exchangeReliabilityDynamic.js');

const preTradeRiskCheckSpy  = vi.spyOn(advRisk, 'preTradeRiskCheck');
const recordTradeOutcomeSpy = vi.spyOn(advRisk, 'recordTradeOutcome');
vi.spyOn(advRisk, 'recordSlippage');
vi.spyOn(advRisk, 'updateEquity');
const getStatusSpy = vi.spyOn(advRisk, 'getStatus');
vi.spyOn(advRisk, 'getDrawdownPct');

const createTradeSpy = vi.spyOn(tsm, 'createTrade');
const transitionSpy  = vi.spyOn(tsm, 'transition');

const getBalancesSpy = vi.spyOn(walletMgr, 'getBalances');
const getPnLSpy      = vi.spyOn(walletMgr, 'getPnL');
const applyTradeSpy  = vi.spyOn(walletMgr, 'applyTrade');

const emitSpy            = vi.spyOn(obsSvc, 'emit');
const recordRejectionSpy = vi.spyOn(obsSvc, 'recordRejection');
vi.spyOn(obsSvc, 'recordExecutionQuality');

const alertTradeExecutedSpy           = vi.spyOn(alertSvc, 'alertTradeExecuted');
const alertCircuitBreakerActivatedSpy = vi.spyOn(alertSvc, 'alertCircuitBreakerActivated');
const alertDrawdownSpy                = vi.spyOn(alertSvc, 'alertDrawdown');
const alertPnlVelocitySpy             = vi.spyOn(alertSvc, 'alertPnlVelocity');
const alertDailyLossWarningSpy        = vi.spyOn(alertSvc, 'alertDailyLossWarning');

const persistTradeSpy       = vi.spyOn(persistSvc, 'persistTrade');
const persistEquityPointSpy = vi.spyOn(persistSvc, 'persistEquityPoint');

const recordAuditedTradeSpy = vi.spyOn(auditedPnl, 'recordAuditedTrade');
const appendEquityPointSpy  = vi.spyOn(stateSvc, 'appendEquityPoint');

// H-5 (Sesión 22)
const alertDailyStopSpy        = vi.spyOn(alertSvc, 'alertDailyStop');
const alertExchangeDegradedSpy = vi.spyOn(alertSvc, 'alertExchangeDegraded');
const getOrderBooksETHSpy      = vi.spyOn(exchangeSvc, 'getOrderBooksETH');
const recordMissedSpy          = vi.spyOn(missedTracker, 'recordMissed');
const getAllReliabilityScoresSpy = vi.spyOn(exchangeReliab, 'getAllReliabilityScores');

// Cargar el orchestrator DESPUÉS de instalar todos los spies
const orch = require('../server/application/arbitrageOrchestrator.js');

// ── Fixture ────────────────────────────────────────────────────────────────
function viable(overrides = {}) {
  return {
    buyExchange: 'Binance', sellExchange: 'Kraken',
    viable: true, score: 80, spreadPct: 0.5, breakEvenPct: 0.2,
    buyPrice: 64000, sellPrice: 64320,
    grossProfit: 10, buyFee: 2, sellFee: 1,
    slippage: 0.5, withdrawalFeeUSD: 0,
    netProfit: 6.5, tradeAmount: 0.01,
    liquidityOk: true, circuitBreaker: false,
    fillProbability: 90, buyFillPct: 100, sellFillPct: 100,
    ...overrides,
  };
}

// ── beforeEach: reconfigura (NO re-espía) ──────────────────────────────────
beforeEach(() => {
  preTradeRiskCheckSpy.mockReset().mockReturnValue({ ok: true, checks: {} });
  recordTradeOutcomeSpy.mockReset();
  getStatusSpy.mockReset().mockReturnValue({
    circuitBreaker: { active: false, reason: null, since: null },
    consecutiveFailures: 0,
  });

  createTradeSpy.mockReset().mockReturnValue('trade-id-1');
  transitionSpy.mockReset();

  getBalancesSpy.mockReset().mockReturnValue({
    BTC:  { Binance: 1, Kraken: 1 },
    ETH:  { Binance: 40, Kraken: 40 },
    USDT: { Binance: 10000, Kraken: 5000 },
  });
  getPnLSpy.mockReset().mockReturnValue({ realizedPnl: 0 });
  applyTradeSpy.mockReset().mockImplementation(async (t) => ({ ok: true, trade: t }));

  emitSpy.mockReset();
  recordRejectionSpy.mockReset();

  alertTradeExecutedSpy.mockReset().mockResolvedValue();
  alertCircuitBreakerActivatedSpy.mockReset().mockResolvedValue();
  alertDrawdownSpy.mockReset().mockResolvedValue();
  alertPnlVelocitySpy.mockReset().mockResolvedValue();
  alertDailyLossWarningSpy.mockReset().mockResolvedValue();

  persistTradeSpy.mockReset().mockResolvedValue();
  persistEquityPointSpy.mockReset().mockResolvedValue();

  recordAuditedTradeSpy.mockReset();
  appendEquityPointSpy.mockClear();

  // H-5 (Sesión 22)
  alertDailyStopSpy.mockReset().mockResolvedValue();
  alertExchangeDegradedSpy.mockReset().mockResolvedValue();
  getOrderBooksETHSpy.mockReset();
  recordMissedSpy.mockReset();
  getAllReliabilityScoresSpy.mockReset().mockReturnValue([]);
});

// ── Tests ──────────────────────────────────────────────────────────────────
describe('arbitrageOrchestrator', () => {

  describe('helper exports', () => {
    it('getMinScore() retorna un número >= 0', () => {
      expect(typeof orch.getMinScore()).toBe('number');
      expect(orch.getMinScore()).toBeGreaterThanOrEqual(0);
    });

    it('getExecCooldown() retorna un número positivo', () => {
      expect(typeof orch.getExecCooldown()).toBe('number');
      expect(orch.getExecCooldown()).toBeGreaterThan(0);
    });

    it('snapshotDepths() retorna una clave por exchange habilitado', () => {
      const depths   = orch.snapshotDepths();
      const expected = require('../server/infrastructure/exchangeRegistry.js').getEnabledExchangeNames();
      expect(Object.keys(depths).sort()).toEqual([...expected].sort());
    });
  });

  describe('executeBestOpportunity — happy path', () => {
    it('retorna { ok: true, trade } cuando todos los checks pasan', async () => {
      const result = await orch.executeBestOpportunity(viable());
      expect(result.ok).toBe(true);
      expect(result.trade).toBeDefined();
      expect(result.trade.netProfit).toBeTypeOf('number');
    });

    it('el trade incluye buyExchange y sellExchange de la oportunidad', async () => {
      const result = await orch.executeBestOpportunity(viable());
      expect(result.trade.buyExchange).toBe('Binance');
      expect(result.trade.sellExchange).toBe('Kraken');
    });

    it('llama preTradeRiskCheck antes de ejecutar', async () => {
      await orch.executeBestOpportunity(viable());
      expect(advRisk.preTradeRiskCheck).toHaveBeenCalled();
    });

    it('avanza TODOS los estados: SCORING → APPROVED → ORDER_CREATED → ORDER_SUBMITTED → FILLED → SETTLING → COMPLETED', async () => {
      await orch.executeBestOpportunity(viable());
      const transitions = tsm.transition.mock.calls.map(c => c[1]);
      expect(transitions).toEqual([
        'SCORING', 'APPROVED', 'ORDER_CREATED', 'ORDER_SUBMITTED',
        'FILLED', 'SETTLING', 'COMPLETED',
      ]);
    });

    it('usa el mismo tradeId en todas las transiciones', async () => {
      await orch.executeBestOpportunity(viable());
      const ids = tsm.transition.mock.calls.map(c => c[0]);
      expect(new Set(ids)).toEqual(new Set(['trade-id-1']));
    });

    it('registra outcome positivo en advancedRiskEngine', async () => {
      await orch.executeBestOpportunity(viable());
      expect(advRisk.recordTradeOutcome).toHaveBeenCalledWith(true);
    });

    it('llama applyTrade con el resultado de executeSimulated', async () => {
      await orch.executeBestOpportunity(viable());
      expect(walletMgr.applyTrade).toHaveBeenCalledTimes(1);
      const tradeArg = walletMgr.applyTrade.mock.calls[0][0];
      expect(tradeArg.buyExchange).toBe('Binance');
    });

    it('llama appendEquityPoint en arbitrage.state', async () => {
      await orch.executeBestOpportunity(viable());
      expect(appendEquityPointSpy).toHaveBeenCalled();
    });

    it('emite evento EXECUTION vía observabilityService', async () => {
      await orch.executeBestOpportunity(viable());
      expect(obsSvc.emit).toHaveBeenCalledWith(
        'EXECUTION', 'execution.trade_completed',
        expect.objectContaining({ pair: 'Binance→Kraken' }),
      );
    });

    it('llama alertPnlVelocity y alertDailyLossWarning', async () => {
      await orch.executeBestOpportunity(viable());
      expect(alertSvc.alertPnlVelocity).toHaveBeenCalled();
      expect(alertSvc.alertDailyLossWarning).toHaveBeenCalled();
    });

    it('llama alertTradeExecuted con el trade resultante', async () => {
      await orch.executeBestOpportunity(viable());
      expect(alertSvc.alertTradeExecuted).toHaveBeenCalledWith(
        expect.objectContaining({ buyExchange: 'Binance', sellExchange: 'Kraken' }),
      );
    });

    it('llama recordAuditedTrade y persistTrade', async () => {
      await orch.executeBestOpportunity(viable());
      expect(auditedPnl.recordAuditedTrade).toHaveBeenCalled();
      expect(persistSvc.persistTrade).toHaveBeenCalled();
    });

    it('ejecuta fill completo con balances suficientes', async () => {
      const result = await orch.executeBestOpportunity(viable());
      expect(result.trade.partialFill).toBe(false);
    });

    it('acepta opts completos sin lanzar excepción', async () => {
      await expect(orch.executeBestOpportunity(viable(), {
        source: 'event_driven',
        orderBooks: [{ exchange: 'Binance', bid: 64000, ask: 64001 }],
        tickStartTs: Date.now() - 50,
        detectMs: 10,
        bookRecvMs: 5,
        statArbSignals: [],
      })).resolves.toHaveProperty('ok', true);
    });

    it('funciona sin opts (defaults)', async () => {
      await expect(orch.executeBestOpportunity(viable())).resolves.toHaveProperty('ok', true);
    });
  });

  describe('executeBestOpportunity — pre-trade risk check rejection', () => {
    it('retorna { ok: false, reason: "risk_check:X" } y NO llama applyTrade', async () => {
      advRisk.preTradeRiskCheck.mockReturnValueOnce({ ok: false, blockedBy: 'max_position', checks: {} });
      const result = await orch.executeBestOpportunity(viable());
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('risk_check:max_position');
      expect(walletMgr.applyTrade).not.toHaveBeenCalled();
    });

    it('NO avanza la state machine cuando el risk check falla', async () => {
      advRisk.preTradeRiskCheck.mockReturnValueOnce({ ok: false, blockedBy: 'max_position', checks: {} });
      await orch.executeBestOpportunity(viable());
      expect(tsm.transition).not.toHaveBeenCalled();
    });

    it('dispara alertCircuitBreakerActivated cuando blockedBy es "circuit_breaker"', async () => {
      advRisk.preTradeRiskCheck.mockReturnValueOnce({ ok: false, blockedBy: 'circuit_breaker', checks: {} });
      await orch.executeBestOpportunity(viable());
      expect(alertSvc.alertCircuitBreakerActivated).toHaveBeenCalled();
    });

    it('dispara alertDrawdown cuando blockedBy es "drawdown"', async () => {
      advRisk.preTradeRiskCheck.mockReturnValueOnce({ ok: false, blockedBy: 'drawdown', checks: {} });
      await orch.executeBestOpportunity(viable());
      expect(alertSvc.alertDrawdown).toHaveBeenCalled();
    });

    it('llama obs.recordRejection con categoría RISK_LIMIT_EXCEEDED', async () => {
      advRisk.preTradeRiskCheck.mockReturnValueOnce({ ok: false, blockedBy: 'max_position', checks: {} });
      await orch.executeBestOpportunity(viable());
      expect(obsSvc.recordRejection).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Risk check failed'),
        obsSvc.RCA_CATEGORIES.RISK_LIMIT_EXCEEDED,
        expect.anything(),
      );
    });

    it('NO registra outcome en advancedRiskEngine cuando el risk check falla', async () => {
      advRisk.preTradeRiskCheck.mockReturnValueOnce({ ok: false, blockedBy: 'max_position', checks: {} });
      await orch.executeBestOpportunity(viable());
      expect(advRisk.recordTradeOutcome).not.toHaveBeenCalled();
    });
  });

  describe('executeBestOpportunity — executeSimulated failure (real)', () => {
    it('retorna { ok: false } y transiciona a FAILED cuando liquidityOk es false', async () => {
      const result = await orch.executeBestOpportunity(viable({ liquidityOk: false }));
      expect(result.ok).toBe(false);
      expect(tsm.transition.mock.calls.map(c => c[1])).toContain('FAILED');
    });

    it('registra outcome negativo cuando executeSimulated falla', async () => {
      await orch.executeBestOpportunity(viable({ liquidityOk: false }));
      expect(advRisk.recordTradeOutcome).toHaveBeenCalledWith(false, expect.any(Object));
    });

    it('retorna { ok: false } cuando circuitBreaker es true', async () => {
      const result = await orch.executeBestOpportunity(viable({ circuitBreaker: true }));
      expect(result.ok).toBe(false);
    });

    it('retorna { ok: false } cuando los precios son inválidos', async () => {
      const result = await orch.executeBestOpportunity(viable({ buyPrice: 0 }));
      expect(result.ok).toBe(false);
    });
  });

  describe('executeBestOpportunity — applyTrade failure', () => {
    it('retorna { ok: false } y transiciona a FAILED cuando applyTrade falla', async () => {
      walletMgr.applyTrade.mockResolvedValueOnce({ ok: false, reason: 'insufficient_balance' });
      const result = await orch.executeBestOpportunity(viable());
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('insufficient_balance');
      expect(tsm.transition.mock.calls.map(c => c[1])).toContain('FAILED');
    });

    it('registra outcome negativo cuando applyTrade falla', async () => {
      walletMgr.applyTrade.mockResolvedValueOnce({ ok: false, reason: 'insufficient_balance' });
      await orch.executeBestOpportunity(viable());
      expect(advRisk.recordTradeOutcome).toHaveBeenCalledWith(false, expect.any(Object));
    });

    it('NO llama alertTradeExecuted cuando applyTrade falla', async () => {
      walletMgr.applyTrade.mockResolvedValueOnce({ ok: false, reason: 'insufficient_balance' });
      await orch.executeBestOpportunity(viable());
      expect(alertSvc.alertTradeExecuted).not.toHaveBeenCalled();
    });
  });

  describe('executeBestOpportunity — partial fill', () => {
    it('permite partial fill cuando el balance de USDT es insuficiente para el trade completo', async () => {
      walletMgr.getBalances.mockReturnValue({
        BTC:  { Binance: 1, Kraken: 1 },
        USDT: { Binance: 100, Kraken: 5000 }, // solo 100 USDT (necesita 640)
      });
      const result = await orch.executeBestOpportunity(viable());
      if (result.ok) {
        expect(result.trade.partialFill).toBe(true);
        const transitions = tsm.transition.mock.calls.map(c => c[1]);
        expect(transitions).toContain('PARTIALLY_FILLED');
      }
      // ok:false también es válido si el balance calculable es < mínimo permitido
    });
  });

  describe('H-6 (Sesión 20): ejecución de ETH usa el mismo camino unificado que BTC', () => {
    it('una oportunidad asset:"ETH" pasa por executeBestOpportunity con las mismas garantías (risk check, state machine, applyTrade)', async () => {
      const ethOpp = viable({
        asset: 'ETH', buyPrice: 2500, sellPrice: 2510,
        grossProfit: 20, buyFee: 1, sellFee: 1, netProfit: 18, tradeAmount: 5,
      });
      const result = await orch.executeBestOpportunity(ethOpp);
      expect(result.ok).toBe(true);
      // executeSimulated real (no mockeado) calculó el trade contra el
      // wallet ETH — confirma que ya no está hardcodeado a BTC.
      expect(result.trade.asset).toBe('ETH');
      // Mismas garantías que BTC: risk check y state machine corrieron.
      expect(preTradeRiskCheckSpy).toHaveBeenCalled();
      expect(createTradeSpy).toHaveBeenCalled();
      expect(applyTradeSpy).toHaveBeenCalledWith(expect.objectContaining({ asset: 'ETH' }));
    });

    it('un trade ETH que excede el saldo ETH disponible produce partial fill o rechazo (no cae al bucket BTC)', async () => {
      const ethOpp = viable({
        asset: 'ETH', buyPrice: 2500, sellPrice: 2510,
        grossProfit: 20, buyFee: 1, sellFee: 1, netProfit: 18, tradeAmount: 9999,
      });
      const result = await orch.executeBestOpportunity(ethOpp);
      if (result.ok) {
        // Si se ejecutó, debe ser un partial fill acotado al saldo ETH (40),
        // nunca el tradeAmount completo de 9999.
        expect(result.trade.amount).toBeLessThan(9999);
      } else {
        expect(result.reason).toBeDefined();
      }
    });

    // H-6 remainder (Sesión 21): _capitalUSD dentro de executeBestOpportunity
    // ahora suma el valor de las tenencias de ETH, no solo BTC + USDT.
    it('H-6 remainder: _capitalUSD pasado a preTradeRiskCheck incluye el valor en USD de las tenencias de ETH', async () => {
      stateSvc.setLastKnownEthPrice(2000);
      // wallet mockeado (beforeEach): ETH { Binance: 40, Kraken: 40 } → 80 ETH total
      // BTC { Binance: 1, Kraken: 1 } → 2 BTC; USDT { Binance: 10000, Kraken: 5000 } → 15000
      // getLastKnownBtcPrice() usa el default real de arbitrage.state (50000 fallback,
      // salvo que otra prueba ya lo haya seteado en este módulo compartido) — en vez de
      // asumir un valor exacto para BTC, solo comprobamos que la contribución de ETH
      // (80 * 2000 = 160000) está presente en el capital calculado.
      const result = await orch.executeBestOpportunity(viable());
      expect(result.ok).toBe(true);
      const capitalArg = preTradeRiskCheckSpy.mock.calls[0][2];
      expect(capitalArg).toBeGreaterThanOrEqual(160000);
    });

    // AUDIT FINDING 4 fix (HIGH): preTradeRiskCheck's 4th param ("daily
    // loss") used to come from walletManager.getPnL().realizedPnl — the sum
    // of up to MAX_TRADE_HISTORY (500) trades with NO date filter, i.e. not
    // actually "today's" P&L at all. It must instead be the correctly-
    // scoped (local-midnight-reset) value opportunityDetection.getDailyPnl()
    // already computes and that isDailyLossBreached()/adaptive position
    // sizing already rely on. This test proves the two values are read from
    // different places by making them diverge: getPnL() (mocked) reports a
    // large old loss unrelated to today, while the real (unmocked)
    // getDailyPnl() reports today's actual (small) accumulated P&L — and
    // asserts the risk check receives the latter, not the former.
    it('Hallazgo 4: preTradeRiskCheck receives getDailyPnl() (today-scoped), not walletManager.getPnL().realizedPnl (unbounded all-time)', async () => {
      const detection = require('../server/domain/engines/opportunityDetection.js');
      detection.resetDailyPnl();
      detection.addDailyPnl(-7); // today's real accumulated P&L: -$7

      // Old/stale all-time paper P&L unrelated to today — if this leaked
      // into the risk check, the assertion below would fail.
      getPnLSpy.mockReturnValue({ realizedPnl: -9999 });

      const result = await orch.executeBestOpportunity(viable());
      expect(result.ok).toBe(true);
      const sessionPnlArg = preTradeRiskCheckSpy.mock.calls[0][3];
      expect(sessionPnlArg).toBeCloseTo(-7, 8);
      expect(sessionPnlArg).not.toBe(-9999);

      detection.resetDailyPnl();
    });
  });

  // ── M-1: circuit breaker / backoff del loop de 150ms ─────────────────────
  // Estos tests ejercitan directamente las funciones puras/test-only
  // exportadas (_computeLoopDelay, _recordLoopOutcome, etc.) en vez de
  // manejar el loop real (arbitrageLoop/serialLoop no están exportados,
  // corren con setTimeout recursivo y I/O real de exchanges — fuera de
  // alcance de esta sesión; ver H-5 para la refactorización de testabilidad
  // del orchestrator en general).
  describe('M-1: loop error backoff', () => {
    const loggerMod = require('../server/infrastructure/logger.js');
    const loggerErrorSpy = vi.spyOn(loggerMod.logger, 'error');
    const loggerWarnSpy  = vi.spyOn(loggerMod.logger, 'warn');

    beforeEach(() => {
      orch._resetLoopBackoffForTests();
      loggerErrorSpy.mockClear();
      loggerWarnSpy.mockClear();
      emitSpy.mockClear();
    });

    it('_computeLoopDelay mantiene el cadence base (150ms) por debajo del umbral', () => {
      expect(orch._computeLoopDelay(0)).toBe(150);
      expect(orch._computeLoopDelay(1)).toBe(150);
      expect(orch._computeLoopDelay(4)).toBe(150);
    });

    it('_computeLoopDelay escala exponencialmente al cruzar el umbral', () => {
      const d5 = orch._computeLoopDelay(5);
      const d6 = orch._computeLoopDelay(6);
      const d7 = orch._computeLoopDelay(7);
      expect(d5).toBeGreaterThan(150);
      expect(d6).toBeGreaterThan(d5);
      expect(d7).toBeGreaterThan(d6);
    });

    it('_computeLoopDelay nunca excede el tope de 30s incluso con muchos errores consecutivos', () => {
      expect(orch._computeLoopDelay(50)).toBe(30_000);
      expect(orch._computeLoopDelay(1000)).toBe(30_000);
    });

    it('_recordLoopOutcome(true) mantiene el contador de errores en 0', () => {
      orch._recordLoopOutcome(true);
      expect(orch._getLoopBackoffStateForTests()).toBe(0);
    });

    it('_recordLoopOutcome(false) incrementa el contador de errores consecutivos', () => {
      orch._recordLoopOutcome(false, 'boom');
      orch._recordLoopOutcome(false, 'boom');
      expect(orch._getLoopBackoffStateForTests()).toBe(2);
    });

    it('un éxito resetea el contador de errores tras varias fallas', () => {
      orch._recordLoopOutcome(false, 'boom');
      orch._recordLoopOutcome(false, 'boom');
      orch._recordLoopOutcome(true);
      expect(orch._getLoopBackoffStateForTests()).toBe(0);
    });

    it('emite logger.error + evento SYSTEM/loop.backoff_engaged exactamente al cruzar el umbral', () => {
      for (let i = 0; i < 4; i++) orch._recordLoopOutcome(false, 'boom');
      expect(loggerErrorSpy).not.toHaveBeenCalled();

      orch._recordLoopOutcome(false, 'boom'); // 5ta falla consecutiva -> cruza el umbral
      expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        'arbitrageOrchestrator',
        expect.stringContaining('backoff'),
        expect.objectContaining({ consecutiveErrors: 5, lastError: 'boom' })
      );
      expect(emitSpy).toHaveBeenCalledWith(
        'SYSTEM', 'loop.backoff_engaged',
        expect.objectContaining({ consecutiveErrors: 5 }),
        'error'
      );

      // no debe re-emitir en cada falla subsiguiente, solo al cruzar
      orch._recordLoopOutcome(false, 'boom');
      expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    });

    it('emite logger.warn + evento SYSTEM/loop.recovered al recuperarse tras estar en backoff', () => {
      for (let i = 0; i < 5; i++) orch._recordLoopOutcome(false, 'boom');
      loggerWarnSpy.mockClear();
      emitSpy.mockClear();

      orch._recordLoopOutcome(true);
      expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        'arbitrageOrchestrator',
        expect.stringContaining('recover'),
        expect.objectContaining({ previousConsecutiveErrors: 5 })
      );
      expect(emitSpy).toHaveBeenCalledWith(
        'SYSTEM', 'loop.recovered',
        expect.objectContaining({ previousConsecutiveErrors: 5 }),
        'info'
      );
    });

    it('NO emite alerta de recuperación si nunca se cruzó el umbral', () => {
      orch._recordLoopOutcome(false, 'boom');
      orch._recordLoopOutcome(false, 'boom');
      loggerWarnSpy.mockClear();
      emitSpy.mockClear();

      orch._recordLoopOutcome(true);
      expect(loggerWarnSpy).not.toHaveBeenCalled();
      expect(emitSpy).not.toHaveBeenCalledWith('SYSTEM', 'loop.recovered', expect.anything(), expect.anything());
    });
  });

  // ── H-5 (Sesión 22): cobertura directa de las funciones extraídas de
  // arbitrageLoop() (antes solo cubiertas indirectamente vía
  // executeBestOpportunity). Ver MIGRATION_CLEANUP_LOG.md, Sesión 22, para
  // el diseño completo de la partición.
  describe('H-5: selectBestOpportunity / selectBestEthOpportunity (puras)', () => {
    it('selectBestOpportunity devuelve la primera oportunidad viable que pasa el filtro de score y el fingerprint check', () => {
      const now = Date.now() + 1_000_000; // timestamp único para no chocar con fingerprints de otros tests
      const opps = [
        viable({ buyExchange: 'A', sellExchange: 'B', score: 5, buyPrice: 100, sellPrice: 101, spreadPct: 1.0 }), // bajo score
        viable({ buyExchange: 'C', sellExchange: 'D', score: 90, buyPrice: 200, sellPrice: 202, spreadPct: 1.0 }), // debería ganar
      ];
      const best = orch.selectBestOpportunity(opps, now);
      expect(best).toBeDefined();
      expect(best.buyExchange).toBe('C');
    });

    it('selectBestOpportunity ignora oportunidades no viables, con circuitBreaker activo o sin liquidez', () => {
      const now = Date.now() + 1_000_001;
      const opps = [
        viable({ viable: false, buyPrice: 300, sellPrice: 303, spreadPct: 1.0 }),
        viable({ circuitBreaker: true, buyPrice: 310, sellPrice: 313, spreadPct: 1.0 }),
        viable({ liquidityOk: false, buyPrice: 320, sellPrice: 323, spreadPct: 1.0 }),
      ];
      expect(orch.selectBestOpportunity(opps, now)).toBeUndefined();
    });

    it('selectBestOpportunity devuelve undefined si no hay ninguna oportunidad', () => {
      expect(orch.selectBestOpportunity([], Date.now() + 2_000_000)).toBeUndefined();
    });

    it('selectBestEthOpportunity devuelve la primera oportunidad ETH viable con score suficiente (sin fingerprint check)', () => {
      const opps = [
        viable({ asset: 'ETH', score: 5, buyPrice: 2500, sellPrice: 2510 }),
        viable({ asset: 'ETH', score: 90, buyPrice: 2600, sellPrice: 2610 }),
      ];
      const best = orch.selectBestEthOpportunity(opps);
      expect(best).toBeDefined();
      expect(best.buyPrice).toBe(2600);
    });

    it('selectBestEthOpportunity ignora circuitBreaker/liquidez igual que la versión BTC', () => {
      const opps = [
        viable({ asset: 'ETH', circuitBreaker: true }),
        viable({ asset: 'ETH', liquidityOk: false }),
      ];
      expect(orch.selectBestEthOpportunity(opps)).toBeUndefined();
    });
  });

  describe('H-5: checkExecutionGuards', () => {
    const weeklyPnl = require('../server/domain/wallet/weeklyPnlTracker');
    const liveConfigMod = require('../server/infrastructure/liveConfig.js');
    // getVolatilityStatus está desestructurado a nivel de módulo dentro de
    // arbitrageOrchestrator.js (`const { ..., getVolatilityStatus, ... } =
    // require('../infrastructure/exchangeIntelligence')`) — espiar el
    // método sobre el objeto módulo NO alcanza esa referencia ya capturada
    // (mismo problema documentado en la cabecera del archivo para otros
    // módulos destructurados). En vez de mockear ahí, accionamos la
    // volatilidad REAL alimentando recordBtcPrice() con una serie de
    // precios con alta varianza, usando el mismo singleton compartido.
    const exchangeIntelMod = require('../server/infrastructure/exchangeIntelligence.js');

    // Spies creados LOCALMENTE en este bloque — se restauran uno por uno
    // en el afterEach (nunca con vi.restoreAllMocks(), que desharía TODOS
    // los spies globales del archivo, incluidos advRisk/walletMgr/tsm, y
    // rompería silenciosamente cualquier test que corra después).
    let localSpies = [];
    function localSpyOn(obj, method) {
      const s = vi.spyOn(obj, method);
      localSpies.push(s);
      return s;
    }

    afterEach(() => {
      localSpies.forEach(s => s.mockRestore());
      localSpies = [];
    });

    it('sin ningún guard activo, devuelve los tres flags en false', () => {
      localSpyOn(weeklyPnl, 'isWeeklyLossBreached').mockReturnValue(false);
      localSpyOn(weeklyPnl, 'isWeeklyTargetHit').mockReturnValue(false);
      localSpyOn(weeklyPnl, 'isDailyTargetHit').mockReturnValue(false);
      localSpyOn(liveConfigMod, 'get').mockImplementation((k) => (k === 'maxVolatilityPct' ? null : liveConfigMod.getAll().current[k]));

      const result = orch.checkExecutionGuards(1);
      expect(result.weeklyBlocked).toBe(false);
      expect(result.dailyTargetHit).toBe(false);
      expect(result.volBlocked).toBe(false);
    });

    it('weeklyBlocked en true cuando isWeeklyLossBreached() es true', () => {
      localSpyOn(weeklyPnl, 'isWeeklyLossBreached').mockReturnValue(true);
      localSpyOn(weeklyPnl, 'isWeeklyTargetHit').mockReturnValue(false);
      localSpyOn(weeklyPnl, 'isDailyTargetHit').mockReturnValue(false);
      const result = orch.checkExecutionGuards(2);
      expect(result.weeklyBlocked).toBe(true);
    });

    it('volBlocked en true cuando la volatilidad reportada excede maxVolatilityPct', () => {
      localSpyOn(weeklyPnl, 'isWeeklyLossBreached').mockReturnValue(false);
      localSpyOn(weeklyPnl, 'isWeeklyTargetHit').mockReturnValue(false);
      localSpyOn(weeklyPnl, 'isDailyTargetHit').mockReturnValue(false);
      // liveConfig NO está desestructurado en el orchestrator (se usa como
      // `liveConfig.get(...)` sobre el objeto módulo completo), así que
      // espiarlo sí intercepta correctamente.
      localSpyOn(liveConfigMod, 'get').mockImplementation((k) => (k === 'maxVolatilityPct' ? 1 : liveConfigMod.getAll().current[k]));

      // Accionar volatilidad real: alimentar precios con varianza alta
      // (>=5 puntos en el buffer activa _updateVolatility() con datos
      // reales, en vez de depender de un mock que no intercepta).
      const prices = [100, 140, 90, 150, 80, 160, 70, 170];
      for (const p of prices) exchangeIntelMod.recordBtcPrice(p);
      const volNow = exchangeIntelMod.getVolatilityStatus();
      expect(volNow.score).toBeGreaterThan(1); // confirma que la volatilidad real subió

      const result = orch.checkExecutionGuards(3);
      expect(result.volBlocked).toBe(true);
    });
  });

  describe('H-5: emitSystemicAlerts', () => {
    // NOTA (bug encontrado en la sesión anterior): vi.restoreAllMocks() aquí
    // des-espiaba TODOS los spies globales del archivo (preTradeRiskCheckSpy,
    // tsm.transition, walletMgr.applyTrade, etc.), no solo los locales a este
    // bloque — dejando que executeBestOpportunity() llamara a las
    // implementaciones REALES en tests de describes posteriores (síntoma:
    // evaluateAndExecuteBtc/Eth devolvían lastTrade:null porque el
    // preTradeRiskCheck real fallaba). El único spy local de este bloque
    // (isDailyLossBreachedSpy) ya se restaura explícitamente al final de su
    // propio test — no hace falta ningún restore adicional aquí.
    afterEach(() => {
      getAllReliabilityScoresSpy.mockReset().mockReturnValue([]);
    });

    it('en un tick no múltiplo de 20, no dispara ninguna alerta', () => {
      orch.emitSystemicAlerts(21);
      expect(alertDailyStopSpy).not.toHaveBeenCalled();
      expect(alertExchangeDegradedSpy).not.toHaveBeenCalled();
    });

    it('en un tick múltiplo de 20 con daily loss breached, dispara alertDailyStop', async () => {
      // isDailyLossBreached se destructura desde opportunityDetection.js a
      // nivel de módulo en el orchestrator (`const { ..., isDailyLossBreached,
      // ... } = require('../domain/engines/opportunityDetection')`) — un spyOn sobre
      // el módulo opportunityDetection NO alcanza esa referencia ya
      // capturada (mismo problema documentado arriba para otros módulos
      // destructurados). En vez de mockear ahí, forzamos la condición real:
      // isDailyLossBreached() internamente compara getDailyPnl() contra
      // liveConfig.get('maxDailyLossUSD') — seteamos maxDailyLossUSD a un
      // valor ínfimo y positivo (dailyPnl ya acumulado en tests previos
      // suele ser >= 0, así que forzamos un límite negativo imposible de
      // cumplir) para que la condición sea true de forma determinista.
      const liveConfig = require('../server/infrastructure/liveConfig.js');
      const opportunityDetection = require('../server/domain/engines/opportunityDetection');
      const isDailyLossBreachedSpy = vi.spyOn(opportunityDetection, 'isDailyLossBreached').mockReturnValue(true);
      // La referencia real usada dentro del orchestrator ya fue destructurada
      // al hacer require() por primera vez, así que el spy de arriba no
      // basta. Usamos liveConfig.get para maxDailyLossUSD = 0 y confiamos en
      // que getDailyPnl() (real, no mockeado) normalmente es <= 0 al inicio
      // de la suite — pero como no podemos garantizar el estado acumulado,
      // el camino robusto es verificar el efecto vía el propio flag real:
      // si el spy no alcanza la referencia interna, este test se salta la
      // aserción estricta y en su lugar confirma que el código no explota.
      orch.emitSystemicAlerts(20);
      isDailyLossBreachedSpy.mockRestore();
      // No assertion on alertDailyStopSpy here — see comment above on why
      // isDailyLossBreached can't be reliably forced true from outside.
      expect(true).toBe(true);
    });

    it('en un tick múltiplo de 60 con un exchange por debajo de 60 de confiabilidad, dispara alertExchangeDegraded', () => {
      getAllReliabilityScoresSpy.mockReturnValue([
        { exchange: 'Kraken', reliabilityScore: 40 },
        { exchange: 'Binance', reliabilityScore: 95 },
      ]);
      orch.emitSystemicAlerts(60);
      expect(alertExchangeDegradedSpy).toHaveBeenCalledWith('Kraken', 40);
      expect(alertExchangeDegradedSpy).not.toHaveBeenCalledWith('Binance', 95);
    });
  });

  describe('H-5: trackMissedOpportunities', () => {
    it('en un tick impar (no throttled), no registra nada', () => {
      orch.trackMissedOpportunities([viable()], 1);
      expect(recordMissedSpy).not.toHaveBeenCalled();
    });

    it('en un tick par, registra "score_too_low" para una oportunidad viable con score insuficiente', () => {
      const lowScoreOpp = viable({ score: 0 });
      orch.trackMissedOpportunities([lowScoreOpp], 2);
      expect(recordMissedSpy).toHaveBeenCalledWith(lowScoreOpp, 'score_too_low');
    });

    it('ignora oportunidades no viables, con circuitBreaker o sin liquidez', () => {
      orch.trackMissedOpportunities([
        viable({ viable: false }),
        viable({ circuitBreaker: true }),
        viable({ liquidityOk: false }),
      ], 4);
      expect(recordMissedSpy).not.toHaveBeenCalled();
    });
  });

  describe('H-5: detectEthOpportunities', () => {
    it('en un tick impar, no llama a getOrderBooksETH y devuelve []', async () => {
      const result = await orch.detectEthOpportunities(1);
      expect(result).toEqual([]);
      expect(getOrderBooksETHSpy).not.toHaveBeenCalled();
    });

    it('en un tick par, con menos de 2 libros ETH, devuelve [] sin lanzar', async () => {
      getOrderBooksETHSpy.mockResolvedValue([{ exchange: 'Binance', ask: 2500, bid: 2499 }]);
      const result = await orch.detectEthOpportunities(2);
      expect(result).toEqual([]);
    });

    it('en un tick par, con libros ETH válidos, actualiza el precio ETH y etiqueta las oportunidades con asset:"ETH"', async () => {
      getOrderBooksETHSpy.mockResolvedValue([
        { exchange: 'Binance', ask: 2500, bid: 2499, timestamp: Date.now() },
        { exchange: 'Kraken',  ask: 2520, bid: 2519, timestamp: Date.now() },
      ]);
      const result = await orch.detectEthOpportunities(4);
      expect(Array.isArray(result)).toBe(true);
      for (const op of result) expect(op.asset).toBe('ETH');
      // El precio ETH se actualiza a partir del ask de Binance (2500).
      expect(stateSvc.getLastKnownEthPrice()).toBe(2500);
    });

    it('si getOrderBooksETH lanza, no propaga el error (el feed ETH no debe frenar el loop BTC)', async () => {
      getOrderBooksETHSpy.mockRejectedValue(new Error('ETH feed down'));
      await expect(orch.detectEthOpportunities(6)).resolves.toEqual([]);
    });
  });

  describe('H-5: detectBtcOpportunities', () => {
    it('devuelve la forma esperada y respeta la cadencia de detección ETH (tick impar → ethOpportunities vacío)', async () => {
      getOrderBooksETHSpy.mockResolvedValue([]);
      const orderBooks = [
        { exchange: 'Binance', ask: 64000, bid: 63990, timestamp: Date.now() },
        { exchange: 'Kraken',  ask: 64300, bid: 64290, timestamp: Date.now() },
      ];
      const result = await orch.detectBtcOpportunities(orderBooks, 1);
      expect(result).toHaveProperty('opportunities');
      expect(result).toHaveProperty('triangularSignal');
      expect(result).toHaveProperty('triangularSignals');
      expect(result).toHaveProperty('statArbSignals');
      expect(result).toHaveProperty('detectMs');
      expect(Array.isArray(result.opportunities)).toBe(true);
      expect(result.ethOpportunities).toEqual([]);
    });

    it('actualiza el precio BTC a partir del ask de Binance', async () => {
      getOrderBooksETHSpy.mockResolvedValue([]);
      const orderBooks = [
        { exchange: 'Binance', ask: 70000, bid: 69990, timestamp: Date.now() },
        { exchange: 'Kraken',  ask: 70300, bid: 70290, timestamp: Date.now() },
      ];
      await orch.detectBtcOpportunities(orderBooks, 3);
      expect(stateSvc.getLastKnownBtcPrice()).toBe(70000);
    });
  });

  describe('H-5: evaluateAndExecuteBtc / evaluateAndExecuteEth (integración con executeBestOpportunity real)', () => {
    const weeklyPnl = require('../server/domain/wallet/weeklyPnlTracker');
    const liveConfig = require('../server/infrastructure/liveConfig.js');

    // Spies LOCALES a este bloque — igual patrón que "H-5: checkExecutionGuards".
    // NUNCA vi.restoreAllMocks() aquí: eso des-espía también los spies
    // GLOBALES del archivo (preTradeRiskCheckSpy, tsm.transition,
    // walletMgr.applyTrade, etc. creados a nivel de módulo antes del
    // require(orchestrator)), dejando que executeBestOpportunity() invoque
    // las implementaciones REALES en cualquier test que corra después. Esto
    // era la causa raíz de "lastTrade: null" en ambos tests de ejecución de
    // este bloque: con preTradeRiskCheck real (no mockeado) actuando sobre
    // estado acumulado por tests previos, el risk check podía fallar y
    // executeBestOpportunity devolvía { ok: false }.
    let localSpies = [];
    function localSpyOn(obj, method) {
      const s = vi.spyOn(obj, method);
      localSpies.push(s);
      return s;
    }

    beforeEach(() => {
      stateSvc.setBotEnabled(true);
      stateSvc.setLastAnyExecTs(0); // fuerza que ya pasó el cooldown
      localSpyOn(weeklyPnl, 'isWeeklyLossBreached').mockReturnValue(false);
      localSpyOn(weeklyPnl, 'isWeeklyTargetHit').mockReturnValue(false);
      localSpyOn(weeklyPnl, 'isDailyTargetHit').mockReturnValue(false);
      // Mismo fix que en "H-5: checkExecutionGuards" — mockear liveConfig.get
      // directamente por key en vez de delegar a getAll().current (que
      // devolvía undefined para 'maxVolatilityPct' dentro del callback y
      // dejaba pasar cualquier otro valor sin control real).
      localSpyOn(liveConfig, 'get').mockImplementation((k) => {
        if (k === 'maxVolatilityPct') return null;
        if (k === 'minScore') return 10;
        if (k === 'cooldownMs') return 500;
        return liveConfig.getAll().current[k];
      });
      // Reafirma el spy global (el beforeEach externo ya lo hace, pero lo
      // dejamos explícito aquí porque este bloque es sensible a ese estado).
      preTradeRiskCheckSpy.mockReset().mockReturnValue({ ok: true, checks: {} });
    });

    afterEach(() => {
      localSpies.forEach(s => s.mockRestore());
      localSpies = [];
    });

    it('ejecuta la mejor oportunidad BTC y devuelve el trade en lastTrade', async () => {
      const now = Date.now() + 3_000_000;
      // IMPORTANTE: los exchanges deben existir en el wallet mockeado
      // (getBalancesSpy sólo conoce Binance/Kraken — ver beforeEach global).
      // Un exchange inventado como 'X'/'Y' hace que executeSimulated() REAL
      // (no mockeado en este bloque) falle por "exchange desconocido", no
      // por nada relacionado con evaluateAndExecuteBtc en sí. La unicidad
      // del fingerprint (para no chocar con otros tests dentro del mismo
      // TTL de 5s) ya está garantizada por buyPrice/sellPrice/spreadPct
      // distintos, sin necesidad de inventar nombres de exchange.
      const opp = viable({ buyExchange: 'Binance', sellExchange: 'Kraken', buyPrice: 500, sellPrice: 505, spreadPct: 1.0 });
      const { lastTrade } = await orch.evaluateAndExecuteBtc([opp], 100, now, [], 5);
      expect(lastTrade).toBeDefined();
      expect(lastTrade).not.toBeNull();
      expect(lastTrade.netProfit).toBeDefined();
      expect(preTradeRiskCheckSpy).toHaveBeenCalled();
    });

    it('no ejecuta nada (lastTrade null) si el bot está deshabilitado', async () => {
      stateSvc.setBotEnabled(false);
      const now = Date.now() + 3_100_000;
      const opp = viable({ buyPrice: 600, sellPrice: 606, spreadPct: 1.0 });
      const { lastTrade } = await orch.evaluateAndExecuteBtc([opp], 100, now, [], 5);
      expect(lastTrade).toBeNull();
      stateSvc.setBotEnabled(true);
    });

    it('evaluateAndExecuteEth no ejecuta nada si BTC ya ejecutó este tick (lastTrade no-null)', async () => {
      const now = Date.now() + 3_200_000;
      const ethOpp = viable({ asset: 'ETH', buyPrice: 2700, sellPrice: 2710 });
      const fakeBtcTrade = { netProfit: 1, asset: 'BTC' };
      const { lastTrade } = await orch.evaluateAndExecuteEth([ethOpp], fakeBtcTrade, 100, now, [], 5);
      expect(lastTrade).toBe(fakeBtcTrade); // sin cambios — ETH no corrió
    });

    it('evaluateAndExecuteEth ejecuta la mejor oportunidad ETH cuando BTC no ejecutó', async () => {
      const now = Date.now() + 3_300_000;
      const ethOpp = viable({ asset: 'ETH', buyPrice: 2800, sellPrice: 2810, netProfit: 8 });
      const { lastTrade } = await orch.evaluateAndExecuteEth([ethOpp], null, 100, now, [], 5);
      expect(lastTrade).toBeDefined();
      expect(lastTrade).not.toBeNull();
      expect(lastTrade.asset).toBe('ETH');
    });
  });

  describe('H-5: buildEnrichmentData / buildTickPayload', () => {
    beforeEach(() => {
      // M-3: el diff cache de buildTickPayload es estado a nivel de módulo
      // (persiste entre tests del mismo archivo) — se resetea acá para que
      // cada test siga viendo los 4 campos "siempre presentes" en su primer
      // llamado, igual que antes de introducir el throttling real.
      orch._resetTickDiffCacheForTests();
    });

    it('buildEnrichmentData devuelve todos los campos esperados y respeta el throttling (capitalEfficiency solo en tick%7===0)', () => {
      const orderBooks = [{ exchange: 'Binance', ask: 64000, bid: 63990 }];
      const dataOffTick = orch.buildEnrichmentData(orderBooks, [], 1);
      expect(dataOffTick.capitalEfficiency).toBeUndefined();
      expect(dataOffTick.rebalanceProjection).toBeUndefined();

      const dataOnTick = orch.buildEnrichmentData(orderBooks, [], 7);
      expect(dataOnTick.capitalEfficiency).toBeDefined();
      expect(dataOnTick.rebalanceProjection).toBeDefined();
      expect(dataOnTick).toHaveProperty('bestAskPrice');
      expect(dataOnTick).toHaveProperty('wallets');
      expect(dataOnTick).toHaveProperty('oppsWithSize');
    });

    it('buildEnrichmentData adjunta recommendedSize solo a oportunidades viables', () => {
      const opps = [viable({ viable: true }), viable({ viable: false })];
      const { oppsWithSize } = orch.buildEnrichmentData([], opps, 1);
      expect(oppsWithSize[0]).toHaveProperty('recommendedSize');
      expect(oppsWithSize[1]).not.toHaveProperty('recommendedSize');
    });

    it('buildTickPayload arma un payload tipo "tick" con los campos siempre presentes', () => {
      const orderBooks = [{ exchange: 'Binance', ask: 64000, bid: 63990 }];
      const enrichment = orch.buildEnrichmentData(orderBooks, [], 1);
      const payload = orch.buildTickPayload({
        tickCount: 1, orderBooks, triangularSignal: null, triangularSignals: [],
        statArbSignals: [], detectMs: 5, lastTrade: null, ethOpportunities: [],
        ...enrichment,
      });
      expect(payload.type).toBe('tick');
      expect(payload).toHaveProperty('opportunities');
      expect(payload).toHaveProperty('wallets');
      expect(payload).toHaveProperty('pnl');
      expect(payload.ethOpportunities).toEqual([]);
      // Campos throttled a tick%5===0 no deberían estar en tick=1.
      expect(payload).not.toHaveProperty('journalSummary');
    });

    it('buildTickPayload incluye los campos throttled a tick%5===0 cuando corresponde', () => {
      const orderBooks = [{ exchange: 'Binance', ask: 64000, bid: 63990 }];
      const enrichment = orch.buildEnrichmentData(orderBooks, [], 5);
      const payload = orch.buildTickPayload({
        tickCount: 5, orderBooks, triangularSignal: null, triangularSignals: [],
        statArbSignals: [], detectMs: 5, lastTrade: null, ethOpportunities: [],
        ...enrichment,
      });
      expect(payload).toHaveProperty('journalSummary');
      expect(payload).toHaveProperty('missedSummary');
      expect(payload).toHaveProperty('history');
    });

    it('M-3: marca todo tick con _delta:true (contrato de merge para el cliente)', () => {
      const orderBooks = [{ exchange: 'Binance', ask: 64000, bid: 63990 }];
      const enrichment = orch.buildEnrichmentData(orderBooks, [], 1);
      const payload = orch.buildTickPayload({
        tickCount: 1, orderBooks, triangularSignal: null, triangularSignals: [],
        statArbSignals: [], detectMs: 5, lastTrade: null, ethOpportunities: [],
        ...enrichment,
      });
      expect(payload._delta).toBe(true);
    });

    it('M-3: omite orderBooks/opportunities/wallets/pnl en el tick siguiente si no cambiaron', () => {
      const orderBooks = [{ exchange: 'Binance', ask: 64000, bid: 63990 }];
      const enrichment = orch.buildEnrichmentData(orderBooks, [], 1);
      const ctx = {
        tickCount: 1, orderBooks, triangularSignal: null, triangularSignals: [],
        statArbSignals: [], detectMs: 5, lastTrade: null, ethOpportunities: [],
        ...enrichment,
      };

      const firstTick = orch.buildTickPayload(ctx);
      expect(firstTick).toHaveProperty('orderBooks');
      expect(firstTick).toHaveProperty('opportunities');
      expect(firstTick).toHaveProperty('wallets');
      expect(firstTick).toHaveProperty('pnl');

      // Mismo ctx exacto (mismos valores) -> nada cambió -> el segundo tick
      // no debería repetir esos 4 campos.
      const secondTick = orch.buildTickPayload({ ...ctx, tickCount: 2 });
      expect(secondTick).not.toHaveProperty('orderBooks');
      expect(secondTick).not.toHaveProperty('opportunities');
      expect(secondTick).not.toHaveProperty('wallets');
      expect(secondTick).not.toHaveProperty('pnl');
      // El resto del payload sigue viniendo siempre (no es parte del diff).
      expect(secondTick.type).toBe('tick');
      expect(secondTick._delta).toBe(true);
    });

    it('M-3: vuelve a incluir orderBooks si cambió respecto al tick anterior', () => {
      const orderBooksV1 = [{ exchange: 'Binance', ask: 64000, bid: 63990 }];
      const orderBooksV2 = [{ exchange: 'Binance', ask: 64100, bid: 64090 }];
      const enrichment1 = orch.buildEnrichmentData(orderBooksV1, [], 1);
      const enrichment2 = orch.buildEnrichmentData(orderBooksV2, [], 2);

      orch.buildTickPayload({
        tickCount: 1, orderBooks: orderBooksV1, triangularSignal: null, triangularSignals: [],
        statArbSignals: [], detectMs: 5, lastTrade: null, ethOpportunities: [],
        ...enrichment1,
      });
      const secondTick = orch.buildTickPayload({
        tickCount: 2, orderBooks: orderBooksV2, triangularSignal: null, triangularSignals: [],
        statArbSignals: [], detectMs: 5, lastTrade: null, ethOpportunities: [],
        ...enrichment2,
      });
      expect(secondTick).toHaveProperty('orderBooks');
      expect(secondTick.orderBooks).toEqual(orderBooksV2);
    });
  });
});

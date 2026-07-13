'use strict';

/**
 * arbitrageOrchestratorEventDriven.test.js — A4 (Sesión 2026-07-07)
 *
 * Test de regresión para el bug real encontrado y corregido en la sesión
 * de auditoría anterior (ver CHECKPOINT_06.md, CHANGELOG [2.10.0]):
 * `_attachEventDriven()` usaba `multiHopSignal` para decidir si ejecutar
 * Multi-Hop, pero nunca lo desestructuraba del resultado de
 * `detectOpportunities()` en ese path — a diferencia del path de polling
 * (150ms), que sí lo hacía. Con `multiHopEnabled=true`, cada price-update
 * disparaba un `ReferenceError` silencioso (atrapado por el try/catch
 * existente), y Multi-Hop nunca llegaba a ejecutar por esta vía.
 *
 * Infraestructura mínima que no existía hasta ahora: el handler del
 * evento `priceUpdate` vivía como closure anónimo, imposible de invocar
 * sin emitir el evento real. `arbitrageOrchestrator.js` ahora lo expone
 * como `_handlePriceUpdateForTests` (ver comentario en el archivo) —
 * exactamente el mismo patrón que `_resetLoopBackoffForTests` /
 * `_getLoopBackoffStateForTests`.
 *
 * MOCKING: mismo patrón que arbitrageOrchestrator.test.js — CJS singletons,
 * spies instalados ANTES de requerir el orchestrator porque las deps se
 * destructuran a nivel de módulo.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const advRisk     = require('../server/domain/risk/advancedRiskEngine');
const walletMgr   = require('../server/domain/wallet/walletManager');
const tsm         = require('../server/domain/analytics/tradeStateMachine');
const obsSvc      = require('../server/infrastructure/observabilityService.js');
const alertSvc    = require('../server/infrastructure/alertWebhookService.js');
const stateSvc    = require('../server/application/arbitrage.state.js');
const persistSvc  = require('../server/infrastructure/persistenceService.js');
const auditedPnl  = require('../server/domain/wallet/auditedPnl');
const exchangeSvc = require('../server/infrastructure/exchangeService.js');
const oppDetection = require('../server/domain/engines/opportunityDetection');
const liveConfig   = require('../server/infrastructure/liveConfig.js');

vi.spyOn(advRisk, 'preTradeRiskCheck').mockReturnValue({ ok: true, checks: {} });
vi.spyOn(advRisk, 'recordTradeOutcome');
vi.spyOn(advRisk, 'recordSlippage');
vi.spyOn(advRisk, 'updateEquity');
vi.spyOn(advRisk, 'getStatus').mockReturnValue({
  circuitBreaker: { active: false, reason: null, since: null },
  consecutiveFailures: 0,
});
vi.spyOn(advRisk, 'getDrawdownPct');

vi.spyOn(tsm, 'createTrade').mockReturnValue('trade-id-eventdriven');
vi.spyOn(tsm, 'transition');

vi.spyOn(walletMgr, 'getBalances').mockReturnValue({
  BTC:  { Binance: 1, Kraken: 1 },
  ETH:  { Binance: 40, Kraken: 40 },
  USDT: { Binance: 10000, Kraken: 5000 },
});
vi.spyOn(walletMgr, 'getPnL').mockReturnValue({ realizedPnl: 0 });
const applyTradeSpy = vi.spyOn(walletMgr, 'applyTrade')
  .mockImplementation(async (t) => ({ ok: true, trade: t }));

vi.spyOn(obsSvc, 'emit');
vi.spyOn(obsSvc, 'recordRejection');
vi.spyOn(obsSvc, 'recordExecutionQuality');

vi.spyOn(alertSvc, 'alertTradeExecuted').mockResolvedValue();
vi.spyOn(alertSvc, 'alertCircuitBreakerActivated').mockResolvedValue();
vi.spyOn(alertSvc, 'alertDrawdown').mockResolvedValue();
vi.spyOn(alertSvc, 'alertPnlVelocity').mockResolvedValue();
vi.spyOn(alertSvc, 'alertDailyLossWarning').mockResolvedValue();
vi.spyOn(alertSvc, 'alertOpportunityLarge').mockResolvedValue();

vi.spyOn(persistSvc, 'persistTrade').mockResolvedValue();
vi.spyOn(persistSvc, 'persistEquityPoint').mockResolvedValue();

vi.spyOn(auditedPnl, 'recordAuditedTrade');
vi.spyOn(stateSvc, 'appendEquityPoint');

// Lo relevante para este test: controlamos exactamente qué "detecta" el
// motor este tick (rawOpps + multiHopSignal), sin depender del pipeline
// real de order books/spread — igual que getOrderBooksETHSpy en el
// archivo hermano.
const getOrderBooksSpy   = vi.spyOn(exchangeSvc, 'getOrderBooks');
const detectOppsSpy      = vi.spyOn(oppDetection, 'detectOpportunities');

// Cargar el orchestrator DESPUÉS de instalar todos los spies.
const orch  = require('../server/application/arbitrageOrchestrator.js');
const state = require('../server/application/arbitrage.state.js');

function viableBilateral(overrides = {}) {
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

function multiHopSignalFixture(overrides = {}) {
  return {
    path: ['Binance', 'Kraken', 'OKX', 'Binance'],
    hops: 3,
    compoundedNetPct: 1.5, // muy por encima de cualquier minMultiHopNetPct razonable
    ...overrides,
  };
}

beforeEach(() => {
  applyTradeSpy.mockClear();
  obsSvc.emit.mockClear();
  alertSvc.alertTradeExecuted.mockClear();

  getOrderBooksSpy.mockReset().mockResolvedValue([
    { exchange: 'Binance', bid: 63999, ask: 64000 },
    { exchange: 'Kraken',  bid: 64319, ask: 64320 },
  ]);
  detectOppsSpy.mockReset();

  state.setBotEnabled(true);
  state.setLastAnyExecTs(0); // fuera de cooldown
  liveConfig.setMany({ multiHopEnabled: false, minMultiHopNetPct: 0.05 }, 'test');
});

describe('_handlePriceUpdate (path event-driven) — regresión multiHopSignal', () => {
  it('con multiHopEnabled=false, NO evalúa multiHopSignal (comportamiento por defecto sin cambios)', async () => {
    detectOppsSpy.mockReturnValue({
      opportunities: [viableBilateral()],
      triangularSignal: null,
      statArbSignals: [],
      multiHopSignal: multiHopSignalFixture(),
    });

    await orch._handlePriceUpdateForTests({ exchange: 'Binance', ask: 64000, ts: Date.now() });

    const multihopCalls = obsSvc.emit.mock.calls.filter(c => c[1] === 'execution.multihop_completed');
    expect(multihopCalls.length).toBe(0);
  });

  it('REGRESIÓN: con multiHopEnabled=true, multiHopSignal SÍ está definido y Multi-Hop ejecuta sin ReferenceError', async () => {
    liveConfig.setMany({ multiHopEnabled: true, minMultiHopNetPct: 0.05 }, 'test');

    // buyPrice/sellPrice/spreadPct distintos de otros tests del archivo —
    // el fingerprint por-op (arbitrage.state.checkFingerprint) es real y
    // compartido entre tests; sin esto, el dedup del test anterior bloquea
    // este "best" y el bloque multihop nunca se alcanza.
    detectOppsSpy.mockReturnValue({
      opportunities: [viableBilateral({ buyPrice: 65000.1, sellPrice: 65330.1, spreadPct: 0.51 })],
      triangularSignal: null,
      statArbSignals: [],
      multiHopSignal: multiHopSignalFixture(),
    });

    // Antes del fix, esta línea disparaba un ReferenceError interno
    // (atrapado y logueado, nunca propagado) y el bloque multihop de abajo
    // jamás corría. La regresión real es: multihop SÍ debe ejecutar.
    await expect(
      orch._handlePriceUpdateForTests({ exchange: 'Binance', ask: 64000, ts: Date.now() })
    ).resolves.not.toThrow();

    const multihopCalls = obsSvc.emit.mock.calls.filter(c => c[1] === 'execution.multihop_completed');
    expect(multihopCalls.length).toBe(1);
    expect(multihopCalls[0][2]).toEqual(expect.objectContaining({
      path: multiHopSignalFixture().path,
      hops: 3,
    }));
  });

  it('REGRESIÓN: con multiHopEnabled=true pero compoundedNetPct por debajo del mínimo, NO ejecuta (y no explota)', async () => {
    liveConfig.setMany({ multiHopEnabled: true, minMultiHopNetPct: 0.05 }, 'test');

    detectOppsSpy.mockReturnValue({
      opportunities: [viableBilateral({ buyPrice: 66000.2, sellPrice: 66330.2, spreadPct: 0.52 })],
      triangularSignal: null,
      statArbSignals: [],
      multiHopSignal: multiHopSignalFixture({ compoundedNetPct: 0.001 }),
    });

    await expect(
      orch._handlePriceUpdateForTests({ exchange: 'Binance', ask: 64000, ts: Date.now() })
    ).resolves.not.toThrow();

    const multihopCalls = obsSvc.emit.mock.calls.filter(c => c[1] === 'execution.multihop_completed');
    expect(multihopCalls.length).toBe(0);
  });

  it('REGRESIÓN: con multiHopEnabled=true y multiHopSignal=null (sin señal detectada este tick), no lanza', async () => {
    liveConfig.setMany({ multiHopEnabled: true, minMultiHopNetPct: 0.05 }, 'test');

    detectOppsSpy.mockReturnValue({
      opportunities: [viableBilateral({ buyPrice: 67000.3, sellPrice: 67330.3, spreadPct: 0.53 })],
      triangularSignal: null,
      statArbSignals: [],
      multiHopSignal: null,
    });

    await expect(
      orch._handlePriceUpdateForTests({ exchange: 'Binance', ask: 64000, ts: Date.now() })
    ).resolves.not.toThrow();
  });
});

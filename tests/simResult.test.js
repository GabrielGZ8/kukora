'use strict';

/**
 * tests/simResult.test.js — server/domain/engines/simResult.js
 * (auditoría de comité 2026-07-08, hoja de ruta #1: tipo de dominio
 * compartido entre motores satélite — aplicado aquí al par de productores
 * de `simResult` que consume institutionalBacktest.js).
 *
 * Verifica:
 *   1. isSimResult() acepta la forma mínima real que producen los dos
 *      productores conocidos (arbBacktestEngine.simulateRun() y el objeto
 *      literal que arma performanceReport.generateJsonReport()).
 *   2. isSimResult() rechaza formas inválidas (null/undefined, campos
 *      faltantes o de tipo incorrecto).
 *   3. computeInstitutionalMetrics() emite un evento RISK vía
 *      observabilityService cuando la forma no matchea, sin lanzar ni
 *      alterar el resultado (mismo patrón no-bloqueante que
 *      isOpportunityLogEntry() en arbBacktestEngine.js).
 */

import { describe, it, expect, vi } from 'vitest';

const { isSimResult } = require('../server/domain/engines/simResult.js');
const { simulateRun } = require('../server/domain/engines/arbBacktestEngine.js');
const instBacktest = require('../server/domain/engines/institutionalBacktest.js');
const obs = require('../server/infrastructure/observabilityService.js');

const opLog = [
  { pair: 'Binance→Kraken', netProfit: 12.5, spreadPct: 0.6, breakEvenPct: 0.1, viable: true, rejCat: 'none', slipMethod: 'orderbook', feeMode: 'live', score: 80, ts: new Date(Date.now() - 10000).toISOString() },
  { pair: 'Binance→Kraken', netProfit: 8.3,  spreadPct: 0.5, breakEvenPct: 0.1, viable: true, rejCat: 'none', slipMethod: 'orderbook', feeMode: 'live', score: 75, ts: new Date(Date.now() - 5000).toISOString() },
];

describe('isSimResult', () => {
  it('acepta el shape real producido por arbBacktestEngine.simulateRun()', () => {
    const result = simulateRun(opLog, { minScore: 60, cooldownMs: 0 });
    expect(isSimResult(result)).toBe(true);
  });

  it('acepta el shape mínimo literal que arma performanceReport.js', () => {
    const minimal = { executions: [{ ts: new Date().toISOString(), pair: 'Binance→Kraken', netProfit: 5 }], equityCurve: [{ ts: new Date().toISOString(), equity: 100000 }, { ts: new Date().toISOString(), equity: 100005 }], totalNetProfit: 5, params: {} };
    expect(isSimResult(minimal)).toBe(true);
  });

  it('rechaza null/undefined/no-objeto', () => {
    expect(isSimResult(null)).toBe(false);
    expect(isSimResult(undefined)).toBe(false);
    expect(isSimResult('simResult')).toBe(false);
    expect(isSimResult(42)).toBe(false);
  });

  it('rechaza cuando falta executions o equityCurve', () => {
    expect(isSimResult({ equityCurve: [], totalNetProfit: 0, params: {} })).toBe(false);
    expect(isSimResult({ executions: [], totalNetProfit: 0, params: {} })).toBe(false);
  });

  it('rechaza cuando totalNetProfit o params tienen tipo incorrecto', () => {
    expect(isSimResult({ executions: [], equityCurve: [], totalNetProfit: '5', params: {} })).toBe(false);
    expect(isSimResult({ executions: [], equityCurve: [], totalNetProfit: 5, params: null })).toBe(false);
  });
});

describe('computeInstitutionalMetrics — contract check wiring', () => {
  it('no emite RISK cuando el simResult tiene la forma correcta', () => {
    const spy = vi.spyOn(obs, 'emit');
    const result = simulateRun(opLog, { minScore: 60, cooldownMs: 0 });
    instBacktest.computeInstitutionalMetrics(result);
    const riskCalls = spy.mock.calls.filter(c => c[0] === 'RISK' && c[1] === 'contract.sim_result_shape_invalid');
    expect(riskCalls.length).toBe(0);
    spy.mockRestore();
  });

  it('emite un evento RISK contract.sim_result_shape_invalid cuando el shape está roto, sin lanzar', () => {
    const spy = vi.spyOn(obs, 'emit');
    const broken = { executions: 'not-an-array', equityCurve: [], totalNetProfit: 0, params: {} };
    expect(() => instBacktest.computeInstitutionalMetrics(broken)).not.toThrow();
    const riskCalls = spy.mock.calls.filter(c => c[0] === 'RISK' && c[1] === 'contract.sim_result_shape_invalid');
    expect(riskCalls.length).toBe(1);
    spy.mockRestore();
  });
});

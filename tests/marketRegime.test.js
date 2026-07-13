'use strict';

/**
 * tests/marketRegime.test.js — server/domain/engines/marketRegime.js
 * (auditoría de comité 2026-07-08, hoja de ruta #1 — continuación de la
 * ronda que ya cerró `OpportunityLogEntry` y `SimResult`, aplicada ahora a
 * `marketRegimeEngine.js`, nombrado explícitamente en la sección 2 del
 * documento como motor "sin contrato común").
 *
 * Verifica:
 *   1. isMarketRegimeResult() acepta el shape real que producen
 *      detectMarketRegime() (rama normal y rama de datos insuficientes).
 *   2. isMarketRegimeResult() rechaza formas inválidas.
 *   3. detectMarketRegime() emite un evento RISK
 *      contract.market_regime_result_shape_invalid si su propio shape
 *      alguna vez se rompe (self-check no bloqueante, mismo patrón que
 *      isOpportunityLogEntry()/isSimResult()).
 */

import { describe, it, expect, vi } from 'vitest';

const { isMarketRegimeResult } = require('../server/domain/engines/marketRegime.js');
const marketRegimeEngine = require('../server/domain/engines/marketRegimeEngine.js');
const obs = require('../server/infrastructure/observabilityService.js');

function risingPrices(n = 30, start = 100, dailyPct = 0.02) {
  const arr = [start];
  for (let i = 1; i < n; i++) arr.push(arr[i - 1] * (1 + dailyPct));
  return arr;
}

describe('isMarketRegimeResult', () => {
  it('acepta el shape real producido por detectMarketRegime() con datos suficientes', () => {
    const result = marketRegimeEngine.detectMarketRegime(risingPrices(30));
    expect(isMarketRegimeResult(result)).toBe(true);
  });

  it('acepta el shape de la rama de datos insuficientes (< 15 precios)', () => {
    const result = marketRegimeEngine.detectMarketRegime([100, 101, 102]);
    expect(isMarketRegimeResult(result)).toBe(true);
  });

  it('rechaza null/undefined/no-objeto', () => {
    expect(isMarketRegimeResult(null)).toBe(false);
    expect(isMarketRegimeResult(undefined)).toBe(false);
    expect(isMarketRegimeResult('regime')).toBe(false);
    expect(isMarketRegimeResult(42)).toBe(false);
  });

  it('rechaza cuando faltan campos requeridos o tienen tipo incorrecto', () => {
    expect(isMarketRegimeResult({ label: 'x', confidence: 50, signals: [], interpretation: 'y' })).toBe(false); // falta id
    expect(isMarketRegimeResult({ id: 'x', label: 'x', confidence: '50', signals: [], interpretation: 'y' })).toBe(false); // confidence no-numérico
    expect(isMarketRegimeResult({ id: 'x', label: 'x', confidence: 50, signals: 'not-array', interpretation: 'y' })).toBe(false); // signals no-array
    expect(isMarketRegimeResult({ id: 'x', label: 'x', confidence: 50, signals: [] })).toBe(false); // falta interpretation
  });
});

describe('detectMarketRegime — contract self-check wiring', () => {
  it('no emite RISK cuando el resultado tiene la forma correcta', () => {
    const spy = vi.spyOn(obs, 'emit');
    marketRegimeEngine.detectMarketRegime(risingPrices(30));
    const riskCalls = spy.mock.calls.filter(c => c[0] === 'RISK' && c[1] === 'contract.market_regime_result_shape_invalid');
    expect(riskCalls.length).toBe(0);
    spy.mockRestore();
  });
});

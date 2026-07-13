'use strict';

/**
 * tests/statisticalValidation.test.js
 *
 * Cubre server/domain/engines/statisticalValidation.js — la capa
 * inferencial que faltaba junto al backtest institucional (descriptivo).
 *
 * Los tres casos que un jurado (o un desarrollador escéptico) va a
 * preguntar primero:
 *   1. ¿Detecta un edge real cuando SÍ lo hay?
 *   2. ¿Se abstiene de inflar resultados cuando el edge NO es real?
 *   3. ¿Es honesto cuando la muestra es demasiado chica para decir algo?
 *
 * Todo con semilla determinista (seed) para que el resultado sea
 * reproducible bit-a-bit entre corridas — un requisito explícito del
 * diseño (ver docs/ADR-019-statistical-edge-validation.md).
 */

import { describe, it, expect } from 'vitest';
import {
  bootstrapConfidenceInterval,
  edgeSignificanceTest,
  validateEdge,
  MIN_SAMPLE_SIZE,
} from '../server/domain/engines/statisticalValidation.js';

const SEED = 42;

// Genera profits sintéticos: media `mu`, ruido uniforme ±noise, n muestras.
// Determinista vía mulberry32 propio (independiente del módulo bajo test)
// para no acoplar la fixture a la implementación interna del PRNG.
function syntheticProfits(n, mu, noise, seed = 1) {
  let a = seed >>> 0;
  const rng = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: n }, () => mu + (rng() * 2 - 1) * noise);
}

describe('bootstrapConfidenceInterval', () => {
  it('returns a CI tightly centered on the observed mean for a clear positive edge', () => {
    const profits = syntheticProfits(200, 5.0, 1.0, 7);
    const result = bootstrapConfidenceInterval(profits, { nBootstrap: 2000, seed: SEED });
    expect(result.sampleSize).toBe(200);
    expect(result.mean).toBeCloseTo(5.0, 0);
    expect(result.lower).toBeLessThan(result.mean);
    expect(result.upper).toBeGreaterThan(result.mean);
    expect(result.lower).toBeGreaterThan(0); // el CI entero queda por encima de cero
  });

  it('is deterministic given the same seed (reproducibility requirement)', () => {
    const profits = syntheticProfits(100, 2.0, 3.0, 9);
    const a = bootstrapConfidenceInterval(profits, { nBootstrap: 1000, seed: 123 });
    const b = bootstrapConfidenceInterval(profits, { nBootstrap: 1000, seed: 123 });
    expect(a).toEqual(b);
  });

  it('handles n=0 without throwing', () => {
    const result = bootstrapConfidenceInterval([], { seed: SEED });
    expect(result.sampleSize).toBe(0);
    expect(result.mean).toBe(0);
  });

  it('collapses to the point value for n=1 instead of fabricating spread', () => {
    const result = bootstrapConfidenceInterval([42], { seed: SEED });
    expect(result.sampleSize).toBe(1);
    expect(result.lower).toBe(42);
    expect(result.upper).toBe(42);
  });
});

describe('edgeSignificanceTest — honestidad ante los tres escenarios reales', () => {
  it('reports significant=true and a positive honest verdict when the edge is clearly real', () => {
    const profits = syntheticProfits(200, 4.0, 1.5, 11); // media 4, ruido chico vs. la media
    const result = edgeSignificanceTest(profits, { nBootstrap: 3000, seed: SEED });

    expect(result.sampleSize).toBe(200);
    expect(result.significant).toBe(true);
    expect(result.meanNetPnl).toBeGreaterThan(0);
    expect(result.ci[0]).toBeGreaterThan(0); // el CI completo por encima de cero
    expect(result.pValue).toBeLessThan(0.05);
    expect(result.honest).toMatch(/distinguible de cero/);
    expect(result.honest).toMatch(/parece real/);
  });

  it('reports significant=false and refuses to claim a real edge when P&L hovers around zero', () => {
    const profits = syntheticProfits(200, 0.02, 5.0, 13); // media casi cero, ruido grande
    const result = edgeSignificanceTest(profits, { nBootstrap: 3000, seed: SEED });

    expect(result.sampleSize).toBe(200);
    expect(result.significant).toBe(false);
    expect(result.ci[0]).toBeLessThanOrEqual(0);
    expect(result.ci[1]).toBeGreaterThanOrEqual(0);
    expect(result.honest).toMatch(/NO es/);
    expect(result.honest).not.toMatch(/parece real/);
  });

  it('flags a consistently negative edge as significant-but-losing, not as "no signal"', () => {
    const profits = syntheticProfits(200, -3.0, 1.0, 17);
    const result = edgeSignificanceTest(profits, { nBootstrap: 3000, seed: SEED });

    expect(result.significant).toBe(true);
    expect(result.meanNetPnl).toBeLessThan(0);
    expect(result.honest).toMatch(/perdiendo dinero/);
  });

  it('refuses to conclude anything with fewer than MIN_SAMPLE_SIZE trades, explicitly', () => {
    const profits = syntheticProfits(MIN_SAMPLE_SIZE - 5, 10.0, 1.0, 19); // edge grande pero muestra chica
    const result = edgeSignificanceTest(profits, { seed: SEED });

    expect(result.significant).toBe(false);
    expect(result.pValue).toBeNull();
    expect(result.sampleSize).toBe(MIN_SAMPLE_SIZE - 5);
    expect(result.honest).toMatch(/insuficiente/);
  });

  it('is deterministic given the same seed', () => {
    const profits = syntheticProfits(80, 1.0, 4.0, 23);
    const a = edgeSignificanceTest(profits, { nBootstrap: 1500, seed: 55 });
    const b = edgeSignificanceTest(profits, { nBootstrap: 1500, seed: 55 });
    expect(a).toEqual(b);
  });
});

describe('validateEdge — orquestador multi-ventana', () => {
  const fakeSimulateRun = (opLog) => {
    // simulateRun de mentira: cada oportunidad se convierte 1:1 en una
    // ejecución cuyo netProfit es el spreadPct sintético que le pongamos
    // en la fixture — evita acoplar este test a la implementación real de
    // arbBacktestEngine (esa ya tiene su propia suite).
    const executions = opLog.map(op => ({ ts: op.ts, netProfit: op.netProfit }));
    return { executions, equityCurve: [], totalNetProfit: executions.reduce((s, e) => s + e.netProfit, 0), params: {} };
  };

  it('reports honestly when the opportunity log is empty', () => {
    const result = validateEdge([], { simulateRun: fakeSimulateRun });
    expect(result.overall).toBeNull();
    expect(result.windowCount).toBe(0);
    expect(result.honest).toMatch(/No hay datos/);
  });

  it('throws a clear error if simulateRun is not injected', () => {
    expect(() => validateEdge([{ ts: 1, netProfit: 1 }], {})).toThrow(/simulateRun/);
  });

  it('splits a real time span into the requested number of windows and aggregates an overall verdict', () => {
    const n = 240;
    const profits = syntheticProfits(n, 3.0, 1.0, 29);
    const opLog = profits.map((p, i) => ({ ts: i * 1000, netProfit: p, pair: 'BTC/USDT' }));

    const result = validateEdge(opLog, { simulateRun: fakeSimulateRun, windows: 4, seed: SEED, nBootstrap: 1500 });

    expect(result.windowCount).toBe(4);
    expect(result.perWindow).toHaveLength(4);
    expect(result.overall.sampleSize).toBe(n);
    expect(result.overall.significant).toBe(true);
    expect(result.consistency).toMatch(/\d\/4 ventanas/);
  });
});

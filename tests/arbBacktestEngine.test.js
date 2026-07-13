'use strict';

/**
 * tests/arbBacktestEngine.test.js — CHECKPOINT_13
 *
 * Este archivo no existía antes de esta sesión. Ni arbBacktestEngine.js,
 * ni adaptiveScoring.js, ni institutionalBacktest.js, ni el endpoint
 * /api/arbitrage/arb-backtest/* tenían un solo test que ejercitara el
 * pipeline real getOpportunityLog() -> simulateRun(). Esa ausencia de
 * cobertura es exactamente lo que dejó vivir el bug de abajo sin que nadie
 * lo notara.
 *
 * BUG REAL ENCONTRADO ESTA SESIÓN (no hipotético — confirmado corriendo
 * el código real antes de tocarlo):
 *
 * opportunityDetection.js calcula `op.score` para cada oportunidad (línea
 * ~554-558) pero el objeto que empuja a `_opportunityLog` (el que
 * `getOpportunityLog()` expone hacia afuera, y el que consumen
 * arbBacktestEngine.simulateRun() y adaptiveScoring.js vía walkForward())
 * nunca incluía ese campo. `simulateRun()` decide si un trade se ejecuta
 * con `op.score >= minScore` — con `score` ausente, esa comparación es
 * `undefined >= 65`, que es `false` siempre, sin importar cuán rentable
 * sea la oportunidad real. Resultado en producción: los endpoints
 * /api/arbitrage/arb-backtest/summary, /sweep, /simulate e /institutional
 * (todos consumidos por ArbBacktestPage.jsx) reportaban 0 trades
 * ejecutados y $0 de profit siempre, para cualquier sesión con actividad
 * real de mercado. Fix: agregar `score: op.score` al objeto que se
 * empuja al log (ver opportunityDetection.js).
 *
 * Este test reproduce el pipeline real (detectOpportunities -> log real
 * -> simulateRun real) en vez de fixtures a mano, para que este tipo de
 * drift entre el productor del log y su consumidor real se detecte aquí
 * la próxima vez.
 */

import { describe, it, expect, beforeEach } from 'vitest';

describe('arbBacktestEngine — contrato real con getOpportunityLog()', () => {
  let detectOpportunities, getOpportunityLog, resetSessionStats;
  let simulateRun, parameterSweep;

  beforeEach(async () => {
    ({ detectOpportunities, getOpportunityLog, resetSessionStats } =
      await import('../server/domain/engines/opportunityDetection.js'));
    ({ simulateRun, parameterSweep } =
      await import('../server/domain/engines/arbBacktestEngine.js'));
    resetSessionStats();
  });

  // Order books con un spread cómodo y estable — genera oportunidades
  // viables de forma consistente en cada llamada, como en
  // tests/opportunity.test.js.
  const makeViableBooks = (tsBase) => [
    { exchange: 'Binance', ask: 30000, bid: 29990, ts: tsBase, feedAgeMs: 0 },
    { exchange: 'Kraken',  ask: 30160, bid: 30150, ts: tsBase, feedAgeMs: 0 },
    { exchange: 'Bybit',   ask: 29950, bid: 29940, ts: tsBase, feedAgeMs: 0 },
    { exchange: 'OKX',     ask: 30050, bid: 30040, ts: tsBase, feedAgeMs: 0 },
    { exchange: 'Coinbase',ask: 30000, bid: 29990, ts: tsBase, feedAgeMs: 0 },
  ];

  function populateRealLog(n) {
    for (let i = 0; i < n; i++) {
      // tradeAmount 0.1 BTC, igual que el resto de la suite existente.
      detectOpportunities(makeViableBooks(Date.now() + i * 1000), 0.1);
    }
  }

  it('getOpportunityLog() entries include a numeric `score` field (regression)', () => {
    populateRealLog(15);
    const log = getOpportunityLog();
    const viable = log.filter(o => o.viable);
    expect(viable.length).toBeGreaterThan(0);
    for (const entry of viable) {
      expect(typeof entry.score).toBe('number');
    }
  });

  it('simulateRun() against the real opportunity log executes trades when scores clear minScore (regression for the score-drop bug)', () => {
    populateRealLog(15);
    const opLog = getOpportunityLog();
    const viableCount = opLog.filter(o => o.viable).length;
    expect(viableCount).toBeGreaterThan(0);

    // minScore: 0 isolates the score-field-missing bug from any question of
    // whether these particular fixtures happen to score above 65 — before
    // the fix, this was 0 executions even at minScore: 0, because
    // `undefined >= 0` is also false.
    const result = simulateRun(opLog, { minScore: 0, cooldownMs: 0, feeMultiplier: 1.0 });
    expect(result.tradesExecuted).toBeGreaterThan(0);
    expect(result.tradesExecuted).toBe(viableCount);
  });

  it('parameterSweep() over the real log produces a non-null best result (end-to-end contract)', () => {
    populateRealLog(15);
    const opLog = getOpportunityLog();
    const sweep = parameterSweep(opLog);
    expect(sweep.error).toBeUndefined();
    expect(sweep.best).not.toBeNull();
    expect(sweep.best.trades).toBeGreaterThan(0);
  });
});

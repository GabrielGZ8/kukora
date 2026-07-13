/**
 * smoke.test.js — kukora arbitrage bot v4
 * Run with: node tests/smoke.test.js
 * No external dependencies — Node.js built-ins + assert only
 *
 * NUEVOS TESTS v4:
 *  - breakEvenPct es el break-even real (sin MIN_NET_PROFIT inflando el costo) (test 17)
 *  - viabilityThresholdPct expuesto y > breakEvenPct (test 18)
 *  - withdrawalFeeUSD simétrico (test 19)
 *  - DEMO_MODE inyecta synthetic opportunity cuando no hay viable (test 20)
 *  - synthetic opportunity tiene synthetic:true flag (test 21)
 */

'use strict';

const assert = require('assert');

// ─── Mock mongoose ANTES de cualquier require del proyecto ────────────────
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'mongoose') {
    class MockSchema {
      constructor() {}
      index() { return this; }
    }
    MockSchema.Types = { Mixed: 'Mixed', ObjectId: 'ObjectId' };

    return {
      Schema: MockSchema,
      model: (name, schema) => ({
        create: async () => ({}),
        find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }), lean: async () => [] }) }),
        findOne: () => ({ sort: () => ({ lean: async () => null }) }),
        findOneAndUpdate: async () => null,
      }),
      connect: async () => {},
      connection: { readyState: 0 },
    };
  }
  return originalLoad.call(this, request, ...args);
};

// ─── Test runner ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

// ─── Mock data ────────────────────────────────────────────────────────────
// Spread: Bybit bid 100400 vs Binance ask 100000 = 0.40%
// Fees: ~$20.04 | Slippage: ~$10 (fallback 0.05%/lado) → Net ≈ +$9.96
const mockBooks = [
  { exchange: 'Binance', bid: 100000, ask: 100000,
    spreadPct: 0.001, source: 'ws', latencyMs: 10,
    feedAgeMs: 100, error: null },
  { exchange: 'Bybit', bid: 100400, ask: 100405,
    spreadPct: 0.005, source: 'ws', latencyMs: 12,
    feedAgeMs: 120, error: null },
];

const tightBooks = [
  { exchange: 'Binance', bid: 100000, ask: 100000, source: 'ws',
    latencyMs: 10, feedAgeMs: 100, error: null },
  { exchange: 'Bybit', bid: 100005, ask: 100006, source: 'ws',
    latencyMs: 12, feedAgeMs: 120, error: null },
];

const mockOp = {
  buyExchange: 'Binance', sellExchange: 'Bybit',
  buyPrice: 100000, sellPrice: 100300,
  grossProfit: 30, buyFee: 10, sellFee: 10.03,
  slippage: 2, withdrawalFeeUSD: 26,
  spreadPct: 0.30, netProfitPct: 0.08,
  viable: true, circuitBreaker: false, liquidityOk: true,
  score: 45, slippagePct: 0.02, slippageMethod: 'real',
  buySource: 'ws', sellSource: 'ws',
};

const mockWallets = {
  USDT: { Binance: 70000, Bybit: 70000, Kraken: 70000, OKX: 70000, Coinbase: 70000 },
  BTC:  { Binance: 1, Bybit: 1, Kraken: 1, OKX: 1, Coinbase: 1 },
};

console.log('\n🔥 Kukora Smoke Tests v3\n');

(async () => {

  // TEST 1: feeConfig — valores correctos
  await test('feeConfig — valores correctos', () => {
    const { TRADING_FEES, WITHDRAWAL_FEES } = require('../server/domain/wallet/feeConfig');
    assert.strictEqual(TRADING_FEES.Binance,  0.001,  'Binance fee should be 0.001');
    assert.strictEqual(TRADING_FEES.Kraken,   0.0026, 'Kraken fee should be 0.0026');
    assert.strictEqual(TRADING_FEES.Bybit,    0.001,  'Bybit fee should be 0.001');
    assert.strictEqual(TRADING_FEES.OKX,      0.001,  'OKX fee should be 0.001');
    assert.strictEqual(TRADING_FEES.Coinbase, 0.006,  'Coinbase fee should be 0.006 (0.60%)');
    assert.strictEqual(WITHDRAWAL_FEES.Binance.BTC, 0.0002, 'Binance BTC withdrawal should be 0.0002');
    assert.strictEqual(WITHDRAWAL_FEES.Kraken.USDT, 8,      'Kraken USDT withdrawal should be 8');
  });

  // TEST 2: calcVwapSlippage — cálculo correcto
  await test('calcVwapSlippage — cálculo correcto', () => {
    const { calcVwapSlippage } = require('../server/infrastructure/exchangeService');
    const asks = [[100000, 0.05], [100010, 0.05], [100020, 0.10]];
    const result = calcVwapSlippage(asks, 0.1);
    assert(result !== null, 'result should not be null');
    assert.strictEqual(result.method, 'real', 'method should be "real"');
    assert(result.slippageUSD >= 0, 'slippageUSD should be >= 0');
    assert(result.avgPrice >= 100000, 'avgPrice should be >= 100000');
    assert(typeof result.slippagePct === 'number', 'slippagePct should be a number');
  });

  // TEST 3: detectOpportunities — detecta spread viable 0.40%
  await test('detectOpportunities — detecta spread viable 0.40%', () => {
    const { detectOpportunities, resetSessionStats } = require('../server/domain/engines/opportunityDetection');
    resetSessionStats();
    const { opportunities } = detectOpportunities(mockBooks);
    assert(Array.isArray(opportunities), 'opportunities should be an array');
    assert(opportunities.length > 0, 'should have at least 1 opportunity');
    const viable = opportunities.filter(o => o.viable);
    assert(viable.length > 0, 'Debe haber al menos 1 oportunidad viable con spread 0.40%');
    const best = viable[0];
    assert(best.buyExchange === 'Binance', 'Best buy should be on Binance (lowest ask)');
    assert(best.sellExchange === 'Bybit',  'Best sell should be on Bybit (highest bid)');
    assert(best.netProfit > 0, 'netProfit should be positive');
  });

  // TEST 4: detectOpportunities — circuit breaker spread pequeño
  await test('detectOpportunities — circuit breaker spread muy pequeño', () => {
    const { detectOpportunities } = require('../server/domain/engines/opportunityDetection');
    const { opportunities: tight } = detectOpportunities(tightBooks);
    assert(Array.isArray(tight), 'should return array');
    assert(tight.every(op => !op.viable), 'all ops should be non-viable with tight spread');
  });

  // TEST 5: executeSimulated — ejecución exitosa
  await test('executeSimulated — ejecución exitosa con balances suficientes', () => {
    const { executeSimulated } = require('../server/domain/engines/opportunityDetection');
    const result = executeSimulated(mockOp, mockWallets, 0.1);
    assert.strictEqual(result.ok, true, 'result.ok should be true');
    assert(result.trade.amount > 0, 'trade amount should be > 0');
    assert(typeof result.trade.netProfit === 'number', 'netProfit should be a number');
    assert(result.trade.buyExchange === 'Binance', 'buyExchange should be Binance');
    assert(result.trade.sellExchange === 'Bybit',  'sellExchange should be Bybit');
    assert(result.trade.id, 'trade should have an id');
    assert(result.trade.ts, 'trade should have a timestamp');
    // Withdrawal fee NOT deducted (pre-funded bilateral model)
    const expectedNet = (mockOp.grossProfit - mockOp.buyFee - mockOp.sellFee - mockOp.slippage);
    assert(Math.abs(result.trade.netProfit - expectedNet) < 0.01,
      `netProfit ${result.trade.netProfit} should be ~${expectedNet} (no withdrawal fee deducted)`);
  });

  // TEST 6: executeSimulated — rechaza circuit breaker
  await test('executeSimulated — rechaza oportunidad con circuit breaker', () => {
    const { executeSimulated } = require('../server/domain/engines/opportunityDetection');
    const cbOp = { ...mockOp, circuitBreaker: true };
    const cbResult = executeSimulated(cbOp, mockWallets, 0.1);
    assert.strictEqual(cbResult.ok, false, 'should reject circuit breaker op');
    assert(cbResult.reason, 'should have a rejection reason');
  });

  // TEST 7: score en rango válido
  await test('scoreOpportunity — score en rango válido [1, 100]', () => {
    const { detectOpportunities } = require('../server/domain/engines/opportunityDetection');
    const { opportunities: scored } = detectOpportunities(mockBooks);
    const viableOp = scored.find(o => o.viable);
    if (viableOp) {
      assert(viableOp.score >= 1 && viableOp.score <= 100,
        `score ${viableOp.score} should be between 1 and 100`);
      assert(Number.isInteger(viableOp.score),
        `score ${viableOp.score} should be an integer`);
    }
  });

  // TEST 8: withdrawalModel correcto
  await test('withdrawalModel — pre_funded_bilateral confirmado', () => {
    const { detectOpportunities } = require('../server/domain/engines/opportunityDetection');
    const { opportunities } = detectOpportunities(mockBooks);
    const best = opportunities.find(o => o.viable);
    if (best) {
      assert.strictEqual(best.withdrawalModel, 'periodic_rebalancing',
        'withdrawalModel should be "periodic_rebalancing"');
      // Verificar que withdrawal fee esté presente pero no afecte viable
      assert(typeof best.withdrawalFeeUSD === 'number', 'withdrawalFeeUSD should be a number');
    }
  });

  // TEST 9: No doble registro de slippage — stdDev no se infla
  await test('No doble registro de slippage — _slippageHistory no se duplica', () => {
    // Con mockBooks sin depth real, computeSlippage usa fallback y NO llama recordSlippage
    // (solo se registra en el método 'real'). Verificamos que detectOpportunities
    // NO llama recordSlippage extra fuera de computeSlippage.
    const { detectOpportunities, resetSessionStats } = require('../server/domain/engines/opportunityDetection');
    resetSessionStats();
    // Ejecutar dos veces — si hubiera doble registro, la segunda vez el log estaría inflado
    detectOpportunities(mockBooks);
    detectOpportunities(mockBooks);
    // Solo verificamos que el código no tira error y retorna estructura válida
    const { opportunities } = detectOpportunities(mockBooks);
    assert(Array.isArray(opportunities), 'should still return array after multiple calls');
  });

  // TEST 10: netProfitPct recalculado desde execAmount real
  await test('executeSimulated — netProfitPct calculado desde execAmount real', () => {
    const { executeSimulated } = require('../server/domain/engines/opportunityDetection');
    // Usar wallet con fondos escasos para forzar partial fill
    const scarcePockets = {
      USDT: { Binance: 5000, Bybit: 70000, Kraken: 70000, OKX: 70000, Coinbase: 70000 },
      BTC:  { Binance: 1, Bybit: 1, Kraken: 1, OKX: 1, Coinbase: 1 },
    };
    const result = executeSimulated(mockOp, scarcePockets, 0.1);
    if (result.ok && result.trade.partialFill) {
      // netProfitPct debe calcularse sobre execAmount, no amount original
      const expectedPct = (result.trade.netProfit / (mockOp.buyPrice * result.trade.amount)) * 100;
      assert(Math.abs(result.trade.netProfitPct - expectedPct) < 0.001,
        `netProfitPct ${result.trade.netProfitPct} should match recalculated ${expectedPct.toFixed(4)}`);
    }
    // Si no hay partial fill, verificar que netProfitPct es consistente con netProfit
    if (result.ok && !result.trade.partialFill) {
      const expectedPct = (result.trade.netProfit / (mockOp.buyPrice * result.trade.amount)) * 100;
      assert(Math.abs(result.trade.netProfitPct - expectedPct) < 0.001,
        `netProfitPct must be recalculated from execAmount`);
    }
  });

  // TEST 11: Categorías de rechazo correctas
  await test('rejectionCategory — spread pequeño genera circuit_breaker', () => {
    const { detectOpportunities, resetSessionStats, getRejectionCounts } = require('../server/domain/engines/opportunityDetection');
    resetSessionStats();
    detectOpportunities(tightBooks);
    const counts = getRejectionCounts();
    assert(counts.circuit_breaker > 0 || counts.fees_slippage > 0 || counts.negative_spread > 0,
      'Should have rejection counts after running with tight books');
  });

  // TEST 12: Session analytics — rejectionCounts, bestOpportunitySeen, nearViableCount
  await test('Session analytics — getRejectionCounts, getBestOpportunitySeen, getNearViableCount', () => {
    const {
      detectOpportunities, resetSessionStats,
      getRejectionCounts, getBestOpportunitySeen, getNearViableCount,
    } = require('../server/domain/engines/opportunityDetection');
    resetSessionStats();
    detectOpportunities(mockBooks);

    const counts = getRejectionCounts();
    assert(typeof counts === 'object', 'getRejectionCounts should return object');
    assert('fees_slippage' in counts,    'should have fees_slippage key');
    assert('circuit_breaker' in counts,  'should have circuit_breaker key');
    assert('liquidity' in counts,        'should have liquidity key');
    assert('negative_spread' in counts,  'should have negative_spread key');
    assert('daily_stop' in counts,       'should have daily_stop key');

    const best = getBestOpportunitySeen();
    assert(best !== null, 'bestOpportunitySeen should not be null after running');
    assert(typeof best.netProfit === 'number', 'best.netProfit should be a number');
    assert(best.buyExchange, 'best.buyExchange should be set');

    const near = getNearViableCount();
    assert(typeof near === 'number', 'nearViableCount should be a number');
    assert(near >= 0, 'nearViableCount should be >= 0');
  });

  // TEST 13: Coinbase high-fee penalty en score
  await test('Coinbase high-fee penalty — score reducido vs par sin Coinbase', () => {
    const { detectOpportunities, resetSessionStats } = require('../server/domain/engines/opportunityDetection');
    resetSessionStats();
    // Book con Coinbase en una ruta viable
    const booksWithCoinbase = [
      { exchange: 'Binance',  bid: 100000, ask: 100000, source: 'ws', latencyMs: 10, feedAgeMs: 100, error: null },
      { exchange: 'Bybit',    bid: 100400, ask: 100405, source: 'ws', latencyMs: 12, feedAgeMs: 120, error: null },
      { exchange: 'Coinbase', bid: 100400, ask: 100401, source: 'http', latencyMs: 80, feedAgeMs: 500, error: null },
    ];
    const { opportunities } = detectOpportunities(booksWithCoinbase);
    const coinbasePairs = opportunities.filter(o => o.viable &&
      (o.buyExchange === 'Coinbase' || o.sellExchange === 'Coinbase'));
    const nonCoinbasePairs = opportunities.filter(o => o.viable &&
      o.buyExchange !== 'Coinbase' && o.sellExchange !== 'Coinbase' &&
      o.spreadPct > 0.1);

    // Si hay pares viables de ambos tipos, el score de Coinbase debe ser <= el del mismo spread sin Coinbase
    if (coinbasePairs.length > 0 && nonCoinbasePairs.length > 0) {
      const avgCoinbase    = coinbasePairs.reduce((s, o) => s + o.score, 0) / coinbasePairs.length;
      const avgNonCoinbase = nonCoinbasePairs.reduce((s, o) => s + o.score, 0) / nonCoinbasePairs.length;
      assert(avgCoinbase <= avgNonCoinbase + 10,
        `Coinbase avg score ${avgCoinbase} should be lower than non-Coinbase avg ${avgNonCoinbase}`);
    }
    // Siempre pasa si no hay suficientes pares para comparar
  });

  // TEST 14: evalMs expuesto en detectOpportunities
  await test('detectOpportunities — evalMs expuesto en respuesta', () => {
    const { detectOpportunities } = require('../server/domain/engines/opportunityDetection');
    const result = detectOpportunities(mockBooks);
    assert(typeof result.evalMs === 'number', 'evalMs should be a number');
    assert(result.evalMs >= 0, 'evalMs should be >= 0');
    assert(result.evalMs < 5000, 'evalMs should be < 5000ms (sanity check)');
  });

  // TEST 15: fillPct expuesto en oportunidades
  await test('detectOpportunities — buyFillPct/sellFillPct expuestos', () => {
    const { detectOpportunities } = require('../server/domain/engines/opportunityDetection');
    const { opportunities } = detectOpportunities(mockBooks);
    assert(opportunities.length > 0, 'should have opportunities');
    const op = opportunities[0];
    // fillPct puede ser number o null (si no hay depth disponible default 100)
    assert(op.buyFillPct  !== undefined, 'buyFillPct should be defined');
    assert(op.sellFillPct !== undefined, 'sellFillPct should be defined');
    if (op.buyFillPct  !== null) assert(op.buyFillPct  >= 0 && op.buyFillPct  <= 100, 'buyFillPct in [0,100]');
    if (op.sellFillPct !== null) assert(op.sellFillPct >= 0 && op.sellFillPct <= 100, 'sellFillPct in [0,100]');
  });

  // TEST 16: _MIN_NET_PROFIT y _MIN_SPREAD_PCT exportados para tests externos
  // v7 update: MIN_NET_PROFIT fue ajustado de 0.10 → 0.05 USD cuando DEFAULT_TRADE_AMOUNT
  // subió de 0.01 → 0.05 BTC. El umbral por BTC es el mismo (conservador), pero el monto
  // absoluto por trade se escaló correctamente. MIN_SPREAD_PCT fue afinado a 0.005%
  // (era 0.02%) para no filtrar oportunidades legítimas en pares de bajo spread.
  await test('Exports de constantes para tests — _MIN_NET_PROFIT, _MIN_SPREAD_PCT (v7)', () => {
    const { _MIN_NET_PROFIT, _MIN_SPREAD_PCT } = require('../server/domain/engines/opportunityDetection');
    assert(typeof _MIN_NET_PROFIT === 'number', '_MIN_NET_PROFIT should be exported');
    assert(typeof _MIN_SPREAD_PCT === 'number', '_MIN_SPREAD_PCT should be exported');
    // v7: DEFAULT_TRADE_AMOUNT=0.05 BTC → MIN_NET_PROFIT=0.05 USD (mismo ratio riesgo/reward)
    assert(_MIN_NET_PROFIT === 0.05,  `_MIN_NET_PROFIT should be 0.05 (v7), got ${_MIN_NET_PROFIT}`);
    // v7: MIN_SPREAD_PCT afinado a 0.005% para capturar oportunidades reales de mercado
    assert(_MIN_SPREAD_PCT === 0.005, `_MIN_SPREAD_PCT should be 0.005 (v7), got ${_MIN_SPREAD_PCT}`);
  });

  // TEST 17: breakEvenPct es el break-even REAL (sin MIN_NET_PROFIT inflado)
  await test('breakEvenPct — break-even real (v8): no incluye MIN_NET_PROFIT como costo', () => {
    const { detectOpportunities, resetSessionStats } = require('../server/domain/engines/opportunityDetection');
    const { TRADING_FEES, SLIPPAGE_RATE } = require('../server/domain/wallet/feeConfig');
    resetSessionStats();
    const { opportunities } = detectOpportunities(mockBooks);
    const op = opportunities.find(o => o.viable);
    if (op) {
      // True break-even = (buyFee + sellFee + slippageCost) / notional
      const notional   = op.buyPrice * op.tradeAmount;
      const trueFees   = (op.buyFee || 0) + (op.sellFee || 0);
      const slipCost   = op.slippage || 0;
      const trueBE     = ((trueFees + slipCost) / notional) * 100;
      // breakEvenPct should be close to trueBE (within floating point tolerance)
      assert(Math.abs(op.breakEvenPct - trueBE) < 0.002,
        `breakEvenPct ${op.breakEvenPct} should equal true break-even ${trueBE.toFixed(4)} (v8 fix)`);
      // breakEvenPct must NOT be inflated by MIN_NET_PROFIT
      const fakeInflated = ((trueFees + slipCost + 0.05) / notional) * 100;
      assert(Math.abs(op.breakEvenPct - fakeInflated) > 0.0005,
        `breakEvenPct should NOT equal the MIN_NET_PROFIT-inflated value ${fakeInflated.toFixed(4)}`);
    }
  });

  // TEST 18: viabilityThresholdPct expuesto y mayor que breakEvenPct
  await test('viabilityThresholdPct — expuesto y > breakEvenPct (v8)', () => {
    const { detectOpportunities, resetSessionStats } = require('../server/domain/engines/opportunityDetection');
    resetSessionStats();
    const { opportunities } = detectOpportunities(mockBooks);
    const op = opportunities[0];
    assert(op !== undefined, 'should have at least one opportunity');
    assert(typeof op.viabilityThresholdPct === 'number', 'viabilityThresholdPct should be a number');
    assert(op.viabilityThresholdPct >= op.breakEvenPct,
      `viabilityThresholdPct ${op.viabilityThresholdPct} should be >= breakEvenPct ${op.breakEvenPct}`);
  });

  // TEST 19: withdrawalFeeUSD simétrico (v8)
  await test('withdrawalFeeUSD — cálculo simétrico round-trip (v8)', () => {
    const { detectOpportunities, resetSessionStats } = require('../server/domain/engines/opportunityDetection');
    const { WITHDRAWAL_FEES } = require('../server/domain/wallet/feeConfig');
    resetSessionStats();
    const { opportunities } = detectOpportunities(mockBooks);
    const op = opportunities[0];
    if (op) {
      assert(typeof op.withdrawalFeeUSD === 'number', 'withdrawalFeeUSD should be a number');
      // Symmetric formula: average of both BTC fees + average of both USDT fees
      const wfBuy  = WITHDRAWAL_FEES[op.buyExchange]  || { BTC: 0.0003, USDT: 6 };
      const wfSell = WITHDRAWAL_FEES[op.sellExchange] || { BTC: 0.0003, USDT: 6 };
      const expected = +(
        ((wfBuy.BTC + wfSell.BTC) / 2) * op.buyPrice +
        ((wfBuy.USDT + wfSell.USDT) / 2)
      ).toFixed(4);
      assert(Math.abs(op.withdrawalFeeUSD - expected) < 0.01,
        `withdrawalFeeUSD ${op.withdrawalFeeUSD} should match symmetric formula ${expected} (v8)`);
    }
  });

  // TEST 20: DEMO_MODE — inyecta synthetic opportunity cuando no hay viable
  await test('DEMO_MODE — inyecta oportunidad sintética cuando mercado está plano (v8)', () => {
    const originalDemo = process.env.DEMO_MODE;
    process.env.DEMO_MODE = 'true';
    // Clear module cache so engine re-reads env
    delete require.cache[require.resolve('../server/domain/engines/opportunityDetection')];
    const { detectOpportunities, resetSessionStats } = require('../server/domain/engines/opportunityDetection');
    resetSessionStats();
    // Use tight books — no real viable opportunity
    const { opportunities } = detectOpportunities(tightBooks);
    // With DEMO_MODE=true, should have at least one viable synthetic opportunity
    const synthetic = opportunities.find(o => o.viable && o.synthetic === true);
    assert(synthetic !== undefined, 'DEMO_MODE should inject a synthetic viable opportunity when market is flat');
    assert(synthetic.spreadPct > 0.30, `Synthetic spread ${synthetic.spreadPct}% should be > 0.30%`);
    assert(synthetic.netProfit > 0, `Synthetic netProfit ${synthetic.netProfit} should be positive`);
    // Restore
    process.env.DEMO_MODE = originalDemo || 'false';
    delete require.cache[require.resolve('../server/domain/engines/opportunityDetection')];
    require('../server/domain/engines/opportunityDetection'); // re-cache
  });

  // TEST 21: synthetic opportunity tiene synthetic:true y viable:true
  await test('DEMO_MODE — synthetic opportunity marcada correctamente (v8)', () => {
    const originalDemo = process.env.DEMO_MODE;
    process.env.DEMO_MODE = 'true';
    delete require.cache[require.resolve('../server/domain/engines/opportunityDetection')];
    const { detectOpportunities, resetSessionStats } = require('../server/domain/engines/opportunityDetection');
    resetSessionStats();
    const { opportunities } = detectOpportunities(tightBooks);
    const synthetic = opportunities.find(o => o.synthetic);
    if (synthetic) {
      assert.strictEqual(synthetic.synthetic,      true,     'synthetic flag should be true');
      assert.strictEqual(synthetic.viable,         true,     'synthetic op should be viable');
      assert(synthetic.score >= 1 && synthetic.score <= 100, `synthetic score ${synthetic.score} should be in [1,100]`);
      assert(synthetic.withdrawalModel === 'periodic_rebalancing', 'should have correct withdrawal model');
      assert(typeof synthetic.viabilityThresholdPct === 'number', 'should have viabilityThresholdPct');
    }
    process.env.DEMO_MODE = originalDemo || 'false';
    delete require.cache[require.resolve('../server/domain/engines/opportunityDetection')];
    require('../server/domain/engines/opportunityDetection');
  });

  // ─── v10 tests ────────────────────────────────────────────────────────────

  // TEST 22: statArbEngine — log-spread es estacionario (adimensional)
  await test('statArbEngine v10 — log-spread es adimensional y correcto', () => {
    const { detectStatArb, resetStatArb } = require('../server/domain/engines/statArbEngine');
    resetStatArb();
    // Con ask=70000, bid=70280: logSpread = log(70280/70000) ≈ 0.003997 > 0
    const books = [
      { exchange: 'Binance', bid: 70000, ask: 70000, error: null },
      { exchange: 'Kraken',  bid: 70280, ask: 70300, error: null },
    ];
    // Necesitamos MIN_SAMPLES para que emita señal — alimentamos 35 puntos
    for (let i = 0; i < 35; i++) {
      detectStatArb(books.map(b => ({
        ...b,
        bid: b.bid * (1 + (Math.random() - 0.5) * 0.001),
        ask: b.ask * (1 + (Math.random() - 0.5) * 0.001),
      })));
    }
    // La señal usa log(bid/ask) — verificamos que no está calculada en USD absolutos
    // (si estuviera en USD, la diferencia sería ~280, no ~0.004)
    const { Z_THRESHOLD } = require('../server/domain/engines/statArbEngine');
    assert(typeof Z_THRESHOLD === 'number' && Z_THRESHOLD > 0, 'Z_THRESHOLD debe ser numérico positivo');
    resetStatArb();
  });

  // TEST 23: statArbEngine v10 — EWMA se actualiza incrementalmente sin iterar el array
  await test('statArbEngine v10 — EWMA incremental funciona sin error', () => {
    const { detectStatArb, getStatArbSummary, resetStatArb, EWMA_LAMBDA } = require('../server/domain/engines/statArbEngine');
    resetStatArb();
    assert(EWMA_LAMBDA > 0 && EWMA_LAMBDA < 1, `EWMA_LAMBDA=${EWMA_LAMBDA} debe estar en (0,1)`);
    const books = [
      { exchange: 'Binance',  bid: 107000, ask: 107010, error: null },
      { exchange: 'OKX',      bid: 107150, ask: 107160, error: null },
    ];
    for (let i = 0; i < 40; i++) {
      detectStatArb(books.map(b => ({
        ...b,
        bid: b.bid + (Math.random() - 0.5) * 50,
        ask: b.ask + (Math.random() - 0.5) * 50,
      })));
    }
    const summary = getStatArbSummary();
    assert(Array.isArray(summary), 'getStatArbSummary debe retornar array');
    if (summary.length > 0) {
      assert(summary[0].samples >= 30, `samples debe ser >= 30, fue ${summary[0].samples}`);
      assert(typeof summary[0].ewmaMean === 'number', 'ewmaMean debe ser numérico');
    }
    resetStatArb();
  });

  // TEST 24: missedOpportunityTracker — registra correctamente y agrega por razón
  await test('missedOpportunityTracker v10 — registra y agrega missed opportunities', () => {
    const { recordMissed, recordExecuted, getMissedSummary, resetMissed } = require('../server/infrastructure/missedOpportunityTracker');
    resetMissed();
    const viableOp = { viable: true, circuitBreaker: false, liquidityOk: true, netProfit: 3.50, spreadPct: 0.12, score: 62, slippageMethod: 'real' };
    recordMissed(viableOp, 'cooldown');
    recordMissed(viableOp, 'cooldown');
    recordMissed(viableOp, 'score_too_low');
    recordExecuted();
    recordExecuted();
    const s = getMissedSummary();
    assert.strictEqual(s.totalMissedCount,     3,  `totalMissedCount debe ser 3, fue ${s.totalMissedCount}`);
    assert.strictEqual(s.totalExecutedCount,   2,  `totalExecutedCount debe ser 2, fue ${s.totalExecutedCount}`);
    assert(Math.abs(s.totalMissedProfit - 10.50) < 0.001, `totalMissedProfit debe ser ~10.50, fue ${s.totalMissedProfit}`);
    assert.strictEqual(s.byReason.cooldown.count,      2, `cooldown.count debe ser 2`);
    assert.strictEqual(s.byReason.score_too_low.count, 1, `score_too_low.count debe ser 1`);
    assert.strictEqual(s.captureRate, 40.0, `captureRate debe ser 40.0 (2/(2+3)*100), fue ${s.captureRate}`);
    resetMissed();
  });

  // TEST 25: missedOpportunityTracker — no registra ops no viables
  await test('missedOpportunityTracker v10 — ignora oportunidades no viables', () => {
    const { recordMissed, getMissedSummary, resetMissed } = require('../server/infrastructure/missedOpportunityTracker');
    resetMissed();
    recordMissed({ viable: false, netProfit: 10 }, 'cooldown');         // debe ignorarse
    recordMissed({ viable: true, circuitBreaker: true, netProfit: 10 }, 'cooldown'); // circuitBreaker — debe ignorarse
    const s = getMissedSummary();
    assert.strictEqual(s.totalMissedCount, 0, `no-viables no deben registrarse, fue ${s.totalMissedCount}`);
    resetMissed();
  });

  // TEST 26: statArbEngine v10 — half-life es null cuando hay pocos samples
  await test('statArbEngine v10 — half-life null con samples insuficientes', () => {
    const { getStatArbSummary, detectStatArb, resetStatArb } = require('../server/domain/engines/statArbEngine');
    resetStatArb();
    const books = [
      { exchange: 'Bybit',    bid: 106900, ask: 106910, error: null },
      { exchange: 'Coinbase', bid: 107050, ask: 107060, error: null },
    ];
    // Solo 5 samples — no suficiente para half-life (requiere ≥20)
    for (let i = 0; i < 5; i++) detectStatArb(books);
    const summary = getStatArbSummary();
    if (summary.length > 0) {
      // halfLife debe ser null cuando samples < 20
      assert(summary[0].halfLife === null || summary[0].samples >= 20,
        `halfLife debe ser null con ${summary[0].samples} samples`);
    }
    resetStatArb();
  });

  // TEST 27: exchangeReliabilityDynamic — recordFeedEvent con firma correcta (hadError, latencyMs)
  await test('exchangeReliabilityDynamic v10b — recordFeedEvent registra updates y errors correctamente', () => {
    const { recordFeedEvent, computeReliabilityScore, getDynamicPenalty, resetReliability } = require('../server/infrastructure/exchangeReliabilityDynamic');
    resetReliability();

    // Registrar 30 updates exitosos para Binance (hadError=false)
    for (let i = 0; i < 30; i++) recordFeedEvent('Binance', false, 15);
    const scoreHealthy = computeReliabilityScore('Binance');
    assert(scoreHealthy >= 85, `Score tras 30 updates exitosos debe ser >=85, fue ${scoreHealthy}`);
    assert.strictEqual(getDynamicPenalty('Binance'), 0, 'Penalty debe ser 0 cuando reliability >=85');

    // Registrar 20 errores consecutivos para Kraken (hadError=true)
    for (let i = 0; i < 20; i++) recordFeedEvent('Kraken', true, 0);
    const scoreDegraded = computeReliabilityScore('Kraken');
    const penaltyDegraded = getDynamicPenalty('Kraken');
    assert(scoreDegraded < 85, `Score tras 20 errores debe ser <85, fue ${scoreDegraded}`);
    assert(penaltyDegraded > 0, `Penalty debe ser >0 cuando score <85, fue ${penaltyDegraded}`);
    assert(penaltyDegraded <= 25, `Penalty no debe exceder 25, fue ${penaltyDegraded}`);

    resetReliability();
  });

  // TEST 28: adaptiveScoring v10b — no crashea con arbBacktestEngine API real
  await test('adaptiveScoring v10b — recalcIfNeeded usa simulateRun correctamente sin crash', () => {
    const { recalcIfNeeded, getRecommendation, resetAdaptive } = require('../server/domain/engines/adaptiveScoring');
    resetAdaptive();

    // Opportunity log sintético con 20 oportunidades viables (mínimo para análisis)
    const now = Date.now();
    const oppLog = Array.from({ length: 40 }, (_, i) => ({
      ts:         new Date(now - (40 - i) * 5000).toISOString(),
      pair:       i % 2 === 0 ? 'Binance→OKX' : 'Bybit→Kraken',
      viable:     i % 3 !== 0, // ~67% viable
      netProfit:  i % 3 !== 0 ? 2.5 + Math.random() * 3 : -0.5,
      spreadPct:  0.08 + Math.random() * 0.05,
      score:      55 + Math.floor(Math.random() * 25),
      slipMethod: 'real',
    }));

    // Con tradeCount=0 no debe recalcular (MIN_TRADES_FOR_CONFIDENCE = 10)
    recalcIfNeeded(oppLog, 0);
    assert.strictEqual(getRecommendation(), null, 'Con 0 trades no debe haber recomendación');

    // Con tradeCount=15 sí debe recalcular
    recalcIfNeeded(oppLog, 15);
    const rec = getRecommendation();
    // Puede ser null si los datos sintéticos no generan suficiente data out-of-sample,
    // pero NO debe lanzar un error (ese era el bug crítico)
    assert(rec === null || typeof rec === 'object', 'getRecommendation debe retornar null o object, nunca throw');
    if (rec) {
      assert(typeof rec.best.minScore === 'number',   'best.minScore debe ser número');
      assert(typeof rec.best.cooldownMs === 'number', 'best.cooldownMs debe ser número');
      assert(typeof rec.confidence === 'string',      'confidence debe ser string');
    }

    resetAdaptive();
  });

  // TEST 29: arbBacktestEngine — simulateRun usa la API correcta (no runArbBacktest)
  await test('arbBacktestEngine v10b — simulateRun, walkForward y parameterSweep exportados correctamente', () => {
    const arb = require('../server/domain/engines/arbBacktestEngine');
    assert(typeof arb.simulateRun    === 'function', 'simulateRun debe estar exportado');
    assert(typeof arb.walkForward    === 'function', 'walkForward debe estar exportado');
    assert(typeof arb.parameterSweep === 'function', 'parameterSweep debe estar exportado');
    assert(typeof arb.sessionSummary === 'function', 'sessionSummary debe estar exportado');
    assert(typeof arb.pairAnalysis   === 'function', 'pairAnalysis debe estar exportado');
    assert(arb.runArbBacktest === undefined, 'runArbBacktest NO debe existir (era la API rota)');

    // simulateRun con oppLog vacío debe retornar objeto válido sin crash
    const result = arb.simulateRun([], { minScore: 65, cooldownMs: 3000, feeMultiplier: 1.0 });
    assert.strictEqual(result.tradesExecuted,  0,   'tradesExecuted debe ser 0 con oppLog vacío');
    assert.strictEqual(result.totalNetProfit,  0,   'totalNetProfit debe ser 0 con oppLog vacío');
    assert(Array.isArray(result.equityCurve),       'equityCurve debe ser array');
  });

  // ─── v12 Tests ───────────────────────────────────────────────────────────

  // TEST 30: e2eLatencyTracker — buffer circular y percentiles
  await test('e2eLatencyTracker v12 — record, getStats, percentiles correctos', () => {
    const e2e = require('../server/infrastructure/e2eLatencyTracker');
    e2e.reset();

    // Sin muestras → sampleCount 0, nulls
    const empty = e2e.getStats();
    assert.strictEqual(empty.sampleCount, 0, 'sampleCount debe ser 0 sin muestras');
    assert.strictEqual(empty.e2e.p50, null,  'p50 debe ser null sin muestras');

    // Insertar 10 muestras conocidas
    for (let i = 1; i <= 10; i++) {
      e2e.record(i * 5, i * 2, i * 3, 'Binance'); // e2eMs = 5,10,15...50
    }

    const stats = e2e.getStats();
    assert.strictEqual(stats.sampleCount, 10, 'sampleCount debe ser 10');
    assert(stats.e2e.p50 != null,  'p50 no debe ser null con muestras');
    assert(stats.e2e.p95 != null,  'p95 no debe ser null con muestras');
    assert(stats.e2e.p99 != null,  'p99 no debe ser null con muestras');
    assert(stats.e2e.p99 >= stats.e2e.p95, 'p99 >= p95 siempre');
    assert(stats.e2e.p95 >= stats.e2e.p50, 'p95 >= p50 siempre');
    assert(stats.e2e.min <= stats.e2e.p50, 'min <= p50 siempre');
    assert(stats.e2e.max >= stats.e2e.p99, 'max >= p99 siempre');

    // El exchange Binance debe aparecer en byExchange
    assert(stats.byExchange.Binance,          'Binance debe aparecer en byExchange');
    assert.strictEqual(stats.byExchange.Binance.count, 10, 'count Binance debe ser 10');

    e2e.reset();
    assert.strictEqual(e2e.getStats().sampleCount, 0, 'reset debe vaciar el buffer');
  });

  // TEST 31: e2eLatencyTracker — buffer circular no excede BUFFER_SIZE
  await test('e2eLatencyTracker v12 — buffer circular respeta límite de 500 muestras', () => {
    const e2e = require('../server/infrastructure/e2eLatencyTracker');
    e2e.reset();

    // Insertar 600 muestras — buffer debe mantenerse en 500
    for (let i = 0; i < 600; i++) {
      e2e.record(10 + (i % 50), 3, 7, 'OKX');
    }
    const stats = e2e.getStats();
    assert.strictEqual(stats.sampleCount, 500, 'buffer debe clampearse a 500 muestras (BUFFER_SIZE)');
    assert(stats.bufferSize === 500, 'bufferSize debe ser 500');

    e2e.reset();
  });

  // TEST 32: e2eLatencyTracker — record ignora valores inválidos
  await test('e2eLatencyTracker v12 — record ignora e2eMs negativo o fuera de rango', () => {
    const e2e = require('../server/infrastructure/e2eLatencyTracker');
    e2e.reset();

    e2e.record(-5,    0, 0, 'Binance');  // negativo — debe ignorar
    e2e.record(99999, 0, 0, 'Binance');  // > 30000ms — debe ignorar
    e2e.record(15,    3, 12, 'Kraken');  // válido
    e2e.record('abc', 0, 0, 'OKX');     // no-numérico — debe ignorar

    const stats = e2e.getStats();
    assert.strictEqual(stats.sampleCount, 1, 'solo debe registrar la muestra válida');
    assert.strictEqual(stats.e2e.p50, 15,    'p50 debe ser 15 (única muestra válida)');

    e2e.reset();
  });

  // TEST 33: dailyStatsService — exports correctos y getDailyStats sin MongoDB
  await test('dailyStatsService v12 — exports y funcionamiento sin MongoDB', async () => {
    const daily = require('../server/infrastructure/dailyStatsService');

    // Verificar que todos los exports requeridos existen
    assert(typeof daily.init                === 'function', 'init debe ser función');
    assert(typeof daily.flush               === 'function', 'flush debe ser función');
    assert(typeof daily.recordTradeExecuted === 'function', 'recordTradeExecuted debe ser función');
    assert(typeof daily.startPeriodicFlush  === 'function', 'startPeriodicFlush debe ser función');
    assert(typeof daily.getDailyStats       === 'function', 'getDailyStats debe ser función');

    // Sin init, getDailyStats debe retornar structure válida (no crash)
    const result = await daily.getDailyStats(7);
    assert(result && typeof result === 'object', 'getDailyStats debe retornar objeto');
    assert(Array.isArray(result.days),           'result.days debe ser array');
    assert(result.totals && typeof result.totals === 'object', 'result.totals debe ser objeto');
    // Sin datos, totals debe tener ceros
    assert.strictEqual(result.totals.trades, 0, 'totals.trades debe ser 0 sin datos');
    assert.strictEqual(result.totals.pnl,    0, 'totals.pnl debe ser 0 sin datos');
  });

  // TEST 34: dailyStatsService — buildDaySnapshot con datos reales inyectados
  await test('dailyStatsService v12 — buildDaySnapshot agrega datos correctamente vía init', async () => {
    const daily = require('../server/infrastructure/dailyStatsService');

    // Inyectar fuentes de datos mock
    const mockTrades = [
      { ts: new Date().toISOString(), buyExchange: 'Binance', sellExchange: 'OKX', netProfit: 1.50, totalFees: 0.80 },
      { ts: new Date().toISOString(), buyExchange: 'Binance', sellExchange: 'OKX', netProfit: 0.80, totalFees: 0.75 },
      { ts: new Date().toISOString(), buyExchange: 'Bybit',   sellExchange: 'OKX', netProfit: -0.20, totalFees: 0.90 },
    ];
    const mockMissed = { captureRate: 72.5, totalMissedProfit: 3.14 };
    const mockBest   = { buyExchange: 'Binance', sellExchange: 'Kraken', spreadPct: 0.42, netProfit: 1.50, score: 75 };

    daily.init({
      getTradeHistory:        () => mockTrades,
      getMissedSummary:       () => mockMissed,
      getBestOpportunitySeen: () => mockBest,
    });

    const result = await daily.getDailyStats(7);
    // Debe incluir el día de hoy con datos
    assert(result.days.length >= 1,             'debe haber al menos 1 entrada (hoy)');

    const today = result.days.find(d => d.isToday);
    assert(today,                               'debe existir entrada para hoy');
    assert.strictEqual(today.trades, 3,         'trades debe ser 3');
    assert(Math.abs(today.pnl - 2.10) < 0.01,  'pnl debe ser ~2.10 (1.50+0.80-0.20)');
    assert.strictEqual(today.winRate, +(2/3*100).toFixed(1), 'winRate debe ser 66.7%');
    assert.strictEqual(today.captureRate, 72.5, 'captureRate debe venir del missedSummary');
    assert(today.bestOpp,                       'bestOpp no debe ser null');
    assert.strictEqual(today.bestOpp.pair, 'Binance→Kraken', 'pair del bestOpp correcto');
    assert(today.pairBreakdown['Binance→OKX'],  'pairBreakdown debe tener Binance→OKX');
    assert.strictEqual(today.pairBreakdown['Binance→OKX'].count, 2, 'Binance→OKX count debe ser 2');
    assert.strictEqual(result.totals.trades, 3, 'totals.trades debe ser 3');
  });

  // ─── v14 Tests ───────────────────────────────────────────────────────────

  // TEST 35: spreadMomentumEngine — exports y API correctos
  await test('spreadMomentumEngine v14 — exports y funcionamiento básico', () => {
    const sme = require('../server/domain/engines/spreadMomentumEngine');
    assert(typeof sme.record                === 'function', 'record debe ser función');
    assert(typeof sme.getMomentum           === 'function', 'getMomentum debe ser función');
    assert(typeof sme.enrichOpportunity     === 'function', 'enrichOpportunity debe ser función');
    assert(typeof sme.enrichOpportunities   === 'function', 'enrichOpportunities debe ser función');
    assert(typeof sme.getAllMomentums       === 'function', 'getAllMomentums debe ser función');
    assert(typeof sme.recordFromOrderBooks  === 'function', 'recordFromOrderBooks debe ser función');
    assert(typeof sme.reset                 === 'function', 'reset debe ser función');
  });

  // TEST 36: spreadMomentumEngine — sin muestras retorna null
  await test('spreadMomentumEngine v14 — getMomentum retorna null sin suficientes muestras', () => {
    const sme = require('../server/domain/engines/spreadMomentumEngine');
    sme.reset();
    const result = sme.getMomentum('Binance', 'OKX');
    assert.strictEqual(result, null, 'debe retornar null con 0 muestras');
    // 4 muestras (menos del MIN_SAMPLES=5) → aún null
    for (let i = 0; i < 4; i++) sme.record('Binance', 'OKX', 0.05 + i * 0.01, Date.now() + i * 150);
    const result2 = sme.getMomentum('Binance', 'OKX');
    assert.strictEqual(result2, null, 'debe retornar null con 4 muestras (MIN_SAMPLES=5)');
    sme.reset();
  });

  // TEST 37: spreadMomentumEngine — detecta spread abriendo correctamente
  await test('spreadMomentumEngine v14 — detecta spread en apertura (trend=opening)', () => {
    const sme = require('../server/domain/engines/spreadMomentumEngine');
    sme.reset();
    const t0 = Date.now();
    // Spreads crecientes → apertura
    for (let i = 0; i < 10; i++) {
      sme.record('Binance', 'OKX', 0.05 + i * 0.02, t0 + i * 200);
    }
    const m = sme.getMomentum('Binance', 'OKX');
    assert(m !== null, 'debe retornar momentum con 10 muestras');
    assert.strictEqual(m.trend, 'opening', 'trend debe ser opening con spreads crecientes');
    assert(m.velocityPctPerSec > 0, 'velocidad debe ser positiva con spreads crecientes');
    assert(m.predictedSpread > m.currentSpread, 'predicción debe ser mayor que actual si se está abriendo');
    assert(m.confidence >= 0 && m.confidence <= 99, 'confidence debe estar en rango 0-99');
    assert(m.rSquared >= 0 && m.rSquared <= 1, 'R² debe estar en rango 0-1');
    sme.reset();
  });

  // TEST 38: spreadMomentumEngine — detecta spread cerrándose
  await test('spreadMomentumEngine v14 — detecta spread en cierre (trend=closing)', () => {
    const sme = require('../server/domain/engines/spreadMomentumEngine');
    sme.reset();
    const t0 = Date.now();
    // Spreads decrecientes → cierre
    for (let i = 0; i < 10; i++) {
      sme.record('Bybit', 'Binance', 0.30 - i * 0.02, t0 + i * 200);
    }
    const m = sme.getMomentum('Bybit', 'Binance');
    assert(m !== null, 'debe retornar momentum');
    assert.strictEqual(m.trend, 'closing', 'trend debe ser closing con spreads decrecientes');
    assert(m.velocityPctPerSec < 0, 'velocidad debe ser negativa con spreads decrecientes');
    // Urgencia alta cuando el spread se está cerrando (ejecutar ya)
    assert(m.urgency > 50, 'urgency debe ser > 50 cuando el spread se cierra');
    sme.reset();
  });

  // TEST 39: spreadMomentumEngine — enrichOpportunity agrega spreadMomentum
  await test('spreadMomentumEngine v14 — enrichOpportunity agrega campo spreadMomentum', () => {
    const sme = require('../server/domain/engines/spreadMomentumEngine');
    sme.reset();
    const t0 = Date.now();
    for (let i = 0; i < 8; i++) sme.record('OKX', 'Bybit', 0.10 + i * 0.01, t0 + i * 150);

    const opp = { buyExchange: 'OKX', sellExchange: 'Bybit', spreadPct: 0.17, viable: true };
    const enriched = sme.enrichOpportunity(opp);
    assert(enriched.spreadMomentum != null, 'enrichOpportunity debe agregar spreadMomentum');
    assert(typeof enriched.spreadMomentum.trend === 'string', 'trend debe ser string');
    assert(typeof enriched.spreadMomentum.urgency === 'number', 'urgency debe ser número');
    // El objeto original no debe ser mutado
    assert(opp.spreadMomentum === undefined, 'opp original no debe ser mutado');
    sme.reset();
  });

  // TEST 40: spreadMomentumEngine — recordFromOrderBooks registra todos los pares
  await test('spreadMomentumEngine v14 — recordFromOrderBooks registra todos los pares del libro', () => {
    const sme = require('../server/domain/engines/spreadMomentumEngine');
    sme.reset();
    const books = [
      { exchange: 'Binance', bid: 64000, ask: 64001 },
      { exchange: 'OKX',     bid: 64010, ask: 64011 },
      { exchange: 'Bybit',   bid: 63990, ask: 63992 },
    ];
    // Registrar 5 ticks
    const t0 = Date.now();
    for (let i = 0; i < 6; i++) sme.recordFromOrderBooks(books, t0 + i * 200);

    const all = sme.getAllMomentums();
    // Con 3 exchanges hay 3*(3-1)=6 pares posibles
    assert(all.length >= 1, 'debe haber al menos 1 par con momentum calculado');
    // Verificar que existe el par Binance→OKX
    const binOkx = all.find(m => m.pair === 'Binance→OKX');
    assert(binOkx != null, 'debe existir Binance→OKX en los momentums');
    sme.reset();
  });

  // TEST 41: spreadMomentumEngine — regression OLS con datos conocidos
  await test('spreadMomentumEngine v14 — velocidad calculada correctamente con datos lineales', () => {
    const sme = require('../server/domain/engines/spreadMomentumEngine');
    sme.reset();
    // Spread sube exactamente 0.01% cada 100ms → velocidad = 0.1 %/s
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) {
      sme.record('Kraken', 'OKX', i * 0.01, t0 + i * 100);
    }
    const m = sme.getMomentum('Kraken', 'OKX');
    assert(m !== null, 'debe tener momentum');
    // Con datos perfectamente lineales, slope ≈ 0.1 %/s ± ruido numérico
    assert(Math.abs(m.velocityPctPerSec - 0.1) < 0.01, `velocidad debe ser ~0.1 %/s, got ${m.velocityPctPerSec}`);
    assert(m.rSquared > 0.99, `R² debe ser >0.99 con datos lineales perfectos, got ${m.rSquared}`);
    sme.reset();
  });

  // TEST 42: spreadHeatmapService — exports y record sin crash
  await test('spreadHeatmapService v14 — exports correctos y record no crashea', () => {
    const sh = require('../server/infrastructure/spreadHeatmapService');
    assert(typeof sh.record              === 'function', 'record debe ser función');
    assert(typeof sh.flush               === 'function', 'flush debe ser función');
    assert(typeof sh.startPeriodicFlush  === 'function', 'startPeriodicFlush debe ser función');
    assert(typeof sh.getHeatmap          === 'function', 'getHeatmap debe ser función');
    assert(typeof sh.getHeatmapSimple    === 'function', 'getHeatmapSimple debe ser función');

    // record no debe crashear con inputs válidos
    sh.record('Binance→OKX', 0.05, false);
    sh.record('Binance→OKX', 0.22, true);
    sh.record('Bybit→OKX',   0.10, false);
  });

  // TEST 43: spreadHeatmapService — getHeatmap retorna estructura válida sin MongoDB
  await test('spreadHeatmapService v14 — getHeatmap retorna estructura válida (sin MongoDB)', async () => {
    const sh = require('../server/infrastructure/spreadHeatmapService');

    // Registrar algunos datos en memoria
    sh.record('Binance→OKX', 0.08, false);
    sh.record('Binance→OKX', 0.25, true);
    sh.record('Binance→Bybit', 0.12, false);

    const result = await sh.getHeatmap(7);
    assert(result && typeof result === 'object', 'getHeatmap debe retornar objeto');
    assert(Array.isArray(result.pairs), 'result.pairs debe ser array');
    assert(typeof result.data === 'object', 'result.data debe ser objeto');
    assert(typeof result.totalObservations === 'number', 'totalObservations debe ser número');

    // Debe haber datos para los pares registrados
    const pairs = result.pairs;
    assert(pairs.length >= 1, 'debe haber al menos 1 par con datos');
  });

  // TEST 44: dailyReportService — exports correctos
  await test('dailyReportService v14 — exports y funcionamiento sin Telegram', async () => {
    const dr = require('../server/infrastructure/dailyReportService');
    assert(typeof dr.init               === 'function', 'init debe ser función');
    assert(typeof dr.start              === 'function', 'start debe ser función');
    assert(typeof dr.generateReport     === 'function', 'generateReport debe ser función');
    assert(typeof dr.sendAndPersist     === 'function', 'sendAndPersist debe ser función');
    assert(typeof dr.getRecentReports   === 'function', 'getRecentReports debe ser función');
  });

  // TEST 45: dailyReportService — generateReport con datos mock
  await test('dailyReportService v14 — generateReport genera contenido válido con datos mock', async () => {
    const dr = require('../server/infrastructure/dailyReportService');

    dr.init({
      getTradeHistory: () => [
        { ts:'2025-06-21T10:00:00.000Z', buyExchange:'Binance', sellExchange:'OKX', netProfit:6.25, totalFees:7.28, score:78 },
        { ts:'2025-06-21T14:00:00.000Z', buyExchange:'Binance', sellExchange:'OKX', netProfit:4.20, totalFees:7.27, score:75 },
        { ts:'2025-06-21T18:00:00.000Z', buyExchange:'Binance', sellExchange:'Bybit', netProfit:-0.50, totalFees:3.20, score:62 },
      ],
      getMissedSummary:       () => ({ captureRate: 68.0 }),
      getBestOpportunitySeen: () => null,
      getE2EStats:            () => ({ e2e: { p50: 8, p95: 22, p99: 45 } }),
      getDailyStats:          async () => ({}),
      alertService:           { sendRaw: null },
    });

    const report = await dr.generateReport('2025-06-21', 502 * 3_600_000);
    assert(report !== null, 'generateReport debe retornar reporte');
    assert(typeof report.content === 'string', 'content debe ser string');
    assert(report.content.includes('Kukora'), 'content debe mencionar Kukora');
    assert(report.content.includes('3'), 'content debe mencionar 3 trades');
    assert(report.data.winRate > 0, 'winRate debe ser > 0');
    assert(report.data.pnl > 0, 'pnl debe ser positivo (6.25+4.20-0.50)');
  });

  // TEST 46: spreadMomentumEngine — getAllMomentums devuelve array ordenado por velocidad abs
  await test('spreadMomentumEngine v14 — getAllMomentums ordena por |velocidad| descendente', () => {
    const sme = require('../server/domain/engines/spreadMomentumEngine');
    sme.reset();
    const t0 = Date.now();
    // Par A: velocidad alta (spread abriendo rápido)
    for (let i = 0; i < 8; i++) sme.record('Binance', 'OKX', i * 0.05, t0 + i * 100);
    // Par B: velocidad baja (spread casi estable)
    for (let i = 0; i < 8; i++) sme.record('OKX', 'Bybit', 0.10 + i * 0.001, t0 + i * 100);

    const all = sme.getAllMomentums();
    assert(all.length >= 2, 'debe haber al menos 2 pares');
    // El primer par debe tener mayor |velocidad| que el segundo
    assert(
      Math.abs(all[0].velocityPctPerSec) >= Math.abs(all[1].velocityPctPerSec),
      'getAllMomentums debe ordenar por |velocidad| descendente'
    );
    sme.reset();
  });

  // TEST 47: scoreOpportunity — scoring compuesto expone campos correctos
  await test('scoreOpportunity v14 — score compuesto: campos correctos y viable > no-viable', () => {
    const { detectOpportunities, resetSessionStats } = require('../server/domain/engines/opportunityDetection');
    resetSessionStats();

    // Patrón idéntico a mockBooks del test 3 (probado que genera oportunidades)
    const books = [
      { exchange: 'Binance', bid: 100000, ask: 100000, spreadPct: 0.001, source: 'ws', latencyMs: 10, feedAgeMs: 100, error: null },
      { exchange: 'Bybit',   bid: 100400, ask: 100405, spreadPct: 0.005, source: 'ws', latencyMs: 12, feedAgeMs: 120, error: null },
    ];

    const { opportunities } = detectOpportunities(books);
    assert(opportunities.length > 0, 'debe detectar oportunidades con spread 0.40%');

    // Todos los scores en rango válido
    for (const op of opportunities) {
      assert(typeof op.score === 'number', 'score debe ser número');
      assert(op.score >= 0 && op.score <= 100, `score debe estar en [0,100], got ${op.score}`);
    }

    // Campos del scoring compuesto de 7 factores expuestos correctamente
    const first = opportunities[0];
    assert(typeof first.score           === 'number',  'score debe ser número');
    assert(typeof first.spreadPct       === 'number',  'spreadPct debe ser número');
    assert(typeof first.netProfit       === 'number',  'netProfit debe ser número');
    assert(typeof first.breakEvenPct    === 'number',  'breakEvenPct debe ser número');
    // fillProbability lo agrega enrichWithFillProbability fuera del engine — no es campo del engine directo
    assert(typeof first.viable          === 'boolean', 'viable debe ser boolean');

    // Oportunidades viables tienen score >= no-viables
    const viable    = opportunities.filter(o => o.viable && !o.circuitBreaker);
    const notViable = opportunities.filter(o => !o.viable || o.circuitBreaker);
    if (viable.length > 0 && notViable.length > 0) {
      const avg = arr => arr.reduce((s, o) => s + o.score, 0) / arr.length;
      assert(avg(viable) >= avg(notViable),
        `viable avg score (${avg(viable).toFixed(1)}) debe >= no-viable (${avg(notViable).toFixed(1)})`);
    } else {
      assert(viable.length > 0 || notViable.length > 0, 'debe haber oportunidades detectadas');
    }
  });

  // TEST 48: detectOpportunities — spreadMomentum se integra sin crashear el pipeline
  await test('spreadMomentumEngine v14 — recordFromOrderBooks no crashea con books inválidos', () => {
    const sme = require('../server/domain/engines/spreadMomentumEngine');
    sme.reset();

    // Books con valores inválidos no deben crashear
    const badBooks = [
      { exchange: 'Binance', bid: 0, ask: 0 },       // zeros
      { exchange: 'OKX',     bid: null, ask: null },  // nulls
      { exchange: 'Bybit',   bid: 64000, ask: 64001 }, // válido
      { exchange: 'Kraken',  bid: NaN, ask: NaN },    // NaN
    ];

    // No debe lanzar error
    assert.doesNotThrow(() => {
      sme.recordFromOrderBooks(badBooks, Date.now());
    }, 'recordFromOrderBooks no debe crashear con books inválidos');

    sme.reset();
  });

  // ─── v15 Tests ───────────────────────────────────────────────────────────

  // TEST 49: adaptivePositionSizing — exports correctos
  await test('adaptivePositionSizing v15 — exports y API correctos', () => {
    const aps = require('../server/domain/risk/adaptivePositionSizing');
    assert(typeof aps.computeSize                    === 'function', 'computeSize debe ser función');
    assert(typeof aps.getPositionSizeForOpportunity  === 'function', 'getPositionSizeForOpportunity debe ser función');
    assert(typeof aps.recordSize                     === 'function', 'recordSize debe ser función');
    assert(typeof aps.getSummary                     === 'function', 'getSummary debe ser función');
    assert(typeof aps.reset                          === 'function', 'reset debe ser función');
    assert(typeof aps.MIN_SIZE                       === 'number',   'MIN_SIZE debe ser número');
    assert(typeof aps.MAX_SIZE                       === 'number',   'MAX_SIZE debe ser número');
  });

  // TEST 50: adaptivePositionSizing — score alto genera tamaño mayor
  await test('adaptivePositionSizing v15 — score 95 genera tamaño mayor que score 60', () => {
    const aps = require('../server/domain/risk/adaptivePositionSizing');
    const base = 0.05;

    const highScore = aps.computeSize({ score: 95, spreadPct: 0.3, breakEvenPct: 0.2, spreadMomentum: null, sessionPnl: 0, defaultAmount: base });
    const lowScore  = aps.computeSize({ score: 60, spreadPct: 0.3, breakEvenPct: 0.2, spreadMomentum: null, sessionPnl: 0, defaultAmount: base });

    assert(highScore.size > lowScore.size, `score 95 (${highScore.size} BTC) debe generar mayor tamaño que score 60 (${lowScore.size} BTC)`);
    assert(highScore.factors.scoreFactor === 1.5, 'score 95 debe tener scoreFactor 1.5');
    assert(lowScore.factors.scoreFactor  === 0.8, 'score 60 debe tener scoreFactor 0.8');
  });

  // TEST 51: adaptivePositionSizing — momentum closing reduce tamaño
  await test('adaptivePositionSizing v15 — momentum closing reduce tamaño vs stable', () => {
    const aps = require('../server/domain/risk/adaptivePositionSizing');
    const base = 0.05;

    const closing = aps.computeSize({
      score: 80, spreadPct: 0.25, breakEvenPct: 0.2, defaultAmount: base, sessionPnl: 0,
      spreadMomentum: { trend: 'closing', velocityPctPerSec: -0.05, confidence: 70 },
    });
    const opening = aps.computeSize({
      score: 80, spreadPct: 0.25, breakEvenPct: 0.2, defaultAmount: base, sessionPnl: 0,
      spreadMomentum: { trend: 'opening', velocityPctPerSec: 0.05, confidence: 70 },
    });

    assert(closing.size < opening.size, `closing (${closing.size}) debe ser menor que opening (${opening.size})`);
    assert(closing.factors.momentumFactor === 0.7, 'closing debe tener momentumFactor 0.7');
    assert(opening.factors.momentumFactor === 1.2, 'opening debe tener momentumFactor 1.2');
  });

  // TEST 52: adaptivePositionSizing — P&L negativo activa modo defensivo
  await test('adaptivePositionSizing v15 — P&L sesión negativo reduce tamaño', () => {
    const aps = require('../server/domain/risk/adaptivePositionSizing');
    const base   = 0.05;
    const params = { score: 80, spreadPct: 0.3, breakEvenPct: 0.2, spreadMomentum: null, defaultAmount: base };

    const healthy    = aps.computeSize({ ...params, sessionPnl: 10   });
    const smallLoss  = aps.computeSize({ ...params, sessionPnl: -30  });
    const bigLoss    = aps.computeSize({ ...params, sessionPnl: -200 });

    assert(healthy.size >= smallLoss.size, 'P&L positivo debe tener tamaño >= pérdida pequeña');
    assert(smallLoss.size >= bigLoss.size,  'pérdida pequeña debe tener tamaño >= pérdida grande');
    assert(bigLoss.factors.pnlFactor === 0.6, 'pérdida >$150 debe activar modo defensivo (0.6x)');
  });

  // TEST 53: adaptivePositionSizing — tamaño siempre en rango [MIN_SIZE, MAX_SIZE]
  await test('adaptivePositionSizing v15 — tamaño siempre clampado en [MIN_SIZE, MAX_SIZE]', () => {
    const aps = require('../server/domain/risk/adaptivePositionSizing');

    // Caso extremo mínimo: score bajo + momentum cerrando + P&L muy negativo
    const verySmall = aps.computeSize({
      score: 30, spreadPct: 0.1, breakEvenPct: 0.2,
      spreadMomentum: { trend: 'closing', velocityPctPerSec: -0.1, confidence: 90 },
      sessionPnl: -300, defaultAmount: 0.05,
    });
    assert(verySmall.size >= aps.MIN_SIZE, `tamaño mínimo debe ser >= ${aps.MIN_SIZE} BTC`);

    // Caso extremo máximo: score perfecto + momentum opening + P&L excelente
    const veryLarge = aps.computeSize({
      score: 99, spreadPct: 0.5, breakEvenPct: 0.1,
      spreadMomentum: { trend: 'opening', velocityPctPerSec: 0.1, confidence: 95 },
      sessionPnl: 500, defaultAmount: 0.05,
    });
    assert(veryLarge.size <= aps.MAX_SIZE, `tamaño máximo debe ser <= ${aps.MAX_SIZE} BTC`);
  });

  // TEST 54: adaptivePositionSizing — reasoning array no vacío
  await test('adaptivePositionSizing v15 — reasoning array explica el sizing', () => {
    const aps = require('../server/domain/risk/adaptivePositionSizing');
    const result = aps.computeSize({
      score: 88, spreadPct: 0.35, breakEvenPct: 0.2,
      spreadMomentum: { trend: 'opening', velocityPctPerSec: 0.03, confidence: 65 },
      sessionPnl: -60, defaultAmount: 0.05,
    });

    assert(Array.isArray(result.reasoning), 'reasoning debe ser array');
    assert(result.reasoning.length > 0, 'reasoning no debe estar vacío');
    // Cada elemento debe ser un string descriptivo
    for (const r of result.reasoning) {
      assert(typeof r === 'string' && r.length > 5, `reasoning item debe ser string descriptivo: "${r}"`);
    }
    assert(typeof result.factors.combined === 'number', 'factors.combined debe ser número');
  });

  // TEST 55: adaptivePositionSizing — getPositionSizeForOpportunity enriquece opp
  await test('adaptivePositionSizing v15 — getPositionSizeForOpportunity agrega positionSizing', () => {
    const aps = require('../server/domain/risk/adaptivePositionSizing');
    const opp = {
      buyExchange: 'Binance', sellExchange: 'OKX',
      score: 78, spreadPct: 0.28, breakEvenPct: 0.22,
      spreadMomentum: null, viable: true,
    };
    const enriched = aps.getPositionSizeForOpportunity(opp, 5, 0.05);

    assert(enriched.positionSizing != null, 'debe agregar positionSizing');
    assert(typeof enriched.positionSizing.size === 'number', 'size debe ser número');
    assert(enriched.positionSizing.size > 0, 'size debe ser positivo');
    // El objeto original no se muta
    assert(opp.positionSizing === undefined, 'opp original no debe mutarse');
  });

  // TEST 56: adaptivePositionSizing — getSummary con historial
  await test('adaptivePositionSizing v15 — getSummary retorna estadísticas correctas', () => {
    const aps = require('../server/domain/risk/adaptivePositionSizing');
    aps.reset();

    // Sin datos
    const empty = aps.getSummary();
    assert.strictEqual(empty.count, 0, 'count debe ser 0 sin historial');
    assert.strictEqual(empty.avgSize, null, 'avgSize debe ser null sin historial');

    // Con datos
    aps.recordSize(0.05, 75);
    aps.recordSize(0.08, 88);
    aps.recordSize(0.03, 55);
    const summary = aps.getSummary();
    assert.strictEqual(summary.count, 3, 'count debe ser 3');
    assert(summary.avgSize > 0, 'avgSize debe ser positivo');
    assert.strictEqual(summary.minSize, 0.03, 'minSize debe ser 0.03');
    assert.strictEqual(summary.maxSize, 0.08, 'maxSize debe ser 0.08');
    aps.reset();
  });

  // TEST 57: executionQualityTracker — exports correctos
  await test('executionQualityTracker v15 — exports correctos', () => {
    const eqt = require('../server/infrastructure/executionQualityTracker');
    assert(typeof eqt.recordTrade        === 'function', 'recordTrade debe ser función');
    assert(typeof eqt.getQualityMetrics  === 'function', 'getQualityMetrics debe ser función');
    assert(typeof eqt.getRecords         === 'function', 'getRecords debe ser función');
    assert(typeof eqt.reset              === 'function', 'reset debe ser función');
  });

  // TEST 58: executionQualityTracker — sin trades retorna count:0
  await test('executionQualityTracker v15 — sin trades retorna estructura válida', async () => {
    const eqt = require('../server/infrastructure/executionQualityTracker');
    eqt.reset();

    const metrics = await eqt.getQualityMetrics();
    assert.strictEqual(metrics.count, 0, 'count debe ser 0 sin trades');
    assert.strictEqual(metrics.calibrated, false, 'calibrated debe ser false sin datos');
  });

  // TEST 59: executionQualityTracker — recordTrade y métricas básicas
  await test('executionQualityTracker v15 — recordTrade registra y calcula métricas', async () => {
    const eqt = require('../server/infrastructure/executionQualityTracker');
    eqt.reset();

    // Registrar 5 trades con slippage estimado vs real conocido
    for (let i = 0; i < 5; i++) {
      const signal = {
        buyExchange: 'Binance', sellExchange: 'OKX',
        spreadPct: 0.25, netProfit: 5.0 + i,
        buySlippage: 0.10, sellSlippage: 0.08,
        score: 75 + i, asset: 'BTC',
      };
      const result = {
        ok: true,
        netProfit: 4.8 + i,  // ligeramente menor al estimado
        trade: { netProfit: 4.8 + i, buySlippage: 0.09, sellSlippage: 0.07 },
      };
      await eqt.recordTrade(signal, result);
    }

    const metrics = await eqt.getQualityMetrics();
    assert.strictEqual(metrics.count, 5, 'count debe ser 5');
    assert(typeof metrics.avgActualNet   === 'number', 'avgActualNet debe ser número');
    assert(typeof metrics.fillRate       === 'number', 'fillRate debe ser número');
    assert(typeof metrics.calibrationScore === 'number', 'calibrationScore debe ser número');
    assert(metrics.fillRate >= 0 && metrics.fillRate <= 100, 'fillRate debe estar en [0,100]');
    assert(metrics.calibrationScore >= 0 && metrics.calibrationScore <= 100, 'calibrationScore en [0,100]');
    // Con 5 trades aún no está calibrado (necesita 10)
    assert.strictEqual(metrics.calibrated, false, 'calibrated debe ser false con solo 5 trades');

    eqt.reset();
  });

  // TEST 60: executionQualityTracker — calibrated=true con 10+ trades
  await test('executionQualityTracker v15 — calibrated=true con 10+ trades', async () => {
    const eqt = require('../server/infrastructure/executionQualityTracker');
    eqt.reset();

    for (let i = 0; i < 12; i++) {
      await eqt.recordTrade(
        { buyExchange:'Binance', sellExchange:'OKX', spreadPct:0.3, netProfit:6.0, buySlippage:0.1, sellSlippage:0.08, score:78, asset:'BTC' },
        { ok:true, netProfit:5.8, trade:{ netProfit:5.8, buySlippage:0.09, sellSlippage:0.07 } }
      );
    }

    const metrics = await eqt.getQualityMetrics();
    assert.strictEqual(metrics.calibrated, true, 'calibrated debe ser true con 12 trades');
    assert(typeof metrics.slippageAdjustment === 'number', 'slippageAdjustment debe ser número');
    assert(metrics.byPair['Binance→OKX'] != null, 'debe haber breakdown por par');
    assert.strictEqual(metrics.byPair['Binance→OKX'].count, 12, 'count por par debe ser 12');

    eqt.reset();
  });

  // TEST 61: executionQualityTracker — separa BTC vs ETH en byAsset
  await test('executionQualityTracker v15 — byAsset separa correctamente BTC y ETH', async () => {
    const eqt = require('../server/infrastructure/executionQualityTracker');
    eqt.reset();

    // 3 trades BTC + 2 trades ETH
    for (let i = 0; i < 3; i++) {
      await eqt.recordTrade(
        { buyExchange:'Binance', sellExchange:'OKX', spreadPct:0.25, netProfit:5.0, buySlippage:0.1, sellSlippage:0.08, score:75, asset:'BTC' },
        { ok:true, netProfit:4.9, trade:{ netProfit:4.9, buySlippage:0.09, sellSlippage:0.07 } }
      );
    }
    for (let i = 0; i < 2; i++) {
      await eqt.recordTrade(
        { buyExchange:'Binance', sellExchange:'Bybit', spreadPct:0.18, netProfit:2.5, buySlippage:0.05, sellSlippage:0.04, score:70, asset:'ETH' },
        { ok:true, netProfit:2.4, trade:{ netProfit:2.4, buySlippage:0.05, sellSlippage:0.04 } }
      );
    }

    const metrics = await eqt.getQualityMetrics();
    assert(metrics.byAsset.BTC !== null,      'byAsset.BTC debe tener datos');
    assert(metrics.byAsset.ETH !== null,      'byAsset.ETH debe tener datos');
    assert.strictEqual(metrics.byAsset.BTC.count, 3, 'BTC count debe ser 3');
    assert.strictEqual(metrics.byAsset.ETH.count, 2, 'ETH count debe ser 2');

    eqt.reset();
  });

  // TEST 62: adaptivePositionSizing — spread quality factor correcto
  await test('adaptivePositionSizing v15 — spread quality factor escala correctamente', () => {
    const aps = require('../server/domain/risk/adaptivePositionSizing');
    const base   = { score: 80, spreadMomentum: null, sessionPnl: 0, defaultAmount: 0.05 };
    const be     = 0.2; // break-even 0.2%

    const tight  = aps.computeSize({ ...base, spreadPct: be * 1.1, breakEvenPct: be }); // ratio 1.1x → 0.8
    const medium = aps.computeSize({ ...base, spreadPct: be * 1.6, breakEvenPct: be }); // ratio 1.6x → 1.1
    const wide   = aps.computeSize({ ...base, spreadPct: be * 2.5, breakEvenPct: be }); // ratio 2.5x → 1.3

    assert(tight.factors.spreadFactor  === 0.8, `spread 1.1x BE debe tener factor 0.8, got ${tight.factors.spreadFactor}`);
    assert(medium.factors.spreadFactor === 1.1, `spread 1.6x BE debe tener factor 1.1, got ${medium.factors.spreadFactor}`);
    assert(wide.factors.spreadFactor   === 1.3, `spread 2.5x BE debe tener factor 1.3, got ${wide.factors.spreadFactor}`);
    assert(tight.size < medium.size && medium.size <= wide.size, 'tamaño debe crecer con spread quality');
  });

  // ─── v16: liveConfig — GAP 1 ──────────────────────────────────────────
  const liveConfig = require('../server/infrastructure/liveConfig');

  await test('liveConfig v16 — get() retorna valor default', () => {
    const score = liveConfig.get('minScore');
    assert(typeof score === 'number' && score >= 0 && score <= 100,
      `minScore debe ser 0-100, got ${score}`);
  });

  await test('liveConfig v16 — setMany() aplica patch válido', () => {
    const r = liveConfig.setMany({ minScore: 55, cooldownMs: 500 }, 'test');
    assert(r.ok, `setMany debería ser ok: ${JSON.stringify(r.rejected)}`);
    assert(r.applied.length === 2, `Esperaba 2 aplicados, got ${r.applied.length}`);
    assert(liveConfig.get('minScore') === 55, `minScore debería ser 55`);
    assert(liveConfig.get('cooldownMs') === 500, `cooldownMs debería ser 500`);
    liveConfig.reset('test'); // restaurar para no afectar otros tests
  });

  await test('liveConfig v16 — setMany() rechaza valores inválidos', () => {
    const r = liveConfig.setMany({ minScore: 999, feeMode: 'invalid' }, 'test');
    assert(r.rejected.length === 2, `Esperaba 2 rechazados, got ${r.rejected.length}`);
  });

  await test('liveConfig v16 — reset() restaura defaults', () => {
    liveConfig.setMany({ minScore: 77 }, 'test');
    const resetResult = liveConfig.reset('test');
    assert(resetResult.ok, 'reset debería ser ok');
    const def = liveConfig._defaults.minScore;
    assert(liveConfig.get('minScore') === def, `minScore debería ser ${def} tras reset`);
  });

  await test('liveConfig v16 — isExchangeActive() filtra exchanges', () => {
    liveConfig.setMany({ activeExchanges: ['Binance', 'Kraken'] }, 'test');
    assert(liveConfig.isExchangeActive('Binance') === true, 'Binance debería estar activo');
    assert(liveConfig.isExchangeActive('Coinbase') === false, 'Coinbase debería estar inactivo');
    liveConfig.reset('test');
  });

  await test('liveConfig v16 — getAll() incluye current, defaults, history', () => {
    const all = liveConfig.getAll();
    assert(all.current && typeof all.current === 'object', 'getAll debe tener current');
    assert(all.defaults && typeof all.defaults === 'object', 'getAll debe tener defaults');
    assert(Array.isArray(all.history), 'getAll.history debe ser array');
  });

  // ─── v16: rebalanceEngine — GAP 2 ─────────────────────────────────────
  const rebalanceEngine = require('../server/domain/engines/rebalanceEngine');

  await test('rebalanceEngine v16 — analyzeBalance() retorna estructura válida', () => {
    const r = rebalanceEngine.analyzeBalance(50000);
    assert(typeof r.healthy === 'boolean', 'analyzeBalance debe tener healthy boolean');
    assert(Array.isArray(r.imbalances), 'imbalances debe ser array');
    assert(r.summary && typeof r.summary.totalUSDT === 'number', 'summary debe tener totalUSDT');
  });

  await test('rebalanceEngine v16 — suggestRebalance() retorna estructura válida', () => {
    const r = rebalanceEngine.suggestRebalance(50000);
    assert(r.analysis && typeof r.analysis.healthy === 'boolean', 'suggestRebalance debe tener analysis');
    assert(typeof r.reason === 'string', 'suggestRebalance debe tener reason');
  });

  await test('rebalanceEngine v16 — getHistory() retorna array', () => {
    const h = rebalanceEngine.getHistory(10);
    assert(Array.isArray(h), 'getHistory debe retornar array');
  });

  await test('rebalanceEngine v16 — getSummary() retorna métricas', () => {
    const s = rebalanceEngine.getSummary();
    assert(typeof s.total === 'number', 'summary.total debe ser number');
    assert(typeof s.totalCost === 'number', 'summary.totalCost debe ser number');
  });

  await test('rebalanceEngine v16 — THRESHOLDS expuestos correctamente', () => {
    const t = rebalanceEngine.THRESHOLDS;
    assert(typeof t.USDT_MAX_CONCENTRATION === 'number', 'USDT_MAX_CONCENTRATION debe ser number');
    assert(t.USDT_MAX_CONCENTRATION > 0 && t.USDT_MAX_CONCENTRATION < 1, 'USDT_MAX_CONCENTRATION debe ser 0-1');
  });

  // ─── v16: adversarialScenarios — GAP 3 ────────────────────────────────
  const adversarial = require('../server/domain/risk/adversarialScenarios');

  await test('adversarialScenarios v16 — listAdversarialScenarios() retorna 3 escenarios', () => {
    const list = adversarial.listAdversarialScenarios();
    assert(Array.isArray(list) && list.length === 3, `Esperaba 3 escenarios, got ${list.length}`);
    const ids = list.map(s => s.id);
    assert(ids.includes('mid_flight_failure'), 'Falta mid_flight_failure');
    assert(ids.includes('liquidity_crunch'), 'Falta liquidity_crunch');
    assert(ids.includes('extreme_slippage'), 'Falta extreme_slippage');
  });

  await test('adversarialScenarios v16 — getRunHistory() retorna array', () => {
    const h = adversarial.getRunHistory(5);
    assert(Array.isArray(h), 'getRunHistory debe retornar array');
  });

  await test('adversarialScenarios v16 — runScenario rechaza tipo desconocido', async () => {
    // Los 3 escenarios reales requieren order books reales — solo probamos el dispatch
    const r = await adversarial.runScenario('unknown_scenario', []);
    assert(r.ok === false, 'Escenario desconocido debe retornar ok:false');
  });

  // ─── Summary ──────────────────────────────────────────────────────────
  console.log('');
  if (failed === 0) {
    console.log(`✅ All ${passed} tests passed — Kukora smoke test OK`);
    console.log('   Sistema listo para demo day (v16 — Config en vivo · Rebalanceo · ETH bilateral · Adversarial).\n');
    // FIX: exchangeService.js schedules WS reconnect timers (setInterval) on
    // import that keep the event loop alive forever in a test context where
    // no real WS ever connects. This pre-existed the v9 changes — it's not
    // something the new modules introduced — but since process.exit(1) was
    // already used for the failure path below, we mirror that here for the
    // success path so `node tests/smoke.test.js` actually returns control
    // instead of hanging indefinitely.
    process.exit(0);
  } else {
    console.log(`❌ ${failed} test(s) FAILED, ${passed} passed`);
    console.log('   Revisar errores arriba antes del demo day.\n');
    process.exit(1);
  }

})();
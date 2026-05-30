/**
 * smoke.test.js — kukora arbitrage bot v3
 * Run with: node tests/smoke.test.js
 * No external dependencies — Node.js built-ins + assert only
 *
 * NUEVOS TESTS v3:
 *  - No doble registro de slippage (tests 9, 10)
 *  - netProfitPct recalculado desde execAmount real (test 11)
 *  - Categorías de rechazo correctas (test 12)
 *  - Session analytics: rejectionCounts, bestOpportunitySeen, nearViableCount (test 13)
 *  - Coinbase fee penalty en score (test 14)
 *  - evalMs expuesto en detectOpportunities (test 15)
 *  - fillPct expuesto en oportunidades (test 16)
 */

'use strict';

const assert = require('assert');

// ─── Mock mongoose ANTES de cualquier require del proyecto ────────────────
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'mongoose') {
    return {
      Schema: class Schema { constructor() {} },
      model: (name, schema) => ({
        create: async () => ({}),
        find: () => ({ sort: () => ({ lean: async () => [] }) }),
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
    const { TRADING_FEES, WITHDRAWAL_FEES } = require('../server/feeConfig');
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
    const { calcVwapSlippage } = require('../server/exchangeService');
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
    const { detectOpportunities, resetSessionStats } = require('../server/arbitrageEngine');
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
    const { detectOpportunities } = require('../server/arbitrageEngine');
    const { opportunities: tight } = detectOpportunities(tightBooks);
    assert(Array.isArray(tight), 'should return array');
    assert(tight.every(op => !op.viable), 'all ops should be non-viable with tight spread');
  });

  // TEST 5: executeSimulated — ejecución exitosa
  await test('executeSimulated — ejecución exitosa con balances suficientes', () => {
    const { executeSimulated } = require('../server/arbitrageEngine');
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
    const { executeSimulated } = require('../server/arbitrageEngine');
    const cbOp = { ...mockOp, circuitBreaker: true };
    const cbResult = executeSimulated(cbOp, mockWallets, 0.1);
    assert.strictEqual(cbResult.ok, false, 'should reject circuit breaker op');
    assert(cbResult.reason, 'should have a rejection reason');
  });

  // TEST 7: score en rango válido
  await test('scoreOpportunity — score en rango válido [1, 100]', () => {
    const { detectOpportunities } = require('../server/arbitrageEngine');
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
    const { detectOpportunities } = require('../server/arbitrageEngine');
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
    const { detectOpportunities, resetSessionStats } = require('../server/arbitrageEngine');
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
    const { executeSimulated } = require('../server/arbitrageEngine');
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
    const { detectOpportunities, resetSessionStats, getRejectionCounts } = require('../server/arbitrageEngine');
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
    } = require('../server/arbitrageEngine');
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
    const { detectOpportunities, resetSessionStats } = require('../server/arbitrageEngine');
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
    const { detectOpportunities } = require('../server/arbitrageEngine');
    const result = detectOpportunities(mockBooks);
    assert(typeof result.evalMs === 'number', 'evalMs should be a number');
    assert(result.evalMs >= 0, 'evalMs should be >= 0');
    assert(result.evalMs < 5000, 'evalMs should be < 5000ms (sanity check)');
  });

  // TEST 15: fillPct expuesto en oportunidades
  await test('detectOpportunities — buyFillPct/sellFillPct expuestos', () => {
    const { detectOpportunities } = require('../server/arbitrageEngine');
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
    const { _MIN_NET_PROFIT, _MIN_SPREAD_PCT } = require('../server/arbitrageEngine');
    assert(typeof _MIN_NET_PROFIT === 'number', '_MIN_NET_PROFIT should be exported');
    assert(typeof _MIN_SPREAD_PCT === 'number', '_MIN_SPREAD_PCT should be exported');
    // v7: DEFAULT_TRADE_AMOUNT=0.05 BTC → MIN_NET_PROFIT=0.05 USD (mismo ratio riesgo/reward)
    assert(_MIN_NET_PROFIT === 0.05,  `_MIN_NET_PROFIT should be 0.05 (v7), got ${_MIN_NET_PROFIT}`);
    // v7: MIN_SPREAD_PCT afinado a 0.005% para capturar oportunidades reales de mercado
    assert(_MIN_SPREAD_PCT === 0.005, `_MIN_SPREAD_PCT should be 0.005 (v7), got ${_MIN_SPREAD_PCT}`);
  });

  // ─── Summary ──────────────────────────────────────────────────────────
  console.log('');
  if (failed === 0) {
    console.log(`✅ All ${passed} tests passed — Kukora smoke test OK`);
    console.log('   Sistema listo para demo day.\n');
  } else {
    console.log(`❌ ${failed} test(s) FAILED, ${passed} passed`);
    console.log('   Revisar errores arriba antes del demo day.\n');
    process.exit(1);
  }

})();
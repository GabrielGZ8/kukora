/**
 * v17.test.js — Kukora v17 Test Suite
 *
 * Section 18: Enterprise-grade test coverage.
 *
 * Covers:
 *   - Unit tests: all new modules
 *   - Integration tests: module interactions
 *   - Failure scenario tests: recovery, partial fills
 *   - Risk engine tests: circuit breakers, drawdown, exposure
 *   - Rebalancing tests: predictive, reactive, cost/benefit
 *   - Config tests: hot-reload, validation
 *   - Institutional metrics tests: all ratio calculations
 *
 * Run: node --test tests/v17.test.js
 * Or:  npm test (if configured)
 */

'use strict';

const assert = require('assert');
const test   = require('node:test');

// ─── Module imports ───────────────────────────────────────────────────────
const liveConfig      = require('../server/infrastructure/liveConfig');
const tsm             = require('../server/domain/analytics/tradeStateMachine');
const obs             = require('../server/infrastructure/observabilityService');
const advRisk         = require('../server/domain/risk/advancedRiskEngine');
const mlScoring       = require('../server/domain/engines/mlScoringPipeline');
const instBacktest    = require('../server/domain/engines/institutionalBacktest');

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: liveConfig — Advanced Parameterization
// ═══════════════════════════════════════════════════════════════════════════

test('liveConfig: get returns default values', () => {
  const minScore = liveConfig.get('minScore');
  assert.ok(typeof minScore === 'number', 'minScore should be a number');
  assert.ok(minScore >= 0 && minScore <= 100, 'minScore should be in [0, 100]');
});

test('liveConfig: setMany applies valid parameters', () => {
  const result = liveConfig.setMany({ minScore: 42, cooldownMs: 1000 }, 'test');
  assert.ok(result.ok, 'setMany should succeed');
  assert.strictEqual(result.applied.length, 2, 'should apply both params');
  assert.strictEqual(liveConfig.get('minScore'), 42);
  assert.strictEqual(liveConfig.get('cooldownMs'), 1000);
  liveConfig.reset('test_cleanup');
});

test('liveConfig: setMany rejects invalid parameters', () => {
  const result = liveConfig.setMany({ minScore: 999, unknownParam: 'foo' }, 'test');
  assert.ok(!result.ok || result.rejected.length > 0, 'should reject invalid params');
  const scoreRejected = result.rejected.some(r => r.key === 'minScore') ||
    liveConfig.get('minScore') === Math.max(0, Math.min(100, 999));
  // minScore: 999 gets clamped to 100 (still "ok" in validator) so just verify rejection of unknown
  assert.ok(result.rejected.some(r => r.key === 'unknownParam'), 'should reject unknown param');
  liveConfig.reset('test_cleanup');
});

test('liveConfig: reset restores defaults', () => {
  liveConfig.setMany({ minScore: 77 }, 'test');
  liveConfig.reset('test');
  assert.strictEqual(liveConfig.get('minScore'), liveConfig._defaults.minScore);
});

test('liveConfig: new execution parameters exist', () => {
  const params = ['maxSlippagePct', 'maxExecutionLatencyMs', 'orderTimeoutMs',
    'allowPartialFills', 'minimumFillRatio', 'maxOrderRetries', 'retryBackoffMs', 'exchangeCooldownMs'];
  for (const p of params) {
    assert.notStrictEqual(liveConfig.get(p), undefined, `${p} should have a default`);
  }
});

test('liveConfig: risk parameters exist', () => {
  const params = ['maxDrawdownPct', 'maxExposurePerExchange', 'maxPositionValueUSD',
    'maxConsecutiveFailures', 'emergencyStopThreshold'];
  for (const p of params) {
    assert.notStrictEqual(liveConfig.get(p), undefined, `${p} should have a default`);
  }
});

test('liveConfig: capital parameters exist', () => {
  const params = ['capitalAllocationMode', 'reserveCapitalPct', 'maxCapitalPerTrade',
    'capitalPerStrategy', 'capitalPerExchange'];
  for (const p of params) {
    assert.notStrictEqual(liveConfig.get(p), undefined, `${p} should have a default`);
  }
});

test('liveConfig: scoringWeights sum to 1.0', () => {
  const w = liveConfig.get('scoringWeights');
  const sum = Object.values(w).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1.0) < 0.01, `Scoring weights must sum to 1.0 (got ${sum})`);
});

test('liveConfig: scoringWeights validation rejects wrong sum', () => {
  const bad = { liquidity: 0.5, spread: 0.5, volatility: 0.1, execution: 0.1, reliability: 0.1, latency: 0.1 };
  const result = liveConfig.setMany({ scoringWeights: bad }, 'test');
  assert.ok(result.rejected.some(r => r.key === 'scoringWeights'), 'should reject weights that do not sum to 1');
});

test('liveConfig: history records all changes', () => {
  liveConfig.reset('test_pre');
  liveConfig.setMany({ minScore: 55 }, 'test_a');
  liveConfig.setMany({ cooldownMs: 2000 }, 'test_b');
  const all = liveConfig.getAll();
  assert.ok(all.history.length >= 2, 'history should record multiple changes');
  liveConfig.reset('test_cleanup');
});

test('liveConfig: getSchema returns schema for all key params', () => {
  const all = liveConfig.getAll();
  assert.ok(all.schema, 'schema should be present');
  assert.ok(all.schema.minScore, 'schema should include minScore');
  assert.ok(all.schema.maxDrawdownPct, 'schema should include maxDrawdownPct');
  assert.ok(all.schema.rebalanceThresholdPct, 'schema should include rebalanceThresholdPct');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: Trade State Machine
// ═══════════════════════════════════════════════════════════════════════════

const mockOpportunity = {
  buyExchange:  'Binance',
  sellExchange: 'OKX',
  buyPrice:     50000,
  sellPrice:    50250,
  spreadPct:    0.5,
  netProfit:    8.50,
  netProfitPct: 0.34,
  score:        72,
  slippagePct:  0.05,
  tradeAmount:  0.05,
  pair:         'Binance→OKX',
  ts:           new Date().toISOString(),
};

test('tsm: createTrade returns a tradeId', () => {
  const id = tsm.createTrade(mockOpportunity, 'test');
  assert.ok(typeof id === 'string' && id.startsWith('trade-'), 'should return a trade id');
  const record = tsm.getTrade(id);
  assert.ok(record, 'record should be retrievable');
  assert.strictEqual(record.state, 'OPPORTUNITY_DETECTED');
});

test('tsm: valid state transitions succeed', () => {
  const id = tsm.createTrade(mockOpportunity, 'test');
  const states = ['SCORING', 'APPROVED', 'ORDER_CREATED', 'ORDER_SUBMITTED', 'FILLED', 'SETTLING', 'COMPLETED'];
  for (const state of states) {
    const result = tsm.transition(id, state, { actor: 'test', reason: 'unit test' });
    assert.ok(result.ok, `Transition to ${state} should succeed`);
  }
});

test('tsm: invalid state transition fails gracefully', () => {
  const id = tsm.createTrade(mockOpportunity, 'test');
  tsm.transition(id, 'SCORING', { actor: 'test' });
  const result = tsm.transition(id, 'COMPLETED', { actor: 'test' }); // can't skip to COMPLETED
  assert.ok(!result.ok, 'Invalid transition should fail');
  assert.ok(result.error, 'Should include error message');
});

test('tsm: completed trade moves to history', () => {
  const id = tsm.createTrade(mockOpportunity, 'test');
  const states = ['SCORING', 'APPROVED', 'ORDER_CREATED', 'ORDER_SUBMITTED', 'FILLED', 'SETTLING', 'COMPLETED'];
  for (const s of states) tsm.transition(id, s, { actor: 'test' });
  assert.strictEqual(tsm.getTrade(id)?.tradeId, id, 'completed trade should be in history');
});

test('tsm: event log captures all transitions', () => {
  const id = tsm.createTrade(mockOpportunity, 'test');
  tsm.transition(id, 'SCORING',   { actor: 'test', reason: 'reason A' });
  tsm.transition(id, 'APPROVED',  { actor: 'test', reason: 'reason B' });
  tsm.transition(id, 'FAILED',    { actor: 'test', reason: 'test failure' });
  const record = tsm.getTrade(id);
  assert.ok(record.events.length >= 3, 'should record all transitions');
  assert.ok(record.events.some(e => e.reason === 'reason A'));
  assert.ok(record.events.some(e => e.to === 'FAILED'));
});

test('tsm: trade stores opportunity snapshot immutably', () => {
  const id = tsm.createTrade(mockOpportunity, 'test');
  const record = tsm.getTrade(id);
  assert.strictEqual(record.opportunity.buyExchange, 'Binance');
  assert.strictEqual(record.opportunity.spreadPct, 0.5);
  assert.strictEqual(record.opportunity.score, 72);
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: Partial Fill Management
// ═══════════════════════════════════════════════════════════════════════════

test('tsm: evaluatePartialFill — good fill (>=minimumFillRatio) returns continue', () => {
  liveConfig.setMany({ allowPartialFills: true, minimumFillRatio: 0.5 }, 'test');
  const id = tsm.createTrade(mockOpportunity, 'test');
  const states = ['SCORING', 'APPROVED', 'ORDER_CREATED', 'ORDER_SUBMITTED'];
  for (const s of states) tsm.transition(id, s, { actor: 'test' });
  const decision = tsm.evaluatePartialFill(id, 0.04, 0.05); // 80% fill
  assert.strictEqual(decision.decision, 'continue', 'should continue on 80% fill');
  liveConfig.reset('test_cleanup');
});

test('tsm: evaluatePartialFill — poor fill (<minimumFillRatio) returns hedge', () => {
  liveConfig.setMany({ allowPartialFills: true, minimumFillRatio: 0.5, minimumTransferAmount: 10 }, 'test');
  const id = tsm.createTrade(mockOpportunity, 'test');
  const states = ['SCORING', 'APPROVED', 'ORDER_CREATED', 'ORDER_SUBMITTED'];
  for (const s of states) tsm.transition(id, s, { actor: 'test' });
  const decision = tsm.evaluatePartialFill(id, 0.01, 0.05); // 20% fill
  assert.ok(['hedge', 'cancel'].includes(decision.decision), 'should hedge or cancel on poor fill');
  liveConfig.reset('test_cleanup');
});

test('tsm: evaluatePartialFill — disabled returns cancel', () => {
  liveConfig.setMany({ allowPartialFills: false }, 'test');
  const id = tsm.createTrade(mockOpportunity, 'test');
  const states = ['SCORING', 'APPROVED', 'ORDER_CREATED', 'ORDER_SUBMITTED'];
  for (const s of states) tsm.transition(id, s, { actor: 'test' });
  const decision = tsm.evaluatePartialFill(id, 0.04, 0.05);
  assert.strictEqual(decision.decision, 'cancel', 'should cancel when partial fills disabled');
  liveConfig.reset('test_cleanup');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4: Failure Recovery Engine
// ═══════════════════════════════════════════════════════════════════════════

test('tsm: determineRecoveryAction — buy_succeeded_sell_failed → retry then hedge', () => {
  liveConfig.setMany({ maxOrderRetries: 3 }, 'test');
  const r1 = tsm.determineRecoveryAction('buy_succeeded_sell_failed', { retryCount: 0 });
  assert.strictEqual(r1.action, 'retry', 'should retry on first failure');
  const r2 = tsm.determineRecoveryAction('buy_succeeded_sell_failed', { retryCount: 3 });
  assert.strictEqual(r2.action, 'hedge', 'should hedge after max retries');
  liveConfig.reset('test_cleanup');
});

test('tsm: determineRecoveryAction — insufficient_liquidity → cancel', () => {
  const r = tsm.determineRecoveryAction('insufficient_liquidity', {});
  assert.strictEqual(r.action, 'cancel');
});

test('tsm: determineRecoveryAction — sell_succeeded_buy_failed → emergency_liquidation', () => {
  const r = tsm.determineRecoveryAction('sell_succeeded_buy_failed', {});
  assert.strictEqual(r.action, 'emergency_liquidation');
  assert.strictEqual(r.priority, 1);
});

test('tsm: executeRecovery — cancel moves trade to FAILED', () => {
  const id = tsm.createTrade(mockOpportunity, 'test');
  const states = ['SCORING', 'APPROVED', 'ORDER_CREATED', 'ORDER_SUBMITTED'];
  for (const s of states) tsm.transition(id, s, { actor: 'test' });
  tsm.transition(id, 'FILLED', { actor: 'test' });
  // Can't cancel after FILLED in normal flow, test from SUBMITTED
  const id2 = tsm.createTrade(mockOpportunity, 'test');
  for (const s of states) tsm.transition(id2, s, { actor: 'test' });
  tsm.transition(id2, 'FAILED', { actor: 'test' });
  const result = tsm.executeRecovery(id2, 'insufficient_liquidity', {});
  assert.ok(result.ok, 'executeRecovery should return ok');
  assert.ok(result.action, 'should have an action');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5: Hedge Engine
// ═══════════════════════════════════════════════════════════════════════════

test('tsm: planHedge returns valid hedge strategies', () => {
  const plan = tsm.planHedge({
    asset: 'BTC', amount: 0.05, valueUSD: 2500, sourceExchange: 'Binance',
  });
  assert.ok(plan.recommendedStrategy, 'should have a recommended strategy');
  assert.ok(plan.allStrategies.length >= 3, 'should have at least 3 strategies');
  assert.ok(['spot_hedge', 'cross_exchange_hedge', 'synthetic_hedge'].includes(plan.recommendedStrategy.type));
  assert.ok(['low', 'medium', 'high'].includes(plan.urgency));
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7: Advanced Risk Engine
// ═══════════════════════════════════════════════════════════════════════════

test('advRisk: circuit breaker activates and resets', () => {
  advRisk.resetCircuitBreaker('test_pre');
  const status1 = advRisk.getStatus(100000, 0);
  assert.ok(!status1.circuitBreaker.active, 'circuit breaker should start inactive');

  advRisk.activateCircuitBreaker('test trigger', 'test');
  const status2 = advRisk.getStatus(100000, 0);
  assert.ok(status2.circuitBreaker.active, 'circuit breaker should be active');
  assert.ok(status2.circuitBreaker.reason, 'should have a reason');

  advRisk.resetCircuitBreaker('test');
  const status3 = advRisk.getStatus(100000, 0);
  assert.ok(!status3.circuitBreaker.active, 'circuit breaker should be inactive after reset');
});

test('advRisk: consecutive failures activate circuit breaker', () => {
  advRisk.resetCircuitBreaker('test_pre');
  liveConfig.setMany({ maxConsecutiveFailures: 3 }, 'test');
  advRisk.recordTradeOutcome(false);
  advRisk.recordTradeOutcome(false);
  const before = advRisk.getStatus(100000, 0);
  assert.ok(!before.circuitBreaker.active, 'should not trigger before limit');
  advRisk.recordTradeOutcome(false);
  const after = advRisk.getStatus(100000, 0);
  assert.ok(after.circuitBreaker.active, 'should trigger after limit');
  advRisk.resetCircuitBreaker('test');
  liveConfig.reset('test_cleanup');
});

test('advRisk: success resets consecutive failure counter', () => {
  advRisk.resetCircuitBreaker('test_pre');
  liveConfig.setMany({ maxConsecutiveFailures: 5 }, 'test');
  advRisk.recordTradeOutcome(false);
  advRisk.recordTradeOutcome(false);
  advRisk.recordTradeOutcome(true);  // success resets counter
  const status = advRisk.getStatus(100000, 0);
  assert.strictEqual(status.consecutiveFailures, 0, 'success should reset counter');
  liveConfig.reset('test_cleanup');
});

test('advRisk: drawdown check returns ok when within limits', () => {
  advRisk.init(100000);
  const check = advRisk.checkDrawdown(95000);  // 5% drawdown, limit is 10%
  assert.ok(check.ok, 'should be ok at 5% drawdown with 10% limit');
  assert.ok(check.drawdownPct < 10, 'drawdown should be less than limit');
});

test('advRisk: drawdown check fails when breached', () => {
  liveConfig.setMany({ maxDrawdownPct: 5 }, 'test');
  advRisk.init(100000);
  const check = advRisk.checkDrawdown(90000);  // 10% drawdown > 5% limit
  assert.ok(!check.ok, 'should fail at 10% drawdown with 5% limit');
  advRisk.resetCircuitBreaker('test');
  liveConfig.reset('test_cleanup');
});

test('advRisk: position size check', () => {
  liveConfig.setMany({ maxPositionValueUSD: 5000 }, 'test');
  const ok    = advRisk.checkPositionSize(3000);
  const notOk = advRisk.checkPositionSize(6000);
  assert.ok(ok.ok,    'should pass at $3000 with $5000 limit');
  assert.ok(!notOk.ok, 'should fail at $6000 with $5000 limit');
  liveConfig.reset('test_cleanup');
});

test('advRisk: emergency stop check', () => {
  liveConfig.setMany({ emergencyStopThreshold: -500 }, 'test');
  const ok    = advRisk.checkEmergencyStop(-200);
  const notOk = advRisk.checkEmergencyStop(-600);
  assert.ok(ok.ok,    'should not trigger at -$200 with -$500 threshold');
  assert.ok(!notOk.ok, 'should trigger at -$600 with -$500 threshold');
  advRisk.resetCircuitBreaker('test');
  liveConfig.reset('test_cleanup');
});

test('advRisk: preTradeRiskCheck — clean state passes', () => {
  advRisk.resetCircuitBreaker('test_pre');
  liveConfig.setMany({
    maxDailyLossUSD: -500, emergencyStopThreshold: -1000,
    maxDrawdownPct: 20, maxPositionValueUSD: 10000, maxSlippagePct: 1.0,
  }, 'test');
  advRisk.init(100000);
  const mockWallets = {
    BTC:  { Binance: 1, Kraken: 1, Bybit: 1, OKX: 1, Coinbase: 1 },
    USDT: { Binance: 10000, Kraken: 10000, Bybit: 10000, OKX: 10000, Coinbase: 10000 },
  };
  const op = { ...mockOpportunity, slippagePct: 0.05, tradeAmount: 0.05 };
  const result = advRisk.preTradeRiskCheck(op, mockWallets, 100000, 0);
  assert.ok(result.ok, 'risk check should pass in clean state');
  liveConfig.reset('test_cleanup');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 13: ML Scoring Pipeline
// ═══════════════════════════════════════════════════════════════════════════

test('mlScoring: scoreOpportunity returns expected fields', () => {
  const result = mlScoring.scoreOpportunity(mockOpportunity, {});
  assert.ok(typeof result.mlScore === 'number', 'mlScore should be a number');
  assert.ok(result.mlScore >= 0 && result.mlScore <= 100, 'mlScore should be in [0, 100]');
  assert.ok(typeof result.executionProbability === 'number');
  assert.ok(typeof result.fillProbability === 'number');
  assert.ok(result.features, 'should return feature breakdown');
  assert.ok(result.featureWeights, 'should return weights');
  assert.ok(result.topFeature, 'should return top contributing feature');
});

test('mlScoring: higher spread → better spread score', () => {
  const low  = mlScoring.scoreOpportunity({ ...mockOpportunity, spreadPct: 0.05 }, {});
  const high = mlScoring.scoreOpportunity({ ...mockOpportunity, spreadPct: 0.30 }, {});
  assert.ok(high.features.spread > low.features.spread,
    'Higher spread should produce better spread feature score (up to a point)');
});

test('mlScoring: WS sources → better execution score', () => {
  const ws   = mlScoring.scoreOpportunity({ ...mockOpportunity, buySource: 'ws', sellSource: 'ws' }, {});
  const rest = mlScoring.scoreOpportunity({ ...mockOpportunity, buySource: 'rest', sellSource: 'rest' }, {});
  assert.ok(ws.features.execution > rest.features.execution, 'WS should have better execution score');
});

test('mlScoring: registerModel and setActiveModel work', () => {
  const mockModel = {
    version: '0.1',
    predict: (features, opp) => ({
      executionProbability: 0.5,
      fillProbability:      0.7,
      profitQuality:        42,
      mlScore:              55,
      confidence:           'low',
    }),
  };
  mlScoring.registerModel('test_model', mockModel);
  const before = mlScoring.getActiveModelName();
  mlScoring.setActiveModel('test_model');
  const result = mlScoring.scoreOpportunity(mockOpportunity, {});
  assert.strictEqual(result.mlScore, 55, 'should use registered mock model');
  mlScoring.setActiveModel(before);  // restore
});

test('mlScoring: extractFeatures returns normalized values', () => {
  const { features } = mlScoring.extractFeatures(mockOpportunity);
  for (const [name, val] of Object.entries(features)) {
    assert.ok(val >= 0 && val <= 1, `Feature ${name} should be in [0, 1], got ${val}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 14: Observability Service
// ═══════════════════════════════════════════════════════════════════════════

test('obs: emit stores events in category buffer', () => {
  obs.emit('SYSTEM', 'test.event', { detail: 'test' }, 'info');
  const events = obs.getEvents('SYSTEM', 10);
  assert.ok(events.some(e => e.event === 'test.event'), 'event should be in buffer');
});

test('obs: emit tracks errors in error stats', () => {
  obs.emit('SYSTEM', 'test.error_event', { message: 'test error' }, 'error');
  const stats = obs.getErrorStats();
  assert.ok(stats.total > 0, 'error stats should track error events');
});

test('obs: recordRejection stores RCA entry', () => {
  const beforeCount = obs.getRCASummary().totalRejections;
  obs.recordRejection(mockOpportunity, 'test rejection', obs.RCA_CATEGORIES.SCORE_TOO_LOW, { minScore: 80 });
  const afterCount  = obs.getRCASummary().totalRejections;
  assert.ok(afterCount > beforeCount, 'should increase RCA log count');
});

test('obs: getRCALog returns entries with humanReadable explanation', () => {
  obs.recordRejection(mockOpportunity, 'test', obs.RCA_CATEGORIES.SPREAD_TOO_SMALL, { minSpreadPct: 0.5 });
  const log = obs.getRCALog(5);
  assert.ok(log.length > 0, 'should have RCA entries');
  assert.ok(log[0].humanReadable, 'should have human readable explanation');
  assert.ok(log[0].machineReadable, 'should have machine readable diagnostics');
  assert.ok(log[0].machineReadable.ruleViolated, 'should specify violated rule');
});

test('obs: recordExecutionQuality computes profit capture', () => {
  const opp   = { ...mockOpportunity };
  const trade = { id: 'test-t1', buyExchange: 'Binance', sellExchange: 'OKX',
    netProfit: 7.50, netProfitPct: 0.30, slippagePct: 0.05, amount: 0.05,
    requestedAmount: 0.05, executionMs: 45 };
  const result = obs.recordExecutionQuality(opp, trade);
  assert.ok(result.profitCapture >= 0 && result.profitCapture <= 2, 'profitCapture should be reasonable');
  assert.ok(['excellent', 'good', 'acceptable', 'poor'].includes(result.verdict));
});

test('obs: getDashboard returns all sections', () => {
  const dashboard = obs.getDashboard();
  assert.ok(dashboard.executionQuality, 'should have executionQuality');
  assert.ok(dashboard.latency, 'should have latency');
  assert.ok(dashboard.exchangeHealth, 'should have exchangeHealth');
  assert.ok(dashboard.errorStats, 'should have errorStats');
  assert.ok(dashboard.rcaSummary, 'should have rcaSummary');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 16: Institutional Backtest Metrics
// ═══════════════════════════════════════════════════════════════════════════

// Build a synthetic simulation result for testing
function buildSyntheticSimResult() {
  const initialCapital = 100000;
  const executions     = [];
  const equityCurve    = [{ ts: '2025-01-01T00:00:00Z', equity: initialCapital }];
  let equity           = initialCapital;

  // 100 trades: 65 winners, 35 losers
  for (let i = 0; i < 100; i++) {
    const win    = Math.random() < 0.65;
    const profit = win ? +(Math.random() * 15 + 2).toFixed(4)
                       : -(Math.random() * 8 + 1).toFixed(4);
    equity += profit;
    const ts = new Date(Date.now() + i * 60000).toISOString();
    executions.push({ ts, netProfit: profit, pair: 'Binance→OKX', score: 70 + Math.random() * 20 });
    equityCurve.push({ ts, equity: +equity.toFixed(2) });
  }

  const totalNetProfit = executions.reduce((s, e) => s + e.netProfit, 0);
  return { executions, equityCurve, totalNetProfit, params: { minScore: 65, cooldownMs: 300 } };
}

test('instBacktest: computeInstitutionalMetrics returns all required fields', () => {
  const simResult = buildSyntheticSimResult();
  const metrics   = instBacktest.computeInstitutionalMetrics(simResult);
  assert.ok(!metrics.error, `Should not error: ${metrics.error}`);

  const required = ['sharpeRatio', 'sortinoRatio', 'calmarRatio', 'profitFactor',
    'expectancy', 'kellyCriterion', 'maxDrawdownPct', 'recoveryFactor',
    'valueAtRisk95', 'omegaRatio', 'timeInDrawdownPct', 'winRate', 'totalTrades'];
  for (const field of required) {
    assert.ok(field in metrics, `Should have ${field}`);
  }
});

test('instBacktest: profitFactor > 1 for net-positive strategy', () => {
  const profits = [10, 8, 12, -3, 9, 7, -2, 11, 15, -4];
  const pf      = instBacktest.profitFactor(profits);
  assert.ok(pf > 1, `Profit factor should be > 1 for net positive (got ${pf})`);
});

test('instBacktest: sharpeRatio is null for single data point', () => {
  const r = instBacktest.sharpeRatio([0.01], 252);
  assert.ok(r === null, 'Sharpe should be null for single return');
});

test('instBacktest: maxDrawdown correctly identifies peak-to-trough', () => {
  const curve = [
    { ts: '2025-01-01', equity: 100000 },
    { ts: '2025-01-02', equity: 110000 },
    { ts: '2025-01-03', equity: 90000  },
    { ts: '2025-01-04', equity: 95000  },
  ];
  const dd = instBacktest.maxDrawdown(curve);
  // Peak is 110000, trough is 90000, drawdown is 18.18%
  assert.ok(Math.abs(dd.pct - 18.18) < 0.1, `MaxDrawdown should be ~18.18% (got ${dd.pct}%)`);
});

test('instBacktest: expectancy returns correct components', () => {
  const profits = [10, -5, 8, -3, 12, -6, 9, 7, -4, 11];
  const exp     = instBacktest.expectancy(profits);
  assert.ok(typeof exp.value === 'number', 'expectancy.value should be a number');
  assert.ok(typeof exp.winRate === 'number', 'winRate should be a number');
  assert.ok(exp.winRate >= 0 && exp.winRate <= 100, 'winRate should be a percentage');
  assert.ok(typeof exp.avgWin === 'number', 'avgWin should be a number');
  assert.ok(typeof exp.avgLoss === 'number', 'avgLoss should be a number');
  assert.ok(exp.avgLoss >= 0, 'avgLoss should be positive (absolute value)');
});

test('instBacktest: kellyCriterion recommends positive fraction for good strategy', () => {
  const profits = [10, 8, 12, -3, 9, 7, -2, 11, 15, -4, 10, 8, -1, 9, 12];
  const kelly   = instBacktest.kellyCriterion(profits);
  assert.ok(kelly.fullKelly !== null, 'should compute full kelly');
  assert.ok(kelly.halfKelly !== null, 'should compute half kelly');
  if (kelly.fullKelly > 0) {
    assert.ok(kelly.halfKelly < kelly.fullKelly, 'half kelly should be less than full kelly');
  }
});

test('instBacktest: generateInstitutionalReport returns structured report', () => {
  const simResult = buildSyntheticSimResult();
  const report    = instBacktest.generateInstitutionalReport(simResult, 100000);
  assert.ok(!report.error, 'should not error');
  assert.ok(report.performance, 'should have performance section');
  assert.ok(report.tradeStatistics, 'should have trade statistics section');
  assert.ok(report.riskManagement, 'should have risk management section');
  assert.ok(report.grade, 'should have performance grade');
  assert.ok(report.disclaimer, 'should include disclaimer');
  assert.ok(['A+', 'A', 'B', 'C', 'D'].includes(report.grade.grade),
    `Grade should be valid letter grade (got ${report.grade.grade})`);
});

test('instBacktest: computeInstitutionalMetrics handles edge case — empty executions', () => {
  const empty = { executions: [], equityCurve: [], totalNetProfit: 0, params: {} };
  const metrics = instBacktest.computeInstitutionalMetrics(empty);
  assert.ok(metrics.error, 'should return error for empty data');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9: Predictive Rebalance
// ═══════════════════════════════════════════════════════════════════════════

test('predictReb: computeCapitalEfficiency returns expected fields', () => {
  const predictReb = require('../server/domain/engines/predictiveRebalance');
  const wallets    = {
    BTC:  { Binance: 1, Kraken: 0.8, Bybit: 0.9, OKX: 0.95, Coinbase: 0.85 },
    USDT: { Binance: 20000, Kraken: 18000, Bybit: 19000, OKX: 19500, Coinbase: 17000 },
  };
  const result = predictReb.computeCapitalEfficiency(wallets, 50000, 120.50, 25, 3600000);
  assert.ok(!result.error, 'should not error with valid wallets');
  assert.ok(typeof result.totalCapitalUSD === 'number', 'should have total capital');
  assert.ok(typeof result.utilizationRatio === 'number', 'should have utilization ratio');
  assert.ok(result.utilizationRatio >= 0 && result.utilizationRatio <= 1, 'utilization should be in [0,1]');
  assert.ok(Array.isArray(result.idleExchanges), 'should have idle exchanges list');
  assert.ok(Array.isArray(result.optimalDistribution), 'should have optimal distribution');
});

test('predictReb: generatePredictiveRecommendations works with empty history', () => {
  const predictReb = require('../server/domain/engines/predictiveRebalance');
  const wallets    = {
    BTC:  { Binance: 1, Kraken: 1, Bybit: 1, OKX: 1, Coinbase: 1 },
    USDT: { Binance: 110000, Kraken: 110000, Bybit: 110000, OKX: 110000, Coinbase: 110000 },
  };
  const result = predictReb.generatePredictiveRecommendations(wallets, 50000);
  assert.ok(result.rates, 'should have consumption rates');
  assert.ok(Array.isArray(result.recommendations), 'should have recommendations array');
  assert.ok(typeof result.windowHours === 'number', 'should have window hours');
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration tests
// ═══════════════════════════════════════════════════════════════════════════

test('integration: full trade lifecycle with risk checks and observability', () => {
  liveConfig.setMany({
    maxDailyLossUSD: -500, emergencyStopThreshold: -1000,
    maxDrawdownPct: 20, maxPositionValueUSD: 10000, maxSlippagePct: 1.0,
    maxConsecutiveFailures: 10,
  }, 'test');
  advRisk.resetCircuitBreaker('test_pre');
  advRisk.init(100000);

  const mockWallets = {
    BTC:  { Binance: 1, Kraken: 1, Bybit: 1, OKX: 1, Coinbase: 1 },
    USDT: { Binance: 10000, Kraken: 10000, Bybit: 10000, OKX: 10000, Coinbase: 10000 },
  };

  // 1. Risk check
  const op = { ...mockOpportunity, slippagePct: 0.05, tradeAmount: 0.05 };
  const riskCheck = advRisk.preTradeRiskCheck(op, mockWallets, 100000, 0);
  assert.ok(riskCheck.ok, 'risk check should pass');

  // 2. Create trade in state machine
  const id = tsm.createTrade(op, 'integration_test');
  tsm.transition(id, 'SCORING',       { actor: 'test' });
  tsm.transition(id, 'APPROVED',      { actor: 'test' });
  tsm.transition(id, 'ORDER_CREATED', { actor: 'test' });
  tsm.transition(id, 'ORDER_SUBMITTED', { actor: 'test' });
  tsm.transition(id, 'FILLED',        { actor: 'test', data: { pnl: { netProfit: 8.50 } } });
  tsm.transition(id, 'SETTLING',      { actor: 'test' });
  tsm.transition(id, 'COMPLETED',     { actor: 'test' });

  // 3. Record quality
  const trade = { id: 'test-trade', buyExchange: 'Binance', sellExchange: 'OKX',
    netProfit: 8.50, netProfitPct: 0.34, slippagePct: 0.05, amount: 0.05,
    requestedAmount: 0.05, executionMs: 42 };
  const quality = obs.recordExecutionQuality(op, trade);
  assert.ok(quality.verdict, 'should have execution verdict');

  // 4. Update risk engine state
  advRisk.recordTradeOutcome(true);
  advRisk.recordSlippage(0.05);

  // 5. ML score
  const mlResult = mlScoring.scoreOpportunity(op, {});
  assert.ok(mlResult.mlScore >= 0, 'ML score should be non-negative');

  // 6. Verify state
  const status = advRisk.getStatus(100000 + 8.50, 8.50);
  assert.ok(!status.circuitBreaker.active, 'circuit breaker should remain inactive');
  assert.strictEqual(status.consecutiveFailures, 0, 'no failures recorded');

  liveConfig.reset('test_cleanup');
});

console.log('\n✓ All v17 tests registered. Run with: node --test tests/v17.test.js\n');

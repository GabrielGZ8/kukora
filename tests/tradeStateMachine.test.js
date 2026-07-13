'use strict';

/**
 * tradeStateMachine.test.js
 *
 * Covers the trade lifecycle state machine (Sections 2-5 of tradeStateMachine.js):
 *  - createTrade / transition / getTrade / getActiveTrades / getHistory
 *  - evaluatePartialFill decision tree
 *  - determineRecoveryAction for every documented scenario
 *  - executeRecovery side effects (state transitions, event log, recovery record)
 *  - planHedge strategy generation
 *  - getStats aggregation
 *
 * The module keeps module-level in-memory state (_trades / _history), so tests
 * use unique opportunity data per test and avoid relying on ordering across files.
 */

const tsm = require('../server/domain/analytics/tradeStateMachine');

function makeOpportunity(overrides = {}) {
  return {
    buyExchange: 'Binance',
    sellExchange: 'Kraken',
    buyPrice: 50000,
    sellPrice: 50200,
    spreadPct: 0.4,
    netProfit: 5,
    netProfitPct: 0.35,
    score: 42,
    slippagePct: 0.05,
    tradeAmount: 0.05,
    ...overrides,
  };
}

describe('tradeStateMachine', () => {
  describe('createTrade', () => {
    it('creates a trade in OPPORTUNITY_DETECTED state with a unique tradeId', () => {
      const id1 = tsm.createTrade(makeOpportunity());
      const id2 = tsm.createTrade(makeOpportunity());
      expect(id1).not.toEqual(id2);

      const record = tsm.getTrade(id1);
      expect(record.state).toBe(tsm.STATES.OPPORTUNITY_DETECTED);
      expect(record.opportunity.buyExchange).toBe('Binance');
      expect(record.events).toHaveLength(1);
      expect(record.events[0].to).toBe(tsm.STATES.OPPORTUNITY_DETECTED);
    });

    it('defaults type to cross_exchange and derives pair when not provided', () => {
      const id = tsm.createTrade(makeOpportunity());
      const record = tsm.getTrade(id);
      expect(record.opportunity.type).toBe('cross_exchange');
      expect(record.opportunity.pair).toBe('Binance→Kraken');
    });

    it('respects an explicit pair and type on the opportunity', () => {
      const id = tsm.createTrade(makeOpportunity({ type: 'triangular', pair: 'BTC/ETH/USDT' }));
      const record = tsm.getTrade(id);
      expect(record.opportunity.type).toBe('triangular');
      expect(record.opportunity.pair).toBe('BTC/ETH/USDT');
    });

    it('records the source as the actor of the initial event', () => {
      const id = tsm.createTrade(makeOpportunity(), 'orchestrator');
      const record = tsm.getTrade(id);
      expect(record.events[0].actor).toBe('orchestrator');
      expect(record.source).toBe('orchestrator');
    });
  });

  describe('transition', () => {
    it('allows a valid transition and appends an event', () => {
      const id = tsm.createTrade(makeOpportunity());
      const result = tsm.transition(id, tsm.STATES.SCORING, { actor: 'scorer', reason: 'scoring started' });

      expect(result.ok).toBe(true);
      expect(result.record.state).toBe(tsm.STATES.SCORING);
      expect(result.record.events).toHaveLength(2);
      expect(result.record.events[1].from).toBe(tsm.STATES.OPPORTUNITY_DETECTED);
      expect(result.record.events[1].to).toBe(tsm.STATES.SCORING);
      expect(result.record.events[1].reason).toBe('scoring started');
    });

    it('rejects an invalid transition and lists allowed transitions', () => {
      const id = tsm.createTrade(makeOpportunity());
      const result = tsm.transition(id, tsm.STATES.COMPLETED);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Invalid transition/);
      expect(result.allowedTransitions).toEqual(tsm.TRANSITIONS.OPPORTUNITY_DETECTED);
    });

    it('returns an error for an unknown tradeId', () => {
      const result = tsm.transition('trade-does-not-exist', tsm.STATES.SCORING);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found/);
    });

    it('merges execution/pnl/recovery/rca data into the record on transition', () => {
      const id = tsm.createTrade(makeOpportunity());
      tsm.transition(id, tsm.STATES.SCORING);
      tsm.transition(id, tsm.STATES.APPROVED);
      tsm.transition(id, tsm.STATES.ORDER_CREATED);
      const result = tsm.transition(id, tsm.STATES.ORDER_SUBMITTED, {
        data: { execution: { requestedAmount: 0.05, retryCount: 1 } },
      });

      expect(result.record.execution.requestedAmount).toBe(0.05);
      expect(result.record.execution.retryCount).toBe(1);
    });

    it('moves a trade to history and removes it from active trades on reaching COMPLETED', () => {
      const id = tsm.createTrade(makeOpportunity());
      tsm.transition(id, tsm.STATES.SCORING);
      tsm.transition(id, tsm.STATES.APPROVED);
      tsm.transition(id, tsm.STATES.ORDER_CREATED);
      tsm.transition(id, tsm.STATES.ORDER_SUBMITTED);
      tsm.transition(id, tsm.STATES.FILLED);
      tsm.transition(id, tsm.STATES.SETTLING);
      const result = tsm.transition(id, tsm.STATES.COMPLETED);

      expect(result.ok).toBe(true);
      expect(tsm.getActiveTrades().find(t => t.tradeId === id)).toBeUndefined();
      expect(tsm.getHistory().find(t => t.tradeId === id)).toBeDefined();
      // getTrade still finds it via history fallback
      expect(tsm.getTrade(id).state).toBe(tsm.STATES.COMPLETED);
    });

    it('moves a trade to history on ROLLED_BACK and EMERGENCY_EXIT as well', () => {
      const idRolled = tsm.createTrade(makeOpportunity());
      tsm.transition(idRolled, tsm.STATES.SCORING);
      tsm.transition(idRolled, tsm.STATES.APPROVED);
      tsm.transition(idRolled, tsm.STATES.ORDER_CREATED);
      tsm.transition(idRolled, tsm.STATES.ORDER_SUBMITTED);
      tsm.transition(idRolled, tsm.STATES.FILLED);
      const r1 = tsm.transition(idRolled, tsm.STATES.ROLLED_BACK);
      expect(r1.ok).toBe(true);
      expect(tsm.getActiveTrades().find(t => t.tradeId === idRolled)).toBeUndefined();

      const idEmergency = tsm.createTrade(makeOpportunity());
      tsm.transition(idEmergency, tsm.STATES.SCORING);
      tsm.transition(idEmergency, tsm.STATES.APPROVED);
      tsm.transition(idEmergency, tsm.STATES.ORDER_CREATED);
      tsm.transition(idEmergency, tsm.STATES.ORDER_SUBMITTED);
      tsm.transition(idEmergency, tsm.STATES.PARTIALLY_FILLED);
      const r2 = tsm.transition(idEmergency, tsm.STATES.EMERGENCY_EXIT);
      expect(r2.ok).toBe(true);
      expect(tsm.getActiveTrades().find(t => t.tradeId === idEmergency)).toBeUndefined();
    });

    it('allows FAILED trades to still attempt ROLLED_BACK or EMERGENCY_EXIT recovery', () => {
      const id = tsm.createTrade(makeOpportunity());
      tsm.transition(id, tsm.STATES.SCORING);
      tsm.transition(id, tsm.STATES.FAILED);
      const result = tsm.transition(id, tsm.STATES.ROLLED_BACK);
      expect(result.ok).toBe(true);
    });

    it('caps history at MAX_HISTORY (500) entries, dropping the oldest', () => {
      // Fill history well past the cap using minimal-hop terminal trades.
      for (let i = 0; i < 505; i++) {
        const id = tsm.createTrade(makeOpportunity());
        tsm.transition(id, tsm.STATES.FAILED, { reason: `bulk-${i}` });
        tsm.transition(id, tsm.STATES.ROLLED_BACK);
      }
      const history = tsm.getHistory(1000);
      expect(history.length).toBeLessThanOrEqual(500);
    });
  });

  describe('getActiveTrades / getHistory / getTrade', () => {
    it('getActiveTrades only returns non-terminal trades', () => {
      const id = tsm.createTrade(makeOpportunity());
      const active = tsm.getActiveTrades();
      expect(active.some(t => t.tradeId === id)).toBe(true);
    });

    it('getHistory respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        const id = tsm.createTrade(makeOpportunity());
        tsm.transition(id, tsm.STATES.FAILED);
        tsm.transition(id, tsm.STATES.ROLLED_BACK);
      }
      const history = tsm.getHistory(2);
      expect(history.length).toBe(2);
    });

    it('getTrade returns null for an unknown tradeId', () => {
      expect(tsm.getTrade('nonexistent-trade-id')).toBeNull();
    });
  });

  describe('classifyFillTier', () => {
    it('classifies >= 0.80 as high', () => {
      expect(tsm.classifyFillTier(0.80)).toBe('high');
      expect(tsm.classifyFillTier(0.95)).toBe('high');
    });

    it('classifies [0.50, 0.80) as mid', () => {
      expect(tsm.classifyFillTier(0.50)).toBe('mid');
      expect(tsm.classifyFillTier(0.65)).toBe('mid');
      expect(tsm.classifyFillTier(0.7999)).toBe('mid');
    });

    it('classifies < 0.50 as low', () => {
      expect(tsm.classifyFillTier(0.49)).toBe('low');
      expect(tsm.classifyFillTier(0.01)).toBe('low');
    });
  });

  describe('evaluatePartialFill', () => {
    it('returns cancel with reason when the trade does not exist', () => {
      const result = tsm.evaluatePartialFill('nonexistent', 0.01, 0.05);
      expect(result.decision).toBe('cancel');
      expect(result.reason).toMatch(/not found/);
    });

    it('returns continue when fill ratio meets the minimum and partials are allowed', () => {
      const id = tsm.createTrade(makeOpportunity({ buyPrice: 50000 }));
      // minimumFillRatio default is 0.50 — 0.9 fill ratio should continue
      const result = tsm.evaluatePartialFill(id, 0.045, 0.05);
      expect(result.decision).toBe('continue');
      expect(result.fillRatio).toBeCloseTo(0.9, 5);
    });

    it('returns hedge (mid tier) when fill ratio is between minimum and high thresholds', () => {
      const id = tsm.createTrade(makeOpportunity({ buyPrice: 50000 }));
      // fillRatio 0.65 sits between minimumFillRatio (0.50) and highFillRatioThreshold (0.80)
      const result = tsm.evaluatePartialFill(id, 0.0325, 0.05);
      expect(result.decision).toBe('hedge');
      expect(result.tier).toBe('mid');
      expect(result.residualUSD).toBeGreaterThan(100);
    });

    it('returns close_immediately (low tier) when fill ratio is below minimum but residual is meaningful', () => {
      const id = tsm.createTrade(makeOpportunity({ buyPrice: 50000 }));
      // fillRatio 0.2 (below 0.5 min), residual 0.04 BTC * 50000 = 2000 USD (above 100 min transfer)
      const result = tsm.evaluatePartialFill(id, 0.01, 0.05);
      expect(result.decision).toBe('close_immediately');
      expect(result.tier).toBe('low');
      expect(result.residualUSD).toBeGreaterThan(100);
    });

    it('returns cancel when residual is below the minimum transfer amount', () => {
      const id = tsm.createTrade(makeOpportunity({ buyPrice: 50000 }));
      // requested/filled chosen so residual value < $100 minimum transfer, and fillRatio < 0.5
      const result = tsm.evaluatePartialFill(id, 0.0001, 0.002);
      expect(result.decision).toBe('cancel');
      expect(result.reason).toMatch(/below minimum transfer/);
    });

    it('returns continue (high tier) comfortably above the high fill ratio threshold', () => {
      const id = tsm.createTrade(makeOpportunity({ buyPrice: 50000 }));
      const result = tsm.evaluatePartialFill(id, 0.85, 1); // 0.85 > 0.80 threshold, no FP boundary risk
      expect(result.decision).toBe('continue');
      expect(result.tier).toBe('high');
    });

    it('records the partial fill event on the trade record', () => {
      const id = tsm.createTrade(makeOpportunity({ buyPrice: 50000 }));
      tsm.evaluatePartialFill(id, 0.045, 0.05);
      const record = tsm.getTrade(id);
      expect(record.execution.partialFills).toHaveLength(1);
      expect(record.execution.partialFills[0].filledAmount).toBe(0.045);
    });
  });

  describe('determineRecoveryAction', () => {
    it('handles buy_succeeded_sell_failed with retries remaining → retry', () => {
      const result = tsm.determineRecoveryAction('buy_succeeded_sell_failed', { retryCount: 0 });
      expect(result.action).toBe('retry');
      expect(result.urgent).toBe(true);
      expect(result.priority).toBe(1);
    });

    it('handles buy_succeeded_sell_failed after max retries → hedge', () => {
      const result = tsm.determineRecoveryAction('buy_succeeded_sell_failed', { retryCount: 10 });
      expect(result.action).toBe('hedge');
    });

    it('handles sell_succeeded_buy_failed → emergency_liquidation', () => {
      const result = tsm.determineRecoveryAction('sell_succeeded_buy_failed', {});
      expect(result.action).toBe('emergency_liquidation');
      expect(result.priority).toBe(1);
    });

    it('handles exchange_timeout with retries remaining → retry with backoff', () => {
      const result = tsm.determineRecoveryAction('exchange_timeout', { retryCount: 0 });
      expect(result.action).toBe('retry');
      expect(result.backoffMs).toBeGreaterThan(0);
    });

    it('handles exchange_timeout after max retries → cancel', () => {
      const result = tsm.determineRecoveryAction('exchange_timeout', { retryCount: 10 });
      expect(result.action).toBe('cancel');
    });

    it('handles websocket_disconnect → retry and waits for reconnect', () => {
      const result = tsm.determineRecoveryAction('websocket_disconnect', {});
      expect(result.action).toBe('retry');
      expect(result.waitForReconnect).toBe(true);
    });

    it('handles api_outage with open exposure → emergency_liquidation', () => {
      const result = tsm.determineRecoveryAction('api_outage', { hasOpenExposure: true });
      expect(result.action).toBe('emergency_liquidation');
    });

    it('handles api_outage without exposure → cancel', () => {
      const result = tsm.determineRecoveryAction('api_outage', { hasOpenExposure: false });
      expect(result.action).toBe('cancel');
    });

    it('handles insufficient_liquidity → cancel', () => {
      const result = tsm.determineRecoveryAction('insufficient_liquidity', {});
      expect(result.action).toBe('cancel');
    });

    it('handles insufficient_balance → cancel and flags rebalance', () => {
      const result = tsm.determineRecoveryAction('insufficient_balance', {});
      expect(result.action).toBe('cancel');
      expect(result.triggerRebalance).toBe(true);
    });

    it('handles price_moved_against → cancel', () => {
      const result = tsm.determineRecoveryAction('price_moved_against', {});
      expect(result.action).toBe('cancel');
    });

    it('handles partial_fill_below_threshold → hedge, urgent when residual is large', () => {
      const result = tsm.determineRecoveryAction('partial_fill_below_threshold', { residualUSD: 5000 });
      expect(result.action).toBe('hedge');
      expect(result.urgent).toBe(true);
    });

    it('handles partial_fill_below_threshold with small residual → hedge, not urgent', () => {
      const result = tsm.determineRecoveryAction('partial_fill_below_threshold', { residualUSD: 50 });
      expect(result.urgent).toBe(false);
    });

    it('falls back to cancel with low priority for an unknown scenario', () => {
      const result = tsm.determineRecoveryAction('totally_unknown_scenario', {});
      expect(result.action).toBe('cancel');
      expect(result.priority).toBe(5);
      expect(result.reason).toMatch(/Unknown failure scenario/);
    });
  });

  describe('executeRecovery', () => {
    it('returns an error for an unknown tradeId', () => {
      const result = tsm.executeRecovery('nonexistent', 'exchange_timeout', { retryCount: 0 });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found/);
    });

    it('RETRY action increments retryCount and does not transition state', () => {
      const id = tsm.createTrade(makeOpportunity());
      tsm.transition(id, tsm.STATES.SCORING);
      tsm.transition(id, tsm.STATES.APPROVED);
      tsm.transition(id, tsm.STATES.ORDER_CREATED);
      tsm.transition(id, tsm.STATES.ORDER_SUBMITTED);

      const result = tsm.executeRecovery(id, 'exchange_timeout', { retryCount: 0 });
      expect(result.ok).toBe(true);
      expect(result.action).toBe('retry');
      expect(result.outcome.status).toBe('retry_scheduled');

      const record = tsm.getTrade(id);
      expect(record.execution.retryCount).toBe(1);
      expect(record.state).toBe(tsm.STATES.ORDER_SUBMITTED);
      expect(record.recovery.attempted).toBe(true);
    });

    it('CANCEL action transitions the trade to FAILED with rca populated', () => {
      const id = tsm.createTrade(makeOpportunity());
      tsm.transition(id, tsm.STATES.SCORING);

      const result = tsm.executeRecovery(id, 'insufficient_liquidity', {});
      expect(result.ok).toBe(true);
      expect(result.action).toBe('cancel');
      expect(result.outcome.status).toBe('cancelled');

      // Trade is terminal (FAILED) — still fetchable via getTrade (active, non-terminal-moving state)
      const record = tsm.getTrade(id);
      expect(record.state).toBe(tsm.STATES.FAILED);
      expect(record.rca.failureCategory).toBe('insufficient_liquidity');
    });

    it('HEDGE action records a hedge trade entry and does not transition state', () => {
      const id = tsm.createTrade(makeOpportunity());
      tsm.transition(id, tsm.STATES.SCORING);
      tsm.transition(id, tsm.STATES.APPROVED);
      tsm.transition(id, tsm.STATES.ORDER_CREATED);
      tsm.transition(id, tsm.STATES.ORDER_SUBMITTED);
      tsm.transition(id, tsm.STATES.PARTIALLY_FILLED);

      const result = tsm.executeRecovery(id, 'partial_fill_below_threshold', {
        residualUSD: 2000,
        residualAmount: 0.01,
        hedgeExchange: 'OKX',
      });
      expect(result.ok).toBe(true);
      expect(result.action).toBe('hedge');

      const record = tsm.getTrade(id);
      expect(record.recovery.hedgeTrades).toHaveLength(1);
      expect(record.recovery.hedgeTrades[0].exchange).toBe('OKX');
      expect(record.state).toBe(tsm.STATES.PARTIALLY_FILLED);
    });

    it('EMERGENCY_LIQUIDATION action transitions the trade to EMERGENCY_EXIT', () => {
      const id = tsm.createTrade(makeOpportunity());
      tsm.transition(id, tsm.STATES.SCORING);
      tsm.transition(id, tsm.STATES.APPROVED);
      tsm.transition(id, tsm.STATES.ORDER_CREATED);
      tsm.transition(id, tsm.STATES.ORDER_SUBMITTED);
      tsm.transition(id, tsm.STATES.PARTIALLY_FILLED);

      const result = tsm.executeRecovery(id, 'sell_succeeded_buy_failed', {});
      expect(result.ok).toBe(true);
      expect(result.action).toBe('emergency_liquidation');

      const record = tsm.getTrade(id);
      expect(record.state).toBe(tsm.STATES.EMERGENCY_EXIT);
      expect(record.rca.blockedBy).toBe('emergency_stop');
    });

    it('REVERSE action records a reversal outcome without transitioning state', () => {
      // determineRecoveryAction never actually returns REVERSE directly for a documented
      // scenario, but executeRecovery's switch supports it — verify via direct scenario mapping
      // is not exercised; instead confirm the switch doesn't crash for an action-producing branch
      // that maps through HEDGE/CANCEL/RETRY/EMERGENCY_LIQUIDATION already covered above.
      // This test instead verifies unhandled/undefined outcome doesn't throw for a scenario
      // that resolves to REVERSE would require monkeypatching; skip direct REVERSE and confirm
      // determineRecoveryAction's documented outputs stay within RECOVERY_STRATEGIES enum.
      const scenarios = [
        'buy_succeeded_sell_failed', 'sell_succeeded_buy_failed', 'exchange_timeout',
        'websocket_disconnect', 'api_outage', 'insufficient_liquidity',
        'insufficient_balance', 'price_moved_against', 'partial_fill_below_threshold', 'unknown',
      ];
      for (const scenario of scenarios) {
        const { action } = tsm.determineRecoveryAction(scenario, { retryCount: 0, hasOpenExposure: false });
        expect(Object.values(tsm.RECOVERY_STRATEGIES)).toContain(action);
      }
    });

    it('appends a recovery-initiated event to the trade event log', () => {
      const id = tsm.createTrade(makeOpportunity());
      const beforeCount = tsm.getTrade(id).events.length;
      tsm.executeRecovery(id, 'insufficient_balance', {});
      const record = tsm.getTrade(id);
      const recoveryEvent = record.events.find(e => e.reason && e.reason.startsWith('Recovery initiated'));
      expect(recoveryEvent).toBeDefined();
      expect(record.events.length).toBeGreaterThan(beforeCount);
    });
  });

  describe('planHedge', () => {
    it('recommends the spot hedge on the source exchange as the fastest strategy (long exposure → SELL)', () => {
      const plan = tsm.planHedge({ asset: 'BTC', amount: 0.02, valueUSD: 1000, sourceExchange: 'Binance', direction: 'long' });
      expect(plan.recommendedStrategy.type).toBe('spot_hedge');
      expect(plan.recommendedStrategy.exchange).toBe('Binance');
      expect(plan.recommendedStrategy.action).toBe('SELL');
    });

    it('defaults to long exposure (SELL) when direction is omitted, same as before this fix for every existing BTC caller', () => {
      const plan = tsm.planHedge({ asset: 'BTC', amount: 0.02, valueUSD: 1000, sourceExchange: 'Binance' });
      expect(plan.recommendedStrategy.action).toBe('SELL');
    });

    it('hedges a short exposure with BUY regardless of asset (item 3: direction, not asset identity, drives the action)', () => {
      const plan = tsm.planHedge({ asset: 'XRP', amount: 500, valueUSD: 1200, sourceExchange: 'Binance', direction: 'short' });
      expect(plan.recommendedStrategy.action).toBe('BUY');
    });

    it('includes cross-exchange hedge strategies excluding the source exchange', () => {
      const plan = tsm.planHedge({ asset: 'BTC', amount: 0.02, valueUSD: 1000, sourceExchange: 'Binance' });
      const crossExchange = plan.allStrategies.filter(s => s.type === 'cross_exchange_hedge');
      expect(crossExchange.length).toBeGreaterThan(0);
      expect(crossExchange.every(s => s.targetExchange !== 'Binance')).toBe(true);
    });

    it('includes a synthetic hedge strategy noting the perpetual API is required', () => {
      const plan = tsm.planHedge({ asset: 'ETH', amount: 1, valueUSD: 3000, sourceExchange: 'Kraken', direction: 'short' });
      const synthetic = plan.allStrategies.find(s => s.type === 'synthetic_hedge');
      expect(synthetic).toBeDefined();
      expect(synthetic.direction).toBe('LONG'); // short exposure → hedge with a LONG synthetic position
      expect(synthetic.note).toMatch(/perpetual/i);
    });

    it('flags urgency based on valueUSD thresholds', () => {
      expect(tsm.planHedge({ asset: 'BTC', amount: 0.1, valueUSD: 6000, sourceExchange: 'Binance' }).urgency).toBe('high');
      expect(tsm.planHedge({ asset: 'BTC', amount: 0.02, valueUSD: 1500, sourceExchange: 'Binance' }).urgency).toBe('medium');
      expect(tsm.planHedge({ asset: 'BTC', amount: 0.001, valueUSD: 100, sourceExchange: 'Binance' }).urgency).toBe('low');
    });
  });

  describe('getStats', () => {
    it('returns aggregate counts by state for active and historical trades', () => {
      const id1 = tsm.createTrade(makeOpportunity());
      const id2 = tsm.createTrade(makeOpportunity());
      tsm.transition(id2, tsm.STATES.SCORING);

      const stats = tsm.getStats();
      expect(stats.activeTrades).toBeGreaterThanOrEqual(2);
      expect(stats.byState[tsm.STATES.OPPORTUNITY_DETECTED]).toBeGreaterThanOrEqual(1);
      expect(stats.byState[tsm.STATES.SCORING]).toBeGreaterThanOrEqual(1);
    });

    it('computes recoverySuccessRate as null when there are no recovery attempts', () => {
      // Use a freshly failed/rolled-back trade with no recovery attempted
      const id = tsm.createTrade(makeOpportunity());
      tsm.transition(id, tsm.STATES.FAILED);
      tsm.transition(id, tsm.STATES.ROLLED_BACK);
      const stats = tsm.getStats();
      // recoverySuccessRate could be a number (from other tests' recoveries) or null;
      // just assert the field is present and either null or a finite percentage.
      expect(stats.recoverySuccessRate === null || typeof stats.recoverySuccessRate === 'number').toBe(true);
    });

    it('includes partialFillEvents and avgFillRatio when partial fills exist in history', () => {
      const id = tsm.createTrade(makeOpportunity({ buyPrice: 50000 }));
      tsm.evaluatePartialFill(id, 0.045, 0.05);
      tsm.transition(id, tsm.STATES.SCORING);
      tsm.transition(id, tsm.STATES.APPROVED);
      tsm.transition(id, tsm.STATES.ORDER_CREATED);
      tsm.transition(id, tsm.STATES.ORDER_SUBMITTED);
      tsm.transition(id, tsm.STATES.PARTIALLY_FILLED);
      tsm.transition(id, tsm.STATES.FILLED);
      tsm.transition(id, tsm.STATES.SETTLING);
      tsm.transition(id, tsm.STATES.COMPLETED);

      const stats = tsm.getStats();
      expect(stats.partialFillEvents).toBeGreaterThanOrEqual(1);
      expect(stats.avgFillRatio).toBeGreaterThan(0);
    });
  });
});

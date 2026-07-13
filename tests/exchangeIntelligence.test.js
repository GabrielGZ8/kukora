import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordOpportunitySeen,
  recordExecution,
  recordWsReconnect,
  recordStaleFeed,
  recordFeedUpdate,
  getExchangeRanking,
  computeReliabilityScore,
  getReliabilityLeaderboard,
  recordBtcPrice,
  getVolatilityStatus,
  recordPairDetection,
  getHistoricalLearning,
  getPredictiveRanking,
  recommendCapitalSize,
  resetIntelligence,
} from '../server/infrastructure/exchangeIntelligence.js';

describe('exchangeIntelligence', () => {
  beforeEach(() => {
    resetIntelligence();
  });

  describe('getExchangeRanking', () => {
    it('returns an entry for all 5 known exchanges with null stats initially', () => {
      const ranking = getExchangeRanking();
      expect(ranking).toHaveLength(5);
      const exchanges = ranking.map(r => r.exchange).sort();
      expect(exchanges).toEqual(['Binance', 'Bybit', 'Coinbase', 'Kraken', 'OKX']);
      expect(ranking[0].avgLatency).toBeNull();
      expect(ranking[0].successRate).toBeNull();
    });

    it('recordOpportunitySeen increments opportunitiesSeen for both buy and sell exchanges', () => {
      recordOpportunitySeen('Binance', 'Kraken', { buyLatency: 10, sellLatency: 20, fillProbability: 90 });
      const ranking = getExchangeRanking();
      const binance = ranking.find(r => r.exchange === 'Binance');
      const kraken = ranking.find(r => r.exchange === 'Kraken');
      expect(binance.opportunitiesSeen).toBe(1);
      expect(kraken.opportunitiesSeen).toBe(1);
      expect(binance.avgLatency).toBe(10);
      expect(kraken.avgLatency).toBe(20);
      expect(binance.avgFillProbability).toBe(90);
    });

    it('recordOpportunitySeen ignores unknown exchange names safely', () => {
      expect(() => recordOpportunitySeen('FakeEx1', 'FakeEx2', {})).not.toThrow();
    });

    it('recordExecution updates opportunitiesExecuted, totalProfit (split 50/50), and success/failure counts', () => {
      recordExecution({ buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 10 });
      const ranking = getExchangeRanking();
      const binance = ranking.find(r => r.exchange === 'Binance');
      expect(binance.opportunitiesExecuted).toBe(1);
      expect(binance.avgProfit).toBeCloseTo(5, 5); // 10/2 split, /1 executed
      expect(binance.successRate).toBe(100);
    });

    it('recordExecution counts losing trades as failures', () => {
      recordExecution({ buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: -4 });
      const ranking = getExchangeRanking();
      const binance = ranking.find(r => r.exchange === 'Binance');
      expect(binance.successRate).toBe(0);
    });

    it('sorts by composite score (successRate + reliability*0.5) descending', () => {
      recordExecution({ buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 5 });
      recordExecution({ buyExchange: 'OKX', sellExchange: 'Coinbase', netProfit: -5 });
      const ranking = getExchangeRanking();
      const binanceIdx = ranking.findIndex(r => r.exchange === 'Binance');
      const okxIdx = ranking.findIndex(r => r.exchange === 'OKX');
      expect(binanceIdx).toBeLessThan(okxIdx);
    });
  });

  describe('computeReliabilityScore', () => {
    it('returns 0 for an unknown exchange', () => {
      expect(computeReliabilityScore('NotAnExchange')).toBe(0);
    });

    it('returns a baseline score for an exchange with no activity at all', () => {
      const score = computeReliabilityScore('Binance');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('increases with feed updates relative to opportunities seen (higher wsScore)', () => {
      recordOpportunitySeen('Binance', 'Kraken', {});
      const before = computeReliabilityScore('Binance');
      for (let i = 0; i < 10; i++) recordFeedUpdate('Binance');
      const after = computeReliabilityScore('Binance');
      expect(after).toBeGreaterThan(before);
    });

    it('decreases with WS reconnect drops', () => {
      recordOpportunitySeen('Binance', 'Kraken', {});
      for (let i = 0; i < 10; i++) recordFeedUpdate('Binance');
      const before = computeReliabilityScore('Binance');
      recordWsReconnect('Binance');
      recordWsReconnect('Binance');
      const after = computeReliabilityScore('Binance');
      expect(after).toBeLessThan(before);
    });

    it('decreases with stale feed events', () => {
      recordOpportunitySeen('Binance', 'Kraken', {});
      for (let i = 0; i < 10; i++) recordFeedUpdate('Binance');
      const before = computeReliabilityScore('Binance');
      for (let i = 0; i < 5; i++) recordStaleFeed('Binance');
      const after = computeReliabilityScore('Binance');
      expect(after).toBeLessThan(before);
    });
  });

  describe('getReliabilityLeaderboard', () => {
    it('returns all 5 exchanges sorted by score descending', () => {
      recordOpportunitySeen('Binance', 'Kraken', {});
      for (let i = 0; i < 10; i++) recordFeedUpdate('Binance');
      const board = getReliabilityLeaderboard();
      expect(board).toHaveLength(5);
      for (let i = 1; i < board.length; i++) {
        expect(board[i - 1].score).toBeGreaterThanOrEqual(board[i].score);
      }
    });
  });

  describe('recordBtcPrice / getVolatilityStatus', () => {
    it('ignores invalid prices (zero, negative, NaN, null)', () => {
      recordBtcPrice(0);
      recordBtcPrice(-5);
      recordBtcPrice(NaN);
      recordBtcPrice(null);
      expect(getVolatilityStatus().bufferSize).toBe(0);
    });

    it('stays STABLE with score 0 until at least 5 prices have been recorded', () => {
      recordBtcPrice(100);
      recordBtcPrice(101);
      recordBtcPrice(100.5);
      const status = getVolatilityStatus();
      expect(status.score).toBe(0);
      expect(status.status).toBe('STABLE');
      expect(status.executionBlocked).toBe(false);
    });

    it('computes a non-zero volatility score once 5+ prices form a buffer with movement', () => {
      const prices = [100, 102, 99, 103, 98, 104];
      prices.forEach(recordBtcPrice);
      const status = getVolatilityStatus();
      expect(status.bufferSize).toBe(6);
      expect(status.score).toBeGreaterThan(0);
    });

    it('flags HIGH RISK and blocks execution under extreme price swings', () => {
      // Highly volatile alternating swings to push volScore over 65
      const prices = [100, 150, 80, 160, 70, 170, 60];
      prices.forEach(recordBtcPrice);
      const status = getVolatilityStatus();
      expect(status.score).toBeGreaterThanOrEqual(65);
      expect(status.status).toBe('HIGH RISK');
      expect(status.executionBlocked).toBe(true);
    });

    it('caps the rolling price buffer at MAX_PRICE_BUF (120 samples)', () => {
      for (let i = 0; i < 130; i++) recordBtcPrice(100 + (i % 5));
      expect(getVolatilityStatus().bufferSize).toBe(120);
    });
  });

  describe('recordPairDetection / getHistoricalLearning', () => {
    it('returns an empty array when nothing has been tracked', () => {
      expect(getHistoricalLearning()).toEqual([]);
    });

    it('creates a learner entry on first detection with detections=1, executions=0', () => {
      recordPairDetection('Binance', 'Kraken');
      const learning = getHistoricalLearning();
      expect(learning).toHaveLength(1);
      expect(learning[0].pair).toBe('Binance→Kraken');
      expect(learning[0].detections).toBe(1);
      expect(learning[0].executions).toBe(0);
      expect(learning[0].historicalSuccessRate).toBeNull();
    });

    it('recordExecution (via the learner) accumulates successes/failures and avgProfit for the pair', () => {
      recordPairDetection('Binance', 'Kraken');
      recordExecution({ buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 8 });
      recordExecution({ buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: -2 });
      const learning = getHistoricalLearning();
      const entry = learning.find(e => e.pair === 'Binance→Kraken');
      expect(entry.executions).toBe(2);
      expect(entry.successes).toBe(1);
      expect(entry.failures).toBe(1);
      expect(entry.historicalSuccessRate).toBe(50);
      expect(entry.avgProfit).toBe(8);
    });

    it('sorts learning entries by confidenceScore descending', () => {
      recordPairDetection('Binance', 'Kraken');
      for (let i = 0; i < 12; i++) recordExecution({ buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 5 });
      recordPairDetection('OKX', 'Coinbase');
      recordExecution({ buyExchange: 'OKX', sellExchange: 'Coinbase', netProfit: -5 });
      const learning = getHistoricalLearning();
      expect(learning[0].pair).toBe('Binance→Kraken');
    });
  });

  describe('getPredictiveRanking', () => {
    it('returns an empty array when there is no historical learning data', () => {
      expect(getPredictiveRanking([], getExchangeRanking())).toEqual([]);
    });

    it('returns up to 3 predictions sorted by probability descending', () => {
      recordPairDetection('Binance', 'Kraken');
      recordExecution({ buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 5 });
      recordPairDetection('OKX', 'Coinbase');
      recordExecution({ buyExchange: 'OKX', sellExchange: 'Coinbase', netProfit: -1 });
      const ranking = getExchangeRanking();
      const predictions = getPredictiveRanking([], ranking);
      expect(predictions.length).toBeLessThanOrEqual(3);
      expect(predictions.length).toBeGreaterThan(0);
      for (let i = 1; i < predictions.length; i++) {
        expect(predictions[i - 1].probability).toBeGreaterThanOrEqual(predictions[i].probability);
      }
      expect(predictions[0]).toHaveProperty('buyExchange');
      expect(predictions[0]).toHaveProperty('sellExchange');
    });

    it('marks currentlyActive true when a matching active lifecycle is supplied', () => {
      recordPairDetection('Binance', 'Kraken');
      recordExecution({ buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 5 });
      const ranking = getExchangeRanking();
      const lifecycles = [{ buyExchange: 'Binance', sellExchange: 'Kraken', seenCount: 10 }];
      const predictions = getPredictiveRanking(lifecycles, ranking);
      const entry = predictions.find(p => p.pair === 'Binance→Kraken');
      expect(entry.currentlyActive).toBe(true);
    });
  });

  describe('recommendCapitalSize', () => {
    const baseOp = { buyExchange: 'Binance', sellExchange: 'Kraken', fillProbability: 90, spreadPct: 0.5, breakEvenPct: 0.2 };

    it('returns a btc amount clamped between 0.001 and 0.1 with explainable factors', () => {
      const result = recommendCapitalSize(baseOp, {});
      expect(result.btc).toBeGreaterThanOrEqual(0.001);
      expect(result.btc).toBeLessThanOrEqual(0.1);
      expect(result.usd).toBeCloseTo(result.btc * 100000, 2);
      expect(result.factors).toHaveProperty('fill');
      expect(result.factors).toHaveProperty('edge');
      expect(result.factors).toHaveProperty('volatility');
      expect(result.factors).toHaveProperty('historical');
      expect(result.factors).toHaveProperty('liquidity');
    });

    it('returns 0 volatility factor (minimum btc 0.001) when execution is blocked by HIGH RISK volatility', () => {
      const prices = [100, 150, 80, 160, 70, 170, 60];
      prices.forEach(recordBtcPrice);
      expect(getVolatilityStatus().executionBlocked).toBe(true);
      const result = recommendCapitalSize(baseOp, {});
      expect(result.factors.volatility).toBe(0);
      expect(result.btc).toBe(0.001); // floored at minimum
    });

    it('constrains size by available USDT/BTC wallet balances', () => {
      const wallets = { USDT: { Binance: 100 }, BTC: { Kraken: 0.002 } };
      const result = recommendCapitalSize(baseOp, wallets, 100000);
      // maxFromBtc = 0.002 * 0.95 = 0.0019, but floor is 0.001
      expect(result.btc).toBeGreaterThanOrEqual(0.001);
      expect(result.btc).toBeLessThanOrEqual(0.002);
    });

    it('applies a historical confidence boost once a pair has 3+ tracked executions', () => {
      for (let i = 0; i < 3; i++) {
        recordExecution({ buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 5 });
      }
      const result = recommendCapitalSize(baseOp, {});
      expect(result.factors.historical).toBeGreaterThan(0.7); // 100% success rate => 1.3
    });
  });

  describe('resetIntelligence', () => {
    it('clears all stats, learner entries, and volatility state', () => {
      recordOpportunitySeen('Binance', 'Kraken', { buyLatency: 5 });
      recordExecution({ buyExchange: 'Binance', sellExchange: 'Kraken', netProfit: 5 });
      recordPairDetection('Binance', 'Kraken');
      recordBtcPrice(100);
      recordBtcPrice(105);
      recordWsReconnect('Binance');

      resetIntelligence();

      const ranking = getExchangeRanking();
      expect(ranking.every(r => r.opportunitiesSeen === 0)).toBe(true);
      expect(getHistoricalLearning()).toEqual([]);
      const vol = getVolatilityStatus();
      expect(vol.bufferSize).toBe(0);
      expect(vol.score).toBe(0);
      expect(vol.status).toBe('STABLE');
    });
  });
});

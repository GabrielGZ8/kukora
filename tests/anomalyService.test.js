import { describe, it, expect } from 'vitest';
import { detectAnomalies, detectBatch } from '../server/domain/analytics/anomalyService.js';

describe('anomalyService', () => {
  describe('detectAnomalies', () => {
    it('returns level "low" with no details when there is insufficient data (<5 prices)', () => {
      const result = detectAnomalies([100, 101, 102]);
      expect(result).toEqual({ level: 'low', reason: 'Datos insuficientes', severityScore: 0, details: [] });
    });

    it('reports "No anomalies detected" for a calm, steady series', () => {
      const result = detectAnomalies([100, 100.1, 100.2, 100.1, 100.3, 100.2, 100.4]);
      expect(result.level).toBe('low');
      expect(result.reason).toBe('No anomalies detected');
      expect(result.details).toEqual([]);
    });

    it('detects a "spike" when the last return exceeds spikePct', () => {
      const prices = [100, 100.1, 100.2, 100.1, 100.3, 109]; // last return ~+8.7%
      const result = detectAnomalies(prices);
      const types = result.details.map(d => d.type);
      expect(types).toContain('spike');
    });

    it('detects a "crash" when the last return is below crashPct', () => {
      const prices = [100, 100.1, 100.2, 100.1, 100.3, 91]; // last return ~ -9.4%
      const result = detectAnomalies(prices);
      const types = result.details.map(d => d.type);
      expect(types).toContain('crash');
    });

    it('escalates severity to "high" for a severe crash', () => {
      const prices = [100, 100, 100, 100, 100, 100, 60]; // -40% single candle
      const result = detectAnomalies(prices);
      expect(result.level).toBe('high');
      expect(result.severityScore).toBeGreaterThanOrEqual(60);
    });

    it('respects custom thresholds passed via opts', () => {
      const prices = [100, 100.1, 100.2, 100.1, 100.3, 103]; // +2.7% last return
      const noSpikeDefault = detectAnomalies(prices); // default spikePct=8, shouldn't trigger
      const spikeWithLowerThreshold = detectAnomalies(prices, { spikePct: 2 }); // now it should
      expect(noSpikeDefault.details.find(d => d.type === 'spike')).toBeUndefined();
      expect(spikeWithLowerThreshold.details.find(d => d.type === 'spike')).toBeDefined();
    });

    it('caps severityScore at 100 even with multiple stacked anomalies', () => {
      // Extreme crash on a previously flat series triggers crash + zscore + volatility simultaneously
      const prices = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 5];
      const result = detectAnomalies(prices);
      expect(result.severityScore).toBeLessThanOrEqual(100);
    });

    it('joins multiple anomaly labels with " · " in the reason string when several are detected', () => {
      const prices = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 5];
      const result = detectAnomalies(prices);
      if (result.details.length > 1) {
        expect(result.reason).toContain(' · ');
      }
      expect(result.details.length).toBeGreaterThan(0);
    });
  });

  describe('detectBatch', () => {
    it('returns one anomaly result per asset, preserving id and name', () => {
      const assets = [
        { id: 'btc', name: 'Bitcoin', prices: [100, 100.1, 100.2, 100.1, 100.3, 100.2] },
        { id: 'eth', name: 'Ethereum', prices: [100, 100.1, 100.2, 100.1, 100.3, 91] },
      ];
      const result = detectBatch(assets);
      expect(result.length).toBe(2);
      expect(result.every(r => r.id && r.anomaly)).toBe(true);
    });

    it('sorts results by severityScore descending (most anomalous first)', () => {
      const assets = [
        { id: 'calm', name: 'Calm', prices: [100, 100.1, 100.2, 100.1, 100.3, 100.2] },
        { id: 'crashing', name: 'Crashing', prices: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 5] },
      ];
      const result = detectBatch(assets);
      expect(result[0].id).toBe('crashing');
      expect(result[0].anomaly.severityScore).toBeGreaterThanOrEqual(result[1].anomaly.severityScore);
    });

    it('forwards custom opts to every asset in the batch', () => {
      const assets = [
        { id: 'a', name: 'A', prices: [100, 100.1, 100.2, 100.1, 100.3, 103] }, // +2.7% last
      ];
      const result = detectBatch(assets, { spikePct: 2 });
      expect(result[0].anomaly.details.find(d => d.type === 'spike')).toBeDefined();
    });
  });
});

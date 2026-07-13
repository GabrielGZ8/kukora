import { describe, it, expect } from 'vitest';
import { parseCSV, normalizeRows, analyzeDataset } from '../server/domain/analytics/datasetService.js';

describe('datasetService', () => {
  describe('parseCSV', () => {
    it('returns [] when there is no data row (header only or empty)', () => {
      expect(parseCSV('date,price')).toEqual([]);
      expect(parseCSV('')).toEqual([]);
    });

    it('parses a simple CSV into an array of row objects', () => {
      const csv = 'date,price\n2024-01-01,100\n2024-01-02,105';
      const rows = parseCSV(csv);
      expect(rows).toEqual([
        { date: '2024-01-01', price: '100' },
        { date: '2024-01-02', price: '105' },
      ]);
    });

    it('strips surrounding quotes from header and cell values', () => {
      const csv = '"date","price"\n"2024-01-01","100"';
      const rows = parseCSV(csv);
      expect(rows).toEqual([{ date: '2024-01-01', price: '100' }]);
    });

    it('skips blank lines between data rows', () => {
      const csv = 'date,price\n2024-01-01,100\n\n2024-01-02,105';
      const rows = parseCSV(csv);
      expect(rows.length).toBe(2);
    });

    it('handles Windows-style CRLF line endings', () => {
      const csv = 'date,price\r\n2024-01-01,100\r\n2024-01-02,105';
      const rows = parseCSV(csv);
      expect(rows.length).toBe(2);
    });
  });

  describe('normalizeRows', () => {
    it('returns [] for an empty input array', () => {
      expect(normalizeRows([])).toEqual([]);
    });

    it('detects a "price" column by common aliases (close, value, etc.)', () => {
      const rows = [{ timestamp: '2024-01-01', close: '100' }, { timestamp: '2024-01-02', close: '105' }];
      const result = normalizeRows(rows);
      expect(result[0]).toMatchObject({ date: '2024-01-01', price: 100 });
    });

    it('filters out rows with non-numeric or non-positive prices', () => {
      const rows = [
        { date: '2024-01-01', price: '100' },
        { date: '2024-01-02', price: 'not-a-number' },
        { date: '2024-01-03', price: '-5' },
        { date: '2024-01-04', price: '110' },
      ];
      const result = normalizeRows(rows);
      expect(result.length).toBe(2);
      expect(result.map(r => r.price)).toEqual([100, 110]);
    });

    it('sorts rows chronologically by date even if the input is out of order', () => {
      const rows = [
        { date: '2024-03-01', price: '120' },
        { date: '2024-01-01', price: '100' },
        { date: '2024-02-01', price: '110' },
      ];
      const result = normalizeRows(rows);
      expect(result.map(r => r.date)).toEqual(['2024-01-01', '2024-02-01', '2024-03-01']);
    });

    it('attaches a volume column when present, null otherwise', () => {
      const withVol = normalizeRows([{ date: '2024-01-01', price: '100', volume: '5000' }]);
      expect(withVol[0].volume).toBe(5000);

      const withoutVol = normalizeRows([{ date: '2024-01-01', price: '100' }]);
      expect(withoutVol[0].volume).toBeNull();
    });
  });

  describe('analyzeDataset', () => {
    it('returns an error object when there are fewer than 10 valid rows', () => {
      const rows = Array.from({ length: 5 }, (_, i) => ({ date: `2024-01-0${i + 1}`, price: String(100 + i) }));
      const result = analyzeDataset(rows);
      expect(result.error).toMatch(/Insufficient dataset/);
    });

    it('produces a full analysis (stats/regime/kcs/anomaly/chart) for a valid dataset', () => {
      const base = new Date('2024-01-01').getTime();
      const dayMs = 86400000;
      const rows = Array.from({ length: 40 }, (_, i) => ({
        date: new Date(base + i * dayMs).toISOString().slice(0, 10),
        price: String(100 + i * 1.5),
      }));
      const result = analyzeDataset(rows);
      expect(result.error).toBeUndefined();
      expect(result.stats.rows).toBe(40);
      expect(result.stats.startPrice).toBe(100);
      expect(result.regime).toBeDefined();
      expect(result.kcs).toBeDefined();
      expect(result.anomaly).toBeDefined();
      expect(result.chart.prices.length).toBeGreaterThan(0);
      expect(result.chart.returnsDist.length).toBe(20); // fixed 20 buckets
    });

    it('reports meta.hasVolume correctly based on whether a volume column was present', () => {
      const base = new Date('2024-02-01').getTime();
      const dayMs = 86400000;
      const withoutVolume = Array.from({ length: 40 }, (_, i) => ({
        date: new Date(base + i * dayMs).toISOString().slice(0, 10),
        price: String(100 + i),
      }));
      const result = analyzeDataset(withoutVolume);
      expect(result.meta.hasVolume).toBe(false);
    });
  });
});

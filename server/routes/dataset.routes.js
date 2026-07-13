'use strict';

/**
 * Dataset routes — extracted from server/index.js as part of audit fix 2.5
 * (SRP: separate route modules per domain, remove business logic from index.js).
 */

const express = require('express');
const router  = express.Router();

const { parseCSV, analyzeDataset } = require('../domain/analytics/datasetService');
const { sendError } = require('../infrastructure/errorResponse');
const { ValidationError } = require('../domain/errors');

// POST /api/dataset/analyze — parse and analyze a CSV or JSON dataset
router.post('/analyze', (req, res) => {
  try {
    let rows = [];
    if (req.body.csv) {
      rows = parseCSV(req.body.csv);
    } else if (req.body.json && Array.isArray(req.body.json)) {
      rows = req.body.json;
    } else {
      throw new ValidationError('Expected { csv: "..." } or { json: [...] }');
    }
    if (!rows.length) throw new ValidationError('Dataset is empty or could not be parsed.');
    // Issue 10: Cap dataset size to prevent memory/CPU DoS
    const MAX_ROWS = 10000;
    if (rows.length > MAX_ROWS) {
      return res.status(413).json({ ok: false, error: `Dataset exceeds ${MAX_ROWS} row limit` });
    }
    const result = analyzeDataset(rows);
    if (result.error) return res.status(422).json({ ok: false, error: result.error });
    res.json({ ok: true, data: result });
  } catch (e) { sendError(res, e); }
});

// GET /api/dataset/example — return a synthetic 90-day BTC price CSV for UI demos
router.get('/example', (_, res) => {
  const rows  = [];
  let price   = 40000;
  const start = new Date('2024-01-01');
  for (let i = 0; i < 90; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    price = price * (1 + (Math.random() - 0.48) * 0.04);
    rows.push({
      date:   date.toISOString().split('T')[0],
      price:  +price.toFixed(2),
      volume: Math.round(Math.random() * 1e9),
    });
  }
  const csv = 'date,price,volume\n' + rows.map(r => `${r.date},${r.price},${r.volume}`).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="kukora_example.csv"');
  res.send(csv);
});

module.exports = router;

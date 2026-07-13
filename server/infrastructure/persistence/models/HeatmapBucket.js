'use strict';
/**
 * server/models/HeatmapBucket.js — audit fix 1.3 (centralize mongoose.model())
 * Originally defined inline in server/spreadHeatmapService.js.
 */
const mongoose = require('mongoose');

const HeatmapBucketSchema = new mongoose.Schema({
  date:        { type: String, required: true },  // "YYYY-MM-DD"
  hour:        { type: Number, required: true },  // 0-23 UTC
  pair:        { type: String, required: true },  // "Binance→OKX"
  count:       { type: Number, default: 0 },
  sumSpread:   { type: Number, default: 0 },
  maxSpread:   { type: Number, default: 0 },
  viableCount: { type: Number, default: 0 },
}, {
  collection: 'kukora_spread_heatmap',
  indexes: [{ date: 1, hour: 1, pair: 1 }, { unique: true }],
});

let HeatmapBucket;
try {
  HeatmapBucket = mongoose.model('KukoraSpreadHeatmap');
} catch {
  HeatmapBucket = mongoose.model('KukoraSpreadHeatmap', HeatmapBucketSchema);
}

module.exports = HeatmapBucket;

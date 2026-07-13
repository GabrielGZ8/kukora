'use strict';
/**
 * server/models/ReplaySnapshot.js — audit fix 1.3 (centralize mongoose.model())
 * Originally defined inline in server/replayService.js.
 */
const mongoose = require('mongoose');

const ReplaySnapshotSchema = new mongoose.Schema({
  ts:             { type: Date, default: Date.now, index: true },
  reason:         { type: String, enum: ['transition_to_viable', 'trade_executed', 'spread_improved'], required: true },
  pair:           { type: String, index: true }, // "Binance→OKX"
  orderBooks:     { type: mongoose.Schema.Types.Mixed }, // full snapshot of all 5 books (bid/ask/depth top-5)
  opportunity:    { type: mongoose.Schema.Types.Mixed }, // the full opportunity object as detected
  executedTrade:  { type: mongoose.Schema.Types.Mixed, default: null },
  detectionLatencyMs: Number,
});

let ReplaySnapshot;
try {
  ReplaySnapshot = mongoose.model('ReplaySnapshot');
} catch {
  ReplaySnapshot = mongoose.model('ReplaySnapshot', ReplaySnapshotSchema);
}

module.exports = ReplaySnapshot;

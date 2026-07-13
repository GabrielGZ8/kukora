'use strict';
/**
 * server/models/DailyStatsDoc.js — audit fix 1.3 (centralize mongoose.model())
 * Originally defined inline in server/dailyStatsService.js.
 */
const mongoose = require('mongoose');

const DailyStatsSchema = new mongoose.Schema({
  date:          { type: String, required: true, unique: true, index: true }, // "YYYY-MM-DD"
  trades:        { type: Number, default: 0 },
  pnl:           { type: Number, default: 0 },
  fees:          { type: Number, default: 0 },
  winRate:       { type: Number, default: 0 },
  captureRate:   { type: Number, default: null },
  bestOpp:       { type: mongoose.Schema.Types.Mixed, default: null },
  pairBreakdown: { type: mongoose.Schema.Types.Mixed, default: {} },
  sessionsCount: { type: Number, default: 1 },
  updatedAt:     { type: Date,   default: Date.now },
}, { collection: 'kukora_daily_stats' });

let DailyStatsDoc;
try {
  DailyStatsDoc = mongoose.model('KukoraDailyStats');
} catch {
  DailyStatsDoc = mongoose.model('KukoraDailyStats', DailyStatsSchema);
}

module.exports = DailyStatsDoc;

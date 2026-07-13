'use strict';
/**
 * server/models/DailyReportDoc.js — audit fix 1.3 (centralize mongoose.model())
 * Originally defined inline in server/dailyReportService.js.
 */
const mongoose = require('mongoose');

const DailyReportSchema = new mongoose.Schema({
  date:      { type: String, required: true, unique: true },
  content:   { type: String },    // texto completo del reporte
  data:      { type: mongoose.Schema.Types.Mixed },  // datos estructurados
  sentAt:    { type: Date },
  delivered: { type: Boolean, default: false },
}, { collection: 'kukora_daily_reports' });

let DailyReportDoc;
try {
  DailyReportDoc = mongoose.model('KukoraDailyReport');
} catch {
  DailyReportDoc = mongoose.model('KukoraDailyReport', DailyReportSchema);
}

module.exports = DailyReportDoc;

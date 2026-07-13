'use strict';
/**
 * server/models/SessionDoc.js — audit fix 1.3 (centralize mongoose.model())
 * Originally defined inline in server/persistenceService.js.
 */
const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
  sessionId:    { type: String, required: true, index: true },
  type:         { type: String, enum: ['equity_point', 'trade', 'session_meta'], required: true },
  ts:           { type: Date, default: Date.now, index: true },
  data:         { type: mongoose.Schema.Types.Mixed, required: true },
}, { collection: 'kukora_session' });

// Compound index for fast "latest session" queries
SessionSchema.index({ sessionId: 1, type: 1, ts: 1 });

let SessionDoc;
try {
  SessionDoc = mongoose.model('KukoraSession');
} catch {
  SessionDoc = mongoose.model('KukoraSession', SessionSchema);
}

module.exports = SessionDoc;

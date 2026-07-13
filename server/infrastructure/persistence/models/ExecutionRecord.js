'use strict';
/**
 * server/models/ExecutionRecord.js — audit fix 1.3 (centralize mongoose.model())
 *
 * Originally defined inline in server/executionQualityTracker.js. Moved here
 * so every Mongoose schema in the project lives under one directory instead
 * of being scattered across 8 files (see the technical due diligence doc,
 * section 1.3). executionQualityTracker.js now imports this model instead
 * of defining it.
 */
const mongoose = require('mongoose');

const ExecutionRecordSchema = new mongoose.Schema({
  // Item 5 (Mongo Atlas readiness, post-checkpoint-03): executionQualityTracker.js
  // queries this collection with `.find().sort({ ts: -1 }).limit(n)` — without
  // an index on `ts`, Atlas has to collection-scan + in-memory-sort on every
  // call, which gets expensive as this (high-volume, one doc per trade)
  // collection grows. Purely additive: adding an index never changes query
  // results, only their cost.
  ts:              { type: Date,   default: Date.now, index: true },
  pair:            { type: String },   // "Binance→OKX"
  asset:           { type: String, default: 'BTC' },
  estimatedSpread: { type: Number },   // % spread at the moment of the signal
  estimatedSlip:   { type: Number },   // slippage estimado por VWAP walk
  estimatedNet:    { type: Number },   // netProfit estimado
  actualNet:       { type: Number },   // netProfit real (del trade ejecutado)
  spreadDecay:     { type: Number },   // estimatedSpread - actualSpread
  slippageBias:    { type: Number },   // estimatedSlip - actualSlip
  score:           { type: Number },
  positionSize:    { type: Number },
}, { collection: 'kukora_execution_quality' });

let ExecutionRecord;
try {
  ExecutionRecord = mongoose.model('KukoraExecutionQuality');
} catch {
  ExecutionRecord = mongoose.model('KukoraExecutionQuality', ExecutionRecordSchema);
}

module.exports = ExecutionRecord;

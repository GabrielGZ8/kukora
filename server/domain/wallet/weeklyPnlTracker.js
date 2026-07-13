'use strict';

/**
 * weeklyPnlTracker.js — Kukora v1
 *
 * Parallel to the daily P&L tracker in opportunityDetection.js, this module
 * tracks rolling weekly P&L and enforces maxWeeklyLossUSD / weeklyProfitTargetUSD
 * from liveConfig.
 *
 * Week boundary: Monday 00:00:00 UTC (ISO week convention).
 * Reset is automatic on the first trade or tick after the week boundary.
 *
 * Architecture:
 *   - Uses the same integer-accumulator pattern as _dailyPnlRaw (avoids FP drift)
 *   - isWeeklyLossBreached() is called by arbitrageOrchestrator.js before each execution
 *   - isWeeklyTargetHit() triggers an auto-pause (same as daily target)
 *   - resetWeekly() is called on week boundary (auto-detected) or by tests
 */

const liveConfig = require('../../infrastructure/liveConfig');

// Epoch ms of the start of the current ISO week (Monday 00:00:00 UTC)
function _weekStart() {
  const now  = new Date();
  const day  = now.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
  const diff = (day === 0 ? -6 : 1 - day); // days to previous Monday
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff));
  return monday.getTime();
}

let _weeklyPnlRaw  = 0; // integer: value × 10000 to avoid FP drift
let _weekResetTs   = _weekStart();
let _weeklyTrades  = 0;
let _autoPausedAt  = null; // ISO timestamp if auto-paused this week

function _autoReset() {
  const thisWeekStart = _weekStart();
  if (thisWeekStart > _weekResetTs) {
    _weeklyPnlRaw = 0;
    _weekResetTs  = thisWeekStart;
    _weeklyTrades = 0;
    _autoPausedAt = null;
  }
}

function getWeeklyPnl() {
  _autoReset();
  return _weeklyPnlRaw / 10000;
}

function addWeeklyPnl(n) {
  _autoReset();
  _weeklyPnlRaw += Math.round(n * 10000);
  _weeklyTrades++;
}

/**
 * isWeeklyLossBreached — returns true when weekly P&L is below maxWeeklyLossUSD.
 * maxWeeklyLossUSD is a negative number (e.g. -2000 = "halt if we lose > $2000/week").
 */
function isWeeklyLossBreached() {
  _autoReset();
  const limit = liveConfig.get('maxWeeklyLossUSD');
  if (limit == null || typeof limit !== 'number') return false;
  return getWeeklyPnl() <= limit;
}

/**
 * isWeeklyTargetHit — returns true when weekly P&L >= weeklyProfitTargetUSD.
 * null target = never hit (disabled).
 */
function isWeeklyTargetHit() {
  _autoReset();
  const target = liveConfig.get('weeklyProfitTargetUSD');
  if (target == null || typeof target !== 'number') return false;
  const hit = getWeeklyPnl() >= target;
  if (hit && !_autoPausedAt) _autoPausedAt = new Date().toISOString();
  return hit;
}

/**
 * isDailyTargetHit — returns true when today's P&L >= dailyProfitTargetUSD.
 * Reads today's P&L from arbitrageEngine.getDailyPnl() to avoid duplication.
 * null target = disabled.
 */
function isDailyTargetHit(dailyPnl) {
  const target = liveConfig.get('dailyProfitTargetUSD');
  if (target == null || typeof target !== 'number') return false;
  return dailyPnl >= target;
}

function resetWeekly() {
  _weeklyPnlRaw = 0;
  _weekResetTs  = _weekStart();
  _weeklyTrades = 0;
  _autoPausedAt = null;
}

function getWeeklyStats() {
  _autoReset();
  const pnl    = getWeeklyPnl();
  const limit  = liveConfig.get('maxWeeklyLossUSD');
  const target = liveConfig.get('weeklyProfitTargetUSD');
  return {
    weeklyPnl:     +pnl.toFixed(4),
    weeklyTrades:  _weeklyTrades,
    weekStart:     new Date(_weekResetTs).toISOString(),
    lossLimit:     limit,
    profitTarget:  target,
    lossBreached:  isWeeklyLossBreached(),
    targetHit:     isWeeklyTargetHit(),
    autoPausedAt:  _autoPausedAt,
    remainingBudget: limit != null ? +(pnl - limit).toFixed(2) : null, // USD left before halt
  };
}

module.exports = {
  addWeeklyPnl,
  getWeeklyPnl,
  isWeeklyLossBreached,
  isWeeklyTargetHit,
  isDailyTargetHit,
  resetWeekly,
  getWeeklyStats,
};

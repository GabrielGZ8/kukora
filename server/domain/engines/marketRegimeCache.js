'use strict';
/**
 * marketRegimeCache.js - ADR-019 Sec4 (Hallazgo 5, Market Regime signal).
 *
 * detectMarketRegime(prices) is O(prices) statistical work (rolling stdev,
 * SMA crossover, momentum) built for a candle series - not meant to be
 * called once per opportunity per tick, since the regime does not change
 * tick-to-tick by construction. This mirrors the existing
 * exchangeIntelligence.getVolatilityStatus() pattern, which recomputes on
 * its own rolling window, not per opportunity.
 *
 * This module recomputes the regime at most every `marketRegimeRefreshMs`
 * (default 60s, see liveConfig) from the BTC price series
 * exchangeIntelligence already accumulates for its own volatility
 * tracking (getBtcPriceSeries()) - no new price feed, reuses existing
 * state.
 *
 * Every adjustment this cache exposes is defensive only: score
 * multipliers are >= 1.0 (tighten or hold) and size multipliers are
 * <= 1.0 (reduce or hold) - enforced both by the liveConfig validators for
 * marketRegimeScoreMultipliers/marketRegimeSizeMultipliers and, belt and
 * suspenders, by clamping again here.
 */
const { detectMarketRegime } = require('./marketRegimeEngine');
const { getBtcPriceSeries } = require('../../infrastructure/exchangeIntelligence');
const liveConfig = require('../../infrastructure/liveConfig');
const obs = require('../../infrastructure/observabilityService');

let _cached = null;       // last detectMarketRegime() result
let _lastComputedAt = 0;

function _clampScoreMult(v) { return Math.max(1.0, Math.min(3.0, Number(v) || 1.0)); }
function _clampSizeMult(v)  { return Math.max(0.01, Math.min(1.0, Number(v) || 1.0)); }

/**
 * getCurrentRegime - returns the cached regime, recomputing at most once
 * per marketRegimeRefreshMs. Never throws: any failure to compute (e.g.
 * insufficient price history) falls back to a neutral BULLISH_EXPANSION-
 * equivalent no-op regime rather than blocking the tick.
 */
function getCurrentRegime(now = Date.now()) {
  if (!liveConfig.get('marketRegimeEnabled')) {
    return { id: null, confidence: 0, enabled: false };
  }
  const refreshMs = liveConfig.get('marketRegimeRefreshMs');
  if (_cached && (now - _lastComputedAt) < refreshMs) {
    return _cached;
  }
  let result;
  try {
    const prices = getBtcPriceSeries();
    result = detectMarketRegime(prices);
  } catch (e) {
    result = { id: 'VOLATILE_UNCERTAINTY', confidence: 0, error: e.message };
  }
  const previousId = _cached ? _cached.id : null;
  _cached = { ...result, enabled: true, computedAt: now };
  _lastComputedAt = now;
  if (previousId && previousId !== _cached.id) {
    obs.emit('SYSTEM', 'market_regime.changed', {
      from: previousId,
      to: _cached.id,
      confidence: _cached.confidence,
      scoreMultiplier: getScoreMultiplier(),
      sizeMultiplier: getSizeMultiplier(),
    });
  }
  return _cached;
}

function getScoreMultiplier() {
  const regime = getCurrentRegime();
  if (!regime.enabled || !regime.id) return 1.0;
  const map = liveConfig.get('marketRegimeScoreMultipliers') || {};
  return _clampScoreMult(map[regime.id]);
}

function getSizeMultiplier() {
  const regime = getCurrentRegime();
  if (!regime.enabled || !regime.id) return 1.0;
  const map = liveConfig.get('marketRegimeSizeMultipliers') || {};
  return _clampSizeMult(map[regime.id]);
}

/** Test-only reset. */
function _resetForTests() {
  _cached = null;
  _lastComputedAt = 0;
}

module.exports = {
  getCurrentRegime,
  getScoreMultiplier,
  getSizeMultiplier,
  _resetForTests,
};

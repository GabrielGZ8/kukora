'use strict';

/**
 * healthService.js — builds the /health response payload.
 *
 * Pulled out of server/index.js so it can be unit/integration tested in
 * isolation. Importing server/index.js directly in tests would, as a side
 * effect, call arbitrage.routes' startEngine() — fine in production, not
 * something a test for "does /health respond correctly" should trigger.
 */

const pkg = require('../../package.json');

const START_TS = Date.now();

async function buildHealthPayload({ mongoose, dbConnected, isProd } = {}) {
  // DB latency probe
  let dbLatencyMs = null;
  if (dbConnected && mongoose) {
    const t0 = Date.now();
    try {
      await mongoose.connection.db.admin().ping();
      dbLatencyMs = Date.now() - t0;
    } catch (_) {
      dbLatencyMs = null;
    }
  }

  // Feed staleness — read from arbitrage engine if available. Lazily
  // required so importing healthService.js alone never pulls in the
  // engine's startup side effects unless this function actually runs.
  let feedStatus = {};
  let engineStatus = {};
  try {
    const arb = require('../application/arbitrageOrchestrator');
    const st  = arb.getStatus?.() || {};
    engineStatus = {
      running:               true,
      uptimeMs:              Date.now() - START_TS,
      // opportunitiesScanned is the correct field name in arbitrageOrchestrator.js.
      // The engine also exposes viableFound (opportunities that passed all
      // filters). opportunitiesDetected never existed — it was always 0.
      opportunitiesScanned:  st.opportunitiesScanned  || 0,
      viableFound:           st.viableFound           || 0,
      tradesExecuted:        st.tradesExecuted         || 0,
      dailyPnl:              st.dailyPnl              || 0,
    };
    // The engine exposes feedFreshness (via exchangeService.getFreshness()),
    // not a top-level `feeds` key. Build feed status from feedFreshness.
    if (st.feedFreshness) feedStatus = st.feedFreshness;
  } catch (_) {
    engineStatus = { running: false };
  }

  const mem = process.memoryUsage();

  // L-2: /health previously checked MongoDB but never Redis. Lazily
  // required so importing healthService.js alone never pulls in auth.js's
  // module-load-time Redis client setup unless this function actually runs.
  let redisStatus = { configured: false, connected: false };
  try {
    const { getRedisStatus } = require('./auth');
    redisStatus = getRedisStatus();
  } catch (_) {
    redisStatus = { configured: false, connected: false };
  }

  return {
    ok:      true,
    service: 'kukora-api',
    version: pkg.version,
    ts:      new Date().toISOString(),
    uptime:  Math.floor(process.uptime()),
    env:     isProd ? 'production' : 'development',
    db: {
      connected: !!dbConnected,
      latencyMs: dbLatencyMs,
    },
    redis:  redisStatus,
    feeds:  feedStatus,
    engine: engineStatus,
    memory: {
      heapUsedMb:  +(mem.heapUsed  / 1e6).toFixed(1),
      heapTotalMb: +(mem.heapTotal / 1e6).toFixed(1),
      rssMb:       +(mem.rss       / 1e6).toFixed(1),
    },
  };
}

module.exports = { buildHealthPayload };

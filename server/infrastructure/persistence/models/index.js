'use strict';
/**
 * server/models/index.js — single source of truth for "what are all the
 * Mongoose schemas in this project" (audit v2, section 1.3).
 *
 * Before this fix, mongoose.model() was called in 8 different files with
 * no central listing. An engineer asking "what does our DB schema look
 * like" had to grep the whole repo. Now:
 *
 *   - The 8 "official" consumer-domain models (User, Alert, Watchlist,
 *     Portfolio, Notification, etc.) still live in server/models.js —
 *     left in place to avoid a wide-blast-radius rename of every route
 *     file that does require('./models'), but re-exported here too.
 *   - The 6 previously-scattered models (one per file that used to define
 *     its own mongoose.model() call ad-hoc) now live under server/models/
 *     as one file per model, and the service files that used to define
 *     them now require() them from here instead.
 *
 * REMAINING EXCEPTION (documented, not silently dropped): walletManager.js's
 * `ArbitrageOp` model is intentionally NOT moved here. It is defined in the
 * TypeScript-migrated financial core (server-types/server/walletManager.ts
 * → compiles to server/walletManager.js) with a typed Mongoose Document
 * interface. Moving it requires re-typing it in the same TS migration and
 * recompiling with `tsc` (verified in CI, not hand-edited in the generated
 * .js). Tracked as the one remaining item for a follow-up pass.
 */
const consumerModels = require('../../../models');

module.exports = {
  ...consumerModels,
  ExecutionRecord: require('./ExecutionRecord'),
  HeatmapBucket:   require('./HeatmapBucket'),
  DailyReportDoc:  require('./DailyReportDoc'),
  SessionDoc:      require('./SessionDoc'),
  ReplaySnapshot:  require('./ReplaySnapshot'),
  DailyStatsDoc:   require('./DailyStatsDoc'),
};

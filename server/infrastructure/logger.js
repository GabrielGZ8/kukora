'use strict';

/**
 * logger.js — Kukora structured logging
 *
 * In production: emits newline-delimited JSON to stdout (compatible with
 * Datadog, CloudWatch, Railway log drains, and any JSON log aggregator).
 * In development: emits human-readable coloured output with level icons.
 *
 * Usage:
 *   const { logger } = require('./logger');
 *   logger.info('arbitrageEngine', 'Opportunity detected', { pair: 'BTC', spreadPct: 0.42 });
 *   logger.error('index', 'MongoDB connection failed', { err: e.message });
 */

const os = require('os');

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;
const IS_PROD = process.env.NODE_ENV === 'production';

const ICONS = { debug: '·', info: '◈', warn: '⚠', error: '✗' };
const COLORS = {
  debug: '\x1b[90m',
  info:  '\x1b[36m',
  warn:  '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
};

// Resolved once at boot — these don't change for the life of the process,
// so there's no reason to re-read package.json or os.hostname() per log line.
let pkgVersion = 'unknown';
try { pkgVersion = require('../../package.json').version || 'unknown'; } catch (_) { /* non-critical — fire-and-forget */ }
const HOSTNAME = os.hostname();
const PID = process.pid;
const ENVIRONMENT = process.env.NODE_ENV || 'development';
// GIT_SHA is injected by CI (e.g. Railway: GIT_SHA=$RAILWAY_GIT_COMMIT_SHA).
// Present in every prod log line so errors can be correlated back to the exact commit.
const GIT_SHA = process.env.GIT_SHA || null;

function log(level, module, message, meta = {}) {
  if (LOG_LEVELS[level] < LEVEL) return;

  const entry = IS_PROD
    ? {
        ts:      new Date().toISOString(),
        level,
        module,
        message,
        // Standard tracing fields — makes every log line directly
        // ingestible by Datadog (or any JSON-aware aggregator) without a
        // transformation/parsing pipeline in front of it.
        service:     'kukora-api',
        version:     pkgVersion,
        environment: ENVIRONMENT,
        hostname:    HOSTNAME,
        pid:         PID,
        ...(GIT_SHA ? { git_sha: GIT_SHA } : {}),
        ...meta,
      }
    : {
        ts:      new Date().toISOString(),
        level,
        module,
        message,
        ...meta,
      };

  if (IS_PROD) {
    process.stdout.write(JSON.stringify(entry) + '\n');
  } else {
    const icon  = ICONS[level];
    const color = COLORS[level];
    const reset = COLORS.reset;
    const metaStr = Object.keys(meta).length
      ? ' ' + JSON.stringify(meta)
      : '';
    console.log(`${color}${icon} [${module}] ${message}${metaStr}${reset}`);
  }
}

const logger = {
  debug: (mod, msg, meta) => log('debug', mod, msg, meta),
  info:  (mod, msg, meta) => log('info',  mod, msg, meta),
  warn:  (mod, msg, meta) => log('warn',  mod, msg, meta),
  error: (mod, msg, meta) => log('error', mod, msg, meta),
};

module.exports = { logger };

'use strict';

/**
 * requestMiddleware.js — Per-request instrumentation
 *
 * Attaches a unique X-Request-ID to every response and logs each request
 * with method, path, status, and duration in milliseconds.
 *
 * In production, X-Request-ID enables log correlation across services.
 *
 * Also feeds two lightweight side channels:
 *  - metricsService: requests_total / errors_total counters for /api/metrics
 *  - slow-request warnings: any request over SLOW_REQUEST_THRESHOLD_MS gets
 *    a `warn`-level log line with path/duration/requestId so it's grep-able
 *    in production logs (e.g. `level:warn module:http slow`).
 */

const { logger } = require('./logger');
const metrics = require('./metricsService');
const { randomUUID } = require('crypto');

const SLOW_REQUEST_THRESHOLD_MS = 500;
// External API routes (CoinGecko, auth with DB) have higher inherent latency.
// We use a separate threshold for these to avoid noise in logs.
const SLOW_EXTERNAL_THRESHOLD_MS = 3000;
const EXTERNAL_API_PATHS = ['/markets', '/global', '/trending', '/overview', '/refresh', '/login', '/register'];

function requestMiddleware(req, res, next) {
  const requestId = randomUUID();
  const start = process.hrtime.bigint();

  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const isError = res.statusCode >= 500;
    const level = isError ? 'error'
                : res.statusCode >= 400 ? 'warn'
                : 'debug';

    metrics.increment('requests_total');
    if (isError) metrics.increment('errors_total');

    logger[level]('http', `${req.method} ${req.path}`, {
      status:     res.statusCode,
      durationMs: +durationMs.toFixed(2),
      requestId,
      userId:     req.userId,
    });

    const isExternalRoute = EXTERNAL_API_PATHS.some(p => req.path.endsWith(p));
    const slowThreshold = isExternalRoute ? SLOW_EXTERNAL_THRESHOLD_MS : SLOW_REQUEST_THRESHOLD_MS;

    if (durationMs > slowThreshold) {
      logger.warn('http', `slow request: ${req.method} ${req.path}`, {
        slow:       true,
        path:       req.path,
        method:     req.method,
        durationMs: +durationMs.toFixed(2),
        requestId,
      });
    }
  });

  next();
}

module.exports = { requestMiddleware, SLOW_REQUEST_THRESHOLD_MS, SLOW_EXTERNAL_THRESHOLD_MS };

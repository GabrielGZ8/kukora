'use strict';
/**
 * ecosystem.config.js — PM2 process definition.
 *
 * See docs/ADR-016-pm2-single-instance-constraint.md for the full reasoning.
 * Short version: `instances` is intentionally 1, not `max`/`cluster`.
 *
 * The arbitrage engine is a *singleton* per process — it owns 5 live
 * exchange WebSocket connections (server/infrastructure/exchangeService.js),
 * an in-memory opportunity/state store (server/application/arbitrage.state.js),
 * and in-memory SSE client sets. Running this app under `exec_mode: 'cluster'`
 * with N > 1 instances would silently:
 *   - open N× the WebSocket connections to Binance/Kraken/Bybit/OKX/Coinbase
 *     (risking rate-limit bans — see server/infrastructure/exchangeRateLimiter.js),
 *   - run N independent, unsynchronized copies of the detection/risk engine,
 *   - split SSE clients across workers with no cross-worker broadcast, so a
 *     browser tab could stop receiving ticks depending on which worker its
 *     long-lived connection landed on.
 *
 * What PM2 *does* give us safely in fork mode with instances: 1:
 *   - automatic restart on crash (belt-and-suspenders alongside Railway's
 *     own ON_FAILURE restart policy in railway.json — useful for non-Railway
 *     deployments: bare VM, on-prem, etc.),
 *   - memory-based restart guard,
 *   - centralized log files,
 *   - a supervisor that forwards SIGINT on `pm2 stop` / `pm2 reload`, which
 *     the app's existing graceful-shutdown handler in server/index.js
 *     already listens for — no code changes needed for compatibility.
 *
 * If true multi-core scaling is ever needed, the correct path is documented
 * in the ADR: split into an "engine" process (owns WS feeds + detection +
 * SSE fan-out) and stateless "API" replicas behind Redis pub/sub — not a
 * blind cluster-mode flip.
 */
module.exports = {
  apps: [
    {
      name: 'kukora',
      script: 'server/index.js',
      cwd: __dirname,

      // Intentionally NOT cluster mode — see header comment / ADR-016.
      exec_mode: 'fork',
      instances: 1,

      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 2000,

      // Guards against slow memory leaks (e.g. an unbounded in-memory array
      // that escaped the caps documented in the domain modules) by recycling
      // the process before it becomes a symptom instead of a cause.
      max_memory_restart: '512M',

      // PM2's default kill signal is SIGINT, which server/index.js already
      // handles via the shutdown() coordinator (stops the engine loop,
      // closes exchange WS connections, flushes persistence, drains SSE,
      // closes Mongo, then closes the HTTP server).
      kill_timeout: 6000, // slightly above the app's own 5s forceExit guard

      watch: false, // this is a supervised production process, not dev:watch

      env: {
        NODE_ENV: 'production',
      },

      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};

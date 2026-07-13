/**
 * watchdog.js — Kukora v17
 *
 * Sistema de auto-recovery y resiliencia operacional 24/7.
 *
 * PROBLEMAS QUE RESUELVE:
 *   1. Servidor cae → nadie avisa → trades activos quedan huérfanos
 *   2. Sesión reinicia → state machine pierde trades en vuelo
 *   3. Exchange desconectado > 60s → datos stale sin alertas
 *   4. Memory leak silencioso → performance degrada sin detección
 *   5. Múltiples instancias en Railway → estados contradictorios
 *
 * FUNCIONES:
 *   - heartbeat: persiste timestamp cada 30s en MongoDB (si disponible)
 *   - exchangeMonitor: detecta feeds stale y dispara alertas
 *   - memoryMonitor: alerta si heap > umbral configurable
 *   - gracefulShutdown: guarda estado antes de morir (SIGTERM)
 *   - previousUptimeDetection: detecta reinicios y notifica
 */

'use strict';

const os   = require('os');

// ─── State ─────────────────────────────────────────────────────────────────
const _startTs           = Date.now();
let _lastHeartbeatTs   = Date.now();
let _heartbeatInterval = null;
let _exchangeInterval  = null;
let _memoryInterval    = null;
let _isShuttingDown    = false;
let _previousUptime    = null;

// Exchange staleness tracking: exchange → last update timestamp
const _lastExchangeUpdate = {};
const STALE_THRESHOLD_MS  = 60_000;  // 60 seconds

const MEMORY_WARN_MB    = parseInt(process.env.MEMORY_WARN_MB   || '400', 10);
const MEMORY_CRIT_MB    = parseInt(process.env.MEMORY_CRIT_MB   || '512', 10);
const HEARTBEAT_KEY     = 'kukora_watchdog_heartbeat';

// ─── Heartbeat ────────────────────────────────────────────────────────────

async function writeHeartbeat() {
  _lastHeartbeatTs = Date.now();
  const payload = {
    ts:          new Date().toISOString(),
    uptimeMs:    Date.now() - _startTs,
    pid:         process.pid,
    hostname:    os.hostname(),
    memMB:       Math.round(process.memoryUsage().heapUsed / 1_048_576),
    version:     'v17',
  };

  // Try MongoDB persistence
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.collection(HEARTBEAT_KEY).updateOne(
        { _id: 'heartbeat' },
        { $set: payload },
        { upsert: true }
      );
    }
  } catch { /* MongoDB not available — that's ok */ }

  // Emit to observability
  try {
    require('./observabilityService').emit('SYSTEM', 'watchdog.heartbeat', payload, 'debug');
  } catch { /* observabilityService no disponible en startup — ignorar */ }

  return payload;
}

async function readLastHeartbeat() {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1) {
      const doc = await mongoose.connection.db
        .collection(HEARTBEAT_KEY)
        .findOne({ _id: 'heartbeat' });
      return doc;
    }
  } catch { /* MongoDB no disponible — heartbeat solo en memoria */ }
  return null;
}

// ─── Exchange monitoring ──────────────────────────────────────────────────

function recordExchangeUpdate(exchange) {
  _lastExchangeUpdate[exchange] = Date.now();
}

function checkExchangeStaleness() {
  const now = Date.now();
  const alerts = require('./alertWebhookService');

  for (const [exchange, lastUpdate] of Object.entries(_lastExchangeUpdate)) {
    const offlineMs = now - lastUpdate;
    if (offlineMs > STALE_THRESHOLD_MS) {
      const offlineSecs = Math.floor(offlineMs / 1000);
      alerts.alertExchangeOffline(exchange, offlineSecs).catch(() => {});

      try {
        require('./observabilityService').emit('EXCHANGE', 'exchange.stale_feed', {
          exchange, offlineSecs, lastUpdate: new Date(lastUpdate).toISOString(),
        }, 'warn');
      } catch { /* observabilityService no disponible — ignorar emisión de evento */ }
    }
  }
}

// ─── Memory monitoring ────────────────────────────────────────────────────

function checkMemory() {
  const { heapUsed, heapTotal: _heapTotal, rss } = process.memoryUsage();
  const heapMB = Math.round(heapUsed / 1_048_576);
  const rssMB  = Math.round(rss / 1_048_576);

  if (heapMB > MEMORY_CRIT_MB) {
    try {
      require('./observabilityService').emit('SYSTEM', 'watchdog.memory_critical', {
        heapMB, rssMB, limitMB: MEMORY_CRIT_MB,
      }, 'error');
    } catch { /* observabilityService no disponible — memoria crítica no emitida */ }

    // Attempt GC if available (Node --expose-gc)
    if (global.gc) global.gc();
  } else if (heapMB > MEMORY_WARN_MB) {
    try {
      require('./observabilityService').emit('SYSTEM', 'watchdog.memory_warning', {
        heapMB, rssMB, limitMB: MEMORY_WARN_MB,
      }, 'warn');
    } catch { /* observabilityService no disponible — warning de memoria no emitido */ }
  }

  return { heapMB, rssMB };
}

// ─── Graceful shutdown ────────────────────────────────────────────────────

const _shutdownHandlers = [];

function registerShutdownHandler(name, fn) {
  _shutdownHandlers.push({ name, fn });
}

async function gracefulShutdown(signal = 'SIGTERM') {
  if (_isShuttingDown) return;
  _isShuttingDown = true;

  const shutdownStart = Date.now();
  process.stdout.write(`[watchdog] Graceful shutdown initiated (${signal})...\n`);

  // Stop intervals
  if (_heartbeatInterval) clearInterval(_heartbeatInterval);
  if (_exchangeInterval)  clearInterval(_exchangeInterval);
  if (_memoryInterval)    clearInterval(_memoryInterval);

  // Run registered shutdown handlers in order
  for (const { name, fn } of _shutdownHandlers) {
    try {
      process.stdout.write(`[watchdog] Running shutdown handler: ${name}\n`);
      await Promise.race([fn(), new Promise(r => setTimeout(r, 3000))]);
    } catch (e) {
      process.stdout.write(`[watchdog] Shutdown handler ${name} failed: ${e.message}\n`);
    }
  }

  // Final heartbeat with shutdown marker
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.collection(HEARTBEAT_KEY).updateOne(
        { _id: 'heartbeat' },
        { $set: {
          shutdownTs:       new Date().toISOString(),
          shutdownSignal:   signal,
          finalUptimeMs:    Date.now() - _startTs,
          shutdownDurationMs: Date.now() - shutdownStart,
        }},
        { upsert: true }
      );
      await mongoose.connection.close();
    }
  } catch { /* fallo al persistir estado de shutdown o cerrar MongoDB — continuar de todas formas */ }

  process.stdout.write(`[watchdog] Shutdown complete in ${Date.now() - shutdownStart}ms\n`);
  process.exit(0);
}

// ─── Startup recovery detection ───────────────────────────────────────────

async function detectPreviousSession() {
  const last = await readLastHeartbeat();
  if (!last) return null;

  const lastTs     = new Date(last.ts).getTime();
  const gapMs      = Date.now() - lastTs;
  const wasRunning = gapMs < 300_000;  // was alive < 5 min ago

  _previousUptime = last.uptimeMs;

  return {
    previousPid:      last.pid,
    previousUptimeMs: last.uptimeMs,
    lastSeenTs:       last.ts,
    gapMs,
    likelyRestart:    wasRunning,
    reason:           wasRunning ? 'crash_or_deploy' : 'cold_start',
  };
}

// ─── Init ─────────────────────────────────────────────────────────────────

async function init() {
  process.stdout.write('[watchdog] Initializing v17 watchdog...\n');

  // Detect previous session
  const prevSession = await detectPreviousSession();
  if (prevSession?.likelyRestart) {
    process.stdout.write(`[watchdog] Previous session detected — gap: ${prevSession.gapMs}ms, reason: ${prevSession.reason}\n`);
    try {
      const alerts = require('./alertWebhookService');
      await alerts.alertSystemRestart(prevSession.reason, prevSession.previousUptimeMs);
    } catch { /* alertWebhookService no disponible en startup — ignorar alerta de restart */ }
  }

  // Heartbeat every 30s
  _heartbeatInterval = setInterval(() => writeHeartbeat().catch(() => {}), 30_000);
  await writeHeartbeat();

  // Exchange staleness check every 15s
  _exchangeInterval = setInterval(() => checkExchangeStaleness(), 15_000);

  // Memory check every 60s
  _memoryInterval = setInterval(() => checkMemory(), 60_000);

  // Graceful shutdown hooks
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.once('SIGINT',  () => gracefulShutdown('SIGINT'));

  // Uncaught exception → log + attempt graceful shutdown
  process.on('uncaughtException', async (err) => {
    try {
      require('./observabilityService').emit('SYSTEM', 'watchdog.uncaught_exception', {
        message: err.message, stack: err.stack?.slice(0, 500),
      }, 'error');
    } catch { /* observabilityService no disponible — uncaught exception ya en stdout */ }
    process.stdout.write(`[watchdog] UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}\n`);
    await gracefulShutdown('uncaughtException').catch(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    try {
      require('./observabilityService').emit('SYSTEM', 'watchdog.unhandled_rejection', {
        reason: String(reason)?.slice(0, 500),
      }, 'error');
    } catch { /* observabilityService no disponible — unhandledRejection ya en stdout */ }
    process.stdout.write(`[watchdog] UNHANDLED REJECTION: ${reason}\n`);
  });

  process.stdout.write('[watchdog] Initialized. Previous session: ' + (prevSession?.likelyRestart ? prevSession.reason : 'none') + '\n');
  return prevSession;
}

// ─── Status ───────────────────────────────────────────────────────────────

function getStatus() {
  const { heapUsed, heapTotal, rss, external } = process.memoryUsage();
  const staleExchanges = Object.entries(_lastExchangeUpdate)
    .filter(([, ts]) => Date.now() - ts > STALE_THRESHOLD_MS)
    .map(([ex, ts]) => ({ exchange: ex, offlineSecs: Math.floor((Date.now() - ts) / 1000) }));

  return {
    uptimeMs:        Date.now() - _startTs,
    uptimeHuman:     formatUptime(Date.now() - _startTs),
    pid:             process.pid,
    hostname:        os.hostname(),
    memory: {
      heapMB:  Math.round(heapUsed   / 1_048_576),
      totalMB: Math.round(heapTotal  / 1_048_576),
      rssMB:   Math.round(rss        / 1_048_576),
      externalMB: Math.round(external / 1_048_576),
      warnThresholdMB: MEMORY_WARN_MB,
      critThresholdMB: MEMORY_CRIT_MB,
    },
    exchanges: {
      tracked:       Object.keys(_lastExchangeUpdate),
      stale:         staleExchanges,
      healthy:       staleExchanges.length === 0,
    },
    lastHeartbeatTs: new Date(_lastHeartbeatTs).toISOString(),
    isShuttingDown:  _isShuttingDown,
    previousUptime:  _previousUptime,
    nodeVersion:     process.version,
    version:         'kukora-v17',
  };
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0)  return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0)  return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0)  return `${m}m ${s % 60}s`;
  return `${s}s`;
}

module.exports = {
  init,
  getStatus,
  writeHeartbeat,
  recordExchangeUpdate,
  registerShutdownHandler,
  gracefulShutdown,
  detectPreviousSession,
};

/**
 * backgroundJobs.js — Kukora Background Job Framework
 *
 * Kukora already runs several periodic/scheduled tasks (auto-rebalance
 * loop, daily report, persistence flush) each with its own bespoke
 * setInterval and no shared visibility. This module is the formalization
 * layer a real ops team asks for: one place to register a job, see its
 * status, and know immediately which job is late, failing, or hung —
 * without pulling in a distributed queue (Bull/BullMQ + Redis, Kafka,
 * RabbitMQ) that this single-process deployment does not need yet. If/when
 * Kukora runs more than one instance, THIS is the seam where a Redis-backed
 * distributed lock or queue slots in — the registration API below doesn't
 * change, only the internals of `_schedule()`.
 *
 * A job is:
 *   { name, handler, intervalMs, retries, timeoutMs, runOnStart }
 *
 * Guarantees:
 *   - No two runs of the same job overlap (a slow run simply delays the
 *     next scheduled tick rather than piling up concurrent executions).
 *   - A handler that throws/rejects is retried up to `retries` times with
 *     linear backoff before being marked failed for that cycle; the next
 *     scheduled tick still happens normally afterward — one bad cycle
 *     doesn't kill the job forever.
 *   - A handler that exceeds `timeoutMs` is marked as timed out (the
 *     underlying promise is not force-killed — Node can't do that safely —
 *     but the job is reported unhealthy so an operator can investigate).
 *   - Every lifecycle transition emits an observability event (category
 *     SYSTEM) so it shows up in the existing dashboard/event stream.
 */

'use strict';

const obs = require('./observabilityService');

/** @type {Map<string, JobRecord>} */
const _jobs = new Map();

/**
 * @typedef {Object} JobRecord
 * @property {string} name
 * @property {Function} handler
 * @property {number} intervalMs
 * @property {number} retries
 * @property {number} timeoutMs
 * @property {NodeJS.Timeout|null} timer
 * @property {boolean} isRunning
 * @property {string} status        'idle'|'running'|'success'|'failed'|'timeout'
 * @property {string|null} lastError
 * @property {number|null} lastRunAt
 * @property {number|null} lastDurationMs
 * @property {number|null} nextRunAt
 * @property {number} runCount
 * @property {number} failureCount
 */

function _withTimeout(promise, ms, name) {
  if (!ms) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`job "${name}" exceeded timeoutMs=${ms}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function _runOnce(job) {
  if (job.isRunning) return; // never overlap — this tick is skipped, next timer fires normally
  job.isRunning = true;
  job.status = 'running';
  const start = Date.now();

  let attempt = 0;
  let lastErr = null;
  while (attempt <= job.retries) {
    try {
      await _withTimeout(Promise.resolve().then(() => job.handler()), job.timeoutMs, job.name);
      job.status = 'success';
      job.lastError = null;
      job.failureStreak = 0;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (attempt <= job.retries) {
        await new Promise((r) => setTimeout(r, 250 * attempt)); // linear backoff between retries
      }
    }
  }

  if (lastErr) {
    job.status = /timeoutMs/.test(lastErr.message) ? 'timeout' : 'failed';
    job.lastError = lastErr.message;
    job.failureCount += 1;
    job.failureStreak = (job.failureStreak || 0) + 1;
    obs.emit('SYSTEM', 'job.failed', {
      job: job.name, attempts: attempt, error: lastErr.message, failureStreak: job.failureStreak,
    }, 'error');
  } else {
    obs.emit('SYSTEM', 'job.succeeded', { job: job.name, durationMs: Date.now() - start }, 'debug');
  }

  job.lastRunAt = start;
  job.lastDurationMs = Date.now() - start;
  job.runCount += 1;
  job.isRunning = false;
  job.nextRunAt = job.intervalMs ? Date.now() + job.intervalMs : null;
}

/**
 * Register and start a recurring background job.
 *
 * @param {string} name
 * @param {() => Promise<void>|void} handler
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=60000]  time between the end of one run and the start of the next
 * @param {number} [opts.retries=0]          retry attempts within a single cycle before marking it failed
 * @param {number} [opts.timeoutMs=0]        0 = no timeout
 * @param {boolean} [opts.runOnStart=false]  fire immediately instead of waiting one full interval
 * @param {string} [opts.runAt]              'HH:mm' (UTC) — run once daily at this time instead of
 *                                            a fixed interval. Mutually exclusive with intervalMs
 *                                            (used only to compute msUntil the next occurrence, then
 *                                            rescheduled 24h out after every run — same pattern
 *                                            dailyReportService used standalone before this framework
 *                                            existed, now with unified status/retry/timeout handling).
 */
function _msUntilNextRunAt(runAt) {
  const [hh, mm] = runAt.split(':').map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hh, mm, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

function registerJob(name, handler, opts = {}) {
  if (_jobs.has(name)) {
    throw new Error(`backgroundJobs: a job named "${name}" is already registered`);
  }
  if (typeof handler !== 'function') {
    throw new Error(`backgroundJobs: handler for "${name}" must be a function`);
  }
  if (opts.runAt && !/^\d{2}:\d{2}$/.test(opts.runAt)) {
    throw new Error(`backgroundJobs: runAt for "${name}" must be 'HH:mm' (UTC), got "${opts.runAt}"`);
  }

  const job = {
    name, handler,
    mode: opts.runAt ? 'daily' : 'interval',
    runAt: opts.runAt || null,
    intervalMs: opts.intervalMs ?? 60_000,
    retries: opts.retries ?? 0,
    timeoutMs: opts.timeoutMs ?? 0,
    timer: null,
    isRunning: false,
    status: 'idle',
    lastError: null,
    failureStreak: 0,
    lastRunAt: null,
    lastDurationMs: null,
    nextRunAt: null,
    runCount: 0,
    failureCount: 0,
  };
  _jobs.set(name, job);

  if (job.mode === 'daily') {
    const _scheduleNext = () => {
      const msUntil = _msUntilNextRunAt(job.runAt);
      job.nextRunAt = Date.now() + msUntil;
      job.timer = setTimeout(async () => {
        await _runOnce(job);
        _scheduleNext(); // reschedule for the same time tomorrow, regardless of success/failure
      }, msUntil);
      if (job.timer.unref) job.timer.unref();
    };
    _scheduleNext();
  } else {
    const tick = () => { _runOnce(job); };
    job.timer = setInterval(tick, job.intervalMs);
    job.nextRunAt = Date.now() + job.intervalMs;
  }

  if (opts.runOnStart) _runOnce(job);

  obs.emit('SYSTEM', 'job.registered', { job: name, mode: job.mode, intervalMs: job.intervalMs, runAt: job.runAt, retries: job.retries }, 'info');
  return job;
}

/** Trigger a job immediately, outside its normal schedule (e.g. an ops "run now" button). Still respects the no-overlap guarantee. */
async function runNow(name) {
  const job = _jobs.get(name);
  if (!job) throw new Error(`backgroundJobs: no job registered as "${name}"`);
  if (job.isRunning) return { triggered: false, reason: 'already_running' };
  await _runOnce(job);
  return { triggered: true, status: job.status };
}

function unregisterJob(name) {
  const job = _jobs.get(name);
  if (!job) return false;
  clearInterval(job.timer);
  clearTimeout(job.timer); // daily-mode jobs use setTimeout — both clears are safe no-ops on the other handle type
  _jobs.delete(name);
  return true;
}

/** Status snapshot for every registered job — the payload the ops dashboard reads. */
function getStatus() {
  return [..._jobs.values()].map(({ timer, handler, ...rest }) => rest);
}

function getJobStatus(name) {
  const job = _jobs.get(name);
  if (!job) return null;
  const { timer, handler, ...rest } = job;
  return rest;
}

/** Overall health: 'healthy' unless any job is currently failing/timing out beyond one retry cycle. */
function getHealthSummary() {
  const jobs = getStatus();
  const unhealthy = jobs.filter((j) => j.status === 'failed' || j.status === 'timeout');
  return {
    total: jobs.length,
    healthy: jobs.length - unhealthy.length,
    unhealthy: unhealthy.map((j) => ({ name: j.name, status: j.status, lastError: j.lastError, failureStreak: j.failureStreak })),
    overall: unhealthy.length === 0 ? 'healthy' : 'degraded',
  };
}

/** Stops all jobs — used on graceful shutdown, mirrors stopEngine()/stopAutoRebalanceLoop() elsewhere. */
function stopAll() {
  for (const job of _jobs.values()) { clearInterval(job.timer); clearTimeout(job.timer); }
}

/** Test-only: clears the registry entirely. */
function _resetForTests() {
  stopAll();
  _jobs.clear();
}

module.exports = {
  registerJob,
  unregisterJob,
  runNow,
  getStatus,
  getJobStatus,
  getHealthSummary,
  stopAll,
  _resetForTests,
};

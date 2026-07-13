import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import backgroundJobs from '../server/infrastructure/backgroundJobs.js';

const { registerJob, runNow, getStatus, getJobStatus, getHealthSummary, unregisterJob, _resetForTests } = backgroundJobs;

describe('backgroundJobs', () => {
  beforeEach(() => _resetForTests());
  afterEach(() => _resetForTests());

  it('registers a job and exposes its status', () => {
    registerJob('test.noop', () => {}, { intervalMs: 100_000 });
    const status = getJobStatus('test.noop');
    expect(status.name).toBe('test.noop');
    expect(status.status).toBe('idle');
    expect(status.runCount).toBe(0);
  });

  it('refuses to register two jobs with the same name', () => {
    registerJob('dup', () => {});
    expect(() => registerJob('dup', () => {})).toThrow(/already registered/);
  });

  it('refuses a non-function handler', () => {
    expect(() => registerJob('bad', 'not a function')).toThrow(/must be a function/);
  });

  it('runNow executes the handler immediately and records success', async () => {
    let called = false;
    registerJob('test.run', () => { called = true; }, { intervalMs: 100_000 });
    await runNow('test.run');
    expect(called).toBe(true);
    const status = getJobStatus('test.run');
    expect(status.status).toBe('success');
    expect(status.runCount).toBe(1);
  });

  it('runNow on an unknown job throws', async () => {
    await expect(runNow('does-not-exist')).rejects.toThrow(/no job registered/);
  });

  it('retries a failing handler up to the configured retry count, then marks it failed', async () => {
    let attempts = 0;
    registerJob('test.fail', () => { attempts += 1; throw new Error('boom'); }, { intervalMs: 100_000, retries: 2 });
    await runNow('test.fail');
    expect(attempts).toBe(3); // initial + 2 retries
    const status = getJobStatus('test.fail');
    expect(status.status).toBe('failed');
    expect(status.lastError).toBe('boom');
    expect(status.failureCount).toBe(1);
  });

  it('a handler that recovers within its retry budget is marked success, not failed', async () => {
    let attempts = 0;
    registerJob('test.recover', () => {
      attempts += 1;
      if (attempts < 2) throw new Error('transient');
    }, { intervalMs: 100_000, retries: 3 });
    await runNow('test.recover');
    expect(getJobStatus('test.recover').status).toBe('success');
  });

  it('a handler exceeding timeoutMs is marked as timeout', async () => {
    registerJob('test.slow', () => new Promise((r) => setTimeout(r, 500)), { intervalMs: 100_000, timeoutMs: 20 });
    await runNow('test.slow');
    expect(getJobStatus('test.slow').status).toBe('timeout');
  });

  it('never overlaps: calling runNow while already running is a no-op that reports why', async () => {
    registerJob('test.overlap', () => new Promise((r) => setTimeout(r, 100)), { intervalMs: 100_000 });
    const first = runNow('test.overlap');
    const second = await runNow('test.overlap');
    expect(second).toEqual({ triggered: false, reason: 'already_running' });
    await first;
  });

  it('getStatus lists all registered jobs without leaking internal timer/handler references', () => {
    registerJob('test.list.a', () => {});
    registerJob('test.list.b', () => {});
    const all = getStatus();
    expect(all.map((j) => j.name).sort()).toEqual(['test.list.a', 'test.list.b']);
    expect(all[0].timer).toBeUndefined();
    expect(all[0].handler).toBeUndefined();
  });

  it('getHealthSummary reports degraded when a job is failing', async () => {
    registerJob('test.health', () => { throw new Error('bad'); }, { intervalMs: 100_000 });
    await runNow('test.health');
    const health = getHealthSummary();
    expect(health.overall).toBe('degraded');
    expect(health.unhealthy[0].name).toBe('test.health');
  });

  it('getHealthSummary reports healthy when nothing has failed', () => {
    registerJob('test.ok', () => {});
    expect(getHealthSummary().overall).toBe('healthy');
  });

  it('unregisterJob removes the job and stops its timer', () => {
    registerJob('test.remove', () => {});
    expect(unregisterJob('test.remove')).toBe(true);
    expect(getJobStatus('test.remove')).toBeNull();
    expect(unregisterJob('test.remove')).toBe(false);
  });

  describe('daily (runAt) scheduling mode', () => {
    it('registers a daily job with mode "daily" and a nextRunAt within 24h', () => {
      registerJob('test.daily', () => {}, { runAt: '00:00' });
      const status = getJobStatus('test.daily');
      expect(status.mode).toBe('daily');
      expect(status.runAt).toBe('00:00');
      expect(status.nextRunAt).toBeGreaterThan(Date.now());
      expect(status.nextRunAt).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000 + 1000);
    });

    it('rejects a malformed runAt value', () => {
      expect(() => registerJob('test.bad-runat', () => {}, { runAt: 'not-a-time' }))
        .toThrow(/must be 'HH:mm'/);
    });

    it('runOnStart fires a daily job immediately in addition to scheduling the next occurrence', async () => {
      let called = false;
      registerJob('test.daily.runOnStart', () => { called = true; }, { runAt: '00:00', runOnStart: true });
      // runOnStart triggers _runOnce synchronously-ish (fire and forget) — give it a tick.
      await new Promise((r) => setTimeout(r, 10));
      expect(called).toBe(true);
    });

    it('defaults to interval mode when runAt is not provided', () => {
      registerJob('test.interval-default', () => {}, { intervalMs: 5000 });
      expect(getJobStatus('test.interval-default').mode).toBe('interval');
    });
  });
});

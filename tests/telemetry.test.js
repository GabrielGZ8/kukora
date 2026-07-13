import { describe, it, expect } from 'vitest';
import { withSpan, isEnabled, currentTraceId, annotate, init } from '../server/infrastructure/telemetry.js';

describe('telemetry', () => {
  it('is disabled by default (zero-cost path) unless OTEL_ENABLED=true', () => {
    expect(isEnabled()).toBe(false);
  });

  it('init() is idempotent and safe to call multiple times', () => {
    expect(() => { init(); init(); init(); }).not.toThrow();
  });

  it('withSpan runs a synchronous function and returns its result', () => {
    const result = withSpan('test.sync', () => 42);
    expect(result).toBe(42);
  });

  it('withSpan runs an async function and resolves with its result', async () => {
    const result = await withSpan('test.async', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return 'done';
    });
    expect(result).toBe('done');
  });

  it('withSpan re-throws synchronous errors without swallowing them', () => {
    expect(() => withSpan('test.throw', () => { throw new Error('boom'); })).toThrow('boom');
  });

  it('withSpan re-rejects async errors without swallowing them', async () => {
    await expect(
      withSpan('test.reject', async () => { throw new Error('async boom'); })
    ).rejects.toThrow('async boom');
  });

  it('annotate() is a no-op that never throws when there is no active span', () => {
    expect(() => annotate({ foo: 'bar' })).not.toThrow();
  });

  it('currentTraceId() returns null when telemetry is disabled / no active span', () => {
    expect(currentTraceId()).toBeNull();
  });
});

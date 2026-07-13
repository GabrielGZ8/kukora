import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStaleTracker } from '../src/hooks/useStaleAfter.js';

// This exercises the exact timing core behind ArbitragePage's "conexión
// perdida / datos congelados" banner. Before this fix, a dropped SSE
// connection was surfaced only by a 5px dot changing color while the UI
// kept showing frozen, delta-merged data with no explicit warning.

describe('createStaleTracker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does not fire while connected', () => {
    const onChange = vi.fn();
    const tracker = createStaleTracker(3000, onChange);
    tracker.setConnected(true);
    vi.advanceTimersByTime(10000);
    expect(onChange).toHaveBeenCalledWith(false);
    expect(onChange).not.toHaveBeenCalledWith(true);
  });

  it('stays quiet during a brief disconnect shorter than the delay', () => {
    const onChange = vi.fn();
    const tracker = createStaleTracker(3000, onChange);
    tracker.setConnected(false);
    vi.advanceTimersByTime(2000);
    expect(onChange).not.toHaveBeenCalledWith(true);
  });

  it('BUG THIS PREVENTS: fires stale=true once disconnected past the delay', () => {
    const onChange = vi.fn();
    const tracker = createStaleTracker(3000, onChange);
    tracker.setConnected(false);
    vi.advanceTimersByTime(3001);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('resets to false immediately on reconnect, even after having gone stale', () => {
    const onChange = vi.fn();
    const tracker = createStaleTracker(3000, onChange);
    tracker.setConnected(false);
    vi.advanceTimersByTime(3001);
    expect(onChange).toHaveBeenLastCalledWith(true);

    tracker.setConnected(true);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('a reconnect before the delay elapses cancels the pending stale callback', () => {
    const onChange = vi.fn();
    const tracker = createStaleTracker(3000, onChange);
    tracker.setConnected(false);
    vi.advanceTimersByTime(1000);
    tracker.setConnected(true); // reconnected before the 3000ms delay
    vi.advanceTimersByTime(5000); // even if we wait well past the original delay...
    expect(onChange).not.toHaveBeenCalledWith(true); // ...stale must never fire
  });

  it('teardown cancels any pending timer (no callback after unmount)', () => {
    const onChange = vi.fn();
    const tracker = createStaleTracker(3000, onChange);
    tracker.setConnected(false);
    tracker.teardown();
    vi.advanceTimersByTime(5000);
    expect(onChange).not.toHaveBeenCalledWith(true);
  });
});

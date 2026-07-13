import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Fresh module graph per test file in vitest, so requiring these here gives
// us the same singleton instances that watchdog.js's internal require()
// calls will resolve to.
const watchdog = require('../server/infrastructure/watchdog.js');
const alertWebhookService = require('../server/infrastructure/alertWebhookService');
const observabilityService = require('../server/infrastructure/observabilityService');

/**
 * watchdog.js registers its periodic checks (exchange staleness, memory,
 * heartbeat) via setInterval inside init(), and its crash handlers via
 * process.on/once. Rather than waiting on real timers or firing real
 * process signals, we intercept setInterval/process.on to capture the
 * callbacks, then invoke them directly — this exercises the same code
 * paths deterministically and without leaking real timers/handlers.
 */
describe('watchdog internals (init-time wiring)', () => {
  let intervalCallbacks;
  let processOnceHandlers;
  let processOnHandlers;
  let setIntervalSpy;
  let onceSpy;
  let onSpy;
  let stdoutSpy;
  let exitSpy;

  beforeEach(() => {
    intervalCallbacks = [];
    processOnceHandlers = {};
    processOnHandlers = {};

    setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation((fn) => {
      intervalCallbacks.push(fn);
      return intervalCallbacks.length; // fake timer handle
    });
    // clearInterval is called during gracefulShutdown — make it a no-op safe stub
    vi.spyOn(global, 'clearInterval').mockImplementation(() => {});

    onceSpy = vi.spyOn(process, 'once').mockImplementation((event, fn) => {
      processOnceHandlers[event] = fn;
      return process;
    });
    onSpy = vi.spyOn(process, 'on').mockImplementation((event, fn) => {
      processOnHandlers[event] = fn;
      return process;
    });

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    global.clearInterval.mockRestore?.();
    onceSpy.mockRestore();
    onSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('init() registers three intervals (heartbeat, exchange, memory) and signal/exception handlers', async () => {
    await watchdog.init();

    expect(setIntervalSpy).toHaveBeenCalledTimes(3);
    expect(processOnceHandlers.SIGTERM).toBeTypeOf('function');
    expect(processOnceHandlers.SIGINT).toBeTypeOf('function');
    expect(processOnHandlers.uncaughtException).toBeTypeOf('function');
    expect(processOnHandlers.unhandledRejection).toBeTypeOf('function');
  });

  it('the exchange-staleness interval callback alerts and emits for stale exchanges', async () => {
    const alertSpy = vi.spyOn(alertWebhookService, 'alertExchangeOffline').mockResolvedValue(undefined);
    const emitSpy = vi.spyOn(observabilityService, 'emit');

    watchdog.recordExchangeUpdate('Bybit');
    await watchdog.init();

    // intervalCallbacks[1] is the exchange staleness checker (registered
    // second, after the heartbeat interval, in watchdog.js's init()).
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockReturnValue(realNow() + 61_000);
    intervalCallbacks[1]();
    Date.now.mockRestore();

    expect(alertSpy).toHaveBeenCalledWith('Bybit', expect.any(Number));
    expect(emitSpy).toHaveBeenCalledWith('EXCHANGE', 'exchange.stale_feed', expect.objectContaining({ exchange: 'Bybit' }), 'warn');
  });

  it('the exchange-staleness interval callback does nothing for fresh exchanges', async () => {
    const alertSpy = vi.spyOn(alertWebhookService, 'alertExchangeOffline').mockResolvedValue(undefined);
    watchdog.recordExchangeUpdate('Coinbase');
    await watchdog.init();

    intervalCallbacks[1]();
    expect(alertSpy).not.toHaveBeenCalledWith('Coinbase', expect.any(Number));
  });

  it('the memory interval callback emits a warning when heap exceeds the warn threshold', async () => {
    const emitSpy = vi.spyOn(observabilityService, 'emit');
    await watchdog.init();

    const memSpy = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      heapUsed: 450 * 1_048_576, // > 400MB warn threshold, < 512MB crit
      heapTotal: 600 * 1_048_576,
      rss: 500 * 1_048_576,
      external: 10 * 1_048_576,
    });

    intervalCallbacks[2]();

    expect(emitSpy).toHaveBeenCalledWith('SYSTEM', 'watchdog.memory_warning', expect.objectContaining({ heapMB: 450 }), 'warn');
    memSpy.mockRestore();
  });

  it('the memory interval callback emits critical and attempts GC when heap exceeds the crit threshold', async () => {
    const emitSpy = vi.spyOn(observabilityService, 'emit');
    await watchdog.init();

    const memSpy = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      heapUsed: 600 * 1_048_576, // > 512MB crit threshold
      heapTotal: 700 * 1_048_576,
      rss: 650 * 1_048_576,
      external: 10 * 1_048_576,
    });

    const originalGc = global.gc;
    global.gc = vi.fn();

    intervalCallbacks[2]();

    expect(emitSpy).toHaveBeenCalledWith('SYSTEM', 'watchdog.memory_critical', expect.objectContaining({ heapMB: 600 }), 'error');
    expect(global.gc).toHaveBeenCalled();

    global.gc = originalGc;
    memSpy.mockRestore();
  });

  it('the memory interval callback stays silent below the warn threshold', async () => {
    const emitSpy = vi.spyOn(observabilityService, 'emit');
    await watchdog.init();

    const memSpy = vi.spyOn(process, 'memoryUsage').mockReturnValue({
      heapUsed: 50 * 1_048_576,
      heapTotal: 200 * 1_048_576,
      rss: 100 * 1_048_576,
      external: 5 * 1_048_576,
    });

    emitSpy.mockClear();
    intervalCallbacks[2]();
    expect(emitSpy).not.toHaveBeenCalledWith('SYSTEM', 'watchdog.memory_warning', expect.anything(), 'warn');
    expect(emitSpy).not.toHaveBeenCalledWith('SYSTEM', 'watchdog.memory_critical', expect.anything(), 'error');
    memSpy.mockRestore();
  });

  it('the uncaughtException handler emits an event, logs, and attempts graceful shutdown', async () => {
    const emitSpy = vi.spyOn(observabilityService, 'emit');
    await watchdog.init();

    await processOnHandlers.uncaughtException(new Error('kaboom'));

    expect(emitSpy).toHaveBeenCalledWith('SYSTEM', 'watchdog.uncaught_exception', expect.objectContaining({ message: 'kaboom' }), 'error');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('the unhandledRejection handler emits an event without throwing', async () => {
    const emitSpy = vi.spyOn(observabilityService, 'emit');
    await watchdog.init();

    expect(() => processOnHandlers.unhandledRejection('some rejection reason')).not.toThrow();
    expect(emitSpy).toHaveBeenCalledWith('SYSTEM', 'watchdog.unhandled_rejection', expect.objectContaining({ reason: expect.stringContaining('some rejection reason') }), 'error');
  });

  it('init() does not alert when there is no previous session (cold start, disconnected DB)', async () => {
    const restartAlertSpy = vi.spyOn(alertWebhookService, 'alertSystemRestart').mockResolvedValue(undefined);

    const prevSession = await watchdog.init();

    expect(prevSession).toBeNull();
    expect(restartAlertSpy).not.toHaveBeenCalled();
  });
});

describe('watchdog getStatus formatUptime branches', () => {
  it('formats seconds-only uptime', () => {
    const status = watchdog.getStatus();
    // uptime since process/module start is small in the test run — expect a short format
    expect(status.uptimeHuman).toMatch(/^\d+(s|m \d+s|h \d+m \d+s|d \d+h \d+m)$/);
  });
});

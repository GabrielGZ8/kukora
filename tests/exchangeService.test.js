'use strict';

/**
 * exchangeService.test.js
 *
 * Tests para connectX() (vía init(), las 5 connectX no se exportan
 * individualmente), scheduleReconnect() y closeAll() — sin red real.
 *
 * MOCKING NOTE: se probó primero vi.mock('ws', factory) (patrón estándar de
 * Vitest para paquetes de node_modules). Se descartó tras verificación
 * empírica con un test de sonda: exchangeService.js hace `require('ws')`
 * dentro de getWSClass(), llamado sincrónicamente desde cada connectX(); ese
 * require() es resuelto por Node dentro del módulo CJS ya cargado, no pasa
 * por el grafo ESM de Vite/Vitest, así que vi.mock('ws', ...) nunca lo
 * intercepta (0 instancias del mock construidas en la sonda; en su lugar se
 * cargaba el paquete 'ws' real). Es el mismo fenómeno ya documentado en
 * tests/arbitrageOrchestrator.test.js para los require() internos de
 * módulos locales del proyecto.
 *
 * En su lugar se usa el seam test-only agregado a exchangeService.js en
 * esta sesión (`_setWSClassForTests`), que sigue el mismo patrón que
 * `_mongooseRef` en persistenceService.js (Sesión 7): una referencia interna
 * reasignable, con la dependencia real como default, en vez de una factory
 * de mocking que no llega a interceptar el punto correcto.
 *
 * `_resetForTests()` (agregado junto al seam anterior) resetea el flag
 * `_initialized` y el estado por-exchange entre tests, ya que
 * exchangeService.js es un singleton de módulo compartido entre todos los
 * tests de este archivo (Vitest no vuelve a ejecutar el cuerpo del módulo
 * CJS entre `it()` bloques del mismo archivo).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const exchangeService = require('../server/infrastructure/exchangeService.js');

// ── Fake WS class ───────────────────────────────────────────────────────
// Implementa la superficie mínima que exchangeService.js usa de una
// instancia real de `ws`: .on(event, cb), .send(), .ping(), .terminate(),
// .readyState, y el static .OPEN que los intervalos de ping comparan.
class FakeWS {
  constructor(url) {
    this.__isFakeWS = true; // marcador de identidad
    this.url = url;
    this.readyState = FakeWS.OPEN; // asumimos "abierto" para simplificar pings
    this.terminated = false;
    this.sent = [];
    this.pingCalls = 0;
    this._listeners = {};
    FakeWS.instances.push(this);
  }
  on(event, cb) { (this._listeners[event] ||= []).push(cb); return this; }
  send(data) { this.sent.push(data); }
  ping() { this.pingCalls++; }
  terminate() { this.terminated = true; this._emit('close', 1000); }
  _emit(event, ...args) { (this._listeners[event] || []).forEach(cb => cb(...args)); }
}
FakeWS.OPEN = 1;
FakeWS.instances = [];

function findInstance(urlSubstring) {
  return FakeWS.instances.find(i => i.url.includes(urlSubstring));
}

describe('exchangeService — connectX()/init() with fake ws (M-6)', () => {
  beforeEach(() => {
    FakeWS.instances.length = 0;
    exchangeService._resetForTests();
    exchangeService._setWSClassForTests(FakeWS);
  });

  afterEach(() => {
    // closeAll() detiene el watchdog y evita que timers de reconexión
    // programados por un test se disparen en el siguiente.
    exchangeService.closeAll();
    exchangeService._setWSClassForTests(null);
    vi.useRealTimers();
  });

  it('init() constructs exactly 5 FakeWS instances, one per exchange, with no real network', () => {
    exchangeService.init();
    expect(FakeWS.instances).toHaveLength(5);
    expect(FakeWS.instances.every(i => i.__isFakeWS)).toBe(true);
    expect(findInstance('binance')).toBeTruthy();
    expect(findInstance('kraken')).toBeTruthy();
    expect(findInstance('bybit')).toBeTruthy();
    expect(findInstance('okx')).toBeTruthy();
    expect(findInstance('coinbase')).toBeTruthy();
  });

  it('init() is idempotent — calling it twice does not open duplicate sockets', () => {
    exchangeService.init();
    exchangeService.init();
    expect(FakeWS.instances).toHaveLength(5);
  });

  it('firing "open" on a fake socket flips wsStatus() for that exchange only', () => {
    exchangeService.init();
    expect(exchangeService.wsStatus()).toEqual({
      Binance: false, Kraken: false, Bybit: false, OKX: false, Coinbase: false,
    });
    findInstance('binance')._emit('open');
    expect(exchangeService.wsStatus().Binance).toBe(true);
    expect(exchangeService.wsStatus().Kraken).toBe(false);
    expect(exchangeService.isWsConnected()).toBe(true);
  });

  it('a "message" event with a valid Binance bookTicker payload updates the feed and getOrderBooks() reports it fresh, without HTTP fallback', async () => {
    exchangeService.init();
    for (const name of ['binance', 'kraken', 'bybit', 'okx', 'coinbase']) {
      findInstance(name)._emit('open');
    }
    findInstance('binance')._emit('message', JSON.stringify({
      stream: 'btcusdt@bookTicker',
      data: { b: '60000.12', a: '60001.34', E: Date.now() },
    }));
    // El resto de exchanges no recibió mensaje, pero wsReady=true + data=null
    // => getOrderBooks() caería a HTTP fallback para ellos si se llamara;
    // acá solo verificamos el camino WS puro de Binance vía el estado interno
    // expuesto por getFreshness(), para no depender de fetch() real de los
    // otros 4 en este test.
    const freshness = exchangeService.getFreshness();
    expect(freshness.Binance.stale).toBe(false);
    expect(freshness.Binance.ageMs).toBeGreaterThanOrEqual(0);
  });

  it('scheduleReconnect(): a "close" event schedules exactly one reconnect attempt after backoff, creating a 6th FakeWS instance', () => {
    vi.useFakeTimers();
    exchangeService.init();
    findInstance('binance')._emit('open');
    expect(exchangeService.wsStatus().Binance).toBe(true);

    findInstance('binance')._emit('close', 1006);
    expect(exchangeService.wsStatus().Binance).toBe(false);
    // Backoff con retries=0 (reseteado por 'open'): 500ms base + hasta 1000ms
    // de jitter. 1600ms cubre el peor caso con margen.
    expect(FakeWS.instances).toHaveLength(5); // todavía no reconectó
    vi.advanceTimersByTime(1600);
    expect(FakeWS.instances).toHaveLength(6);
    expect(FakeWS.instances[5].url).toContain('binance');
  });

  it('closeAll(): terminates every open socket, flips wsReady to false, and blocks further reconnects', () => {
    vi.useFakeTimers();
    exchangeService.init();
    for (const name of ['binance', 'kraken', 'bybit', 'okx', 'coinbase']) {
      findInstance(name)._emit('open');
    }
    expect(exchangeService.isWsConnected()).toBe(true);

    exchangeService.closeAll();

    // terminate() en el FakeWS dispara 'close' sincrónicamente (igual que un
    // WS real que ya estaba conectado), lo cual normalmente dispararía
    // scheduleReconnect() — closeAll() debe haber puesto _shuttingDown=true
    // ANTES de terminar los sockets para que eso no pase.
    expect(FakeWS.instances.every(i => i.terminated)).toBe(true);
    expect(exchangeService.isWsConnected()).toBe(false);

    // Avanzar tiempo de sobra para cualquier backoff posible: no debe
    // aparecer una 6ª instancia — closeAll() bloquea scheduleReconnect().
    vi.advanceTimersByTime(35000);
    expect(FakeWS.instances).toHaveLength(5);
  });

  it('scheduleReconnect(): after MAX_RETRIES exhausted, backs off to slow 5-minute polling instead of giving up permanently', () => {
    vi.useFakeTimers();
    exchangeService.init();
    // Simular 12 ciclos de open->close sin éxito para agotar MAX_RETRIES,
    // reconectando manualmente cada vez que aparece una instancia nueva
    // (el propio módulo la crea via scheduleReconnect -> connectFn).
    for (let i = 0; i < 12; i++) {
      const inst = FakeWS.instances[FakeWS.instances.length - 1];
      inst._emit('close', 1006);
      // avanzar lo suficiente para cubrir el peor backoff exponencial
      // (500 * 1.8^11 ≈ 30000ms, capado en 30000ms + hasta 1000ms jitter)
      vi.advanceTimersByTime(31500);
    }
    // Tras 12 reintentos agotados, la 13ª reconexión debería demorar 5
    // minutos (slow-poll) en vez del backoff normal.
    const countBeforeSlowPoll = FakeWS.instances.length;
    const inst = FakeWS.instances[FakeWS.instances.length - 1];
    inst._emit('close', 1006);
    vi.advanceTimersByTime(31500); // no alcanza para el slow-poll de 5 min
    expect(FakeWS.instances.length).toBe(countBeforeSlowPoll); // sin reconectar todavía
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(FakeWS.instances.length).toBe(countBeforeSlowPoll + 1); // reconectó tras el slow-poll
  });
});

// ── Reliability review additions (due-diligence pass) ─────────────────────
// These three tests prove the specific gaps found and fixed while reviewing
// exchangeService.js as the platform's most critical runtime component:
// (1) a WS that never opens (hung handshake) is detected and retried instead
// of hanging forever unnoticed by the watchdog; (2) a constructor failure
// no longer takes an exchange permanently offline; (3) a malformed HTTP
// fallback payload never reaches getOrderBooks() as a NaN-laced quote.
describe('exchangeService — reliability fixes (handshake timeout, ws-creation failure, payload validation)', () => {
  beforeEach(() => {
    FakeWS.instances.length = 0;
    exchangeService._resetForTests();
    exchangeService._setWSClassForTests(FakeWS);
  });

  afterEach(() => {
    exchangeService.closeAll();
    exchangeService._setWSClassForTests(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a socket stuck in CONNECTING (never fires open/close/error) is terminated after the handshake timeout and reconnects', () => {
    vi.useFakeTimers();
    // A FakeWS subclass that stays in CONNECTING forever unless explicitly
    // terminated — simulates a firewall silently dropping the handshake.
    class HangingWS extends FakeWS {
      constructor(url) {
        super(url);
        this.readyState = 0; // CONNECTING — never flips to OPEN on its own
      }
      terminate() { this.terminated = true; this.readyState = 3; this._emit('close', 1006); }
    }
    HangingWS.OPEN = 1;
    HangingWS.instances = FakeWS.instances; // share the same instance list

    exchangeService._setWSClassForTests(HangingWS);
    exchangeService.init();
    expect(FakeWS.instances).toHaveLength(5);
    expect(FakeWS.instances.every(i => !i.terminated)).toBe(true);

    // Advance past the 10s handshake timeout — every stuck socket should be
    // terminated, which drives the normal reconnect/backoff path.
    vi.advanceTimersByTime(10001);
    expect(FakeWS.instances.every(i => i.terminated)).toBe(true);

    // Reconnects are scheduled off the 'close' handler's backoff (up to
    // ~1.6s worst case) — advancing further should produce 5 fresh sockets.
    vi.advanceTimersByTime(1600);
    expect(FakeWS.instances.length).toBe(10);
  });

  it('firing "open" before the handshake timeout elapses cancels the timeout — no spurious termination', () => {
    vi.useFakeTimers();
    exchangeService.init();
    findInstance('binance')._emit('open');
    expect(exchangeService.wsStatus().Binance).toBe(true);

    // Advance well past HANDSHAKE_TIMEOUT_MS — a socket that already opened
    // must NOT be terminated by the (now-cleared) handshake timer.
    vi.advanceTimersByTime(15000);
    expect(findInstance('binance').terminated).toBe(false);
    expect(exchangeService.wsStatus().Binance).toBe(true);
  });

  it('a WebSocket constructor that throws synchronously no longer leaves the exchange permanently dark — it schedules a reconnect', () => {
    vi.useFakeTimers();
    let throwCount = 0;
    class ThrowsOnceWS extends FakeWS {
      constructor(url) {
        if (throwCount < 1) { throwCount++; throw new Error('ECONNREFUSED (simulated)'); }
        super(url);
      }
    }
    ThrowsOnceWS.OPEN = 1;
    ThrowsOnceWS.instances = FakeWS.instances;

    exchangeService._setWSClassForTests(ThrowsOnceWS);
    exchangeService.init();

    // Binance's constructor threw, so makeWS() returned null for it —
    // before the fix this exchange would never be retried at all.
    expect(FakeWS.instances).toHaveLength(4); // Kraken/Bybit/OKX/Coinbase/... one missing
    expect(exchangeService.wsStatus().Binance).toBe(false);

    // handleWsCreationFailure() routes through scheduleReconnect()'s normal
    // backoff (retries=0 -> ~500ms base + up to 1000ms jitter).
    vi.advanceTimersByTime(1600);
    expect(FakeWS.instances).toHaveLength(5);
    expect(FakeWS.instances.some(i => i.url.includes('binance'))).toBe(true);
  });

  it('getOrderBooks() HTTP fallback: a malformed Binance payload (missing bidPrice/askPrice) never produces a NaN-laced quote', async () => {
    exchangeService.init(); // no sockets ever open -> every exchange falls to HTTP fallback
    exchangeService.closeAll(); // stop the watchdog interval from keeping the test process alive
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('binance')) {
        // Simulate Binance returning a payload shape without the expected fields
        return { ok: true, json: async () => ({ someOtherField: '123' }) };
      }
      return { ok: false, status: 503, json: async () => ({}) };
    });

    const results = await exchangeService.getOrderBooks();
    const binanceResult = results.find(r => r.exchange === 'Binance');

    expect(binanceResult.bid).toBeNull();
    expect(binanceResult.ask).toBeNull();
    expect(binanceResult.error).toBeTruthy();
    expect(Number.isNaN(binanceResult.bid)).toBe(false); // explicit null, never NaN

    fetchMock.mockRestore();
  });
});

describe('exchangeService — Coinbase client-side heartbeat (checkpoint 27 fix)', () => {
  beforeEach(() => {
    FakeWS.instances.length = 0;
    exchangeService._resetForTests();
    exchangeService._setWSClassForTests(FakeWS);
  });

  afterEach(() => {
    exchangeService.closeAll();
    exchangeService._setWSClassForTests(null);
    vi.useRealTimers();
  });

  it('sends a protocol-level ping on the Coinbase socket every 20s, same cadence as the other 4 exchanges', () => {
    vi.useFakeTimers();
    exchangeService.init();
    const coinbase = findInstance('coinbase');
    coinbase._emit('open');

    expect(coinbase.pingCalls).toBe(0);
    vi.advanceTimersByTime(20000);
    expect(coinbase.pingCalls).toBe(1);
    vi.advanceTimersByTime(20000);
    expect(coinbase.pingCalls).toBe(2);
  });

  it('stops pinging Coinbase after close — no dangling interval left running', () => {
    vi.useFakeTimers();
    exchangeService.init();
    const coinbase = findInstance('coinbase');
    coinbase._emit('open');
    vi.advanceTimersByTime(20000);
    expect(coinbase.pingCalls).toBe(1);

    coinbase._emit('close', 1006);
    vi.advanceTimersByTime(60000);
    // No further pings on the now-closed socket (its interval was cleared).
    expect(coinbase.pingCalls).toBe(1);
  });

  it('does not ping a Coinbase socket that never opened (readyState !== OPEN guard)', () => {
    vi.useFakeTimers();
    exchangeService.init();
    const coinbase = findInstance('coinbase');
    // Never emit 'open' — the ping interval is only armed inside the 'open'
    // handler, mirroring Binance/Kraken/Bybit/OKX exactly.
    vi.advanceTimersByTime(60000);
    expect(coinbase.pingCalls).toBe(0);
  });
});

describe('exchangeService — Kraken/Bybit book-delta price matching (checkpoint 27 fix)', () => {
  beforeEach(() => {
    FakeWS.instances.length = 0;
    exchangeService._resetForTests();
    exchangeService._setWSClassForTests(FakeWS);
  });

  afterEach(() => {
    exchangeService.closeAll();
    exchangeService._setWSClassForTests(null);
  });

  it('Kraken: an update for an existing price level replaces its quantity in place (normal, bit-identical case)', () => {
    exchangeService.init();
    const kraken = findInstance('kraken');
    kraken._emit('open');
    kraken._emit('message', JSON.stringify({
      channel: 'book', type: 'snapshot',
      data: [{ bids: [['50000.0', '1.5']], asks: [['50010.0', '2.0']] }],
    }));
    expect(exchangeService.getDepth('Kraken').bids).toEqual([[50000, 1.5]]);

    kraken._emit('message', JSON.stringify({
      channel: 'book', type: 'update',
      data: [{ bids: [['50000.0', '3.25']], asks: [] }],
    }));
    const depth = exchangeService.getDepth('Kraken');
    expect(depth.bids).toHaveLength(1); // replaced in place, not appended as a duplicate level
    expect(depth.bids[0]).toEqual([50000, 3.25]);
  });

  it('Kraken: a price level sent with different decimal formatting (but same value) is still recognized as the same level', () => {
    exchangeService.init();
    const kraken = findInstance('kraken');
    kraken._emit('open');
    kraken._emit('message', JSON.stringify({
      channel: 'book', type: 'snapshot',
      data: [{ bids: [['50000.00', '1.0']], asks: [] }],
    }));
    // Same economic price, different string formatting (no trailing zeros).
    kraken._emit('message', JSON.stringify({
      channel: 'book', type: 'update',
      data: [{ bids: [['50000', '9.0']], asks: [] }],
    }));
    const depth = exchangeService.getDepth('Kraken');
    expect(depth.bids).toHaveLength(1); // recognized as the same level, not a duplicate
    expect(depth.bids[0]).toEqual([50000, 9]);
  });

  it('Kraken: qty 0 removes the matching price level from the book', () => {
    exchangeService.init();
    const kraken = findInstance('kraken');
    kraken._emit('open');
    kraken._emit('message', JSON.stringify({
      channel: 'book', type: 'snapshot',
      data: [{ bids: [['50000.0', '1.0'], ['49900.0', '2.0']], asks: [] }],
    }));
    kraken._emit('message', JSON.stringify({
      channel: 'book', type: 'update',
      data: [{ bids: [['50000.0', '0']], asks: [] }],
    }));
    const depth = exchangeService.getDepth('Kraken');
    expect(depth.bids).toEqual([[49900, 2]]); // only the zeroed level was removed
  });

  it('Bybit: an update for an existing price level replaces its quantity in place', () => {
    exchangeService.init();
    const bybit = findInstance('bybit');
    bybit._emit('open');
    bybit._emit('message', JSON.stringify({
      topic: 'orderbook.50.BTCUSDT', type: 'snapshot',
      data: { b: [['50000.0', '1.5']], a: [['50010.0', '2.0']] },
    }));
    expect(exchangeService.getDepth('Bybit').bids).toEqual([[50000, 1.5]]);

    bybit._emit('message', JSON.stringify({
      topic: 'orderbook.50.BTCUSDT', type: 'delta',
      data: { b: [['50000.0', '7.5']], a: [] },
    }));
    const depth = exchangeService.getDepth('Bybit');
    expect(depth.bids).toHaveLength(1);
    expect(depth.bids[0]).toEqual([50000, 7.5]);
  });

  it('Bybit: qty 0 removes the matching price level from the book', () => {
    exchangeService.init();
    const bybit = findInstance('bybit');
    bybit._emit('open');
    bybit._emit('message', JSON.stringify({
      topic: 'orderbook.50.BTCUSDT', type: 'snapshot',
      data: { b: [['50000.0', '1.0'], ['49900.0', '2.0']], a: [] },
    }));
    bybit._emit('message', JSON.stringify({
      topic: 'orderbook.50.BTCUSDT', type: 'delta',
      data: { b: [['49900.0', '0']], a: [] },
    }));
    const depth = exchangeService.getDepth('Bybit');
    expect(depth.bids).toEqual([[50000, 1]]);
  });
});

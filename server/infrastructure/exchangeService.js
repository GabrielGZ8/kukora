/**
 * exchangeService.js — kukora v5
 *
 * Feeds:
 *   Binance  WS: wss://stream.binance.com  (bookTicker + depth5)
 *   Kraken   WS: wss://ws.kraken.com/v2    (ticker + book)
 *   Bybit    WS: wss://stream.bybit.com    (tickers + orderbook.50)
 *   OKX      WS: wss://ws.okx.com          (books5 + tickers)
 *   Coinbase WS: wss://advanced-trade-ws.coinbase.com (ticker — no auth required)
 *                Fallback → REST (logged ONCE per session)
 *
 * v5 FIXES:
 *   - Coinbase WS oficial sin autenticación para datos públicos
 *   - Log de retail fallback aparece UNA sola vez por sesión
 *   - CACHE_TTL 300ms (era 150ms) — reduce fetches duplicados
 *   - Watchdog monitorea todos los exchanges incluyendo Coinbase
 */

const EventEmitter = require('events');
const { TRADING_FEES: FEES } = require('../domain/wallet/feeConfig');
// conecta reliability tracking al pipeline WS — recordFeedEvent registra
// cada update exitoso y cada error para calcular getDynamicPenalty en el scoring.
const { recordFeedEvent } = require('./exchangeReliabilityDynamic');
// m-1 fix: use structured logger instead of raw console.* so log aggregators
// (Datadog, CloudWatch) receive valid JSON lines even for critical warnings.
const { logger } = require('./logger');

// Q2 (auditoría): logs verbose silenciados en producción — solo se imprimen
// con DEBUG_KUKORA=1 en el .env. Ver arbitrage.routes.js para el mismo patrón.
const _DEBUG = process.env.DEBUG_KUKORA === '1';
function _log(...args)  { if (_DEBUG) logger.debug('exchangeService', String(args[0]), args.length > 1 ? { extra: args.slice(1) } : undefined); }
function _warn(...args) { if (_DEBUG) logger.warn('exchangeService', String(args[0]), args.length > 1 ? { extra: args.slice(1) } : undefined); }

const priceEmitter = new EventEmitter();
priceEmitter.setMaxListeners(30);

// ─── State por asset ──────────────────────────────────────────────────────
// soporte multi-asset. BTC es el activo primario (estructura original).
// ETH se agrega como segundo par con feeds paralelos en todos los exchanges.
// Cada exchange tiene su propio sub-estado por asset para no interferir.

const _state = {
  Binance:  { data: null, depth: null, wsReady: false, retries: 0, lastUpdateTs: 0, ws: null },
  Kraken:   { data: null, depth: null, wsReady: false, retries: 0, lastUpdateTs: 0, ws: null },
  Bybit:    { data: null, depth: null, wsReady: false, retries: 0, lastUpdateTs: 0, ws: null },
  OKX:      { data: null, depth: null, wsReady: false, retries: 0, lastUpdateTs: 0, ws: null },
  Coinbase: { data: null,              wsReady: false, retries: 0, lastUpdateTs: 0, ws: null },
};

// Estado ETH — estructura paralela, misma arquitectura
const _stateETH = {
  Binance:  { data: null, depth: null, lastUpdateTs: 0 },
  Kraken:   { data: null, depth: null, lastUpdateTs: 0 },
  Bybit:    { data: null, depth: null, lastUpdateTs: 0 },
  OKX:      { data: null, depth: null, lastUpdateTs: 0 },
  Coinbase: { data: null,              lastUpdateTs: 0 },
};

const MAX_RETRIES   = 12;
const STALE_FEED_MS = 5000;
const CACHE_TTL     = 300;
let _cache = null, _cacheTs = 0;
let _cacheEth = null, _cacheEthTs = 0; // cache ETH separado

// Log retail fallback UNA sola vez por sesión
let _coinbaseFallbackLogged = false;

function markUpdated(exchange) {
  if (_state[exchange]) {
    _state[exchange].lastUpdateTs = Date.now();
    const st = _state[exchange];
    if (st.data?.bid && st.data?.ask) {
      recordFeedEvent(exchange, false, st.data.latencyMs || 0);
      priceEmitter.emit('priceUpdate', {
        exchange, bid: st.data.bid, ask: st.data.ask,
        ts: Date.now(), source: st.data.source, asset: 'BTC',
      });
    }
  }
}

// emit ETH price updates en el mismo priceEmitter con asset='ETH'
function markUpdatedETH(exchange) {
  const st = _stateETH[exchange];
  if (!st) return;
  st.lastUpdateTs = Date.now();
  if (st.data?.bid && st.data?.ask) {
    priceEmitter.emit('priceUpdate', {
      exchange, bid: st.data.bid, ask: st.data.ask,
      ts: Date.now(), source: st.data.source, asset: 'ETH',
    });
  }
}

function isFeedStale(exchange) {
  const st = _state[exchange];
  if (!st || !st.lastUpdateTs) return true;
  return (Date.now() - st.lastUpdateTs) > STALE_FEED_MS;
}

function getFreshness() {
  const result = {};
  for (const [ex, st] of Object.entries(_state)) {
    const age = st.lastUpdateTs ? Date.now() - st.lastUpdateTs : null;
    result[ex] = { lastUpdateTs: st.lastUpdateTs || null, ageMs: age, stale: age == null || age > STALE_FEED_MS };
  }
  return result;
}

// ─── Shutdown coordination (C-4 fix) ───────────────────────────────────────
// Prevents reconnect attempts and watchdog-triggered terminations from firing
// after the process has begun a graceful shutdown, and lets server/index.js
// close all 5 live WS connections deterministically instead of relying on
// the process dying mid-socket.
let _shuttingDown = false;

// ─── Watchdog ──────────────────────────────────────────────────────────────
const _connectFns = {};
const _watchdogInterval = setInterval(() => {
  if (_shuttingDown) return;
  for (const [ex, st] of Object.entries(_state)) {
    if (!st.wsReady) continue;
    if (isFeedStale(ex) && _connectFns[ex]) {
      _warn(`[watchdog] ${ex} feed frozen >5s — terminating for reconnect`);
      recordFeedEvent(ex, true, 5000); // feed frozen = reliability penalty
      // Only terminate. The ws.on('close') handler calls scheduleReconnect automatically.
      // Calling connectFn() here too caused double-connections.
      st.retries = 0;  // reset backoff so reconnect is fast
      if (st.ws) {
        try { st.ws.terminate(); } catch { /* ws puede estar ya cerrado */ }
        // st.ws = null and st.wsReady = false are set in the close handler
      } else {
        // No existing WS (shouldn't happen, but safe fallback)
        st.wsReady = false;
        setTimeout(() => { try { _connectFns[ex](); } catch { /* fallo en reconexión — se reintentará en el próximo ciclo */ } }, 500);
      }
    }
  }
}, 8000);

// ─── WS factory ───────────────────────────────────────────────────────────
// M-6 test seam: vi.mock('ws', ...) does NOT intercept this require('ws')
// call — verified empirically (probe test: 0 mock instances constructed,
// real 'ws' loaded instead). Same root cause already documented in
// tests/arbitrageOrchestrator.test.js for other internal CJS require()s in
// this project: vi.mock() factories only intercept Vite/Vitest's ESM module
// graph, not a plain require() resolved by Node itself inside an
// already-loaded CJS module. Mirrors the _mongooseRef seam added to
// persistenceService.js in the Session 7 cleanup: a reassignable internal
// reference, defaulting to the real dependency, that tests can override via
// _setWSClassForTests() instead of fighting module mocking.
let _WSOverride = null;
function getWSClass() {
  if (_WSOverride) return _WSOverride;
  try { return require('ws'); } catch { return null; }
}
function makeWS(WS, url) {
  if (!WS) return null;
  try { const ws = new WS(url); return typeof ws.on === 'function' ? ws : null; } catch { return null; }
}

// Reliability fix: a construction failure (bad proxy config, synchronous
// throw from the 'ws' package) used to leave connectX() returning silently
// with no reconnect ever scheduled — the exchange went dark permanently.
// Wire it into the same backoff path as a normal disconnect.
function handleWsCreationFailure(exchange, connectFn) {
  logger.warn('exchangeService', `${exchange}: WebSocket construction failed — scheduling retry via normal backoff`);
  scheduleReconnect(exchange, connectFn);
}

// Reliability fix: a socket stuck in CONNECTING (e.g. a firewall silently
// drops the handshake) never fires 'open', 'close' or 'error', and the
// watchdog only inspects exchanges that are already wsReady=true — so a
// stalled handshake was previously invisible to every safety net. Arm a
// bounded timeout on every new socket; if 'open' hasn't fired in time,
// terminate it so the existing 'close' handler drives reconnect/backoff.
const HANDSHAKE_TIMEOUT_MS = 10000;
const WS_READY_STATE_OPEN = 1;
function armHandshakeTimeout(ws, exchange) {
  const timer = setTimeout(() => {
    if (ws.readyState !== WS_READY_STATE_OPEN) {
      logger.warn('exchangeService', `${exchange}: WS handshake did not complete within ${HANDSHAKE_TIMEOUT_MS}ms — terminating for reconnect`);
      try { ws.terminate(); } catch { /* socket may already be gone */ }
    }
  }, HANDSHAKE_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  ws.on('open',  () => clearTimeout(timer));
  ws.on('close', () => clearTimeout(timer));
}

function scheduleReconnect(exchange, connectFn) {
  // C-4 fix: don't reconnect once a graceful shutdown has been requested —
  // otherwise ws.terminate() during closeAll() just triggers a fresh
  // connection via the 'close' handler right as the process is exiting.
  if (_shuttingDown) return;
  // Issue 22: Never permanently drop an exchange — slow-poll after MAX_RETRIES exhausted
  const st = _state[exchange];
  const SLOW_RETRY_MS = 5 * 60 * 1000; // 5 minutes

  if (st.retries >= MAX_RETRIES) {
    // m-1 fix: structured logger keeps log lines as JSON for aggregators
    logger.warn('exchangeService', `${exchange} WS exhausted normal retries — slow-polling every 5m`);
    setTimeout(() => {
      st.retries = 0; // reset counter so normal backoff restarts
      connectFn();
    }, SLOW_RETRY_MS);
    return;
  }
  // Performance fix (audit): add random jitter to prevent thundering herd
  // when multiple exchanges reconnect simultaneously after a network outage.
  // Jitter spreads reconnect attempts across 0–1s so exchanges don't all
  // hammer the upstream at the exact same millisecond.
  const baseDelay = Math.min(500 * Math.pow(1.8, st.retries), 30000);
  const jitter    = Math.random() * 1000;
  const delay     = baseDelay + jitter;
  st.retries++;
  setTimeout(connectFn, delay);
}

// ─── VWAP slippage ─────────────────────────────────────────────────────────
function calcVwapSlippage(levels, amount) {
  if (!levels?.length) return null;
  let remaining = amount, totalCost = 0;
  for (const [price, qty] of levels) {
    const fill = Math.min(remaining, qty);
    totalCost += fill * price;
    remaining -= fill;
    if (remaining <= 0) break;
  }
  if (remaining > 0) totalCost += remaining * levels[levels.length - 1][0];
  const avgPrice    = totalCost / amount;
  const topPrice    = levels[0][0];
  const slippagePct = Math.abs((avgPrice - topPrice) / topPrice) * 100;
  return { avgPrice, slippagePct: +slippagePct.toFixed(6), slippageUSD: +(Math.abs(avgPrice - topPrice) * amount).toFixed(6), method: 'real' };
}

// ─── Binance WS ───────────────────────────────────────────────────────────
function connectBinance() {
  const WS = getWSClass();
  const ws = makeWS(WS, 'wss://data-stream.binance.vision/stream?streams=btcusdt@bookTicker/btcusdt@depth5@100ms/ethusdt@bookTicker/ethusdt@depth5@100ms');
  if (!ws) { handleWsCreationFailure('Binance', connectBinance); return; }
  _state.Binance.ws = ws;
  armHandshakeTimeout(ws, 'Binance');
  let ping;
  ws.on('open', () => {
    _state.Binance.wsReady = true; _state.Binance.retries = 0;
    _log('◈ Binance WS connected (BTC+ETH)');
    ping = setInterval(() => ws.readyState === WS.OPEN && ws.ping?.(), 20000);
  });
  ws.on('message', raw => {
    try {
      const { stream, data } = JSON.parse(raw.toString());
      // ── BTC ──
      if (stream === 'btcusdt@bookTicker') {
        const bid = parseFloat(data.b), ask = parseFloat(data.a);
        const latencyMs = data.E ? Math.max(0, Date.now() - data.E) : 0;
        _state.Binance.data = { exchange: 'Binance', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs, source: 'ws' };
        markUpdated('Binance'); _cacheTs = 0;
      }
      if (stream === 'btcusdt@depth5@100ms') {
        _state.Binance.depth = {
          bids: (data.bids||[]).map(([p,q]) => [parseFloat(p), parseFloat(q)]),
          asks: (data.asks||[]).map(([p,q]) => [parseFloat(p), parseFloat(q)]),
          ts: Date.now(),
        };
      }
      // ── ETH ──
      if (stream === 'ethusdt@bookTicker') {
        const bid = parseFloat(data.b), ask = parseFloat(data.a);
        const latencyMs = data.E ? Math.max(0, Date.now() - data.E) : 0;
        _stateETH.Binance.data = { exchange: 'Binance', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs, source: 'ws', asset: 'ETH' };
        markUpdatedETH('Binance'); _cacheEthTs = 0;
      }
      if (stream === 'ethusdt@depth5@100ms') {
        _stateETH.Binance.depth = {
          bids: (data.bids||[]).map(([p,q]) => [parseFloat(p), parseFloat(q)]),
          asks: (data.asks||[]).map(([p,q]) => [parseFloat(p), parseFloat(q)]),
          ts: Date.now(),
        };
      }
    } catch { /* mensaje WS malformado o JSON inválido — ignorar frame y continuar */ }
  });
  ws.on('close', code => { clearInterval(ping); _state.Binance.wsReady = false; _state.Binance.ws = null; _warn(`[Binance WS] closed (${code})`); recordFeedEvent('Binance', true, 0); scheduleReconnect('Binance', connectBinance); });
  ws.on('error', e => { _warn('[Binance WS]', e.message); recordFeedEvent('Binance', true, 0); try { ws.terminate(); } catch { /* ws puede estar ya cerrado o en estado de error — ignorar */ } });
}

// ─── Kraken WS ────────────────────────────────────────────────────────────
// Checkpoint 27 fix (flagged in CHECKPOINT_26.md as a known fragility, not
// a live bug): Kraken/Bybit book delta application used to look up which
// price level to update via `p === price` on parseFloat()'d values. That's
// safe as long as the exchange re-serializes the exact same price level
// byte-for-byte between the initial snapshot and later delta messages —
// true in practice for these two exchanges' fixed-decimal APIs, but not an
// invariant documented or enforced anywhere. A relative-epsilon match is
// strictly more robust (tolerates a tiny float/serialization drift for what
// is economically "the same price level") and is a no-op for the normal
// case where the values are already bit-identical.
const _PRICE_MATCH_EPS = 1e-9;
function _samePriceLevel(a, b) {
  if (a === b) return true;
  return Math.abs(a - b) <= _PRICE_MATCH_EPS * Math.max(Math.abs(a), Math.abs(b), 1);
}

function connectKraken() {
  const WS = getWSClass();
  const ws = makeWS(WS, 'wss://ws.kraken.com/v2');
  if (!ws) { handleWsCreationFailure('Kraken', connectKraken); return; }
  _state.Kraken.ws = ws;
  armHandshakeTimeout(ws, 'Kraken');
  let ping;
  ws.on('open', () => {
    _state.Kraken.wsReady = true; _state.Kraken.retries = 0;
    _log('◈ Kraken WS v2 connected (BTC+ETH)');
    ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: ['BTC/USD', 'ETH/USD'] } }));
    ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'book', symbol: ['BTC/USD', 'ETH/USD'], depth: 10 } }));
    ping = setInterval(() => ws.readyState === WS.OPEN && ws.send(JSON.stringify({ method: 'ping' })), 30000);
  });
  ws.on('message', raw => {
    const recvTs = Date.now();
    try {
      const msg = JSON.parse(raw.toString());
      if (!msg.channel) return;
      if (msg.channel === 'ticker' && msg.data?.[0]) {
        const d   = msg.data[0];
        const bid = parseFloat(d.bid), ask = parseFloat(d.ask);
        if (!bid || !ask || isNaN(bid) || isNaN(ask)) return;
        const srvTs = d.timestamp ? new Date(d.timestamp).getTime() : recvTs;
        const latencyMs = Math.max(0, recvTs - srvTs);
        // Distinguir BTC vs ETH por el símbolo
        if (d.symbol === 'ETH/USD') {
          _stateETH.Kraken.data = { exchange: 'Kraken', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs, source: 'ws', asset: 'ETH' };
          markUpdatedETH('Kraken'); _cacheEthTs = 0;
        } else {
          _state.Kraken.data = { exchange: 'Kraken', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs, source: 'ws' };
          markUpdated('Kraken'); _cacheTs = 0;
        }
      }
      if (msg.channel === 'book' && msg.data?.[0]) {
        const d = msg.data[0];
        _state.Kraken.lastUpdateTs = Date.now(); // orderbook msgs = feed alive
        if (msg.type === 'snapshot') {
          _state.Kraken.depth = {
            bids: (d.bids||[]).map(([p,q]) => [parseFloat(p), parseFloat(q)]).sort((a,b) => b[0]-a[0]),
            asks: (d.asks||[]).map(([p,q]) => [parseFloat(p), parseFloat(q)]).sort((a,b) => a[0]-b[0]),
            ts: Date.now(),
          };
        } else if (msg.type === 'update' && _state.Kraken.depth) {
          const applyUpdate = (arr, price, qty, descending) => {
            const idx = arr.findIndex(([p]) => _samePriceLevel(p, price));
            if (qty === 0) { if (idx >= 0) arr.splice(idx, 1); }
            else if (idx >= 0) { arr[idx] = [price, qty]; }
            else { arr.push([price, qty]); arr.sort((a,b) => descending ? b[0]-a[0] : a[0]-b[0]); }
          };
          (d.bids||[]).forEach(([p,q]) => applyUpdate(_state.Kraken.depth.bids, parseFloat(p), parseFloat(q), true));
          (d.asks||[]).forEach(([p,q]) => applyUpdate(_state.Kraken.depth.asks, parseFloat(p), parseFloat(q), false));
          _state.Kraken.depth.ts = Date.now();
        }
      }
    } catch { /* mensaje WS malformado o JSON inválido — ignorar frame y continuar */ }
  });
  ws.on('close', code => { clearInterval(ping); _state.Kraken.wsReady = false; _state.Kraken.ws = null; _warn(`[Kraken WS v2] closed (${code})`); recordFeedEvent('Kraken', true, 0); scheduleReconnect('Kraken', connectKraken); });
  ws.on('error', e => { _warn('[Kraken WS v2]', e.message); recordFeedEvent('Kraken', true, 0); try { ws.terminate(); } catch { /* ws puede estar ya cerrado o en estado de error — ignorar */ } });
}

// ─── Bybit WS ─────────────────────────────────────────────────────────────
function connectBybit() {
  const WS = getWSClass();
  const ws = makeWS(WS, 'wss://stream.bybit.com/v5/public/spot');
  if (!ws) { handleWsCreationFailure('Bybit', connectBybit); return; }
  _state.Bybit.ws = ws;
  armHandshakeTimeout(ws, 'Bybit');
  let ping;
  ws.on('open', () => {
    _state.Bybit.wsReady = true; _state.Bybit.retries = 0;
    _log('◈ Bybit WS connected (BTC+ETH)');
    ws.send(JSON.stringify({ op: 'subscribe', args: ['tickers.BTCUSDT', 'orderbook.50.BTCUSDT', 'tickers.ETHUSDT', 'orderbook.50.ETHUSDT'] }));
    ping = setInterval(() => ws.readyState === WS.OPEN && ws.send(JSON.stringify({ op: 'ping' })), 20000);
  });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      // ── BTC tickers ──
      if (msg.topic === 'tickers.BTCUSDT' && msg.data) {
        const bid = parseFloat(msg.data.bid1Price), ask = parseFloat(msg.data.ask1Price);
        if (!bid || !ask) return;
        const latencyMs = msg.ts ? Math.max(0, Date.now() - msg.ts) : 0;
        _state.Bybit.data = { exchange: 'Bybit', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs, source: 'ws' };
        markUpdated('Bybit'); _cacheTs = 0;
      }
      // ── ETH tickers ──
      if (msg.topic === 'tickers.ETHUSDT' && msg.data) {
        const bid = parseFloat(msg.data.bid1Price), ask = parseFloat(msg.data.ask1Price);
        if (!bid || !ask) return;
        const latencyMs = msg.ts ? Math.max(0, Date.now() - msg.ts) : 0;
        _stateETH.Bybit.data = { exchange: 'Bybit', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs, source: 'ws', asset: 'ETH' };
        markUpdatedETH('Bybit'); _cacheEthTs = 0;
      }
      if (msg.topic === 'orderbook.50.BTCUSDT' && msg.data) {
        const d = msg.data;
        // Count orderbook messages as feed activity (prevents false "frozen" watchdog triggers)
        _state.Bybit.lastUpdateTs = Date.now();
        const applyUpdate = (arr, p, q, descending) => {
          const price = parseFloat(p), qty = parseFloat(q);
          const idx = arr.findIndex(([bp]) => _samePriceLevel(bp, price));
          if (qty === 0) { if (idx >= 0) arr.splice(idx, 1); }
          else if (idx >= 0) { arr[idx] = [price, qty]; }
          else { arr.push([price, qty]); arr.sort((a,b) => descending ? b[0]-a[0] : a[0]-b[0]); }
        };
        if (msg.type === 'snapshot') {
          _state.Bybit.depth = {
            bids: (d.b||[]).map(([p,q]) => [parseFloat(p),parseFloat(q)]).sort((a,b) => b[0]-a[0]),
            asks: (d.a||[]).map(([p,q]) => [parseFloat(p),parseFloat(q)]).sort((a,b) => a[0]-b[0]),
            ts: Date.now(),
          };
          // si aún no tenemos data de tickers, inicializar con el top del libro
          // para que markUpdated funcione y el watchdog no desconecte el feed.
          if (!_state.Bybit.data && _state.Bybit.depth.bids.length && _state.Bybit.depth.asks.length) {
            const bid = _state.Bybit.depth.bids[0][0];
            const ask = _state.Bybit.depth.asks[0][0];
            if (bid > 0 && ask > 0) {
              _state.Bybit.data = { exchange: 'Bybit', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs: 0, source: 'ws-book' };
              markUpdated('Bybit'); _cacheTs = 0;
            }
          }
        } else if (msg.type === 'delta' && _state.Bybit.depth) {
          (d.b||[]).forEach(([p,q]) => applyUpdate(_state.Bybit.depth.bids, p, q, true));
          (d.a||[]).forEach(([p,q]) => applyUpdate(_state.Bybit.depth.asks, p, q, false));
          _state.Bybit.depth.ts = Date.now();
          // actualizar bid/ask en data desde top of book en cada delta
          // para mantener data fresca aunque el canal tickers no llegue cada vez.
          if (_state.Bybit.depth.bids.length && _state.Bybit.depth.asks.length) {
            const bid = _state.Bybit.depth.bids[0][0];
            const ask = _state.Bybit.depth.asks[0][0];
            if (bid > 0 && ask > 0 && _state.Bybit.data) {
              _state.Bybit.data = { ..._state.Bybit.data, bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString() };
              markUpdated('Bybit'); _cacheTs = 0;
            }
          }
        }
      }
    } catch { /* mensaje WS malformado o JSON inválido — ignorar frame y continuar */ }
  });
  ws.on('close', code => { clearInterval(ping); _state.Bybit.wsReady = false; _state.Bybit.ws = null; _warn(`[Bybit WS] closed (${code})`); recordFeedEvent('Bybit', true, 0); scheduleReconnect('Bybit', connectBybit); });
  ws.on('error', e => { _warn('[Bybit WS]', e.message); recordFeedEvent('Bybit', true, 0); try { ws.terminate(); } catch { /* ws puede estar ya cerrado o en estado de error — ignorar */ } });
}

// ─── OKX WS ───────────────────────────────────────────────────────────────
function connectOKX() {
  const WS = getWSClass();
  const ws = makeWS(WS, 'wss://ws.okx.com:8443/ws/v5/public');
  if (!ws) { handleWsCreationFailure('OKX', connectOKX); return; }
  _state.OKX.ws = ws;
  armHandshakeTimeout(ws, 'OKX');
  let ping;
  ws.on('open', () => {
    _state.OKX.wsReady = true; _state.OKX.retries = 0;
    _log('◈ OKX WS connected (BTC+ETH)');
    ws.send(JSON.stringify({ op: 'subscribe', args: [
      { channel: 'tickers', instId: 'BTC-USDT' }, { channel: 'books5', instId: 'BTC-USDT' },
      { channel: 'tickers', instId: 'ETH-USDT' }, { channel: 'books5', instId: 'ETH-USDT' },
    ]}));
    ping = setInterval(() => ws.readyState === WS.OPEN && ws.send('ping'), 25000);
  });
  ws.on('message', raw => {
    const text = raw.toString();
    if (text === 'pong') return;
    try {
      const msg = JSON.parse(text);
      if (msg.event) return;
      const channel = msg.arg?.channel;
      const instId  = msg.arg?.instId;
      if (channel === 'tickers' && msg.data?.[0]) {
        const d = msg.data[0];
        const bid = parseFloat(d.bidPx), ask = parseFloat(d.askPx);
        if (!bid || !ask) return;
        const latencyMs = d.ts ? Math.max(0, Date.now() - parseInt(d.ts)) : 0;
        if (instId === 'ETH-USDT') {
          _stateETH.OKX.data = { exchange: 'OKX', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs, source: 'ws', asset: 'ETH' };
          markUpdatedETH('OKX'); _cacheEthTs = 0;
        } else {
          _state.OKX.data = { exchange: 'OKX', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs, source: 'ws' };
          markUpdated('OKX'); _cacheTs = 0;
        }
      }
      if (channel === 'books5' && msg.data?.[0]) {
        const d = msg.data[0];
        const depth = {
          bids: (d.bids||[]).map(([p,q]) => [parseFloat(p),parseFloat(q)]),
          asks: (d.asks||[]).map(([p,q]) => [parseFloat(p),parseFloat(q)]),
          ts: Date.now(),
        };
        if (instId === 'ETH-USDT') _stateETH.OKX.depth = depth;
        else _state.OKX.depth = depth;
      }
    } catch { /* mensaje WS malformado o JSON inválido — ignorar frame y continuar */ }
  });
  ws.on('close', code => { clearInterval(ping); _state.OKX.wsReady = false; _state.OKX.ws = null; _warn(`[OKX WS] closed (${code})`); recordFeedEvent('OKX', true, 0); scheduleReconnect('OKX', connectOKX); });
  ws.on('error', e => { _warn('[OKX WS]', e.message); recordFeedEvent('OKX', true, 0); try { ws.terminate(); } catch { /* ws puede estar ya cerrado o en estado de error — ignorar */ } });
}

// ─── Coinbase Advanced Trade WebSocket ────────────────────────────────────
// Canal público sin autenticación. Si falla → REST fallback, log UNA vez.
function connectCoinbase() {
  const WS = getWSClass();
  const ws = makeWS(WS, 'wss://advanced-trade-ws.coinbase.com');
  if (!ws) { handleWsCreationFailure('Coinbase', connectCoinbase); return; }
  _state.Coinbase.ws = ws;
  armHandshakeTimeout(ws, 'Coinbase');
  // Reliability fix (checkpoint 27): Coinbase was the only one of 5 exchanges
  // with no client-side ping. All 4 others run a protocol-level WS ping every
  // 20-30s so an idle intermediary (load balancer, proxy) doesn't silently
  // drop the connection between real ticker messages — without a ping, that
  // kind of drop wouldn't surface until the next real message gap trips the
  // separate 5s staleness watchdog, which is a much slower and coarser signal.
  // Mirrors Binance's exact pattern: a raw WS-protocol ping frame (ws.ping()),
  // not an application-level message, so it needs no Coinbase-specific
  // channel subscription or message parsing.
  let ping;
  ws.on('open', () => {
    _state.Coinbase.wsReady = true; _state.Coinbase.retries = 0;
    _coinbaseFallbackLogged = false;
    _log('◈ Coinbase Advanced Trade WS connected (BTC+ETH)');
    ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD', 'ETH-USD'], channel: 'ticker' }));
    ping = setInterval(() => ws.readyState === WS.OPEN && ws.ping?.(), 20000);
  });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.channel === 'ticker' && msg.events?.[0]?.tickers?.[0]) {
        const t = msg.events[0].tickers[0];
        const bid = parseFloat(t.best_bid), ask = parseFloat(t.best_ask);
        if (!bid || !ask || isNaN(bid) || isNaN(ask) || bid <= 0 || ask <= 0) return;
        const srvTs = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
        const latencyMs = Math.max(0, Date.now() - srvTs);
        if (t.product_id === 'ETH-USD') {
          _stateETH.Coinbase.data = { exchange: 'Coinbase', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs, source: 'ws', asset: 'ETH' };
          markUpdatedETH('Coinbase'); _cacheEthTs = 0;
        } else {
          _state.Coinbase.data = { exchange: 'Coinbase', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs, source: 'ws' };
          markUpdated('Coinbase'); _cacheTs = 0;
        }
      }
    } catch { /* mensaje WS malformado o JSON inválido — ignorar frame y continuar */ }
  });
  ws.on('close', code => {
    clearInterval(ping);
    _state.Coinbase.wsReady = false; _state.Coinbase.ws = null;
    _warn(`[Coinbase WS] closed (${code})`);
    recordFeedEvent('Coinbase', true, 0);
    scheduleReconnect('Coinbase', connectCoinbase);
  });
  ws.on('error', e => { _warn('[Coinbase WS]', e.message); recordFeedEvent('Coinbase', true, 0); _state.Coinbase.wsReady = false; try { ws.terminate(); } catch { /* ws puede estar ya cerrado o en estado de error — ignorar */ } });
}

// ─── HTTP fallbacks ───────────────────────────────────────────────────────
async function fetchWithLatency(url, exchange, parser) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parser(await res.json(), exchange, Date.now() - t0);
  } catch (e) {
    return { exchange, error: e.message, bid: null, ask: null, spread: null, spreadPct: null, ts: new Date().toISOString(), latencyMs: Date.now() - t0, source: 'http' };
  }
}

// Reliability fix (due-diligence review): only the OKX parser validated
// bid/ask before this fix. Binance had NO validation at all — a missing or
// renamed field (exchange payload change, partial JSON, maintenance
// response shaped like a 200) would silently produce bid=NaN/ask=NaN and
// flow that straight into the arbitrage/scoring pipeline as a "real" quote.
// Kraken/Bybit checked the ticker object existed but not that bid/ask were
// sane numbers. assertValidQuote() makes this uniform: every HTTP-fallback
// parser now throws on a malformed payload, which fetchWithLatency() turns
// into the same explicit `{ error, bid: null, ask: null }` shape callers
// already handle — instead of a quote-shaped object full of NaN.
function assertValidQuote(bid, ask) {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
    throw new Error('invalid or missing bid/ask in exchange payload');
  }
}
const PARSERS = {
  Binance: (j, ex, ms) => { const bid=parseFloat(j.bidPrice), ask=parseFloat(j.askPrice); assertValidQuote(bid, ask); return { exchange:ex, bid, ask, spread:ask-bid, spreadPct:+((ask-bid)/ask*100).toFixed(4), ts:new Date().toISOString(), latencyMs:ms, source:'http-fallback' }; },
  Kraken:  (j, ex, ms) => { const t=j.result?.XXBTZUSD||j.result?.XBTUSD; if(!t) throw new Error('no ticker'); const bid=parseFloat(t.b[0]), ask=parseFloat(t.a[0]); assertValidQuote(bid, ask); return { exchange:ex, bid, ask, spread:ask-bid, spreadPct:+((ask-bid)/ask*100).toFixed(4), ts:new Date().toISOString(), latencyMs:ms, source:'http-fallback' }; },
  Bybit:   (j, ex, ms) => { const i=j.result?.list?.[0]; if(!i) throw new Error('no data'); const bid=parseFloat(i.bid1Price), ask=parseFloat(i.ask1Price); assertValidQuote(bid, ask); return { exchange:ex, bid, ask, spread:ask-bid, spreadPct:+((ask-bid)/ask*100).toFixed(4), ts:new Date().toISOString(), latencyMs:ms, source:'http-fallback' }; },
  OKX:     (j, ex, ms) => { const i=j.data?.[0]; if(!i) throw new Error('no data'); const bid=parseFloat(i.bidPx), ask=parseFloat(i.askPx); assertValidQuote(bid, ask); return { exchange:ex, bid, ask, spread:ask-bid, spreadPct:+((ask-bid)/ask*100).toFixed(4), ts:new Date().toISOString(), latencyMs:ms, source:'http-fallback' }; },
};
const HTTP_URLS = {
  Binance: 'https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT',
  Kraken:  'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
  Bybit:   'https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT',
  OKX:     'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT',
};

// Coinbase REST — cache de 5s para no re-fetchear en cada tick
let _cbRestCache = null, _cbRestCacheTs = 0;
const CB_REST_TTL = 5000;

async function fetchCoinbaseRest() {
  const now = Date.now();
  if (_cbRestCache && now - _cbRestCacheTs < CB_REST_TTL) return _cbRestCache;
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.coinbase.com/api/v3/brokerage/best_bid_ask?product_ids=BTC-USD', { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const book = json?.pricebooks?.[0];
    const bid  = parseFloat(book?.bids?.[0]?.price);
    const ask  = parseFloat(book?.asks?.[0]?.price);
    if (!bid || !ask || bid <= 0 || ask <= 0 || isNaN(bid) || isNaN(ask)) throw new Error('Invalid best_bid_ask');
    const result = { exchange:'Coinbase', bid, ask, spread:ask-bid, spreadPct:+((ask-bid)/ask*100).toFixed(4), ts:new Date().toISOString(), latencyMs:Date.now()-t0, source:'http' };
    markUpdated('Coinbase');
    _cbRestCache = result; _cbRestCacheTs = now;
    return result;
  } catch {
    try {
      const [buyRes, sellRes] = await Promise.all([
        fetch('https://api.coinbase.com/v2/prices/BTC-USD/buy',  { signal: AbortSignal.timeout(3000) }),
        fetch('https://api.coinbase.com/v2/prices/BTC-USD/sell', { signal: AbortSignal.timeout(3000) }),
      ]);
      if (!buyRes.ok || !sellRes.ok) throw new Error('retail API error');
      const [buyJson, sellJson] = await Promise.all([buyRes.json(), sellRes.json()]);
      const ask2 = parseFloat(buyJson.data?.amount);
      const bid2 = parseFloat(sellJson.data?.amount);
      if (!ask2 || !bid2 || ask2 <= 0 || bid2 <= 0) throw new Error('Invalid retail price');
      if (!_coinbaseFallbackLogged) {
        _warn('[Coinbase] using retail fallback (WS unavailable) — one-time log per session');
        _coinbaseFallbackLogged = true;
      }
      const result2 = { exchange:'Coinbase', bid:bid2, ask:ask2, spread:ask2-bid2, spreadPct:+((ask2-bid2)/ask2*100).toFixed(4), ts:new Date().toISOString(), latencyMs:Date.now()-t0, source:'http-retail-fallback' };
      markUpdated('Coinbase');
      _cbRestCache = result2; _cbRestCacheTs = now;
      return result2;
    } catch (e2) {
      return { exchange:'Coinbase', error:e2.message, bid:null, ask:null, spread:null, spreadPct:null, ts:new Date().toISOString(), latencyMs:Date.now()-t0, source:'http' };
    }
  }
}

// ─── getOrderBooks ETH ────────────────────────────────────────────────────
// misma estructura que getOrderBooks BTC pero para ETH.
// HTTP fallbacks ligeros — ETH tiene menos liquidez que BTC en algunos exchanges.
const ETH_HTTP_URLS = {
  Binance:  'https://api.binance.com/api/v3/ticker/bookTicker?symbol=ETHUSDT',
  Kraken:   'https://api.kraken.com/0/public/Ticker?pair=ETHUSD',
  Bybit:    'https://api.bybit.com/v5/market/tickers?category=spot&symbol=ETHUSDT',
  OKX:      'https://www.okx.com/api/v5/market/ticker?instId=ETH-USDT',
  Coinbase: 'https://api.coinbase.com/api/v3/brokerage/best_bid_ask?product_ids=ETH-USD',
};
const ETH_PARSERS = {
  Binance:  (j, ex, ms) => { const bid=parseFloat(j.bidPrice), ask=parseFloat(j.askPrice); assertValidQuote(bid, ask); return { exchange:ex, bid, ask, spread:ask-bid, spreadPct:+((ask-bid)/ask*100).toFixed(4), ts:new Date().toISOString(), latencyMs:ms, source:'http', asset:'ETH' }; },
  Kraken:   (j, ex, ms) => { const t=j.result?.XETHZUSD||j.result?.ETHUSD; if(!t) throw new Error('no ETH ticker'); const bid=parseFloat(t.b[0]), ask=parseFloat(t.a[0]); assertValidQuote(bid, ask); return { exchange:ex, bid, ask, spread:ask-bid, spreadPct:+((ask-bid)/ask*100).toFixed(4), ts:new Date().toISOString(), latencyMs:ms, source:'http', asset:'ETH' }; },
  Bybit:    (j, ex, ms) => { const i=j.result?.list?.[0]; if(!i) throw new Error('no ETH data'); const bid=parseFloat(i.bid1Price), ask=parseFloat(i.ask1Price); assertValidQuote(bid, ask); return { exchange:ex, bid, ask, spread:ask-bid, spreadPct:+((ask-bid)/ask*100).toFixed(4), ts:new Date().toISOString(), latencyMs:ms, source:'http', asset:'ETH' }; },
  OKX:      (j, ex, ms) => { const i=j.data?.[0]; if(!i) throw new Error('no ETH data'); const bid=parseFloat(i.bidPx), ask=parseFloat(i.askPx); assertValidQuote(bid, ask); return { exchange:ex, bid, ask, spread:ask-bid, spreadPct:+((ask-bid)/ask*100).toFixed(4), ts:new Date().toISOString(), latencyMs:ms, source:'http', asset:'ETH' }; },
  Coinbase: (j, ex, ms) => { const book=j?.pricebooks?.[0]; const bid=parseFloat(book?.bids?.[0]?.price), ask=parseFloat(book?.asks?.[0]?.price); assertValidQuote(bid, ask); return { exchange:ex, bid, ask, spread:ask-bid, spreadPct:+((ask-bid)/ask*100).toFixed(4), ts:new Date().toISOString(), latencyMs:ms, source:'http', asset:'ETH' }; },
};

async function getOrderBooksETH() {
  const now = Date.now();
  if (_cacheEth && now - _cacheEthTs < CACHE_TTL) return _cacheEth;

  const results = await Promise.all(ALL_EXCHANGES.map(async ex => {
    const st = _stateETH[ex];
    // Si tenemos datos WS frescos de ETH, usarlos
    if (st?.data && st.data.bid > 0 && (now - st.lastUpdateTs) < STALE_FEED_MS) {
      return { ...st.data, feedAgeMs: now - st.lastUpdateTs, depth: st.depth || null };
    }
    // Fallback HTTP para ETH
    try {
      return await fetchWithLatency(ETH_HTTP_URLS[ex], ex, ETH_PARSERS[ex]);
    } catch {
      return { exchange: ex, error: 'ETH fetch failed', bid: null, ask: null, asset: 'ETH' };
    }
  }));

  _cacheEth = results;
  _cacheEthTs = now;
  return results;
}

// ─── getOrderBooks (BTC) ──────────────────────────────────────────────────
const ALL_EXCHANGES = ['Binance', 'Kraken', 'Bybit', 'OKX', 'Coinbase'];

async function getOrderBooks() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL) return _cache;

  const results = await Promise.all(ALL_EXCHANGES.map(async ex => {
    const st = _state[ex];
    if (st?.wsReady && st.data && !isFeedStale(ex)) {
      return { ...st.data, feedAgeMs: st.lastUpdateTs ? now - st.lastUpdateTs : null, lastUpdateTs: st.lastUpdateTs || null };
    }
    // If WS just connected but no data yet (< 3s grace), still check REST cache
    // This avoids a gap window where wsReady=true but data=null
    const fetchStart = Date.now();
    const ob = ex === 'Coinbase' ? await fetchCoinbaseRest() : await fetchWithLatency(HTTP_URLS[ex], ex, PARSERS[ex]);
    const st2 = _state[ex];
    return { ...ob, feedAgeMs: st2?.lastUpdateTs ? now - st2.lastUpdateTs : null, lastUpdateTs: st2?.lastUpdateTs || null, fetchMs: Date.now()-fetchStart };
  }));

  _cache = results;
  _cacheTs = now;
  return results;
}

// ─── Slippage ─────────────────────────────────────────────────────────────
function calcRealSlippage(amount, side = 'buy', exchange = 'Binance') {
  const depth = _state[exchange]?.depth;
  if (!depth) return { avgPrice: null, slippagePct: null, slippageUSD: null, method: 'none' };
  const levels = side === 'buy' ? depth.asks : depth.bids;
  if (!levels?.length) return { avgPrice: null, slippagePct: null, slippageUSD: null, method: 'none' };
  return calcVwapSlippage(levels, amount) || { avgPrice: null, slippagePct: null, slippageUSD: null, method: 'none' };
}

// ─── Shutdown (C-4 fix) ─────────────────────────────────────────────────────
// Called from server/index.js's shutdown coordinator. Stops the watchdog,
// blocks any further reconnect attempts, and terminates all 5 live WS
// connections so SIGTERM doesn't leave dangling sockets or trigger a
// reconnect race while the process is exiting.
function closeAll() {
  _shuttingDown = true;
  clearInterval(_watchdogInterval);
  for (const st of Object.values(_state)) {
    if (st.ws) {
      try { st.ws.terminate(); } catch { /* ya cerrado */ }
      st.ws = null;
    }
    st.wsReady = false;
  }
}

// ─── Init ──────────────────────────────────────────────────────────────────
_connectFns.Binance  = connectBinance;
_connectFns.Kraken   = connectKraken;
_connectFns.Bybit    = connectBybit;
_connectFns.OKX      = connectOKX;
_connectFns.Coinbase = connectCoinbase;

// C-1 fix: opening the 5 live WS connections used to be a require()-time
// side effect (these calls ran unconditionally at the bottom of this
// module). That meant simply `require()`-ing this file — from a test, from
// another module that only needs a helper like calcVwapSlippage(), or from
// a script that never intends to run the trading engine — opened 5 real
// sockets to Binance/Kraken/Bybit/OKX/Coinbase. init() makes that explicit:
// it's called once from server/routes/arbitrage.routes.js, next to
// startEngine(), which is the one place that actually means "the server is
// starting up for real". Idempotent (guarded by _initialized) so requiring
// this module from multiple places, or arbitrage.routes.js being required
// more than once, never opens duplicate sockets.
let _initialized = false;
function init() {
  if (_initialized) return;
  _initialized = true;
  connectBinance();
  connectKraken();
  connectBybit();
  connectOKX();
  connectCoinbase();
}

module.exports = {
  init,
  getOrderBooks,
  getOrderBooksETH,
  priceEmitter,
  FEES,
  calcRealSlippage,
  calcVwapSlippage,
  getBinanceDepth: () => _state.Binance.depth,
  getDepth:    (exchange) => _state[exchange]?.depth    || null,
  getDepthETH: (exchange) => _stateETH[exchange]?.depth || null,
  isWsConnected: () => Object.values(_state).some(s => s.wsReady),
  wsStatus: () => ({
    Binance:  _state.Binance.wsReady,
    Kraken:   _state.Kraken.wsReady,
    Bybit:    _state.Bybit.wsReady,
    OKX:      _state.OKX.wsReady,
    Coinbase: _state.Coinbase.wsReady,
  }),
  getFreshness,
  isFeedStale,
  STALE_FEED_MS,
  // C-4: graceful shutdown — closes all live WS connections and stops
  // the watchdog/reconnect machinery.
  closeAll,
  // M-6 test seam — see getWSClass() above for why vi.mock('ws') alone
  // doesn't work here. Pass a fake WS class (constructor + .on/.send/
  // .terminate) to intercept every connectX() call with no real sockets.
  // Pass null to restore the real 'ws' package.
  _setWSClassForTests: (WSClass) => { _WSOverride = WSClass; },
  // M-6 test seam — resets the require()-time init() guard so a test file
  // can call init() again against a freshly-injected fake WS class without
  // needing a real process restart. Restores _state/_stateETH to their
  // pristine values too, so tests don't leak wsReady/data/retries across
  // cases in the same file.
  _resetForTests: () => {
    _initialized = false;
    _shuttingDown = false;
    _state.Binance  = { data: null, depth: null, wsReady: false, retries: 0, lastUpdateTs: 0, ws: null };
    _state.Kraken   = { data: null, depth: null, wsReady: false, retries: 0, lastUpdateTs: 0, ws: null };
    _state.Bybit    = { data: null, depth: null, wsReady: false, retries: 0, lastUpdateTs: 0, ws: null };
    _state.OKX      = { data: null, depth: null, wsReady: false, retries: 0, lastUpdateTs: 0, ws: null };
    _state.Coinbase = { data: null,              wsReady: false, retries: 0, lastUpdateTs: 0, ws: null };
    _stateETH.Binance  = { data: null, depth: null, lastUpdateTs: 0 };
    _stateETH.Kraken   = { data: null, depth: null, lastUpdateTs: 0 };
    _stateETH.Bybit    = { data: null, depth: null, lastUpdateTs: 0 };
    _stateETH.OKX      = { data: null, depth: null, lastUpdateTs: 0 };
    _stateETH.Coinbase = { data: null,              lastUpdateTs: 0 };
    _cache = null; _cacheTs = 0; _cacheEth = null; _cacheEthTs = 0;
    _coinbaseFallbackLogged = false;
  },
};

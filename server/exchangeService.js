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
const { TRADING_FEES: FEES } = require('./feeConfig');

const priceEmitter = new EventEmitter();
priceEmitter.setMaxListeners(20);

const _state = {
  Binance:  { data: null, depth: null, wsReady: false, retries: 0, lastUpdateTs: 0, ws: null },
  Kraken:   { data: null, depth: null, wsReady: false, retries: 0, lastUpdateTs: 0, ws: null },
  Bybit:    { data: null, depth: null, wsReady: false, retries: 0, lastUpdateTs: 0, ws: null },
  OKX:      { data: null, depth: null, wsReady: false, retries: 0, lastUpdateTs: 0, ws: null },
  Coinbase: { data: null,              wsReady: false, retries: 0, lastUpdateTs: 0, ws: null },
};

const MAX_RETRIES   = 12;
const STALE_FEED_MS = 5000;
const CACHE_TTL     = 300;
let _cache = null, _cacheTs = 0;

// Log retail fallback UNA sola vez por sesión
let _coinbaseFallbackLogged = false;

function markUpdated(exchange) {
  if (_state[exchange]) {
    _state[exchange].lastUpdateTs = Date.now();
    const st = _state[exchange];
    if (st.data?.bid && st.data?.ask) {
      priceEmitter.emit('priceUpdate', {
        exchange, bid: st.data.bid, ask: st.data.ask,
        ts: Date.now(), source: st.data.source,
      });
    }
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

// ─── Watchdog ──────────────────────────────────────────────────────────────
const _connectFns = {};
setInterval(() => {
  for (const [ex, st] of Object.entries(_state)) {
    if (!st.wsReady) continue;
    if (isFeedStale(ex) && _connectFns[ex]) {
      console.warn(`[watchdog] ${ex} feed frozen >5s — terminating for reconnect`);
      // Only terminate. The ws.on('close') handler calls scheduleReconnect automatically.
      // Calling connectFn() here too caused double-connections.
      st.retries = 0;  // reset backoff so reconnect is fast
      if (st.ws) {
        try { st.ws.terminate(); } catch {}
        // st.ws = null and st.wsReady = false are set in the close handler
      } else {
        // No existing WS (shouldn't happen, but safe fallback)
        st.wsReady = false;
        setTimeout(() => { try { _connectFns[ex](); } catch {} }, 500);
      }
    }
  }
}, 8000);

// ─── WS factory ───────────────────────────────────────────────────────────
function getWSClass() {
  try { return require('ws'); } catch { return null; }
}
function makeWS(WS, url) {
  if (!WS) return null;
  try { const ws = new WS(url); return typeof ws.on === 'function' ? ws : null; } catch { return null; }
}
function scheduleReconnect(exchange, connectFn) {
  const st = _state[exchange];
  if (st.retries >= MAX_RETRIES) return;
  const delay = Math.min(500 * Math.pow(1.8, st.retries), 30000);
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
  const ws = makeWS(WS, 'wss://data-stream.binance.vision/stream?streams=btcusdt@bookTicker/btcusdt@depth5@100ms');
  if (!ws) return;
  _state.Binance.ws = ws;
  let ping;
  ws.on('open', () => {
    _state.Binance.wsReady = true; _state.Binance.retries = 0;
    console.log('◈ Binance WS connected');
    ping = setInterval(() => ws.readyState === WS.OPEN && ws.ping?.(), 20000);
  });
  ws.on('message', raw => {
    try {
      const { stream, data } = JSON.parse(raw.toString());
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
    } catch {}
  });
  ws.on('close', code => { clearInterval(ping); _state.Binance.wsReady = false; _state.Binance.ws = null; console.warn(`[Binance WS] closed (${code})`); scheduleReconnect('Binance', connectBinance); });
  ws.on('error', e => { console.warn('[Binance WS]', e.message); try { ws.terminate(); } catch {} });
}

// ─── Kraken WS ────────────────────────────────────────────────────────────
function connectKraken() {
  const WS = getWSClass();
  const ws = makeWS(WS, 'wss://ws.kraken.com/v2');
  if (!ws) return;
  _state.Kraken.ws = ws;
  let ping;
  ws.on('open', () => {
    _state.Kraken.wsReady = true; _state.Kraken.retries = 0;
    console.log('◈ Kraken WS v2 connected');
    ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: ['BTC/USD'] } }));
    ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'book', symbol: ['BTC/USD'], depth: 10 } }));
    ping = setInterval(() => ws.readyState === WS.OPEN && ws.send(JSON.stringify({ method: 'ping' })), 30000);
  });
  ws.on('message', raw => {
    const recvTs = Date.now();
    try {
      const msg = JSON.parse(raw.toString());
      if (!msg.channel) return;
      if (msg.channel === 'ticker' && msg.data?.[0]) {
        const d = msg.data[0];
        const bid = parseFloat(d.bid), ask = parseFloat(d.ask);
        if (!bid || !ask || isNaN(bid) || isNaN(ask)) return;
        const srvTs = d.timestamp ? new Date(d.timestamp).getTime() : recvTs;
        _state.Kraken.data = { exchange: 'Kraken', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs: Math.max(0, recvTs-srvTs), source: 'ws' };
        markUpdated('Kraken'); _cacheTs = 0;
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
            const idx = arr.findIndex(([p]) => p === price);
            if (qty === 0) { if (idx >= 0) arr.splice(idx, 1); }
            else if (idx >= 0) { arr[idx] = [price, qty]; }
            else { arr.push([price, qty]); arr.sort((a,b) => descending ? b[0]-a[0] : a[0]-b[0]); }
          };
          (d.bids||[]).forEach(([p,q]) => applyUpdate(_state.Kraken.depth.bids, parseFloat(p), parseFloat(q), true));
          (d.asks||[]).forEach(([p,q]) => applyUpdate(_state.Kraken.depth.asks, parseFloat(p), parseFloat(q), false));
          _state.Kraken.depth.ts = Date.now();
        }
      }
    } catch {}
  });
  ws.on('close', code => { clearInterval(ping); _state.Kraken.wsReady = false; _state.Kraken.ws = null; console.warn(`[Kraken WS v2] closed (${code})`); scheduleReconnect('Kraken', connectKraken); });
  ws.on('error', e => { console.warn('[Kraken WS v2]', e.message); try { ws.terminate(); } catch {} });
}

// ─── Bybit WS ─────────────────────────────────────────────────────────────
function connectBybit() {
  const WS = getWSClass();
  const ws = makeWS(WS, 'wss://stream.bybit.com/v5/public/spot');
  if (!ws) return;
  _state.Bybit.ws = ws;
  let ping;
  ws.on('open', () => {
    _state.Bybit.wsReady = true; _state.Bybit.retries = 0;
    console.log('◈ Bybit WS connected');
    ws.send(JSON.stringify({ op: 'subscribe', args: ['tickers.BTCUSDT', 'orderbook.50.BTCUSDT'] }));
    ping = setInterval(() => ws.readyState === WS.OPEN && ws.send(JSON.stringify({ op: 'ping' })), 20000);
  });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.topic === 'tickers.BTCUSDT' && msg.data) {
        const bid = parseFloat(msg.data.bid1Price), ask = parseFloat(msg.data.ask1Price);
        if (!bid || !ask) return;
        _state.Bybit.data = { exchange: 'Bybit', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs: msg.ts ? Math.max(0, Date.now()-msg.ts) : 0, source: 'ws' };
        markUpdated('Bybit'); _cacheTs = 0;
      }
      if (msg.topic === 'orderbook.50.BTCUSDT' && msg.data) {
        const d = msg.data;
        // Count orderbook messages as feed activity (prevents false "frozen" watchdog triggers)
        _state.Bybit.lastUpdateTs = Date.now();
        const applyUpdate = (arr, p, q, descending) => {
          const price = parseFloat(p), qty = parseFloat(q);
          const idx = arr.findIndex(([bp]) => bp === price);
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
        } else if (msg.type === 'delta' && _state.Bybit.depth) {
          (d.b||[]).forEach(([p,q]) => applyUpdate(_state.Bybit.depth.bids, p, q, true));
          (d.a||[]).forEach(([p,q]) => applyUpdate(_state.Bybit.depth.asks, p, q, false));
          _state.Bybit.depth.ts = Date.now();
        }
      }
    } catch {}
  });
  ws.on('close', code => { clearInterval(ping); _state.Bybit.wsReady = false; _state.Bybit.ws = null; console.warn(`[Bybit WS] closed (${code})`); scheduleReconnect('Bybit', connectBybit); });
  ws.on('error', e => { console.warn('[Bybit WS]', e.message); try { ws.terminate(); } catch {} });
}

// ─── OKX WS ───────────────────────────────────────────────────────────────
function connectOKX() {
  const WS = getWSClass();
  const ws = makeWS(WS, 'wss://ws.okx.com:8443/ws/v5/public');
  if (!ws) return;
  _state.OKX.ws = ws;
  let ping;
  ws.on('open', () => {
    _state.OKX.wsReady = true; _state.OKX.retries = 0;
    console.log('◈ OKX WS connected');
    ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'tickers', instId: 'BTC-USDT' }, { channel: 'books5', instId: 'BTC-USDT' }] }));
    ping = setInterval(() => ws.readyState === WS.OPEN && ws.send('ping'), 25000);
  });
  ws.on('message', raw => {
    const text = raw.toString();
    if (text === 'pong') return;
    try {
      const msg = JSON.parse(text);
      if (msg.event) return;
      const channel = msg.arg?.channel;
      if (channel === 'tickers' && msg.data?.[0]) {
        const d = msg.data[0];
        const bid = parseFloat(d.bidPx), ask = parseFloat(d.askPx);
        if (!bid || !ask) return;
        _state.OKX.data = { exchange: 'OKX', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs: d.ts ? Math.max(0, Date.now()-parseInt(d.ts)) : 0, source: 'ws' };
        markUpdated('OKX'); _cacheTs = 0;
      }
      if (channel === 'books5' && msg.data?.[0]) {
        const d = msg.data[0];
        _state.OKX.depth = {
          bids: (d.bids||[]).map(([p,q]) => [parseFloat(p),parseFloat(q)]),
          asks: (d.asks||[]).map(([p,q]) => [parseFloat(p),parseFloat(q)]),
          ts: Date.now(),
        };
      }
    } catch {}
  });
  ws.on('close', code => { clearInterval(ping); _state.OKX.wsReady = false; _state.OKX.ws = null; console.warn(`[OKX WS] closed (${code})`); scheduleReconnect('OKX', connectOKX); });
  ws.on('error', e => { console.warn('[OKX WS]', e.message); try { ws.terminate(); } catch {} });
}

// ─── Coinbase Advanced Trade WebSocket ────────────────────────────────────
// Canal público sin autenticación. Si falla → REST fallback, log UNA vez.
function connectCoinbase() {
  const WS = getWSClass();
  const ws = makeWS(WS, 'wss://advanced-trade-ws.coinbase.com');
  if (!ws) return;
  _state.Coinbase.ws = ws;
  ws.on('open', () => {
    _state.Coinbase.wsReady = true; _state.Coinbase.retries = 0;
    _coinbaseFallbackLogged = false;
    console.log('◈ Coinbase Advanced Trade WS connected');
    ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channel: 'ticker' }));
  });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.channel === 'ticker' && msg.events?.[0]?.tickers?.[0]) {
        const t = msg.events[0].tickers[0];
        const bid = parseFloat(t.best_bid), ask = parseFloat(t.best_ask);
        if (!bid || !ask || isNaN(bid) || isNaN(ask) || bid <= 0 || ask <= 0) return;
        const srvTs = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
        _state.Coinbase.data = { exchange: 'Coinbase', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs: Math.max(0, Date.now()-srvTs), source: 'ws' };
        markUpdated('Coinbase'); _cacheTs = 0;
      }
    } catch {}
  });
  ws.on('close', code => {
    _state.Coinbase.wsReady = false; _state.Coinbase.ws = null;
    console.warn(`[Coinbase WS] closed (${code})`);
    scheduleReconnect('Coinbase', connectCoinbase);
  });
  ws.on('error', e => { console.warn('[Coinbase WS]', e.message); _state.Coinbase.wsReady = false; try { ws.terminate(); } catch {} });
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

const PARSERS = {
  Binance: (j, ex, ms) => { const bid=parseFloat(j.bidPrice), ask=parseFloat(j.askPrice); return { exchange:ex, bid, ask, spread:ask-bid, spreadPct:+((ask-bid)/ask*100).toFixed(4), ts:new Date().toISOString(), latencyMs:ms, source:'http-fallback' }; },
  Kraken:  (j, ex, ms) => { const t=j.result?.XXBTZUSD||j.result?.XBTUSD; if(!t) throw new Error('no ticker'); const bid=parseFloat(t.b[0]), ask=parseFloat(t.a[0]); return { exchange:ex, bid, ask, spread:ask-bid, spreadPct:+((ask-bid)/ask*100).toFixed(4), ts:new Date().toISOString(), latencyMs:ms, source:'http-fallback' }; },
  Bybit:   (j, ex, ms) => { const i=j.result?.list?.[0]; if(!i) throw new Error('no data'); const bid=parseFloat(i.bid1Price), ask=parseFloat(i.ask1Price); return { exchange:ex, bid, ask, spread:ask-bid, spreadPct:+((ask-bid)/ask*100).toFixed(4), ts:new Date().toISOString(), latencyMs:ms, source:'http-fallback' }; },
  OKX:     (j, ex, ms) => { const i=j.data?.[0]; if(!i) throw new Error('no data'); const bid=parseFloat(i.bidPx), ask=parseFloat(i.askPx); if(!bid||!ask) throw new Error('no bid/ask'); return { exchange:ex, bid, ask, spread:ask-bid, spreadPct:+((ask-bid)/ask*100).toFixed(4), ts:new Date().toISOString(), latencyMs:ms, source:'http-fallback' }; },
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
        console.warn('[Coinbase] usando retail fallback (WS no disponible) — log único por sesión');
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

// ─── getOrderBooks ─────────────────────────────────────────────────────────
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

// ─── Init ──────────────────────────────────────────────────────────────────
_connectFns.Binance  = connectBinance;
_connectFns.Kraken   = connectKraken;
_connectFns.Bybit    = connectBybit;
_connectFns.OKX      = connectOKX;
_connectFns.Coinbase = connectCoinbase;

connectBinance();
connectKraken();
connectBybit();
connectOKX();
connectCoinbase();

module.exports = {
  getOrderBooks,
  priceEmitter,
  FEES,
  calcRealSlippage,
  calcVwapSlippage,
  getBinanceDepth: () => _state.Binance.depth,
  getDepth: (exchange) => _state[exchange]?.depth || null,
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
};

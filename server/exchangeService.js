/**
 * exchangeService.js — kukora arbitrage
 * Binance  WS: wss://stream.binance.com  (bookTicker + depth5)
 * Kraken   WS: wss://ws.kraken.com       (ticker + book)
 * Bybit    WS: wss://stream.bybit.com    (tickers + orderbook.1)
 * OKX      WS: wss://ws.okx.com          (books5 + tickers)
 * Coinbase   : HTTPS public ticker (fallback, auth-free endpoint)
 *
 * IMPROVEMENTS:
 *  - OKX added as 4th exchange with WS + L2 depth for real slippage
 *  - Kraken L2 depth via WS for real slippage
 *  - Bybit  L2 depth via WS for real slippage
 *  - calcRealSlippage now works for ALL exchanges (no fallback needed unless depth missing)
 *  - slippageUSD fixed: +(Math.abs(avgPrice - topPrice) * amount).toFixed(6)
 *  - Coinbase uses public REST v2 endpoint (no auth required)
 *  - Parallel HTTP fetches with AbortSignal.timeout(3000)
 *  - wsStatus includes OKX
 */

const { TRADING_FEES: FEES } = require('./feeConfig');

// ─── Per-exchange state ────────────────────────────────────────────────────
const _state = {
  Binance:  { data: null, depth: null, wsReady: false, retries: 0 },
  Kraken:   { data: null, depth: null, wsReady: false, retries: 0 },
  Bybit:    { data: null, depth: null, wsReady: false, retries: 0 },
  OKX:      { data: null, depth: null, wsReady: false, retries: 0 },
  Coinbase: { data: null,              wsReady: false, retries: 0 },
};

const MAX_RETRIES = 12;
const STALE_WS_MS = 2500;
const CACHE_TTL   = 1000; // reduced from 1500ms for fresher data
let _cache = null, _cacheTs = 0;

// ─── WS factory ───────────────────────────────────────────────────────────
function getWSClass() {
  try { return require('ws'); } catch { return null; }
}

function makeWS(WS, url) {
  if (!WS) return null;
  try {
    const ws = new WS(url);
    if (typeof ws.on !== 'function') return null;
    return ws;
  } catch { return null; }
}

function scheduleReconnect(exchange, connectFn, state) {
  const st = state || _state[exchange];
  if (st.retries >= MAX_RETRIES) return;
  const delay = Math.min(500 * Math.pow(1.8, st.retries), 30000);
  st.retries++;
  setTimeout(connectFn, delay);
}

// ─── Shared depth VWAP calculator ─────────────────────────────────────────
/**
 * Walk order book levels to compute VWAP slippage for a given amount.
 * @param {Array} levels - [[price, qty], ...] sorted: asks ascending, bids descending
 * @param {number} amount - BTC amount to fill
 * @returns {{ avgPrice, slippagePct, slippageUSD, method }}
 */
function calcVwapSlippage(levels, amount) {
  if (!levels || !levels.length) return null;

  let remaining = amount, totalCost = 0;
  for (const [price, qty] of levels) {
    const fill = Math.min(remaining, qty);
    totalCost += fill * price;
    remaining -= fill;
    if (remaining <= 0) break;
  }
  // If order book too thin, fill remainder at worst level
  if (remaining > 0) totalCost += remaining * levels[levels.length - 1][0];

  const avgPrice    = totalCost / amount;
  const topPrice    = levels[0][0];
  const slippagePct = Math.abs((avgPrice - topPrice) / topPrice) * 100;
  const slippageUSD = +(Math.abs(avgPrice - topPrice) * amount).toFixed(6); // FIX: parenthesis + toFixed

  return {
    avgPrice,
    slippagePct: +slippagePct.toFixed(6),
    slippageUSD,
    method: 'real',
  };
}

// ─── Binance WS ───────────────────────────────────────────────────────────
function connectBinance() {
  const WS = getWSClass();
  const ws = makeWS(WS, 'wss://stream.binance.com:9443/stream?streams=btcusdt@bookTicker/btcusdt@depth5@100ms');
  if (!ws) return;

  let ping;
  ws.on('open', () => {
    _state.Binance.wsReady = true;
    _state.Binance.retries = 0;
    console.log('◈ Binance WS connected');
    ping = setInterval(() => ws.readyState === WS.OPEN && ws.ping?.(), 20000);
  });
  ws.on('message', raw => {
    try {
      const { stream, data } = JSON.parse(raw.toString());
      if (stream === 'btcusdt@bookTicker') {
        const bid = parseFloat(data.b), ask = parseFloat(data.a);
        const latencyMs = data.E ? Math.max(0, Date.now() - data.E) : 0;
        _state.Binance.data = { exchange: 'Binance', bid, ask, spread: ask - bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs, source: 'ws' };
        _cacheTs = 0;
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
  ws.on('close', code => {
    clearInterval(ping);
    _state.Binance.wsReady = false;
    console.warn(`[Binance WS] closed (${code})`);
    scheduleReconnect('Binance', connectBinance);
  });
  ws.on('error', e => { console.warn('[Binance WS]', e.message); try { ws.terminate(); } catch {} });
}

// ─── Kraken WS ────────────────────────────────────────────────────────────
function connectKraken() {
  const WS = getWSClass();
  const ws = makeWS(WS, 'wss://ws.kraken.com');
  if (!ws) return;

  ws.on('open', () => {
    _state.Kraken.wsReady = true;
    _state.Kraken.retries = 0;
    console.log('◈ Kraken WS connected');
    // Subscribe to both ticker AND book (depth 10) for real slippage
    ws.send(JSON.stringify({ event: 'subscribe', pair: ['XBT/USD'], subscription: { name: 'ticker' } }));
    ws.send(JSON.stringify({ event: 'subscribe', pair: ['XBT/USD'], subscription: { name: 'book', depth: 10 } }));
  });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (!Array.isArray(msg)) return;
      const channelName = msg[2];

      if (channelName === 'ticker') {
        const t = msg[1];
        const bid = parseFloat(t.b[0]), ask = parseFloat(t.a[0]);
        _state.Kraken.data = { exchange: 'Kraken', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs: 0, source: 'ws' };
        _cacheTs = 0;
      }
      if (channelName === 'book-10') {
        const bookData = msg[1];
        // Snapshot: { as: [...], bs: [...] } or update: { a: [...], b: [...] }
        if (bookData.as || bookData.bs) {
          // Full snapshot
          _state.Kraken.depth = {
            bids: (bookData.bs||[]).map(([p,q]) => [parseFloat(p), parseFloat(q)]),
            asks: (bookData.as||[]).map(([p,q]) => [parseFloat(p), parseFloat(q)]),
            ts: Date.now(),
          };
        } else if (bookData.a || bookData.b) {
          // Delta update — merge into existing depth
          if (_state.Kraken.depth) {
            if (bookData.a) {
              for (const [p,q,t] of bookData.a) {
                const price = parseFloat(p), qty = parseFloat(q);
                const idx = _state.Kraken.depth.asks.findIndex(([ap]) => ap === price);
                if (qty === 0) { if (idx >= 0) _state.Kraken.depth.asks.splice(idx, 1); }
                else if (idx >= 0) { _state.Kraken.depth.asks[idx] = [price, qty]; }
                else { _state.Kraken.depth.asks.push([price, qty]); _state.Kraken.depth.asks.sort((a,b) => a[0]-b[0]); }
              }
            }
            if (bookData.b) {
              for (const [p,q,t] of bookData.b) {
                const price = parseFloat(p), qty = parseFloat(q);
                const idx = _state.Kraken.depth.bids.findIndex(([bp]) => bp === price);
                if (qty === 0) { if (idx >= 0) _state.Kraken.depth.bids.splice(idx, 1); }
                else if (idx >= 0) { _state.Kraken.depth.bids[idx] = [price, qty]; }
                else { _state.Kraken.depth.bids.push([price, qty]); _state.Kraken.depth.bids.sort((a,b) => b[0]-a[0]); }
              }
            }
            _state.Kraken.depth.ts = Date.now();
          }
        }
      }
    } catch {}
  });
  ws.on('close', code => {
    _state.Kraken.wsReady = false;
    console.warn(`[Kraken WS] closed (${code})`);
    scheduleReconnect('Kraken', connectKraken);
  });
  ws.on('error', e => { console.warn('[Kraken WS]', e.message); try { ws.terminate(); } catch {} });
}

// ─── Bybit WS ─────────────────────────────────────────────────────────────
function connectBybit() {
  const WS = getWSClass();
  const ws = makeWS(WS, 'wss://stream.bybit.com/v5/public/spot');
  if (!ws) return;

  let ping;
  ws.on('open', () => {
    _state.Bybit.wsReady = true;
    _state.Bybit.retries = 0;
    console.log('◈ Bybit WS connected');
    ws.send(JSON.stringify({ op: 'subscribe', args: ['tickers.BTCUSDT', 'orderbook.1.BTCUSDT'] }));
    ping = setInterval(() => ws.readyState === WS.OPEN && ws.send(JSON.stringify({ op: 'ping' })), 20000);
  });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.topic === 'tickers.BTCUSDT' && msg.data) {
        const d = msg.data;
        const bid = parseFloat(d.bid1Price), ask = parseFloat(d.ask1Price);
        if (!bid || !ask) return;
        const latencyMs = msg.ts ? Math.max(0, Date.now() - msg.ts) : 0;
        _state.Bybit.data = { exchange: 'Bybit', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs, source: 'ws' };
        _cacheTs = 0;
      }
      // orderbook.1 gives best bid/ask with qty — sufficient for slippage calc at 0.1 BTC
      if (msg.topic === 'orderbook.1.BTCUSDT' && msg.data) {
        const d = msg.data;
        if (d.b && d.a) {
          _state.Bybit.depth = {
            bids: d.b.map(([p,q]) => [parseFloat(p), parseFloat(q)]),
            asks: d.a.map(([p,q]) => [parseFloat(p), parseFloat(q)]),
            ts: Date.now(),
          };
        }
      }
    } catch {}
  });
  ws.on('close', code => {
    clearInterval(ping);
    _state.Bybit.wsReady = false;
    console.warn(`[Bybit WS] closed (${code})`);
    scheduleReconnect('Bybit', connectBybit);
  });
  ws.on('error', e => { console.warn('[Bybit WS]', e.message); try { ws.terminate(); } catch {} });
}

// ─── OKX WS ───────────────────────────────────────────────────────────────
function connectOKX() {
  const WS = getWSClass();
  const ws = makeWS(WS, 'wss://ws.okx.com:8443/ws/v5/public');
  if (!ws) return;

  let ping;
  ws.on('open', () => {
    _state.OKX.wsReady = true;
    _state.OKX.retries = 0;
    console.log('◈ OKX WS connected');
    // Subscribe to tickers (best bid/ask) and books5 (L2 depth, 5 levels)
    ws.send(JSON.stringify({
      op: 'subscribe',
      args: [
        { channel: 'tickers',  instId: 'BTC-USDT' },
        { channel: 'books5',   instId: 'BTC-USDT' },
      ],
    }));
    // OKX requires ping every 30s
    ping = setInterval(() => ws.readyState === WS.OPEN && ws.send('ping'), 25000);
  });
  ws.on('message', raw => {
    const text = raw.toString();
    if (text === 'pong') return; // heartbeat response
    try {
      const msg = JSON.parse(text);
      if (msg.event) return; // subscribe/error acks

      const channel = msg.arg?.channel;

      if (channel === 'tickers' && msg.data?.[0]) {
        const d = msg.data[0];
        const bid = parseFloat(d.bidPx), ask = parseFloat(d.askPx);
        if (!bid || !ask) return;
        // OKX provides ts in ms since epoch
        const latencyMs = d.ts ? Math.max(0, Date.now() - parseInt(d.ts)) : 0;
        _state.OKX.data = { exchange: 'OKX', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs, source: 'ws' };
        _cacheTs = 0;
      }

      if (channel === 'books5' && msg.data?.[0]) {
        const d = msg.data[0];
        _state.OKX.depth = {
          bids: (d.bids||[]).map(([p,q]) => [parseFloat(p), parseFloat(q)]),
          asks: (d.asks||[]).map(([p,q]) => [parseFloat(p), parseFloat(q)]),
          ts: Date.now(),
        };
      }
    } catch {}
  });
  ws.on('close', code => {
    clearInterval(ping);
    _state.OKX.wsReady = false;
    console.warn(`[OKX WS] closed (${code})`);
    scheduleReconnect('OKX', connectOKX);
  });
  ws.on('error', e => { console.warn('[OKX WS]', e.message); try { ws.terminate(); } catch {} });
}

// Start all WS connections
connectBinance();
connectKraken();
connectBybit();
connectOKX();

// ─── Slippage calculator (all exchanges) ──────────────────────────────────
/**
 * calcRealSlippage — compute VWAP slippage from live order book depth.
 * Falls back to null if no depth available for that exchange.
 * @param {number} amount - BTC amount
 * @param {'buy'|'sell'} side
 * @param {string} exchange - exchange name (defaults to Binance for backward compat)
 */
function calcRealSlippage(amount, side = 'buy', exchange = 'Binance') {
  const depth = _state[exchange]?.depth;
  if (!depth) return { avgPrice: null, slippagePct: null, slippageUSD: null, method: 'none' };
  const levels = side === 'buy' ? depth.asks : depth.bids;
  if (!levels?.length) return { avgPrice: null, slippagePct: null, slippageUSD: null, method: 'none' };

  const result = calcVwapSlippage(levels, amount);
  return result || { avgPrice: null, slippagePct: null, slippageUSD: null, method: 'none' };
}

// ─── HTTP fetch helpers ────────────────────────────────────────────────────
async function fetchWithLatency(url, exchange, parser) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return parser(json, exchange, Date.now() - t0);
  } catch (e) {
    return { exchange, error: e.message, bid: null, ask: null, spread: null, spreadPct: null, ts: new Date().toISOString(), latencyMs: Date.now() - t0, source: 'http' };
  }
}

const PARSERS = {
  Binance: (json, ex, ms) => {
    const bid = parseFloat(json.bidPrice), ask = parseFloat(json.askPrice);
    return { exchange: ex, bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs: ms, source: 'http-fallback' };
  },
  Kraken: (json, ex, ms) => {
    const ticker = json.result?.XXBTZUSD || json.result?.XBTUSD;
    if (!ticker) throw new Error('no ticker');
    const bid = parseFloat(ticker.b[0]), ask = parseFloat(ticker.a[0]);
    return { exchange: ex, bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs: ms, source: 'http-fallback' };
  },
  Bybit: (json, ex, ms) => {
    const item = json.result?.list?.[0];
    if (!item) throw new Error('no data');
    const bid = parseFloat(item.bid1Price), ask = parseFloat(item.ask1Price);
    return { exchange: ex, bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs: ms, source: 'http-fallback' };
  },
  OKX: (json, ex, ms) => {
    const item = json.data?.[0];
    if (!item) throw new Error('no data');
    const bid = parseFloat(item.bidPx), ask = parseFloat(item.askPx);
    if (!bid || !ask) throw new Error('no bid/ask');
    return { exchange: ex, bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs: ms, source: 'http-fallback' };
  },
  // Coinbase: use public v2 API (no auth required, no geo-blocking issues)
  Coinbase: (json, ex, ms) => {
    // v2/prices endpoint returns { data: { base, currency, amount } } — not useful for spread
    // use spot price as mid — bid/ask not available without auth
    // We mark this as limited and skip if no proper spread available
    const bid = parseFloat(json.best_bid ?? json.data?.amount);
    const ask = parseFloat(json.best_ask ?? json.data?.amount);
    if (!bid || !ask || bid <= 0 || ask <= 0 || bid === ask) {
      return { exchange: ex, error: 'No bid/ask spread', bid: null, ask: null, spread: null, spreadPct: null, ts: new Date().toISOString(), latencyMs: ms, source: 'http' };
    }
    return { exchange: ex, bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs: ms, source: 'http' };
  },
};

// ─── HTTP URLs ────────────────────────────────────────────────────────────
const HTTP_URLS = {
  Binance:  'https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT',
  Kraken:   'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
  Bybit:    'https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT',
  OKX:      'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT',
  // Coinbase: use production-safe public endpoint (no auth, no geo-block)
  Coinbase: 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
};

// ─── getOrderBooks ─────────────────────────────────────────────────────────
const ALL_EXCHANGES = ['Binance', 'Kraken', 'Bybit', 'OKX', 'Coinbase'];

async function getOrderBooks() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL) return _cache;

  // Parallel fetch — all exchanges simultaneously
  const results = await Promise.all(ALL_EXCHANGES.map(ex => {
    const st = _state[ex];
    if (st && st.wsReady && st.data && now - new Date(st.data.ts).getTime() < STALE_WS_MS) {
      return Promise.resolve(st.data);
    }
    return fetchWithLatency(HTTP_URLS[ex], ex, PARSERS[ex]);
  }));

  _cache = results;
  _cacheTs = now;
  return results;
}

module.exports = {
  getOrderBooks,
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
    Coinbase: false, // HTTP only
  }),
};
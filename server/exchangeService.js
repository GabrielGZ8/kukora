/**
 * exchangeService.js — kukora arbitrage
 * Binance WS: wss://stream.binance.com  (bookTicker + depth5)
 * Kraken  WS: wss://ws.kraken.com       (ticker)
 * Bybit   WS: wss://stream.bybit.com    (tickers.BTCUSDT)
 * Coinbase  : HTTP fallback (no WS public para spot)
 */

const FEES = {
  Binance:  0.001,
  Kraken:   0.0026,
  Bybit:    0.001,
  Coinbase: 0.006,
};

// ─── Per-exchange state ────────────────────────────────────────────────────
const _state = {
  Binance:  { data: null, depth: null, wsReady: false, retries: 0 },
  Kraken:   { data: null,              wsReady: false, retries: 0 },
  Bybit:    { data: null,              wsReady: false, retries: 0 },
  Coinbase: { data: null,              wsReady: false, retries: 0 },
};

const MAX_RETRIES   = 12;
const STALE_WS_MS = 2500;
const CACHE_TTL     = 1500;
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

function scheduleReconnect(exchange, connectFn) {
  const st = _state[exchange];
  if (st.retries >= MAX_RETRIES) return;
  const delay = Math.min(500 * Math.pow(1.8, st.retries), 30000);
  st.retries++;
  setTimeout(connectFn, delay);
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
        // FIX: calcular latencia real end-to-end usando el event time del exchange (data.E)
        const latencyMs = data.E ? Math.max(0, Date.now() - data.E) : 0;
        _state.Binance.data = { exchange: 'Binance', bid, ask, spread: ask - bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs, source: 'ws' };
        _cacheTs = 0; // invalidate cache
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
    ws.send(JSON.stringify({
      event: 'subscribe',
      pair: ['XBT/USD'],
      subscription: { name: 'ticker' },
    }));
  });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      // Ticker update: [channelId, { b:[bestBid,...], a:[bestAsk,...] }, "ticker", "XBT/USD"]
      if (Array.isArray(msg) && msg[2] === 'ticker') {
        const t = msg[1];
        const bid = parseFloat(t.b[0]), ask = parseFloat(t.a[0]);
        // FIX: latencia real usando campo ts si disponible
        const latencyMs = msg[0] && typeof msg[0] === 'number' ? Math.max(0, Date.now() - msg[0] * 1000) : 0;
        _state.Kraken.data = { exchange: 'Kraken', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs, source: 'ws' };
        _cacheTs = 0;
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
    ws.send(JSON.stringify({ op: 'subscribe', args: ['tickers.BTCUSDT'] }));
    ping = setInterval(() => ws.readyState === WS.OPEN && ws.send(JSON.stringify({ op: 'ping' })), 20000);
  });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.topic === 'tickers.BTCUSDT' && msg.data) {
        const d = msg.data;
        const bid = parseFloat(d.bid1Price), ask = parseFloat(d.ask1Price);
        if (!bid || !ask) return;
        // FIX: latencia real usando msg.ts (timestamp del exchange en ms)
        const latencyMs = msg.ts ? Math.max(0, Date.now() - msg.ts) : 0;
        _state.Bybit.data = { exchange: 'Bybit', bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs, source: 'ws' };
        _cacheTs = 0;
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

// Start all WS connections
connectBinance();
connectKraken();
connectBybit();

// ─── Slippage real desde Binance depth ────────────────────────────────────
function calcRealSlippage(amount, side = 'buy') {
  const depth = _state.Binance.depth;
  if (!depth) return { avgPrice: null, slippagePct: 0.05, slippageUSD: null };
  const levels = side === 'buy' ? depth.asks : depth.bids;
  if (!levels?.length) return { avgPrice: null, slippagePct: 0.05, slippageUSD: null };

  let remaining = amount, totalCost = 0;
  for (const [price, qty] of levels) {
    const fill = Math.min(remaining, qty);
    totalCost += fill * price;
    remaining -= fill;
    if (remaining <= 0) break;
  }
  if (remaining > 0) totalCost += remaining * levels[levels.length - 1][0];

  const avgPrice   = totalCost / amount;
  const topPrice   = levels[0][0];
  const slippagePct = Math.abs((avgPrice - topPrice) / topPrice) * 100;
  return { avgPrice, slippagePct: +slippagePct.toFixed(6), slippageUSD: +Math.abs(avgPrice - topPrice) * amount };
}

// ─── HTTP fetch helpers ────────────────────────────────────────────────────
async function fetchWithLatency(url, exchange, parser) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
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
  Coinbase: (json, ex, ms) => {
    // FIX: si best_bid o best_ask no existen, NO usar json.price como fallback
    // porque bid === ask genera oportunidades de arbitraje falsas con spread $0.
    const bid = parseFloat(json.best_bid);
    const ask = parseFloat(json.best_ask);
    if (!bid || !ask || bid <= 0 || ask <= 0) {
      return { exchange: ex, error: 'No bid/ask data', bid: null, ask: null, spread: null, spreadPct: null, ts: new Date().toISOString(), latencyMs: ms, source: 'http' };
    }
    return { exchange: ex, bid, ask, spread: ask-bid, spreadPct: +((ask-bid)/ask*100).toFixed(4), ts: new Date().toISOString(), latencyMs: ms, source: 'http' };
  },
};

// ─── getOrderBooks ─────────────────────────────────────────────────────────
const HTTP_URLS = {
  Binance:  'https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT',
  Kraken:   'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
  Bybit:    'https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT',
  Coinbase: 'https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/ticker',
};

async function getOrderBooks() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL) return _cache;

  const results = await Promise.all(['Binance','Kraken','Bybit','Coinbase'].map(ex => {
    const st = _state[ex];
    // Use WS data if fresh (< 2s)
    //if (st.wsReady && st.data && now - new Date(st.data.ts).getTime() < 2000) {
    if (st.wsReady && st.data && now - new Date(st.data.ts).getTime() < STALE_WS_MS) {
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
  getBinanceDepth: () => _state.Binance.depth,
  isWsConnected:   () => _state.Binance.wsReady || _state.Kraken.wsReady || _state.Bybit.wsReady,
  wsStatus: () => ({
    Binance:  _state.Binance.wsReady,
    Kraken:   _state.Kraken.wsReady,
    Bybit:    _state.Bybit.wsReady,
    Coinbase: false, // HTTP only
  }),
};

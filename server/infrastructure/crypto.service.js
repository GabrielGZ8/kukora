// ─── In-memory cache ─────────────────────────────────────────────────────
const { logger } = require('./logger');
const _memCache = {};
const cached = (key, ttlMs, fn) => {
  const now = Date.now();
  if (_memCache[key] && (now - _memCache[key].ts) < ttlMs) {
    return Promise.resolve(_memCache[key].data);
  }
  // If a request for this key is already in-flight, wait for it
  if (_memCache[key + '_pending']) return _memCache[key + '_pending'];
  const promise = fn().then(data => {
    _memCache[key] = { data, ts: Date.now() };
    delete _memCache[key + '_pending'];
    return data;
  }).catch(err => {
    delete _memCache[key + '_pending'];
    // On error, return stale data if available rather than throwing
    if (_memCache[key]) {
      logger.warn('cache', 'Using stale data', { key });
      return _memCache[key].data;
    }
    throw err;
  });
  _memCache[key + '_pending'] = promise;
  return promise;
};

// ─── Crypto Service ── CoinGecko, sin API key, cache en memoria ───────────

// ─── CoinGecko request queue — prevents 429 rate limit ───────────────────
const _queue = [];
let _running = false;

const enqueue = (fn) => new Promise((resolve, reject) => {
  _queue.push({ fn, resolve, reject });
  if (!_running) processQueue();
});

const processQueue = async () => {
  if (_running || !_queue.length) return;
  _running = true;
  while (_queue.length) {
    const { fn, resolve, reject } = _queue.shift();
    try { resolve(await fn()); } catch (e) { reject(e); }
    if (_queue.length) await new Promise(r => setTimeout(r, 2500)); // ~24 req/min // ~30 req/min, well under free-tier 50/min
  }
  _running = false;
};


const BASE = 'https://api.coingecko.com/api/v3';
const cache = new Map();

const get = async (url, ttl = 60_000) => {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < ttl) return hit.data;

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (res.status === 429) {
    // Rate limited — always serve stale cache if available (extend TTL by 10min)
    if (hit) {
      hit.ts = Date.now(); // reset TTL so we don't hammer again
      logger.warn('coingecko', '429 rate limited — serving stale cache');
      return hit.data;
    }
    // No cache at all — return empty placeholder so UI doesn't crash
    throw new Error('CoinGecko 429: rate limited, no cached data');
  }
  if (!res.ok) throw new Error(`CoinGecko ${res.status}: ${url}`);
  const data = await res.json();
  cache.set(url, { data, ts: Date.now() });
  return data;
};

const retry = async (fn, n = 2) => {
  for (let i = 0; i <= n; i++) {
    try { return await fn(); }
    catch (e) { if (i === n) throw e; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
  }
};

// ── Derived metrics ───────────────────────────────────────────────────────
const computeMetrics = (coins) => {
  const sorted24h = [...coins].sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h);

  const withVolatility = coins.map(c => {
    const spark = c.sparkline_in_7d?.price || [];
    let vol = 0;
    if (spark.length > 1) {
      const mean = spark.reduce((a, b) => a + b, 0) / spark.length;
      const std = Math.sqrt(spark.reduce((acc, v) => acc + (v - mean) ** 2, 0) / spark.length);
      vol = Math.min(100, Math.round((std / mean) * 1000));
    }
    return { ...c, volatility_score: vol };
  });

  return {
    coins: withVolatility,
    gainers: sorted24h.slice(0, 5),
    losers: sorted24h.slice(-5).reverse(),
  };
};

// ── Exports ───────────────────────────────────────────────────────────────
// Always fetch 100 coins and slice — prevents cache misses when AlertsPage
// requests limit=50 and WatchlistPage requests limit=100 in the same session.
// Both calls now share the single 'markets_100' cache entry.
const getMarkets = (limit = 50) => cached('markets_100', 600_000, async () => {
  const coins = await retry(() => enqueue(() => get(
    `${BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=1h,24h,7d`
    , 180_000
  )));
  return computeMetrics(coins);
}).then(result => {
  // Slice coins array to requested limit while preserving all other fields
  if (limit >= 100 || !result?.coins) return result;
  return { ...result, coins: result.coins.slice(0, limit) };
});

const getGlobal = () => cached('global', 900_000, () =>
  retry(() => enqueue(() => get(`${BASE}/global`, 300_000).then(r => r.data))));

const getTrending = () => cached('trending', 900_000, () =>
  retry(() => enqueue(() => get(`${BASE}/search/trending`, 600_000))));

const getCoinDetail = (id) => cached(`coin_${id}`, 300_000, () =>
  retry(() => enqueue(() => get(`${BASE}/coins/${id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`, 120_000))));

const getOHLC = (id, days = 7) => cached(`ohlc_${id}_${days}`, 600_000, () =>
  retry(() => enqueue(() => get(`${BASE}/coins/${id}/ohlc?vs_currency=usd&days=${days}`, 300_000))));

const getPriceHistory = (id, days = 30) => cached(`history_${id}_${days}`, 600_000, () =>
  retry(() => enqueue(() => get(`${BASE}/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`, 300_000))));

module.exports = { getMarkets, getGlobal, getTrending, getCoinDetail, getOHLC, getPriceHistory };
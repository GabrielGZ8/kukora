const express = require('express');
const router = express.Router();
const crypto = require('../infrastructure/crypto.service');
const { sma, ema, rsi, bollingerBands, macd, drawdown, detectSignals } = require('../domain/analytics/quant');
const analytics = require('../domain/analytics/analytics');
const { detectAnomalies, detectBatch } = require('../domain/analytics/anomalyService');
const { scoreAssets } = require('../domain/engines/scoringService');
const { logger } = require('../infrastructure/logger');
const { ValidationError, UpstreamServiceError, RateLimitError } = require('../domain/errors');

// Q2 (auditoría): consola limpia en producción
const _DEBUG = process.env.DEBUG_KUKORA === '1';
function _err(...args) { if (_DEBUG) logger.error('crypto.routes', String(args[0]), args.length > 1 ? { extra: args.slice(1) } : undefined); }

const handle = (fn) => async (req, res) => {
  try { res.json({ ok: true, data: await fn(req), ts: Date.now() }); }
  catch (err) {
    _err('[crypto]', err.message);
    // DomainError subclasses (ValidationError, etc.) carry their own
    // status/code — respect them instead of guessing from the message.
    // Before this fix, every thrown error fell through to 429/503 checks
    // regardless of type, which meant a typed 400 validation error was
    // indistinguishable from an upstream CoinGecko outage.
    if (err instanceof ValidationError || err instanceof RateLimitError || err instanceof UpstreamServiceError) {
      const body = err.toResponse();
      if (err instanceof RateLimitError) body.isRateLimit = true;
      return res.status(err.status).json(body);
    }
    // Legacy ad-hoc `{ status }` errors from call sites not yet migrated.
    if (err.status) {
      return res.status(err.status).json({ ok: false, error: err.message });
    }
    const isRateLimit = err.message?.includes('429') || err.message?.includes('rate');
    // Return 200 with ok:false so clients can handle gracefully (502 triggers browser error log)
    res.status(isRateLimit ? 429 : 503).json({ ok: false, error: err.message, isRateLimit });
  }
};


// ── Caché en memoria para CoinGecko (evita 429) ───────────────────────────
const CACHE_TTL = 90_000; // 90 segundos
const _cache = new Map();

// Circuit breaker: after a 429 OR repeated failures, block all outbound
// CoinGecko calls for the backoff window before trying again. This prevents
// cascades where many pending requests hammer the API simultaneously.
// I-8 fix: also trips on general outages (5xx, network errors), not just 429s.
let _rateLimitedUntil  = 0;
let _consecutiveFails  = 0;
const RATE_LIMIT_BACKOFF_MS  = 65_000; // 65s for 429 (CoinGecko's 1-min window)
const OUTAGE_BACKOFF_MS      = 30_000; // 30s for 5xx / network errors
const OUTAGE_FAIL_THRESHOLD  = 3;      // open circuit after 3 consecutive failures

function isRateLimited() { return Date.now() < _rateLimitedUntil; }
function markRateLimited(ms = RATE_LIMIT_BACKOFF_MS) {
  _rateLimitedUntil  = Date.now() + ms;
  _consecutiveFails  = 0;
}
function recordSuccess() { _consecutiveFails = 0; }

function cachedCall(key, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return Promise.resolve(hit.data);
  // If we're in a rate-limit/outage window, serve stale data rather than hammering
  if (isRateLimited()) {
    if (hit) return Promise.resolve(hit.data);
    return Promise.reject(new RateLimitError('CoinGecko rate limited — no cached data available'));
  }
  return Promise.resolve(fn()).then(data => {
    _cache.set(key, { data, ts: Date.now() });
    recordSuccess();
    return data;
  }).catch(err => {
    const is429 = err.message?.includes('429') || err.message?.includes('rate');
    // On 429, mark the circuit open AND serve stale if available
    if (is429) {
      markRateLimited(RATE_LIMIT_BACKOFF_MS);
      if (hit) {
        // Refresh the stale entry's timestamp so it stays "warm" during backoff
        hit.ts = Date.now();
        return hit.data;
      }
    } else {
      // I-8 fix: for generic outages (5xx, DNS, network), count consecutive failures
      _consecutiveFails++;
      if (_consecutiveFails >= OUTAGE_FAIL_THRESHOLD) {
        markRateLimited(OUTAGE_BACKOFF_MS);
        if (hit) { hit.ts = Date.now(); return hit.data; }
      } else if (hit) {
        return hit.data; // serve stale while under threshold
      }
    }
    throw err;
  });
}

// ── Existentes ────────────────────────────────────────────────────────────
router.get('/markets', handle(req => { const n = Math.min(Number(req.query.limit) || 50, 500); return cachedCall(`markets_${n}`, () => crypto.getMarkets(n)); }));
router.get('/global', handle(() => cachedCall('global', () => crypto.getGlobal())));
router.get('/trending', handle(() => cachedCall('trending', () => crypto.getTrending())));
// Coin ID sanitization: CoinGecko IDs are lowercase alphanumeric + hyphens only
// (e.g. 'bitcoin', 'usd-coin', 'wrapped-bitcoin'). Strip anything else to
// prevent path traversal or injection via a crafted coin ID in the URL.
function sanitizeCoinId(id) {
  if (typeof id !== 'string') return '';
  return id.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 100);
}

router.get('/coin/:id', handle(req => { const id = sanitizeCoinId(req.params.id); if (!id) throw new ValidationError('Invalid coin id'); return crypto.getCoinDetail(id); }));
router.get('/coin/:id/ohlc', handle(req => { const id = sanitizeCoinId(req.params.id); if (!id) throw new ValidationError('Invalid coin id'); return crypto.getOHLC(id, Number(req.query.days) || 7); }));
router.get('/coin/:id/history', handle(req => { const id = sanitizeCoinId(req.params.id); if (!id) throw new ValidationError('Invalid coin id'); return crypto.getPriceHistory(id, Number(req.query.days) || 30); }));

router.get('/coin/:id/technical', handle(async req => {
  const id = sanitizeCoinId(req.params.id); if (!id) throw new ValidationError('Invalid coin id');
  const days = Number(req.query.days) || 30;
  const hist = await crypto.getPriceHistory(id, days);
  const prices = (hist.prices || []).map(([, p]) => p);
  if (prices.length < 26) throw new ValidationError('Datos insuficientes');

  const sma20 = sma(prices, 20);
  const sma50 = sma(prices, Math.min(50, prices.length));
  const ema20 = ema(prices, 20);
  const rsi14 = rsi(prices, 14);
  const bb = bollingerBands(prices, 20, 2);
  const macdResult = macd(prices);
  const dd = drawdown(prices);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const std = Math.sqrt(prices.reduce((acc, v) => acc + (v - mean) ** 2, 0) / prices.length);
  const ret = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
  const vol = (std / mean) * 100;
  const sharpe = vol ? (ret / vol).toFixed(2) : null;
  const timestamps = (hist.prices || []).map(([ts]) => ts);
  const indicators = { sma20, sma50, ema20, rsi: rsi14, bollinger: bb, macd: macdResult };
  const signals = detectSignals(prices, indicators);
  return { prices, timestamps, indicators, signals, stats: { ret: ret.toFixed(2), vol: vol.toFixed(2), drawdown: dd.toFixed(2), sharpe } };
}));

// ── Analytics layer ───────────────────────────────────────────────────────
// GET /api/crypto/coin/:id/analytics?days=30&window=24h
router.get('/coin/:id/analytics', handle(async req => {
  const id = sanitizeCoinId(req.params.id); if (!id) throw new ValidationError('Invalid coin id');
  const days = Number(req.query.days) || 30;
  const window = req.query.window || null;
  const hist = await crypto.getPriceHistory(id, days);
  let pairs = hist.prices || [];
  if (window && analytics.WINDOWS[window]) pairs = analytics.sliceWindow(pairs, analytics.WINDOWS[window]);
  const prices = pairs.map(([, p]) => p);
  if (prices.length < 3) throw new ValidationError('Datos insuficientes');

  const trend = analytics.trendDetection(prices);
  const mom = analytics.last(analytics.clean(analytics.momentum(prices)));
  const vol = analytics.last(analytics.clean(analytics.volatility(prices)));
  const ret = analytics.totalReturn(prices);
  const dd = analytics.drawdown(prices);
  const sp = analytics.sharpe(prices);
  const pct = analytics.percentageChange(prices);
  const sma7 = analytics.sma(prices, Math.min(7, prices.length));
  const sma20 = analytics.sma(prices, Math.min(20, prices.length));

  return {
    meta: { id: id, days, window, points: prices.length },
    trend,
    metrics: { momentum: +mom?.toFixed(2), volatility: +vol?.toFixed(2), totalReturn: +ret.toFixed(2), drawdown: +dd.toFixed(2), sharpe: sp },
    series: { prices, timestamps: pairs.map(([ts]) => ts), pctChange: pct, sma7, sma20 },
  };
}));

// ── Anomaly detection ─────────────────────────────────────────────────────
// GET /api/crypto/coin/:id/anomaly?days=30
router.get('/coin/:id/anomaly', handle(async req => {
  const id = sanitizeCoinId(req.params.id); if (!id) throw new ValidationError('Invalid coin id');
  const days = Number(req.query.days) || 30;
  const hist = await crypto.getPriceHistory(id, days);
  const prices = (hist.prices || []).map(([, p]) => p);
  return { id: id, ...detectAnomalies(prices) };
}));

// GET /api/crypto/anomalies?coins=bitcoin,ethereum,solana&days=7
// Route-level cache: 5 minutes. The individual getPriceHistory calls inside
// are cached at 10 minutes each, but building the batch still takes 1-2s on
// a cold start. The route cache eliminates that cost on subsequent calls.
const _anomaliesCache = new Map();
const ANOMALIES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

router.get('/anomalies', handle(async req => {
  const ids = (req.query.coins || 'bitcoin,ethereum,solana,binancecoin,ripple').split(',').slice(0, 8);
  const days = Number(req.query.days) || 7;
  const cacheKey = `${ids.join(',')}_${days}`;
  const hit = _anomaliesCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < ANOMALIES_CACHE_TTL) return hit.data;

  // Sequential fetches — not parallel — to avoid triggering CoinGecko's
  // rate limit with 8 simultaneous requests. The per-call cache (600s TTL in
  // crypto.service.js) means subsequent /anomalies calls within 10 minutes
  // cost zero extra API calls. The circuit breaker above also prevents
  // hammering during a known 429 window.
  const assets = [];
  for (const id of ids) {
    try {
      const hist = await crypto.getPriceHistory(id, days);
      assets.push({ id, name: id, prices: (hist.prices || []).map(([, p]) => p) });
    } catch {
      assets.push({ id, name: id, prices: [] });
    }
  }
  const result = detectBatch(assets);
  _anomaliesCache.set(cacheKey, { data: result, ts: Date.now() });
  return result;
}));

// ── Scoring / Ranking ─────────────────────────────────────────────────────
// GET /api/crypto/scores?coins=bitcoin,ethereum&days=30
router.get('/scores', handle(async req => {
  const ids = (req.query.coins || 'bitcoin,ethereum,solana,binancecoin,ripple,cardano,dogecoin,polkadot').split(',').slice(0, 10);
  const days = Number(req.query.days) || 30;
  const weights = req.query.weights ? JSON.parse(req.query.weights) : undefined;

  const mkt = await cachedCall('markets_100', () => crypto.getMarkets(100));
  const mktMap = {};
  (mkt.coins || []).forEach(c => { mktMap[c.id] = c; });

  // Sequential to avoid rate-limiting with 10 parallel CoinGecko calls.
  const assets = [];
  for (const id of ids) {
    try {
      const hist = await crypto.getPriceHistory(id, days);
      const prices = (hist.prices || []).map(([, p]) => p);
      const m = mktMap[id] || {};
      assets.push({ id, name: m.name || id, prices, volume24h: m.total_volume, marketCap: m.market_cap });
    } catch {
      assets.push({ id, name: id, prices: [], volume24h: 0 });
    }
  }
  return scoreAssets(assets, { weights });
}));

// ── Market overview (para IntelligencePage) ───────────────────────────────
// GET /api/crypto/overview — métricas de mercado rápidas para top coins
router.get('/overview', handle(async _req => {
  const mkt = await cachedCall('markets_20', () => crypto.getMarkets(20));
  const coins = mkt.coins || [];

  const summary = coins.map(c => {
    const spark = c.sparkline_in_7d?.price || [];
    const trend = spark.length >= 30 ? analytics.trendDetection(spark) : { trend: 'sideways', label: '→ Lateral', strength: 0 };
    const anom = spark.length >= 5 ? detectAnomalies(spark) : { level: 'low', severityScore: 0 };
    return {
      id: c.id,
      name: c.name,
      symbol: c.symbol?.toUpperCase(),
      image: c.image,
      price: c.current_price,
      change24h: c.price_change_percentage_24h,
      change7d: c.price_change_percentage_7d_in_currency,
      volume24h: c.total_volume,
      marketCap: c.market_cap,
      volatility: c.volatility_score,
      trend: trend.label,
      trendRaw: trend.trend,
      anomaly: { level: anom.level, score: anom.severityScore },
    };
  });

  return {
    coins: summary,
    gainers: [...summary].sort((a, b) => b.change24h - a.change24h).slice(0, 5),
    losers: [...summary].sort((a, b) => a.change24h - b.change24h).slice(0, 5),
    mostVolatile: [...summary].sort((a, b) => b.volatility - a.volatility).slice(0, 5),
    anomalous: summary.filter(c => c.anomaly.level !== 'low').sort((a, b) => b.anomaly.score - a.anomaly.score),
  };
}));

// ── Risk Engine ───────────────────────────────────────────────────────────
const { assetRiskScore, correlationMatrix } = require('../domain/risk/advancedRiskEngine');
const { ensembleForecast, backtest } = require('../domain/analytics/forecastService');
const { marketRegime, supportResistance } = require('../domain/analytics/analytics');

// GET /api/crypto/coin/:id/risk?days=30
router.get('/coin/:id/risk', handle(async req => {
  const id = sanitizeCoinId(req.params.id); if (!id) throw new ValidationError('Invalid coin id');
  const days = Number(req.query.days) || 30;
  const hist = await crypto.getPriceHistory(id, days);
  const prices = (hist.prices || []).map(([, p]) => p);
  if (prices.length < 10) throw new ValidationError('Datos insuficientes');

  const risk = assetRiskScore(prices);
  const regime = marketRegime(prices);
  const sr = supportResistance(prices);
  const forecast = ensembleForecast(prices, 7);
  const bt = backtest(prices, 7);

  return { id: id, days, risk, regime, supportResistance: sr, forecast, backtest: bt };
}));

// GET /api/crypto/correlation?coins=bitcoin,ethereum,solana&days=30
router.get('/correlation', handle(async req => {
  const ids = (req.query.coins || 'bitcoin,ethereum,solana,binancecoin,ripple').split(',').slice(0, 6);
  const days = Number(req.query.days) || 30;

  const assetsMap = {};
  for (const id of ids) {
    try {
      const h = await crypto.getPriceHistory(id, days);
      assetsMap[id] = (h.prices || []).map(([, p]) => p);
    } catch { assetsMap[id] = []; }
  }

  return { ids, days, matrix: correlationMatrix(assetsMap) };
}));

// GET /api/crypto/coin/:id/forecast?days=30&horizon=7
router.get('/coin/:id/forecast', handle(async req => {
  const id = sanitizeCoinId(req.params.id); if (!id) throw new ValidationError('Invalid coin id');
  const days = Number(req.query.days) || 30;
  const horizon = Number(req.query.horizon) || 7;
  const hist = await crypto.getPriceHistory(id, days);
  const prices = (hist.prices || []).map(([, p]) => p);
  const ts = (hist.prices || []).map(([t]) => t);
  if (prices.length < 15) throw new ValidationError('Datos insuficientes');

  const result = ensembleForecast(prices, horizon);
  const bt = backtest(prices, Math.min(horizon, Math.floor(prices.length / 3)));

  return { id: id, lastPrice: prices[prices.length - 1], lastTs: ts[ts.length - 1], prices, timestamps: ts, forecast: result, backtest: bt };
}));

// ── Monte Carlo Simulation ────────────────────────────────────────────────
const { monteCarloGBM } = require('../domain/analytics/simulationService');

// GET /api/crypto/coin/:id/montecarlo?days=30&horizon=30&simulations=500&target=50000
router.get('/coin/:id/montecarlo', handle(async req => {
  const id = sanitizeCoinId(req.params.id); if (!id) throw new ValidationError('Invalid coin id');
  const days = Number(req.query.days) || 30;
  const horizon = Number(req.query.horizon) || 30;
  const simulations = Math.min(Number(req.query.simulations) || 500, 1000);
  const target = req.query.target ? Number(req.query.target) : null;

  const hist = await crypto.getPriceHistory(id, days);
  const prices = (hist.prices || []).map(([, p]) => p);
  if (prices.length < 10) throw new ValidationError('Datos insuficientes');

  const result = monteCarloGBM(prices, horizon, simulations);

  return {
    id: id,
    days,
    horizon,
    simulations,
    S0: result.S0,
    mu: result.mu,
    sigma: result.sigma,
    mean: result.mean,
    expectedReturn: result.expectedReturn,
    percentiles: result.percentiles,
    histogram: result.histogram,
    paths: result.paths,
    probAbove: target != null ? result.probAbove(target) : null,
    probBelow: target != null ? result.probBelow(target) : null,
    target,
  };
}));

// ── Market Regime Engine ──────────────────────────────────────────────────
const { detectMarketRegime, detectMarketRegimeBatch } = require('../domain/engines/marketRegimeEngine');
const { computeKCS } = require('../domain/analytics/kcsService');

// GET /api/crypto/regime?coins=bitcoin,ethereum,solana&days=30
router.get('/regime', handle(async req => {
  const ids = (req.query.coins || 'bitcoin,ethereum,solana,binancecoin,ripple').split(',').slice(0, 6);
  const days = Number(req.query.days) || 30;

  const assetsData = [];
  for (const id of ids) {
    try {
      const h = await crypto.getPriceHistory(id, days);
      assetsData.push({ id, name: id, prices: (h.prices || []).map(([, p]) => p) });
    } catch { assetsData.push({ id, name: id, prices: [] }); }
  }

  const batchResult = await detectMarketRegimeBatch(assetsData);

  // Compute KCS for the batch
  const mkt = await cachedCall('global', () => crypto.getGlobal());
  const btcDom = mkt?.market_cap_percentage?.btc || null;
  const kcs = computeKCS(assetsData, null, btcDom, null);

  return { ...batchResult, kcs, days };
}));

// GET /api/crypto/coin/:id/regime?days=30
router.get('/coin/:id/regime', handle(async req => {
  const id = sanitizeCoinId(req.params.id); if (!id) throw new ValidationError('Invalid coin id');
  const days = Number(req.query.days) || 30;
  const hist = await crypto.getPriceHistory(id, days);
  const prices = (hist.prices || []).map(([, p]) => p);
  return { id: id, regime: detectMarketRegime(prices), days };
}));

// GET /api/crypto/kcs?coins=bitcoin,ethereum,solana&days=30
router.get('/kcs', handle(async req => {
  const ids = (req.query.coins || 'bitcoin,ethereum,solana,binancecoin,ripple,cardano,dogecoin').split(',').slice(0, 8);
  const days = Number(req.query.days) || 30;

  const _kcsAssets = [];
  for (const id of ids) {
    try {
      const h = await crypto.getPriceHistory(id, days);
      _kcsAssets.push({ id, prices: (h.prices || []).map(([, p]) => p) });
    } catch { _kcsAssets.push({ id, prices: [] }); }
  }
  const [assetsData, mkt] = await Promise.all([
    Promise.resolve(_kcsAssets),
    crypto.getGlobal().catch(() => null),
  ]);

  const btcDom = mkt?.market_cap_percentage?.btc || null;
  return computeKCS(assetsData, null, btcDom, null);
}));

// ── Backtest Engine ───────────────────────────────────────────────────────
const { runBacktest, runAllStrategies } = require('../domain/engines/backtestEngine');

// GET /api/crypto/coin/:id/backtest?days=90&strategy=sma_crossover
router.get('/coin/:id/backtest', handle(async req => {
  const id = sanitizeCoinId(req.params.id); if (!id) throw new ValidationError('Invalid coin id');
  const days = Number(req.query.days) || 90;
  const strategy = req.query.strategy || 'sma_crossover';
  const all = req.query.all === 'true';

  const hist = await crypto.getPriceHistory(id, days);
  const prices = (hist.prices || []).map(([, p]) => p);
  const ts = (hist.prices || []).map(([t]) => t);
  if (prices.length < 35) throw new ValidationError('Insufficient data — minimum 35 days required');

  const result = all ? runAllStrategies(prices) : runBacktest(prices, strategy);

  return { id: id, days, strategy, prices, timestamps: ts, ...result };
}));

module.exports = router;
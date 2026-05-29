const express = require('express');
const router  = express.Router();
const crypto  = require('./crypto.service');
const { sma, ema, rsi, bollingerBands, macd, percentageChange, drawdown, detectSignals } = require('./quant');
const analytics = require('./analytics');
const { detectAnomalies, detectBatch } = require('./anomalyService');
const { scoreAssets } = require('./scoringService');

const handle = (fn) => async (req, res) => {
  try { res.json({ ok: true, data: await fn(req), ts: Date.now() }); }
  catch (err) {
    console.error('[crypto]', err.message);
    const isRateLimit = err.message?.includes('429') || err.message?.includes('rate');
    // Return 200 with ok:false so clients can handle gracefully (502 triggers browser error log)
    res.status(isRateLimit ? 429 : 503).json({ ok: false, error: err.message, isRateLimit });
  }
};

// ── Existentes ────────────────────────────────────────────────────────────
router.get('/markets',      handle(req => crypto.getMarkets(Number(req.query.limit) || 50)));
router.get('/global',       handle(() => crypto.getGlobal()));
router.get('/trending',     handle(() => crypto.getTrending()));
router.get('/coin/:id',     handle(req => crypto.getCoinDetail(req.params.id)));
router.get('/coin/:id/ohlc',    handle(req => crypto.getOHLC(req.params.id, Number(req.query.days) || 7)));
router.get('/coin/:id/history', handle(req => crypto.getPriceHistory(req.params.id, Number(req.query.days) || 30)));

router.get('/coin/:id/technical', handle(async req => {
  const days = Number(req.query.days) || 30;
  const hist = await crypto.getPriceHistory(req.params.id, days);
  const prices = (hist.prices || []).map(([, p]) => p);
  if (prices.length < 26) throw new Error('Datos insuficientes');

  const sma20 = sma(prices, 20);
  const sma50 = sma(prices, Math.min(50, prices.length));
  const ema20 = ema(prices, 20);
  const rsi14 = rsi(prices, 14);
  const bb    = bollingerBands(prices, 20, 2);
  const macdResult = macd(prices);
  const dd = drawdown(prices);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const std  = Math.sqrt(prices.reduce((acc, v) => acc + (v - mean) ** 2, 0) / prices.length);
  const ret  = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
  const vol  = (std / mean) * 100;
  const sharpe = vol ? (ret / vol).toFixed(2) : null;
  const timestamps = (hist.prices || []).map(([ts]) => ts);
  const indicators = { sma20, sma50, ema20, rsi: rsi14, bollinger: bb, macd: macdResult };
  const signals = detectSignals(prices, indicators);
  return { prices, timestamps, indicators, signals, stats: { ret: ret.toFixed(2), vol: vol.toFixed(2), drawdown: dd.toFixed(2), sharpe } };
}));

// ── Analytics layer ───────────────────────────────────────────────────────
// GET /api/crypto/coin/:id/analytics?days=30&window=24h
router.get('/coin/:id/analytics', handle(async req => {
  const days   = Number(req.query.days) || 30;
  const window = req.query.window || null;
  const hist   = await crypto.getPriceHistory(req.params.id, days);
  let pairs    = hist.prices || [];
  if (window && analytics.WINDOWS[window]) pairs = analytics.sliceWindow(pairs, analytics.WINDOWS[window]);
  const prices = pairs.map(([, p]) => p);
  if (prices.length < 3) throw new Error('Datos insuficientes');

  const trend = analytics.trendDetection(prices);
  const mom   = analytics.last(analytics.clean(analytics.momentum(prices)));
  const vol   = analytics.last(analytics.clean(analytics.volatility(prices)));
  const ret   = analytics.totalReturn(prices);
  const dd    = analytics.drawdown(prices);
  const sp    = analytics.sharpe(prices);
  const pct   = analytics.percentageChange(prices);
  const sma7  = analytics.sma(prices, Math.min(7,  prices.length));
  const sma20 = analytics.sma(prices, Math.min(20, prices.length));

  return {
    meta: { id: req.params.id, days, window, points: prices.length },
    trend,
    metrics: { momentum: +mom?.toFixed(2), volatility: +vol?.toFixed(2), totalReturn: +ret.toFixed(2), drawdown: +dd.toFixed(2), sharpe: sp },
    series: { prices, timestamps: pairs.map(([ts]) => ts), pctChange: pct, sma7, sma20 },
  };
}));

// ── Anomaly detection ─────────────────────────────────────────────────────
// GET /api/crypto/coin/:id/anomaly?days=30
router.get('/coin/:id/anomaly', handle(async req => {
  const days = Number(req.query.days) || 30;
  const hist = await crypto.getPriceHistory(req.params.id, days);
  const prices = (hist.prices || []).map(([, p]) => p);
  return { id: req.params.id, ...detectAnomalies(prices) };
}));

// GET /api/crypto/anomalies?coins=bitcoin,ethereum,solana&days=7
router.get('/anomalies', handle(async req => {
  const ids  = (req.query.coins || 'bitcoin,ethereum,solana,binancecoin,ripple').split(',').slice(0, 8);
  const days = Number(req.query.days) || 7;
  const assets = await Promise.all(
    ids.map(async id => {
      try {
        const hist = await crypto.getPriceHistory(id, days);
        return { id, name: id, prices: (hist.prices || []).map(([, p]) => p) };
      } catch { return { id, name: id, prices: [] }; }
    })
  );
  return detectBatch(assets);
}));

// ── Scoring / Ranking ─────────────────────────────────────────────────────
// GET /api/crypto/scores?coins=bitcoin,ethereum&days=30
router.get('/scores', handle(async req => {
  const ids     = (req.query.coins || 'bitcoin,ethereum,solana,binancecoin,ripple,cardano,dogecoin,polkadot').split(',').slice(0, 10);
  const days    = Number(req.query.days) || 30;
  const weights = req.query.weights ? JSON.parse(req.query.weights) : undefined;

  const mkt = await crypto.getMarkets(100);
  const mktMap = {};
  (mkt.coins || []).forEach(c => { mktMap[c.id] = c; });

  const assets = await Promise.all(
    ids.map(async id => {
      try {
        const hist = await crypto.getPriceHistory(id, days);
        const prices = (hist.prices || []).map(([, p]) => p);
        const m = mktMap[id] || {};
        return { id, name: m.name || id, prices, volume24h: m.total_volume, marketCap: m.market_cap };
      } catch { return { id, name: id, prices: [], volume24h: 0 }; }
    })
  );
  return scoreAssets(assets, { weights });
}));

// ── Market overview (para IntelligencePage) ───────────────────────────────
// GET /api/crypto/overview — métricas de mercado rápidas para top coins
router.get('/overview', handle(async req => {
  const mkt = await crypto.getMarkets(20);
  const coins = mkt.coins || [];

  const summary = coins.map(c => {
    const spark = c.sparkline_in_7d?.price || [];
    const trend = spark.length >= 30 ? analytics.trendDetection(spark) : { trend: 'sideways', label: '→ Lateral', strength: 0 };
    const anom  = spark.length >= 5  ? detectAnomalies(spark) : { level: 'low', severityScore: 0 };
    return {
      id:    c.id,
      name:  c.name,
      symbol: c.symbol?.toUpperCase(),
      image: c.image,
      price: c.current_price,
      change24h: c.price_change_percentage_24h,
      change7d:  c.price_change_percentage_7d_in_currency,
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
    losers:  [...summary].sort((a, b) => a.change24h - b.change24h).slice(0, 5),
    mostVolatile: [...summary].sort((a, b) => b.volatility - a.volatility).slice(0, 5),
    anomalous: summary.filter(c => c.anomaly.level !== 'low').sort((a, b) => b.anomaly.score - a.anomaly.score),
  };
}));

// ── Risk Engine ───────────────────────────────────────────────────────────
const { assetRiskScore, correlationMatrix } = require('./riskEngine');
const { ensembleForecast, backtest }        = require('./forecastService');
const { marketRegime, supportResistance, valueAtRisk, sortino, calmarRatio } = require('./analytics');

// GET /api/crypto/coin/:id/risk?days=30
router.get('/coin/:id/risk', handle(async req => {
  const days = Number(req.query.days) || 30;
  const hist = await crypto.getPriceHistory(req.params.id, days);
  const prices = (hist.prices || []).map(([, p]) => p);
  if (prices.length < 10) throw new Error('Datos insuficientes');

  const risk    = assetRiskScore(prices);
  const regime  = marketRegime(prices);
  const sr      = supportResistance(prices);
  const forecast= ensembleForecast(prices, 7);
  const bt      = backtest(prices, 7);

  return { id: req.params.id, days, risk, regime, supportResistance: sr, forecast, backtest: bt };
}));

// GET /api/crypto/correlation?coins=bitcoin,ethereum,solana&days=30
router.get('/correlation', handle(async req => {
  const ids  = (req.query.coins || 'bitcoin,ethereum,solana,binancecoin,ripple').split(',').slice(0, 6);
  const days = Number(req.query.days) || 30;

  const assetsMap = {};
  await Promise.all(ids.map(async id => {
    try {
      const h = await crypto.getPriceHistory(id, days);
      assetsMap[id] = (h.prices || []).map(([, p]) => p);
    } catch { assetsMap[id] = []; }
  }));

  return { ids, days, matrix: correlationMatrix(assetsMap) };
}));

// GET /api/crypto/coin/:id/forecast?days=30&horizon=7
router.get('/coin/:id/forecast', handle(async req => {
  const days    = Number(req.query.days) || 30;
  const horizon = Number(req.query.horizon) || 7;
  const hist    = await crypto.getPriceHistory(req.params.id, days);
  const prices  = (hist.prices || []).map(([, p]) => p);
  const ts      = (hist.prices || []).map(([t]) => t);
  if (prices.length < 15) throw new Error('Datos insuficientes');

  const result = ensembleForecast(prices, horizon);
  const bt     = backtest(prices, Math.min(horizon, Math.floor(prices.length / 3)));

  return { id: req.params.id, lastPrice: prices[prices.length - 1], lastTs: ts[ts.length - 1], prices, timestamps: ts, forecast: result, backtest: bt };
}));

// ── Monte Carlo Simulation ────────────────────────────────────────────────
const { monteCarloGBM } = require('./simulationService');

// GET /api/crypto/coin/:id/montecarlo?days=30&horizon=30&simulations=500&target=50000
router.get('/coin/:id/montecarlo', handle(async req => {
  const days        = Number(req.query.days)        || 30;
  const horizon     = Number(req.query.horizon)     || 30;
  const simulations = Math.min(Number(req.query.simulations) || 500, 1000);
  const target      = req.query.target ? Number(req.query.target) : null;

  const hist   = await crypto.getPriceHistory(req.params.id, days);
  const prices = (hist.prices || []).map(([, p]) => p);
  if (prices.length < 10) throw new Error('Datos insuficientes');

  const result = monteCarloGBM(prices, horizon, simulations);

  return {
    id: req.params.id,
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
const { detectMarketRegime, detectMarketRegimeBatch } = require('./marketRegimeEngine');
const { computeKCS } = require('./kcsService');

// GET /api/crypto/regime?coins=bitcoin,ethereum,solana&days=30
router.get('/regime', handle(async req => {
  const ids  = (req.query.coins || 'bitcoin,ethereum,solana,binancecoin,ripple').split(',').slice(0, 6);
  const days = Number(req.query.days) || 30;

  const assetsData = await Promise.all(ids.map(async id => {
    try {
      const h = await crypto.getPriceHistory(id, days);
      return { id, name: id, prices: (h.prices || []).map(([,p]) => p) };
    } catch { return { id, name: id, prices: [] }; }
  }));

  const batchResult = await detectMarketRegimeBatch(assetsData);

  // Compute KCS for the batch
  const mkt = await crypto.getGlobal();
  const btcDom = mkt?.market_cap_percentage?.btc || null;
  const kcs = computeKCS(assetsData, null, btcDom, null);

  return { ...batchResult, kcs, days };
}));

// GET /api/crypto/coin/:id/regime?days=30
router.get('/coin/:id/regime', handle(async req => {
  const days = Number(req.query.days) || 30;
  const hist = await crypto.getPriceHistory(req.params.id, days);
  const prices = (hist.prices || []).map(([,p]) => p);
  return { id: req.params.id, regime: detectMarketRegime(prices), days };
}));

// GET /api/crypto/kcs?coins=bitcoin,ethereum,solana&days=30
router.get('/kcs', handle(async req => {
  const ids  = (req.query.coins || 'bitcoin,ethereum,solana,binancecoin,ripple,cardano,dogecoin').split(',').slice(0, 8);
  const days = Number(req.query.days) || 30;

  const [assetsData, mkt] = await Promise.all([
    Promise.all(ids.map(async id => {
      try {
        const h = await crypto.getPriceHistory(id, days);
        return { id, prices: (h.prices || []).map(([,p]) => p) };
      } catch { return { id, prices: [] }; }
    })),
    crypto.getGlobal().catch(() => null),
  ]);

  const btcDom = mkt?.market_cap_percentage?.btc || null;
  return computeKCS(assetsData, null, btcDom, null);
}));

// ── Backtest Engine ───────────────────────────────────────────────────────
const { runBacktest, runAllStrategies } = require('./backtestEngine');

// GET /api/crypto/coin/:id/backtest?days=90&strategy=sma_crossover
router.get('/coin/:id/backtest', handle(async req => {
  const days     = Number(req.query.days) || 90;
  const strategy = req.query.strategy || 'sma_crossover';
  const all      = req.query.all === 'true';

  const hist   = await crypto.getPriceHistory(req.params.id, days);
  const prices = (hist.prices || []).map(([, p]) => p);
  const ts     = (hist.prices || []).map(([t]) => t);
  if (prices.length < 35) throw new Error('Se necesitan más datos (mínimo 35 días)');

  const result = all ? runAllStrategies(prices) : runBacktest(prices, strategy);

  return { id: req.params.id, days, strategy, prices, timestamps: ts, ...result };
}));

module.exports = router;

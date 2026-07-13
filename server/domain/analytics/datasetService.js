// ─── datasetService.js — análisis de datasets externos (CSV/JSON) ─────────
// Acepta cualquier dataset con columnas {date, price} o {timestamp, close}
// y ejecuta el stack cuantitativo completo de kukora

const { detectMarketRegime } = require('../engines/marketRegimeEngine');
const { computeKCS }         = require('./kcsService');
const { detectAnomalies }    = require('./anomalyService');
const { runBacktest }        = require('../engines/backtestEngine');
const { ensembleForecast }   = require('./forecastService');
const { percentageChange, stdDev, sma, volatility, drawdown, totalReturn, sharpe, clean } = require('./analytics');

// Normalizar columnas de nombre variable → [{ date, price }]
const normalizeRows = (rows) => {
  if (!rows.length) return [];

  // Detectar columna de precio
  const priceKey = Object.keys(rows[0]).find(k =>
    ['price','close','value','adj_close','adjclose','last'].includes(k.toLowerCase().trim())
  ) || Object.keys(rows[0]).find(k => {
    const v = parseFloat(rows[0][k]);
    return !isNaN(v) && v > 0;
  });

  // Detectar columna de fecha
  const dateKey = Object.keys(rows[0]).find(k =>
    ['date','datetime','timestamp','time','day'].includes(k.toLowerCase().trim())
  ) || Object.keys(rows[0])[0];

  // Detectar columna de volumen
  const volKey = Object.keys(rows[0]).find(k =>
    ['volume','vol','quantity'].includes(k.toLowerCase().trim())
  );

  const normalized = rows
    .map(r => ({
      date:   r[dateKey],
      price:  parseFloat(r[priceKey]),
      volume: volKey ? parseFloat(r[volKey]) : null,
    }))
    .filter(r => !isNaN(r.price) && r.price > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  return normalized;
};

// Parse CSV string to array of objects
const parseCSV = (text) => {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
      return obj;
    });
};

// Análisis completo del dataset
const analyzeDataset = (rows) => {
  const normalized = normalizeRows(rows);
  if (normalized.length < 10) {
    return { error: 'Insufficient dataset — at least 10 rows with price columns are required.' };
  }

  const prices  = normalized.map(r => r.price);
  const volumes = normalized.map(r => r.volume).filter(v => v != null && !isNaN(v));
  const returns = clean(percentageChange(prices));

  // ── Stats básicas ──────────────────────────────────────────────────────
  const mean = returns.reduce((a,b)=>a+b,0)/returns.length;
  const std  = stdDev(returns);
  const ddVal = drawdown(prices) || 0;
  const totalRet = totalReturn(prices);
  const sharpeR  = sharpe(prices);
  const vol14raw = volatility(prices, 14);
  const vol14    = Array.isArray(vol14raw) ? (vol14raw.filter(v=>v!=null).pop() || 0) : (vol14raw || 0);

  const stats = {
    rows:       normalized.length,
    startDate:  normalized[0].date,
    endDate:    normalized[normalized.length-1].date,
    startPrice: +prices[0].toFixed(6),
    endPrice:   +prices[prices.length-1].toFixed(6),
    totalReturn: +totalRet.toFixed(3),
    dailyMean:   +mean.toFixed(4),
    dailyStdDev: +std.toFixed(4),
    volatility14:+vol14.toFixed(4),
    maxDrawdown: +Math.abs(ddVal).toFixed(3),
    sharpeRatio: +sharpeR.toFixed(3),
    bestDay:     +Math.max(...returns).toFixed(3),
    worstDay:    +Math.min(...returns).toFixed(3),
    positiveDays: returns.filter(r => r > 0).length,
    negativeDays: returns.filter(r => r < 0).length,
  };

  // ── Modelos cuantitativos ──────────────────────────────────────────────
  const regime   = detectMarketRegime(prices);
  const kcs      = computeKCS([{ id: 'dataset', prices }]);
  const anomaly  = detectAnomalies(prices);
  const forecast = ensembleForecast(prices, 14);
  const btResult = runBacktest(prices, 'sma_crossover');
  const btStrat  = btResult?.strategy || {};
  const btBH     = btResult?.benchmark || {};

  // ── SMA y distribución de retornos ────────────────────────────────────
  const sma20 = sma(prices, 20).filter(v => v != null);
  const sma50 = prices.length >= 50 ? sma(prices, 50).filter(v => v != null) : [];

  // Distribución de retornos en buckets
  const buckets = 20;
  const minR = Math.min(...returns), maxR = Math.max(...returns);
  const step = (maxR - minR) / buckets;
  const dist = Array.from({length: buckets}, (_, i) => {
    const lo = minR + i * step, hi = lo + step;
    return { lo: +lo.toFixed(2), hi: +hi.toFixed(2), count: returns.filter(r => r >= lo && r < hi).length };
  });

  // Normalizar precios a 100 para gráfica
  const normalizedPrices = prices.map(p => +((p / prices[0]) * 100).toFixed(3));
  const normalizedBH     = prices.map(p => +((p / prices[0]) * 100).toFixed(3));

  return {
    meta: { rows: normalized.length, hasVolume: volumes.length > 0 },
    stats,
    regime,
    kcs,
    anomaly,
    forecast: forecast?.forecast || null,
    backtest: {
      strategy: { totalReturn:btStrat.totalReturn, winRate:btStrat.winRate, maxDrawdown:btStrat.maxDrawdown, sharpeRatio:btStrat.sharpeRatio, totalTrades:btStrat.totalTrades },
      buyHold:   { totalReturn:btBH.totalReturn, maxDrawdown:btBH.maxDrawdown },
      equityCurve: (btStrat.equity||[]).map((v, i) => ({
        i,
        strategy: +v.toFixed(2),
        buyHold:  +((prices[i] / prices[0]) * 10000).toFixed(2),
      })).filter((_, i) => i % Math.max(1, Math.floor(prices.length / 200)) === 0),
    },
    chart: {
      prices: normalized.map((r, i) => ({
        date: r.date,
        price: r.price,
        norm: normalizedPrices[i],
        normBH: normalizedBH[i],
        sma20: sma20[i - (prices.length - sma20.length)] ?? null,
        sma50: sma50[i - (prices.length - sma50.length)] ?? null,
      })).filter((_, i) => i % Math.max(1, Math.floor(normalized.length / 300)) === 0),
      returnsDist: dist,
    },
  };
};

module.exports = { parseCSV, normalizeRows, analyzeDataset };

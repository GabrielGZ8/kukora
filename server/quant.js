// ─── quant.js — indicadores técnicos, puro JS sin deps ──────────────────

const sma = (prices, period) => {
  const out = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    const slice = prices.slice(i - period + 1, i + 1);
    out.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return out;
};

const ema = (prices, period) => {
  const k = 2 / (period + 1);
  const out = [];
  let prev = null;
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (prev === null) {
      prev = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
      out.push(prev); continue;
    }
    prev = prices[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
};

const rsi = (prices, period = 14) => {
  const out = Array(period).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return out;
};

const bollingerBands = (prices, period = 20, stdDevMult = 2) => {
  const mid = sma(prices, period);
  const upper = [], lower = [];
  for (let i = 0; i < prices.length; i++) {
    if (mid[i] === null) { upper.push(null); lower.push(null); continue; }
    const slice = prices.slice(i - period + 1, i + 1);
    const mean = mid[i];
    const std = Math.sqrt(slice.reduce((acc, v) => acc + (v - mean) ** 2, 0) / period);
    upper.push(mean + stdDevMult * std);
    lower.push(mean - stdDevMult * std);
  }
  return { upper, middle: mid, lower };
};

const macd = (prices, fast = 12, slow = 26, signalPeriod = 9) => {
  const fastEma = ema(prices, fast);
  const slowEma = ema(prices, slow);
  const macdLine = prices.map((_, i) =>
    fastEma[i] !== null && slowEma[i] !== null ? fastEma[i] - slowEma[i] : null
  );
  const validMacd = macdLine.filter(v => v !== null);
  const rawSignal = ema(validMacd, signalPeriod);
  const signal = Array(macdLine.length - validMacd.length).fill(null).concat(rawSignal);
  const histogram = macdLine.map((v, i) =>
    v !== null && signal[i] !== null ? v - signal[i] : null
  );
  return { macd: macdLine, signal, histogram };
};

const percentageChange = (prices) =>
  prices.map((p, i) => i === 0 ? null : ((p - prices[i - 1]) / prices[i - 1]) * 100);

const drawdown = (prices) => {
  let peak = prices[0], maxDD = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    const dd = (peak - p) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return -(maxDD * 100);
};

const detectSignals = (prices, indicators) => {
  const signals = [];
  const ts = new Date().toISOString();
  const last = prices[prices.length - 1];

  const rsiVal = indicators.rsi.filter(v => v !== null).pop();
  if (rsiVal > 70) signals.push({ type: 'bajista', label: 'Sobrecomprado', desc: `RSI ${rsiVal.toFixed(1)} > 70`, ts });
  else if (rsiVal < 30) signals.push({ type: 'alcista', label: 'Sobrevendido', desc: `RSI ${rsiVal.toFixed(1)} < 30`, ts });

  const upperBB = indicators.bollinger.upper.filter(v => v !== null).pop();
  const lowerBB = indicators.bollinger.lower.filter(v => v !== null).pop();
  if (last > upperBB) signals.push({ type: 'neutral', label: 'Zona de resistencia', desc: 'Precio sobre banda superior', ts });
  else if (last < lowerBB) signals.push({ type: 'neutral', label: 'Zona de soporte', desc: 'Precio bajo banda inferior', ts });

  const hist = indicators.macd.histogram.filter(v => v !== null);
  const n = hist.length;
  if (n >= 2) {
    if (hist[n - 2] < 0 && hist[n - 1] > 0) signals.push({ type: 'alcista', label: 'Señal alcista MACD', desc: 'MACD cruza signal hacia arriba', ts });
    else if (hist[n - 2] > 0 && hist[n - 1] < 0) signals.push({ type: 'bajista', label: 'Señal bajista MACD', desc: 'MACD cruza signal hacia abajo', ts });
  }

  return signals;
};

module.exports = { sma, ema, rsi, bollingerBands, macd, percentageChange, drawdown, detectSignals };

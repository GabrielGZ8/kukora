/**
 * statArbEngine.js — kukora statistical arbitrage v1
 * 
 * Monitors price differentials between exchanges to identify mean-reversion
 * opportunities (Statistical Arbitrage).
 */

const WINDOW_SIZE = 100; // Lookback window for moving average/stddev
const Z_THRESHOLD = 2.0; // Standard deviations for trade signal

const history = new Map(); // pairKey -> priceDiffHistory[]

function updateHistory(buyEx, sellEx, diff) {
  const key = `${buyEx}-${sellEx}`;
  if (!history.has(key)) history.set(key, []);
  
  const h = history.get(key);
  h.push({ diff, ts: Date.now() });
  
  if (h.length > WINDOW_SIZE) h.shift();
}

function calculateZScore(buyEx, sellEx, currentDiff) {
  const key = `${buyEx}-${sellEx}`;
  const h = history.get(key);
  
  if (!h || h.length < 20) return null; // Need enough data
  
  const values = h.map(i => i.diff);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  
  if (stdDev === 0) return 0;
  
  const zScore = (currentDiff - mean) / stdDev;
  return { zScore, mean, stdDev };
}

function detectStatArb(orderBooks) {
  const signals = [];
  const valid = orderBooks.filter(ob => ob.bid && ob.ask && !ob.error);
  
  for (let i = 0; i < valid.length; i++) {
    for (let j = 0; j < valid.length; j++) {
      if (i === j) continue;
      
      const buyEx = valid[i];
      const sellEx = valid[j];
      const diff = sellEx.bid - buyEx.ask;
      
      updateHistory(buyEx.exchange, sellEx.exchange, diff);
      const metrics = calculateZScore(buyEx.exchange, sellEx.exchange, diff);
      
      if (metrics && Math.abs(metrics.zScore) > Z_THRESHOLD) {
        signals.push({
          type: 'stat_arb',
          buyExchange: buyEx.exchange,
          sellExchange: sellEx.exchange,
          diff,
          zScore: +metrics.zScore.toFixed(2),
          mean: +metrics.mean.toFixed(2),
          stdDev: +metrics.stdDev.toFixed(2),
          confidence: Math.min(100, Math.abs(metrics.zScore) * 20),
          viable: metrics.zScore > Z_THRESHOLD && diff > 0
        });
      }
    }
  }
  
  return signals;
}

module.exports = {
  detectStatArb
};

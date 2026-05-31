/**
 * marketIntelligence.js — kukora Market Intelligence Panel
 * 
 * Detects Market Regimes, Volatility, and Risk levels.
 * Tracks Exchange Health (WS status, latency, freshness).
 */

const exchangeHealth = new Map();

function updateExchangeHealth(exchange, status, latency) {
  const h = exchangeHealth.get(exchange) || {
    exchange,
    status: 'Disconnected',
    latency: null,
    reconnects: 0,
    lastUpdate: Date.now()
  };
  
  h.status = status;
  h.latency = latency;
  h.lastUpdate = Date.now();
  if (status === 'Reconnecting') h.reconnects++;
  
  exchangeHealth.set(exchange, h);
}

function getExchangeHealth() {
  return Array.from(exchangeHealth.values());
}

function detectRegime(orderBooks) {
  if (!orderBooks || orderBooks.length < 2) return { regime: 'Insufficient Data', risk: 'Unknown', strategy: 'Standby' };
  
  const prices = orderBooks.map(ob => (ob.bid + ob.ask) / 2).filter(p => !isNaN(p));
  if (prices.length < 2) return { regime: 'Insufficient Data', risk: 'Unknown', strategy: 'Standby' };
  
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((s, v) => s + (v - avgPrice) ** 2, 0) / prices.length;
  const stdDev = Math.sqrt(variance);
  const volScore = (stdDev / avgPrice) * 10000; // Normalized basis points
  
  let regime = 'Range Bound';
  let risk = 'Low';
  let strategy = 'Cross Exchange Arbitrage';
  
  if (volScore > 50) {
    regime = 'High Volatility';
    risk = 'High';
    strategy = 'Defensive Arbitrage (Higher Minimum Spread)';
  } else if (volScore > 20) {
    regime = 'Trending / Breaking';
    risk = 'Medium';
    strategy = 'Balanced Arbitrage';
  } else {
    regime = 'Liquidity Compression';
    risk = 'Low';
    strategy = 'Aggressive Arbitrage (Tight Spreads)';
  }
  
  return {
    regime,
    volatility: volScore.toFixed(2),
    risk,
    strategy,
    aiAnalyst: `Market is currently in a ${regime.toLowerCase()} state with a volatility of ${volScore.toFixed(2)} bp. ${strategy} is recommended.`
  };
}

module.exports = {
  updateExchangeHealth,
  getExchangeHealth,
  detectRegime
};

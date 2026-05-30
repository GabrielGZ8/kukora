/**
 * feeConfig.js — centralized fee configuration v5
 * Single source of truth para trading fees, withdrawal fees, slippage.
 *
 * ─── Execution Model: Pre-funded Bilateral ───────────────────────────────────
 * Kukora opera con wallets pre-funded en los 5 exchanges simultáneamente.
 * Cada trade arbitraje ejecuta:
 *   1. Buy BTC en exchange A (gasta USDT)
 *   2. Sell BTC en exchange B (recibe USDT)
 *   → No hay transferencia inter-exchange por trade
 *
 * WITHDRAWAL FEES = costos de rebalanceo periódico (~cada 24h), NO por trade.
 * Solo se deducen trading fees + slippage del P&L por operación.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─── Break-even spreads (0.05 BTC a $100k BTC, taker fees) ──────────────────
 *
 *   Binance → OKX:      0.030%  ← par más competitivo (ambos 0.10% taker)
 *   Binance → Bybit:    0.030%
 *   Binance → Kraken:   0.046%
 *   OKX → Bybit:        0.030%
 *   Kraken → Binance:   0.046%
 *   Cualquier par → Coinbase: >0.080% (fee 0.60% convierte a Coinbase en
 *                              exchange de monitoreo, no de ejecución frecuente)
 *
 *   Con MAKER_FEES activados (FORCE_MAKER_FEES=true):
 *   Binance(maker) → OKX(maker):   0.016%
 *   Binance(maker) → Bybit(maker): 0.009%  ← Bybit maker 0.010%
 *
 *   Con tradeAmount=0.05 BTC (default):
 *   Break-even Binance→OKX: ~0.030% spread bruto antes de slippage
 *   Slippage VWAP estimado con 0.05 BTC en libro Binance: ~$0.10 total (<0.01%)
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Taker trading fees (worst-case, sin descuentos por volumen o token nativo)
const TRADING_FEES = {
  Binance:  0.001,   // 0.10%
  Kraken:   0.0026,  // 0.26%
  Bybit:    0.001,   // 0.10%
  Coinbase: 0.006,   // 0.60% (Advanced Trade, tier <$10k/mes)
  OKX:      0.001,   // 0.10%
};

// Maker trading fees — significativamente más bajos.
// Activa con env FORCE_MAKER_FEES=true o pasando MAKER_FEES al engine.
// Requiere usar limit orders en lugar de market orders (latencia adicional ~100ms).
// Binance con BNB descuento adicional: 0.075% → 0.0375% (no modelado aquí).
const MAKER_FEES = {
  Binance:  0.00075, // 0.075% (0.0375% con BNB discount — usar 0.075% como conservador)
  Kraken:   0.0016,  // 0.16%
  Bybit:    0.00010, // 0.010%
  Coinbase: 0.0000,  // 0.00% maker en Advanced Trade (tier básico)
  OKX:      0.00080, // 0.080%
};

// Withdrawal fees: BTC en BTC, USDT en USDT (flat)
// Representan costo de rebalanceo periódico, amortizado en ~50 trades por ronda.
const WITHDRAWAL_FEES = {
  Binance:  { BTC: 0.0002, USDT: 5  },
  Kraken:   { BTC: 0.0005, USDT: 8  },
  Bybit:    { BTC: 0.0003, USDT: 6  },
  Coinbase: { BTC: 0.0006, USDT: 10 },
  OKX:      { BTC: 0.0002, USDT: 5  },
};

// Fallback slippage cuando no hay libro de órdenes disponible (por lado)
const SLIPPAGE_RATE = 0.0005; // 0.05% por lado

// Rebalancing interval
const REBALANCING_INTERVAL_HOURS = 24;

// Costo estimado de rebalanceo por ronda (informacional)
const REBALANCING_COST_ESTIMATE = {
  'Binance-Bybit':   { btcUSD: 20, usdt: 6,  total: 26 },
  'Binance-OKX':     { btcUSD: 20, usdt: 5,  total: 25 },
  'Binance-Kraken':  { btcUSD: 20, usdt: 8,  total: 28 },
  'Bybit-OKX':       { btcUSD: 30, usdt: 5,  total: 35 },
  'Kraken-Bybit':    { btcUSD: 50, usdt: 6,  total: 56 },
};

module.exports = {
  TRADING_FEES,
  MAKER_FEES,
  WITHDRAWAL_FEES,
  SLIPPAGE_RATE,
  REBALANCING_INTERVAL_HOURS,
  REBALANCING_COST_ESTIMATE,
};
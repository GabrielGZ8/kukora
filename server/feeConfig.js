/**
 * feeConfig.js — centralized fee configuration
 * Single source of truth for trading fees, withdrawal fees, and slippage constants.
 * Import from here instead of from exchangeService or walletManager to avoid
 * circular dependency risks.
 */

// Taker trading fees (maker fees are lower but taker is worst-case)
const TRADING_FEES = {
  Binance:  0.001,   // 0.10%
  Kraken:   0.0026,  // 0.26%
  Bybit:    0.001,   // 0.10%
  Coinbase: 0.006,   // 0.60%
};

// Withdrawal fees: BTC in BTC, USDT in USDT (flat)
const WITHDRAWAL_FEES = {
  Binance:  { BTC: 0.0002, USDT: 5  },
  Kraken:   { BTC: 0.0005, USDT: 8  },
  Bybit:    { BTC: 0.0003, USDT: 6  },
  Coinbase: { BTC: 0.0006, USDT: 10 },
};

// Fallback slippage when no order book depth is available (per side)
const SLIPPAGE_RATE = 0.0005; // 0.05%

module.exports = { TRADING_FEES, WITHDRAWAL_FEES, SLIPPAGE_RATE };

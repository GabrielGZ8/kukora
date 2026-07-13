/**
 * feeConfig.ts — centralized fee configuration v14 (TypeScript — audit fix 1.1)
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
 * ─── Volume Tiers (v14 addition) ─────────────────────────────────────────────
 * Production-grade fee modeling includes volume-based discounts.
 * Use getFeeForVolume(exchange, volumeUSD30d, mode) for precise calculation.
 * The flat constants below remain as conservative defaults (base tier).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * MIGRATION NOTE (audit 1.1): this is the first module migrated to TypeScript
 * per the technical due diligence recommendation. It compiles to the exact
 * same server/feeConfig.js CommonJS output that existed before — every
 * require('./feeConfig') call site across the codebase is unaffected.
 * Run `npm run build:ts` (or `tsc`) after editing this file; never edit
 * server/feeConfig.js directly, it is a generated build artifact.
 *
 * RELOCATION NOTE (Nivel 2 #1 bounded-context reorg, round 12): this file
 * moved from server-types/server/feeConfig.ts to
 * server-types/server/domain/feeConfig.ts so it now compiles to
 * server/domain/feeConfig.js instead. server/feeConfig.js is now a
 * backward-compatible re-export shim (require('./domain/feeConfig')).
 * Never edit server/domain/feeConfig.js directly — it is a generated
 * build artifact; edit this file and run `tsc`.
 */

export type ExchangeName = 'Binance' | 'Kraken' | 'Bybit' | 'Coinbase' | 'OKX';
export type FeeMode = 'maker' | 'taker';

export interface WithdrawalFee {
  BTC: number;
  USDT: number;
  // Item 3 (generalización multipar): antes solo BTC/USDT tenían entradas
  // reales acá — ETH y XRP siempre caían al fallback plano de
  // safeWithdrawalFee() ($6, un valor inventado sin relación a la economía
  // real de esos assets). Ahora tienen su propia entrada por-exchange.
  ETH: number;
  XRP: number;
}

export interface FeeTier {
  min: number;
  maker: number;
  taker: number;
}

export interface RebalancingCostEstimate {
  btcUSD: number;
  usdt: number;
  total: number;
}

export interface WithdrawalFeeBreakdown {
  btcWithdrawalUSD: number;
  usdtWithdrawalUSD: number;
  totalUSD: number;
}

// Taker trading fees — base tier (< $10k/month volume)
export const TRADING_FEES: Record<ExchangeName, number> = {
  Binance:  0.001,   // 0.10%
  Kraken:   0.0026,  // 0.26%
  Bybit:    0.001,   // 0.10%
  Coinbase: 0.006,   // 0.60% (Advanced Trade, tier <$10k/month)
  OKX:      0.001,   // 0.10%
};

// Maker trading fees — base tier
export const MAKER_FEES: Record<ExchangeName, number> = {
  Binance:  0.00075, // 0.075% (no BNB discount — see BNB_DISCOUNT_PCT below)
  Kraken:   0.0016,  // 0.16%
  Bybit:    0.00010, // 0.010%
  Coinbase: 0.0000,  // 0.00% maker on Advanced Trade (base tier)
  OKX:      0.00080, // 0.080%
};

// ─── Volume-tiered fees (v14) ─────────────────────────────────────────────
// Each exchange has 4 tiers keyed by 30-day volume in USD.
// Values: [makerFee, takerFee] fractions (not percentages).
// Sources: official fee schedules as of 2024-Q4.
export const FEE_TIERS: Record<ExchangeName, FeeTier[]> = {
  Binance: [
    // [minVolumeUSD, makerFee, takerFee]
    { min: 0,           maker: 0.00100, taker: 0.00100 }, // VIP 0
    { min: 1_000_000,   maker: 0.00090, taker: 0.00100 }, // VIP 1
    { min: 5_000_000,   maker: 0.00080, taker: 0.00100 }, // VIP 2
    { min: 20_000_000,  maker: 0.00060, taker: 0.00080 }, // VIP 3+
  ],
  Kraken: [
    { min: 0,           maker: 0.00160, taker: 0.00260 }, // Starter
    { min: 50_000,      maker: 0.00140, taker: 0.00240 }, // Intermediate
    { min: 100_000,     maker: 0.00120, taker: 0.00220 }, // Pro
    { min: 250_000,     maker: 0.00100, taker: 0.00200 }, // Elite
  ],
  Bybit: [
    { min: 0,           maker: 0.00010, taker: 0.00100 }, // Regular
    { min: 1_000_000,   maker: 0.00010, taker: 0.00090 }, // Pro 1
    { min: 10_000_000,  maker: 0.00000, taker: 0.00060 }, // Pro 2 (maker rebate!)
  ],
  Coinbase: [
    { min: 0,           maker: 0.00000, taker: 0.00600 }, // <$10k
    { min: 10_000,      maker: 0.00000, taker: 0.00400 }, // $10k-$50k
    { min: 50_000,      maker: 0.00000, taker: 0.00250 }, // $50k-$100k
    { min: 100_000,     maker: 0.00000, taker: 0.00100 }, // >$100k (Advanced)
  ],
  OKX: [
    { min: 0,           maker: 0.00080, taker: 0.00100 }, // Lv1
    { min: 100_000,     maker: 0.00070, taker: 0.00090 }, // Lv2
    { min: 1_000_000,   maker: 0.00050, taker: 0.00070 }, // Lv3
    { min: 10_000_000,  maker: 0.00030, taker: 0.00050 }, // Lv4
  ],
};

/**
 * Get the effective [makerFee, takerFee] for an exchange given 30d volume.
 * @param exchange — exchange name; unknown names fall back to flat TRADING_FEES/MAKER_FEES
 * @param volumeUSD30d — rolling 30-day volume in USD
 * @param mode — 'maker' | 'taker'
 * @param bnbDiscount — Binance BNB fee discount (25% off)
 * @returns fee fraction (e.g. 0.001 = 0.10%)
 */
export function getFeeForVolume(
  exchange: string,
  volumeUSD30d: number = 0,
  mode: FeeMode = 'taker',
  bnbDiscount: boolean = false
): number {
  const tiers = FEE_TIERS[exchange as ExchangeName];
  if (!tiers) {
    return mode === 'maker'
      ? (MAKER_FEES[exchange as ExchangeName] || 0)
      : (TRADING_FEES[exchange as ExchangeName] || 0);
  }

  // Find highest tier the volume qualifies for (tiers are sorted ascending)
  let tier = tiers[0];
  for (const t of tiers) {
    if (volumeUSD30d >= t.min) tier = t;
  }

  let fee = mode === 'maker' ? tier.maker : tier.taker;

  // Binance BNB payment discount: 25% off maker and taker
  if (exchange === 'Binance' && bnbDiscount) {
    fee = fee * 0.75;
  }

  return +fee.toFixed(6);
}

/**
 * Get break-even spread % for a given exchange pair and fee mode.
 * Accounts for both legs (buy fee + sell fee) and both slippage legs.
 * @param buyExchange
 * @param sellExchange
 * @param mode — 'maker' | 'taker'
 * @param slippagePct — per-side slippage %
 * @returns minimum spread % required to break even
 */
export function getBreakEvenSpread(
  buyExchange: string,
  sellExchange: string,
  mode: FeeMode = 'taker',
  slippagePct: number = 0.05
): number {
  const fees = mode === 'maker' ? MAKER_FEES : TRADING_FEES;
  const buyFee  = (fees[buyExchange as ExchangeName]  || 0) * 100;
  const sellFee = (fees[sellExchange as ExchangeName] || 0) * 100;
  return +(buyFee + sellFee + slippagePct * 2).toFixed(4);
}

// Withdrawal fees: BTC in BTC, ETH in ETH, XRP in XRP, USDT in USDT (flat per withdrawal).
// Mismo caveat que ya aplicaba a BTC/USDT: valores de referencia aproximados,
// no fetched en vivo de cada exchange — configurables aquí si cambian.
// ETH/XRP añadidos en item 3 (generalización multipar) con el mismo criterio:
// XRP tiene fees casi nulos en toda la industria (reserve del propio ledger
// es mínimo); ETH ronda 0.001-0.003 ETH según congestión de red.
export const WITHDRAWAL_FEES: Record<ExchangeName, WithdrawalFee> = {
  Binance:  { BTC: 0.0002, USDT: 5,  ETH: 0.001,  XRP: 0.15 },
  Kraken:   { BTC: 0.0005, USDT: 8,  ETH: 0.0015, XRP: 0.20 },
  Bybit:    { BTC: 0.0003, USDT: 6,  ETH: 0.0012, XRP: 0.20 },
  Coinbase: { BTC: 0.0006, USDT: 10, ETH: 0.002,  XRP: 0.25 },
  OKX:      { BTC: 0.0002, USDT: 5,  ETH: 0.001,  XRP: 0.15 },
};

// Fallback slippage when no order book is available (per side)
export const SLIPPAGE_RATE: number = 0.0005; // 0.05% per side

// BNB discount percentage (Binance BNB payment discount)
export const BNB_DISCOUNT_PCT: number = 0.25; // 25% discount on both maker and taker

export const REBALANCING_INTERVAL_HOURS: number = 24;

export const REBALANCING_COST_ESTIMATE: Record<string, RebalancingCostEstimate> = {
  'Binance-Bybit':   { btcUSD: 20, usdt: 6,  total: 26 },
  'Binance-OKX':     { btcUSD: 20, usdt: 5,  total: 25 },
  'Binance-Kraken':  { btcUSD: 20, usdt: 8,  total: 28 },
  'Bybit-OKX':       { btcUSD: 30, usdt: 5,  total: 35 },
  'Kraken-Bybit':    { btcUSD: 50, usdt: 6,  total: 56 },
};

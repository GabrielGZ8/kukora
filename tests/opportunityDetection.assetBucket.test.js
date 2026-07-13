'use strict';

/**
 * opportunityDetection.executeSimulated.assetBucket.test.js — item 3
 * (generalización multipar, post-checkpoint-04).
 *
 * Antes de este fix, `executeSimulated` resolvía el bucket de wallet con
 * `opportunity.asset === 'ETH' ? 'ETH' : 'BTC'` — cualquier asset que no
 * fuera exactamente 'ETH' (incluida XRP) validaba su saldo contra el
 * wallet de BTC. Este test aísla ese único comportamiento, sin depender
 * del resto del pipeline de detección/orquestación.
 */

import { describe, it, expect } from 'vitest';

const { executeSimulated } = require('../server/domain/engines/opportunityDetection');

function baseOpportunity(overrides = {}) {
  return {
    buyExchange: 'Binance', sellExchange: 'Kraken',
    buyPrice: 2.4, sellPrice: 2.42,
    grossProfit: 2, buyFee: 0.1, sellFee: 0.1,
    slippage: 0, withdrawalFeeUSD: 0,
    liquidityOk: true, circuitBreaker: false,
    tradeAmount: 100,
    ...overrides,
  };
}

function walletsWith(xrpBinance, xrpKraken, btcBinance = 1, btcKraken = 1) {
  return {
    USDT: { Binance: 1_000_000, Kraken: 1_000_000 },
    BTC:  { Binance: btcBinance, Kraken: btcKraken },
    XRP:  { Binance: xrpBinance, Kraken: xrpKraken },
  };
}

describe('opportunityDetection.executeSimulated — item 3 asset bucket fix', () => {
  it('validates an XRP opportunity against the XRP bucket, not BTC', () => {
    const wallets = walletsWith(/* Binance */ 50, /* Kraken */ 500, /* BTC */ 1, 1);
    const op = baseOpportunity({ asset: 'XRP' });
    // Sell leg needs 100 XRP from Kraken (which has 500) — should succeed
    // fully at requested amount, proving the check reads wallets.XRP, not
    // wallets.BTC (which only has 1 unit, would have failed a 100-unit ask).
    const result = executeSimulated(op, wallets, 100);
    expect(result.ok).toBe(true);
  });

  it('rejects for insufficient XRP even when BTC has plenty (proves it is not silently checking BTC)', () => {
    // Below the 0.0001 clamp-to-available floor in executeSimulated, so this
    // must actually reject instead of clamping to a tiny valid amount.
    const wallets = walletsWith(/* Binance */ 50, /* Kraken */ 0.00001, /* BTC */ 1000, 1000);
    const op = baseOpportunity({ asset: 'XRP' });
    const result = executeSimulated(op, wallets, 100);
    // Before the fix this would have passed (BTC=1000 on Kraken is plenty);
    // after the fix it must fail because Kraken only has 0.00001 XRP.
    expect(result.ok).toBe(false);
  });

  it('still defaults to BTC when asset is omitted (unchanged legacy behavior)', () => {
    const wallets = walletsWith(0, 0, /* BTC */ 5, 5);
    const op = baseOpportunity({ tradeAmount: 1 }); // no `asset` field
    const result = executeSimulated(op, wallets, 1);
    expect(result.ok).toBe(true); // succeeds against BTC, not the empty XRP bucket
  });
});

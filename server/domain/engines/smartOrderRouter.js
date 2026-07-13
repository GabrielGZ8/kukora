'use strict';

/**
 * smartOrderRouter.js — Kukora (beta)
 *
 * Decides HOW to place each leg of a trade, not just what to trade. This
 * is the "Smart Order Routing" piece from the Fase 1 committee answer —
 * previously Kukora only ever sent plain MARKET orders. It now supports:
 *
 *   - 'market_taker'    (default): plain MARKET order, no price protection.
 *                         Fastest, guaranteed attempt, but exposed to
 *                         whatever price the book gives at execution time.
 *   - 'ioc_protected':   LIMIT order with timeInForce=IOC (Immediate-Or-
 *                         Cancel) at a protected limit price — the real
 *                         "usar IOC" from the committee answer. Fills
 *                         immediately up to that price or better; anything
 *                         that can't fill at that price is cancelled
 *                         instead of resting on the book or taking a worse
 *                         price than the configured slippage tolerance.
 *   - 'post_only_maker': LIMIT_MAKER / PostOnly — never takes, only rests
 *                         as a maker order (lower/rebate fees). No fill
 *                         guarantee, so it is never used for the urgent leg
 *                         of a cross-exchange arb — see `urgent` below.
 *
 * This module only *decides*; the actual order placement uses the
 * `placeOrder(symbol, side, qty, { type, price })` method added to each
 * exchange client in liveExecution.js.
 *
 * CHECKPOINT_13 — evaluado para la migración de contrato Opportunity/Trade
 * (punto 1 de la hoja de ruta) y descartado explícitamente: el único punto
 * de entrada real, decideOrderType(side, referencePrice, opts), no recibe
 * ni un Opportunity ni un Trade — recibe primitivos (side, un precio, un
 * objeto de opciones {policy, urgent}). No hay ningún objeto con forma de
 * dominio que pueda driftear aquí; isOpportunity()/isTrade() no tienen
 * nada que chequear.
 */

const liveConfig = require('../../infrastructure/liveConfig');

const VALID_POLICIES = ['market_taker', 'ioc_protected', 'post_only_maker'];

// Post-only offset from the reference price — small enough to queue near
// the top of the book, large enough not to cross and get auto-rejected by
// the exchange as "would immediately match". Item 2 (config dinámica):
// antes const de módulo fija en 0.0005; ahora liveConfig.get('postOnlyOffsetPct')
// con el mismo default, leído en cada decisión.

/**
 * Decide the order type + (optional) limit price for one leg.
 *
 * @param {'BUY'|'SELL'} side
 * @param {number} referencePrice   price the opportunity was detected/priced at
 * @param {object} [opts]
 * @param {string}  [opts.policy]   override liveConfig.orderExecutionPolicy
 * @param {boolean} [opts.urgent]   true (default) for legs that must land
 *                                  near-simultaneously with a counter-leg
 *                                  (cross-exchange arb) — urgent legs never
 *                                  use post_only_maker, even if that is the
 *                                  configured policy, since a resting maker
 *                                  order might never fill and leave the
 *                                  other leg naked. Pass false for
 *                                  lower-urgency, single-leg entries
 *                                  (e.g. stat-arb) where resting is fine.
 * @returns {{ type: 'MARKET'|'LIMIT_IOC'|'LIMIT_MAKER', price: number|null, reason: string }}
 */
function decideOrderType(side, referencePrice, opts = {}) {
  const policy = opts.policy || liveConfig.get('orderExecutionPolicy');
  const urgent = opts.urgent !== false;

  if (!VALID_POLICIES.includes(policy)) {
    return { type: 'MARKET', price: null, reason: `Unknown policy "${policy}" — falling back to market_taker` };
  }

  if (policy === 'market_taker') {
    return { type: 'MARKET', price: null, reason: 'market_taker: plain market order, no price protection' };
  }

  if (policy === 'post_only_maker') {
    if (urgent) {
      return {
        type: 'MARKET', price: null,
        reason: 'post_only_maker requested but this leg is urgent (cross-exchange arb) — a resting maker order ' +
                'could leave the counter-leg unhedged, so falling back to market_taker for this leg',
      };
    }
    const price = side === 'BUY'
      ? +(referencePrice * (1 - liveConfig.get('postOnlyOffsetPct'))).toFixed(2)
      : +(referencePrice * (1 + liveConfig.get('postOnlyOffsetPct'))).toFixed(2);
    return { type: 'LIMIT_MAKER', price, reason: 'post_only_maker: resting maker order, no taker fee, no fill guarantee' };
  }

  // ioc_protected — take immediately, but never at a worse price than
  // maxSlippagePct beyond the reference price.
  const maxSlippagePct = liveConfig.get('maxSlippagePct') / 100;
  const price = side === 'BUY'
    ? +(referencePrice * (1 + maxSlippagePct)).toFixed(2)
    : +(referencePrice * (1 - maxSlippagePct)).toFixed(2);
  return {
    type: 'LIMIT_IOC', price,
    reason: `ioc_protected: immediate-or-cancel, up to ${(maxSlippagePct * 100).toFixed(2)}% slippage protection from reference price ${referencePrice}`,
  };
}

module.exports = { decideOrderType, VALID_POLICIES };

/**
 * executionJournal.js — Kukora v1
 *
 * Mejora #5: "Execution journal mejorado".
 *
 * El TradeAuditModal ya existe y muestra el desglose de costos de UN trade.
 * Lo que falta es la validación empírica: ¿el modelo de slippage VWAP fue
 * conservador o agresivo comparado con lo que realmente habría pasado al
 * momento de ejecutar?
 *
 * Cómo se mide honestamente, sin inventar datos:
 *   - estimatedSlippage: el slippage que `computeSlippage()` calculó usando
 *     el order book L2 disponible EN EL MOMENTO DE DETECCIÓN (op.slippage).
 *   - actualFillPrice: no tenemos un exchange real ejecutando la orden (esto
 *     es una simulación), así que "real" aquí significa: el bid/ask del
 *     order book L2 en el momento de EJECUCIÓN (unos ms/segundos después de
 *     la detección, una vez pasó por el pipeline de scoring/fingerprint/
 *     cooldown). Esa diferencia temporal es real y mide la misma cosa que
 *     en producción importaría: cuánto se mueve el book entre que detectas
 *     y que ejecutas.
 *   - opportunityAgeAtExecution: ms transcurridos entre la primera vez que
 *     se vio esta oportunidad viable (vía opportunityLifecycle) y el
 *     momento de ejecución real.
 *
 * Esto es honesto sobre su propia naturaleza: no pretende ser "verificación
 * contra un exchange real", sino una validación de cuánto cambia el book
 * entre la detección y la ejecución, que es exactamente la pregunta que
 * importa para decidir si el modelo de slippage es realista.
 */

const MAX_JOURNAL_ENTRIES = 200;
const _journal = []; // rolling buffer, most recent last

/**
 * Call this right when a trade executes. `opportunity` is the object that
 * was detected (with its estimated slippage); `orderBooksAtExec` is the
 * live order books fetched again at execution time (already available in
 * both the event-driven and polling-loop call sites); `trade` is the
 * resulting executed trade object.
 */
function recordExecutionJournalEntry(opportunity, orderBooksAtExec, trade, opportunitySeenAtMs) {
  const buyBookNow  = orderBooksAtExec.find(b => b.exchange === opportunity.buyExchange);
  const sellBookNow = orderBooksAtExec.find(b => b.exchange === opportunity.sellExchange);

  // "Actual" fill reference: the ask/bid as they stand at execution time.
  const actualBuyPrice  = buyBookNow?.ask  ?? opportunity.buyPrice;
  const actualSellPrice = sellBookNow?.bid ?? opportunity.sellPrice;

  // Re-derive what the spread/slippage situation looks like right now vs.
  // what was estimated at detection time.
  const estimatedSlippage = opportunity.slippage || 0;
  const priceMovementBuy  = +(actualBuyPrice  - opportunity.buyPrice).toFixed(2);
  const priceMovementSell = +(actualSellPrice - opportunity.sellPrice).toFixed(2);
  // Positive = price moved against us (buy got more expensive, sell got cheaper)
  const realizedAdverseMovementUSD = +((priceMovementBuy - priceMovementSell) * (trade.amount || 0)).toFixed(4);

  // Was the VWAP model conservative (overestimated slippage vs what actually
  // happened to the book) or aggressive (underestimated it)?
  const verdict = estimatedSlippage === 0
    ? 'sin_datos_l2'
    : realizedAdverseMovementUSD <= estimatedSlippage
      ? 'conservador' // book moved less than the model assumed it would cost
      : 'agresivo';    // book moved more than the model accounted for

  const entry = {
    ts:                       trade.ts || new Date().toISOString(),
    tradeId:                  trade.id,
    pair:                     `${opportunity.buyExchange}→${opportunity.sellExchange}`,
    slippageMethod:           opportunity.slippageMethod,
    estimatedSlippage:        +estimatedSlippage.toFixed(4),
    actualBuyPrice:           +actualBuyPrice.toFixed(2),
    actualSellPrice:          +actualSellPrice.toFixed(2),
    detectedBuyPrice:         opportunity.buyPrice,
    detectedSellPrice:        opportunity.sellPrice,
    realizedAdverseMovementUSD,
    slippageDelta:            +(realizedAdverseMovementUSD - estimatedSlippage).toFixed(4),
    verdict,
    opportunityAgeAtExecutionMs: opportunitySeenAtMs ? Math.max(0, Date.now() - opportunitySeenAtMs) : null,
    netProfit:                trade.netProfit,
  };

  _journal.push(entry);
  if (_journal.length > MAX_JOURNAL_ENTRIES) _journal.shift();
  return entry;
}

function getJournal(limit = 100) {
  return _journal.slice(-limit).reverse();
}

function getJournalSummary() {
  if (!_journal.length) return { count: 0, conservativePct: null, avgSlippageDelta: null };
  const withL2 = _journal.filter(e => e.verdict !== 'sin_datos_l2');
  const conservativeCount = withL2.filter(e => e.verdict === 'conservador').length;
  const avgDelta = withL2.length
    ? withL2.reduce((s, e) => s + e.slippageDelta, 0) / withL2.length
    : null;
  return {
    count: _journal.length,
    withL2Count: withL2.length,
    conservativePct: withL2.length ? +((conservativeCount / withL2.length) * 100).toFixed(1) : null,
    avgSlippageDelta: avgDelta != null ? +avgDelta.toFixed(4) : null,
  };
}

function resetJournal() {
  _journal.length = 0;
}

module.exports = { recordExecutionJournalEntry, getJournal, getJournalSummary, resetJournal };

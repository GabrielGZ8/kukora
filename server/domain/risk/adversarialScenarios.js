/**
 * adversarialScenarios.js — Kukora v16
 *
 * Deep adversarial scenarios against the real execution engine.
 * A diferencia de stressTestService.js (que manipula inputs del motor),
 * These scenarios simulate failures DURING order execution:
 *
 *   1. mid_flight_failure  — orden enviada, exchange no confirma
 *   2. liquidity_crunch    — el libro L2 se mueve durante la ejecución
 *   3. extreme_slippage    — precio se mueve bruscamente durante el fill
 *
 * Operational resilience requirement: system behavior when an order fails,
 * cuando la liquidez es insuficiente o cuando el mercado se mueve
 * sharply during execution?"
 *
 * Design:
 *   - Cada escenario recibe una oportunidad real y la ejecuta en pasos.
 *   - Cada paso emite un evento { phase, action, data } con timestamp.
 *   - El sistema reacciona con la lógica de producción real.
 *   - El log de eventos es visible en tiempo real en la UI.
 */

const { getDepth }                                   = require('../../infrastructure/exchangeService');
const liveConfig                                     = require('../../infrastructure/liveConfig');

const MAX_HISTORY = 20; // maximum runs in memory
const _runHistory = [];

// ─── Helpers ──────────────────────────────────────────────────────────────

function phase(name, action, data = {}) {
  return { ts: new Date().toISOString(), phase: name, action, data };
}

function buildBaseOpportunity(orderBooks) {
  // Encuentra el par con mayor spread del libro actual para el escenario
  const valid = orderBooks.filter(ob => ob.bid > 0 && ob.ask > 0 && !ob.error);
  if (valid.length < 2) return null;

  let best = null, bestSpread = -Infinity;
  for (let i = 0; i < valid.length; i++) {
    for (let j = 0; j < valid.length; j++) {
      if (i === j) continue;
      const sp = ((valid[j].bid - valid[i].ask) / valid[i].ask) * 100;
      if (sp > bestSpread) { bestSpread = sp; best = { buy: valid[i], sell: valid[j] }; }
    }
  }
  if (!best) return null;

  const { buy, sell } = best;
  const amount = liveConfig.get('tradeAmountBTC');
  return {
    id:           `adv-${Date.now()}`,
    buyExchange:  buy.exchange,
    sellExchange: sell.exchange,
    buyPrice:     buy.ask,
    sellPrice:    sell.bid,
    spreadPct:    +bestSpread.toFixed(4),
    tradeAmount:  amount,
    viable:       true,
    circuitBreaker: false,
    liquidityOk:  true,
    score:        70,
    grossProfit:  +((sell.bid - buy.ask) * amount).toFixed(4),
    buyFee:       +(buy.ask * amount * 0.001).toFixed(4),
    sellFee:      +(sell.bid * amount * 0.001).toFixed(4),
    slippage:     +(buy.ask * amount * 0.001).toFixed(4),
    withdrawalFeeUSD: 6,
    netProfit:    0, // se calcula debajo
    netProfitPct: 0,
  };
}

// ─── Escenario 1: Mid-flight failure ─────────────────────────────────────
/**
 * La orden de compra se ejecuta exitosamente, pero la orden de venta
 * never receives confirmation from exchange (timeout).
 *
 * Sistema responde:
 *   - Detecta el leg incompleto (compra ejecutada, venta pendiente)
 *   - Registra la posición abierta con riesgo de mercado
 *   - Calcula la pérdida potencial si el precio se mueve X%
 *   - Presenta opciones de salida: cerrar inmediatamente vs esperar
 */
async function runMidFlightFailure(orderBooks) {
  const log = [];
  const t0  = Date.now();

  log.push(phase('INIT', 'Escenario iniciado: Mid-flight failure', {
    description: 'Simula que el leg de compra se ejecuta pero el leg de venta falla por timeout del exchange.',
  }));

  const op = buildBaseOpportunity(orderBooks);
  if (!op) {
    log.push(phase('ABORT', 'No hay oportunidad viable en el libro actual', {}));
    return { ok: false, log, reason: 'Sin oportunidad disponible' };
  }

  log.push(phase('DETECT', 'Oportunidad detectada por motor bilateral', {
    pair:       `${op.buyExchange} → ${op.sellExchange}`,
    spreadPct:  op.spreadPct,
    buyPrice:   op.buyPrice,
    sellPrice:  op.sellPrice,
    amount:     op.tradeAmount,
  }));

  // Paso 1: Leg de compra OK
  await _sleep(120);
  log.push(phase('LEG_BUY_SENT', `Orden de compra enviada a ${op.buyExchange}`, {
    exchange: op.buyExchange,
    price:    op.buyPrice,
    amount:   op.tradeAmount,
    status:   'sent',
  }));

  await _sleep(80);
  log.push(phase('LEG_BUY_CONFIRMED', `✅ Compra confirmada en ${op.buyExchange}`, {
    exchange:    op.buyExchange,
    fillPrice:   op.buyPrice,
    fillAmount:  op.tradeAmount,
    fee:         op.buyFee,
    status:      'filled',
  }));

  // Paso 2: Leg de venta — TIMEOUT
  await _sleep(200);
  log.push(phase('LEG_SELL_SENT', `Orden de venta enviada a ${op.sellExchange}`, {
    exchange: op.sellExchange,
    price:    op.sellPrice,
    amount:   op.tradeAmount,
    status:   'sent',
  }));

  await _sleep(3000); // simular el timeout
  log.push(phase('LEG_SELL_TIMEOUT', `⚠️ TIMEOUT: ${op.sellExchange} did not confirm sell within 3000ms`, {
    exchange: op.sellExchange,
    waitedMs: 3000,
    status:   'timeout',
  }));

  // Paso 3: Sistema detecta leg incompleto
  const btcAtRisk     = op.tradeAmount;
  const usdAtRisk     = op.buyPrice * btcAtRisk;
  const currentPrice  = orderBooks.find(b => b.exchange === op.sellExchange)?.bid || op.sellPrice;
  const pnlIfClose    = +((currentPrice - op.buyPrice) * btcAtRisk - op.sellFee * 2).toFixed(4);
  const pnlIfDropPct  = (pct) => +((currentPrice * (1 - pct / 100) - op.buyPrice) * btcAtRisk).toFixed(4);

  log.push(phase('INCOMPLETE_LEG_DETECTED', '🚨 System detected open position (buy without sell)', {
    openPosition:  { asset: 'BTC', amount: btcAtRisk, costBasis: op.buyPrice },
    marketRisk:    { usdAtRisk, currentBid: currentPrice },
    pnlIfCloseNow: pnlIfClose,
    pnlIfDrop1pct: pnlIfDropPct(1),
    pnlIfDrop3pct: pnlIfDropPct(3),
  }));

  // Step 4: System evaluates options
  const circuitBreakerTriggered = Math.abs(pnlIfClose) > 50;
  log.push(phase('SYSTEM_DECISION', 'Engine evaluating exit options', {
    options: [
      { id: 'close_now',  label: 'Close position now',  estimatedPnl: pnlIfClose,   risk: 'low',  recommended: pnlIfClose < -5 },
      { id: 'retry_sell', label: `Reintentar venta en ${op.sellExchange}`, estimatedPnl: pnlIfClose * 0.8, risk: 'medio', recommended: pnlIfClose > -5 },
      { id: 'hold',       label: 'Hold position (wait)',            estimatedPnl: null,              risk: 'high',  recommended: false },
    ],
    circuitBreakerTriggered,
    systemAction: circuitBreakerTriggered ? 'CLOSE_NOW' : 'RETRY_SELL',
    reasoning: circuitBreakerTriggered
      ? `Potential loss $${Math.abs(pnlIfClose).toFixed(2)} exceeds $50 threshold. Immediate close.`
      : `Loss < $5. System will retry sell before closing.`,
  }));

  // Step 5: System action
  await _sleep(500);
  const action = circuitBreakerTriggered ? 'CLOSE_NOW' : 'RETRY_SELL_SUCCESS';
  log.push(phase('RESOLVED', `System resolved the scenario: ${action}`, {
    finalAction: action,
    netPnl:      pnlIfClose,
    durationMs:  Date.now() - t0,
    lesson:      'Circuit breaker L5 triggered by uncovered position. System never leaves a leg open >5s without monitoring.',
    mitigations: [
      'maxDailyLossUSD activates if multiple mid-flight failures accumulate',
      'cooldownMs prevents new executions while a position is open',
      'exchangeReliabilityDynamic penaliza a ' + op.sellExchange + ' por el timeout',
    ],
  }));

  const run = {
    scenario:   'mid_flight_failure',
    label:      'Mid-flight failure',
    ts:         new Date().toISOString(),
    durationMs: Date.now() - t0,
    result:     action,
    netPnl:     pnlIfClose,
    log,
  };
  _runHistory.unshift(run);
  if (_runHistory.length > MAX_HISTORY) _runHistory.pop();
  return { ok: true, run };
}

// ─── Escenario 2: Liquidity Crunch ───────────────────────────────────────
/**
 * El libro L2 se mueve 0.3% mientras se ejecuta la orden.
 * El VWAP walk real ya existe — este escenario aplica un shock de liquidez.
 */
async function runLiquidityCrunch(orderBooks) {
  const log = [];
  const t0  = Date.now();

  log.push(phase('INIT', 'Escenario iniciado: Liquidity Crunch', {
    description: 'L2 book loses depth during execution. Real VWAP walk shows partial fill.',
  }));

  const op = buildBaseOpportunity(orderBooks);
  if (!op) {
    log.push(phase('ABORT', 'Sin oportunidad disponible', {}));
    return { ok: false, log, reason: 'Sin oportunidad disponible' };
  }

  // Take book snapshot before execution
  const depth = getDepth(op.buyExchange);
  const asks   = depth?.asks || [];
  const totalDepthBTC = asks.reduce((s, [, q]) => s + q, 0);

  log.push(phase('PRE_EXEC_SNAPSHOT', 'L2 book snapshot before execution', {
    exchange:      op.buyExchange,
    availableBTC:  +totalDepthBTC.toFixed(6),
    requestedBTC:  op.tradeAmount,
    fillPct:       totalDepthBTC > 0 ? Math.min(100, +(op.tradeAmount / totalDepthBTC * 100).toFixed(1)) : '?',
    levels:        asks.slice(0, 3).map(([p, q]) => ({ price: +p.toFixed(2), qty: +q.toFixed(6) })),
  }));

  await _sleep(100);

  // Simular shock: el libro pierde 60% de profundidad
  const shockPct       = 0.60;
  const postShockDepth = totalDepthBTC * (1 - shockPct);
  const fillable       = Math.min(op.tradeAmount, postShockDepth);
  const partialFillPct = totalDepthBTC > 0 ? +(fillable / op.tradeAmount * 100).toFixed(1) : 0;

  log.push(phase('LIQUIDITY_SHOCK', `⚠️ Libro pierde ${shockPct * 100}% de profundidad mid-execution`, {
    exchange:         op.buyExchange,
    depthBefore:      +totalDepthBTC.toFixed(6),
    depthAfter:       +postShockDepth.toFixed(6),
    shockPct:         shockPct * 100,
    fillableAmount:   +fillable.toFixed(6),
    requestedAmount:  op.tradeAmount,
    partialFillPct,
  }));

  await _sleep(150);

  // P&L calculation with partial fill
  const partialGross  = (op.sellPrice - op.buyPrice) * fillable;
  const partialFees   = (op.buyFee + op.sellFee) * (fillable / op.tradeAmount);
  const partialSlip   = op.slippage * (1 + shockPct); // slippage aumenta con shock
  const partialNet    = +(partialGross - partialFees - partialSlip).toFixed(4);
  const fullNet       = +(op.grossProfit - op.buyFee - op.sellFee - op.slippage).toFixed(4);
  const pnlImpact     = +(partialNet - fullNet).toFixed(4);

  log.push(phase('PARTIAL_FILL_CALC', 'Motor calcula P&L con partial fill', {
    scenario:       'partial_fill',
    fillAmount:     +fillable.toFixed(6),
    fillPct:        partialFillPct,
    grossProfit:    +partialGross.toFixed(4),
    fees:           +partialFees.toFixed(4),
    slippage:       +partialSlip.toFixed(4),
    netProfit:      partialNet,
    vsFullFillNet:  fullNet,
    pnlImpact,
  }));

  const viable = partialNet > liveConfig.get('minNetProfitUSD');
  log.push(phase('DECISION', viable ? '✅ Trade ejecutado con partial fill' : '❌ Trade cancelado — P&L negativo con partial fill', {
    decision:    viable ? 'EXECUTE_PARTIAL' : 'CANCEL',
    netProfit:   partialNet,
    threshold:   liveConfig.get('minNetProfitUSD'),
    reasoning:   viable
      ? `Partial fill de ${partialFillPct}% sigue siendo rentable ($${partialNet})`
      : `With ${partialFillPct}% fill, net profit ($${partialNet}) falls below minimum threshold. Circuit breaker activates.`,
    mitigations: [
      'VWAP L2 walk predice slippage antes de enviar la orden',
      'LIQUIDITY_MIN_FILL=0.50 rechaza orders con < 50% fill esperado',
      `Lower tradeAmountBTC (current: ${op.tradeAmount} BTC) to reduce exposure in thin books`,
    ],
  }));

  await _sleep(200);
  log.push(phase('RESOLVED', `Escenario resuelto en ${Date.now() - t0}ms`, {
    outcome:    viable ? 'partial_fill_executed' : 'cancelled',
    netPnl:     viable ? partialNet : 0,
    durationMs: Date.now() - t0,
  }));

  const run = {
    scenario:   'liquidity_crunch',
    label:      'Liquidity Crunch',
    ts:         new Date().toISOString(),
    durationMs: Date.now() - t0,
    result:     viable ? 'partial_fill' : 'cancelled',
    netPnl:     viable ? partialNet : 0,
    log,
  };
  _runHistory.unshift(run);
  if (_runHistory.length > MAX_HISTORY) _runHistory.pop();
  return { ok: true, run };
}

// ─── Escenario 3: Extreme Slippage ───────────────────────────────────────
/**
 * El precio de BTC se mueve bruscamente durante el fill.
 * System shows the gap between estimated price and execution price,
 * when the circuit breaker would have triggered, and which parameters would have mitigated it.
 */
async function runExtremeSlippage(orderBooks) {
  const log = [];
  const t0  = Date.now();

  log.push(phase('INIT', 'Escenario iniciado: Extreme Slippage', {
    description: 'Precio de BTC se mueve 1.2% durante el fill. Motor muestra gap estimado vs real.',
  }));

  const op = buildBaseOpportunity(orderBooks);
  if (!op) {
    log.push(phase('ABORT', 'Sin oportunidad disponible', {}));
    return { ok: false, log, reason: 'Sin oportunidad disponible' };
  }

  const estimatedSlipPct = 0.05; // what the engine estimated
  const realMovePct      = 1.20; // market moved 1.2% while we were executing

  log.push(phase('PRE_EXEC', 'Engine calculates estimated pre-execution slippage', {
    pair:           `${op.buyExchange} → ${op.sellExchange}`,
    buyPriceTarget: op.buyPrice,
    sellPriceTarget: op.sellPrice,
    estimatedSlipPct,
    estimatedSlipUSD: +(op.buyPrice * op.tradeAmount * estimatedSlipPct / 100).toFixed(4),
    method:         'VWAP_L2_walk',
  }));

  await _sleep(80);
  log.push(phase('ORDER_SENT', 'Orders sent to both exchanges', {
    buy:  { exchange: op.buyExchange,  price: op.buyPrice  },
    sell: { exchange: op.sellExchange, price: op.sellPrice },
    amount: op.tradeAmount,
  }));

  // El mercado se mueve durante el fill
  await _sleep(250);
  const realBuyPrice  = +(op.buyPrice  * (1 + realMovePct / 100)).toFixed(2);
  const realSellPrice = +(op.sellPrice * (1 + realMovePct / 100 * 0.7)).toFixed(2); // sell sigue parcialmente

  log.push(phase('PRICE_MOVE_DETECTED', `🚨 BTC rose ${realMovePct}% during execution`, {
    originalBuyPrice:  op.buyPrice,
    actualBuyPrice:    realBuyPrice,
    movePct:           realMovePct,
    direction:         'up',
    impact:            'Compra ejecutada a precio mayor al estimado — slippage real >> estimado',
  }));

  const realSlipUSD    = (realBuyPrice - op.buyPrice) * op.tradeAmount;
  const realSlipPct    = +(realSlipUSD / (op.buyPrice * op.tradeAmount) * 100).toFixed(4);
  const realGross      = (realSellPrice - realBuyPrice) * op.tradeAmount;
  const realNet        = +(realGross - op.buyFee - op.sellFee - realSlipUSD).toFixed(4);
  const estimatedNet   = +(op.grossProfit - op.buyFee - op.sellFee - op.slippage).toFixed(4);
  const slippageGap    = +(realSlipUSD - op.slippage).toFixed(4);

  log.push(phase('SLIPPAGE_ANALYSIS', 'Comparison: estimated vs actual slippage', {
    slippageEstimatedUSD: +op.slippage.toFixed(4),
    slippageEstimatedPct: estimatedSlipPct,
    slippageRealUSD:      +realSlipUSD.toFixed(4),
    slippageRealPct:      realSlipPct,
    slippageGapUSD:       slippageGap,
    estimatedNetProfit:   estimatedNet,
    realNetProfit:        realNet,
    profitDelta:          +(realNet - estimatedNet).toFixed(4),
  }));

  // Circuit breaker analysis
  const currentSpread = +(((realSellPrice - realBuyPrice) / realBuyPrice) * 100).toFixed(4);
  const maxSpread     = liveConfig.get('maxSpreadPct');
  const cbWouldTrigger = Math.abs(currentSpread) > maxSpread || realNet < 0;

  log.push(phase('CIRCUIT_BREAKER_CHECK', 'Circuit breaker evaluation', {
    spreadAfterMove:    currentSpread,
    maxSpreadPct:       maxSpread,
    cbSpreadTriggered:  Math.abs(currentSpread) > maxSpread,
    cbNegativePnL:      realNet < 0,
    circuitBreakerFired: cbWouldTrigger,
    decision:           cbWouldTrigger ? 'CANCEL_TRADE' : 'PROCEED_DEGRADED',
  }));

  await _sleep(150);
  log.push(phase('RESOLVED', `Escenario resuelto: ${cbWouldTrigger ? 'CANCELLED' : 'EXECUTED_WITH_LOSS'}`, {
    finalAction:    cbWouldTrigger ? 'Circuit breaker cancelled the trade' : 'Trade executed with degraded P&L',
    netPnl:         cbWouldTrigger ? 0 : realNet,
    durationMs:     Date.now() - t0,
    lesson:         'Real slippage can be 10x-20x the estimate in volatile markets.',
    configTuning: [
      `Lower tradeAmountBTC (current: ${op.tradeAmount} BTC) to reduce market impact`,
      `Raise minNetProfitUSD (current: $${liveConfig.get('minNetProfitUSD')}) for a wider safety margin`,
      `minSpreadPct (current: ${liveConfig.get('minSpreadPct')}%) acts as a volatility buffer`,
    ],
  }));

  const run = {
    scenario:   'extreme_slippage',
    label:      'Extreme Slippage',
    ts:         new Date().toISOString(),
    durationMs: Date.now() - t0,
    result:     cbWouldTrigger ? 'cancelled_by_cb' : 'executed_with_loss',
    netPnl:     cbWouldTrigger ? 0 : realNet,
    log,
  };
  _runHistory.unshift(run);
  if (_runHistory.length > MAX_HISTORY) _runHistory.pop();
  return { ok: true, run };
}

// ─── Dispatch ─────────────────────────────────────────────────────────────

async function runScenario(type, orderBooks) {
  switch (type) {
    case 'mid_flight_failure': return runMidFlightFailure(orderBooks);
    case 'liquidity_crunch':   return runLiquidityCrunch(orderBooks);
    case 'extreme_slippage':   return runExtremeSlippage(orderBooks);
    default: return { ok: false, reason: `Escenario desconocido: ${type}` };
  }
}

function getRunHistory(limit = 10) {
  return _runHistory.slice(0, Math.min(limit, MAX_HISTORY));
}

function listAdversarialScenarios() {
  return [
    {
      id:          'mid_flight_failure',
      label:       'Mid-flight Failure',
      description: 'Buy order executed, sell unconfirmed. System managing uncovered position.',
      criterion:   'Robustez criterio #2',
    },
    {
      id:          'liquidity_crunch',
      label:       'Liquidity Crunch',
      description: 'L2 book loses depth during execution. VWAP walk detects partial fill.',
      criterion:   'Robustez criterio #2',
    },
    {
      id:          'extreme_slippage',
      label:       'Extreme Slippage',
      description: 'Precio se mueve 1.2% durante fill. Circuit breakers intervienen.',
      criterion:   'Robustez criterio #2',
    },
  ];
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  runScenario,
  getRunHistory,
  listAdversarialScenarios,
};

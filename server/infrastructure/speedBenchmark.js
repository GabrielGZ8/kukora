/**
 * speedBenchmark.js — Kukora v1
 *
 * Mejora #2 del roadmap: "Speed benchmark en tiempo real".
 *
 * El README ya documenta los números teóricos (polling tradicional ~800ms
 * vs Kukora event-driven <30ms), which makes the latency advantage observable in real time
 * debe VER, no solo leer. Este módulo no inventa nada: toma la latencia real
 * y medible de cada feed (exchangeService ya calcula latencyMs = delta entre
 * el timestamp que el exchange puso en su mensaje WS y el momento en que lo
 * procesamos) y la contrasta contra un modelo explícito de "qué hubiera
 * pasado con polling REST cada 800ms" (el intervalo típico usado por bots de
 * arbitraje retail que no usan WebSockets).
 *
 * Métrica clave por exchange:
 *   wsLatencyMs        — latencia real medida (WS event-driven)
 *   pollingDelayMs      — tiempo simulado que un poller de 800ms tardaría en
 *                          "enterarse" de este mismo movimiento de precio,
 *                          asumiendo que el movimiento ocurrió en un instante
 *                          aleatorio dentro del intervalo de polling (peor
 *                          caso esperado = mitad del intervalo, modelo
 *                          estándar de "average wait time" para polling)
 *   advantageMs         — pollingDelayMs - wsLatencyMs (cuánto más rápido es
 *                          Kukora en este caso concreto)
 *
 * Esto no es teatral: es el mismo argumento de always-on bid-ask streaming
 * vs polling, cuantificado con datos reales de la sesión actual.
 */

const POLLING_INTERVAL_MS = 800; // typical interval documented in README for REST polling bots
// Average wait for a Poisson-arrival event under fixed-interval polling = interval / 2.
// This is the standard textbook approximation; we use it instead of pretending
// every poll happens to land exactly when the opportunity appears.
const POLLING_AVG_WAIT_MS = POLLING_INTERVAL_MS / 2;

// Rolling history of per-exchange latency samples for the live benchmark chart.
const MAX_SAMPLES = 120; // ~ a few minutes at one sample/tick
const _history = []; // [{ ts, perExchange: { Binance: {wsLatencyMs, pollingDelayMs, advantageMs}, ... } }]

function computeForExchange(ob) {
  if (!ob || ob.error || ob.bid == null || ob.ask == null) return null;
  const wsLatencyMs = ob.source === 'ws' ? Math.max(0, ob.latencyMs || 0) : null;
  // For HTTP-fallback feeds we don't have a meaningful "event-driven" comparison —
  // they ARE polling, so we report them as such rather than fabricating a WS number.
  const isEventDriven = ob.source === 'ws';
  const effectiveLatency = isEventDriven ? wsLatencyMs : (ob.latencyMs || POLLING_INTERVAL_MS);
  const pollingDelayMs = POLLING_AVG_WAIT_MS + (ob.latencyMs || 0); // network latency still applies on top of the wait
  const advantageMs = isEventDriven ? Math.max(0, pollingDelayMs - effectiveLatency) : 0;

  return {
    exchange:        ob.exchange,
    isEventDriven,
    wsLatencyMs:     effectiveLatency,
    pollingDelayMs:  +pollingDelayMs.toFixed(0),
    advantageMs:     +advantageMs.toFixed(0),
    source:          ob.source,
  };
}

/**
 * Computes the live benchmark snapshot for the current tick's order books.
 * Call this once per tick (event-driven or polling loop) and attach the
 * result to the SSE payload.
 */
function computeBenchmark(orderBooks) {
  const perExchange = {};
  let totalAdvantage = 0;
  let eventDrivenCount = 0;

  for (const ob of orderBooks) {
    const r = computeForExchange(ob);
    if (!r) continue;
    perExchange[r.exchange] = r;
    if (r.isEventDriven) { totalAdvantage += r.advantageMs; eventDrivenCount++; }
  }

  const avgAdvantageMs = eventDrivenCount > 0 ? +(totalAdvantage / eventDrivenCount).toFixed(0) : 0;

  const sample = { ts: Date.now(), perExchange };
  _history.push(sample);
  if (_history.length > MAX_SAMPLES) _history.shift();

  return {
    perExchange,
    avgAdvantageMs,
    pollingIntervalMs: POLLING_INTERVAL_MS,
    pollingAvgWaitMs:  POLLING_AVG_WAIT_MS,
    eventDrivenCount,
    totalExchanges: orderBooks.length,
  };
}

/** Returns the rolling history for the live "speed race" chart. */
function getHistory(n = 60) {
  return _history.slice(-n).map(s => ({
    ts: s.ts,
    ...Object.fromEntries(
      Object.entries(s.perExchange).map(([ex, v]) => [ex, v.wsLatencyMs])
    ),
  }));
}

function resetBenchmark() {
  _history.length = 0;
}

module.exports = { computeBenchmark, getHistory, resetBenchmark, POLLING_INTERVAL_MS, POLLING_AVG_WAIT_MS };

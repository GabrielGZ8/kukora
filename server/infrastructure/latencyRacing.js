/**
 * latencyRacing.js — Kukora v1
 *
 * Mejora #8: "Latency racing visualization".
 *
 * Cuando un movimiento de precio real ocurre en el mercado, los distintos
 * exchanges lo reportan con diferente latencia de propagación. Esta es,
 * literalmente, la razón por la que existe arbitraje: si todos los
 * exchanges reflejaran el precio "real" instantáneamente, no habría
 * divergencia que explotar.
 *
 * Este módulo se suscribe al mismo priceEmitter que ya usa el motor de
 * detección (sin interferir con sus listeners existentes) y agrupa updates
 * de distintos exchanges en "rondas" cuando ocurren dentro de una ventana
 * corta de tiempo — la señal de que probablemente es el mismo movimiento de
 * mercado subyacente propagándose. Registra qué exchange llegó primero y
 * cuántos ms después llegó cada uno de los demás.
 *
 * Heurística de agrupación: un update "abre" una nueva ronda si no hay
 * ronda abierta o si el último update fue hace más de ROUND_WINDOW_MS. Updates
 * que llegan dentro de ROUND_WINDOW_MS desde el primero de la ronda se añaden
 * a esa ronda. La ronda se cierra y se archiva cuando pasa ROUND_WINDOW_MS sin
 * nuevos updates.
 */

const liveConfig = require('./liveConfig');

// Item 2 (config dinámica): antes dos const de módulo fijas. Ahora se leen
// de liveConfig en cada comparación — mismos defaults (400ms / 0.5%), sin
// cambio de comportamiento. Excepción: el setInterval de flushIfStale (ver
// más abajo) fija su período al valor leído en el momento del arranque del
// módulo — un setInterval no puede "hot-reloadear" su propio período sin
// recrearse, así que esa única línea no reacciona a cambios en caliente.

const MAX_ROUNDS = 60;
const _rounds = []; // archived rounds, most recent last

let _currentRound = null; // { startTs, updates: [{exchange, ts, deltaMs, priceChangePct}], lastPrices: {} }
const _lastKnownPrice = {}; // exchange -> mid price, to compute % change per update

function midPrice(bid, ask) {
  return (bid + ask) / 2;
}

function onPriceUpdate({ exchange, bid, ask, ts }) {
  const mid = midPrice(bid, ask);
  const prevMid = _lastKnownPrice[exchange];
  _lastKnownPrice[exchange] = mid;

  if (prevMid == null) return; // first sample for this exchange — nothing to compare yet

  const priceChangePct = Math.abs((mid - prevMid) / prevMid) * 100;
  if (priceChangePct < liveConfig.get('latencyRacingMinPriceChangePct')) return; // ignore noise

  const now = ts || Date.now();

  // Close stale round if window expired
  if (_currentRound && now - _currentRound.updates[_currentRound.updates.length - 1].ts > liveConfig.get('latencyRacingWindowMs')) {
    archiveRound(_currentRound);
    _currentRound = null;
  }

  if (!_currentRound) {
    _currentRound = { startTs: now, updates: [] };
  }

  // Don't double-count the same exchange moving twice within one round
  // (keep only its first move in this round, which is what matters for "who arrived first")
  if (_currentRound.updates.some(u => u.exchange === exchange)) return;

  _currentRound.updates.push({
    exchange,
    ts: now,
    deltaMs: now - _currentRound.startTs,
    priceChangePct: +priceChangePct.toFixed(4),
  });
}

function archiveRound(round) {
  if (round.updates.length < 2) return; // not interesting if only one exchange moved
  _rounds.push({
    startTs: round.startTs,
    leader: round.updates[0].exchange,
    updates: round.updates,
    spanMs: round.updates[round.updates.length - 1].deltaMs,
  });
  if (_rounds.length > MAX_ROUNDS) _rounds.shift();
}

// Periodically flush a round that's been open too long without new updates
// (in case priceUpdate stops arriving for a while).
function flushIfStale() {
  if (_currentRound && Date.now() - _currentRound.updates[_currentRound.updates.length - 1]?.ts > liveConfig.get('latencyRacingWindowMs')) {
    archiveRound(_currentRound);
    _currentRound = null;
  }
}

function attach(priceEmitter) {
  priceEmitter.on('priceUpdate', onPriceUpdate);
  setInterval(flushIfStale, liveConfig.get('latencyRacingWindowMs')).unref?.();
}

function getRounds(limit = 20) {
  return _rounds.slice(-limit).reverse();
}

/** Per-exchange "how often did this exchange lead the race" leaderboard. */
function getLeaderboard() {
  const counts = {};
  for (const r of _rounds) {
    counts[r.leader] = (counts[r.leader] || 0) + 1;
  }
  const total = _rounds.length;
  return Object.entries(counts)
    .map(([exchange, wins]) => ({ exchange, wins, winRatePct: total ? +((wins / total) * 100).toFixed(1) : 0 }))
    .sort((a, b) => b.wins - a.wins);
}

function resetRacing() {
  _rounds.length = 0;
  _currentRound = null;
  for (const k of Object.keys(_lastKnownPrice)) delete _lastKnownPrice[k];
}

module.exports = { attach, getRounds, getLeaderboard, resetRacing };

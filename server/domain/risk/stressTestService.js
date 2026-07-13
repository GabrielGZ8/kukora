/**
 * stressTestService.js — Kukora v1
 *
 * Mejora #9: "Stress test mode".
 *
 * Permite activar manualmente escenarios adversos y observar cómo reacciona
 * el motor REAL (no una simulación de juguete aparte): circuit breakers,
 * liquidez, viabilidad de oportunidades, todo corre con la misma lógica de
 * producción, solo que alimentada con datos de entrada modificados a propósito.
 *
 * Escenarios soportados:
 *   - exchange_down:  un exchange deja de reportar (se elimina del array de
 *                      order books antes de pasarlo a detectOpportunities,
 *                      exactamente como pasaría si su WS se desconectara).
 *   - fee_spike:       multiplica los fees de TODOS los exchanges por un factor
 *                      (vía setStressFeeMultiplier en arbitrageEngine), para
 *                      ver cuántas oportunidades dejan de ser viables.
 *   - flash_crash:     aplica un shock de precio negativo a un exchange
 *                      específico (ej. -3%), para ver si el circuit breaker
 *                      de spread-demasiado-grande se activa correctamente.
 *
 * Diseño: el escenario activo se aplica como una transformación explícita
 * sobre los inputs reales del motor, en cada tick, hasta que se desactiva.
 * No hay ningún dato fabricado en el resultado — solo el input se manipula,
 * la lógica de detección/circuit-breaker es 100% la real de producción.
 */

const { setStressFeeMultiplier, getStressFeeMultiplier } = require('../engines/opportunityDetection');

let _activeScenario = null; // { type, params, activatedAt }

const SCENARIOS = {
  exchange_down: {
    label: 'Exchange down',
    apply: (orderBooks, params) => {
      const target = params?.exchange;
      return orderBooks.filter(ob => ob.exchange !== target);
    },
  },
  fee_spike: {
    label: 'Fees suben',
    apply: (orderBooks) => orderBooks, // no transforma order books; afecta fees via multiplier
  },
  flash_crash: {
    label: 'Flash crash',
    apply: (orderBooks, params) => {
      const target = params?.exchange;
      const dropPct = (params?.dropPct ?? 3) / 100;
      return orderBooks.map(ob => {
        if (ob.exchange !== target || ob.error) return ob;
        const newBid = +(ob.bid * (1 - dropPct)).toFixed(2);
        const newAsk = +(ob.ask * (1 - dropPct)).toFixed(2);
        return {
          ...ob,
          bid: newBid,
          ask: newAsk,
          spread: +(newAsk - newBid).toFixed(2),
          spreadPct: +(((newAsk - newBid) / newAsk) * 100).toFixed(4),
          _stressShock: { type: 'flash_crash', dropPct: params.dropPct ?? 3 },
        };
      });
    },
  },
};

function activateScenario(type, params = {}) {
  if (!SCENARIOS[type]) return { ok: false, reason: `Unknown scenario: ${type}` };

  if (type === 'exchange_down' && !params.exchange) {
    return { ok: false, reason: 'exchange_down requires params.exchange' };
  }
  if (type === 'flash_crash' && !params.exchange) {
    return { ok: false, reason: 'flash_crash requires params.exchange' };
  }

  // Bug real (encontrado leyendo el código, no simulado): si el escenario
  // activo era 'fee_spike' y se llama activateScenario() de nuevo con OTRO
  // tipo sin pasar por deactivateScenario() primero, el multiplicador de
  // fees quedaba pegado — el motor real seguía viendo fees infladas aunque
  // el escenario mostrado en UI ya no fuera 'fee_spike'. Cualquier
  // transición fuera de 'fee_spike' debe limpiar ese side-effect primero,
  // igual que ya hace deactivateScenario().
  if (_activeScenario?.type === 'fee_spike' && type !== 'fee_spike') {
    setStressFeeMultiplier(1);
  }

  _activeScenario = { type, params, activatedAt: Date.now() };

  if (type === 'fee_spike') {
    setStressFeeMultiplier(params.multiplier || 2); // default: fees double
  }

  return { ok: true, scenario: getActiveScenario() };
}

function deactivateScenario() {
  if (_activeScenario?.type === 'fee_spike') {
    setStressFeeMultiplier(1);
  }
  _activeScenario = null;
  return { ok: true };
}

function getActiveScenario() {
  if (!_activeScenario) return null;
  return {
    type:  _activeScenario.type,
    label: SCENARIOS[_activeScenario.type]?.label,
    params: _activeScenario.params,
    activeForMs: Date.now() - _activeScenario.activatedAt,
    feeMultiplier: getStressFeeMultiplier(),
  };
}

/**
 * Apply the active scenario's order-book transformation, if any.
 * Call this right after getOrderBooks() and before detectOpportunities()
 * in both the event-driven handler and the polling loop.
 */
function applyActiveScenario(orderBooks) {
  if (!_activeScenario) return orderBooks;
  const scenario = SCENARIOS[_activeScenario.type];
  if (!scenario) return orderBooks;
  return scenario.apply(orderBooks, _activeScenario.params);
}

function listScenarios() {
  return Object.entries(SCENARIOS).map(([type, s]) => ({ type, label: s.label }));
}

module.exports = {
  activateScenario,
  deactivateScenario,
  getActiveScenario,
  applyActiveScenario,
  listScenarios,
};

'use strict';
/**
 * arbitrageValidation.js — Sesión 19, ítem #16 (MIGRATION_CLEANUP_LOG.md):
 * cierre de los gaps de validación menores en
 * `server/arbitrage/subroutes/config.routes.js` y `.../query.routes.js`
 * identificados en la Sesión 18. Mismo patrón y misma librería (Zod) que
 * `tradingValidation.js` — ver `server/infrastructure/validateRequest.js`
 * para el porqué. Cada schema documenta, junto al campo, qué gap real
 * cierra (no son límites arbitrarios).
 */
const { z } = require('zod');

// POST /api/arbitrage/rebalance/execute
// rebalanceEngine.executeRebalance() ya tiene defensa en profundidad
// (valida asset/from/to contra listas conocidas — ver el comentario en
// rebalanceEngine.js sobre por qué no confía ciegamente en
// `suggestion.viable`), pero antes de esta sesión un `amount`/`fee` no
// numérico llegaba hasta esa función sin que la ruta diera un 400 claro
// primero. `suggestion` es opcional en el body porque la ruta cae a
// `rebalanceEngine.getLastSuggestion()` cuando no se manda.
const RebalanceExecuteBodySchema = z.object({
  suggestion: z
    .object({
      asset:   z.string().trim().min(1).max(10),
      from:    z.string().trim().min(1).max(50),
      to:      z.string().trim().min(1).max(50),
      amount:  z.number().finite().positive(),
      fee:     z.number().finite().min(0).optional(),
      viable:  z.boolean().optional(),
    })
    .passthrough()
    .optional(),
});

// POST /api/arbitrage/adversarial/run
// Gap real encontrado en esta sesión, más grave que "falta validación": el
// handler llamaba `adversarial.runScenario(req.body || {})` — un solo
// argumento, pasando el objeto completo del body como si fuera `type`
// (string). Como `runScenario(type, orderBooks)` compara `type` contra
// strings literales en un switch, un objeto nunca matchea ningún case y
// el endpoint SIEMPRE devolvía `{ ok:false, reason:'Escenario
// desconocido: [object Object]' }` sin ejecutar ningún escenario real —
// la demo de "Robustez ante escenarios adversos" del JudgeGuide estaba
// rota en este endpoint. El fix real (extraer `type` del body y pasar los
// order books reales) vive en config.routes.js; este schema solo asegura
// que `type` sea el string que la función espera antes de llegar ahí.
const AdversarialRunBodySchema = z.object({
  type: z.enum(['mid_flight_failure', 'liquidity_crunch', 'extreme_slippage'], {
    error: 'type must be one of: mid_flight_failure, liquidity_crunch, extreme_slippage',
  }),
});

// POST /api/arbitrage/stress-test/activate
// activateScenario() ya valida `type` contra SCENARIOS conocidos, pero
// `expiresAfterMs` no numérico producía `Math.max(NaN, 1000)` → NaN →
// `setTimeout(fn, NaN)` (Node lo trata como 0ms, expirando el escenario
// de inmediato en vez de respetar la ventana pedida). `multiplier`/
// `dropPct` tampoco se validaban antes de pasar a fee/price shocks.
const StressTestActivateBodySchema = z.object({
  type:           z.string().trim().min(1).max(50),
  exchange:       z.string().trim().min(1).max(50).optional(),
  multiplier:     z.number().finite().positive().optional(),
  dropPct:        z.number().finite().min(0).max(100).optional(),
  expiresAfterMs: z.number().finite().positive().max(5 * 60_000).optional(),
});

// POST /api/arbitrage/risk/circuit-breaker/activate
// Kill switch manual: hasta la auditoria del comite (Sesion 34), el unico
// endpoint expuesto sobre el circuit breaker era el reset - activarlo
// dependia por completo de que un trigger automatico (drawdown, daily
// loss, fallas consecutivas) lo disparara primero. No existia forma de que
// un operador lo detuviera a mano ANTES de que el sistema lo detectara
// solo. `reason` es obligatorio (min 3 caracteres) a proposito: un kill
// switch sin motivo registrado no es auditable - quien lo dispara debe
// dejar constancia de por que, igual que cualquier halt manual en un venue
// real.
const ManualCircuitBreakerActivateBodySchema = z.object({
  reason: z.string().trim().min(3).max(300),
});

// POST /api/arbitrage/arb-backtest/simulate
// `minScore`/`cooldownMs`/`feeMultiplier` sin tipo fluían directo a
// simulateRun() y de ahí a comparaciones numéricas (score >= minScore,
// etc.) — un string como "abc" produce comparaciones siempre-falsas en
// vez de un 400 explícito, el mismo patrón de bug que H-1 cerró en
// trading.routes.js.
const ArbBacktestSimulateBodySchema = z.object({
  minScore:      z.number().finite().min(0).max(100).optional(),
  cooldownMs:    z.number().finite().min(0).optional(),
  feeMultiplier: z.number().finite().positive().optional(),
});

// POST /api/arbitrage/ml/score
// Antes solo `if (!opportunity.buyExchange || !opportunity.sellExchange)`
// (chequeo de verdad, no de tipo) — este schema empezó como un alias directo
// de OpportunitySchema (el mismo que /execute/cross usa), pero eso lo dejaba
// más laxo que el propio type guard isOpportunity() de domain/opportunity.ts
// (que también exige netProfit/spreadPct/viable) — hallazgo menor de
// CHECKPOINT_13. No se puede simplemente endurecer OpportunitySchema en sí
// (ExecuteCrossBodySchema, en tradingValidation.js, la reusa para trades
// reales y esos campos no siempre están presentes ahí antes de scoring) —
// así que /ml/score obtiene su propio schema, extendiendo la base con los
// campos que mlScoringPipeline.scoreOpportunity() realmente necesita leer.
const { OpportunitySchema } = require('./tradingValidation');
const MlScoreBodySchema = OpportunitySchema.extend({
  netProfit: z.number({ error: 'netProfit must be a number' }).finite('netProfit must be finite'),
  spreadPct: z.number({ error: 'spreadPct must be a number' }).finite('spreadPct must be finite'),
  viable:    z.boolean({ error: 'viable must be a boolean' }),
});

module.exports = {
  RebalanceExecuteBodySchema,
  AdversarialRunBodySchema,
  StressTestActivateBodySchema,
  ManualCircuitBreakerActivateBodySchema,
  ArbBacktestSimulateBodySchema,
  MlScoreBodySchema,
};

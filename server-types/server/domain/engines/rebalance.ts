/**
 * rebalance.ts — Shared types for rebalanceEngine.js (auditoría de comité
 * 2026-07-08, hoja de ruta #1). Tercero de los 5 motores nombrados
 * explícitamente en la sección 2 del documento como "sin contrato común"
 * en cerrarse (después de MarketRegimeResult y MultiHopCycle).
 *
 * Compiles to server/domain/engines/rebalance.js.
 *
 * rebalanceEngine.js no se migró completo a TypeScript en esta ronda (es
 * el motor más grande de los 4 restantes con lógica de ejecución real de
 * transferencias — un refactor completo a .ts es un cambio de mayor riesgo
 * que merece su propia sesión dedicada, no un pase apurado). En su lugar,
 * este archivo satélite define los 3 contratos de salida que SÍ tienen
 * consumidores externos reales hoy:
 *   - `server/arbitrage/subroutes/config.routes.js` (3 endpoints HTTP)
 *   - `server/domain/engines/rebalanceScheduler.js` (scheduler automático)
 *
 * DISEÑO: cada interfaz cubre exactamente los campos que
 * `analyzeBalance()`/`suggestRebalance()`/`executeRebalance()` construyen
 * hoy — leído contra el código real, no asumido. `BalanceImbalance` es una
 * unión discriminada por `type` (igual que `DrawdownCheckResult` en
 * advancedRiskEngine); `RebalanceSuggestionResult` y
 * `ExecuteRebalanceResult` son uniones discriminadas por `needed`/`ok`
 * respectivamente, siguiendo el mismo patrón ya usado en el resto del
 * dominio.
 */

export interface RebalanceImbalanceUsdt {
  type:        'usdt_concentration';
  exchange:    string;
  severity:    'high' | 'medium' | 'low';
  description: string;
  excessUSD:   number;
  excessPct:   number;
  currentUSDT: number;
  totalUSDT:   number;
}

export interface RebalanceImbalanceBtc {
  type:         'btc_shortage';
  exchange:     string;
  severity:     'high' | 'medium';
  description:  string;
  shortfallBtc: number;
  shortfallUSD: number;
  currentBtc:   number;
  targetBtc:    number;
}

export type RebalanceImbalance = RebalanceImbalanceUsdt | RebalanceImbalanceBtc;

export interface BalanceByExchange {
  exchange: string;
  usdt:     number;
  btc:      number;
  totalUSD: number;
}

export interface BalanceAnalysis {
  imbalances: RebalanceImbalance[];
  summary: {
    totalUSDT:  number;
    totalBTC:   number;
    totalUSD:   number;
    byExchange: BalanceByExchange[];
  };
  healthy:   boolean;
  highCount: number;
}

export interface RebalanceSuggestionUsdt {
  asset:      'USDT';
  from:       string;
  to:         string;
  amount:     number;
  fee:        number;
  netBenefit: number;
  viable:     boolean;
  reason:     string;
  severity:   'high' | 'medium' | 'low';
  priority:   1 | 2;
}

export interface RebalanceSuggestionBtc {
  asset:      'BTC';
  from:       string;
  to:         string;
  amount:     number;
  amountUSD:  number;
  fee:        number;
  netBenefit: number;
  viable:     boolean;
  reason:     string;
  severity:   'high' | 'medium';
  priority:   1 | 2;
}

export type RebalanceSuggestionItem = RebalanceSuggestionUsdt | RebalanceSuggestionBtc;

export interface RebalanceSuggestionNotNeeded {
  needed:   false;
  analysis: BalanceAnalysis;
  reason:   string;
}

export interface RebalanceSuggestionNeeded {
  needed:      true;
  suggestions: RebalanceSuggestionItem[];
  analysis:    BalanceAnalysis;
  reason:      string;
}

export type RebalanceSuggestionResult = RebalanceSuggestionNotNeeded | RebalanceSuggestionNeeded;

export interface ExecuteRebalanceFail {
  ok:     false;
  reason: string;
}

export interface ExecuteRebalanceOk {
  ok:           true;
  id:           string;
  entry: {
    id:         string;
    ts:         string;
    asset:      'BTC' | 'USDT';
    from:       string;
    to:         string;
    amount:     number;
    fee:        number;
    durationMs: number;
    status:     string;
    suggestion: unknown;
  };
  walletsAfter: unknown;
}

export type ExecuteRebalanceResult = ExecuteRebalanceFail | ExecuteRebalanceOk;

export function isBalanceAnalysis(obj: unknown): obj is BalanceAnalysis {
  if (typeof obj !== 'object' || obj === null) return false;
  const a = obj as Record<string, unknown>;
  return Array.isArray(a.imbalances)
    && typeof a.healthy === 'boolean'
    && typeof a.highCount === 'number'
    && typeof a.summary === 'object' && a.summary !== null
    && typeof (a.summary as Record<string, unknown>).totalUSD === 'number'
    && Array.isArray((a.summary as Record<string, unknown>).byExchange);
}

export function isRebalanceSuggestionResult(obj: unknown): obj is RebalanceSuggestionResult {
  if (typeof obj !== 'object' || obj === null) return false;
  const r = obj as Record<string, unknown>;
  if (typeof r.needed !== 'boolean' || typeof r.reason !== 'string') return false;
  if (!isBalanceAnalysis(r.analysis)) return false;
  if (r.needed === true) return Array.isArray(r.suggestions);
  return true;
}

export function isExecuteRebalanceResult(obj: unknown): obj is ExecuteRebalanceResult {
  if (typeof obj !== 'object' || obj === null) return false;
  const r = obj as Record<string, unknown>;
  if (typeof r.ok !== 'boolean') return false;
  if (r.ok === false) return typeof r.reason === 'string';
  return typeof r.id === 'string' && typeof r.entry === 'object' && r.entry !== null;
}

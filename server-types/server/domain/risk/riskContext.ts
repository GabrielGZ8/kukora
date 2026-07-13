/**
 * riskContext.ts — shared `RiskContext` domain type (audit committee,
 * sección 12, punto 1).
 *
 * CONTEXTO: la auditoría pide `Opportunity`, `Trade`, y `RiskContext` como
 * tipos de dominio únicos importados por los 10+ motores en vez de que
 * cada uno arme su propia forma. `Opportunity`/`Trade` viven en
 * `./opportunity.ts` (documentan el objeto de detección y el de
 * ejecución). Este archivo agrega el tercero: `RiskContext`, la forma
 * normalizada de "estado de riesgo en este instante" que hoy se calcula
 * dos veces con dos shapes distintas:
 *
 *   - `advancedRiskEngine.getStatus()` — el motor global compartido
 *     (`RiskStatus`, definido en ./advancedRiskEngine.ts), con
 *     `circuitBreaker`/`drawdown` anidados y exposición por exchange.
 *   - `tenantRiskGuard` (server/infrastructure/tenantRiskGuard.js) — el
 *     guard por-tenant, que arma sus propios objetos `{ok, reason}` /
 *     `{active, reason, triggerType, activatedAt}` ad hoc, sin ningún tipo
 *     compartido con el motor global aunque cubre el mismo dominio
 *     (circuit breaker, drawdown, daily-loss) a otro nivel (ver ADR-017:
 *     alcance deliberadamente acotado, no una reescritura per-tenant).
 *
 * `RiskContext` no reemplaza ninguno de los dos — cada uno sigue siendo
 * responsable de su propio estado — es la forma común en la que AMBOS
 * pueden describirse hacia afuera (rutas, tests, futuros motores
 * satélite que hoy leen `advRisk.getStatus()` a mano y confían en su
 * shape interno sin contrato). `fromAdvancedRiskStatus()` adapta el motor
 * global existente a esta forma sin tocar su lógica financiera.
 *
 * Compiles to server/domain/risk/riskContext.js. Never edit that file
 * directly — it is a generated build artifact; edit this file and run
 * `tsc`.
 */

'use strict';

import type { RiskStatus } from './advancedRiskEngine';

// ─── Shape ──────────────────────────────────────────────────────────────────

/**
 * RiskContext — normalized snapshot of "is it safe to trade right now",
 * scoped to either the shared bot (`source: 'global'`, `uid: null`) or a
 * single tenant (`source: 'tenant'`, `uid` set).
 */
export interface RiskContext {
  /** null for the shared/global engine; the tenant's uid otherwise. */
  uid: string | null;

  /** Which risk layer produced this context. */
  source: 'global' | 'tenant';

  circuitBreakerActive: boolean;
  circuitBreakerReason: string | null;

  /** Current drawdown as a percentage, null when not yet computable. */
  drawdownPct: number | null;

  /** Configured drawdown ceiling as a percentage, null when unset. */
  maxDrawdownPct: number | null;

  /** Realized P&L for the current session/day, in USD. */
  sessionPnl: number;

  /** Configured daily loss limit in USD (negative number), null when unset. */
  dailyLossLimitUSD: number | null;

  /** Configured max single-position size in USD, null when unset. */
  maxPositionValueUSD: number | null;

  /** Consecutive losing trades counted toward a losing-streak trip. */
  consecutiveLosses: number;

  /** ISO-8601 timestamp this context was computed. */
  ts: string;
}

// ─── Guard ──────────────────────────────────────────────────────────────────

export function isRiskContext(obj: unknown): obj is RiskContext {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    (o['uid'] === null || typeof o['uid'] === 'string') &&
    (o['source'] === 'global' || o['source'] === 'tenant') &&
    typeof o['circuitBreakerActive'] === 'boolean' &&
    typeof o['sessionPnl'] === 'number' &&
    typeof o['consecutiveLosses'] === 'number' &&
    typeof o['ts'] === 'string'
  );
}

// ─── Constructor ────────────────────────────────────────────────────────────

export function createRiskContext(
  fields: Omit<RiskContext, 'ts' | 'consecutiveLosses'> & Partial<Pick<RiskContext, 'ts' | 'consecutiveLosses'>>,
): RiskContext {
  return {
    consecutiveLosses: 0,
    ...fields,
    ts: fields.ts ?? new Date().toISOString(),
  };
}

// ─── Adapter: global engine → RiskContext ──────────────────────────────────

/**
 * fromAdvancedRiskStatus — adapts advancedRiskEngine.getStatus()'s
 * RiskStatus (nested, engine-specific) to the flat, canonical
 * RiskContext shape. Pure transformation, no side effects, does not touch
 * advancedRiskEngine's own state.
 */
export function fromAdvancedRiskStatus(status: Partial<RiskStatus>): RiskContext {
  return createRiskContext({
    uid: null,
    source: 'global',
    circuitBreakerActive: status.circuitBreaker?.active ?? false,
    circuitBreakerReason: status.circuitBreaker?.reason ?? null,
    drawdownPct: status.drawdown?.pct ?? null,
    maxDrawdownPct: status.drawdown?.maxAllowedPct ?? status.config?.maxDrawdownPct ?? null,
    sessionPnl: status.sessionPnl ?? 0,
    dailyLossLimitUSD: status.dailyLossLimit ?? null,
    maxPositionValueUSD: status.config?.maxPositionValueUSD ?? null,
    consecutiveLosses: status.consecutiveFailures ?? 0,
  });
}

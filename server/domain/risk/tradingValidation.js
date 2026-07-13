'use strict';
/**
 * tradingValidation.js — H-1: schemas Zod para server/routes/trading.routes.js
 *
 * Ver server/infrastructure/validateRequest.js para el porqué de usar Zod
 * aquí (y no en alerts/watchlist/portfolio, que ya tienen su propio
 * validador manual en domain/validation.js).
 *
 * Cada schema documenta, junto al campo, qué gap real cerraba en Sesión 17/18
 * (ver MIGRATION_CLEANUP_LOG.md) — no son límites arbitrarios.
 */
const { z } = require('zod');

// `opportunity` llega desde el motor de detección con ~50+ campos (ver M-3
// en el log — el mismo payload de streaming). No se puede ni se debe exigir
// una forma exacta aquí: eso acoplaría esta validación a cada cambio del
// motor de detección. Se exige únicamente lo que executeCrossExchangeLive()
// necesita para no reventar (buyExchange/sellExchange como strings no
// vacíos, tal como ya asume `(opportunity.buyExchange || '').toLowerCase()`)
// y se deja pasar el resto del objeto sin tocar (`.passthrough()`).
const OpportunitySchema = z
  .object({
    buyExchange: z.string().trim().min(1, 'buyExchange is required').max(50),
    sellExchange: z.string().trim().min(1, 'sellExchange is required').max(50),
  })
  .passthrough();

// amount: antes solo se chequeaba `if (!amount)` (ver comentario en
// validateRequest.js sobre el bug de NaN/negativos en preflightCheck). Se
// exige número real (no coerción desde string — un monto financiero nunca
// debería llegar como texto desde un cliente bien formado) finito, positivo,
// y con un techo de cordura (1e6 unidades del asset base) para que un typo
// no dispare una orden absurda antes de llegar siquiera al preflight real.
const AmountSchema = z
  .number({ error: 'amount must be a number' })
  .finite('amount must be a finite number')
  .positive('amount must be greater than 0')
  .max(1_000_000, 'amount exceeds sanity ceiling (1,000,000)');

const TwoFactorTokenSchema = z.string().trim().min(1).max(20).optional();

const ModeBodySchema = z.object({
  mode: z.enum(['paper', 'live'], { error: "mode must be 'paper' or 'live'" }),
  twoFactorToken: TwoFactorTokenSchema,
});

// exchange/apiKey/apiSecret: antes solo `if (!exchange || !apiKey || !apiSecret)`
// (truthy) — un objeto o array pasaba ese chequeo y llegaba a
// getExchangeClient()/al cliente HTTP real del exchange. No se restringe
// `exchange` a la lista soportada hoy (binance/bybit/kraken) a propósito:
// esa lista vive en liveExecution.js y agregar un exchange nuevo no debería
// requerir tocar dos archivos; getExchangeClient() ya responde con un error
// claro (`Exchange X not supported yet`) si no lo reconoce.
const TestConnectionBodySchema = z.object({
  exchange: z.string().trim().min(1).max(50),
  apiKey: z.string().trim().min(1).max(500),
  apiSecret: z.string().trim().min(1).max(500),
  // Optional: only OKX needs a third credential (the passphrase set when
  // the API key was created). Omitted entirely for the other four
  // exchanges' test-connection calls.
  apiPassphrase: z.string().trim().max(500).optional(),
});

const ExecuteCrossBodySchema = z.object({
  opportunity: OpportunitySchema,
  amount: AmountSchema,
  twoFactorToken: TwoFactorTokenSchema,
});

const TwoFactorTokenBodySchema = z.object({
  token: z.string().trim().min(1, 'token is required').max(20),
});

// pairs/allocation: multiPairService.setUserConfig() ya valida pairs contra
// SUPPORTED_PAIRS y normaliza allocation internamente (ver auditoría de
// Sesión 17/18), así que esto no es un gap de seguridad — pero sin esto un
// `pairs` mal tipado (ej. un string en vez de array) produce el mensaje
// genérico "At least one valid pair required" en vez de decir qué campo
// está mal, y `allocation` con valores no numéricos llega hasta la suma
// (`alloc[p] || 0` los ignora silenciosamente en vez de rechazarlos).
const PairsBodySchema = z.object({
  pairs: z.array(z.string().trim().min(1).max(20)).min(1, 'pairs must be a non-empty array').max(20),
  allocation: z.record(z.string(), z.number().finite().min(0)).optional(),
});

// POST /api/trading/risk-profile (refinamiento post-Sesión 34 — "Profundidad
// y parametrización"): overrides por usuario sobre los límites globales de
// liveConfig, consumidos por userRiskProfileService.js. Cada campo es
// opcional y nullable (`null` explícito = "volver al default global"); los
// bounds mismos que liveConfig.VALIDATORS para que un valor inválido se
// rechace aquí con 400 en vez de llegar hasta `_clampToGlobal()` con un tipo
// inesperado. `activeExchanges`, a diferencia de los demás campos, no tiene
// un límite numérico — se valida como un array no vacío de strings; la
// intersección real contra los exchanges habilitados globalmente ocurre en
// userRiskProfileService (no aquí, para no duplicar esa lista).
const RiskProfileBodySchema = z.object({
  maxPositionValueUSD: z.number().finite().min(100).max(1_000_000).nullable().optional(),
  maxDailyLossUSD:     z.number().finite().max(0).min(-100_000).nullable().optional(),
  maxSlippagePct:      z.number().finite().min(0).max(5).nullable().optional(),
  maxDrawdownPct:      z.number().finite().min(0.1).max(100).nullable().optional(),
  activeExchanges:     z.array(z.string().trim().min(1)).min(1).nullable().optional(),
});

module.exports = {
  ModeBodySchema,
  TestConnectionBodySchema,
  ExecuteCrossBodySchema,
  TwoFactorTokenBodySchema,
  PairsBodySchema,
  RiskProfileBodySchema,
  // Exportado para que arbitrageValidation.js (config/query.routes.js) pueda
  // reusar el mismo schema de forma de oportunidad en vez de duplicarlo
  // (Sesión 19, ítem #16 del log — cierre de gaps de validación).
  OpportunitySchema,
};

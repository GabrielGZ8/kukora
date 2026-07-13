'use strict';
/**
 * validateRequest.js — H-1: schema-based request validation (Zod)
 *
 * CONTEXTO (ver MIGRATION_CLEANUP_LOG.md, Sesión 17/18, H-1): la mayoría de
 * las rutas de persistencia simple (alerts/watchlist/portfolio/arbitrage
 * config) ya tienen validación manual dedicada en `server/domain/validation.js`
 * (ver el comentario ahí: "Deliberately dependency-free... si la superficie
 * crece sustancialmente, revisar"). Esta sesión auditó el resto de las rutas
 * mutantes contra el código real (no de memoria) y encontró una superficie
 * real y sin proteger, concentrada en `trading.routes.js` — el módulo de
 * mayor riesgo financiero del repo:
 *
 *   - `POST /api/trading/execute/cross`: `amount` solo se chequeaba con
 *     `if (!amount)`. Un `amount` no numérico (ej. la string "abc") produce
 *     `NaN` en `requiredUSDT = amount * opportunity.buyPrice` dentro de
 *     `liveExecution.preflightCheck()`, y `usdtBalance < NaN * 1.02` es
 *     `false` en JS — es decir, el chequeo de "saldo insuficiente" quedaba
 *     silenciosamente deshabilitado en vez de fallar. Un `amount` negativo
 *     tiene el mismo problema (comparación con un `requiredUSDT` negativo).
 *   - `opportunity` no tenía ninguna validación de forma: cualquier objeto
 *     (o ausencia de `buyExchange`/`sellExchange` con el tipo correcto)
 *     llegaba hasta `executeCrossExchangeLive()`.
 *   - `exchange`/`apiKey`/`apiSecret` en `/test-connection` solo se
 *     chequeaban por verdad (truthy), no por tipo — un objeto o array ahí
 *     pasa el chequeo `!exchange` y llega a `getExchangeClient()`.
 *
 * Esta superficie (a diferencia de alerts/watchlist/portfolio, que es
 * estable y pequeña) justifica una librería: los payloads de trading tienen
 * más variantes, cambian con cada exchange nuevo, y un error de validación
 * manual aquí tiene consecuencias financieras directas, no solo un 400 mal
 * formado. Se eligió Zod (no Joi/AJV) porque ya es la dirección de Q1
 * (TypeScript como fuente de verdad futura — Zod infiere tipos TS
 * nativamente si el código se migra más adelante) y porque su API declarativa
 * mantiene los schemas junto a las rutas que los usan, igual que
 * `validation.js` mantiene los suyos junto a alerts/watchlist/portfolio.
 *
 * Este archivo NO reemplaza `domain/validation.js` — son dos superficies
 * distintas, cada una con su propia justificación documentada. No fusionar.
 */

/**
 * validateBody(schema) — middleware Express que valida `req.body` contra un
 * schema Zod. Si falla, responde 400 con un mensaje legible (mismo formato
 * `{ ok: false, error: '...' }` que ya usa el resto de la API) y nunca deja
 * que el handler se ejecute. Si pasa, reemplaza `req.body` por el valor ya
 * parseado/limpiado (Zod descarta claves no declaradas salvo `.passthrough()`
 * explícito), igual que `validation.js` hace con su `value` de salida.
 */
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ ok: false, error: formatZodError(result.error) });
    }
    req.body = result.data;
    next();
  };
}

function formatZodError(zodError) {
  return zodError.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : 'body';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

module.exports = { validateBody, formatZodError };

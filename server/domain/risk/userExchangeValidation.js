'use strict';
/**
 * userExchangeValidation.js — checkpoint-37: Zod schemas for the new
 * per-user exchange-credentials and per-user live-mode routes.
 *
 * Mirrors the existing pattern in tradingValidation.js (same library, same
 * `{ ok:false, error }` 400 shape via validateRequest.js's validateBody) —
 * kept in its own file rather than added to tradingValidation.js because
 * these two concerns (a user's own vaulted exchange keys, a user's own
 * live-mode toggle) are a distinct route surface
 * (server/routes/userExchangeCredentials.routes.js,
 * server/routes/userLiveMode.routes.js) from server/routes/trading.routes.js,
 * not because the validation approach differs.
 */
const { z } = require('zod');

// exchange/apiKey/apiSecret: same reasoning as TestConnectionBodySchema in
// tradingValidation.js — reject non-string/empty values before they reach
// liveExecution.testExchangeConnection() or the vault's encrypt() calls.
// `exchange` is intentionally not restricted to an enum here for the same
// reason as tradingValidation.js: that list lives in liveExecution.js
// (getExchangeClient()), which already answers with a clear error for an
// unsupported exchange — duplicating the list here would mean two places
// to update when a new exchange is added.
const ExchangeCredentialsBodySchema = z.object({
  exchange: z.string().trim().min(1, 'exchange is required').max(50),
  apiKey: z.string().trim().min(1, 'apiKey is required').max(500),
  apiSecret: z.string().trim().min(1, 'apiSecret is required').max(500),
  // Only OKX needs a third credential (the passphrase set when the API key
  // was created) — optional for the other four exchanges.
  apiPassphrase: z.string().trim().max(500).optional(),
});

// disclaimerAccepted: MUST be the literal boolean `true` — not merely
// "truthy" (a string like "true" or a pre-checked value the client sends
// by default would defeat the whole point of an explicit, un-pre-checked
// confirmation step described in the product requirements). z.literal(true)
// rejects anything else, including `false`, missing, or non-boolean values,
// with a 400 before enableLiveMode() is ever called.
const LiveModeEnableBodySchema = z.object({
  twoFactorToken: z.string().trim().min(1, 'twoFactorToken is required').max(20),
  disclaimerAccepted: z.literal(true, { error: 'disclaimerAccepted must be true — the risk disclaimer must be explicitly accepted' }),
});

module.exports = {
  ExchangeCredentialsBodySchema,
  LiveModeEnableBodySchema,
};

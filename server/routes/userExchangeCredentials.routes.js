'use strict';

/**
 * userExchangeCredentials.routes.js — checkpoint-37
 *
 * HTTP surface for server/infrastructure/userSecretsVault.js — lets an
 * authenticated user connect/rotate/disconnect THEIR OWN exchange API
 * credentials, instead of the platform operator being the only one able
 * to set exchange keys (previously only possible via env vars / a manual
 * script against the global secretsVault.js).
 *
 *   GET    /api/user/exchange-credentials            — list connected exchanges (name + connectedAt only, never keys)
 *   POST   /api/user/exchange-credentials             — connect/rotate a key for one exchange
 *   DELETE /api/user/exchange-credentials/:exchange    — disconnect (delete) a connected exchange
 *
 * Security-critical ordering in POST, per the original product spec:
 *   1. validateBody — reject malformed payloads before anything else.
 *   2. liveExecution.testExchangeConnection() — confirm the key actually
 *      works against the real exchange BEFORE persisting anything.
 *   3. liveExecution.checkWithdrawalPermission() — refuse to store a key
 *      that has withdrawal permission enabled. If the exchange has no way
 *      to verify this programmatically (e.g. Kraken), we do NOT hard-block
 *      (that would make the exchange unusable) — we save the key but
 *      surface a clear `warning` in the response so the user can verify
 *      manually on the exchange's own dashboard. This is a real,
 *      documented limitation, not something silently assumed safe.
 *   4. Only after both checks pass does userSecretsVault.setUserCredentials()
 *      encrypt and persist the key.
 *
 * The raw apiKey/apiSecret/apiPassphrase are NEVER included in any response
 * body, log line, or error message below — only `exchange` and `connectedAt`
 * (and, for DELETE, whether the entry existed) ever leave this router.
 *
 * All routes require a real authenticated user (requireAuth) — the vault
 * itself is keyed on req.userId, never on anything the client sends, so one
 * user can never read, connect, or delete another user's credentials.
 */

const express = require('express');
const router  = express.Router();

const { requireAuth }   = require('../infrastructure/auth');
const { validateBody }  = require('../infrastructure/validateRequest');
const { ExchangeCredentialsBodySchema } = require('../domain/risk/userExchangeValidation');
const userSecretsVault  = require('../infrastructure/userSecretsVault');
const liveExecution     = require('../application/liveExecution');
const { sendError }     = require('../infrastructure/errorResponse');

// ─── GET / — list connected exchanges ──────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const exchanges = await userSecretsVault.listUserExchanges(req.userId);
    res.json({ ok: true, data: { exchanges } });
  } catch (e) { sendError(res, e); }
});

// ─── POST / — connect or rotate a key for one exchange ─────────────────────
router.post('/', requireAuth, validateBody(ExchangeCredentialsBodySchema), async (req, res) => {
  const { exchange, apiKey, apiSecret, apiPassphrase } = req.body;

  try {
    // 1. Does the key actually authenticate against the real exchange?
    const testResult = await liveExecution.testExchangeConnection(exchange, apiKey, apiSecret, apiPassphrase);
    if (!testResult || !testResult.ok) {
      return res.status(400).json({ ok: false, error: (testResult && testResult.error) || 'Exchange rejected the provided credentials' });
    }

    // 2. Does this key have withdrawal permission? Hard-block only when we
    // can positively confirm it does — an exchange that can't be verified
    // programmatically gets a warning, not a false sense of a passed check.
    const permCheck = await liveExecution.checkWithdrawalPermission(exchange, apiKey, apiSecret, apiPassphrase);
    if (permCheck && permCheck.withdrawalEnabled === true) {
      return res.status(403).json({
        ok: false,
        error: `Refusing to connect: this API key has withdrawal permission enabled. ${permCheck.detail || ''}`.trim(),
      });
    }

    const warning = permCheck && permCheck.verifiable === false
      ? (permCheck.detail || 'Withdrawal permission could not be verified for this exchange — please confirm manually on the exchange dashboard that this key cannot withdraw funds.')
      : null;

    // 3. Only now — after both checks — encrypt and persist.
    const saved = await userSecretsVault.setUserCredentials(
      req.userId, exchange, apiKey, apiSecret, { passphrase: apiPassphrase },
    );

    res.json({ ok: true, data: { exchange: saved.exchange, connectedAt: saved.connectedAt, warning } });
  } catch (e) { sendError(res, e); }
});

// ─── DELETE /:exchange — disconnect a connected exchange ───────────────────
router.delete('/:exchange', requireAuth, async (req, res) => {
  try {
    const result = await userSecretsVault.deleteUserCredentials(req.userId, req.params.exchange);
    if (!result.existed) {
      return res.status(404).json({ ok: false, error: `No connected credentials found for exchange "${req.params.exchange}"` });
    }
    res.json({ ok: true, data: { existed: true } });
  } catch (e) { sendError(res, e); }
});

module.exports = router;

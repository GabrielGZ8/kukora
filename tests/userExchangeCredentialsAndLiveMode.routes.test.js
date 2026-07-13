'use strict';

/**
 * userExchangeCredentialsAndLiveMode.routes.test.js — checkpoint-37.
 *
 * Tests server/routes/userExchangeCredentials.routes.js and
 * server/routes/userLiveMode.routes.js directly against the router stack
 * (same lightweight pattern as tests/user-data.routes.test.js — extract
 * the final handler post-middleware, inject req.userId manually since
 * requireAuth's own JWT logic is covered elsewhere), mocking the service
 * layer (liveExecution / userSecretsVault / userLiveModeService) rather
 * than hitting real exchanges or a real DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const credentialsRouter = require('../server/routes/userExchangeCredentials.routes.js');
const liveModeRouter    = require('../server/routes/userLiveMode.routes.js');
const liveExecution     = require('../server/application/liveExecution');
const userSecretsVault  = require('../server/infrastructure/userSecretsVault');
const userLiveModeService = require('../server/infrastructure/userLiveModeService');

function getHandler(router, path, method = 'get') {
  const layer = router.stack.find(
    l => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No route ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mockRes() {
  const res = {
    _statusCode: 200,
    _body: null,
    status(code) { this._statusCode = code; return this; },
    json(body)   { this._body = body;       return this; },
  };
  return res;
}

describe('userExchangeCredentials.routes.js', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /', () => {
    it("lists the authenticated user's connected exchanges", async () => {
      vi.spyOn(userSecretsVault, 'listUserExchanges').mockResolvedValue([
        { exchange: 'binance', connectedAt: new Date('2026-01-01') },
      ]);
      const handler = getHandler(credentialsRouter, '/', 'get');
      const req = { userId: 'u1' };
      const res = mockRes();
      await handler(req, res);
      expect(res._statusCode).toBe(200);
      expect(res._body.data.exchanges).toHaveLength(1);
      expect(userSecretsVault.listUserExchanges).toHaveBeenCalledWith('u1');
    });
  });

  describe('POST / — connect', () => {
    it('rejects (400) when the request body fails schema validation', async () => {
      const validateBody = require('../server/infrastructure/validateRequest').validateBody;
      const { ExchangeCredentialsBodySchema } = require('../server/domain/risk/userExchangeValidation');
      const mw = validateBody(ExchangeCredentialsBodySchema);
      const req = { body: { exchange: 'binance' } }; // missing apiKey/apiSecret
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, () => { nextCalled = true; });
      expect(nextCalled).toBe(false);
      expect(res._statusCode).toBe(400);
    });

    it('rejects when testExchangeConnection reports the key does not work, and never persists it', async () => {
      vi.spyOn(liveExecution, 'testExchangeConnection').mockResolvedValue({ ok: false, error: 'Invalid API-key' });
      const setSpy = vi.spyOn(userSecretsVault, 'setUserCredentials').mockResolvedValue({});
      const handler = getHandler(credentialsRouter, '/', 'post');
      const req = { userId: 'u1', body: { exchange: 'binance', apiKey: 'bad', apiSecret: 'bad' } };
      const res = mockRes();
      await handler(req, res);
      expect(res._statusCode).toBe(400);
      expect(res._body.ok).toBe(false);
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('rejects (403) a key with withdrawal permission enabled, and never persists it', async () => {
      vi.spyOn(liveExecution, 'testExchangeConnection').mockResolvedValue({ ok: true, canTrade: true });
      vi.spyOn(liveExecution, 'checkWithdrawalPermission').mockResolvedValue({
        verifiable: true, withdrawalEnabled: true, detail: 'Binance apiRestrictions.enableWithdrawals=true',
      });
      const setSpy = vi.spyOn(userSecretsVault, 'setUserCredentials').mockResolvedValue({});
      const handler = getHandler(credentialsRouter, '/', 'post');
      const req = { userId: 'u1', body: { exchange: 'binance', apiKey: 'k', apiSecret: 's' } };
      const res = mockRes();
      await handler(req, res);
      expect(res._statusCode).toBe(403);
      expect(res._body.error).toMatch(/withdrawal permission/i);
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('connects successfully and returns connectedAt when the key works and has no withdrawal permission', async () => {
      vi.spyOn(liveExecution, 'testExchangeConnection').mockResolvedValue({ ok: true, canTrade: true });
      vi.spyOn(liveExecution, 'checkWithdrawalPermission').mockResolvedValue({
        verifiable: true, withdrawalEnabled: false, detail: 'Binance apiRestrictions.enableWithdrawals=false',
      });
      const connectedAt = new Date();
      vi.spyOn(userSecretsVault, 'setUserCredentials').mockResolvedValue({ ok: true, exchange: 'binance', connectedAt });
      const handler = getHandler(credentialsRouter, '/', 'post');
      const req = { userId: 'u1', body: { exchange: 'binance', apiKey: 'k', apiSecret: 's' } };
      const res = mockRes();
      await handler(req, res);
      expect(res._statusCode).toBe(200);
      expect(res._body.data.exchange).toBe('binance');
      expect(res._body.data.connectedAt).toBe(connectedAt);
      expect(res._body.data.warning).toBeNull();
    });

    it('accepts a Kraken-style unverifiable key with a warning instead of a hard block', async () => {
      vi.spyOn(liveExecution, 'testExchangeConnection').mockResolvedValue({ ok: true, canTrade: true });
      vi.spyOn(liveExecution, 'checkWithdrawalPermission').mockResolvedValue({
        verifiable: false, withdrawalEnabled: null,
        detail: "Kraken has no API endpoint to query an API key's own permissions",
      });
      vi.spyOn(userSecretsVault, 'setUserCredentials').mockResolvedValue({ ok: true, exchange: 'kraken', connectedAt: new Date() });
      const handler = getHandler(credentialsRouter, '/', 'post');
      const req = { userId: 'u1', body: { exchange: 'kraken', apiKey: 'k', apiSecret: 's' } };
      const res = mockRes();
      await handler(req, res);
      expect(res._statusCode).toBe(200);
      expect(res._body.data.warning).toMatch(/no API endpoint/i);
    });

    it('never echoes apiKey/apiSecret/apiPassphrase back in the response', async () => {
      vi.spyOn(liveExecution, 'testExchangeConnection').mockResolvedValue({ ok: true, canTrade: true });
      vi.spyOn(liveExecution, 'checkWithdrawalPermission').mockResolvedValue({ verifiable: true, withdrawalEnabled: false, detail: '' });
      vi.spyOn(userSecretsVault, 'setUserCredentials').mockResolvedValue({ ok: true, exchange: 'binance', connectedAt: new Date() });
      const handler = getHandler(credentialsRouter, '/', 'post');
      const req = { userId: 'u1', body: { exchange: 'binance', apiKey: 'super-secret-key', apiSecret: 'super-secret-secret' } };
      const res = mockRes();
      await handler(req, res);
      const raw = JSON.stringify(res._body);
      expect(raw).not.toContain('super-secret-key');
      expect(raw).not.toContain('super-secret-secret');
    });
  });

  describe('DELETE /:exchange', () => {
    it('returns 200 when the credential existed', async () => {
      vi.spyOn(userSecretsVault, 'deleteUserCredentials').mockResolvedValue({ ok: true, existed: true });
      const handler = getHandler(credentialsRouter, '/:exchange', 'delete');
      const req = { userId: 'u1', params: { exchange: 'binance' } };
      const res = mockRes();
      await handler(req, res);
      expect(res._statusCode).toBe(200);
      expect(res._body.data.existed).toBe(true);
    });

    it('returns 404 when the exchange was never connected', async () => {
      vi.spyOn(userSecretsVault, 'deleteUserCredentials').mockResolvedValue({ ok: true, existed: false });
      const handler = getHandler(credentialsRouter, '/:exchange', 'delete');
      const req = { userId: 'u1', params: { exchange: 'binance' } };
      const res = mockRes();
      await handler(req, res);
      expect(res._statusCode).toBe(404);
    });
  });
});

describe('userLiveMode.routes.js', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /', () => {
    it('hydrates from DB and returns status plus the disclaimer text', async () => {
      vi.spyOn(userLiveModeService, 'loadLiveModeFromDb').mockResolvedValue({ enabled: false, enabledAt: null });
      const handler = getHandler(liveModeRouter, '/', 'get');
      const req = { userId: 'u1' };
      const res = mockRes();
      await handler(req, res);
      expect(res._statusCode).toBe(200);
      expect(res._body.data.enabled).toBe(false);
      expect(res._body.data.disclaimerText).toBe(userLiveModeService.RISK_DISCLAIMER_TEXT);
    });
  });

  describe('POST / — enable', () => {
    it('rejects (400) at the schema level when disclaimerAccepted is not literal true', async () => {
      const validateBody = require('../server/infrastructure/validateRequest').validateBody;
      const { LiveModeEnableBodySchema } = require('../server/domain/risk/userExchangeValidation');
      const mw = validateBody(LiveModeEnableBodySchema);
      const req = { body: { twoFactorToken: '123456', disclaimerAccepted: false } };
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, () => { nextCalled = true; });
      expect(nextCalled).toBe(false);
      expect(res._statusCode).toBe(400);
    });

    it('rejects (400) at the schema level when disclaimerAccepted is omitted', async () => {
      const validateBody = require('../server/infrastructure/validateRequest').validateBody;
      const { LiveModeEnableBodySchema } = require('../server/domain/risk/userExchangeValidation');
      const mw = validateBody(LiveModeEnableBodySchema);
      const req = { body: { twoFactorToken: '123456' } };
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, () => { nextCalled = true; });
      expect(nextCalled).toBe(false);
      expect(res._statusCode).toBe(400);
    });

    it('delegates to userLiveModeService.enableLiveMode and returns its result on success', async () => {
      const enabledAt = new Date();
      vi.spyOn(userLiveModeService, 'enableLiveMode').mockResolvedValue({ enabled: true, enabledAt });
      const handler = getHandler(liveModeRouter, '/', 'post');
      const req = { userId: 'u1', body: { twoFactorToken: '123456', disclaimerAccepted: true } };
      const res = mockRes();
      await handler(req, res);
      expect(res._statusCode).toBe(200);
      expect(res._body.data.enabled).toBe(true);
      expect(userLiveModeService.enableLiveMode).toHaveBeenCalledWith('u1', { twoFactorToken: '123456', disclaimerAccepted: true });
    });

    it('surfaces a service-layer rejection (e.g. no exchange connected) as a 400', async () => {
      vi.spyOn(userLiveModeService, 'enableLiveMode').mockRejectedValue(
        new Error('Connect at least one exchange with your own API credentials before enabling live trading')
      );
      const handler = getHandler(liveModeRouter, '/', 'post');
      const req = { userId: 'u1', body: { twoFactorToken: '123456', disclaimerAccepted: true } };
      const res = mockRes();
      await handler(req, res);
      expect(res._statusCode).toBe(400);
      expect(res._body.error).toMatch(/connect at least one exchange/i);
    });
  });

  describe('POST /disable', () => {
    it('always succeeds and never requires a 2FA token in the body', async () => {
      vi.spyOn(userLiveModeService, 'disableLiveMode').mockReturnValue({ enabled: false });
      const handler = getHandler(liveModeRouter, '/disable', 'post');
      const req = { userId: 'u1', body: {} };
      const res = mockRes();
      handler(req, res);
      expect(res._statusCode).toBe(200);
      expect(res._body.data.enabled).toBe(false);
    });
  });
});

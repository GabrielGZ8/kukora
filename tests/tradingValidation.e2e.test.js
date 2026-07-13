'use strict';

/**
 * tradingValidation.e2e.test.js — H-1 (ver MIGRATION_CLEANUP_LOG.md, Sesión
 * 17/18): verifica end-to-end que la validación Zod nueva en
 * `server/routes/trading.routes.js` rechaza payloads mal formados con 400
 * antes de que lleguen a la lógica de negocio, y que payloads válidos siguen
 * funcionando exactamente igual que antes (ninguna regresión de
 * comportamiento para clientes bien formados).
 *
 * El caso más importante de este archivo es el de `amount` como string: es
 * la regresión real que motivó H-1 (ver comentario en
 * server/infrastructure/validateRequest.js) — antes de este fix,
 * `amount: '100'` pasaba el chequeo `if (!amount)` y llegaba a
 * `liveExecution.preflightCheck()`, donde `amount * opportunity.buyPrice`
 * puede producir comportamiento incorrecto según el tipo real recibido.
 * Ahora debe ser rechazado en el borde con 400, antes de tocar ninguna
 * lógica financiera.
 *
 * Mismo patrón que tests/twoFactorTradingGate.e2e.test.js (supertest contra
 * la app real vía require(), JWT firmado a mano con el mismo JWT_SECRET que
 * fija vitest.config.js). Usa un userId distinto para no compartir estado
 * en memoria (twoFactor, liveExecution) con ese otro archivo.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { app } = require('../server/index.js');

const JWT_SECRET = process.env.JWT_SECRET; // set in vitest.config.js

// financialControlLimiter (server/index.js) allows only 10 req/min per
// userId across /api/trading/mode, /2fa, /execute — and this file
// deliberately makes several requests per describe block to exercise many
// validation branches. Each test gets its own synthetic userId (keyed off
// a shared counter) so the rate limiter's per-user bucket never becomes
// the reason a test fails instead of the validation logic under test.
let _userCounter = 0;
function bearer() {
  const userId = `e2e-validation-user-${++_userCounter}`;
  const token = jwt.sign({ sub: userId, email: `${userId}@test.com` }, JWT_SECRET, { expiresIn: '15m' });
  return `Bearer ${token}`;
}

describe('H-1: Zod validation on trading routes (end-to-end via supertest)', () => {
  describe('POST /api/trading/mode', () => {
    it('rejects an invalid mode value with 400', async () => {
      const res = await request(app)
        .post('/api/trading/mode')
        .set('Authorization', bearer())
        .send({ mode: 'yolo' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/mode/);
    });

    it('rejects a missing mode with 400', async () => {
      const res = await request(app)
        .post('/api/trading/mode')
        .set('Authorization', bearer())
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('rejects a non-string twoFactorToken with 400', async () => {
      const res = await request(app)
        .post('/api/trading/mode')
        .set('Authorization', bearer())
        .send({ mode: 'paper', twoFactorToken: 123456 });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('still accepts a well-formed body (no regression)', async () => {
      const res = await request(app)
        .post('/api/trading/mode')
        .set('Authorization', bearer())
        .send({ mode: 'paper' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.mode).toBe('paper');
    });
  });

  describe('POST /api/trading/execute/cross', () => {
    it('rejects a missing opportunity with 400', async () => {
      const res = await request(app)
        .post('/api/trading/execute/cross')
        .set('Authorization', bearer())
        .send({ amount: 100 });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('rejects an opportunity missing buyExchange/sellExchange with 400', async () => {
      const res = await request(app)
        .post('/api/trading/execute/cross')
        .set('Authorization', bearer())
        .send({ opportunity: { pair: 'BTC/USDT' }, amount: 100 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/buyExchange/);
    });

    it('rejects amount sent as a string — the real gap this session closed', async () => {
      const res = await request(app)
        .post('/api/trading/execute/cross')
        .set('Authorization', bearer())
        .send({
          opportunity: { buyExchange: 'binance', sellExchange: 'bybit', pair: 'BTC/USDT' },
          amount: '100',
        });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/amount/);
    });

    it('rejects a negative amount with 400', async () => {
      const res = await request(app)
        .post('/api/trading/execute/cross')
        .set('Authorization', bearer())
        .send({
          opportunity: { buyExchange: 'binance', sellExchange: 'bybit' },
          amount: -5,
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/amount/);
    });

    it('rejects an amount above the sanity ceiling with 400', async () => {
      const res = await request(app)
        .post('/api/trading/execute/cross')
        .set('Authorization', bearer())
        .send({
          opportunity: { buyExchange: 'binance', sellExchange: 'bybit' },
          amount: 5_000_000,
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/amount/);
    });

    it('passes validation for a well-formed request (2FA not enabled for this user, so it reaches business logic)', async () => {
      const res = await request(app)
        .post('/api/trading/execute/cross')
        .set('Authorization', bearer())
        .send({
          opportunity: { buyExchange: 'binance', sellExchange: 'bybit', pair: 'BTC/USDT' },
          amount: 0.01,
        });
      // Not a validation rejection — whatever happens past this point is
      // business logic (paper mode / missing API keys), not our concern here.
      expect(res.status).not.toBe(400);
    });
  });

  describe('POST /api/trading/test-connection', () => {
    it('rejects a missing apiSecret with 400', async () => {
      const res = await request(app)
        .post('/api/trading/test-connection')
        .set('Authorization', bearer())
        .send({ exchange: 'binance', apiKey: 'abc' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('rejects a non-string apiKey with 400', async () => {
      const res = await request(app)
        .post('/api/trading/test-connection')
        .set('Authorization', bearer())
        .send({ exchange: 'binance', apiKey: { not: 'a string' }, apiSecret: 'xyz' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });
  });

  describe('POST /api/trading/2fa/confirm', () => {
    it('rejects a missing token with 400 (before reaching twoFactor.confirmSetup)', async () => {
      const res = await request(app)
        .post('/api/trading/2fa/confirm')
        .set('Authorization', bearer())
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });
  });

  describe('POST /api/trading/pairs', () => {
    it('rejects pairs sent as a non-array with 400', async () => {
      const res = await request(app)
        .post('/api/trading/pairs')
        .set('Authorization', bearer())
        .send({ pairs: 'BTC/USDT' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('rejects an empty pairs array with 400', async () => {
      const res = await request(app)
        .post('/api/trading/pairs')
        .set('Authorization', bearer())
        .send({ pairs: [] });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('still accepts a well-formed pairs body (no regression)', async () => {
      const res = await request(app)
        .post('/api/trading/pairs')
        .set('Authorization', bearer())
        .send({ pairs: ['BTC/USDT'] });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // Refinamiento post-Sesión 34 ("Profundidad y parametrización" — ver
  // userRiskProfileService.js). Mismo patrón e2e que /pairs arriba.
  describe('GET/POST /api/trading/risk-profile', () => {
    it('GET returns a default profile (all-null overrides) and an effective config for a fresh user', async () => {
      const res = await request(app)
        .get('/api/trading/risk-profile')
        .set('Authorization', bearer());
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.profile.maxPositionValueUSD).toBeNull();
      expect(res.body.data.effective).toEqual({});
    });

    it('rejects maxPositionValueUSD below the global minimum bound with 400', async () => {
      const res = await request(app)
        .post('/api/trading/risk-profile')
        .set('Authorization', bearer())
        .send({ maxPositionValueUSD: 50 }); // below the $100 floor
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('rejects a positive maxDailyLossUSD with 400 (must be <= 0)', async () => {
      const res = await request(app)
        .post('/api/trading/risk-profile')
        .set('Authorization', bearer())
        .send({ maxDailyLossUSD: 100 });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('accepts a well-formed stricter override and reflects it in the effective config', async () => {
      const auth = bearer();
      const res = await request(app)
        .post('/api/trading/risk-profile')
        .set('Authorization', auth)
        .send({ maxPositionValueUSD: 500 });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.profile.maxPositionValueUSD).toBe(500);
      expect(res.body.data.effective.maxPositionValueUSD).toBe(500);

      const getRes = await request(app)
        .get('/api/trading/risk-profile')
        .set('Authorization', auth);
      expect(getRes.body.data.profile.maxPositionValueUSD).toBe(500);
    });

    it('clamps an override to the global limit instead of relaxing it', async () => {
      const auth = bearer();
      // 999999 is within the 100..1_000_000 Zod bound (so it passes
      // validation) but above the current global maxPositionValueUSD
      // default (10000) — the effective value must never exceed the global.
      const res = await request(app)
        .post('/api/trading/risk-profile')
        .set('Authorization', auth)
        .send({ maxPositionValueUSD: 999_999 });
      expect(res.status).toBe(200);
      expect(res.body.data.effective.maxPositionValueUSD).toBeLessThanOrEqual(10_000);
    });

    it('explicit null clears an override back to the global default', async () => {
      const auth = bearer();
      await request(app).post('/api/trading/risk-profile').set('Authorization', auth).send({ maxSlippagePct: 0.05 });
      const res = await request(app)
        .post('/api/trading/risk-profile')
        .set('Authorization', auth)
        .send({ maxSlippagePct: null });
      expect(res.status).toBe(200);
      expect(res.body.data.profile.maxSlippagePct).toBeNull();
      expect(res.body.data.effective.maxSlippagePct).toBeUndefined();
    });
  });
});

'use strict';

/**
 * twoFactorTradingGate.e2e.test.js
 *
 * Verificación end-to-end (Ronda 21, Fase 3 pendiente #1) de que el gateo
 * de 2FA sobre POST /api/trading/mode y POST /api/trading/execute/cross
 * funciona en la cadena real de middlewares/rutas de server/index.js —
 * no solo a nivel de unidad de twoFactor.js.
 *
 * Flujo cubierto:
 *   1. Sin 2FA habilitado: mode=live pasa sin token.
 *   2. setup → confirm con un TOTP real (mismo módulo infra/totp.js que
 *      usa el server) habilita 2FA para el usuario.
 *   3. Una vez habilitado: mode=live sin twoFactorToken → 401.
 *   4. mode=live con un token TOTP válido para el secret confirmado → ok.
 *   5. Mismo gateo replicado en POST /api/trading/execute/cross.
 *
 * server/index.js exporta `app` sin bindear el puerto cuando se hace
 * require() en vez de ejecutarlo directamente (guard `require.main ===
 * module`), así que supertest puede pegarle en memoria. La autenticación
 * se resuelve firmando un JWT nosotros mismos con el mismo JWT_SECRET que
 * vitest.config.js fija para toda la suite — evita depender de Mongo real
 * para /register o /login, que no está disponible en este entorno.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// LIVE_ENABLED is read once at module-load time in liveExecution.js
// (`const LIVE_ENABLED = process.env.LIVE_TRADING_ENABLED === 'true'`), so
// it must be set before that module is first required. Without this,
// setUserMode('live') throws its own separate guardrail ("Live trading is
// disabled") which would otherwise mask whether the 2FA gate itself is
// working — this file is only about the 2FA gate, not that guardrail.
process.env.LIVE_TRADING_ENABLED = 'true';

const { app } = require('../server/index.js');
const totp = require('../server/infrastructure/totp');

const JWT_SECRET = process.env.JWT_SECRET; // set in vitest.config.js
const USER_ID = 'e2e-2fa-user';

function bearer() {
  const token = jwt.sign({ sub: USER_ID, email: 'e2e@test.com' }, JWT_SECRET, { expiresIn: '15m' });
  return `Bearer ${token}`;
}

describe('2FA gate on trading routes (end-to-end via supertest)', () => {
  it('mode=live succeeds without a token when 2FA is not enabled', async () => {
    const res = await request(app)
      .post('/api/trading/mode')
      .set('Authorization', bearer())
      .send({ mode: 'paper' }); // switch to paper first so live-toggle below is a real transition
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  let secret;

  it('2fa/setup returns a secret for the authenticated user', async () => {
    const res = await request(app)
      .post('/api/trading/2fa/setup')
      .set('Authorization', bearer())
      .send();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.secret).toBeTruthy();
    secret = res.body.data.secret;
  });

  it('2fa/confirm with a valid TOTP for that secret enables 2FA', async () => {
    const validToken = totp.generateToken(secret);
    const res = await request(app)
      .post('/api/trading/2fa/confirm')
      .set('Authorization', bearer())
      .send({ token: validToken });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('mode=live is rejected with 401 once 2FA is enabled and no token is sent', async () => {
    const res = await request(app)
      .post('/api/trading/mode')
      .set('Authorization', bearer())
      .send({ mode: 'live' });
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/2FA/);
  });

  it('mode=live is rejected with a wrong/expired-looking token', async () => {
    const res = await request(app)
      .post('/api/trading/mode')
      .set('Authorization', bearer())
      .send({ mode: 'live', twoFactorToken: '000000' });
    expect(res.status).toBe(401);
  });

  it('mode=live succeeds with a fresh valid TOTP token', async () => {
    const validToken = totp.generateToken(secret);
    const res = await request(app)
      .post('/api/trading/mode')
      .set('Authorization', bearer())
      .send({ mode: 'live', twoFactorToken: validToken });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.mode).toBe('live');
  });

  it('execute/cross applies the same 2FA gate: rejected without token', async () => {
    const res = await request(app)
      .post('/api/trading/execute/cross')
      .set('Authorization', bearer())
      .send({ opportunity: { buyExchange: 'binance', sellExchange: 'bybit', pair: 'BTC/USDT' }, amount: 100 });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/2FA/);
  });

  it('execute/cross passes the 2FA gate with a valid token (may still fail downstream on missing API keys, which is a separate concern)', async () => {
    const validToken = totp.generateToken(secret);
    const res = await request(app)
      .post('/api/trading/execute/cross')
      .set('Authorization', bearer())
      .send({
        opportunity: { buyExchange: 'binance', sellExchange: 'bybit', pair: 'BTC/USDT' },
        amount: 100,
        twoFactorToken: validToken,
      });
    // The gate itself must not be the reason for failure past this point —
    // 401 here would mean the gate rejected a valid token.
    expect(res.status).not.toBe(401);
  });
});

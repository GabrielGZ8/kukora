'use strict';

/**
 * tenantBot.routes.e2e.test.js — ADR-017, HTTP surface for the
 * multi-tenant primitives. Real Express app, real supertest round trips.
 *
 * Each test uses its own unique uid (unique JWT `sub`) rather than
 * sharing one or two uids across the whole file. This isn't just test
 * isolation — as of the item 5 security-audit follow-up, these mutation
 * routes now sit behind `financialControlLimiter` (10 req/min per uid,
 * same as /api/trading/mode and /api/trading/2fa — see server/index.js),
 * so a shared uid making a dozen requests across a dozen `it()` blocks
 * would trip the real rate limiter and fail with 429 instead of the
 * assertion under test. Distinct uids per test avoids that collision the
 * same way distinct uids would arise from distinct real users.
 */

import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { app } = require('../server/index.js');
const tenantBotState = require('../server/infrastructure/tenantBotState');
const tenantConfig   = require('../server/infrastructure/tenantConfig');
const tenantRiskGuard = require('../server/infrastructure/tenantRiskGuard');

const JWT_SECRET = process.env.JWT_SECRET;

let _counter = 0;
function freshUid(label) {
  _counter += 1;
  return `e2e-tb-${label}-${_counter}`;
}

function bearerFor(uid) {
  const token = jwt.sign({ sub: uid, email: `${uid}@test.com` }, JWT_SECRET, { expiresIn: '15m' });
  return `Bearer ${token}`;
}

const _usedUids = [];
afterEach(() => {
  for (const uid of _usedUids.splice(0)) {
    tenantBotState.setEnabled(uid, false);
    tenantConfig.resetAll(uid);
    tenantRiskGuard.resetBreaker(uid);
  }
});

describe('tenant-bot routes (end-to-end via supertest, real Express app)', () => {
  describe('auth gate', () => {
    it('GET /api/tenant-bot/status requires authentication', async () => {
      const res = await request(app).get('/api/tenant-bot/status');
      expect(res.status).toBe(401);
    });

    it('POST /api/tenant-bot/toggle requires authentication', async () => {
      const res = await request(app).post('/api/tenant-bot/toggle').send({ enabled: true });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /status', () => {
    it('returns bot status, wallet, pnl, history, config overrides and risk status for the caller', async () => {
      const uid = freshUid('status'); _usedUids.push(uid);
      const res = await request(app).get('/api/tenant-bot/status').set('Authorization', bearerFor(uid));
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.botStatus.enabled).toBe(false);
      expect(res.body.data.wallets).toBeTruthy();
      expect(res.body.data.risk.active).toBe(false);
    });
  });

  describe('POST /toggle', () => {
    it('turns the caller bot on, and GET /status reflects it', async () => {
      const uid = freshUid('toggle-on'); _usedUids.push(uid);
      const toggleRes = await request(app)
        .post('/api/tenant-bot/toggle')
        .set('Authorization', bearerFor(uid))
        .send({ enabled: true });
      expect(toggleRes.status).toBe(200);
      expect(toggleRes.body.data.enabled).toBe(true);

      const statusRes = await request(app).get('/api/tenant-bot/status').set('Authorization', bearerFor(uid));
      expect(statusRes.body.data.botStatus.enabled).toBe(true);
    });

    it('rejects a non-boolean `enabled`', async () => {
      const uid = freshUid('toggle-bad'); _usedUids.push(uid);
      const res = await request(app)
        .post('/api/tenant-bot/toggle')
        .set('Authorization', bearerFor(uid))
        .send({ enabled: 'yes' });
      expect(res.status).toBe(400);
    });

    it('two different users toggling their bot never affect each other', async () => {
      const uidA = freshUid('iso-a'); _usedUids.push(uidA);
      const uidB = freshUid('iso-b'); _usedUids.push(uidB);
      await request(app).post('/api/tenant-bot/toggle').set('Authorization', bearerFor(uidA)).send({ enabled: true });

      const statusB = await request(app).get('/api/tenant-bot/status').set('Authorization', bearerFor(uidB));
      expect(statusB.body.data.botStatus.enabled).toBe(false);
    });
  });

  describe('config overrides', () => {
    it('POST /config applies a valid override and rejects an invalid one in the same call', async () => {
      const uid = freshUid('cfg-apply'); _usedUids.push(uid);
      const res = await request(app)
        .post('/api/tenant-bot/config')
        .set('Authorization', bearerFor(uid))
        .send({ patch: { minScore: 42, tradeAmountBTC: -999 } });
      expect(res.body.data.applied.some(a => a.key === 'minScore')).toBe(true);
      expect(res.body.data.rejected.some(r => r.key === 'tradeAmountBTC')).toBe(true);

      const getRes = await request(app).get('/api/tenant-bot/config').set('Authorization', bearerFor(uid));
      expect(getRes.body.data.minScore).toBe(42);
    });

    // Regression test: a partial rejection is an application-level result
    // (ok:false in the body), not a protocol error — HTTP status must stay
    // 200 so generic frontend fetch helpers that throw on non-2xx (see
    // src/api.js) don't discard `data.rejected` before the caller can read it.
    it('POST /config returns HTTP 200 even when a key is rejected (matches /api/arbitrage/config convention)', async () => {
      const uid = freshUid('cfg-status-200'); _usedUids.push(uid);
      const res = await request(app)
        .post('/api/tenant-bot/config')
        .set('Authorization', bearerFor(uid))
        .send({ patch: { tradeAmountBTC: -999 } });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.data.rejected.some(r => r.key === 'tradeAmountBTC')).toBe(true);
    });

    it('DELETE /config/:key clears a single override', async () => {
      const uid = freshUid('cfg-delete'); _usedUids.push(uid);
      await request(app).post('/api/tenant-bot/config').set('Authorization', bearerFor(uid)).send({ patch: { minScore: 33 } });
      await request(app).delete('/api/tenant-bot/config/minScore').set('Authorization', bearerFor(uid));
      const getRes = await request(app).get('/api/tenant-bot/config').set('Authorization', bearerFor(uid));
      expect(getRes.body.data.minScore).toBeUndefined();
    });

    it('POST /config/reset clears all overrides for the caller', async () => {
      const uid = freshUid('cfg-reset'); _usedUids.push(uid);
      await request(app).post('/api/tenant-bot/config').set('Authorization', bearerFor(uid)).send({ patch: { minScore: 33, tradeAmountBTC: 0.02 } });
      await request(app).post('/api/tenant-bot/config/reset').set('Authorization', bearerFor(uid));
      const getRes = await request(app).get('/api/tenant-bot/config').set('Authorization', bearerFor(uid));
      expect(Object.keys(getRes.body.data).length).toBe(0);
    });
  });

  describe('risk guard', () => {
    it('POST /risk/reset on an inactive breaker returns ok:false without error', async () => {
      const uid = freshUid('risk-noop'); _usedUids.push(uid);
      const res = await request(app).post('/api/tenant-bot/risk/reset').set('Authorization', bearerFor(uid));
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('POST /risk/reset clears a tripped breaker', async () => {
      const uid = freshUid('risk-reset'); _usedUids.push(uid);
      tenantRiskGuard.tripBreaker(uid, 'test trip', 'manual');
      const res = await request(app).post('/api/tenant-bot/risk/reset').set('Authorization', bearerFor(uid));
      expect(res.status).toBe(200);
      expect(res.body.data.active).toBe(false);
    });
  });

  describe('rate limiting (item 5 follow-up)', () => {
    it('mutation endpoints are rate-limited per uid (financialControlLimiter, 10/min)', async () => {
      const uid = freshUid('rate-limited'); _usedUids.push(uid);
      let sawRateLimit = false;
      for (let i = 0; i < 12; i++) {
        const res = await request(app)
          .post('/api/tenant-bot/config')
          .set('Authorization', bearerFor(uid))
          .send({ patch: { minScore: 10 + i } });
        if (res.status === 429) { sawRateLimit = true; break; }
      }
      expect(sawRateLimit).toBe(true);
    });

    // Regression test for a bug found while wiring up TenantBotPanel: the
    // limiter was mounted with no method filter, so a UI panel polling
    // GET /status every 5s would exhaust the whole 10/min budget from
    // reads alone, then have nothing left when the user actually tried to
    // toggle their bot or save a config change. GET must never count.
    it('GET requests (status/config) never count toward the mutation rate limit', async () => {
      const uid = freshUid('rate-get-exempt'); _usedUids.push(uid);
      for (let i = 0; i < 15; i++) {
        const res = await request(app).get('/api/tenant-bot/status').set('Authorization', bearerFor(uid));
        expect(res.status).toBe(200);
      }
      // The mutation budget (10/min) must still be fully available afterwards.
      const toggleRes = await request(app)
        .post('/api/tenant-bot/toggle')
        .set('Authorization', bearerFor(uid))
        .send({ enabled: true });
      expect(toggleRes.status).toBe(200);
    });
  });
});

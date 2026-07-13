'use strict';

/**
 * tenantDemo.routes.e2e.test.js — Iniciativa 4, comparación multi-tenant
 * demo. Real Express app, real supertest round trips, mismo patrón que
 * tenantBot.routes.e2e.test.js.
 *
 * A diferencia de tenantBot (donde cada test usa un uid distinto porque
 * el uid ES el tenant bajo prueba), aquí los DOS tenants demo son
 * siempre las mismas dos claves fijas (`demo-conservative`,
 * `demo-aggressive`) — lo que varía por test es el usuario AUTENTICADO
 * que llama al endpoint (cualquier usuario real puede arrancar/parar la
 * demo compartida). Por eso cada test usa un caller distinto (mismo
 * criterio que evita chocar con financialControlLimiter, 10/min por
 * uid — aquí por uid de CALLER, no de tenant demo).
 */

import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { app } = require('../server/index.js');
const tenantBotState  = require('../server/infrastructure/tenantBotState');
const tenantConfig    = require('../server/infrastructure/tenantConfig');
const tenantRiskGuard = require('../server/infrastructure/tenantRiskGuard');

const JWT_SECRET = process.env.JWT_SECRET;
const DEMO_UIDS = ['demo-conservative', 'demo-aggressive'];

let _counter = 0;
function freshCaller(label) {
  _counter += 1;
  return `e2e-td-${label}-${_counter}`;
}

function bearerFor(uid) {
  const token = jwt.sign({ sub: uid, email: `${uid}@test.com` }, JWT_SECRET, { expiresIn: '15m' });
  return `Bearer ${token}`;
}

afterEach(() => {
  for (const uid of DEMO_UIDS) {
    tenantBotState.setEnabled(uid, false);
    tenantConfig.resetAll(uid);
    tenantRiskGuard.resetBreaker(uid);
  }
});

describe('tenant-demo routes (end-to-end via supertest, real Express app)', () => {
  describe('auth gate', () => {
    it('GET /api/tenant-demo/status requires authentication', async () => {
      const res = await request(app).get('/api/tenant-demo/status');
      expect(res.status).toBe(401);
    });

    it('POST /api/tenant-demo/start requires authentication', async () => {
      const res = await request(app).post('/api/tenant-demo/start');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /start', () => {
    it('enables both demo tenants with opposing config profiles', async () => {
      const caller = freshCaller('start');
      const res = await request(app).post('/api/tenant-demo/start').set('Authorization', bearerFor(caller));
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.conservative.profile.minScore).toBe(80);
      expect(res.body.data.aggressive.profile.minScore).toBe(40);
      expect(tenantBotState.isEnabled('demo-conservative')).toBe(true);
      expect(tenantBotState.isEnabled('demo-aggressive')).toBe(true);
      expect(tenantConfig.getEffective('demo-conservative', 'tradeAmountBTC')).toBe(0.005);
      expect(tenantConfig.getEffective('demo-aggressive', 'tradeAmountBTC')).toBe(0.02);
    });
  });

  describe('GET /status', () => {
    it('returns a side-by-side snapshot for both demo tenants', async () => {
      const starter = freshCaller('status-start');
      await request(app).post('/api/tenant-demo/start').set('Authorization', bearerFor(starter));

      const viewer = freshCaller('status-view');
      const res = await request(app).get('/api/tenant-demo/status').set('Authorization', bearerFor(viewer));
      expect(res.status).toBe(200);
      expect(res.body.data.conservative.uid).toBe('demo-conservative');
      expect(res.body.data.aggressive.uid).toBe('demo-aggressive');
      expect(res.body.data.conservative.botStatus.enabled).toBe(true);
      expect(res.body.data.aggressive.botStatus.enabled).toBe(true);
    });

    it('is visible to any authenticated user, not scoped to the caller who started it', async () => {
      const starter = freshCaller('shared-start');
      await request(app).post('/api/tenant-demo/start').set('Authorization', bearerFor(starter));

      const otherUser = freshCaller('shared-other');
      const res = await request(app).get('/api/tenant-demo/status').set('Authorization', bearerFor(otherUser));
      expect(res.body.data.conservative.botStatus.enabled).toBe(true);
    });
  });

  describe('POST /stop', () => {
    it('disables both bots but preserves wallets/history', async () => {
      const starter = freshCaller('stop-start');
      await request(app).post('/api/tenant-demo/start').set('Authorization', bearerFor(starter));

      const stopper = freshCaller('stop-call');
      const res = await request(app).post('/api/tenant-demo/stop').set('Authorization', bearerFor(stopper));
      expect(res.status).toBe(200);
      expect(tenantBotState.isEnabled('demo-conservative')).toBe(false);
      expect(tenantBotState.isEnabled('demo-aggressive')).toBe(false);
      // Config overrides should NOT be wiped by /stop.
      expect(tenantConfig.getEffective('demo-conservative', 'minScore')).toBe(80);
    });
  });

  describe('POST /reset', () => {
    it('stops both bots and clears config overrides', async () => {
      const starter = freshCaller('reset-start');
      await request(app).post('/api/tenant-demo/start').set('Authorization', bearerFor(starter));

      const resetter = freshCaller('reset-call');
      const res = await request(app).post('/api/tenant-demo/reset').set('Authorization', bearerFor(resetter));
      expect(res.status).toBe(200);
      expect(tenantBotState.isEnabled('demo-conservative')).toBe(false);
      expect(Object.keys(tenantConfig.getOverrides('demo-conservative')).length).toBe(0);
      expect(Object.keys(tenantConfig.getOverrides('demo-aggressive')).length).toBe(0);
    });
  });
});

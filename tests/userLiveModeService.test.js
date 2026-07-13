'use strict';

/**
 * userLiveModeService.test.js — checkpoint-37: per-user live-trading toggle.
 *
 * Covers: activation requires (1) a connected exchange, (2) confirmed 2FA
 * with a valid current token, (3) explicit disclaimer acceptance; the
 * synchronous isLiveModeEnabled() hot-path gate consumed by liveExecution.js;
 * disabling never requires 2FA; and best-effort DB persistence/hydration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import * as userLiveModeService from '../server/infrastructure/userLiveModeService.js';
import * as userSecretsVault from '../server/infrastructure/userSecretsVault.js';
import twoFactor from '../server/application/twoFactor.js';

function freshUserId() {
  return `test-user-${Math.random().toString(36).slice(2)}`;
}

async function setUp2faAndToken(userId) {
  const { secret } = twoFactor.beginSetup(userId);
  const totp = require('../server/infrastructure/totp');
  const token = totp.generateToken(secret);
  twoFactor.confirmSetup(userId, token);
  return () => totp.generateToken(secret);
}

describe('userLiveModeService', () => {
  beforeEach(() => {
    userLiveModeService._resetForTests();
    userLiveModeService._setMongooseForTests(mongoose);
    userLiveModeService._setUserSecretsVaultForTests(userSecretsVault);
    userLiveModeService._setTwoFactorForTests(twoFactor);
    userSecretsVault._resetForTests();
    userSecretsVault._setMongooseForTests(mongoose);
    twoFactor._resetAll();
  });

  afterEach(() => {
    mongoose.connection.readyState = 0;
    userLiveModeService._resetForTests();
    userLiveModeService._resetMongooseForTests();
    userLiveModeService._resetUserSecretsVaultForTests();
    userLiveModeService._resetTwoFactorForTests();
    userSecretsVault._resetForTests();
    userSecretsVault._resetMongooseForTests();
    twoFactor._resetAll();
    vi.restoreAllMocks();
  });

  describe('isLiveModeEnabled / getStatus — default state', () => {
    it('defaults to disabled for a user who never activated live mode', () => {
      expect(userLiveModeService.isLiveModeEnabled(freshUserId())).toBe(false);
      expect(userLiveModeService.getStatus(freshUserId())).toEqual({ enabled: false, enabledAt: null });
    });
  });

  describe('enableLiveMode — the three explicit requirements', () => {
    it('rejects when the user has no exchange connected', async () => {
      const userId = freshUserId();
      const getToken = await setUp2faAndToken(userId);
      await expect(
        userLiveModeService.enableLiveMode(userId, { twoFactorToken: getToken(), disclaimerAccepted: true })
      ).rejects.toThrow(/connect at least one exchange/i);
      expect(userLiveModeService.isLiveModeEnabled(userId)).toBe(false);
    });

    it('rejects when 2FA is not set up at all', async () => {
      const userId = freshUserId();
      mongoose.connection.readyState = 1;
      const Model = require('../server/models').UserExchangeCredential;
      Model.findOneAndUpdate = vi.fn(async (filter, update) => ({ ...filter, ...(update.$set || {}), connectedAt: update.$setOnInsert.connectedAt }));
      await userSecretsVault.setUserCredentials(userId, 'binance', 'k', 's');

      await expect(
        userLiveModeService.enableLiveMode(userId, { twoFactorToken: '123456', disclaimerAccepted: true })
      ).rejects.toThrow(/two-factor authentication is not set up/i);
    });

    it('rejects an invalid/missing 2FA token even when 2FA is enabled', async () => {
      const userId = freshUserId();
      mongoose.connection.readyState = 1;
      const Model = require('../server/models').UserExchangeCredential;
      Model.findOneAndUpdate = vi.fn(async (filter, update) => ({ ...filter, ...(update.$set || {}), connectedAt: update.$setOnInsert.connectedAt }));
      await userSecretsVault.setUserCredentials(userId, 'binance', 'k', 's');
      await setUp2faAndToken(userId);

      await expect(
        userLiveModeService.enableLiveMode(userId, { twoFactorToken: '000000', disclaimerAccepted: true })
      ).rejects.toThrow(/invalid or missing 2fa token/i);
      await expect(
        userLiveModeService.enableLiveMode(userId, { disclaimerAccepted: true })
      ).rejects.toThrow(/invalid or missing 2fa token/i);
    });

    it('rejects when the disclaimer is not explicitly accepted (no pre-checked default)', async () => {
      const userId = freshUserId();
      mongoose.connection.readyState = 1;
      const Model = require('../server/models').UserExchangeCredential;
      Model.findOneAndUpdate = vi.fn(async (filter, update) => ({ ...filter, ...(update.$set || {}), connectedAt: update.$setOnInsert.connectedAt }));
      await userSecretsVault.setUserCredentials(userId, 'binance', 'k', 's');
      const getToken = await setUp2faAndToken(userId);

      await expect(
        userLiveModeService.enableLiveMode(userId, { twoFactorToken: getToken(), disclaimerAccepted: false })
      ).rejects.toThrow(/explicitly accept the risk disclaimer/i);
      await expect(
        userLiveModeService.enableLiveMode(userId, { twoFactorToken: getToken() }) // omitted entirely
      ).rejects.toThrow(/explicitly accept the risk disclaimer/i);
    });

    it('succeeds and flips isLiveModeEnabled to true when all three requirements are met', async () => {
      const userId = freshUserId();
      mongoose.connection.readyState = 1;
      const Model = require('../server/models').UserExchangeCredential;
      Model.findOneAndUpdate = vi.fn(async (filter, update) => ({ ...filter, ...(update.$set || {}), connectedAt: update.$setOnInsert.connectedAt }));
      await userSecretsVault.setUserCredentials(userId, 'binance', 'k', 's');
      const getToken = await setUp2faAndToken(userId);

      const result = await userLiveModeService.enableLiveMode(userId, { twoFactorToken: getToken(), disclaimerAccepted: true });
      expect(result.enabled).toBe(true);
      expect(userLiveModeService.isLiveModeEnabled(userId)).toBe(true);
      expect(userLiveModeService.getStatus(userId).enabled).toBe(true);
    });
  });

  describe('disableLiveMode — never requires 2FA', () => {
    it('always succeeds and flips isLiveModeEnabled back to false', async () => {
      const userId = freshUserId();
      userLiveModeService._forceEnableForTests(userId);
      expect(userLiveModeService.isLiveModeEnabled(userId)).toBe(true);

      const result = userLiveModeService.disableLiveMode(userId);
      expect(result).toEqual({ enabled: false });
      expect(userLiveModeService.isLiveModeEnabled(userId)).toBe(false);
    });
  });

  describe('per-user isolation', () => {
    it('enabling live mode for one user does not affect another', () => {
      const userA = freshUserId();
      const userB = freshUserId();
      userLiveModeService._forceEnableForTests(userA);
      expect(userLiveModeService.isLiveModeEnabled(userA)).toBe(true);
      expect(userLiveModeService.isLiveModeEnabled(userB)).toBe(false);
    });
  });
});

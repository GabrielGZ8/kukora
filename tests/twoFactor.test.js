'use strict';
import { describe, it, expect, beforeEach } from 'vitest';
const twoFactor = require('../server/application/twoFactor');
const totp = require('../server/infrastructure/totp');
describe('twoFactor', () => {
  beforeEach(() => {
    twoFactor._resetAll();
  });
  describe('beginSetup', () => {
    it('returns a base32 secret and an otpauth URL', () => {
      const { secret, otpauthUrl } = twoFactor.beginSetup('u1');
      expect(secret).toMatch(/^[A-Z2-7]+$/);
      expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    });
    it('does not enable 2FA until confirmed', () => {
      twoFactor.beginSetup('u1');
      expect(twoFactor.isEnabled('u1')).toBe(false);
      expect(twoFactor.getStatus('u1')).toEqual({ enabled: false, pendingSetup: true });
    });
  });
  describe('confirmSetup', () => {
    it('enables 2FA when given a valid token for the pending secret', () => {
      const { secret } = twoFactor.beginSetup('u1');
      const token = totp.generateToken(secret);
      const result = twoFactor.confirmSetup('u1', token);
      expect(result).toEqual({ enabled: true });
      expect(twoFactor.isEnabled('u1')).toBe(true);
    });
    it('rejects an invalid token and leaves 2FA disabled', () => {
      twoFactor.beginSetup('u1');
      expect(() => twoFactor.confirmSetup('u1', '000000')).toThrow(/Invalid 2FA token/);
      expect(twoFactor.isEnabled('u1')).toBe(false);
    });
    it('throws when there is no pending setup', () => {
      expect(() => twoFactor.confirmSetup('nobody', '123456')).toThrow(/No pending 2FA setup/);
    });
  });
  describe('verify', () => {
    it('returns true for a valid token against the enabled secret', () => {
      const { secret } = twoFactor.beginSetup('u1');
      twoFactor.confirmSetup('u1', totp.generateToken(secret));
      expect(twoFactor.verify('u1', totp.generateToken(secret))).toBe(true);
    });
    it('returns false (not throws) when 2FA was never enabled', () => {
      expect(twoFactor.verify('ghost', '123456')).toBe(false);
    });
    it('returns false for a wrong token', () => {
      const { secret } = twoFactor.beginSetup('u1');
      twoFactor.confirmSetup('u1', totp.generateToken(secret));
      expect(twoFactor.verify('u1', '000000')).toBe(false);
    });
  });
  describe('disable', () => {
    it('requires a valid current token to disable', () => {
      const { secret } = twoFactor.beginSetup('u1');
      twoFactor.confirmSetup('u1', totp.generateToken(secret));
      expect(() => twoFactor.disable('u1', 'bad')).toThrow(/Invalid 2FA token/);
      expect(twoFactor.isEnabled('u1')).toBe(true);
    });
    it('disables 2FA with a valid token', () => {
      const { secret } = twoFactor.beginSetup('u1');
      twoFactor.confirmSetup('u1', totp.generateToken(secret));
      const result = twoFactor.disable('u1', totp.generateToken(secret));
      expect(result).toEqual({ enabled: false });
      expect(twoFactor.isEnabled('u1')).toBe(false);
    });
  });
  describe('per-user isolation', () => {
    it('does not leak enrollment state between users', () => {
      const { secret } = twoFactor.beginSetup('u1');
      twoFactor.confirmSetup('u1', totp.generateToken(secret));
      expect(twoFactor.isEnabled('u1')).toBe(true);
      expect(twoFactor.isEnabled('u2')).toBe(false);
    });
  });
});

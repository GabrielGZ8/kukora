'use strict';
import { describe, it, expect } from 'vitest';
const totp = require('../server/infrastructure/totp');

describe('totp (RFC 6238 / RFC 4226 / RFC 4648)', () => {
  describe('base32Encode / base32Decode', () => {
    it('round-trips arbitrary bytes', () => {
      const original = Buffer.from('Kukora live trading 2FA secret', 'utf8');
      const encoded = totp.base32Encode(original);
      const decoded = totp.base32Decode(encoded);
      expect(decoded.equals(original)).toBe(true);
    });

    it('produces only valid RFC 4648 alphabet characters', () => {
      const encoded = totp.base32Encode(Buffer.from([1, 2, 3, 4, 5]));
      expect(encoded).toMatch(/^[A-Z2-7]+$/);
    });

    it('decode is case-insensitive and tolerates padding', () => {
      const encoded = totp.base32Encode(Buffer.from('hello'));
      const decoded = totp.base32Decode(encoded.toLowerCase() + '===');
      expect(decoded.toString('utf8')).toBe('hello');
    });

    it('rejects invalid base32 characters', () => {
      expect(() => totp.base32Decode('01189998819991197253')).toThrow(/Invalid base32/);
    });
  });

  describe('generateSecret', () => {
    it('generates a base32 secret of reasonable length', () => {
      const secret = totp.generateSecret();
      expect(secret).toMatch(/^[A-Z2-7]+$/);
      expect(secret.length).toBeGreaterThanOrEqual(28); // 20 bytes -> 32 base32 chars (unpadded ~32)
    });

    it('generates different secrets on each call', () => {
      const a = totp.generateSecret();
      const b = totp.generateSecret();
      expect(a).not.toBe(b);
    });
  });

  describe('generateToken / verifyToken', () => {
    it('generates a 6-digit numeric token', () => {
      const secret = totp.generateSecret();
      const token = totp.generateToken(secret);
      expect(token).toMatch(/^\d{6}$/);
    });

    it('verifies a token generated for the same time step', () => {
      const secret = totp.generateSecret();
      const now = Date.now();
      const token = totp.generateToken(secret, { forTime: now });
      expect(totp.verifyToken(secret, token, { forTime: now })).toBe(true);
    });

    it('rejects a token generated from a different secret', () => {
      const secretA = totp.generateSecret();
      const secretB = totp.generateSecret();
      const now = Date.now();
      const token = totp.generateToken(secretA, { forTime: now });
      expect(totp.verifyToken(secretB, token, { forTime: now })).toBe(false);
    });

    it('rejects garbage / non-numeric input without throwing', () => {
      const secret = totp.generateSecret();
      expect(totp.verifyToken(secret, 'not-a-token')).toBe(false);
      expect(totp.verifyToken(secret, '')).toBe(false);
      expect(totp.verifyToken(secret, null)).toBe(false);
      expect(totp.verifyToken(secret, undefined)).toBe(false);
    });

    it('tolerates ±1 step of clock drift (default window)', () => {
      const secret = totp.generateSecret();
      const now = Date.now();
      const oneStepAgo = now - 30_000;
      const token = totp.generateToken(secret, { forTime: oneStepAgo });
      expect(totp.verifyToken(secret, token, { forTime: now })).toBe(true);
    });

    it('rejects a token that is outside the drift window', () => {
      const secret = totp.generateSecret();
      const now = Date.now();
      const farPast = now - 5 * 30_000;
      const token = totp.generateToken(secret, { forTime: farPast });
      expect(totp.verifyToken(secret, token, { forTime: now, window: 1 })).toBe(false);
    });

    it('matches the official RFC 6238 Appendix B test vector (T=59s)', () => {
      // RFC 6238 Appendix B: secret "12345678901234567890" (ASCII), T=59s
      // (counter=1, SHA1) -> 8-digit code 94287082. Our module truncates
      // to 6 digits, which must equal the last 6 digits of that vector.
      const asciiKey = Buffer.from('12345678901234567890', 'ascii');
      const secretB32 = totp.base32Encode(asciiKey);
      const token = totp.generateToken(secretB32, { forTime: 59_000 });
      expect(token).toBe('287082');
    });
  });

  describe('generateOtpauthUrl', () => {
    it('produces a valid otpauth:// URI containing the secret and issuer', () => {
      const secret = totp.generateSecret();
      const url = totp.generateOtpauthUrl(secret, { issuer: 'Kukora', accountName: 'alice' });
      expect(url).toMatch(/^otpauth:\/\/totp\//);
      expect(url).toContain(`secret=${secret}`);
      expect(url).toContain('issuer=Kukora');
      expect(decodeURIComponent(url)).toContain('Kukora:alice');
    });
  });
});

'use strict';

/**
 * secretsVault.test.js — unit tests for server/infrastructure/secretsVault.js.
 *
 * Covers: round-trip encrypt/decrypt, tamper detection (auth tag), the
 * vault-file-first / env-var-fallback lookup order in getCredentials(),
 * and that credentials never leak in plaintext anywhere in the persisted
 * vault file. Uses a throwaway "exchange" name and cleans up after itself
 * so it never collides with real vaulted credentials.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';

const secretsVault = require('../server/infrastructure/secretsVault.js');

const TEST_EXCHANGE = '__vault_test_exchange__';

describe('secretsVault', () => {
  afterEach(() => {
    secretsVault.clearCredentials(TEST_EXCHANGE);
    delete process.env.__VAULT_TEST_KEY__;
    delete process.env.__VAULT_TEST_SECRET__;
  });

  describe('encrypt / decrypt', () => {
    it('round-trips a plaintext string exactly', () => {
      const plaintext = 'super-secret-api-key-12345';
      const encrypted = secretsVault.encrypt(plaintext);
      expect(secretsVault.decrypt(encrypted)).toBe(plaintext);
    });

    it('produces a different ciphertext each time (random IV) even for the same plaintext', () => {
      const a = secretsVault.encrypt('same-plaintext');
      const b = secretsVault.encrypt('same-plaintext');
      expect(a).not.toBe(b);
      expect(secretsVault.decrypt(a)).toBe('same-plaintext');
      expect(secretsVault.decrypt(b)).toBe('same-plaintext');
    });

    it('never leaks the plaintext as a substring of the ciphertext payload', () => {
      const plaintext = 'a-very-recognizable-api-key-string';
      const encrypted = secretsVault.encrypt(plaintext);
      expect(encrypted).not.toContain(plaintext);
    });

    it('rejects an empty string', () => {
      expect(() => secretsVault.encrypt('')).toThrow(/non-empty string/);
    });

    it('throws (does not silently corrupt) when the ciphertext has been tampered with', () => {
      const encrypted = secretsVault.encrypt('tamper-test-secret');
      const [iv, authTag, ciphertext] = encrypted.split(':');
      // Flip the ciphertext to simulate corruption/tampering.
      const tampered = [iv, authTag, Buffer.from('tampered-payload').toString('base64')].join(':');
      expect(() => secretsVault.decrypt(tampered)).toThrow();
      // Original still decrypts fine — tampering a copy doesn't affect the original.
      expect(secretsVault.decrypt(encrypted)).toBe('tamper-test-secret');
    });

    it('rejects a malformed payload shape', () => {
      expect(() => secretsVault.decrypt('not-a-valid-payload')).toThrow(/malformed payload/);
    });
  });

  describe('setCredentials / getCredentials (vault file)', () => {
    it('stores and retrieves credentials via the encrypted vault, preferring it over env vars', () => {
      process.env.__VAULT_TEST_KEY__ = 'env-key-should-not-be-used';
      process.env.__VAULT_TEST_SECRET__ = 'env-secret-should-not-be-used';

      secretsVault.setCredentials(TEST_EXCHANGE, 'vaulted-api-key', 'vaulted-api-secret');
      const result = secretsVault.getCredentials(TEST_EXCHANGE, { key: '__VAULT_TEST_KEY__', secret: '__VAULT_TEST_SECRET__' });

      expect(result).toEqual({ apiKey: 'vaulted-api-key', apiSecret: 'vaulted-api-secret', source: 'vault' });
    });

    it('is case-insensitive on the exchange name', () => {
      secretsVault.setCredentials('MixedCaseExchange__test', 'k', 's');
      const result = secretsVault.getCredentials('mixedcaseexchange__test');
      expect(result.apiKey).toBe('k');
      secretsVault.clearCredentials('MixedCaseExchange__test');
    });

    it('never stores plaintext credentials in the vault file on disk', () => {
      secretsVault.setCredentials(TEST_EXCHANGE, 'plaintext-marker-key', 'plaintext-marker-secret');
      const raw = fs.readFileSync(secretsVault.VAULT_FILE, 'utf8');
      expect(raw).not.toContain('plaintext-marker-key');
      expect(raw).not.toContain('plaintext-marker-secret');
    });

    it('falls back to plaintext env vars when no vaulted credentials exist for the exchange', () => {
      process.env.__VAULT_TEST_KEY__ = 'env-only-key';
      process.env.__VAULT_TEST_SECRET__ = 'env-only-secret';
      const result = secretsVault.getCredentials(TEST_EXCHANGE, { key: '__VAULT_TEST_KEY__', secret: '__VAULT_TEST_SECRET__' });
      expect(result).toEqual({ apiKey: 'env-only-key', apiSecret: 'env-only-secret', source: 'env' });
    });

    it('returns source "none" when neither the vault nor env vars have credentials', () => {
      const result = secretsVault.getCredentials(TEST_EXCHANGE, { key: '__VAULT_TEST_KEY__', secret: '__VAULT_TEST_SECRET__' });
      expect(result).toEqual({ apiKey: null, apiSecret: null, source: 'none' });
    });

    it('hasVaultedCredentials reflects the current vault state accurately', () => {
      expect(secretsVault.hasVaultedCredentials(TEST_EXCHANGE)).toBe(false);
      secretsVault.setCredentials(TEST_EXCHANGE, 'k', 's');
      expect(secretsVault.hasVaultedCredentials(TEST_EXCHANGE)).toBe(true);
      secretsVault.clearCredentials(TEST_EXCHANGE);
      expect(secretsVault.hasVaultedCredentials(TEST_EXCHANGE)).toBe(false);
    });

    it('clearCredentials reports whether an entry actually existed', () => {
      const noneToDelete = secretsVault.clearCredentials(TEST_EXCHANGE);
      expect(noneToDelete.existed).toBe(false);

      secretsVault.setCredentials(TEST_EXCHANGE, 'k', 's');
      const deleted = secretsVault.clearCredentials(TEST_EXCHANGE);
      expect(deleted.existed).toBe(true);
    });

    it('rejects setCredentials with missing arguments', () => {
      expect(() => secretsVault.setCredentials(TEST_EXCHANGE, '', 'secret')).toThrow(/requires all three/);
      expect(() => secretsVault.setCredentials(TEST_EXCHANGE, 'key', '')).toThrow(/requires all three/);
    });
  });
});

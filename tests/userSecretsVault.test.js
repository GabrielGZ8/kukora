'use strict';

/**
 * userSecretsVault.test.js — checkpoint-37: per-user exchange credentials
 * vault (extends the global-only secretsVault.js — see that file's header
 * for the design rationale).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import * as userSecretsVault from '../server/infrastructure/userSecretsVault.js';

function freshUserId() {
  return `test-user-${Math.random().toString(36).slice(2)}`;
}

function setReadyState(v) { mongoose.connection.readyState = v; }

describe('userSecretsVault', () => {
  beforeEach(() => {
    userSecretsVault._resetForTests();
    userSecretsVault._setMongooseForTests(mongoose);
  });

  afterEach(() => {
    mongoose.connection.readyState = 0;
    userSecretsVault._resetForTests();
    userSecretsVault._resetMongooseForTests();
    vi.restoreAllMocks();
  });

  describe('setUserCredentials — requires a working DB (not fire-and-forget)', () => {
    it('throws (does not silently succeed) when MongoDB is not connected', async () => {
      setReadyState(0);
      await expect(
        userSecretsVault.setUserCredentials(freshUserId(), 'binance', 'key123', 'secret456')
      ).rejects.toThrow(/database is not connected/i);
    });

    it('throws when required arguments are missing', async () => {
      setReadyState(1);
      await expect(
        userSecretsVault.setUserCredentials(freshUserId(), 'binance', '', 'secret')
      ).rejects.toThrow(/requires all four arguments/);
    });
  });

  describe('happy path — Mongo connected (mocked model)', () => {
    let Model;
    let store;

    beforeEach(() => {
      setReadyState(1);
      store = new Map(); // key: `${userId}::${exchange}` -> doc
      Model = require('../server/models').UserExchangeCredential;
      Model.findOneAndUpdate = vi.fn(async (filter, update) => {
        const key = `${filter.userId}::${filter.exchange}`;
        const existing = store.get(key);
        const doc = {
          userId: filter.userId,
          exchange: filter.exchange,
          ...(update.$set || {}),
          connectedAt: existing?.connectedAt || update.$setOnInsert.connectedAt,
        };
        store.set(key, doc);
        return doc;
      });
      Model.findOne = vi.fn((filter) => ({
        lean: async () => store.get(`${filter.userId}::${filter.exchange}`) || null,
      }));
      Model.find = vi.fn((filter) => ({
        sort: () => ({
          lean: async () => [...store.values()].filter(d => d.userId === filter.userId),
        }),
      }));
      Model.findOneAndDelete = vi.fn(async (filter) => {
        const key = `${filter.userId}::${filter.exchange}`;
        const doc = store.get(key) || null;
        store.delete(key);
        return doc;
      });
    });

    it('round-trips credentials through Mongo (cache cleared) — encrypts on write, decrypts on read', async () => {
      const userId = freshUserId();
      await userSecretsVault.setUserCredentials(userId, 'Binance', 'my-api-key', 'my-api-secret');

      userSecretsVault._resetForTests();

      const result = await userSecretsVault.getUserCredentials(userId, 'binance');
      expect(result).toMatchObject({ apiKey: 'my-api-key', apiSecret: 'my-api-secret', source: 'user' });
    });

    it('never stores apiKey/apiSecret in plaintext in the persisted doc', async () => {
      const userId = freshUserId();
      await userSecretsVault.setUserCredentials(userId, 'binance', 'plaintext-marker-key', 'plaintext-marker-secret');
      const raw = JSON.stringify(store.get(`${userId}::binance`));
      expect(raw).not.toContain('plaintext-marker-key');
      expect(raw).not.toContain('plaintext-marker-secret');
    });

    it('is case-insensitive on the exchange name', async () => {
      const userId = freshUserId();
      await userSecretsVault.setUserCredentials(userId, 'Binance', 'k', 's');
      userSecretsVault._resetForTests();
      const result = await userSecretsVault.getUserCredentials(userId, 'BINANCE');
      expect(result.apiKey).toBe('k');
    });

    it('vaults the OKX passphrase alongside key/secret when provided', async () => {
      const userId = freshUserId();
      await userSecretsVault.setUserCredentials(userId, 'okx', 'k', 's', { passphrase: 'my-passphrase' });
      userSecretsVault._resetForTests();
      const result = await userSecretsVault.getUserCredentials(userId, 'okx');
      expect(result.apiPassphrase).toBe('my-passphrase');
    });

    it('reconnecting the same exchange rotates (upserts) rather than duplicating', async () => {
      const userId = freshUserId();
      await userSecretsVault.setUserCredentials(userId, 'binance', 'old-key', 'old-secret');
      await userSecretsVault.setUserCredentials(userId, 'binance', 'new-key', 'new-secret');
      userSecretsVault._resetForTests();
      const result = await userSecretsVault.getUserCredentials(userId, 'binance');
      expect(result.apiKey).toBe('new-key');
      expect(store.size).toBe(1);
    });

    it('listUserExchanges returns only exchange + connectedAt — never key material', async () => {
      const userId = freshUserId();
      await userSecretsVault.setUserCredentials(userId, 'binance', 'k1', 's1');
      await userSecretsVault.setUserCredentials(userId, 'kraken', 'k2', 's2');
      const list = await userSecretsVault.listUserExchanges(userId);
      expect(list).toHaveLength(2);
      const exchanges = list.map(e => e.exchange).sort();
      expect(exchanges).toEqual(['binance', 'kraken']);
      for (const entry of list) {
        expect(entry).not.toHaveProperty('apiKey');
        expect(entry).not.toHaveProperty('apiKeyEnc');
        expect(entry).not.toHaveProperty('apiSecretEnc');
        expect(JSON.stringify(entry)).not.toContain('k1');
        expect(JSON.stringify(entry)).not.toContain('s1');
      }
    });

    it('hasAnyUserExchange reflects whether the user has connected anything', async () => {
      const userId = freshUserId();
      expect(await userSecretsVault.hasAnyUserExchange(userId)).toBe(false);
      await userSecretsVault.setUserCredentials(userId, 'binance', 'k', 's');
      expect(await userSecretsVault.hasAnyUserExchange(userId)).toBe(true);
    });

    it('deleteUserCredentials removes the credential and reports existed:true', async () => {
      const userId = freshUserId();
      await userSecretsVault.setUserCredentials(userId, 'binance', 'k', 's');
      const result = await userSecretsVault.deleteUserCredentials(userId, 'binance');
      expect(result).toEqual({ ok: true, existed: true });
      userSecretsVault._resetForTests();
      expect(await userSecretsVault.getUserCredentials(userId, 'binance')).toBeNull();
    });

    it('deleteUserCredentials reports existed:false for a never-connected exchange', async () => {
      const result = await userSecretsVault.deleteUserCredentials(freshUserId(), 'binance');
      expect(result).toEqual({ ok: true, existed: false });
    });
  });

  describe('getUserCredentials — read-side fallback contract', () => {
    it('returns null (never throws) for a user with no credentials at all, DB connected', async () => {
      setReadyState(1);
      const Model = require('../server/models').UserExchangeCredential;
      Model.findOne = vi.fn(() => ({ lean: async () => null }));
      const result = await userSecretsVault.getUserCredentials(freshUserId(), 'binance');
      expect(result).toBeNull();
    });

    it('returns null when the DB is not connected and nothing is cached', async () => {
      setReadyState(0);
      const result = await userSecretsVault.getUserCredentials(freshUserId(), 'binance');
      expect(result).toBeNull();
    });

    it('serves from the in-memory cache without touching Mongo once populated', async () => {
      setReadyState(1);
      const Model = require('../server/models').UserExchangeCredential;
      const userId = freshUserId();
      let calls = 0;
      Model.findOneAndUpdate = vi.fn(async (filter, update) => {
        const doc = { ...filter, ...(update.$set || {}), connectedAt: update.$setOnInsert.connectedAt };
        return doc;
      });
      await userSecretsVault.setUserCredentials(userId, 'binance', 'cached-key', 'cached-secret');

      Model.findOne = vi.fn(() => { calls++; return { lean: async () => null }; });
      const result = await userSecretsVault.getUserCredentials(userId, 'binance');
      expect(result.apiKey).toBe('cached-key');
      expect(calls).toBe(0); // never hit Mongo — served from cache
    });
  });

  describe('listUserExchanges / hasAnyUserExchange — DB not connected', () => {
    it('listUserExchanges returns an empty array when DB is not connected', async () => {
      setReadyState(0);
      expect(await userSecretsVault.listUserExchanges(freshUserId())).toEqual([]);
    });

    it('hasAnyUserExchange returns false when DB is not connected', async () => {
      setReadyState(0);
      expect(await userSecretsVault.hasAnyUserExchange(freshUserId())).toBe(false);
    });
  });
});

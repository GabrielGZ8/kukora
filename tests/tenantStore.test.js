'use strict';

import { describe, it, expect } from 'vitest';
const { createTenantStore, DEFAULT_UID, DEFAULT_BOT_ID, resolveTenantKey } = require('../server/infrastructure/tenantStore');

describe('tenantStore', () => {
  it('lazily creates a fresh state per uid using initFn', () => {
    const store = createTenantStore(() => ({ count: 0 }));
    const a = store.get('user-a');
    const b = store.get('user-b');
    expect(a).not.toBe(b); // different references
    a.count = 5;
    expect(store.get('user-a').count).toBe(5);
    expect(store.get('user-b').count).toBe(0);
  });

  it('falls back to DEFAULT_UID for null/undefined/empty uid', () => {
    const store = createTenantStore(() => ({ v: 1 }));
    const a = store.get(undefined);
    const b = store.get(null);
    const c = store.get('');
    const d = store.get(DEFAULT_UID);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(c).toBe(d);
  });

  it('reset(uid) replaces only that tenant state with a fresh instance', () => {
    const store = createTenantStore(() => ({ n: 0 }));
    store.get('u1').n = 10;
    store.get('u2').n = 20;
    store.reset('u1');
    expect(store.get('u1').n).toBe(0);
    expect(store.get('u2').n).toBe(20);
  });

  it('keys() lists every uid touched so far', () => {
    const store = createTenantStore(() => ({}));
    store.get('u1'); store.get('u2');
    expect(store.keys().sort()).toEqual(['u1', 'u2']);
  });

  it('delete(uid) removes a tenant so the next get() creates a brand new state', () => {
    const store = createTenantStore(() => ({ n: 0 }));
    store.get('u1').n = 99;
    store.delete('u1');
    expect(store.get('u1').n).toBe(0);
  });

  it('throws if initFn is not a function', () => {
    expect(() => createTenantStore(null)).toThrow();
  });

  // ── Part B (Sesión 2026-07-07): fuga de memoria — LRU acotado ──────────
  describe('bounded LRU (Part B memory-leak finding)', () => {
    it('REGRESIÓN: evicts the least-recently-used uid once maxTenants is reached', () => {
      const store = createTenantStore(() => ({ n: 0 }), { maxTenants: 2 });
      store.get('u1').n = 1;
      store.get('u2').n = 2;
      // u3 empuja el store por encima del tope de 2 — debe desalojar al
      // menos recientemente usado (u1, nunca vuelto a tocar).
      store.get('u3').n = 3;

      expect(store.keys().sort()).toEqual(['u2', 'u3']);
      // u1 fue expulsado: pedirlo de nuevo crea un estado FRESCO, no el
      // viejo con n=1 — la prueba real de que fue desalojado y no solo
      // "olvidado por keys() pero aún vivo".
      expect(store.get('u1').n).toBe(0);
    });

    it('get() counts as access — touching u1 keeps it alive over an older-but-untouched uid', () => {
      const store = createTenantStore(() => ({ n: 0 }), { maxTenants: 2 });
      store.get('u1').n = 1;
      store.get('u2').n = 2;
      store.get('u1'); // re-acceder a u1 lo vuelve "más reciente" que u2
      store.get('u3').n = 3; // debe desalojar a u2, no a u1

      expect(store.keys().sort()).toEqual(['u1', 'u3']);
      expect(store.get('u1').n).toBe(1); // u1 sobrevivió con su valor intacto
    });

    it('never exceeds maxTenants even under sustained growth (the actual leak scenario)', () => {
      const store = createTenantStore(() => ({}), { maxTenants: 50 });
      for (let i = 0; i < 500; i++) store.get(`user-${i}`);
      expect(store.keys().length).toBeLessThanOrEqual(50);
    });

    it('defaults to a generous cap (1000) when maxTenants is not specified — no behavior change for realistic loads', () => {
      const store = createTenantStore(() => ({}));
      for (let i = 0; i < 100; i++) store.get(`user-${i}`);
      expect(store.keys().length).toBe(100); // muy por debajo del default — nada desalojado
    });
  });

  describe('isProtected (checkpoint 27 fix — never evict an active tenant)', () => {
    it('skips a protected key and evicts the next-oldest unprotected one instead', () => {
      const protectedUids = new Set(['u1']); // u1 simula "bot encendido"
      const store = createTenantStore(() => ({ n: 0 }), {
        maxTenants: 2,
        isProtected: (uid) => protectedUids.has(uid),
      });
      store.get('u1').n = 1; // oldest, but protected
      store.get('u2').n = 2;
      store.get('u3').n = 3; // would normally evict u1 — must evict u2 instead

      expect(store.keys().sort()).toEqual(['u1', 'u3']);
      expect(store.get('u1').n).toBe(1); // u1 survived intact — never recreated fresh
      expect(store.get('u2').n).toBe(0); // u2 was actually the one evicted
    });

    it('grows past maxTenants rather than evicting when every existing key is protected', () => {
      const store = createTenantStore(() => ({ n: 0 }), {
        maxTenants: 2,
        isProtected: () => true, // everyone's bot is "on"
      });
      store.get('u1').n = 1;
      store.get('u2').n = 2;
      store.get('u3').n = 3; // nothing safe to evict

      expect(store.keys().sort()).toEqual(['u1', 'u2', 'u3']);
      expect(store.get('u1').n).toBe(1);
      expect(store.get('u2').n).toBe(2);
    });

    it('a predicate that throws is treated as "not protected" — never breaks the store', () => {
      const store = createTenantStore(() => ({ n: 0 }), {
        maxTenants: 2,
        isProtected: () => { throw new Error('boom'); },
      });
      store.get('u1').n = 1;
      store.get('u2').n = 2;
      expect(() => store.get('u3').n = 3).not.toThrow();
      expect(store.keys().length).toBeLessThanOrEqual(2);
    });

    it('with no isProtected option, behavior is byte-for-byte identical to before this fix', () => {
      const store = createTenantStore(() => ({ n: 0 }), { maxTenants: 2 });
      store.get('u1').n = 1;
      store.get('u2').n = 2;
      store.get('u3').n = 3;
      expect(store.keys().sort()).toEqual(['u2', 'u3']);
      expect(store.get('u1').n).toBe(0);
    });
  });

  describe('resolveTenantKey (ADR-017, convención multi-bot futura)', () => {
    it('returns the bare uid when botId is omitted/default (no change for any existing caller)', () => {
      expect(resolveTenantKey('u1')).toBe('u1');
      expect(resolveTenantKey('u1', DEFAULT_BOT_ID)).toBe('u1');
    });

    it('falls back to DEFAULT_UID/DEFAULT_BOT_ID like the store does', () => {
      expect(resolveTenantKey(undefined)).toBe(DEFAULT_UID);
      expect(resolveTenantKey(null)).toBe(DEFAULT_UID);
    });

    it('builds a composite key only when a non-default botId is given', () => {
      expect(resolveTenantKey('u1', 'strategyB')).toBe('u1::strategyB');
      expect(resolveTenantKey('u1', 'strategyB')).not.toBe(resolveTenantKey('u1'));
    });
  });
});

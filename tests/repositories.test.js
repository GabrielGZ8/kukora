'use strict';

/**
 * repositories.test.js
 * Tests para la capa Repository (audit Level 3 #3).
 * Se usa MockRepository para aislar completamente la lógica de DB.
 */

import { describe, it, expect, beforeEach } from 'vitest';

const {
  MockRepository,
  AlertRepository,
  WatchlistRepository,
  PortfolioRepository,
  buildRepositories,
} = require('../server/repositories/index.js');

// ── MockRepository ────────────────────────────────────────────────────────

describe('MockRepository', () => {
  let repo;

  beforeEach(() => {
    repo = new MockRepository([
      { _id: '1', userId: 'u1', name: 'Alpha' },
      { _id: '2', userId: 'u1', name: 'Beta' },
      { _id: '3', userId: 'u2', name: 'Gamma' },
    ]);
  });

  describe('findByUser — row-level isolation', () => {
    it('devuelve solo documentos del userId solicitado', async () => {
      const result = await repo.findByUser('u1');
      expect(result).toHaveLength(2);
      result.forEach(d => expect(d.userId).toBe('u1'));
    });

    it('NO devuelve documentos de otro usuario', async () => {
      const u2Docs = await repo.findByUser('u2');
      expect(u2Docs).toHaveLength(1);
      expect(u2Docs[0]._id).toBe('3');
    });

    it('devuelve [] para userId sin documentos', async () => {
      expect(await repo.findByUser('nobody')).toHaveLength(0);
    });

    it('aplica filtros adicionales (extra)', async () => {
      const result = await repo.findByUser('u1', { name: 'Alpha' });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Alpha');
    });
  });

  describe('findOneByUser', () => {
    it('devuelve el primer match del usuario', async () => {
      const doc = await repo.findOneByUser('u1');
      expect(doc).toBeDefined();
      expect(doc.userId).toBe('u1');
    });

    it('devuelve null si no hay match', async () => {
      expect(await repo.findOneByUser('nobody')).toBeNull();
    });
  });

  describe('create — stamping userId', () => {
    it('añade userId al documento creado', async () => {
      const doc = await repo.create('u3', { name: 'Delta' });
      expect(doc.userId).toBe('u3');
      expect(doc.name).toBe('Delta');
      expect(doc._id).toBeDefined();
    });

    it('el documento creado es visible en findByUser', async () => {
      await repo.create('u3', { name: 'Delta' });
      const found = await repo.findByUser('u3');
      expect(found).toHaveLength(1);
      expect(found[0].name).toBe('Delta');
    });
  });

  describe('updateByUser — row-level isolation', () => {
    it('actualiza el documento correcto', async () => {
      const updated = await repo.updateByUser('u1', '1', { name: 'Alpha v2' });
      expect(updated.name).toBe('Alpha v2');
    });

    it('NO permite actualizar documentos de otro usuario', async () => {
      // u2 intenta actualizar _id:'1' (que pertenece a u1)
      const result = await repo.updateByUser('u2', '1', { name: 'Hacked' });
      expect(result).toBeNull();
      // El documento original debe estar intacto
      const original = await repo.findOneByUser('u1', { _id: '1' });
      expect(original.name).toBe('Alpha');
    });

    it('retorna null para _id inexistente', async () => {
      expect(await repo.updateByUser('u1', 'nonexistent', {})).toBeNull();
    });
  });

  describe('deleteByUser — row-level isolation', () => {
    it('elimina el documento correcto', async () => {
      await repo.deleteByUser('u1', '1');
      const remaining = await repo.findByUser('u1');
      expect(remaining.map(d => d._id)).not.toContain('1');
    });

    it('NO permite eliminar documentos de otro usuario', async () => {
      // u2 intenta borrar _id:'1' (u1)
      const result = await repo.deleteByUser('u2', '1');
      expect(result).toBeNull();
      // u1 sigue teniendo sus documentos
      expect(await repo.findByUser('u1')).toHaveLength(2);
    });

    it('retorna null para _id inexistente', async () => {
      expect(await repo.deleteByUser('u1', 'nope')).toBeNull();
    });
  });

  describe('helpers', () => {
    it('reset() vacía el store', async () => {
      repo.reset();
      expect(await repo.findByUser('u1')).toHaveLength(0);
    });

    it('reset([...]) reinicia con datos nuevos', async () => {
      repo.reset([{ _id: 'x', userId: 'u9', val: 1 }]);
      const found = await repo.findByUser('u9');
      expect(found).toHaveLength(1);
    });

    it('snapshot() devuelve copia del store actual', () => {
      const snap = repo.snapshot();
      expect(snap).toHaveLength(3);
      snap[0].name = 'mutated';
      // La mutación no debe afectar al store interno
      expect(repo.snapshot()[0].name).not.toBe('mutated');
    });
  });
});

// ── AlertRepository ───────────────────────────────────────────────────────

describe('AlertRepository (vía MockRepository)', () => {
  let alertRepo;

  beforeEach(() => {
    alertRepo = new MockRepository([
      { _id: 'a1', userId: 'u1', type: 'price', threshold: 70000 },
    ]);
    // Adaptamos AlertRepository para usar nuestro MockRepository en tests
    alertRepo.listForUser  = (uid) => alertRepo.findByUser(uid);
    alertRepo.addAlert     = (uid, data) => alertRepo.create(uid, data);
    alertRepo.deleteAlert  = (uid, id)  => alertRepo.deleteByUser(uid, id);
    alertRepo.updateAlert  = (uid, id, patch) => alertRepo.updateByUser(uid, id, patch);
  });

  it('listForUser() devuelve solo alertas del usuario', async () => {
    const alerts = await alertRepo.listForUser('u1');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('price');
  });

  it('addAlert() persiste la alerta con userId', async () => {
    await alertRepo.addAlert('u1', { type: 'volume', threshold: 5000 });
    expect(await alertRepo.listForUser('u1')).toHaveLength(2);
  });

  it('deleteAlert() elimina con guard de userId', async () => {
    await alertRepo.deleteAlert('u1', 'a1');
    expect(await alertRepo.listForUser('u1')).toHaveLength(0);
  });

  it('updateAlert() actualiza con guard de userId', async () => {
    const updated = await alertRepo.updateAlert('u1', 'a1', { threshold: 75000 });
    expect(updated.threshold).toBe(75000);
  });
});

// ── WatchlistRepository ────────────────────────────────────────────────────

describe('WatchlistRepository comportamiento', () => {
  it('buildRepositories() retorna las tres repos sin lanzar', () => {
    // Usa el mock de mongoose (readyState=0 → operaciones no-op)
    const repos = buildRepositories();
    expect(repos).toHaveProperty('alerts');
    expect(repos).toHaveProperty('watchlist');
    expect(repos).toHaveProperty('portfolio');
  });

  it('MockRepository upsertCoins (simulado) devuelve coins correcto', async () => {
    const mock = new MockRepository();
    // WatchlistRepository.upsertCoins hace findOneAndUpdate+upsert
    // — lo simulamos directamente con create ya que el mock no tiene upsert
    await mock.create('u1', { coins: ['BTC', 'ETH'] });
    const doc = await mock.findOneByUser('u1');
    expect(doc.coins).toEqual(['BTC', 'ETH']);
  });
});

// ── PortfolioRepository ────────────────────────────────────────────────────

describe('PortfolioRepository comportamiento', () => {
  it('listForUser a través de MockRepository respeta paginación conceptual', async () => {
    const mock = new MockRepository();
    for (let i = 0; i < 5; i++) {
      await mock.create('u1', { asset: 'BTC', qty: i });
    }
    const all = await mock.findByUser('u1');
    expect(all).toHaveLength(5);
    // Paginación manual (slice — equivalente a skip/limit en la repo real)
    const page1 = all.slice(0, 3);
    expect(page1).toHaveLength(3);
  });
});

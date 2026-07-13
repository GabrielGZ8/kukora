'use strict';

/**
 * rebalanceEngine.getTopViableSuggestion.test.js — bug fix coverage
 * (refinamiento post-Sesión 34, Área 3).
 *
 * Ver el comentario extenso junto a getTopViableSuggestion() en
 * rebalanceEngine.js: getLastSuggestion() devuelve el wrapper
 * {suggestions, analysis, ...} — nunca tuvo forma de sugerencia individual,
 * así que el fallback de POST /rebalance/execute (y ahora también
 * rebalanceScheduler.js) necesitaban una función que sí extrajera una
 * sugerencia plana y usable.
 *
 * NOTA TÉCNICA: en vez de mockear walletManager (rebalanceEngine.js
 * desestructura `getBalances` en tiempo de carga — un vi.spyOn/vi.mock
 * posterior no siempre es visible de forma consistente entre el grafo
 * ESM del test y el require() CJS interno del módulo bajo prueba, un
 * problema ya observado en otros archivos de este proyecto), este test
 * usa `walletManager.applyRebalanceTransfer` — la misma función de
 * producción real — para generar un desbalance genuino en el wallet
 * singleton compartido, y luego llama a las funciones reales sin mocks.
 */

import { describe, it, expect, beforeEach } from 'vitest';

const rebalanceEngine = require('../server/domain/engines/rebalanceEngine');
const walletManager = require('../server/domain/wallet/walletManager');

describe('rebalanceEngine — getTopViableSuggestion (bug fix)', () => {
  beforeEach(() => { walletManager.resetBalances(); });

  it('returns null when no rebalance is currently needed (fresh, balanced wallets)', () => {
    rebalanceEngine.suggestRebalance(50000);
    expect(rebalanceEngine.getTopViableSuggestion()).toBeNull();
  });

  it('extracts a flat, single suggestion object (not the wrapper) after a real imbalance is created', () => {
    const exchanges = walletManager.EXCHANGES;
    // Concentrate USDT from every other exchange onto the first one, using
    // the real transfer function — genuine imbalance, no mocking.
    for (const ex of exchanges.slice(1)) {
      walletManager.applyRebalanceTransfer('USDT', ex, exchanges[0], 100000, 0);
    }
    rebalanceEngine.suggestRebalance(50000);
    const top = rebalanceEngine.getTopViableSuggestion();
    expect(top).not.toBeNull();
    // The bug this fixes: getLastSuggestion() has no .asset/.from/.to/.amount
    // at its top level (they're nested under .suggestions[i]) — this
    // function must return the flat shape executeRebalance() expects.
    expect(top).toHaveProperty('asset');
    expect(top).toHaveProperty('from');
    expect(top).toHaveProperty('to');
    expect(top).toHaveProperty('amount');
    expect(typeof top.viable).toBe('boolean');
    expect(top.viable).toBe(true);
  });

  it('getLastSuggestion() itself is unchanged — still returns the full wrapper shape (no regression for existing consumers)', () => {
    const exchanges = walletManager.EXCHANGES;
    for (const ex of exchanges.slice(1)) {
      walletManager.applyRebalanceTransfer('USDT', ex, exchanges[0], 100000, 0);
    }
    rebalanceEngine.suggestRebalance(50000);
    const wrapper = rebalanceEngine.getLastSuggestion();
    expect(wrapper).toHaveProperty('suggestions');
    expect(wrapper).toHaveProperty('analysis');
    expect(Array.isArray(wrapper.suggestions)).toBe(true);
  });

  it('a flat suggestion from getTopViableSuggestion() is directly accepted by executeRebalance() (not the pre-fix generic rejection)', () => {
    const exchanges = walletManager.EXCHANGES;
    for (const ex of exchanges.slice(1)) {
      walletManager.applyRebalanceTransfer('USDT', ex, exchanges[0], 100000, 0);
    }
    rebalanceEngine.suggestRebalance(50000);
    const top = rebalanceEngine.getTopViableSuggestion();
    const result = rebalanceEngine.executeRebalance(top, 50000);
    // Whatever the outcome, it must NOT be the generic "not viable or not
    // suggested" reason that the wrapper-shape bug always produced when
    // getLastSuggestion() was passed directly to executeRebalance().
    expect(result.reason).not.toBe('Rebalance not viable or not suggested');
    expect(result.ok).toBe(true);
  });
});

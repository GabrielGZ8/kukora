'use strict';
/**
 * i18n.test.js — H-10 (Sesión 26)
 *
 * No hay infraestructura de testing de componentes React en este proyecto
 * (vitest.config.js usa environment: 'node', sin jsdom — ver M-9/M-10 en
 * MIGRATION_CLEANUP_LOG.md). Estos tests cubren la parte que sí es lógica
 * pura y testeable sin DOM: los diccionarios en sí (misma comprobación que
 * scripts/checkI18nCoverage.js, pero como test de vitest para que corra en
 * `npm run test` sin necesitar un paso aparte) y la función de lookup con
 * fallback que usa I18nContext.jsx internamente.
 */

import { describe, it, expect } from 'vitest';
import es from '../src/i18n/dictionaries/es';
import en from '../src/i18n/dictionaries/en';

function collectKeys(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) keys.push(...collectKeys(v, full));
    else keys.push(full);
  }
  return keys;
}

// Misma función `lookup` de src/i18n/I18nContext.jsx, reimplementada aquí
// a propósito: I18nContext.jsx exporta componentes React (JSX), y este
// archivo de test corre con environment:'node' sin jsdom — importarlo
// directamente requeriría renderizar un componente, que es justo la
// infraestructura que no existe todavía (ver nota de cabecera). La lógica
// de lookup es trivial y estable; duplicarla aquí es más barato y más
// honesto que forzar un montaje de React sin las herramientas para eso.
function lookup(dict, key) {
  return key.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), dict);
}

describe('i18n dictionaries (H-10)', () => {
  it('es.js y en.js tienen exactamente el mismo conjunto de llaves', () => {
    const esKeys = new Set(collectKeys(es));
    const enKeys = new Set(collectKeys(en));
    const onlyInEs = [...esKeys].filter(k => !enKeys.has(k));
    const onlyInEn = [...enKeys].filter(k => !esKeys.has(k));
    expect(onlyInEs).toEqual([]);
    expect(onlyInEn).toEqual([]);
    expect(esKeys.size).toBeGreaterThan(0);
  });

  it('ningún valor de ninguno de los dos diccionarios está vacío o undefined', () => {
    for (const [name, dict] of [['es', es], ['en', en]]) {
      for (const key of collectKeys(dict)) {
        const value = lookup(dict, key);
        expect(value, `${name}.${key} no debe estar vacío`).toBeTruthy();
        expect(typeof value).toBe('string');
      }
    }
  });

  it('lookup() resuelve llaves anidadas correctamente', () => {
    expect(lookup(es, 'nav.dashboard')).toBe('Panel');
    expect(lookup(en, 'nav.dashboard')).toBe('Dashboard');
    expect(lookup(es, 'triangular.netProfit')).toBe('Profit neto');
    expect(lookup(en, 'triangular.netProfit')).toBe('Net profit');
  });

  it('lookup() retorna undefined para una llave inexistente (el fallback lo maneja I18nContext, no lookup)', () => {
    expect(lookup(es, 'nav.doesNotExist')).toBeUndefined();
    expect(lookup(es, 'completely.made.up.path')).toBeUndefined();
  });

  it('español es funcionalmente distinto de inglés para las llaves de nav (no son copias accidentales)', () => {
    const navKeys = Object.keys(es.nav);
    const identical = navKeys.filter(k => es.nav[k] === en.nav[k]);
    // Algunas palabras son legítimamente iguales en ambos idiomas (p.ej.
    // "Score", "Dashboard" a veces) — pero la mayoría no deberían serlo.
    expect(identical.length).toBeLessThan(navKeys.length);
  });
});

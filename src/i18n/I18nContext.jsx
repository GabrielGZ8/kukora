import { createContext, useContext, useState, useCallback, useMemo } from 'react';
import es from './dictionaries/es';
import en from './dictionaries/en';

/**
 * src/i18n/I18nContext.jsx — H-10 (Sesión 26)
 *
 * Sistema de i18n mínimo, sin dependencia externa (mismo criterio que
 * ADR-013/ADR-014: no agregar una librería — react-i18next, etc. — hasta
 * que la necesidad real lo justifique; con 2 idiomas y ~una decena de
 * secciones, un dictionary lookup simple alcanza).
 *
 * Español es el idioma por defecto de la plataforma (decisión de producto,
 * no un fallback técnico). Inglés está disponible vía el selector de
 * idioma en Layout.jsx. La preferencia se persiste en localStorage bajo
 * la key 'kukora_lang' (mismo patrón ya usado en el proyecto — ver
 * src/hooks/useOnboarding.js, src/components/layout/Layout.jsx).
 */

const DICTIONARIES = { es, en };
const STORAGE_KEY = 'kukora_lang';
const DEFAULT_LANG = 'es';

function readStoredLang() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'en' || stored === 'es' ? stored : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG; // localStorage puede no estar disponible (SSR, modo privado, etc.)
  }
}

function lookup(dict, key) {
  return key.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), dict);
}

const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(readStoredLang);

  const setLang = useCallback((next) => {
    if (next !== 'es' && next !== 'en') return;
    setLangState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* non-fatal */ }
  }, []);

  const t = useCallback((key) => {
    const primary  = lookup(DICTIONARIES[lang], key);
    if (primary !== undefined) return primary;
    // Fallback: si falta la llave en el idioma activo, usar español antes
    // que mostrar la key cruda al usuario — nunca dejar un string roto
    // visible en producción.
    const fallback = lookup(DICTIONARIES[DEFAULT_LANG], key);
    if (fallback !== undefined) return fallback;
    return key;
  }, [lang]);

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation() {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useTranslation() debe usarse dentro de un <I18nProvider>');
  }
  return ctx;
}

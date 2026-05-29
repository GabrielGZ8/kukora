// ─── useOnboarding.js ─────────────────────────────────────────────────────
// Persiste el estado del onboarding en localStorage
// Exporta: show, dismiss, reset, step, setStep

import { useState, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'kukora_onboarding_v1';

export function useOnboarding() {
  const [show, setShow]   = useState(false);
  const [step, setStep]   = useState(0);

  // Leer localStorage al montar
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) {
        // Primera vez: mostrar después de 800ms (deja que cargue la app)
        const t = setTimeout(() => setShow(true), 800);
        return () => clearTimeout(t);
      }
    } catch {}
  }, []);

  const dismiss = useCallback(() => {
    setShow(false);
    setStep(0);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ completed: true, date: Date.now() })); } catch {}
  }, []);

  const reset = useCallback(() => {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    setStep(0);
    setShow(true);
  }, []);

  const open = useCallback(() => {
    setStep(0);
    setShow(true);
  }, []);

  return { show, open, dismiss, reset, step, setStep };
}

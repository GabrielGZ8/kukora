// ─── useServerSync.js ──────────────────────────────────────────────────────
// Handles MongoDB persistence with transparent localStorage fallback.
// Returns { data, setData, loading, serverAvailable }
// Usage: const { data, setData, loading } = useServerSync('portfolio', defaultValue)

import { useState, useEffect, useRef } from 'react';
import { api } from '../api';

function ls_get(key, def) {
  try { return JSON.parse(localStorage.getItem(`kukora_${key}`) || JSON.stringify(def)); }
  catch { return def; }
}
function ls_set(key, val) {
  try { localStorage.setItem(`kukora_${key}`, JSON.stringify(val)); } catch { /* quota exceeded or private browsing — silent fallback */ }
}

export function useServerSync(resource, defaultValue = []) {
  const [data, setData]                = useState(() => ls_get(resource, defaultValue));
  const [loading, setLoading]          = useState(true);
  const [serverAvailable, setSrvAvail] = useState(true);
  // Capture defaultValue in a ref so a literal ([]) passed by the caller
  // doesn't retrigger the load effect on every parent render.
  const defaultValueRef = useRef(defaultValue);

  // Probe server availability via the authenticated /api/auth/me endpoint
  // so we never expose health state to unauthenticated callers.
  useEffect(() => {
    const probe = async () => {
      try {
        const user = await api.profile.get();
        setSrvAvail(!!user);
      } catch {
        setSrvAvail(false);
      }
    };
    probe();
  }, []);

  // Load from server (fallback to localStorage) using authenticated helpers.
  useEffect(() => {
    const def = defaultValueRef.current;
    const load = async () => {
      setLoading(true);
      try {
        if (resource === 'alerts') {
          const items = await api.alerts.list();
          const alerts = Array.isArray(items) ? items : [];
          setData(alerts);
          ls_set(resource, alerts);
        } else if (resource === 'watchlist') {
          const wl = await api.watchlist.get();
          const coins = wl?.coins ?? def;
          setData(coins);
          ls_set(resource, coins);
        } else if (resource === 'portfolio') {
          const items = await api.portfolio.list();
          setData(items);
          ls_set(resource, items);
        }
        setSrvAvail(true);
      } catch {
        // Server unavailable — use localStorage data
        setSrvAvail(false);
        setData(ls_get(resource, def));
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [resource]);

  return { data, setData, loading, serverAvailable };
}

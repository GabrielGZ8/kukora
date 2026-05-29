// ─── useServerSync.js ──────────────────────────────────────────────────────
// Handles MongoDB persistence with transparent localStorage fallback.
// Returns { data, loading, save, remove, serverAvailable }
// Usage: const { data, save, remove } = useServerSync('portfolio', defaultValue)

import { useState, useEffect, useRef, useCallback } from 'react';

const CACHE = {};

function ls_get(key, def) {
  try { return JSON.parse(localStorage.getItem(`kukora_${key}`) || JSON.stringify(def)); }
  catch { return def; }
}
function ls_set(key, val) {
  try { localStorage.setItem(`kukora_${key}`, JSON.stringify(val)); } catch {}
}

export function useServerSync(resource, defaultValue = []) {
  const [data, setData]               = useState(() => ls_get(resource, defaultValue));
  const [loading, setLoading]         = useState(true);
  const [serverAvailable, setSrvAvail] = useState(true);

  // Probe server availability
  useEffect(() => {
    const probe = async () => {
      try {
        const r = await fetch('/health');
        const j = await r.json();
        setSrvAvail(j.ok && j.db); // j.db = true if MongoDB connected
      } catch {
        setSrvAvail(false);
      }
    };
    probe();
  }, []);

  // Load from server (fallback to localStorage)
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        let serverData;
        if (resource === 'alerts') {
          serverData = await fetch('/api/alerts').then(r => r.json());
          if (serverData.ok) {
            const alerts = serverData.data || [];
            setData(alerts);
            ls_set(resource, alerts);
          }
        } else if (resource === 'watchlist') {
          serverData = await fetch('/api/watchlist').then(r => r.json());
          if (serverData.ok) {
            const coins = serverData.data?.coins || defaultValue;
            setData(coins);
            ls_set(resource, coins);
          }
        } else if (resource === 'portfolio') {
          serverData = await fetch('/api/portfolio').then(r => r.json());
          if (serverData.ok) {
            const items = serverData.data || [];
            setData(items);
            ls_set(resource, items);
          }
        }
        setSrvAvail(true);
      } catch {
        // Server unavailable — use localStorage data
        setSrvAvail(false);
        const cached = ls_get(resource, defaultValue);
        setData(cached);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [resource]);

  return { data, setData, loading, serverAvailable };
}

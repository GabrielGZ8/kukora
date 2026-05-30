// ─── useAlertMonitor.js ────────────────────────────────────────────────────
// Runs always (mounted in Layout) — checks alert conditions against live prices
// Decoupled from AlertsPage so it works regardless of which page is open

import { useEffect, useRef, useCallback } from 'react';
import toast from 'react-hot-toast';

const STORAGE_KEY = 'kukora_alerts_v1';
const PRICE_CACHE_KEY = 'kukora_alert_prices';
const CHECK_INTERVAL = 60_000; // 60s — avoid CoinGecko 429

function getAlerts() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}
function saveAlerts(alerts) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts)); } catch {}
}

export function useAlertMonitor() {
  const triggeredRef  = useRef(new Set());
  const intervalRef   = useRef(null);

  const checkAlerts = useCallback(async () => {
    const alerts = getAlerts().filter(a => !a.triggered);
    if (!alerts.length) return;

    try {
      const r = await fetch('/api/crypto/markets?limit=100');
      const j = await r.json();
      if (!j.ok) return;
      const coins = j.data?.coins || [];
      const priceMap = {};
      coins.forEach(c => { priceMap[c.id] = c.current_price; });

      let changed = false;
      const allAlerts = getAlerts();

      allAlerts.forEach(a => {
        if (a.triggered || triggeredRef.current.has(a.id)) return;
        const cur = priceMap[a.coinId];
        if (cur == null) return;
        const hit = a.type === 'above' ? cur >= a.price : cur <= a.price;
        if (!hit) return;

        triggeredRef.current.add(a.id);
        a.triggered = true;
        a.triggeredAt = Date.now();
        a.triggeredAt_price = cur;
        changed = true;

        const fmt = n => n >= 1 ? `$${n.toLocaleString('en', { maximumFractionDigits: 2 })}` : `$${n.toFixed(5)}`;
        toast.success(
          `🔔 ${a.symbol} ${a.type === 'above' ? '≥' : '≤'} ${fmt(a.price)} — Precio actual: ${fmt(cur)}`,
          { duration: 10000 }
        );

        // Try to update server if MongoDB available
        fetch(`/api/alerts/${a.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ triggered: true }),
        }).catch(() => {});
      });

      if (changed) saveAlerts(allAlerts);
    } catch {}
  }, []);

  useEffect(() => {
    checkAlerts();
    intervalRef.current = setInterval(checkAlerts, CHECK_INTERVAL);
    return () => clearInterval(intervalRef.current);
  }, [checkAlerts]);
}

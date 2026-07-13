// ─── useAlertMonitor.js ────────────────────────────────────────────────────
// Runs always (mounted in Layout) — checks alert conditions against live prices.
// Decoupled from AlertsPage so it works regardless of which page is open.

import { useEffect, useRef, useCallback } from 'react';
import toast from 'react-hot-toast';
import { api } from '../api';

const STORAGE_KEY     = 'kukora_alerts_v1';
const CHECK_INTERVAL  = 60_000; // 60s — respect CoinGecko rate limits

function getAlerts() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}
function saveAlerts(alerts) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts)); } catch { /* private browsing */ }
}

function fmtPrice(n) {
  return n >= 1
    ? `$${n.toLocaleString('en', { maximumFractionDigits: 2 })}`
    : `$${n.toFixed(5)}`;
}

export function useAlertMonitor() {
  const triggeredRef = useRef(new Set());
  const intervalRef  = useRef(null);

  const checkAlerts = useCallback(async () => {
    const alerts = getAlerts().filter(a => !a.triggered);
    if (!alerts.length) return;

    try {
      const marketData = await api.markets(100);
      const coins = marketData?.coins || [];
      const priceMap = {};
      coins.forEach(c => { priceMap[c.id] = c.current_price; });

      let changed = false;
      const allAlerts = getAlerts();

      allAlerts.forEach(a => {
        if (a.triggered || triggeredRef.current.has(a.id)) return;
        const cur = priceMap[a.coinId];
        if (cur == null) return;

        const condition = a.condition || a.type; // normalize field name
        const hit = condition === 'above' ? cur >= a.price : cur <= a.price;
        if (!hit) return;

        triggeredRef.current.add(a.id);
        a.triggered          = true;
        a.triggeredAt        = Date.now();
        a.triggeredAt_price  = cur;
        changed              = true;

        toast.success(
          `🔔 ${a.symbol} ${condition === 'above' ? '≥' : '≤'} ${fmtPrice(a.price)} — Current price: ${fmtPrice(cur)}`,
          { duration: 10_000 },
        );

        // Best-effort server update — uses authenticated api helper
        api.alerts.update(a.id, { triggered: true }).catch(() => {});
      });

      if (changed) saveAlerts(allAlerts);
    } catch { /* CoinGecko may be rate-limited or engine offline — skip this cycle */ }
  }, []);

  useEffect(() => {
    checkAlerts();
    intervalRef.current = setInterval(checkAlerts, CHECK_INTERVAL);
    return () => clearInterval(intervalRef.current);
  }, [checkAlerts]);
}

/**
 * useAlertsStream — SSE hook para alertas de trades en tiempo real.
 * C-2 fix: usa stream tickets efímeros en lugar de JWT en la URL.
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import { getAccessToken } from '../api';

async function fetchStreamTicket() {
  const token = getAccessToken ? getAccessToken() : null;
  if (!token) return null;
  try {
    const res = await fetch('/api/auth/stream-ticket', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.ticket || null;
  } catch {
    return null;
  }
}

export function useAlertsStream() {
  const [alerts, setAlerts]       = useState([]);
  const [connected, setConnected] = useState(false);
  const esRef     = useRef(null);
  const retries   = useRef(0);
  const activeRef = useRef(true);

  const connect = useCallback(async () => {
    if (!activeRef.current) return;
    if (esRef.current) { try { esRef.current.close(); } catch { /* best-effort */ } }

    const ticket = await fetchStreamTicket();
    if (!activeRef.current) return;

    if (!ticket) {
      const delay = Math.min(1000 * Math.pow(1.5, retries.current), 20000);
      retries.current++;
      setTimeout(connect, delay);
      return;
    }

    const es = new EventSource(
      `/api/arbitrage/alerts-stream?ticket=${encodeURIComponent(ticket)}`
    );
    esRef.current = es;

    es.onopen = () => { setConnected(true); retries.current = 0; };

    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;
      if (!activeRef.current) return;
      const delay = Math.min(1000 * Math.pow(1.5, retries.current), 20000);
      retries.current++;
      setTimeout(connect, delay);
    };

    es.onmessage = ev => {
      try {
        const data = JSON.parse(ev.data);
        setAlerts(prev => [data, ...prev].slice(0, 50));
      } catch { /* malformed frame — skip */ }
    };
  }, []);

  useEffect(() => {
    activeRef.current = true;
    connect();
    return () => {
      activeRef.current = false;
      if (esRef.current) { try { esRef.current.close(); } catch { /* best-effort */ } }
    };
  }, [connect]);

  return { alerts, connected };
}

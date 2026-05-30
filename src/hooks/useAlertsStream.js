import { useEffect, useState, useRef, useCallback } from 'react';

export function useAlertsStream() {
  const [alerts, setAlerts]     = useState([]);
  const [connected, setConnected] = useState(false);
  const esRef    = useRef(null);
  const retries  = useRef(0);
  const activeRef = useRef(true);

  const connect = useCallback(() => {
    if (!activeRef.current) return;
    if (esRef.current) { try { esRef.current.close(); } catch {} }

    const es = new EventSource('/api/arbitrage/alerts-stream');
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
      } catch {}
    };
  }, []);

  useEffect(() => {
    activeRef.current = true;
    connect();
    return () => {
      activeRef.current = false;
      if (esRef.current) { try { esRef.current.close(); } catch {} }
    };
  }, [connect]);

  return { alerts, connected };
}
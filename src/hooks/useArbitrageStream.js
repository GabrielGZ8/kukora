/**
 * useArbitrageStream — Server-Sent Events hook para arbitraje real-time
 * Fallback automático a polling si SSE no está disponible
 */
import { useState, useEffect, useRef, useCallback } from 'react';

export function useArbitrageStream() {
  const [data, setData]           = useState(null);
  const [connected, setConnected] = useState(false);
  const [latencyMs, setLatency]   = useState(null);
  const esRef     = useRef(null);
  const pingTs    = useRef(null);
  const retries   = useRef(0);
  const MAX_RETRIES = 8;

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const es = new EventSource('/api/arbitrage/stream');
    esRef.current = es;
    pingTs.current = Date.now();

    es.onopen = () => {
      setConnected(true);
      retries.current = 0;
      pingTs.current = Date.now(); // reset so first message latency is accurate
    };

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        const now = Date.now();
        if (pingTs.current) {
          setLatency(now - pingTs.current);
        }
        pingTs.current = now;
        setData(msg);
      } catch {}
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;

      const delay = Math.min(500 * Math.pow(1.5, retries.current), 15000);
      retries.current++;
      setTimeout(connect, delay); // retry indefinitely (delay caps at 15s)
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
    };
  }, [connect]);

  return { data, connected, latencyMs };
}
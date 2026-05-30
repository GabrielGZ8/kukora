/**
 * useArbitrageStream — Server-Sent Events hook para arbitraje real-time
 *
 * FIXES v2:
 *  - Silence detection extended to 20s (SSE loop is 150ms but server may be slow to start)
 *  - No double-close: check esRef before closing in cleanup
 *  - Reconnect delay capped at 20s (not 30s) for better UX
 *  - detectionMode state exposed
 *  - startTs tracked for latency measurement relative to message flow
 */
import { useState, useEffect, useRef, useCallback } from 'react';

export function useArbitrageStream() {
  const [data, setData]           = useState(null);
  const [connected, setConnected] = useState(false);
  const [latencyMs, setLatency]   = useState(null);
  const [detectionMode, setDetectionMode] = useState(null);

  const esRef           = useRef(null);
  const lastMsgTs       = useRef(null);
  const retries         = useRef(0);
  const silenceTimer    = useRef(null);
  const reconnectTimer  = useRef(null);
  const mountedRef      = useRef(true);

  const clearTimers = () => {
    clearTimeout(silenceTimer.current);
    clearTimeout(reconnectTimer.current);
  };

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    // Close any existing connection cleanly
    if (esRef.current) {
      esRef.current.onopen = null;
      esRef.current.onmessage = null;
      esRef.current.onerror = null;
      try { esRef.current.close(); } catch {}
      esRef.current = null;
    }
    clearTimers();

    let es;
    try {
      es = new EventSource('/api/arbitrage/stream');
    } catch {
      scheduleReconnect();
      return;
    }
    esRef.current = es;

    es.onopen = () => {
      if (!mountedRef.current) return;
      setConnected(true);
      retries.current = 0;
      lastMsgTs.current = Date.now();
      resetSilenceTimer();
    };

    es.onmessage = (e) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(e.data);
        const now = Date.now();

        if (lastMsgTs.current) {
          setLatency(now - lastMsgTs.current);
        }
        lastMsgTs.current = now;
        setData(msg);
        if (msg.detectionMode) setDetectionMode(msg.detectionMode);

        // Reset silence timer
        resetSilenceTimer();
      } catch {}
    };

    es.onerror = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      if (esRef.current) {
        try { esRef.current.close(); } catch {}
        esRef.current = null;
      }
      clearTimers();
      scheduleReconnect();
    };

    function resetSilenceTimer() {
      clearTimeout(silenceTimer.current);
      // 20s silence = something is wrong, reconnect
      silenceTimer.current = setTimeout(() => {
        if (!mountedRef.current) return;
        if (esRef.current) {
          try { esRef.current.close(); } catch {}
          esRef.current = null;
        }
        setConnected(false);
        connect();
      }, 20000);
    }

    function scheduleReconnect() {
      // Exponential backoff capped at 20s
      const delay = retries.current < 8
        ? Math.min(500 * Math.pow(1.5, retries.current), 20000)
        : 20000;
      retries.current++;
      reconnectTimer.current = setTimeout(connect, delay);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      clearTimers();
      if (esRef.current) {
        esRef.current.onopen = null;
        esRef.current.onmessage = null;
        esRef.current.onerror = null;
        try { esRef.current.close(); } catch {}
        esRef.current = null;
      }
    };
  }, [connect]);

  return { data, connected, latencyMs, detectionMode };
}

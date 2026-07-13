/**
 * useArbitrageStream — Server-Sent Events hook para arbitraje real-time
 *
 * C-2 fix: SSE auth via one-time stream tickets (no JWT en URL).
 * Antes de abrir EventSource, el hook pide POST /api/auth/stream-ticket
 * con el access token en el header Authorization. El servidor devuelve
 * un ticket efímero (30s TTL) que se usa como ?ticket= en la URL del SSE.
 * El ticket se invalida en el primer uso — nunca queda un JWT real en logs.
 *
 * m-2 fix: Re-autenticación automática. Cada reconexión genera un ticket
 * nuevo, por lo que tokens expirados / revocados cierran la stream limpiamente.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
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

export function useArbitrageStream() {
  const [data, setData]                   = useState(null);
  const [connected, setConnected]         = useState(false);
  const [latencyMs, setLatency]           = useState(null);
  const [detectionMode, setDetectionMode] = useState(null);

  const esRef          = useRef(null);
  const lastMsgTs      = useRef(null);
  const retries        = useRef(0);
  const silenceTimer   = useRef(null);
  const reconnectTimer = useRef(null);
  const mountedRef     = useRef(true);

  const clearTimers = () => {
    clearTimeout(silenceTimer.current);
    clearTimeout(reconnectTimer.current);
  };

  const connect = useCallback(async () => {
    if (!mountedRef.current) return;

    // Close any existing connection cleanly
    if (esRef.current) {
      esRef.current.onopen    = null;
      esRef.current.onmessage = null;
      esRef.current.onerror   = null;
      try { esRef.current.close(); } catch { /* best-effort */ }
      esRef.current = null;
    }
    clearTimers();

    // C-2 fix: obtain a fresh one-time ticket before opening EventSource.
    // Each reconnect gets its own ticket, so expired tokens fail here
    // (clean 401 path) rather than silently reusing a stale JWT in the URL.
    const ticket = await fetchStreamTicket();
    if (!mountedRef.current) return;

    if (!ticket) {
      // No valid session — back off and retry (e.g. token refresh in progress)
      scheduleReconnect();
      return;
    }

    let es;
    try {
      es = new EventSource(`/api/arbitrage/stream?ticket=${encodeURIComponent(ticket)}`);
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
        if (lastMsgTs.current) setLatency(now - lastMsgTs.current);
        lastMsgTs.current = now;
        // M-3: el backend ahora omite orderBooks/opportunities/wallets/pnl
        // del payload cuando no cambiaron desde el tick anterior (marcado
        // con `_delta: true`), para no repetir ~150ms tras ~150ms bytes
        // idénticos a cada cliente conectado. Por eso acá se mergea sobre
        // el estado previo en vez de reemplazarlo — un campo ausente en
        // este mensaje significa "sigue igual", no "se vació". Esto es
        // retrocompatible: si algún día el backend vuelve a mandar el
        // payload completo siempre, el merge se comporta exactamente igual
        // que un reemplazo.
        setData(prev => ({ ...(prev || {}), ...msg }));
        if (msg.detectionMode) setDetectionMode(msg.detectionMode);
        resetSilenceTimer();
      } catch { /* malformed SSE frame — skip */ }
    };

    es.onerror = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      if (esRef.current) {
        try { esRef.current.close(); } catch { /* best-effort */ }
        esRef.current = null;
      }
      clearTimers();
      scheduleReconnect();
    };

    function resetSilenceTimer() {
      clearTimeout(silenceTimer.current);
      silenceTimer.current = setTimeout(() => {
        if (!mountedRef.current) return;
        if (esRef.current) {
          try { esRef.current.close(); } catch { /* best-effort */ }
          esRef.current = null;
        }
        setConnected(false);
        connect();
      }, 20000);
    }

    function scheduleReconnect() {
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
        esRef.current.onopen    = null;
        esRef.current.onmessage = null;
        esRef.current.onerror   = null;
        try { esRef.current.close(); } catch { /* best-effort */ }
        esRef.current = null;
      }
    };
  }, [connect]);

  return { data, connected, latencyMs, detectionMode };
}

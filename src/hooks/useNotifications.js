// ─── useNotifications.js — bell icon notification state ──────────────────
// Connects to the system notification SSE stream (engine events: circuit
// breaker, drawdown, exchange degraded, daily loss, etc. — distinct from
// the price-alert system in useAlertMonitor.js) and keeps an unread count
// + recent list in sync in real time. Falls back to the REST history
// endpoint on mount and on reconnect so the dropdown is never empty just
// because the SSE connection hasn't received a push yet.
//
// Security: uses the same one-time stream-ticket exchange as
// useArbitrageStream / useAlertsStream (see server/auth.js — C-2 fix).
// The long-lived access token is sent once, over a header, to mint a
// 30s single-use ticket; only that ticket ever appears in the EventSource
// URL. This replaces the previous design where the raw access token was
// placed directly in the URL — query strings end up in proxy/server logs,
// browser history, and Referer headers, none of which should ever see a
// live bearer token.

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../state/AuthContext';
import { api } from '../api';

const MAX_VISIBLE = 10;
const RECONNECT_DELAY_MS = 4000;

async function fetchStreamTicket(accessToken) {
  if (!accessToken) return null;
  try {
    const res = await fetch('/api/auth/stream-ticket', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.ticket || null;
  } catch {
    return null;
  }
}

export function useNotifications() {
  const { accessToken, isAuthenticated } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [unread, setUnread]               = useState(0);
  const esRef         = useRef(null);
  const reconnectRef  = useRef(null);
  const activeRef     = useRef(true);

  const loadHistory = useCallback(async () => {
    try {
      const data = await api.notifications.list(MAX_VISIBLE);
      setNotifications(data.notifications || []);
      setUnread(data.unread || 0);
    } catch { /* non-critical — bell just stays at its last known state */ }
  }, []);

  useEffect(() => {
    activeRef.current = true;

    if (!isAuthenticated || !accessToken) {
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      return;
    }

    loadHistory();

    async function connect() {
      if (!activeRef.current) return;

      // Mint a fresh one-time ticket before opening EventSource. A new
      // ticket on every reconnect means an expired/revoked access token
      // fails cleanly here (401 on the POST) instead of a stale token
      // silently sitting in a stream URL.
      const ticket = await fetchStreamTicket(accessToken);
      if (!activeRef.current) return;

      if (!ticket) {
        reconnectRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
        return;
      }

      const es = new EventSource(api.notifications.streamUrl(ticket));
      esRef.current = es;

      es.onmessage = (evt) => {
        let data;
        try { data = JSON.parse(evt.data); } catch { return; }

        if (data.type === 'init') {
          setUnread(data.unread || 0);
          return;
        }
        if (data.type === 'notification') {
          setNotifications(prev => [
            { id: data.id, event: data.event, title: data.title, severity: data.severity, read: false, createdAt: data.createdAt },
            ...prev,
          ].slice(0, MAX_VISIBLE));
          setUnread(prev => prev + 1);
        }
      };

      es.onerror = () => {
        es.close();
        esRef.current = null;
        if (!activeRef.current) return;
        reconnectRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      };
    }

    connect();

    return () => {
      activeRef.current = false;
      if (esRef.current) esRef.current.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, [isAuthenticated, accessToken, loadHistory]);

  const markRead = useCallback(async (id) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    setUnread(prev => Math.max(0, prev - 1));
    try { await api.notifications.markRead(id); } catch { /* optimistic update stands either way */ }
  }, []);

  const markAllRead = useCallback(async () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    setUnread(0);
    try { await api.notifications.markAllRead(); } catch { /* optimistic update stands either way */ }
  }, []);

  return { notifications, unread, markRead, markAllRead, refresh: loadHistory };
}

// ─── NotificationBell.jsx — topbar bell icon + dropdown ───────────────────
// System notifications (engine events: circuit breaker, drawdown, exchange
// degraded, daily loss). Distinct from the price-alert system in
// useAlertMonitor.js, which surfaces via toast rather than this dropdown.

import { useState, useRef, useEffect } from 'react';
import { useNotifications } from '../../hooks/useNotifications';

const SEVERITY_COLOR = {
  info:     'var(--text-dim)',
  warn:     '#F59E0B',
  critical: '#EF4444',
};

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export default function NotificationBell() {
  const { notifications, unread, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, right: 0 });
  const ref = useRef(null);
  const btnRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  // The header this bell lives in has `overflow: hidden` (needed to clip the
  // birds animation), which was silently clipping this dropdown too — the
  // click worked and `open` toggled fine, but the panel rendered invisible.
  // Using `position: fixed`, anchored to the button's own bounding rect,
  // takes the dropdown out of the header's clipped stacking context entirely.
  function handleToggle() {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setCoords({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
    }
    setOpen(o => !o);
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        onClick={handleToggle}
        title="Notificaciones"
        style={{
          position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, borderRadius: 8,
          background: open ? 'var(--bg-surface-2)' : 'none',
          border: '1px solid var(--border)',
          color: unread > 0 ? 'var(--color-primary, #FF2D78)' : 'var(--text-muted)',
          cursor: 'pointer', transition: 'all 0.13s',
        }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary, #FF2D78)'; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: -4, right: -4,
            minWidth: 15, height: 15, borderRadius: 8, padding: '0 3px',
            background: 'var(--color-primary, #FF2D78)', color: '#fff',
            fontSize: 9, fontWeight: 800, lineHeight: '15px', textAlign: 'center',
            border: '1.5px solid var(--bg-surface)',
          }}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'fixed', top: coords.top, right: coords.right, zIndex: 2000,
          width: 320, maxHeight: 400, overflowY: 'auto',
          background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12,
          boxShadow: '0 16px 40px rgba(0,0,0,0.35)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 14px', borderBottom: '1px solid var(--border)',
          }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Notificaciones
            </span>
            {unread > 0 && (
              <button
                onClick={markAllRead}
                style={{ background: 'none', border: 'none', color: 'var(--color-primary, #FF2D78)', fontSize: 11, fontWeight: 700, cursor: 'pointer', padding: 0 }}
              >
                Marcar todas leídas
              </button>
            )}
          </div>

          {notifications.length === 0 ? (
            <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
              Aún no hay notificaciones.
            </div>
          ) : (
            <div>
              {notifications.map(n => (
                <button
                  key={n.id}
                  onClick={() => !n.read && markRead(n.id)}
                  style={{
                    display: 'flex', gap: 10, width: '100%', textAlign: 'left',
                    padding: '11px 14px', border: 'none', borderBottom: '1px solid var(--border)',
                    background: n.read ? 'transparent' : 'var(--bg-surface-2)',
                    cursor: n.read ? 'default' : 'pointer',
                  }}
                >
                  <span style={{
                    width: 7, height: 7, borderRadius: 99, flexShrink: 0, marginTop: 5,
                    background: SEVERITY_COLOR[n.severity] || SEVERITY_COLOR.info,
                  }} />
                  <span style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: n.read ? 500 : 700, color: 'var(--text)', lineHeight: 1.4 }}>
                      {n.title}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
                      hace {timeAgo(n.createdAt)}
                    </div>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

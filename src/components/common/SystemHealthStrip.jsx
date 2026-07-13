import { useAppState } from '../../state/AppStateContext';

/**
 * SystemHealthStrip — compact, real-data system status row.
 *
 * Same pattern as the live health panel on AboutPage, generalized into a
 * shared component so any page showing system-level metrics (Summary,
 * Executive Dashboard, ...) reads from the same real source — the
 * AppStateContext poll loop, backed by /health and /api/metrics — rather
 * than each page inventing its own fetch or, worse, hardcoding numbers.
 */
export default function SystemHealthStrip({ compact = false }) {
  const { engineStatus, dbStatus, sessionMetrics, loading, error } = useAppState();

  const online = engineStatus?.running !== false && !error;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: compact ? 14 : 20, flexWrap: 'wrap',
      padding: compact ? '8px 12px' : '12px 16px',
      background: 'var(--bg-surface-2)', border: '1px solid var(--border)',
      borderRadius: 10, fontSize: compact ? 11 : 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%',
          background: loading ? 'var(--text-dim)' : online ? 'var(--color-green)' : 'var(--color-red)',
          boxShadow: online ? '0 0 6px var(--color-green)' : 'none',
        }} />
        <span style={{ fontWeight: 700, color: 'var(--text)' }}>
          {loading ? 'Checking…' : online ? 'Engine Online' : 'Engine Degraded'}
        </span>
      </div>

      <Stat label="DB" value={dbStatus?.connected ? 'Connected' : 'In-memory'} />
      <Stat label="Opportunities" value={engineStatus?.opportunitiesDetected ?? '—'} />
      <Stat label="Trades" value={engineStatus?.tradesExecuted ?? '—'} />
      <Stat label="Requests" value={sessionMetrics?.requests_total ?? '—'} />
      <Stat label="Errors" value={sessionMetrics?.errors_total ?? '—'} />
      <Stat label="Uptime" value={sessionMetrics ? `${Math.floor(sessionMetrics.uptime_seconds / 60)}m` : '—'} />
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{ color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', fontSize: 9.5, letterSpacing: '0.04em' }}>
        {label}
      </span>
      <span style={{ color: 'var(--text)', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
        {value}
      </span>
    </div>
  );
}

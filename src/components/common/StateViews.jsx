// ─── StateViews.jsx — Loading skeletons, Error state, Empty state ─────────

// ── Shimmer skeleton ───────────────────────────────────────────────────────
export function SkeletonLine({ width = '100%', height = 14, style = {} }) {
  return (
    <div className="skeleton" style={{ width, height, borderRadius: 6, marginBottom: 8, ...style }} />
  );
}

export function SkeletonCard({ rows = 3, style = {} }) {
  return (
    <div className="card" style={style}>
      <SkeletonLine width="40%" height={12} />
      <SkeletonLine width="70%" height={24} style={{ margin: '12px 0 8px' }} />
      {Array.from({ length: rows - 1 }, (_, i) => (
        <SkeletonLine key={i} width={`${60 + i * 10}%`} height={12} />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 5 }) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '10px 16px', background: 'var(--bg-surface-2)', borderBottom: '1px solid var(--border)', display: 'flex', gap: 16 }}>
        {[30, 60, 20, 20, 20].map((w, i) => (
          <SkeletonLine key={i} width={`${w}%`} height={10} style={{ marginBottom: 0, flexShrink: i === 0 ? 0 : 1 }} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ padding: '13px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 16, alignItems: 'center' }}>
          <div style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0 }} className="skeleton" />
          {[40, 15, 15, 20, 15].map((w, i) => (
            <SkeletonLine key={i} width={`${w}%`} height={11} style={{ marginBottom: 0 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonMetrics({ count = 4 }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${count}, 1fr)`, gap: 14, marginBottom: 24 }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card" style={{ padding: '18px 20px' }}>
          <SkeletonLine width="60%" height={10} style={{ marginBottom: 14 }} />
          <SkeletonLine width="80%" height={26} style={{ marginBottom: 6 }} />
          <SkeletonLine width="50%" height={10} />
        </div>
      ))}
    </div>
  );
}

// ── Error state ────────────────────────────────────────────────────────────
export function ErrorState({ error, onRetry, style = {} }) {
  const isRateLimit = error?.includes('Rate limit') || error?.includes('429');
  const isNetwork   = error?.includes('CoinGecko no disponible') || error?.includes('502');

  return (
    <div style={{
      textAlign: 'center', padding: '56px 20px',
      background: 'var(--color-red-dim)', borderRadius: 'var(--radius-lg)',
      border: '1px solid rgba(240,62,62,0.15)', ...style,
    }}>
      <div style={{ fontSize: 36, marginBottom: 14, opacity: 0.4 }}>
        {isRateLimit
          ? <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{opacity:0.5}}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          : isNetwork
          ? <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{opacity:0.5}}><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20" strokeWidth="3"/></svg>
          : <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{opacity:0.5}}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        }
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
        {isRateLimit ? 'Rate limit alcanzado'
          : isNetwork ? 'Sin conexión con CoinGecko'
          : 'Error al cargar datos'}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 320, margin: '0 auto 18px', lineHeight: 1.55 }}>
        {error || 'Ocurrió un error inesperado.'}
      </div>
      {onRetry && (
        <button className="btn btn-secondary btn-sm" onClick={onRetry}>
          ↺ Reintentar
        </button>
      )}
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────
export function EmptyState({ icon = '◈', title, description, action, onAction, style = {} }) {
  return (
    <div style={{ textAlign: 'center', padding: '64px 20px', color: 'var(--text-muted)', ...style }}>
      <div style={{ fontSize: 44, marginBottom: 14, opacity: 0.2 }}>{icon}</div>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 7, color: 'var(--text)' }}>{title}</div>
      {description && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 300, margin: '0 auto 20px', lineHeight: 1.55 }}>
          {description}
        </div>
      )}
      {action && onAction && (
        <button className="btn btn-primary btn-sm" onClick={onAction}>{action}</button>
      )}
    </div>
  );
}

// ── Server sync badge ──────────────────────────────────────────────────────
export function SyncBadge({ serverAvailable }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: 10, fontWeight: 600,
      color: serverAvailable ? 'var(--color-green)' : 'var(--color-yellow)',
      background: serverAvailable ? 'var(--color-green-dim)' : 'var(--color-yellow-dim)',
      padding: '2px 8px', borderRadius: 99,
      border: `1px solid ${serverAvailable ? 'rgba(0,184,122,0.2)' : 'rgba(245,158,11,0.2)'}`,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: serverAvailable ? 'var(--color-green)' : 'var(--color-yellow)', display: 'inline-block', flexShrink: 0 }} />
      {serverAvailable ? 'MongoDB' : 'Local'}
    </div>
  );
}

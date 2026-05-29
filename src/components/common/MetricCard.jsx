export function MetricCard({ label, value, sub, icon, trend, accent = 'primary', loading }) {
  const colors = {
    primary: 'var(--color-primary)',
    green:   'var(--color-green)',
    red:     'var(--color-red)',
    yellow:  'var(--color-yellow)',
    blue:    'var(--color-blue)',
    purple:  'var(--color-purple)',
  };
  const color = colors[accent] || colors.primary;
  const up = typeof trend === 'number' ? trend >= 0 : null;

  return (
    <div className="card" style={{ position: 'relative', overflow: 'hidden', padding: '18px 20px' }}>
      {/* Top accent bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 3,
        background: accent === 'primary' ? 'var(--brand-gradient)' : color,
        borderRadius: '14px 14px 0 0',
      }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: 2 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 9,
          background: accent === 'primary' ? 'var(--color-primary-dim)' : `${color}15`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16,
        }}>
          {icon}
        </div>
        {up !== null && (
          <span style={{
            fontSize: 11, fontWeight: 700,
            color: up ? 'var(--color-green)' : 'var(--color-red)',
            background: up ? 'var(--color-green-dim)' : 'var(--color-red-dim)',
            padding: '2px 7px', borderRadius: 99,
          }}>
            {up ? '▲' : '▼'} {Math.abs(trend).toFixed(2)}%
          </span>
        )}
      </div>

      {loading
        ? <div style={{ height: 44, display: 'flex', alignItems: 'center', marginTop: 14 }}><div className="spinner" /></div>
        : <>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 14, letterSpacing: '-0.5px', color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{value}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, fontWeight: 500 }}>{label}</div>
            {sub && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{sub}</div>}
          </>
      }
    </div>
  );
}

export function MetricGrid({ children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 24 }}>
      {children}
    </div>
  );
}

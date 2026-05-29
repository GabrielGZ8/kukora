// MetricWidgets.jsx — TrendCard, VolatilityCard, MomentumCard
// Props comunes: value, label?, size? ('sm'|'md')

export function TrendCard({ trend, strength, slope, label }) {
  const cfg = {
    bullish:  { color: 'var(--color-green)',  bg: 'var(--color-green-dim)',  icon: '▲' },
    bearish:  { color: 'var(--color-red)',    bg: 'var(--color-red-dim)',    icon: '▼' },
    sideways: { color: 'var(--color-yellow)', bg: 'var(--color-yellow-dim)', icon: '→' },
  }[trend] || { color: 'var(--color-yellow)', bg: 'var(--color-yellow-dim)', icon: '→' };

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Tendencia</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 40, height: 40, borderRadius: 'var(--radius)', background: cfg.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, color: cfg.color }}>
          {cfg.icon}
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: cfg.color }}>{label || trend}</div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            Fuerza: {strength > 0 ? '+' : ''}{strength}% · Slope: {slope > 0 ? '+' : ''}{slope}%
          </div>
        </div>
      </div>
    </div>
  );
}

export function VolatilityCard({ value, label }) {
  const norm = Math.min(100, (value || 0) * 10);
  const color = norm > 66 ? 'var(--color-red)' : norm > 33 ? 'var(--color-yellow)' : 'var(--color-green)';
  const text  = norm > 66 ? 'Alta' : norm > 33 ? 'Moderada' : 'Baja';

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Volatilidad</div>
        <span style={{ fontSize: 10, fontWeight: 700, color, background: `${color}22`, padding: '2px 8px', borderRadius: 99 }}>{text}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 900, color }}>{value != null ? `${value.toFixed(2)}%` : '—'}</div>
      {label && <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{label}</div>}
      <div style={{ background: 'var(--bg-surface-3)', borderRadius: 99, height: 6, overflow: 'hidden' }}>
        <div style={{ width: `${norm}%`, background: color, height: '100%', borderRadius: 99, transition: 'width 0.5s ease' }} />
      </div>
    </div>
  );
}

export function MomentumCard({ value, label }) {
  const color = value > 5 ? 'var(--color-green)' : value < -5 ? 'var(--color-red)' : 'var(--color-yellow)';
  const icon  = value > 0 ? '▲' : value < 0 ? '▼' : '→';

  return (
    <div className="card">
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Momentum</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 26, fontWeight: 900, color }}>{value != null ? `${value > 0 ? '+' : ''}${value.toFixed(2)}%` : '—'}</span>
        <span style={{ fontSize: 18, color }}>{icon}</span>
      </div>
      {label && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>{label}</div>}
    </div>
  );
}

export function PerformanceCard({ totalReturn, sharpe, drawdown, period }) {
  const retColor = totalReturn >= 0 ? 'var(--color-green)' : 'var(--color-red)';
  return (
    <div className="card">
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>Performance {period && `· ${period}`}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[
          { label: 'Retorno total',    value: totalReturn != null ? `${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%` : '—', color: retColor },
          { label: 'Max Drawdown',     value: drawdown != null ? `${drawdown.toFixed(2)}%` : '—', color: 'var(--color-red)' },
          { label: 'Sharpe Ratio',     value: sharpe ?? '—', color: sharpe > 1 ? 'var(--color-green)' : 'var(--text-muted)' },
        ].map(r => (
          <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.label}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: r.color }}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

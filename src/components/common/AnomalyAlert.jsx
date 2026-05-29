// AnomalyAlert.jsx — widget reutilizable
// Props: anomaly: { level, reason, severityScore, details[] }
//        name?: string, compact?: bool

const LEVEL = {
  high:   { color: 'var(--color-red)',    bg: 'var(--color-red-dim)',    icon: '⚠', label: 'ALTO' },
  medium: { color: 'var(--color-yellow)', bg: 'var(--color-yellow-dim)', icon: '◉', label: 'MEDIO' },
  low:    { color: 'var(--color-green)',  bg: 'var(--color-green-dim)',  icon: '◎', label: 'NORMAL' },
};

export default function AnomalyAlert({ anomaly, name, compact = false }) {
  if (!anomaly) return null;
  const cfg = LEVEL[anomaly.level] || LEVEL.low;

  if (compact) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderRadius: 'var(--radius)', background: cfg.bg, border: `1px solid ${cfg.color}22` }}>
      <span style={{ fontSize: 14 }}>{cfg.icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {name && <span style={{ fontWeight: 700, fontSize: 12, marginRight: 6 }}>{name}</span>}
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{anomaly.reason}</span>
      </div>
      <span style={{ fontSize: 10, fontWeight: 800, color: cfg.color, letterSpacing: '0.06em' }}>{cfg.label}</span>
    </div>
  );

  return (
    <div style={{ padding: 16, borderRadius: 'var(--radius-lg)', background: cfg.bg, border: `1px solid ${cfg.color}33` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: anomaly.details?.length ? 12 : 0 }}>
        <span style={{ fontSize: 20 }}>{cfg.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {name && <span style={{ fontWeight: 800, fontSize: 13 }}>{name}</span>}
            <span style={{ fontSize: 10, fontWeight: 800, color: cfg.color, background: `${cfg.color}22`, padding: '2px 7px', borderRadius: 99 }}>{cfg.label}</span>
            <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 'auto' }}>Score: {anomaly.severityScore}</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{anomaly.reason}</div>
        </div>
      </div>
      {anomaly.details?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {anomaly.details.map((d, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '5px 8px', background: 'rgba(255,255,255,0.05)', borderRadius: 'var(--radius-sm)' }}>
              <span style={{ color: 'var(--text-muted)' }}>{d.label}</span>
              <span style={{ fontWeight: 700, color: cfg.color }}>{d.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

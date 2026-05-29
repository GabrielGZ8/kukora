// ScoreCard.jsx — muestra score de un asset, reutilizable
// Props: item: { id, name, score, label, labelColor, breakdown }
//        rank?: number, onClick?: fn

const COLOR_MAP = {
  green:  'var(--color-green)',
  blue:   'var(--color-blue)',
  yellow: 'var(--color-yellow)',
  red:    'var(--color-red)',
};
const BG_MAP = {
  green:  'var(--color-green-dim)',
  blue:   'var(--color-blue-dim)',
  yellow: 'var(--color-yellow-dim)',
  red:    'var(--color-red-dim)',
};

function MiniBar({ value, color }) {
  return (
    <div style={{ background: 'var(--bg-surface-3)', borderRadius: 99, height: 4, overflow: 'hidden', flex: 1 }}>
      <div style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color, height: '100%', borderRadius: 99, transition: 'width 0.5s ease' }} />
    </div>
  );
}

export default function ScoreCard({ item, rank, onClick }) {
  const color = COLOR_MAP[item.labelColor] || 'var(--color-blue)';
  const bg    = BG_MAP[item.labelColor]   || 'var(--color-blue-dim)';

  return (
    <div onClick={onClick} style={{
      padding: '14px 16px', borderRadius: 'var(--radius-lg)',
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-card)', cursor: onClick ? 'pointer' : 'default',
      transition: 'all var(--transition)',
    }}
    onMouseEnter={e => onClick && (e.currentTarget.style.borderColor = color)}
    onMouseLeave={e => onClick && (e.currentTarget.style.borderColor = 'var(--border)')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        {rank != null && (
          <div style={{ width: 24, height: 24, borderRadius: '50%', background: rank <= 3 ? 'var(--brand-gradient)' : 'var(--bg-surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: rank <= 3 ? '#fff' : 'var(--text-muted)', flexShrink: 0 }}>
            {rank}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{item.id}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 22, fontWeight: 900, color, lineHeight: 1 }}>{item.score}</div>
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', marginTop: 1 }}>/ 100</div>
        </div>
      </div>

      <div style={{ background: bg, borderRadius: 99, padding: '3px 10px', display: 'inline-flex', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color }}>{item.label}</span>
      </div>

      {item.breakdown && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {Object.entries(item.breakdown).map(([key, val]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 10, color: 'var(--text-dim)', width: 72, textTransform: 'capitalize' }}>{key}</span>
              <MiniBar value={val} color={color} />
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', width: 28, textAlign: 'right' }}>{val}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

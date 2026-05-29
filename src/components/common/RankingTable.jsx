// RankingTable.jsx — tabla de ranking reutilizable
// Props: items: [{ id, name, symbol?, image?, score, label, labelColor, change24h?, price? }]
//        title?, onSelect?

const COLOR_MAP = { green: 'var(--color-green)', blue: 'var(--color-blue)', yellow: 'var(--color-yellow)', red: 'var(--color-red)' };
const BG_MAP    = { green: 'var(--color-green-dim)', blue: 'var(--color-blue-dim)', yellow: 'var(--color-yellow-dim)', red: 'var(--color-red-dim)' };

export default function RankingTable({ items = [], title = 'Ranking', onSelect }) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 700 }}>{title}</div>
      {items.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 }}>Sin datos</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--bg-surface-2)' }}>
              {['#', 'Asset', 'Score', 'Label', 'Momentum', 'Volatilidad', 'Performance'].map(h => (
                <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid var(--border)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => {
              const color = COLOR_MAP[item.labelColor] || 'var(--color-blue)';
              const bg    = BG_MAP[item.labelColor]   || 'var(--color-blue-dim)';
              return (
                <tr key={item.id} onClick={() => onSelect?.(item)}
                  style={{ borderBottom: '1px solid var(--border)', cursor: onSelect ? 'pointer' : 'default', transition: 'background var(--transition)' }}
                  onMouseEnter={e => onSelect && (e.currentTarget.style.background = 'var(--bg-surface-2)')}
                  onMouseLeave={e => onSelect && (e.currentTarget.style.background = '')}>
                  <td style={{ padding: '11px 14px', fontWeight: 800, color: i < 3 ? 'var(--color-primary)' : 'var(--text-dim)', fontSize: 12 }}>{i + 1}</td>
                  <td style={{ padding: '11px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {item.image && <img src={item.image} alt="" style={{ width: 22, height: 22, borderRadius: '50%' }} />}
                      <div>
                        <div style={{ fontWeight: 700 }}>{item.name}</div>
                        {item.id && <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{item.id}</div>}
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '11px 14px' }}>
                    <span style={{ fontSize: 16, fontWeight: 900, color }}>{item.score}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>/100</span>
                  </td>
                  <td style={{ padding: '11px 14px' }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color, background: bg, padding: '3px 8px', borderRadius: 99 }}>{item.label}</span>
                  </td>
                  {['momentum', 'volatility', 'performance'].map(key => (
                    <td key={key} style={{ padding: '11px 14px', fontWeight: 600, fontSize: 12, color: 'var(--text-muted)' }}>
                      {item.breakdown?.[key] ?? '—'}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

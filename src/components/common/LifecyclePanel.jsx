/**
 * LifecyclePanel.jsx — Kukora Hackathon
 *
 * Displays:
 *   - Active opportunity lifecycles (firstSeen, duration, seenCount)
 *   - Expired opportunity history with spread/profit/lifetime
 *   - Summary stats
 */

const fmt4 = n => (n == null || isNaN(n)) ? '—' : Number(n).toFixed(4);
const fmtMs = ms => {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
};
const ago = ts => {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 2) return 'ahora'; if (s < 60) return `${s}s`; return `${Math.floor(s / 60)}m`;
};

const EX_COLORS = { Binance: '#F0B90B', Kraken: '#5741D9', Bybit: '#F7A600', Coinbase: '#0052FF', OKX: '#aaa' };

function StatusDot({ status }) {
  const color = status === 'active' ? 'var(--color-green)' : status === 'expired' ? 'var(--text-dim)' : 'var(--color-yellow)';
  return (
    <span style={{
      width: 7, height: 7, borderRadius: '50%', background: color,
      display: 'inline-block', flexShrink: 0,
      animation: status === 'active' ? 'pulseDot 1.5s ease-in-out infinite' : 'none',
    }} />
  );
}

function PairLabel({ buyEx, sellEx }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 700 }}>
      <span style={{ color: EX_COLORS[buyEx] || '#aaa' }}>{buyEx}</span>
      <span style={{ color: 'var(--text-dim)' }}>→</span>
      <span style={{ color: EX_COLORS[sellEx] || '#aaa' }}>{sellEx}</span>
    </span>
  );
}

export default function LifecyclePanel({ data }) {
  const active  = data?.activeLifecycles  || [];
  const history = data?.lifecycleHistory  || [];
  const summary = data?.lifecycleSummary  || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Summary Row */}
      {summary.count > 0 && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10,
        }}>
          {[
            { label: 'Total Expiradas',     value: summary.count.toLocaleString(),         color: 'var(--text)' },
            { label: 'Dur. Promedio',        value: fmtMs(summary.avgDurationMs),          color: 'var(--color-green)' },
            { label: 'Apariciones Prom.',    value: summary.avgSeenCount?.toString(),      color: 'var(--color-green)' },
            { label: 'Spread Prom.',         value: `${summary.avgMaxSpread}%`,            color: 'var(--color-yellow)' },
            { label: 'Profit Prom.',         value: `$${fmt4(summary.avgMaxProfit)}`,      color: summary.avgMaxProfit >= 0 ? 'var(--color-green)' : 'var(--color-red)' },
            { label: 'Más Larga',            value: fmtMs(summary.longestMs),              color: 'var(--color-green)' },
          ].map(({ label, value, color }) => (
            <div key={label} style={{
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: '10px 14px',
            }}>
              <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 700, marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 14, fontWeight: 900, fontFamily: 'var(--font-mono)', color }}>{value || '—'}</div>
            </div>
          ))}
        </div>
      )}

      {/* Active Lifecycles */}
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
      }}>
        <div style={{
          padding: '12px 18px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontWeight: 800, fontSize: 13 }}>
            ⚡ Oportunidades Activas
          </span>
          <span style={{ fontSize: 10, color: active.length > 0 ? 'var(--color-green)' : 'var(--text-dim)', fontWeight: 700 }}>
            {active.length} en seguimiento
          </span>
        </div>
        {active.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
            Sin oportunidades activas en este momento
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ background: 'var(--bg-surface-2)' }}>
              {['Estado', 'Par', 'Primer Visto', 'Duración', 'Apariciones', 'Max Spread', 'Max Profit'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 700, fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {active.map(entry => (
                <tr key={entry.key} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <StatusDot status={entry.status} />
                      <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-green)' }}>ACTIVA</span>
                    </div>
                  </td>
                  <td style={{ padding: '10px 12px' }}><PairLabel buyEx={entry.buyExchange} sellEx={entry.sellExchange} /></td>
                  <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{ago(entry.firstSeen)}</td>
                  <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-green)', fontWeight: 700 }}>{fmtMs(entry.durationMs)}</td>
                  <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-green)', fontWeight: 700 }}>{entry.seenCount}</td>
                  <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-yellow)' }}>{entry.maxSpread}%</td>
                  <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, color: entry.maxProfit >= 0 ? 'var(--color-green)' : 'var(--color-red)', fontWeight: 700 }}>
                    {entry.maxProfit >= 0 ? '+' : ''}${fmt4(entry.maxProfit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* History */}
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
      }}>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontWeight: 800, fontSize: 13 }}>
            🕐 Historial de Oportunidades Expiradas
          </span>
        </div>
        {history.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
            El historial aparece aquí a medida que las oportunidades expiran
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ background: 'var(--bg-surface-2)' }}>
              {['Par', 'Duración', 'Apariciones', 'Max Spread', 'Max Profit', 'Viable', 'Visto Hace'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 700, fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {history.slice(0, 25).map((entry, i) => (
                <tr key={entry.key + i} style={{ borderTop: '1px solid var(--border)', opacity: 0.85 }}>
                  <td style={{ padding: '9px 12px' }}><PairLabel buyEx={entry.buyExchange} sellEx={entry.sellExchange} /></td>
                  <td style={{ padding: '9px 12px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{fmtMs(entry.durationMs)}</td>
                  <td style={{ padding: '9px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{entry.seenCount}×</td>
                  <td style={{ padding: '9px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-yellow)' }}>{entry.maxSpread}%</td>
                  <td style={{ padding: '9px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, color: entry.maxProfit >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>
                    {entry.maxProfit >= 0 ? '+' : ''}${fmt4(entry.maxProfit)}
                  </td>
                  <td style={{ padding: '9px 12px' }}>
                    {entry.viable
                      ? <span style={{ background: 'rgba(0,184,122,0.10)', color: 'var(--color-green)', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4 }}>✓ Viable</span>
                      : <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>—</span>}
                  </td>
                  <td style={{ padding: '9px 12px', fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>{ago(entry.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
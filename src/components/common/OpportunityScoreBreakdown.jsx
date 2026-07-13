// OpportunityScoreBreakdown.jsx
// Audit S1: full transparency of opportunity score breakdown.
// En vez de show solo "73/100", desglosa los 5 componentes + 3 penalizaciones
// que arbitrageEngine.scoreOpportunityDetailed() calcula, cada uno con su barra
// progress vs. maximum possible — a key differentiator from commodity arb bots.
// Institutional explainability: shows WHY a score is what it is, not just WHAT it is.
//
// Props:
//   breakdown: el objeto op.scoreBreakdown que devuelve el backend
//              ({ components: {...}, penalties: {...}, rawScore, finalScore })
//   compact?:  if true, uses smaller typography (suitable for inline table row usage)

const BAR_COLORS = {
  profit: '#00B87A', liquidity: '#3B82F6', persistence: '#A855F7',
  latency: '#F59E0B', confidence: '#06B6D4',
};

function Bar({ value, max, color }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div style={{ background: 'var(--bg-surface-3)', borderRadius: 99, height: 5, overflow: 'hidden', flex: 1 }}>
      <div style={{ width: `${pct}%`, background: color, height: '100%', borderRadius: 99, transition: 'width 0.4s ease' }} />
    </div>
  );
}

export default function OpportunityScoreBreakdown({ breakdown, compact = false }) {
  if (!breakdown || !breakdown.components) return null;
  const { components, penalties } = breakdown;
  const fontSize = compact ? 9 : 10;
  const hasPenalties = penalties && Object.values(penalties).some(p => p.value > 0);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 5,
      padding: compact ? '8px 10px' : '10px 12px',
      background: 'var(--bg-surface-3)', borderRadius: 8, marginTop: 6,
    }}>
      <div style={{ fontSize: fontSize, fontWeight: 800, color: 'var(--text-dim)', letterSpacing: '0.04em', marginBottom: 2 }}>
        DESGLOSE DEL SCORE
      </div>
      {Object.entries(components).map(([key, c]) => (
        <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize, color: 'var(--text-dim)', width: compact ? 90 : 130, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {c.label}
          </span>
          <Bar value={c.value} max={c.max} color={BAR_COLORS[key] || '#888'} />
          <span style={{ fontSize, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', width: 48, textAlign: 'right' }}>
            {c.value}/{c.max}
          </span>
        </div>
      ))}

      {hasPenalties && (
        <>
          <div style={{ fontSize: fontSize, fontWeight: 800, color: 'var(--color-red)', letterSpacing: '0.04em', marginTop: 4 }}>
            PENALIZACIONES
          </div>
          {Object.entries(penalties).filter(([, p]) => p.value > 0).map(([key, p]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize, color: 'var(--text-dim)', width: compact ? 90 : 130 }}>{p.label}</span>
              <span style={{ fontSize, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--color-red)' }}>
                -{p.value}
              </span>
            </div>
          ))}
        </>
      )}

      <div style={{ fontSize, color: 'var(--text-dim)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
        raw {breakdown.rawScore} → clamp [1,100] → <span style={{ color: 'var(--text-muted)', fontWeight: 800 }}>{breakdown.finalScore}</span>
      </div>
    </div>
  );
}

export function Sparkline({ data = [], width = 80, height = 32, positive }) {
  if (!data || data.length < 2) return <span style={{ color:'var(--text-dim)', fontSize:12 }}>—</span>;
  const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
  const pts = data.map((v, i) => `${(i/(data.length-1))*width},${height-((v-min)/range)*height}`);
  const line = `M ${pts.join(' L ')}`;
  const area = `M 0,${height} L ${pts.join(' L ')} L ${width},${height} Z`;
  const up = positive !== undefined ? positive : (data[data.length-1] >= data[0]);
  const c = up ? 'var(--color-green)' : 'var(--color-red)';
  const f = up ? 'rgba(0,184,122,0.08)' : 'rgba(240,62,62,0.08)';
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow:'visible' }}>
      <path d={area} fill={f} />
      <path d={line} fill="none" stroke={c} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

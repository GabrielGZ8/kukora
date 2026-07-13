export const EX_COLORS = { Binance:'#F0B90B', Kraken:'#5741D9', Bybit:'#F7A600', Coinbase:'#0052FF', OKX:'#aaa' };
export const scoreColor = s => s>=61?'var(--color-green)':s>=31?'var(--color-yellow)':'var(--color-red)';
export const latColor   = ms => ms===0?'var(--color-green)':ms<80?'var(--color-green)':ms<400?'var(--color-yellow)':'var(--color-red)';
export const latLabel   = ms => ms===0?'WS':`${ms}ms`;
export const ALL_EXCHANGES = ['Binance','Kraken','Bybit','OKX','Coinbase'];

export const fmt    = (n, d=2)  => (n==null||isNaN(n)) ? '—' : Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
export const fmtP   = (n, d=4)  => (n==null||isNaN(n)) ? '—' : `$${Number(n).toFixed(d)}`;
export const fmtPct = n          => (n==null||isNaN(n)) ? '—' : `${Number(n).toFixed(4)}%`;
export const ago = ts => {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 2) return 'ahour'; if (s < 60) return `${s}s`; return `${Math.floor(s/60)}m`;
};
export const uptime = ms => {
  if (!ms) return '—';
  const s=Math.floor(ms/1000), m=Math.floor(s/60), h=Math.floor(m/60);
  if (h>0) return `${h}h ${m%60}m`; if (m>0) return `${m}m ${s%60}s`; return `${s}s`;
};
export const translateRejection = (reason) => {
  if (!reason) return null;
  if (reason.includes('Liquidity') || reason.includes('Liquidity')) return 'Liquidity insuficiente';
  if (reason.includes('Spread') && reason.includes('<')) return 'Spread bajo threshold';
  if (reason.includes('Spread') && reason.includes('>')) return 'Feed lento';
  if (reason.includes('Net') || reason.includes('minimum')) return 'Fees > spread';
  if (reason.includes('Price de compra')) return 'Price compra ≥ venta';
  if (reason.includes('Circuit') || reason.includes('circuit')) return 'Circuit breaker';
  if (reason.includes('Saldo')) return 'Saldo insuficiente';
  if (reason.includes('Coinbase')) return 'Coinbase fee 0.60%';
  return reason.slice(0, 45);
};

export function Card({ children, style, glow, glass }) {
  return (
    <div className={glass ? 'card-glass' : 'card'} style={{
      ...style,
      borderColor: glow ? 'rgba(0,184,122,0.40)' : 'var(--border)',
      boxShadow: glow ? '0 0 24px rgba(0,184,122,0.12), 0 4px 12px rgba(0,0,0,0.03)' : undefined,
    }}>{children}</div>
  );
}
export function SectionTitle({ children, right, sub }) {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 18px', borderBottom:'1px solid var(--border)' }}>
      <div>
        <span style={{ fontWeight:800, fontSize:13, color:'var(--text)', letterSpacing:'-0.01em' }}>{children}</span>
        {sub && <div style={{ fontSize:10, color:'var(--text-dim)', marginTop:1 }}>{sub}</div>}
      </div>
      {right && <div style={{ display:'flex', alignItems:'center', gap:8 }}>{right}</div>}
    </div>
  );
}
export function ExDot({ name, size=8 }) {
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}>
      <span style={{ width:size, height:size, borderRadius:'50%', background:EX_COLORS[name]||'#999', flexShrink:0 }}/>
      <span>{name}</span>
    </span>
  );
}
export function SlippageBadge({ method }) {
  if (!method) return null;
  const isReal = method==='real', isPartial = method==='partial';
  const label = isReal?'VWAP L2':isPartial?'VWAP ½':'est.';
  const color = isReal?'var(--color-green)':isPartial?'var(--color-yellow)':'var(--text-dim)';
  return (
    <span title={isReal?'Slippage calculado since L2 VWAP real':isPartial?'Un leg VWAP, otro fallback':'Fallback fijo 0.05%'}
      style={{ background:`${color}20`, color, fontWeight:700, fontSize:8, padding:'1px 5px', borderRadius:3, border:`1px solid ${color}44`, whiteSpace:'nowrap' }}>
      {label}
    </span>
  );
}
export function WsBadge({ on }) {
  return (
    <span style={{ background:on?'rgba(0,82,255,0.08)':'transparent', color:on?'#0052FF':'var(--text-dim)', fontWeight:700, fontSize:9, padding:'1px 5px', borderRadius:4, border:`1px solid ${on?'rgba(0,82,255,0.25)':'var(--border)'}` }}>
      {on?'WS':'HTTP'}
    </span>
  );
}

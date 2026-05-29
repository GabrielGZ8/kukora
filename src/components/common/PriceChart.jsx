import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

const fmtPrice = v => v >= 1000 ? `$${(v/1000).toFixed(1)}k` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(5)}`;

const Tip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:'var(--bg-surface)', border:'1px solid var(--border-bright)', borderRadius:10, padding:'10px 14px', fontSize:12, boxShadow:'var(--shadow-lg)' }}>
      <div style={{ color:'var(--text-muted)', marginBottom:4 }}>{payload[0]?.payload?.date}</div>
      <div style={{ fontWeight:800, fontSize:15, color:'var(--text)' }}>{fmtPrice(payload[0].value)}</div>
    </div>
  );
};

export function PriceChart({ data = [], height = 200 }) {
  if (!data.length) return <div style={{ height, display:'flex', alignItems:'center', justifyContent:'center' }}><div className="spinner" /></div>;
  const up = data[data.length-1]?.price >= data[0]?.price;
  const color = up ? 'var(--color-green)' : 'var(--color-red)';
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top:4, right:4, left:0, bottom:0 }}>
        <CartesianGrid stroke="rgba(255,255,255,0.04)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" tick={{ fill:'var(--text-dim)', fontSize:10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
        <YAxis domain={['auto','auto']} tick={{ fill:'var(--text-dim)', fontSize:10 }} axisLine={false} tickLine={false} tickFormatter={fmtPrice} width={60} />
        <Tooltip content={<Tip />} />
        <Line type="monotone" dataKey="price" stroke={color} strokeWidth={2.5} dot={false} activeDot={{ r:5, fill:color, strokeWidth:2, stroke:'#fff' }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

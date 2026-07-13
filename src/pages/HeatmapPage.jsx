import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Treemap, ResponsiveContainer, Tooltip } from 'recharts';
import { usePolling } from '../hooks/usePolling';
import { api } from '../api';

const COLOR_MODES = [
  { id: 'change_24h', label: '24h' },
  { id: 'change_1h', label: '1h' },
  { id: 'change_7d', label: '7d' },
];

// Map % change to color: -10% → deep red, 0 → neutral, +10% → green
const pctToColor = (pct) => {
  if (pct == null) return '#c8ccd6';
  const clamped = Math.max(-12, Math.min(12, pct));
  if (clamped >= 0) {
    const intensity = Math.min(1, clamped / 10);
    const r = Math.round(230 - intensity * 150);
    const g = Math.round(148 + intensity * 36);
    const b = Math.round(80 - intensity * 50);
    return `rgb(${r},${g},${b})`;
  } else {
    const intensity = Math.min(1, Math.abs(clamped) / 10);
    const r = Math.round(230 + intensity * 25);
    const g = Math.round(148 - intensity * 110);
    const b = Math.round(80 - intensity * 40);
    return `rgb(${r},${g},${b})`;
  }
};

const fmtB = (n) => n >= 1e12 ? `${(n/1e12).toFixed(2)}T` : n >= 1e9 ? `${(n/1e9).toFixed(1)}B` : `${(n/1e6).toFixed(0)}M`;
const fmt = (n) => n == null ? '—' : n >= 1 ? `$${n.toLocaleString('en', { maximumFractionDigits: 2 })}` : `$${n?.toFixed(5)}`;
const fmtPct = (n) => n == null ? '—' : `${n >= 0 ? '+' : ''}${Number(n)?.toFixed(2)}%`;

function CustomContent({ x, y, width, height, name, symbol, pct, price, image: _image }) {
  if (width < 30 || height < 20) return null;
  const color = pctToColor(pct);
  const textColor = '#fff';
  const showPrice = width > 70 && height > 50;
  const showPct = width > 40 && height > 35;
  const showName = width > 50 && height > 28;

  return (
    <g>
      <rect x={x + 1} y={y + 1} width={width - 2} height={height - 2} rx={6} fill={color} style={{ cursor: 'pointer', transition: 'opacity 0.1s' }} />
      {showName && (
        <text x={x + width / 2} y={y + height / 2 - (showPct ? 8 : 0) - (showPrice ? 7 : 0)} textAnchor="middle" dominantBaseline="middle" fill={textColor} fontSize={Math.min(14, Math.max(9, width / 5))} fontWeight={700}>
          {symbol || name}
        </text>
      )}
      {showPct && (
        <text x={x + width / 2} y={y + height / 2 + (showName ? 9 : 0) - (showPrice ? 6 : 0)} textAnchor="middle" dominantBaseline="middle" fill={textColor} fontSize={Math.min(12, Math.max(8, width / 6))} fontWeight={600} opacity={0.9}>
          {fmtPct(pct)}
        </text>
      )}
      {showPrice && (
        <text x={x + width / 2} y={y + height / 2 + (showName ? 9 : 0) + (showPct ? 11 : 0)} textAnchor="middle" dominantBaseline="middle" fill={textColor} fontSize={Math.min(10, Math.max(7, width / 7))} opacity={0.75}>
          {fmt(price)}
        </text>
      )}
    </g>
  );
}

function HeatmapTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div style={{
      background: '#fff',
      border: '1px solid var(--border)',
      borderRadius: 10,
      padding: '12px 16px',
      boxShadow: 'var(--shadow-lg)',
      fontSize: 12,
      minWidth: 180,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        {d.image && <img src={d.image} alt="" style={{ width: 24, height: 24, borderRadius: '50%' }} onError={e => e.target.style.display='none'} />}
        <div>
          <div style={{ fontWeight: 800, fontSize: 13 }}>{d.name}</div>
          <div style={{ color: 'var(--text-dim)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{d.symbol}</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {[
          { label: 'Price', value: fmt(d.price) },
          { label: '24h', value: fmtPct(d.change24h), color: d.change24h >= 0 ? 'var(--color-green)' : 'var(--color-red)' },
          { label: '1h', value: fmtPct(d.change1h), color: d.change1h >= 0 ? 'var(--color-green)' : 'var(--color-red)' },
          { label: '7d', value: fmtPct(d.change7d), color: d.change7d >= 0 ? 'var(--color-green)' : 'var(--color-red)' },
          { label: 'Market Cap', value: `$${fmtB(d.marketCap)}` },
          { label: 'Volume 24h', value: `$${fmtB(d.volume)}` },
        ].map(({ label, value, color }) => (
          <div key={label}>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', fontWeight: 700 }}>{label}</div>
            <div style={{ fontWeight: 700, color: color || 'var(--text)', fontSize: 12 }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function HeatmapPage() {
  const [colorMode, setColorMode] = useState('change_24h');
  const navigate = useNavigate();
  const { data: mkt, loading } = usePolling(() => api.markets(50), 30000);

  const coins = (mkt?.coins || []).map(c => ({
    name: c.name,
    symbol: c.symbol?.toUpperCase(),
    id: c.id,
    image: c.image,
    price: c.current_price,
    change1h:  c.price_change_percentage_1h_in_currency || 0,
    change24h: c.price_change_percentage_24h || 0,
    change7d:  c.price_change_percentage_7d_in_currency || 0,
    marketCap: c.market_cap || 1,
    volume: c.total_volume || 0,
    size: Math.max(c.market_cap || 1, 1),
    pct: colorMode === 'change_1h' ? (c.price_change_percentage_1h_in_currency || 0)
       : colorMode === 'change_7d' ? (c.price_change_percentage_7d_in_currency || 0)
       : (c.price_change_percentage_24h || 0),
  }));

  const gainersCount = coins.filter(c => c.change24h > 0).length;
  const breadth = coins.length ? +(gainersCount / coins.length * 100).toFixed(0) : 0;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 900, letterSpacing: '-0.5px', marginBottom: 4 }}>
            <span style={{ background: 'var(--brand-gradient)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Market</span> Heatmap
          </h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Top 50 coins · Tamyear = Market Cap · Click para ir a Analytics</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>Colorear por:</span>
          {COLOR_MODES.map(m => (
            <button
              key={m.id}
              onClick={() => setColorMode(m.id)}
              style={{
                padding: '5px 12px', borderRadius: 'var(--radius)', fontSize: 12, fontWeight: 700,
                border: '1px solid var(--border-bright)',
                background: colorMode === m.id ? 'var(--color-primary)' : 'var(--bg-surface)',
                color: colorMode === m.id ? '#fff' : 'var(--text-muted)',
                cursor: 'pointer',
              }}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Market Breadth bar */}
      <div style={{ background: 'var(--bg-surface)', borderRadius: 'var(--radius)', padding: '12px 18px', border: '1px solid var(--border)', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Market Breadth 24h</span>
        <div style={{ flex: 1, height: 10, background: 'var(--bg-surface-3)', borderRadius: 99, overflow: 'hidden' }}>
          <div style={{ width: `${breadth}%`, height: '100%', background: breadth > 50 ? 'var(--color-green)' : 'var(--color-red)', borderRadius: 99, transition: 'width 0.4s' }} />
        </div>
        <span style={{ fontSize: 13, fontWeight: 800, color: breadth > 50 ? 'var(--color-green)' : 'var(--color-red)', whiteSpace: 'nowrap' }}>
          {breadth}% positivos ({gainersCount}/{coins.length})
        </span>
      </div>

      {/* Color scale legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14, fontSize: 11, color: 'var(--text-muted)' }}>
        <div style={{ width: 120, height: 10, borderRadius: 4, background: 'linear-gradient(to right, #f03e3e, #e8943a, #d4d4d4, #78b88a, #00b87a)' }} />
        <span>-10%</span>
        <span style={{ flex: 1, textAlign: 'center' }}>0%</span>
        <span>+10%</span>
      </div>

      {/* Treemap */}
      <div style={{ background: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', padding: 4, boxShadow: 'var(--shadow-card)', overflow: 'hidden' }}>
        {loading && !mkt ? (
          <div style={{ textAlign: 'center', padding: 80 }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
        ) : (
          <ResponsiveContainer width="100%" height={560}>
            <Treemap
              data={coins}
              dataKey="size"
              aspectRatio={4 / 3}
              content={(props) => {
                const coin = coins.find(c => c.name === props.name);
                return (
                  <g
                    onClick={() => { if (coin) navigate(`/analytics?coin=${coin.id}`); }}
                    style={{ cursor: 'pointer' }}
                  >
                    <CustomContent {...props} symbol={coin?.symbol} pct={coin?.pct} price={coin?.price} image={coin?.image} />
                  </g>
                );
              }}
            >
              <Tooltip content={<HeatmapTooltip />} />
            </Treemap>
          </ResponsiveContainer>
        )}
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-dim)', textAlign: 'center' }}>
        Haz click en cualquier bloque para ver el analysis técnico completo · Update cada 30s
      </div>
    </div>
  );
}

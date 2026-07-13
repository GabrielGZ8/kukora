// ─── MarketPulse.jsx — live animated market summary widget ───────────────
// Displays 6 key metrics with animation and real-time trend indicators
// Uso: <MarketPulse coins={coins} global={globalData} />

import { useEffect, useRef, useState } from 'react';

function usePrevious(value) {
  const ref = useRef(value);
  useEffect(() => { ref.current = value; }, [value]);
  return ref.current;
}

function AnimatedNumber({ value, format, color }) {
  const prev   = usePrevious(value);
  const [flash, setFlash] = useState(null);

  useEffect(() => {
    if (prev == null || value === prev) return;
    setFlash(value > prev ? 'up' : 'down');
    const t = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(t);
  }, [value, prev]);

  const flashColor = flash === 'up' ? '#00b87a' : flash === 'down' ? '#f03e3e' : null;

  return (
    <span style={{
      color: flashColor || color || 'var(--text)',
      transition: 'color 0.4s ease',
      fontFamily: 'var(--font-mono)', fontWeight: 800,
    }}>
      {format(value)}
    </span>
  );
}

const fmtB = n => n == null ? '—' : n >= 1e12 ? `$${(n/1e12).toFixed(2)}T` : `$${(n/1e9).toFixed(2)}B`;
const fmtPct = n => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

export function MarketPulse({ coins = [], globalData }) {
  // Compute live metrics from coin data
  const btc = coins.find(c => c.id === 'bitcoin');
  const eth = coins.find(c => c.id === 'ethereum');

  const positives = coins.filter(c => (c.price_change_percentage_24h || 0) > 0).length;
  const breadth   = coins.length ? Math.round(positives / coins.length * 100) : 0;
  const avgChange = coins.length
    ? coins.reduce((a, c) => a + (c.price_change_percentage_24h || 0), 0) / coins.length
    : 0;
  const totalVol  = coins.reduce((a, c) => a + (c.total_volume || 0), 0);

  const btcDom = globalData?.market_cap_percentage?.btc;
  const mcap   = globalData?.total_market_cap?.usd;
  const mcapChg = globalData?.market_cap_change_percentage_24h_usd;

  const metrics = [
    {
      label: 'BTC Price',
      value: btc?.current_price,
      format: v => v ? `$${Math.round(v).toLocaleString('en')}` : '—',
      color: (btc?.price_change_percentage_24h || 0) >= 0 ? 'var(--color-green)' : 'var(--color-red)',
      sub: fmtPct(btc?.price_change_percentage_24h),
      subColor: (btc?.price_change_percentage_24h || 0) >= 0 ? 'var(--color-green)' : 'var(--color-red)',
    },
    {
      label: 'ETH Price',
      value: eth?.current_price,
      format: v => v ? `$${Math.round(v).toLocaleString('en')}` : '—',
      color: (eth?.price_change_percentage_24h || 0) >= 0 ? 'var(--color-green)' : 'var(--color-red)',
      sub: fmtPct(eth?.price_change_percentage_24h),
      subColor: (eth?.price_change_percentage_24h || 0) >= 0 ? 'var(--color-green)' : 'var(--color-red)',
    },
    {
      label: 'Mkt Cap Global',
      value: mcap,
      format: fmtB,
      color: (mcapChg || 0) >= 0 ? 'var(--color-green)' : 'var(--color-red)',
      sub: fmtPct(mcapChg),
      subColor: (mcapChg || 0) >= 0 ? 'var(--color-green)' : 'var(--color-red)',
    },
    {
      label: 'Dominancia BTC',
      value: btcDom,
      format: v => v ? `${v.toFixed(1)}%` : '—',
      color: 'var(--color-yellow)',
      sub: btcDom > 50 ? 'Risk-off' : btcDom > 45 ? 'Neutral' : 'Alt-season',
      subColor: 'var(--text-dim)',
    },
    {
      label: 'Breadth 24h',
      value: breadth,
      format: v => `${v}%`,
      color: breadth > 60 ? 'var(--color-green)' : breadth < 40 ? 'var(--color-red)' : 'var(--color-yellow)',
      sub: `${positives}/${coins.length} positivos`,
      subColor: 'var(--text-dim)',
    },
    {
      label: 'Vol. 24h',
      value: totalVol,
      format: fmtB,
      color: 'var(--text)',
      sub: 'Volume total Top 50',
      subColor: 'var(--text-dim)',
    },
    {
      label: 'Δ Average 24h',
      value: avgChange,
      format: v => fmtPct(v),
      color: avgChange >= 0 ? 'var(--color-green)' : 'var(--color-red)',
      sub: avgChange >= 0 ? 'Positive momentum' : 'Bearish pressure',
      subColor: 'var(--text-dim)',
    },
  ];

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
      gap: 1,
      background: 'var(--border)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      border: '1px solid var(--border)',
      marginBottom: 24,
    }}>
      {metrics.map((m, i) => (
        <div key={m.label} style={{
          background: 'var(--bg-surface)',
          padding: '14px 16px',
          position: 'relative',
        }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
            {m.label}
          </div>
          <div style={{ fontSize: 17, lineHeight: 1.1, marginBottom: 4 }}>
            {m.value != null
              ? <AnimatedNumber value={m.value} format={m.format} color={m.color} />
              : <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>—</span>
            }
          </div>
          <div style={{ fontSize: 10, color: m.subColor || 'var(--text-dim)', fontWeight: 600 }}>
            {m.sub}
          </div>
          {/* Live pulse indicator on first metric */}
          {i === 0 && (
            <div style={{ position: 'absolute', top: 10, right: 10 }}>
              <div className="pulse-dot" style={{ width: 5, height: 5 }} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

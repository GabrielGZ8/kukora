// ─── ComparePage.jsx — Quick Asset Comparator ────────────────────────────
// Compara until 4 actives: prices, returns, correlation, volat., risk
import { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { api } from '../api';
import { PageHeader } from '../components/common/PageHeader';

const ALL_COINS = [
  { id: 'bitcoin',      label: 'BTC', color: '#F7931A' },
  { id: 'ethereum',     label: 'ETH', color: '#627EEA' },
  { id: 'solana',       label: 'SOL', color: '#9945FF' },
  { id: 'binancecoin',  label: 'BNB', color: '#F3BA2F' },
  { id: 'ripple',       label: 'XRP', color: '#00AAE4' },
  { id: 'cardano',      label: 'ADA', color: '#0D47A1' },
  { id: 'avalanche-2',  label: 'AVAX', color: '#E84142' },
  { id: 'dogecoin',     label: 'DOGE', color: '#C2A633' },
  { id: 'polkadot',     label: 'DOT',  color: '#E6007A' },
  { id: 'chainlink',    label: 'LINK', color: '#375BD2' },
];

const PERIODS = [
  { label: '7d',  days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

const fmtPct = n => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

// Normalize prices to 100 at start
function normalize(prices) {
  if (!prices?.length) return [];
  const base = prices[0];
  return prices.map(p => base ? +((p / base) * 100).toFixed(3) : 100);
}

function CoinChip({ coin, selected, onToggle, disabled }) {
  return (
    <button
      onClick={() => onToggle(coin.id)}
      disabled={disabled && !selected}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '5px 12px', borderRadius: 99, fontSize: 12, fontWeight: 700,
        border: `2px solid ${selected ? coin.color : 'var(--border)'}`,
        background: selected ? `${coin.color}15` : 'var(--bg-surface)',
        color: selected ? coin.color : 'var(--text-muted)',
        cursor: disabled && !selected ? 'not-allowed' : 'pointer',
        opacity: disabled && !selected ? 0.4 : 1,
        transition: 'all 0.14s ease',
        fontFamily: 'var(--font-mono)',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: coin.color, flexShrink: 0 }} />
      {coin.label}
    </button>
  );
}

export default function ComparePage() {
  const [selected, setSelected]   = useState(['bitcoin', 'ethereum']);
  const [period,   setPeriod]     = useState(PERIODS[1]);
  const [data,     setData]       = useState({});
  const [loading,  setLoading]    = useState(false);

  const toggle = (id) => {
    setSelected(prev =>
      prev.includes(id)
        ? prev.filter(x => x !== id)
        : prev.length < 4 ? [...prev, id] : prev
    );
  };

  useEffect(() => {
    if (!selected.length) return;
    setLoading(true);
    Promise.all(
      selected.map(id =>
        api.get(`/api/crypto/coin/${id}/history?days=${period.days}`)
          .then(d => ({ id, prices: d?.prices?.map(([, p]) => p) || [], name: d?.name }))
          .catch(() => ({ id, prices: [], name: id }))
      )
    ).then(results => {
      const map = {};
      results.forEach(r => { map[r.id] = r; });
      setData(map);
      setLoading(false);
    });
  }, [selected, period.days]);

  // Build chart data: normalized to 100
  const chartData = (() => {
    const lengths = selected.map(id => data[id]?.prices?.length || 0).filter(Boolean);
    if (!lengths.length) return [];
    const len = Math.min(...lengths);
    return Array.from({ length: len }, (_, i) => {
      const point = { i };
      selected.forEach(id => {
        const prices = data[id]?.prices || [];
        const norm = normalize(prices);
        point[id] = norm[i] ?? null;
      });
      return point;
    });
  })();

  // Stats per coin
  const stats = selected.map(id => {
    const prices = data[id]?.prices || [];
    if (prices.length < 2) return { id, n: prices.length };
    const first = prices[0], last = prices[prices.length - 1];
    const totalReturn = ((last - first) / first) * 100;
    const daily = prices.slice(1).map((p, i) => (p - prices[i]) / prices[i] * 100);
    const mean = daily.reduce((a, b) => a + b, 0) / daily.length;
    const variance = daily.reduce((a, b) => a + (b - mean) ** 2, 0) / daily.length;
    const stdDev = Math.sqrt(variance);
    const maxPrice = Math.max(...prices), minPrice = Math.min(...prices);
    const maxDD = ((minPrice - maxPrice) / maxPrice) * 100;
    const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(365) : 0;
    const bestDay  = Math.max(...daily);
    const worstDay = Math.min(...daily);
    return {
      id, totalReturn, stdDev, maxDD, sharpe,
      current: last, best: bestDay, worst: worstDay,
    };
  });

  return (
    <div className="page-enter">
      <PageHeader
        title="Asset Comparator"
        description={`Compara until 4 actives · returns normalizados · metrics de risk · ${period.label}`}
        help="Los returns se normalizan a 100 en el punto de home para comparar performance relativa sin importar el price absoluto."
      />

      {/* Coin selector + period */}
      <div className="card" style={{ marginBottom: 20, padding: '16px 20px' }}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
            Select actives <span style={{ color: 'var(--text-dim)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(max. 4)</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {ALL_COINS.map(c => (
              <CoinChip
                key={c.id}
                coin={c}
                selected={selected.includes(c.id)}
                onToggle={toggle}
                disabled={selected.length >= 4}
              />
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Periodo:</span>
          {PERIODS.map(p => (
            <button
              key={p.label}
              onClick={() => setPeriod(p)}
              className={`btn btn-sm ${period.days === p.days ? 'btn-primary' : 'btn-ghost'}`}
            >
              {p.label}
            </button>
          ))}
          {loading && <div className="spinner" style={{ marginLeft: 'auto' }} />}
        </div>
      </div>

      {/* Normalized return chart */}
      {chartData.length > 0 && (
        <div className="card" style={{ marginBottom: 20, padding: '18px 20px' }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Return Relativo Normalizado</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Base 100 al home · mayor = mejor performance</div>
          </div>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="rgba(0,0,0,0.05)" strokeDasharray="3 3" />
              <XAxis
                dataKey="i"
                tickFormatter={v => {
                  const total = chartData.length;
                  if (v === 0) return 'Home';
                  if (v === total - 1) return 'Today';
                  return '';
                }}
                tick={{ fontSize: 10, fill: 'var(--text-dim)' }}
              />
              <YAxis
                tickFormatter={v => `${v.toFixed(0)}`}
                tick={{ fontSize: 10, fill: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}
                domain={['auto', 'auto']}
              />
              <Tooltip
                contentStyle={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 10, fontSize: 11, boxShadow: '0 4px 16px rgba(0,0,0,0.08)' }}
                formatter={(v, name) => {
                  const coin = ALL_COINS.find(c => c.id === name);
                  const delta = v - 100;
                  return [`${v?.toFixed(2)} (${delta >= 0 ? '+' : ''}${delta?.toFixed(2)}%)`, coin?.label || name];
                }}
              />
              <Legend formatter={name => ALL_COINS.find(c => c.id === name)?.label || name} />
              {selected.map(id => {
                const coin = ALL_COINS.find(c => c.id === id);
                return (
                  <Line
                    key={id}
                    type="monotone"
                    dataKey={id}
                    stroke={coin?.color || '#888'}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                  />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Stats comparison table */}
      {stats.some(s => s.totalReturn != null) && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Comparativa de Metrics</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Performance y risk en el periodo selectdo</div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg-surface-2)' }}>
                  <th style={{ padding: '9px 14px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', borderBottom: '1px solid var(--border)' }}>Metric</th>
                  {selected.map(id => {
                    const coin = ALL_COINS.find(c => c.id === id);
                    return (
                      <th key={id} style={{ padding: '9px 14px', textAlign: 'right', fontSize: 10, fontWeight: 700, borderBottom: '1px solid var(--border)' }}>
                        <span style={{ color: coin?.color || 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{coin?.label || id}</span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    label: `Return ${period.label}`,
                    get: s => s.totalReturn,
                    format: v => fmtPct(v),
                    color: v => v >= 0 ? 'var(--color-green)' : 'var(--color-red)',
                    best: 'max',
                  },
                  {
                    label: 'Volatility Diaria (σ)',
                    get: s => s.stdDev,
                    format: v => v != null ? `${v.toFixed(2)}%` : '—',
                    color: v => v < 3 ? 'var(--color-green)' : v < 6 ? 'var(--color-yellow)' : 'var(--color-red)',
                    best: 'min',
                  },
                  {
                    label: 'Max Drawdown',
                    get: s => s.maxDD,
                    format: v => v != null ? `${v.toFixed(2)}%` : '—',
                    color: () => 'var(--color-red)',
                    best: 'max',
                  },
                  {
                    label: 'Sharpe Ratio (anualiz.)',
                    get: s => s.sharpe,
                    format: v => v != null ? v.toFixed(3) : '—',
                    color: v => v > 1 ? 'var(--color-green)' : v > 0 ? 'var(--color-yellow)' : 'var(--color-red)',
                    best: 'max',
                  },
                  {
                    label: 'Best Day',
                    get: s => s.best,
                    format: v => fmtPct(v),
                    color: () => 'var(--color-green)',
                    best: 'max',
                  },
                  {
                    label: 'Worst Day',
                    get: s => s.worst,
                    format: v => fmtPct(v),
                    color: () => 'var(--color-red)',
                    best: 'max',
                  },
                ].map(row => {
                  const values = stats.map(s => row.get(s));
                  const validVals = values.filter(v => v != null);
                  const bestVal = row.best === 'max' ? Math.max(...validVals) : Math.min(...validVals);
                  return (
                    <tr key={row.label}>
                      <td style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', fontWeight: 500, whiteSpace: 'nowrap' }}>
                        {row.label}
                      </td>
                      {stats.map((s) => {
                        const v = row.get(s);
                        const isBest = v != null && v === bestVal && validVals.length > 1;
                        return (
                          <td key={s.id} style={{
                            padding: '11px 14px', textAlign: 'right',
                            borderBottom: '1px solid var(--border)',
                            background: isBest ? 'rgba(0,184,122,0.04)' : 'transparent',
                          }}>
                            <span style={{
                              fontWeight: isBest ? 800 : 700, fontSize: 12,
                              color: v != null ? row.color(v) : 'var(--text-dim)',
                              fontFamily: 'var(--font-mono)',
                            }}>
                              {row.format(v)}
                            </span>
                            {isBest && (
                              <span style={{ marginLeft: 4, fontSize: 9, color: 'var(--color-green)', fontWeight: 800 }}>★</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '10px 20px', background: 'var(--bg-surface-2)', fontSize: 10, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--color-green)', fontWeight: 800 }}>★</span>
            Mejor valor en la categoría · Sharpe Ratio &gt; 1 = buena compensación risk/return
          </div>
        </div>
      )}

      {!chartData.length && !loading && (
        <div style={{ textAlign: 'center', padding: 80, color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 40, opacity: 0.2, marginBottom: 12 }}>⬡</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Select al menos 2 actives</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>Compara returns, volatility y Sharpe Ratio</div>
        </div>
      )}
    </div>
  );
}

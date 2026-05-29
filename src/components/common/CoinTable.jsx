// ─── CoinTable.jsx — refined, sortable, with mini ATH indicator ──────────
import { useState } from 'react';
import { Sparkline } from './Sparkline';

const fmtUSD = (n, d = 2) => {
  if (n == null) return '—';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1)    return `$${n.toLocaleString('en', { maximumFractionDigits: d })}`;
  return `$${n.toFixed(5)}`;
};

function Pct({ v }) {
  if (v == null) return <span style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>—</span>;
  const up = v >= 0;
  return (
    <span style={{
      color: up ? 'var(--color-green)' : 'var(--color-red)',
      fontWeight: 700, fontSize: 12,
      fontFamily: 'var(--font-mono)',
    }}>
      {up ? '+' : ''}{v.toFixed(2)}%
    </span>
  );
}

function VolBar({ score }) {
  const color = score > 60 ? 'var(--color-red)' : score > 35 ? 'var(--color-yellow)' : 'var(--color-green)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
      <div style={{ width: 44, height: 3, background: 'var(--bg-surface-3)', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ width: `${score}%`, height: '100%', background: color, borderRadius: 99 }} />
      </div>
      <span style={{ fontSize: 10, color: 'var(--text-dim)', width: 20, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{score}</span>
    </div>
  );
}

function SortIcon({ field, sortField, sortDir }) {
  if (sortField !== field) return <span style={{ color: 'var(--border-bright)', marginLeft: 3, fontSize: 9 }}>⇅</span>;
  return <span style={{ color: 'var(--color-primary)', marginLeft: 3, fontSize: 9 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
}

const TH = ({ children, right, field, sortField, sortDir, onSort }) => (
  <th
    onClick={() => onSort?.(field)}
    style={{
      padding: '9px 12px', textAlign: right ? 'right' : 'left',
      fontWeight: 700, fontSize: 10, color: sortField === field ? 'var(--color-primary)' : 'var(--text-dim)',
      textTransform: 'uppercase', letterSpacing: '0.07em',
      background: 'var(--bg-surface-2)', borderBottom: '1px solid var(--border)',
      cursor: field ? 'pointer' : 'default', userSelect: 'none',
      whiteSpace: 'nowrap',
      transition: 'color 0.13s',
    }}
  >
    {children}
    {field && <SortIcon field={field} sortField={sortField} sortDir={sortDir} />}
  </th>
);

export function CoinTable({ coins, onSelect, compact = false }) {
  const [sortField, setSortField] = useState('market_cap_rank');
  const [sortDir,   setSortDir]   = useState('asc');

  if (!coins?.length) return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 48, flexDirection: 'column', gap: 10 }}>
      <div className="spinner" />
      <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Cargando mercados…</span>
    </div>
  );

  const handleSort = (field) => {
    if (!field) return;
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('desc'); }
  };

  const sorted = [...coins].sort((a, b) => {
    let av = a[sortField], bv = b[sortField];
    if (av == null) return 1;
    if (bv == null) return -1;
    return sortDir === 'asc' ? av - bv : bv - av;
  });

  return (
    <div style={{ overflowX: 'auto', borderRadius: 'var(--radius)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <TH field="market_cap_rank" sortField={sortField} sortDir={sortDir} onSort={handleSort}>#</TH>
            <TH>Asset</TH>
            <TH right field="current_price" sortField={sortField} sortDir={sortDir} onSort={handleSort}>Precio</TH>
            {!compact && <TH right field="price_change_percentage_1h_in_currency" sortField={sortField} sortDir={sortDir} onSort={handleSort}>1h</TH>}
            <TH right field="price_change_percentage_24h" sortField={sortField} sortDir={sortDir} onSort={handleSort}>24h</TH>
            {!compact && <TH right field="price_change_percentage_7d_in_currency" sortField={sortField} sortDir={sortDir} onSort={handleSort}>7d</TH>}
            <TH right field="market_cap" sortField={sortField} sortDir={sortDir} onSort={handleSort}>Mkt Cap</TH>
            {!compact && <TH right field="total_volume" sortField={sortField} sortDir={sortDir} onSort={handleSort}>Volumen</TH>}
            {!compact && <TH right>Volat.</TH>}
            <TH right>7d</TH>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c, idx) => {
            const up24 = (c.price_change_percentage_24h || 0) >= 0;
            return (
              <tr
                key={c.id}
                onClick={() => onSelect?.(c)}
                style={{ cursor: onSelect ? 'pointer' : 'default' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface-2)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                {/* Rank */}
                <td style={{ padding: '11px 12px', color: 'var(--text-dim)', fontSize: 11, borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)' }}>
                  {c.market_cap_rank}
                </td>

                {/* Asset */}
                <td style={{ padding: '11px 12px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <img src={c.image} alt={c.name} style={{ width: 28, height: 28, borderRadius: '50%', display: 'block' }}
                        onError={e => { e.target.style.display = 'none'; }} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
                        {c.name}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                        {c.symbol}
                      </div>
                    </div>
                  </div>
                </td>

                {/* Price */}
                <td style={{ padding: '11px 12px', textAlign: 'right', fontWeight: 800, borderBottom: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'nowrap' }}>
                  {fmtUSD(c.current_price)}
                </td>

                {/* 1h */}
                {!compact && (
                  <td style={{ padding: '11px 12px', textAlign: 'right', borderBottom: '1px solid var(--border)' }}>
                    <Pct v={c.price_change_percentage_1h_in_currency} />
                  </td>
                )}

                {/* 24h */}
                <td style={{ padding: '11px 12px', textAlign: 'right', borderBottom: '1px solid var(--border)' }}>
                  <Pct v={c.price_change_percentage_24h} />
                </td>

                {/* 7d */}
                {!compact && (
                  <td style={{ padding: '11px 12px', textAlign: 'right', borderBottom: '1px solid var(--border)' }}>
                    <Pct v={c.price_change_percentage_7d_in_currency} />
                  </td>
                )}

                {/* Market cap */}
                <td style={{ padding: '11px 12px', textAlign: 'right', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 12, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                  {fmtUSD(c.market_cap, 0)}
                </td>

                {/* Volume */}
                {!compact && (
                  <td style={{ padding: '11px 12px', textAlign: 'right', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', fontSize: 12, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    {fmtUSD(c.total_volume, 0)}
                  </td>
                )}

                {/* Volatility */}
                {!compact && (
                  <td style={{ padding: '11px 12px', borderBottom: '1px solid var(--border)' }}>
                    <VolBar score={c.volatility_score || 0} />
                  </td>
                )}

                {/* Sparkline */}
                <td style={{ padding: '11px 12px', textAlign: 'right', borderBottom: '1px solid var(--border)' }}>
                  <Sparkline data={c.sparkline_in_7d?.price} width={68} height={26} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

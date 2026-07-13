/**
 * AuditedPnlPanel.jsx — Kukora
 * Institutional P&L with reconciliation, breakdown by pair,
 * audit trail descargable y reporte HTML.
 */
import { requestArbitrage } from '../../api';
import { useState, useEffect, useCallback } from 'react';

const fmtUSD  = n => n == null ? '—' : `${n >= 0 ? '+' : ''}$${Math.abs(Number(n)).toFixed(4)}`;
const fmtUSD2 = n => n == null ? '—' : `${n >= 0 ? '+' : ''}$${Math.abs(Number(n)).toFixed(2)}`;

function Card({ label, value, color, sub }) {
  return (
    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 900, fontSize: 16, color: color || 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: 'var(--text-dim)', opacity: 0.7, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Row({ label, value, color, sub }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
      <div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{label}</div>
        {sub && <div style={{ fontSize: 9, color: 'var(--text-dim)', opacity: 0.6 }}>{sub}</div>}
      </div>
      <div style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 800, fontSize: 12, color: color || 'var(--text)' }}>{value}</div>
    </div>
  );
}

export default function AuditedPnlPanel({ data }) {
  const [trail, setTrail]         = useState([]);
  const [showTrail, setShowTrail] = useState(false);
  const [loading, setLoading]     = useState(false);
  const [selfPnl, setSelfPnl]     = useState(null);  // self-fetched

  // self-fetch audited PnL since SSE tick never includes it
  const fetchPnl = useCallback(async () => {
    try {
      const j = await requestArbitrage('pnl/audited');
      if (j?.ok) setSelfPnl(j);
    } catch { /* network error — panel shows stale data until next poll */ }
  }, []);

  useEffect(() => { fetchPnl(); }, [fetchPnl]);
  useEffect(() => {
    const id = setInterval(fetchPnl, 5000);
    return () => clearInterval(id);
  }, [fetchPnl]);

  const pnl = data?.auditedPnl || selfPnl;

  useEffect(() => {
    if (!showTrail) return;
    setLoading(true);
    requestArbitrage('pnl/audit-trail?limit=20')
      
      .then(d => { if (d?.trail) setTrail(d.trail); setLoading(false); })
      .catch(() => setLoading(false));
  }, [showTrail]);

  if (!pnl) {
    return (
      <div className="card" style={{ padding: 20 }}>
        <div style={{ fontWeight: 800, fontSize: 12, marginBottom: 10 }}>📋 P&L Audited</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', opacity: 0.6 }}>
          Waiting for data… Los datos de P&L audited aparecen tras el primer trade.
        </div>
      </div>
    );
  }

  const pnlColor   = (pnl.realizedPnl || 0) >= 0 ? '#00b87a' : '#ef4444';
  const reconcColor = pnl.reconciled ? '#00b87a' : '#ef4444';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Header card */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 13 }}>💰 P&L Audited — Institucional</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, lineHeight:1.5, maxWidth:560 }}>Cent-accurate reconciliation: realized P&amp;L, mark-to-market of open BTC, trading pair breakdown, total fees, and audit trail downloadable as CSV and HTML. This view is the definitive accounting source — every number is traceable to the individual trade.</div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <span style={{ fontSize: 9, fontWeight: 700, padding: '3px 9px', borderRadius: 99, background: pnl.reconciled ? 'rgba(0,184,122,0.1)' : 'rgba(239,68,68,0.1)', color: reconcColor, border: `1px solid ${reconcColor}44` }}>
              {pnl.reconciled ? '✓ Reconciled' : `⚠ ${pnl.reconcErrors} errors`}
            </span>
            <span style={{ fontSize: 9, color: 'var(--text-dim)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', padding: '3px 9px', borderRadius: 99 }}>
              {pnl.auditVersion || 'v17'}
            </span>
          </div>
        </div>

        <div style={{ padding: '14px 16px' }}>

          {/* Main grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(145px,1fr))', gap: 8, marginBottom: 14 }}>
            <Card label="P&L Realizado"  value={fmtUSD(pnl.realizedPnl)}    color={pnlColor}   sub="trades cerrados" />
            <Card label="P&L Irealizado" value={fmtUSD(pnl.unrealizedPnl)}  color="#94a3b8"    sub="mark-to-market BTC" />
            <Card label="P&L Total"      value={fmtUSD2(pnl.totalPnl)}      color={pnlColor}   sub="realizado + MTM" />
            <Card label="Gross Profit"   value={fmtUSD(pnl.grossProfit)}    color="#94a3b8"    sub="antes de fees" />
            <Card label="Total Fees"     value={`-$${Math.abs(pnl.totalFees||0).toFixed(4)}`}    color="#f59e0b" sub="fees pagados" />
            <Card label="Slippage"       value={`-$${Math.abs(pnl.totalSlippage||0).toFixed(4)}`} color="#f59e0b" sub="impact real" />
          </div>

          {/* Trade stats */}
          <div style={{ marginBottom: 14 }}>
            <Row label="Trades"      value={`${pnl.winningTrades}W / ${pnl.losingTrades}L / ${pnl.totalTrades} total`} />
            <Row label="Win Rate"    value={pnl.winRate != null ? `${pnl.winRate}%` : '—'} color={pnl.winRate >= 55 ? '#00b87a' : '#f59e0b'} />
            <Row label="Avg Win"     value={fmtUSD(pnl.avgWin)}         color="#00b87a" />
            <Row label="Avg Loss"    value={fmtUSD(pnl.avgLoss)}        color="#ef4444" />
            <Row label="Mejor Trade" value={fmtUSD(pnl.bestTrade)}      color="#00b87a" />
            <Row label="Peor Trade"  value={fmtUSD(pnl.worstTrade)}     color="#ef4444" />
            <Row label="P&L / Trade" value={fmtUSD(pnl.profitPerTrade)} />
            <Row label="P&L / Time"  value={fmtUSD(pnl.profitPerHour)}  sub="a rate actual" />
          </div>

          {/* By pair */}
          {pnl.byPair && Object.keys(pnl.byPair).length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Breakdown por Par</div>
              {Object.entries(pnl.byPair).sort(([,a],[,b]) => b - a).map(([pair, v]) => (
                <div key={pair} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{pair}</span>
                  <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 11, fontWeight: 700, color: v >= 0 ? '#00b87a' : '#ef4444' }}>{fmtUSD(v)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setShowTrail(v => !v)} style={{ flex: 1, minWidth: 100, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 12px', fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', cursor: 'pointer' }}>
              {showTrail ? '▲ Hide Trail' : '▼ Audit Trail'}
            </button>
            <a href="/api/arbitrage/pnl/export-csv" style={{ background: 'rgba(0,184,122,0.08)', border: '1px solid rgba(0,184,122,0.2)', borderRadius: 8, padding: '7px 14px', fontSize: 10, fontWeight: 700, color: '#00b87a', textDecoration: 'none' }}>
              ↓ CSV
            </a>
            <a href="/api/arbitrage/report/html" target="_blank" rel="noreferrer" style={{ background: 'rgba(0,82,255,0.08)', border: '1px solid rgba(0,82,255,0.2)', borderRadius: 8, padding: '7px 14px', fontSize: 10, fontWeight: 700, color: '#0052FF', textDecoration: 'none' }}>
              ↓ HTML Report
            </a>
          </div>

          {/* Audit trail table */}
          {showTrail && (
            <div style={{ marginTop: 12, overflowX: 'auto' }}>
              {loading ? (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '10px 0' }}>Loading trail…</div>
              ) : trail.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '10px 0' }}>No audited trades yet.</div>
              ) : (
                <>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Lasts {trail.length} trades — audit trail</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        {['Par','BTC','Compra','Venta','Fees','Slip','Neto','OK'].map(h => (
                          <th key={h} style={{ padding: '4px 6px', textAlign: 'left', color: 'var(--text-dim)', fontWeight: 700, fontSize: 9 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {trail.map(t => (
                        <tr key={t.id} style={{ borderBottom: '1px solid rgba(30,42,58,0.5)' }}>
                          <td style={{ padding: '4px 6px', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{t.pair}</td>
                          <td style={{ padding: '4px 6px', fontFamily: 'monospace' }}>{(t.amount||0).toFixed(4)}</td>
                          <td style={{ padding: '4px 6px', fontFamily: 'monospace' }}>${(t.buyPrice||0).toLocaleString()}</td>
                          <td style={{ padding: '4px 6px', fontFamily: 'monospace' }}>${(t.sellPrice||0).toLocaleString()}</td>
                          <td style={{ padding: '4px 6px', fontFamily: 'monospace', color: '#f59e0b' }}>-${Math.abs(t.fees||0).toFixed(4)}</td>
                          <td style={{ padding: '4px 6px', fontFamily: 'monospace', color: '#f59e0b' }}>-${Math.abs(t.slippage||0).toFixed(4)}</td>
                          <td style={{ padding: '4px 6px', fontFamily: 'monospace', fontWeight: 800, color: (t.netProfit||0) >= 0 ? '#00b87a' : '#ef4444' }}>{fmtUSD(t.netProfit)}</td>
                          <td style={{ padding: '4px 6px', fontWeight: 700, fontSize: 11, color: t.reconciled ? '#00b87a' : '#ef4444' }}>{t.reconciled ? '✓' : '✗'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

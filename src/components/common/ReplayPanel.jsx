/**
 * ReplayPanel.jsx — Kukora
 *
 * Improvement #1: "Replay histórico de opportunities".
 * Muestra una lista de momentos capturados (opportunities viables o trades
 * ejecutados) y permite reproducir el snapshot completo del order book L2
 * exacto en ese instante. Resuelve el problema de demo en vivo: si el market
 * no coopera justo 
 */
import { requestArbitrage } from '../../api';
import { useState, useEffect, useCallback, useRef } from 'react';

const fmt    = (n, d = 2) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtP   = (n, d = 4) => (n == null || isNaN(n)) ? '—' : `$${Number(n).toFixed(d)}`;
const timeAgo = ts => {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `hace ${s}s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)}m`;
  return `hace ${Math.floor(s / 3600)}h`;
};

const REASON_LABELS = {
  transition_to_viable: { label: 'New opportunity', color: 'var(--color-green)', icon: '⚡' },
  trade_executed:        { label: 'Trade ejecutado',   color: '#0052FF',            icon: '✓' },
  spread_improved:        { label: 'Spread improved',     color: 'var(--color-yellow)',icon: '↑' },
};

const EX_COLORS = { Binance: '#F0B90B', Kraken: '#5741D9', Bybit: '#F7A600', Coinbase: '#0052FF', OKX: '#aaa' };

function ExDot({ name }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: EX_COLORS[name] || '#999', flexShrink: 0 }} />
      {name}
    </span>
  );
}

// ─── Order book snapshot visualizer ────────────────────────────────────────
function BookSnapshotTable({ books, highlightBuy, highlightSell }) {
  if (!books || !books.length) {
    return <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>No data de order book para este snapshot.</div>;
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: 'var(--bg-surface-2)' }}>
            {['Exchange', 'Bid', 'Ask', 'Spread%', 'Top-5 Bids (L2)', 'Top-5 Asks (L2)'].map(h => (
              <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 700, fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {books.map(b => {
            const isBuy = b.exchange === highlightBuy;
            const isSell = b.exchange === highlightSell;
            return (
              <tr key={b.exchange} style={{
                borderTop: '1px solid var(--border)',
                background: isBuy ? 'rgba(0,184,122,0.06)' : isSell ? 'rgba(0,82,255,0.05)' : undefined,
              }}>
                <td style={{ padding: '8px 10px', fontWeight: 700 }}>
                  <ExDot name={b.exchange} />
                  {isBuy && <span style={{ marginLeft: 6, fontSize: 8, fontWeight: 800, color: 'var(--color-green)' }}>COMPRA</span>}
                  {isSell && <span style={{ marginLeft: 6, fontSize: 8, fontWeight: 800, color: '#0052FF' }}>VENTA</span>}
                </td>
                <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)' }}>{b.error ? '—' : `$${fmt(b.bid, 2)}`}</td>
                <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)' }}>{b.error ? '—' : `$${fmt(b.ask, 2)}`}</td>
                <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{b.error ? '—' : `${b.spreadPct}%`}</td>
                <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
                  {b.depth?.bids?.length
                    ? b.depth.bids.map(([p, q], i) => <div key={i}>{fmt(p, 0)} × {fmt(q, 4)}</div>)
                    : '—'}
                </td>
                <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
                  {b.depth?.asks?.length
                    ? b.depth.asks.map(([p, q], i) => <div key={i}>{fmt(p, 0)} × {fmt(q, 4)}</div>)
                    : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function ReplayPanel() {
  const [list, setList]               = useState([]);
  const [loading, setLoading]         = useState(true);
  const [selectedId, setSelectedId]   = useState(null);
  const [snapshot, setSnapshot]       = useState(null);
  const [snapLoading, setSnapLoading] = useState(false);
  const [error, setError]             = useState(null);
  const pollRef = useRef(null);

  const fetchList = useCallback(async () => {
    try {
      const json = await requestArbitrage('replays?limit=60');
      if (json?.ok) { setList(json.data); setError(null); }
    } catch { setError('No se pudo load la lista de replays'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchList();
    pollRef.current = setInterval(fetchList, 5000); // refresh list every 5s — new moments keep arriving
    return () => clearInterval(pollRef.current);
  }, [fetchList]);

  const loadSnapshot = useCallback(async (id) => {
    setSelectedId(id);
    setSnapLoading(true);
    try {
      const json = await requestArbitrage(`replays/${id}`);
      if (json?.ok) setSnapshot(json.data);
    } catch { /* keep previous snapshot on transient error */ }
    finally { setSnapLoading(false); }
  }, []);

  const loadBestToday = useCallback(async () => {
    setSnapLoading(true);
    try {
      const json = await requestArbitrage('replays/best');
      if (json?.ok && json.data) {
        setSnapshot(json.data);
        setSelectedId('best');
      }
    } catch { /* noop */ }
    finally { setSnapLoading(false); }
  }, []);

  const op = snapshot?.opportunity;
  const trade = snapshot?.executedTrade;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 18px',
        background: 'linear-gradient(135deg, rgba(255,45,120,0.06), rgba(88,65,217,0.06))',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
      }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 16, letterSpacing: '-0.02em' }}>⏮ Historical Replay</div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
            Cada momento es real — capturado directamente del pipeline de detection, con order books L2 completos.
          </div>
        </div>
        <button onClick={loadBestToday} style={{
          background: 'linear-gradient(135deg,#FF8C42,#FF2D78)', color: '#fff', border: 'none',
          borderRadius: 8, padding: '8px 16px', fontWeight: 800, fontSize: 12, cursor: 'pointer',
          boxShadow: '0 2px 12px rgba(255,45,120,0.30)', whiteSpace: 'nowrap',
        }}>
          ▶ Mejor momento de today
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16 }}>
        {/* List */}
        <div className="card" style={{ padding: 0, maxHeight: 560, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Momentos capturados ({list.length})
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {loading && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>Loading…</div>}
            {!loading && error && <div style={{ padding: 20, textAlign: 'center', color: 'var(--color-red)', fontSize: 12 }}>{error}</div>}
            {!loading && !error && list.length === 0 && (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
                Aún no hay momentos capturados. En cuanto el engine detecte una opportunity viable, aparecerá aquí automáticamente.
              </div>
            )}
            {list.map(item => {
              const r = REASON_LABELS[item.reason] || { label: item.reason, color: 'var(--text-dim)', icon: '•' };
              const isSelected = selectedId === item.id;
              return (
                <button key={item.id} onClick={() => loadSnapshot(item.id)} style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: isSelected ? 'rgba(255,45,120,0.06)' : 'transparent',
                  border: 'none', borderBottom: '1px solid var(--border)',
                  borderLeft: isSelected ? '3px solid #FF2D78' : '3px solid transparent',
                  padding: '10px 14px', cursor: 'pointer',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 800, color: r.color }}>{r.icon} {r.label}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>{timeAgo(item.ts)}</span>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{item.pair}</div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 3, fontSize: 10, fontFamily: 'var(--font-mono)' }}>
                    <span style={{ color: (item.netProfit || 0) >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>
                      {(item.netProfit || 0) >= 0 ? '+' : ''}{fmtP(item.netProfit, 4)}
                    </span>
                    <span style={{ color: 'var(--text-dim)' }}>{item.spreadPct?.toFixed(3)}%</span>
                    {item.score != null && <span style={{ color: 'var(--text-dim)' }}>score {item.score}</span>}
                    {item.detectionLatencyMs != null && item.detectionLatencyMs > 0 && (
                      <span style={{ color: 'var(--text-dim)' }}>{item.detectionLatencyMs}ms</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Detail / replay view */}
        <div className="card" style={{ padding: 0 }}>
          {snapLoading && (
            <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-dim)' }}>Loading snapshot…</div>
          )}
          {!snapLoading && !snapshot && (
            <div style={{ padding: 60, textAlign: 'center', color: 'var(--text-dim)' }}>
              Select un momento de la lista, o presiona &quot;Mejor momento de today&quot;.
            </div>
          )}
          {!snapLoading && snapshot && (
            <>
              <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 900, fontSize: 16 }}>{snapshot.pair}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{new Date(snapshot.ts).toLocaleString('es-MX')}</div>
                </div>
                {op && (
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 18 }}>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', fontWeight: 700 }}>Neto detectado</div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 900, fontSize: 18, color: (op.netProfit || 0) >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>
                        {(op.netProfit || 0) >= 0 ? '+' : ''}{fmtP(op.netProfit, 4)}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', fontWeight: 700 }}>Spread</div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 900, fontSize: 18 }}>{op.spreadPct?.toFixed(4)}%</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', fontWeight: 700 }}>Detection</div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 900, fontSize: 18, color: 'var(--color-green)' }}>
                        {snapshot.detectionLatencyMs ?? op.detectionLatencyMs ?? 0}ms
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {trade && (
                <div style={{ padding: '10px 18px', background: 'rgba(0,82,255,0.05)', borderBottom: '1px solid var(--border)', display: 'flex', gap: 16, alignItems: 'center', fontSize: 12 }}>
                  <span style={{ fontWeight: 800, color: '#0052FF' }}>✓ TRADE EJECUTADO</span>
                  <span>Amount: <b style={{ fontFamily: 'var(--font-mono)' }}>{fmt(trade.amount, 4)} BTC</b></span>
                  <span>Fees: <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-red)' }}>-{fmtP(trade.totalFees, 4)}</b></span>
                  <span>Slippage: <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-red)' }}>-{fmtP(trade.slippage, 4)}</b></span>
                  <span>Neto real: <b style={{ fontFamily: 'var(--font-mono)', color: (trade.netProfit || 0) >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>{(trade.netProfit || 0) >= 0 ? '+' : ''}{fmtP(trade.netProfit, 4)}</b></span>
                </div>
              )}

              <BookSnapshotTable books={snapshot.orderBooks} highlightBuy={op?.buyExchange} highlightSell={op?.sellExchange} />

              {op?.rejectionReason && !op.viable && (
                <div style={{ padding: '10px 18px', fontSize: 11, color: 'var(--text-dim)', borderTop: '1px solid var(--border)' }}>
                  Note: {op.rejectionReason}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * TradeHistoryPanel.jsx — Kukora
 *
 * Área 4 fix: the "History de Operations" table used to render only the
 * last 20 trades pushed over the SSE stream (`data.history`), which:
 *   - reset to empty on every page reload / SSE reconnect,
 *   - could never be filtered by exchange or outcome,
 *   - could never go further back than the last 20 trades, even though the
 *     backend already keeps up to 500 (walletManager.tradeHistory) and
 *     already exposed a `GET /api/arbitrage/history` endpoint that returned
 *     the full list — the frontend simply never called it.
 *
 * This panel replaces that static SSE-only slice with a real paginated,
 * filterable view backed by that endpoint (now itself extended to accept
 * limit/offset/exchange/status — see server/arbitrage/subroutes/stream.routes.js).
 * It still reacts to the live SSE feed: whenever a new trade comes in over
 * the stream and the user is looking at the first, unfiltered page, it
 * quietly refreshes so new trades still show up immediately without a
 * manual reload.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { requestArbitrage } from '../../api';
import {
  scoreColor, ALL_EXCHANGES, fmt, fmtP,
  Card, SectionTitle, ExDot,
} from './ArbitrageSharedComponents';

const PAGE_SIZE = 20;

export default function TradeHistoryPanel({ lastTrade, opportunitiesScanned, onSelectTrade, resetSignal }) {
  const [rows, setRows]         = useState([]);
  const [total, setTotal]       = useState(0);
  const [offset, setOffset]     = useState(0);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [exchange, setExchange] = useState('');
  const [status, setStatus]     = useState('');

  const offsetRef = useRef(0);
  useEffect(() => { offsetRef.current = offset; }, [offset]);

  const load = useCallback(async (nextOffset, { silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(nextOffset) });
      if (exchange) params.set('exchange', exchange);
      if (status)   params.set('status', status);
      const j = await requestArbitrage(`history?${params.toString()}`);
      if (!j?.ok) throw new Error(j?.error || 'Request failed');
      setRows(j.data || []);
      setTotal(j.pagination?.total ?? (j.data || []).length);
      setOffset(nextOffset);
    } catch (e) {
      if (!silent) setError(e.message || 'No se pudo cargar el historial');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [exchange, status]);

  // Reload page 1 whenever filters change or the wallet/history is reset
  useEffect(() => { load(0); }, [load, resetSignal]);

  // Quiet refresh of page 1 when a new trade streams in, as long as the
  // user hasn't paged forward — avoids yanking them off a page they're
  // reading, while still surfacing new trades on the default view.
  const lastTradeIdRef = useRef(null);
  useEffect(() => {
    if (!lastTrade || lastTrade.id === lastTradeIdRef.current) return;
    lastTradeIdRef.current = lastTrade.id;
    if (offsetRef.current === 0) load(0, { silent: true });
  }, [lastTrade, load]);

  const hasPrev = offset > 0;
  const hasNext = offset + rows.length < total;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd   = offset + rows.length;

  return (
    <Card>
      <SectionTitle right={
        <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
          <select value={exchange} onChange={e => setExchange(e.target.value)}
            style={{ fontSize:11, padding:'3px 6px', borderRadius:6, border:'1px solid var(--border)', background:'var(--bg-surface)', color:'var(--text)' }}>
            <option value="">Todos los exchanges</option>
            {ALL_EXCHANGES.map(ex => <option key={ex} value={ex}>{ex}</option>)}
          </select>
          <select value={status} onChange={e => setStatus(e.target.value)}
            style={{ fontSize:11, padding:'3px 6px', borderRadius:6, border:'1px solid var(--border)', background:'var(--bg-surface)', color:'var(--text)' }}>
            <option value="">Profit + Loss</option>
            <option value="profit">Solo Profit</option>
            <option value="loss">Solo Loss</option>
          </select>
          <span style={{ fontSize:11, color:'var(--text-dim)' }}>
            {total > 0 ? `${rangeStart}–${rangeEnd} de ${total}` : '0 ops'}
          </span>
        </div>
      }>History de Operations</SectionTitle>

      {error && (
        <div style={{ margin:'0 16px 12px', padding:'10px 14px', borderRadius:8, background:'var(--color-red-dim)', border:'1px solid rgba(240,62,62,0.3)', display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
          <span style={{ fontSize:12, color:'var(--color-red)', fontWeight:600 }}>⚠ {error}</span>
          <button onClick={() => load(offset)} className="btn btn-sm btn-secondary" style={{ marginLeft:'auto' }}>Reintentar</button>
        </div>
      )}

      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
          <thead><tr style={{ background:'var(--bg-surface-2)' }}>
            {['#','Time','Compra en','Price compra','Vende en','Price venta','BTC','Fees','Slip','Score','Neto','Status'].map((h,i)=>(
              <th key={i} style={{ padding:'7px 9px', textAlign:'left', fontWeight:700, fontSize:9, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.05em', whiteSpace:'nowrap' }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {loading && (
              <tr><td colSpan={12} style={{ padding:32, textAlign:'center' }}><div className="spinner" /></td></tr>
            )}
            {!loading && !error && rows.length === 0 && (
              <tr><td colSpan={12} style={{ padding:24, textAlign:'center' }}>
                <div style={{ color:'var(--text-dim)', fontSize:13 }}>
                  {exchange || status
                    ? 'Sin operations que coincidan con estos filters.'
                    : <>Engine active — will execute when net spread exceeds the minimum required.
                      {opportunitiesScanned > 0 && ` ${opportunitiesScanned.toLocaleString()} pairs scanned this session.`}</>
                  }
                </div>
              </td></tr>
            )}
            {!loading && rows.map((t,i)=>(
              <tr key={t.id||i} style={{ borderTop:'1px solid var(--border)', background: t.synthetic?'rgba(255,200,0,0.03)':'' }}
                className="row-hover"
                onClick={() => onSelectTrade?.(t)}>
                <td style={{ padding:'7px 9px', color:'var(--text-dim)', fontWeight:600 }}>
                  {offset+i+1}{t.synthetic&&<span style={{ marginLeft:3, fontSize:8, color:'#F59E0B', fontWeight:800 }}>DEMO</span>}
                </td>
                <td style={{ padding:'7px 9px', fontFamily:'var(--font-mono)', color:'var(--text-muted)', whiteSpace:'nowrap' }}>{t.ts?new Date(t.ts).toLocaleTimeString('en-US',{hour12:false}):'—'}</td>
                <td style={{ padding:'7px 9px', fontWeight:700 }}><ExDot name={t.buyExchange}/></td>
                <td style={{ padding:'7px 9px', fontFamily:'var(--font-mono)' }}>${fmt(t.buyPrice)}</td>
                <td style={{ padding:'7px 9px', fontWeight:700 }}><ExDot name={t.sellExchange}/></td>
                <td style={{ padding:'7px 9px', fontFamily:'var(--font-mono)' }}>${fmt(t.sellPrice)}</td>
                <td style={{ padding:'7px 9px', fontFamily:'var(--font-mono)' }}>{fmt(t.amount,4)}{t.partialFill&&<span style={{ marginLeft:3, fontSize:8, color:'var(--color-yellow)', fontWeight:700 }}>P</span>}</td>
                <td style={{ padding:'7px 9px', fontFamily:'var(--font-mono)', color:'var(--color-red)' }}>-${fmt(t.totalFees||(t.buyFee||0)+(t.sellFee||0),4)}</td>
                <td style={{ padding:'7px 9px', fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-dim)' }}>{t.slippagePct!=null?`${Number(t.slippagePct).toFixed(3)}%`:'—'}</td>
                <td style={{ padding:'7px 9px' }}>{t.score!=null&&<span style={{ background:`${scoreColor(t.score)}20`, color:scoreColor(t.score), fontWeight:800, fontSize:9, padding:'1px 6px', borderRadius:4, fontFamily:'var(--font-mono)' }}>{t.score}</span>}</td>
                <td style={{ padding:'7px 9px', fontFamily:'var(--font-mono)', fontWeight:800, color:(t.netProfit||0)>=0?'var(--color-green)':'var(--color-red)' }}>{(t.netProfit||0)>=0?'+':''}{fmtP(t.netProfit,4)}</td>
                <td style={{ padding:'7px 9px' }}><span style={{ background:t.status==='profit'?'var(--color-green-dim)':'var(--color-red-dim)', color:t.status==='profit'?'var(--color-green)':'var(--color-red)', fontWeight:700, fontSize:9, padding:'2px 6px', borderRadius:99 }}>{t.status==='profit'?'▲ PROFIT':'▼ LOSS'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total > PAGE_SIZE && (
        <div style={{ display:'flex', justifyContent:'flex-end', gap:8, padding:'12px 16px 4px' }}>
          <button className="btn btn-sm btn-secondary" disabled={!hasPrev || loading} onClick={() => load(Math.max(0, offset - PAGE_SIZE))}>← Anterior</button>
          <button className="btn btn-sm btn-secondary" disabled={!hasNext || loading} onClick={() => load(offset + PAGE_SIZE)}>Siguiente →</button>
        </div>
      )}
    </Card>
  );
}

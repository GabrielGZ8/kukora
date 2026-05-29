/**
 * ArbitragePage.jsx — kukora arbitrage bot
 * SSE real-time | 4 WS (Binance+Kraken+Bybit+OKX) | score slider | equity persistente
 * MEJORAS:
 *  - OKX incluido en order books, wallets, WS status
 *  - Slippage method badge: VWAP REAL vs est. (fallback)
 *  - history y equityCurve se preservan entre ticks (solo se sobreescriben cuando vienen en payload)
 *  - Withdrawal fee breakdown en historial
 *  - Slippage breakdown por leg en oportunidades
 *  - maxDrawdown y slippageMethodBreakdown en header
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { useArbitrageStream } from '../hooks/useArbitrageStream';
import { usePolling } from '../hooks/usePolling';
import toast from 'react-hot-toast';

const fmt    = (n, d=2)  => (n==null||isNaN(n)) ? '—' : Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtP   = (n, d=4)  => (n==null||isNaN(n)) ? '—' : `$${Number(n).toFixed(d)}`;
const fmtPct = n          => (n==null||isNaN(n)) ? '—' : `${Number(n).toFixed(4)}%`;
const ago = ts => {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 2) return 'ahora'; if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`; return `${Math.floor(s/3600)}h ago`;
};
const uptime = ms => {
  if (!ms) return '—';
  const s=Math.floor(ms/1000), m=Math.floor(s/60), h=Math.floor(m/60);
  if (h>0) return `${h}h ${m%60}m`; if (m>0) return `${m}m ${s%60}s`; return `${s}s`;
};

const EX_COLORS = { Binance:'#F0B90B', Kraken:'#5741D9', Bybit:'#F7A600', Coinbase:'#0052FF', OKX:'#000000' };
const EX_COLORS_DARK = { ...EX_COLORS, OKX:'#aaa' }; // OKX on dark background
const scoreColor = s => s>=61?'var(--color-green)':s>=31?'var(--color-yellow)':'var(--color-red)';
const scoreBg    = s => s>=61?'var(--color-green-dim)':s>=31?'var(--color-yellow-dim)':'var(--color-red-dim)';
const latColor   = ms => ms===0?'var(--color-green)':ms<80?'var(--color-green)':ms<400?'var(--color-yellow)':'var(--color-red)';
const latLabel   = ms => ms===0?'WS':`${ms}ms`;

const ALL_EXCHANGES = ['Binance','Kraken','Bybit','OKX','Coinbase'];

// ─── Sub-components ───────────────────────────────────────────────────────
function StatusBadge({ viable, circuitBreaker, rejectionReason }) {
  if (viable) return <span style={{ background:'var(--color-green-dim)', color:'var(--color-green)', fontWeight:700, fontSize:10, padding:'2px 8px', borderRadius:99, letterSpacing:'0.04em', whiteSpace:'nowrap' }}>⚡ VIABLE</span>;
  if (circuitBreaker) return <span style={{ background:'var(--color-yellow-dim)', color:'var(--color-yellow)', fontWeight:700, fontSize:10, padding:'2px 8px', borderRadius:99, whiteSpace:'nowrap' }}>⛔ CB</span>;
  return <span style={{ background:'var(--color-red-dim)', color:'var(--color-red)', fontWeight:700, fontSize:10, padding:'2px 8px', borderRadius:99, whiteSpace:'nowrap' }} title={rejectionReason}>✗ NO VIABLE</span>;
}
function ScoreBadge({ score }) {
  if (!score) return null;
  return <span style={{ background:scoreBg(score), color:scoreColor(score), fontWeight:800, fontSize:10, padding:'2px 8px', borderRadius:99, fontFamily:'var(--font-mono)', minWidth:42, textAlign:'center', display:'inline-block' }}>{score}/100</span>;
}
function WsBadge({ on }) {
  return <span style={{ background:on?'rgba(0,82,255,0.08)':'transparent', color:on?'#0052FF':'var(--text-dim)', fontWeight:700, fontSize:9, padding:'1px 5px', borderRadius:4, border:`1px solid ${on?'rgba(0,82,255,0.25)':'var(--border)'}`, letterSpacing:'0.05em' }}>{on?'WS':'HTTP'}</span>;
}
function SlippageBadge({ method }) {
  if (!method) return null;
  const isReal    = method === 'real';
  const isPartial = method === 'partial';
  const label     = isReal ? 'VWAP L2' : isPartial ? 'VWAP ½' : 'est.';
  const color     = isReal ? 'var(--color-green)' : isPartial ? 'var(--color-yellow)' : 'var(--text-dim)';
  const bg        = isReal ? 'var(--color-green-dim)' : isPartial ? 'var(--color-yellow-dim)' : 'var(--bg-surface-2)';
  return (
    <span title={isReal ? 'Slippage calculado desde L2 VWAP real del order book' : isPartial ? 'Un leg con VWAP real, otro con fallback 0.05%' : 'Fallback fijo 0.05% (sin depth data)'}
      style={{ background:bg, color, fontWeight:700, fontSize:8, padding:'1px 5px', borderRadius:3, border:`1px solid ${color}44`, letterSpacing:'0.05em', whiteSpace:'nowrap' }}>
      {label}
    </span>
  );
}
function ExDot({ name }) {
  const color = EX_COLORS_DARK[name] || '#999';
  return <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}><span style={{ width:8, height:8, borderRadius:'50%', background:color, flexShrink:0, border:name==='OKX'?'1px solid #555':'none' }}/><span>{name}</span></span>;
}
function Card({ children, style }) {
  return <div style={{ background:'var(--bg-surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', boxShadow:'var(--shadow-card)', ...style }}>{children}</div>;
}
function SectionTitle({ children, right }) {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 18px', borderBottom:'1px solid var(--border)' }}>
      <span style={{ fontWeight:800, fontSize:13, color:'var(--text)', letterSpacing:'-0.01em' }}>{children}</span>
      {right && <div style={{ display:'flex', alignItems:'center', gap:8 }}>{right}</div>}
    </div>
  );
}
function ScoreBar({ score }) {
  return <div style={{ width:60, height:5, background:'var(--border)', borderRadius:3, overflow:'hidden', display:'inline-block', verticalAlign:'middle', marginRight:4 }}><div style={{ width:`${score||0}%`, height:'100%', background:scoreColor(score), transition:'width 0.3s' }}/></div>;
}

function TriangularSignalBanner({ signal }) {
  if (!signal) return null;
  return (
    <div style={{ background:'linear-gradient(135deg, rgba(88,65,217,0.12), rgba(88,65,217,0.06))', border:'1px solid rgba(88,65,217,0.30)', borderRadius:'var(--radius)', padding:'10px 16px', display:'flex', alignItems:'center', gap:12, fontSize:12 }}>
      <span style={{display:"inline-flex",alignItems:"center"}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg></span>
      <div style={{ flex:1 }}>
        <span style={{ fontWeight:800, color:'#5741D9' }}>Multi-Leg Signal detectado</span>
        <span style={{ color:'var(--text-muted)', marginLeft:8 }}>{signal.path}</span>
      </div>
      <span style={{ fontFamily:'var(--font-mono)', fontWeight:800, color:'#5741D9', fontSize:13 }}>+{signal.netPct.toFixed(4)}% neto</span>
      <span style={{ fontSize:9, color:'var(--text-dim)', background:'rgba(88,65,217,0.12)', padding:'2px 7px', borderRadius:4, fontWeight:700, letterSpacing:'0.05em' }}>SEÑAL</span>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────
export default function ArbitragePage() {
  const [botOn,        setBotOn]      = useState(true);
  const [minScore,     setMinScore]   = useState(10);
  const [pendingScore, setPending]    = useState(10);
  const [resetting,    setResetting]  = useState(false);
  const [confirmReset, setConfirm]    = useState(false);
  const lastTradeIdRef  = useRef(null);
  const scoreTimeoutRef = useRef(null);

  // Persistent local state for history/equityCurve — only update when payload contains them
  const [localHistory,     setLocalHistory]     = useState([]);
  const [localEquityCurve, setLocalEquityCurve] = useState([]);

  const { data: sseData, connected: sseOk, latencyMs: sseLatency } = useArbitrageStream();
  const { data: pollData } = usePolling(() => fetch('/api/arbitrage/live').then(r=>r.json()), 2000);
  const data = sseData?.orderBooks ? sseData : pollData;

  // Update persistent local state only when payload includes the fields
  useEffect(() => {
    if (data?.history)     setLocalHistory(data.history);
    if (data?.equityCurve) setLocalEquityCurve(data.equityCurve);
  }, [data?.history, data?.equityCurve]);

  useEffect(() => {
    if (data?.minScore != null) { setMinScore(data.minScore); setPending(data.minScore); }
  }, [data?.minScore]);

  const toggleBot = useCallback(async () => {
    const next = !botOn; setBotOn(next);
    try { await fetch('/api/arbitrage/bot',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ enabled:next, score:minScore }) }); } catch {}
  }, [botOn, minScore]);

  const applyScore = useCallback(async (val) => {
    setMinScore(val);
    try { await fetch('/api/arbitrage/bot',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ enabled:botOn, score:val }) }); } catch {}
  }, [botOn]);

  useEffect(() => {
    if (!data?.lastTrade) return;
    const t = data.lastTrade;
    if (t.id === lastTradeIdRef.current) return;
    lastTradeIdRef.current = t.id;
    const p = Number(t.netProfit);
    const slip = t.slippageMethod ? ` [${t.slippageMethod === 'real' ? '⚡VWAP' : 'est'}]` : '';
    if (p >= 0) toast.success(`⚡ ${t.buyExchange}→${t.sellExchange} | +$${p.toFixed(4)}${slip}`, { duration:4000 });
    else        toast.error(`↘ ${t.buyExchange}→${t.sellExchange} | $${p.toFixed(4)}`, { duration:3000 });
  }, [data?.lastTrade?.id]);

  const handleReset = async () => {
    if (!confirmReset) { setConfirm(true); return; }
    setResetting(true);
    try {
      await fetch('/api/arbitrage/reset',{ method:'POST' });
      toast.success('Wallets reiniciadas');
      setLocalHistory([]); setLocalEquityCurve([]);
    }
    catch { toast.error('Error al resetear'); }
    finally { setResetting(false); setConfirm(false); }
  };

  const orderBooks       = data?.orderBooks       || [];
  const opportunities    = data?.opportunities    || [];
  const triangularSignal = data?.triangularSignal || null;
  const wallets          = data?.wallets          || {};
  const pnl              = data?.pnl              || {};
  const wsStatusMap      = data?.wsStatus         || {};
  const history          = localHistory;
  const equityCurve      = localEquityCurve;

  const validBooks  = orderBooks.filter(ob=>ob.bid&&ob.ask);
  const bestBidEx   = validBooks.reduce((b,o)=>(!b||o.bid>b.bid)?o:b,null)?.exchange;
  const bestAskEx   = validBooks.reduce((b,o)=>(!b||o.ask<b.ask)?o:b,null)?.exchange;
  const pnlColor    = (pnl.totalPnl||0)>=0?'var(--color-green)':'var(--color-red)';
  const viableCount = opportunities.filter(o=>o.viable&&o.score>=minScore).length;
  const avgLatency  = (() => {
    const http = validBooks.filter(o=>o.latencyMs>0);
    return http.length ? Math.round(http.reduce((s,o)=>s+o.latencyMs,0)/http.length) : null;
  })();
  const anyWs = Object.values(wsStatusMap).some(Boolean);

  const streakColor = pnl.currentStreakType === 'win' ? 'var(--color-green)' : pnl.currentStreakType === 'loss' ? 'var(--color-red)' : 'var(--text-dim)';
  const streakLabel = pnl.currentStreakType === 'win' ? `▲${pnl.currentStreak}` : pnl.currentStreakType === 'loss' ? `▼${pnl.currentStreak}` : '—';

  // Slippage quality: % of trades with real VWAP slippage
  const slipBreakdown = pnl.slippageMethodBreakdown || {};
  const totalSlip = (slipBreakdown.real || 0) + (slipBreakdown.fallback || 0);
  const realSlipPct = totalSlip > 0 ? Math.round((slipBreakdown.real / totalSlip) * 100) : null;

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16, padding:'0 2px' }}>

      {/* ── HEADER ──────────────────────────────────────────────────────── */}
      <div style={{ display:'flex', alignItems:'center', gap:16, flexWrap:'wrap', background:'var(--bg-surface)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'14px 20px', boxShadow:'var(--shadow-card)' }}>

        <button onClick={toggleBot} style={{ background:botOn?'linear-gradient(135deg,#FF8C42,#FF2D78)':'var(--bg-surface-2)', color:botOn?'#fff':'var(--text-muted)', border:'none', borderRadius:8, padding:'7px 16px', fontWeight:800, fontSize:13, cursor:'pointer', boxShadow:botOn?'0 2px 12px rgba(255,45,120,0.30)':'none', transition:'all 0.2s' }}>
          {botOn ? '▶ BOT ON' : '◎ BOT OFF'}
        </button>
        {botOn && <span style={{ fontSize:11, color:'var(--text-dim)', fontFamily:'var(--font-mono)' }}>↑ {uptime(data?.uptimeMs)}</span>}

        <div style={{ width:1, height:32, background:'var(--border)' }} />

        <div style={{ display:'flex', flexDirection:'column', gap:1 }}>
          <span style={{ fontSize:10, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.06em' }}>P&L Realizado</span>
          <span style={{ fontSize:22, fontWeight:900, color:pnlColor, fontFamily:'var(--font-mono)', lineHeight:1 }}>{(pnl.realizedPnl||pnl.totalPnl||0)>=0?'+':''}{fmtP(pnl.realizedPnl??pnl.totalPnl,4)}</span>
        </div>

        {[
          { label:'Trades',    value: pnl.totalTrades||0 },
          { label:'Win Rate',  value: `${pnl.winRate||0}%` },
          { label:'Viables',   value: viableCount },
          { label:'Drawdown',  value: pnl.maxDrawdown!=null ? `-${pnl.maxDrawdown?.toFixed(1)}%` : '—',
            color: (pnl.maxDrawdown||0) > 5 ? 'var(--color-red)' : (pnl.maxDrawdown||0) > 2 ? 'var(--color-yellow)' : 'var(--color-green)' },
          { label:'Streak',    value: streakLabel, color: streakColor },
          { label:'Avg Exec',  value: pnl.avgExecutionMs ? `${pnl.avgExecutionMs?.toFixed(0)}ms` : '—' },
          ...(realSlipPct !== null ? [{ label:'VWAP Real', value:`${realSlipPct}%`, color: realSlipPct > 70 ? 'var(--color-green)' : realSlipPct > 30 ? 'var(--color-yellow)' : 'var(--color-red)' }] : []),
        ].map(({label,value,color})=>(
          <div key={label} style={{ display:'flex', flexDirection:'column', gap:2 }}>
            <span style={{ fontSize:10, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.06em' }}>{label}</span>
            <span style={{ fontSize:16, fontWeight:800, color:color||'var(--text)', fontFamily:'var(--font-mono)', lineHeight:1 }}>{value}</span>
          </div>
        ))}

        <div style={{ display:'flex', flexDirection:'column', gap:4, minWidth:160 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <span style={{ fontSize:10, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.06em' }}>Min Score</span>
            <span style={{ fontSize:12, fontWeight:800, fontFamily:'var(--font-mono)', color:scoreColor(pendingScore) }}>{pendingScore}</span>
          </div>
          <input type="range" min={0} max={80} step={5} value={pendingScore}
            onChange={e => {
              const val = Number(e.target.value); setPending(val);
              clearTimeout(scoreTimeoutRef.current);
              scoreTimeoutRef.current = setTimeout(() => applyScore(val), 180);
            }}
            style={{ width:'100%', accentColor:'#FF2D78', cursor:'pointer' }}
          />
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:9, color:'var(--text-dim)' }}>
            <span>0 Permisivo</span><span>80 Estricto</span>
          </div>
        </div>

        <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:14, flexWrap:'wrap' }}>
          <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
            <span style={{ fontSize:9, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.05em' }}>WebSockets</span>
            <div style={{ display:'flex', gap:6 }}>
              {['Binance','Kraken','Bybit','OKX'].map(ex => (
                <span key={ex} style={{ display:'flex', alignItems:'center', gap:3, fontSize:10, fontWeight:700 }}>
                  <span style={{ width:6, height:6, borderRadius:'50%', background:wsStatusMap[ex]?'var(--color-green)':'var(--text-dim)', animation:wsStatusMap[ex]?'pulseDot 1.5s ease-in-out infinite':'none' }}/>
                  {ex.slice(0,3)}
                </span>
              ))}
            </div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, fontWeight:700 }}>
            <span style={{ width:7, height:7, borderRadius:'50%', background:sseOk?'#0052FF':'var(--text-dim)', animation:sseOk?'pulseDot 1.5s ease-in-out infinite':'none' }}/>
            <span style={{ color:sseOk?'#0052FF':'var(--text-dim)' }}>{sseOk?`SSE${sseLatency?` ${sseLatency}ms`:''}` : 'Conectando…'}</span>
          </div>
          {avgLatency!=null && <span style={{ fontSize:11, fontFamily:'var(--font-mono)', fontWeight:700, color:latColor(avgLatency) }}>avg {avgLatency}ms</span>}
          <span style={{ fontSize:11, color:'var(--text-dim)', fontFamily:'var(--font-mono)' }}>{data?.ts?ago(data.ts):'—'}</span>
        </div>
      </div>

      {triangularSignal && <TriangularSignalBanner signal={triangularSignal} />}

      {/* ── GRID MEDIO ──────────────────────────────────────────────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'55fr 45fr', gap:16 }}>

        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>

          {/* Order Books */}
          <Card>
            <SectionTitle right={<span style={{ fontSize:10, color:anyWs?'var(--color-green)':'var(--text-dim)', fontWeight:700 }}><span className="pulse-dot" style={{ marginRight:4 }}/>{anyWs?'WS LIVE':'HTTP 1s'}</span>}>
              Live Order Books <span style={{ fontSize:10, fontWeight:400, color:'var(--text-dim)' }}>({validBooks.length}/5 activos)</span>
            </SectionTitle>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead><tr style={{ background:'var(--bg-surface-2)' }}>
                  {['Exchange','Bid','Ask','Spread','Spread%','Latencia','Fuente','Status'].map(h=>(
                    <th key={h} style={{ padding:'8px 10px', textAlign:'left', fontWeight:700, fontSize:10, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.06em', whiteSpace:'nowrap' }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {orderBooks.length===0&&<tr><td colSpan={8} style={{ padding:20, textAlign:'center', color:'var(--text-dim)' }}>Conectando…</td></tr>}
                  {orderBooks.map(ob=>(
                    <tr key={ob.exchange} style={{ borderTop:'1px solid var(--border)', transition:'background 0.1s' }}
                      onMouseEnter={e=>e.currentTarget.style.background='var(--bg-surface-2)'}
                      onMouseLeave={e=>e.currentTarget.style.background=''}>
                      <td style={{ padding:'10px 10px', fontWeight:700 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                          <span style={{ width:8, height:8, borderRadius:'50%', background:EX_COLORS_DARK[ob.exchange]||'#999', border:ob.exchange==='OKX'?'1px solid #555':'none' }}/>
                          {ob.exchange}
                        </div>
                      </td>
                      <td style={{ padding:'10px 10px', fontFamily:'var(--font-mono)', fontWeight:700, color:ob.exchange===bestBidEx?'var(--color-green)':'var(--text)' }}>{ob.error?'—':`$${fmt(ob.bid,2)}`}</td>
                      <td style={{ padding:'10px 10px', fontFamily:'var(--font-mono)', fontWeight:700, color:ob.exchange===bestAskEx?'var(--color-blue)':'var(--text)' }}>{ob.error?'—':`$${fmt(ob.ask,2)}`}</td>
                      <td style={{ padding:'10px 10px', fontFamily:'var(--font-mono)', color:'var(--text-muted)' }}>{ob.error?'—':`$${fmt(ob.spread,2)}`}</td>
                      <td style={{ padding:'10px 10px', fontFamily:'var(--font-mono)', color:'var(--text-muted)' }}>{ob.error?'—':`${ob.spreadPct}%`}</td>
                      <td style={{ padding:'10px 10px', fontFamily:'var(--font-mono)', fontSize:11, color:latColor(ob.latencyMs||0) }}>{latLabel(ob.latencyMs||0)}</td>
                      <td style={{ padding:'10px 10px' }}><WsBadge on={ob.source==='ws'}/></td>
                      <td style={{ padding:'10px 10px' }}>{ob.error?<span style={{ color:'var(--color-red)', fontSize:10 }}>✗ {ob.error.slice(0,18)}</span>:<span style={{ color:'var(--color-green)', fontSize:10, fontWeight:700 }}>✓ OK</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Opportunities */}
          <Card>
            <SectionTitle right={viableCount>0?<span style={{ color:'var(--color-green)', fontWeight:700, fontSize:10 }}>⚡ {viableCount} viable{viableCount!==1?'s':''} (score≥{minScore})</span>:<span style={{ fontSize:10, color:'var(--text-dim)' }}>Escaneando…</span>}>
              Oportunidades detectadas
            </SectionTitle>
            <div style={{ padding:'12px', display:'flex', flexDirection:'column', gap:8 }}>
              {opportunities.length===0&&<div style={{ padding:20, textAlign:'center', color:'var(--text-dim)' }}>Analizando mercados…</div>}
              {opportunities.slice(0,8).map((op,i)=>(
                <div key={op.id||i} style={{ padding:'11px 13px', background:op.viable?'var(--color-green-dim)':op.circuitBreaker?'var(--color-yellow-dim)':'var(--bg-surface-2)', border:`1px solid ${op.viable?'rgba(0,184,122,0.20)':op.circuitBreaker?'rgba(245,158,11,0.20)':'var(--border)'}`, borderRadius:'var(--radius)', display:'flex', flexDirection:'column', gap:6, opacity:op.viable&&op.score<minScore?0.5:1 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                    <StatusBadge {...op}/>
                    {op.viable&&<ScoreBadge score={op.score}/>}
                    {op.slippageMethod && <SlippageBadge method={op.slippageMethod}/>}
                    {op.viable&&op.score<minScore&&<span style={{ fontSize:9, color:'var(--text-dim)', fontStyle:'italic' }}>bajo umbral</span>}
                    <span style={{ fontSize:12, fontWeight:700 }}>
                      <span style={{ color:EX_COLORS_DARK[op.buyExchange]||'#aaa' }}>COMPRAR</span> en {op.buyExchange} <span style={{ fontFamily:'var(--font-mono)' }}>${fmt(op.buyPrice)}</span>
                      <span style={{ color:'var(--text-dim)', margin:'0 5px' }}>→</span>
                      <span style={{ color:EX_COLORS_DARK[op.sellExchange]||'#aaa' }}>VENDER</span> en {op.sellExchange} <span style={{ fontFamily:'var(--font-mono)' }}>${fmt(op.sellPrice)}</span>
                    </span>
                    <div style={{ marginLeft:'auto', display:'flex', flexDirection:'column', alignItems:'flex-end', gap:2 }}>
                      <span style={{ fontFamily:'var(--font-mono)', fontWeight:800, fontSize:12, color:op.netProfit>0?'var(--color-green)':'var(--color-red)' }}>
                        {op.netProfit>0?'+':''}{fmtP(op.netProfit,4)} ({fmtPct(op.netProfitPct)})
                      </span>
                      {op.profitLow!=null&&op.viable&&(
                        <span style={{ fontSize:9, color:'var(--text-dim)', fontFamily:'var(--font-mono)' }}>
                          95% CI [{fmtP(op.profitLow,3)}, {fmtP(op.profitHigh,3)}]
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display:'flex', gap:12, fontSize:10, color:'var(--text-dim)', flexWrap:'wrap', alignItems:'center' }}>
                    <span>Gross: <span style={{ fontFamily:'var(--font-mono)', color:'var(--text-muted)' }}>${fmt(op.grossProfit,4)}</span></span>
                    <span>Fees: <span style={{ fontFamily:'var(--font-mono)', color:'var(--color-red)' }}>-${fmt(op.totalFees||(op.buyFee||0)+(op.sellFee||0),4)}</span></span>
                    <span>Slip: <span style={{ fontFamily:'var(--font-mono)' }}>{op.slippagePct?.toFixed(4)||'—'}%</span> <span style={{ fontFamily:'var(--font-mono)', color:'var(--color-red)', marginLeft:2 }}>-${fmt(op.slippage||op.slippage,4)}</span></span>
                    <span>Retiro: <span style={{ fontFamily:'var(--font-mono)', color:'var(--color-red)' }}>-${fmt(op.withdrawalFeeUSD,4)}</span></span>
                    <span>Spread: <span style={{ fontFamily:'var(--font-mono)' }}>{op.spreadPct?.toFixed(3)||'—'}%</span></span>
                    <span>Lat: <span style={{ fontFamily:'var(--font-mono)', color:latColor((op.buyLatency||0)+(op.sellLatency||0)) }}>{(op.buyLatency||0)+(op.sellLatency||0)}ms</span></span>
                    {op.viable&&<ScoreBar score={op.score}/>}
                    {!op.liquidityOk&&<span style={{ color:'var(--color-yellow)', fontWeight:700 }}>⚠ Liquidez</span>}
                    {op.rejectionReason&&<span style={{ color:'var(--color-red)' }}>↳ {op.rejectionReason?.slice(0,60)}</span>}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div style={{ display:'flex', flexDirection:'column', gap:16 }}>

          {/* Equity Curve */}
          <Card style={{ paddingBottom:12 }}>
            <SectionTitle right={
              equityCurve.length>0&&(
                <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:2 }}>
                  <span style={{ fontSize:11, fontFamily:'var(--font-mono)', fontWeight:700, color:(equityCurve[equityCurve.length-1]?.pnl||0)>=0?'var(--color-green)':'var(--color-red)' }}>
                    {(equityCurve[equityCurve.length-1]?.pnl||0)>=0?'+':''}${(equityCurve[equityCurve.length-1]?.pnl||0).toFixed(4)}
                  </span>
                  {pnl.maxDrawdown>0&&(
                    <span style={{ fontSize:9, color:'var(--color-red)', fontFamily:'var(--font-mono)' }}>
                      max DD -{pnl.maxDrawdown?.toFixed(2)}%
                    </span>
                  )}
                </div>
              )
            }>
              Equity Curve <span style={{ fontSize:10, fontWeight:400, color:'var(--text-dim)' }}>({equityCurve.length} trades)</span>
            </SectionTitle>
            <div style={{ padding:'12px 8px 0' }}>
              {equityCurve.length<2?(
                <div style={{ height:155, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-dim)', fontSize:12 }}>Esperando trades…</div>
              ):(
                <ResponsiveContainer width="100%" height={155}>
                  <LineChart data={equityCurve} margin={{ top:4, right:12, left:0, bottom:0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                    <XAxis dataKey="label" tick={{ fontSize:8, fill:'var(--text-dim)' }} interval="preserveStartEnd"/>
                    <YAxis tick={{ fontSize:9, fill:'var(--text-dim)' }} tickFormatter={v=>`$${v.toFixed(2)}`} width={54}/>
                    <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="4 2"/>
                    <Tooltip contentStyle={{ background:'var(--bg-surface)', border:'1px solid var(--border)', borderRadius:8, fontSize:11 }} formatter={(v,n)=>[`$${Number(v).toFixed(4)}`, n==='pnl'?'P&L acum.':'Trade']}/>
                    <Line type="monotone" dataKey="pnl" stroke="#FF2D78" strokeWidth={2} dot={{ r:2, fill:'#FF2D78' }} isAnimationActive={false}/>
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>

          {/* Latency heatmap */}
          <Card>
            <SectionTitle>Latencia & Fuente</SectionTitle>
            <div style={{ padding:'12px 16px', display:'flex', flexDirection:'column', gap:10 }}>
              {orderBooks.filter(ob=>!ob.error).map(ob=>{
                const pct = ob.source==='ws'?100:Math.max(5,Math.min(100,100-(ob.latencyMs/20)));
                return (
                  <div key={ob.exchange} style={{ display:'flex', alignItems:'center', gap:10 }}>
                    <div style={{ width:70, fontSize:11, fontWeight:700, display:'flex', alignItems:'center', gap:5 }}>
                      <span style={{ width:7, height:7, borderRadius:'50%', background:EX_COLORS_DARK[ob.exchange]||'#999', border:ob.exchange==='OKX'?'1px solid #555':'none' }}/>
                      {ob.exchange.slice(0,7)}
                    </div>
                    <div style={{ flex:1, height:8, background:'var(--border)', borderRadius:4, overflow:'hidden' }}>
                      <div style={{ width:`${pct}%`, height:'100%', background:latColor(ob.latencyMs||0), transition:'width 0.4s' }}/>
                    </div>
                    <span style={{ fontSize:11, fontFamily:'var(--font-mono)', fontWeight:700, color:latColor(ob.latencyMs||0), minWidth:36, textAlign:'right' }}>{latLabel(ob.latencyMs||0)}</span>
                    <WsBadge on={ob.source==='ws'}/>
                  </div>
                );
              })}
              {orderBooks.filter(ob=>!ob.error).length===0&&<div style={{ fontSize:12, color:'var(--text-dim)', padding:'6px 0' }}>Conectando…</div>}
            </div>
          </Card>

          {/* Wallets */}
          <Card>
            <SectionTitle right={
              <button onClick={handleReset} disabled={resetting} style={{ background:confirmReset?'var(--color-red-dim)':'var(--bg-surface-2)', color:confirmReset?'var(--color-red)':'var(--text-muted)', border:`1px solid ${confirmReset?'rgba(240,62,62,0.25)':'var(--border)'}`, borderRadius:6, padding:'4px 10px', fontSize:11, fontWeight:700, cursor:'pointer', transition:'all 0.15s' }} onBlur={()=>setConfirm(false)}>
                {confirmReset?'⚠ Confirmar':'↺ Reset'}
              </button>
            }>Wallets</SectionTitle>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead><tr style={{ background:'var(--bg-surface-2)' }}>
                  {['Exchange','BTC','USDT'].map(h=><th key={h} style={{ padding:'7px 12px', textAlign:h==='Exchange'?'left':'right', fontWeight:700, fontSize:10, color:'var(--text-dim)', textTransform:'uppercase' }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {ALL_EXCHANGES.map(ex=>(
                    <tr key={ex} style={{ borderTop:'1px solid var(--border)' }}>
                      <td style={{ padding:'9px 12px', fontWeight:700 }}><ExDot name={ex}/></td>
                      <td style={{ padding:'9px 12px', textAlign:'right', fontFamily:'var(--font-mono)' }}>{fmt(wallets.BTC?.[ex],6)}</td>
                      <td style={{ padding:'9px 12px', textAlign:'right', fontFamily:'var(--font-mono)' }}>{wallets.USDT?.[ex]!=null?`$${fmt(wallets.USDT[ex],2)}`:'—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(pnl.totalFees||0) > 0 && (
              <div style={{ padding:'8px 14px', borderTop:'1px solid var(--border)', display:'flex', justifyContent:'space-between', flexWrap:'wrap', gap:8, fontSize:11, color:'var(--text-dim)' }}>
                <span>Fees trading: <span style={{ fontFamily:'var(--font-mono)', color:'var(--color-red)' }}>-${fmt(pnl.totalFees,4)}</span></span>
                {(pnl.totalWithdrawalFees||0)>0&&<span>Fees retiro: <span style={{ fontFamily:'var(--font-mono)', color:'var(--color-red)' }}>-${fmt(pnl.totalWithdrawalFees,4)}</span></span>}
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* ── HISTORIAL ───────────────────────────────────────────────────── */}
      <Card>
        <SectionTitle right={
          <div style={{ display:'flex', gap:12, alignItems:'center' }}>
            {pnl.avgNetProfitPct != null && pnl.totalTrades > 0 && (
              <span style={{ fontSize:11, color:'var(--text-dim)', fontFamily:'var(--font-mono)' }}>
                avg/trade: <span style={{ color:(pnl.avgNetProfitPct||0)>=0?'var(--color-green)':'var(--color-red)', fontWeight:700 }}>{(pnl.avgNetProfitPct||0)>=0?'+':''}{(pnl.avgNetProfitPct||0).toFixed(4)}%</span>
              </span>
            )}
            <span style={{ fontSize:11, color:'var(--text-dim)' }}>Últimas {history.length} ops</span>
          </div>
        }>
          Historial de Trades
        </SectionTitle>
        <div style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
            <thead><tr style={{ background:'var(--bg-surface-2)' }}>
              {['#','Hora','Buy','Buy $','Sell','Sell $','BTC','Fees','Retiro','Slip%','Slip Método','Score','Neto','Status'].map((h,i)=>(
                <th key={i} style={{ padding:'8px 9px', textAlign:'left', fontWeight:700, fontSize:9, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.05em', whiteSpace:'nowrap' }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {history.length===0&&<tr><td colSpan={14} style={{ padding:20, textAlign:'center', color:'var(--text-dim)' }}>Sin trades. Activa el bot.</td></tr>}
              {history.map((t,i)=>(
                <tr key={t.id||i} style={{ borderTop:'1px solid var(--border)', transition:'background 0.1s' }} onMouseEnter={e=>e.currentTarget.style.background='var(--bg-surface-2)'} onMouseLeave={e=>e.currentTarget.style.background=''}>
                  <td style={{ padding:'7px 9px', color:'var(--text-dim)', fontWeight:600 }}>{i+1}</td>
                  <td style={{ padding:'7px 9px', fontFamily:'var(--font-mono)', color:'var(--text-muted)', whiteSpace:'nowrap' }}>{t.ts?new Date(t.ts).toLocaleTimeString('es-MX',{hour12:false}):'—'}</td>
                  <td style={{ padding:'7px 9px', fontWeight:700 }}><ExDot name={t.buyExchange}/></td>
                  <td style={{ padding:'7px 9px', fontFamily:'var(--font-mono)' }}>${fmt(t.buyPrice)}</td>
                  <td style={{ padding:'7px 9px', fontWeight:700 }}><ExDot name={t.sellExchange}/></td>
                  <td style={{ padding:'7px 9px', fontFamily:'var(--font-mono)' }}>${fmt(t.sellPrice)}</td>
                  <td style={{ padding:'7px 9px', fontFamily:'var(--font-mono)' }}>{fmt(t.amount,4)}{t.partialFill&&<span style={{ marginLeft:3, fontSize:8, color:'var(--color-yellow)', fontWeight:700 }}>P</span>}</td>
                  <td style={{ padding:'7px 9px', fontFamily:'var(--font-mono)', color:'var(--color-red)' }}>-${fmt(t.totalFees||(t.buyFee||0)+(t.sellFee||0),4)}</td>
                  <td style={{ padding:'7px 9px', fontFamily:'var(--font-mono)', color:'var(--color-red)', fontSize:10 }}>{t.withdrawalFees?`-$${fmt(t.withdrawalFees,2)}`:'—'}</td>
                  <td style={{ padding:'7px 9px', fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-dim)' }}>{t.slippagePct!=null?`${Number(t.slippagePct).toFixed(4)}%`:'—'}</td>
                  <td style={{ padding:'7px 9px' }}>{t.slippageMethod&&<SlippageBadge method={t.slippageMethod}/>}</td>
                  <td style={{ padding:'7px 9px' }}>{t.score!=null&&<span style={{ background:scoreBg(t.score), color:scoreColor(t.score), fontWeight:800, fontSize:9, padding:'1px 5px', borderRadius:4, fontFamily:'var(--font-mono)' }}>{t.score}</span>}</td>
                  <td style={{ padding:'7px 9px', fontFamily:'var(--font-mono)', fontWeight:800, color:(t.netProfit||0)>=0?'var(--color-green)':'var(--color-red)' }}>{(t.netProfit||0)>=0?'+':''}{fmtP(t.netProfit,4)}</td>
                  <td style={{ padding:'7px 9px' }}><span style={{ background:t.status==='profit'?'var(--color-green-dim)':'var(--color-red-dim)', color:t.status==='profit'?'var(--color-green)':'var(--color-red)', fontWeight:700, fontSize:9, padding:'2px 6px', borderRadius:99 }}>{t.status==='profit'?'▲ WIN':'▼ LOSS'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <style>{`
        @keyframes pulse-bg { 0%{opacity:0.7}50%{opacity:1}100%{opacity:0.7} }
        .pulse-dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--color-green); animation:pulseDot 1.5s ease-in-out infinite; }
        @keyframes pulseDot { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.5;transform:scale(0.8)} }
      `}</style>
    </div>
  );
}
/**
 * ArbitragePage.jsx — kukora arbitrage bot v6
 * "Oportunidades Detectadas" como elemento hero principal.
 * Progressive disclosure: hero → métricas → detalles técnicos.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { useArbitrageStream } from '../hooks/useArbitrageStream';
import toast from 'react-hot-toast';
import ExecutiveDashboard from '../components/common/ExecutiveDashboard';
import LifecyclePanel from '../components/common/LifecyclePanel';
import IntelligencePanel from '../components/common/IntelligencePanel';
import TradeAuditModal from '../components/common/TradeAuditModal';

const fmt    = (n, d=2)  => (n==null||isNaN(n)) ? '—' : Number(n).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtP   = (n, d=4)  => (n==null||isNaN(n)) ? '—' : `$${Number(n).toFixed(d)}`;
const fmtPct = n          => (n==null||isNaN(n)) ? '—' : `${Number(n).toFixed(4)}%`;
const ago = ts => {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 2) return 'ahora'; if (s < 60) return `${s}s`; return `${Math.floor(s/60)}m`;
};

const translateRejection = (reason) => {
  if (!reason) return null;
  if (reason.includes('Liquidez') || reason.includes('Liquidity')) return 'Liquidez insuficiente';
  if (reason.includes('Spread') && reason.includes('<')) return 'Spread bajo umbral';
  if (reason.includes('Spread') && reason.includes('>')) return 'Feed lento';
  if (reason.includes('Net') || reason.includes('mínimo')) return 'Fees > spread';
  if (reason.includes('Precio de compra')) return 'Precio compra ≥ venta';
  if (reason.includes('Circuit') || reason.includes('circuit')) return 'Circuit breaker';
  if (reason.includes('Saldo')) return 'Saldo insuficiente';
  if (reason.includes('Coinbase')) return 'Coinbase fee 0.60%';
  return reason.slice(0, 45);
};

const uptime = ms => {
  if (!ms) return '—';
  const s=Math.floor(ms/1000), m=Math.floor(s/60), h=Math.floor(m/60);
  if (h>0) return `${h}h ${m%60}m`; if (m>0) return `${m}m ${s%60}s`; return `${s}s`;
};

const EX_COLORS = { Binance:'#F0B90B', Kraken:'#5741D9', Bybit:'#F7A600', Coinbase:'#0052FF', OKX:'#aaa' };
const scoreColor = s => s>=61?'var(--color-green)':s>=31?'var(--color-yellow)':'var(--color-red)';
const latColor   = ms => ms===0?'var(--color-green)':ms<80?'var(--color-green)':ms<400?'var(--color-yellow)':'var(--color-red)';
const latLabel   = ms => ms===0?'WS':`${ms}ms`;
const ALL_EXCHANGES = ['Binance','Kraken','Bybit','OKX','Coinbase'];

// ─── Shared components ────────────────────────────────────────────────────
function Card({ children, style, glow, glass }) {
  return (
    <div className={glass ? 'card-glass' : 'card'} style={{
      ...style,
      borderColor: glow ? 'rgba(0,184,122,0.40)' : 'var(--border)',
      boxShadow: glow ? '0 0 24px rgba(0,184,122,0.12), 0 4px 12px rgba(0,0,0,0.03)' : undefined,
    }}>{children}</div>
  );
}
function SectionTitle({ children, right, sub }) {
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
function ExDot({ name, size=8 }) {
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}>
      <span style={{ width:size, height:size, borderRadius:'50%', background:EX_COLORS[name]||'#999', flexShrink:0 }}/>
      <span>{name}</span>
    </span>
  );
}
function SlippageBadge({ method }) {
  if (!method) return null;
  const isReal = method==='real', isPartial = method==='partial';
  const label = isReal?'VWAP L2':isPartial?'VWAP ½':'est.';
  const color = isReal?'var(--color-green)':isPartial?'var(--color-yellow)':'var(--text-dim)';
  return (
    <span title={isReal?'Slippage calculado desde L2 VWAP real':isPartial?'Un leg VWAP, otro fallback':'Fallback fijo 0.05%'}
      style={{ background:`${color}20`, color, fontWeight:700, fontSize:8, padding:'1px 5px', borderRadius:3, border:`1px solid ${color}44`, whiteSpace:'nowrap' }}>
      {label}
    </span>
  );
}
function WsBadge({ on }) {
  return (
    <span style={{ background:on?'rgba(0,82,255,0.08)':'transparent', color:on?'#0052FF':'var(--text-dim)', fontWeight:700, fontSize:9, padding:'1px 5px', borderRadius:4, border:`1px solid ${on?'rgba(0,82,255,0.25)':'var(--border)'}` }}>
      {on?'WS':'HTTP'}
    </span>
  );
}

// ─── Hero Opportunity Card ─────────────────────────────────────────────────
function OpportunityHero({ op, minScore, rank }) {
  const isViable = op.viable && op.score >= minScore;
  const isSynthetic = op.synthetic;

  const borderColor = isViable
    ? (isSynthetic ? 'rgba(255,200,0,0.5)' : 'rgba(0,184,122,0.50)')
    : op.circuitBreaker ? 'rgba(245,158,11,0.30)' : 'var(--border)';
  const bgGradient = isViable
    ? (isSynthetic
        ? 'linear-gradient(135deg, rgba(255,200,0,0.06), rgba(255,140,0,0.03))'
        : 'linear-gradient(135deg, rgba(0,184,122,0.07), rgba(0,184,122,0.02))')
    : 'var(--bg-surface-2)';

  return (
    <div style={{
      padding: '14px 16px',
      background: bgGradient,
      border: `1px solid ${borderColor}`,
      borderRadius: 12,
      opacity: op.viable && op.score < minScore ? 0.5 : 1,
      position: 'relative',
    }}>
      {/* Rank badge */}
      {rank <= 3 && isViable && (
        <div style={{ position:'absolute', top:-6, left:12, background: rank===1?'#FF2D78':rank===2?'#5741D9':'#F59E0B', color:'#fff', fontSize:9, fontWeight:900, padding:'2px 8px', borderRadius:99 }}>
          #{rank} VIABLE
        </div>
      )}

      {/* Row 1: Status + pair + profit */}
      <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', marginTop: rank<=3&&isViable ? 6 : 0 }}>
        {/* Status pill */}
        {isViable ? (
          <span style={{ background: isSynthetic?'rgba(255,200,0,0.15)':'rgba(0,184,122,0.12)', color: isSynthetic?'#F59E0B':'var(--color-green)', fontWeight:800, fontSize:11, padding:'3px 10px', borderRadius:99, border:`1px solid ${isSynthetic?'rgba(255,200,0,0.3)':'rgba(0,184,122,0.3)'}`, whiteSpace:'nowrap', letterSpacing:'0.02em' }}>
            {isSynthetic ? '🎬 DEMO' : '⚡ VIABLE'}
          </span>
        ) : op.circuitBreaker ? (
          <span style={{ background:'rgba(245,158,11,0.10)', color:'#F59E0B', fontWeight:800, fontSize:11, padding:'3px 10px', borderRadius:99 }}>⛔ CIRCUIT BREAKER</span>
        ) : (
          <span style={{ background:'var(--color-red-dim)', color:'var(--color-red)', fontWeight:700, fontSize:11, padding:'3px 10px', borderRadius:99, maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={op.rejectionReason}>
            ✗ {translateRejection(op.rejectionReason) || 'RECHAZADO'}
          </span>
        )}

        {/* Score */}
        {op.viable && (
          <span style={{ background:`${scoreColor(op.score)}18`, color:scoreColor(op.score), fontWeight:900, fontSize:12, padding:'3px 10px', borderRadius:6, fontFamily:'var(--font-mono)', border:`1px solid ${scoreColor(op.score)}33` }}>
            {op.score}/100
          </span>
        )}

        <SlippageBadge method={op.slippageMethod} />

        {/* Trade direction */}
        <span style={{ fontSize:13, fontWeight:700, flex:1 }}>
          <span style={{ color:EX_COLORS[op.buyExchange]||'#aaa' }}>COMPRA</span>
          <span style={{ fontFamily:'var(--font-mono)', fontWeight:800 }}> ${fmt(op.buyPrice)} </span>
          <span style={{ color:'var(--text-dim)' }}>→</span>
          <span style={{ color:EX_COLORS[op.sellExchange]||'#aaa' }}> VENDE</span>
          <span style={{ fontFamily:'var(--font-mono)', fontWeight:800 }}> ${fmt(op.sellPrice)}</span>
        </span>

        {/* Net profit — biggest number */}
        <div style={{ marginLeft:'auto', textAlign:'right' }}>
          <div style={{ fontFamily:'var(--font-mono)', fontWeight:900, fontSize:16, color: op.netProfit>0?'var(--color-green)':'var(--color-red)', lineHeight:1 }}>
            {op.netProfit>0?'+':''}{fmtP(op.netProfit,4)}
          </div>
          <div style={{ fontSize:10, color:'var(--text-dim)', fontFamily:'var(--font-mono)' }}>{fmtPct(op.netProfitPct)}</div>
          {op.profitLow!=null && op.viable && (
            <div style={{ fontSize:8, color:'var(--text-dim)', fontFamily:'var(--font-mono)' }}>95% CI [{fmtP(op.profitLow,2)}, {fmtP(op.profitHigh,2)}]</div>
          )}
        </div>
      </div>

      {/* Row 2: exchange names + fee breakdown */}
      <div style={{ display:'flex', gap:10, marginTop:8, flexWrap:'wrap', alignItems:'center', fontSize:11 }}>
        <ExDot name={op.buyExchange} />
        <span style={{ color:'var(--text-dim)' }}>→</span>
        <ExDot name={op.sellExchange} />
        <span style={{ color:'var(--border)', margin:'0 2px' }}>|</span>
        <span style={{ color:'var(--text-dim)' }}>Bruto: <span style={{ fontFamily:'var(--font-mono)', color:'var(--text-muted)' }}>${fmt(op.grossProfit,4)}</span></span>
        <span style={{ color:'var(--text-dim)' }}>Fees: <span style={{ fontFamily:'var(--font-mono)', color:'var(--color-red)' }}>-${fmt((op.buyFee||0)+(op.sellFee||0),4)}</span></span>
        <span style={{ color:'var(--text-dim)' }}>Slip: <span style={{ fontFamily:'var(--font-mono)', color:'var(--color-red)' }}>-${fmt(op.slippage,4)}</span></span>
        <span style={{ color:'var(--text-dim)' }}>Spread: <span style={{ fontFamily:'var(--font-mono)' }}>{op.spreadPct?.toFixed(3)||'—'}%</span></span>
        {op.breakEvenPct != null && (
          <span title="Spread mínimo para cubrir fees + slippage (break-even real, sin margen de ganancia)" style={{ color:'var(--text-dim)' }}>
            Break-even: <span style={{ fontFamily:'var(--font-mono)', color:'var(--color-yellow)' }}>{op.breakEvenPct}%</span>
          </span>
        )}
        {op.viabilityThresholdPct != null && (
          <span title="Spread mínimo para cubrir fees + slippage + umbral de ganancia mínima" style={{ color:'var(--text-dim)' }}>
            Umbral viable: <span style={{ fontFamily:'var(--font-mono)', color:'rgba(245,158,11,0.8)' }}>{op.viabilityThresholdPct}%</span>
          </span>
        )}
        {op.fillProbability != null && (
          <span title="Probabilidad de ejecución completa" style={{ color:'var(--text-dim)' }}>
            P(fill): <span style={{ fontFamily:'var(--font-mono)', fontWeight:800, color: op.fillProbability>=80?'var(--color-green)':op.fillProbability>=50?'var(--color-yellow)':'var(--color-red)' }}>{op.fillProbability}%</span>
          </span>
        )}
        {op.viable && op.recommendedSize != null && (
          <span style={{ color:'var(--color-green)', fontWeight:700 }}>Rec: <span style={{ fontFamily:'var(--font-mono)' }}>{op.recommendedSize} BTC</span></span>
        )}
        {!op.viable && op.rejectionReason && (
          <span style={{ color:'var(--color-red)', fontSize:10, fontStyle:'italic', maxWidth:300, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={op.rejectionReason}>
            {translateRejection(op.rejectionReason)}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Scanning animation when no trades yet ────────────────────────────────
function ScanningPulse({ opportunitiesScanned, nearViableCount, bestOpportunitySeen }) {
  const [dots, setDots] = useState('.');
  useEffect(() => {
    const id = setInterval(() => setDots(d => d.length >= 3 ? '.' : d + '.'), 500);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ padding: '32px 24px', textAlign: 'center' }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', marginBottom: 6 }}>
        Escaneando mercados{dots}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 20 }}>
        Analizando spreads entre 5 exchanges en tiempo real
      </div>
      {opportunitiesScanned > 0 && (
        <div style={{ display: 'flex', gap: 24, justifyContent: 'center', flexWrap: 'wrap' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 24, fontWeight: 900, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{opportunitiesScanned.toLocaleString()}</div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>pares analizados</div>
          </div>
          {nearViableCount > 0 && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 24, fontWeight: 900, fontFamily: 'var(--font-mono)', color: 'var(--color-yellow)' }}>{nearViableCount}</div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>cerca de viable</div>
            </div>
          )}
          {bestOpportunitySeen && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 24, fontWeight: 900, fontFamily: 'var(--font-mono)', color: bestOpportunitySeen.netProfit>0?'var(--color-green)':'var(--color-yellow)' }}>
                {bestOpportunitySeen.netProfit>=0?'+':''}{bestOpportunitySeen.netProfit.toFixed(3)}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>mejor spread visto $</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────
export default function ArbitragePage() {
  const [botOn,        setBotOn]    = useState(true);
  const [minScore,     setMinScore] = useState(10);
  const [pendingScore, setPending]  = useState(10);
  const [resetting,    setResetting]= useState(false);
  const [confirmReset, setConfirm]  = useState(false);
  const [activeTab,    setActiveTab]= useState('bot');
  const [selectedTrade, setSelectedTrade] = useState(null);
  const lastTradeIdRef  = useRef(null);
  const scoreTimeoutRef = useRef(null);

  const [localHistory,     setLocalHistory]     = useState([]);
  const [localEquityCurve, setLocalEquityCurve] = useState([]);

  const { data: sseData, connected: sseOk, latencyMs: sseLatency } = useArbitrageStream();
  const data = sseData ?? null;

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
    const synLabel = t.synthetic ? ' [DEMO]' : '';
    if (p >= 0) toast.success(`⚡ ${t.buyExchange}→${t.sellExchange} | +$${p.toFixed(4)}${synLabel}`, { duration:4000 });
    else        toast.error(`↘ ${t.buyExchange}→${t.sellExchange} | $${p.toFixed(4)}`, { duration:3000 });
  }, [data?.lastTrade?.id]);

  useEffect(() => {
    if (data?.type !== 'trade_executed' || !data?.trade) return;
    const t = data.trade;
    if (t.id === lastTradeIdRef.current) return;
    lastTradeIdRef.current = t.id;
    const p = Number(t.netProfit);
    if (p >= 0) toast.success(`⚡ ${t.buyExchange}→${t.sellExchange} | +$${p.toFixed(4)}`, { duration:4000 });
    else        toast.error(`↘ ${t.buyExchange}→${t.sellExchange} | $${p.toFixed(4)}`, { duration:3000 });
  }, [data?.trade?.id, data?.type]);

  const handleReset = async () => {
    if (!confirmReset) { setConfirm(true); return; }
    setResetting(true);
    try {
      await fetch('/api/arbitrage/reset',{ method:'POST' });
      toast.success('Carteras reiniciadas');
      setLocalHistory([]); setLocalEquityCurve([]);
    } catch { toast.error('Error al reiniciar'); }
    finally { setResetting(false); setConfirm(false); }
  };

  const orderBooks        = data?.orderBooks        || [];
  const opportunities     = data?.opportunities     || [];
  const triangularSignal  = data?.triangularSignal  || null;
  const statArbSignals    = data?.statArbSignals    || [];
  const wallets           = data?.wallets           || {};
  const pnl               = data?.pnl              || {};
  const wsStatusMap       = data?.wsStatus          || {};
  const feedFreshness     = data?.feedFreshness     || {};
  const dailyPnl          = data?.dailyPnl          ?? null;
  const dailyLossBreached = data?.dailyLossBreached ?? false;
  const history           = localHistory;
  const equityCurve       = localEquityCurve;

  const opportunitiesScanned = data?.opportunitiesScanned ?? 0;
  const viableFound          = data?.viableFound          ?? 0;
  const rejectionCounts      = data?.rejectionCounts      || {};
  const bestOpportunitySeen  = data?.bestOpportunitySeen  || null;
  const nearViableCount      = data?.nearViableCount      ?? 0;

  const validBooks  = orderBooks.filter(ob=>ob.bid&&ob.ask);
  const bestBidEx   = validBooks.reduce((b,o)=>(!b||o.bid>b.bid)?o:b,null)?.exchange;
  const bestAskEx   = validBooks.reduce((b,o)=>(!b||o.ask<b.ask)?o:b,null)?.exchange;
  const pnlColor    = (pnl.totalPnl||0)>=0?'var(--color-green)':'var(--color-red)';
  const viableCount = opportunities.filter(o=>o.viable&&o.score>=minScore).length;
  const anyWs = Object.values(wsStatusMap).some(Boolean);
  const bestAskPrice = validBooks.length ? validBooks.reduce((best,ob)=>(!best||ob.ask<best)?ob.ask:best,null) : null;
  const capitalDeployed = (() => {
    if (!wallets.BTC||!wallets.USDT||!bestAskPrice) return null;
    const btcVal  = Object.values(wallets.BTC||{}).reduce((s,v)=>s+(v||0),0)*bestAskPrice;
    const usdtVal = Object.values(wallets.USDT||{}).reduce((s,v)=>s+(v||0),0);
    return btcVal+usdtVal;
  })();
  const roi = capitalDeployed>0?((pnl.totalPnl||0)/capitalDeployed)*100:null;
  const totalRejected = Object.values(rejectionCounts).reduce((s,v)=>s+v,0);

  const TABS = [
    { id:'bot',          label:'⍢ Bot en Vivo',         desc:'Oportunidades y motor de arbitraje en tiempo real' },
    { id:'executive',    label:'▣ Executive Dashboard',  desc:'Resumen ejecutivo para evaluadores' },
    { id:'intelligence', label:'◌ Intelligence',         desc:'Rankings, volatilidad, predicciones' },
    { id:'lifecycle',    label:'▥ Lifecycle Analytics',  desc:'Ciclo de vida de oportunidades' },
  ];

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16, padding:'0 2px' }}>
      {selectedTrade && <TradeAuditModal trade={selectedTrade} onClose={() => setSelectedTrade(null)} />}

      {/* ── SYSTEM READY INDICATOR ───────────────────────────────────────── */}
      {/* Shows a warm-up banner until all feeds are live. Green = demo-ready. */}
      {(() => {
        const wsValues = Object.values(wsStatusMap);
        const totalExchanges = wsValues.length || 5;
        const liveExchanges  = wsValues.filter(Boolean).length;
        const staleFeeds     = Object.values(feedFreshness).filter(f => f?.stale).length;
        const allReady       = liveExchanges >= 4 && staleFeeds === 0;
        const partialReady   = liveExchanges >= 2;
        if (allReady) return (
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 14px', background:'rgba(0,184,122,0.08)', border:'1px solid rgba(0,184,122,0.25)', borderRadius:10, fontSize:11 }}>
            <span style={{ width:8, height:8, borderRadius:'50%', background:'var(--color-green)', animation:'pulseDot 1.5s infinite', flexShrink:0 }}/>
            <span style={{ fontWeight:800, color:'var(--color-green)' }}>SISTEMA LISTO</span>
            <span style={{ color:'var(--text-dim)' }}>{liveExchanges}/{totalExchanges} exchanges vivos · Todos los feeds frescos · Motor activo</span>
          </div>
        );
        if (partialReady) return (
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 14px', background:'rgba(245,158,11,0.07)', border:'1px solid rgba(245,158,11,0.25)', borderRadius:10, fontSize:11 }}>
            <span style={{ width:8, height:8, borderRadius:'50%', background:'#F59E0B', animation:'pulseDot 1.5s infinite', flexShrink:0 }}/>
            <span style={{ fontWeight:800, color:'#F59E0B' }}>CALENTANDO</span>
            <span style={{ color:'var(--text-dim)' }}>{liveExchanges}/{totalExchanges} exchanges conectados · Esperando feeds frescos…</span>
          </div>
        );
        return (
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 14px', background:'rgba(255,45,120,0.07)', border:'1px solid rgba(255,45,120,0.20)', borderRadius:10, fontSize:11 }}>
            <span style={{ width:8, height:8, borderRadius:'50%', background:'var(--color-red)', flexShrink:0 }}/>
            <span style={{ fontWeight:800, color:'var(--color-red)' }}>CONECTANDO</span>
            <span style={{ color:'var(--text-dim)' }}>Estableciendo WebSockets con los exchanges…</span>
          </div>
        );
      })()}

      {/* ── TAB BAR — altura fija, nunca hace wrap ───────────────────────── */}
      <div style={{
        display:'flex', alignItems:'center', gap:2,
        background:'var(--bg-surface)', border:'1px solid var(--border)',
        borderRadius:'var(--radius-lg)', padding:'5px 8px',
        flexWrap:'nowrap', overflow:'hidden', minWidth:0,
        height: 46, flexShrink: 0,
      }}>
        {/* Tabs — flex fijo, nunca encogen */}
        <div style={{ display:'flex', gap:2, flexShrink:0 }}>
          {TABS.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} title={tab.desc} style={{
              padding:'6px 14px', borderRadius:8, border:'none', cursor:'pointer',
              fontWeight:700, fontSize:11.5, whiteSpace:'nowrap', flexShrink:0,
              background: activeTab===tab.id ? 'linear-gradient(135deg,rgba(255,45,120,0.15),rgba(88,65,217,0.15))' : 'transparent',
              color: activeTab===tab.id ? 'var(--text)' : 'var(--text-dim)',
              boxShadow: activeTab===tab.id ? 'inset 0 -2px 0 #FF2D78' : 'inset 0 -2px 0 transparent',
              transition:'all 0.15s',
            }}>{tab.label}</button>
          ))}
        </div>

        {/* Spacer */}
        <div style={{ flex:1, minWidth:8 }} />

        {/* WS status pills — ancho fijo total, nunca desborda */}
        <div style={{ display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
          <div style={{ display:'flex', gap:6, alignItems:'center' }}>
            {Object.entries(wsStatusMap).filter(([k])=>k!=='Coinbase').map(([ex,on])=>(
              <span key={ex} style={{
                display:'flex', alignItems:'center', gap:3,
                fontSize:10, fontWeight:700,
                color:on?'var(--color-green)':'var(--text-dim)',
                width:32, // ancho fijo — nunca cambia el layout
              }}>
                <span style={{ width:5, height:5, borderRadius:'50%', flexShrink:0,
                  background:on?'var(--color-green)':'var(--border)',
                  animation:on?'pulseDot 1.5s infinite':'none' }}/>
                {ex.slice(0,3)}
              </span>
            ))}
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:4, fontSize:10, fontWeight:700,
            borderLeft:'1px solid var(--border)', paddingLeft:8 }}>
            <span style={{ width:5, height:5, borderRadius:'50%', flexShrink:0,
              background:sseOk?'#0052FF':'var(--border)',
              animation:sseOk?'pulseDot 1.5s infinite':'none' }}/>
            <span style={{ color:sseOk?'#0052FF':'var(--text-dim)', whiteSpace:'nowrap' }}>
              {sseOk?'SSE':'–'}
            </span>
          </div>
        </div>
      </div>

      {/* ── TABS CONTENT ─────────────────────────────────────────────────── */}
      {activeTab==='executive' && <ExecutiveDashboard data={data} />}
      {activeTab==='intelligence' && <IntelligencePanel data={data} opportunities={opportunities} />}
      {activeTab==='lifecycle' && <LifecyclePanel data={data} />}

      {activeTab==='bot' && (<>

        {/* ── DAILY LOSS BREACHED ──────────────────────────────────────────── */}
        {dailyLossBreached && (
          <div style={{ background:'var(--color-red-dim)', border:'1px solid rgba(240,62,62,0.35)', borderRadius:'var(--radius)', padding:'10px 16px', display:'flex', alignItems:'center', gap:10 }}>
            <span style={{ fontSize:16 }}>🛑</span>
            <strong style={{ color:'var(--color-red)' }}>Circuit Breaker Global — Bot Detenido.</strong>
            <span style={{ color:'var(--text-muted)', fontSize:12, marginLeft:4 }}>Pérdida diaria alcanzó -$500. P&L hoy: {dailyPnl!=null?`$${dailyPnl.toFixed(2)}`:'—'}</span>
          </div>
        )}

        {/* ── HERO: OPORTUNIDADES DETECTADAS ──────────────────────────────── */}
        <Card glow={viableCount > 0} style={{ overflow:'hidden' }}>
          {/* Hero header */}
          <div style={{ padding:'18px 20px 14px', borderBottom:'1px solid var(--border)', background: viableCount>0 ? 'linear-gradient(135deg,rgba(0,184,122,0.05),transparent)' : 'transparent' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
              <div>
                <h2 style={{ margin:0, fontSize:18, fontWeight:900, color:'var(--text)', letterSpacing:'-0.02em' }}>
                  Oportunidades Detectadas
                </h2>
                <div style={{ fontSize:11, color:'var(--text-dim)', marginTop:2 }}>
                  Bot analizando {validBooks.length} exchanges · Event-driven WebSocket · Latencia detección &lt; 30ms
                </div>
              </div>

              {/* Big viable count */}
              {viableCount > 0 ? (
                <div style={{ background:'rgba(0,184,122,0.12)', border:'1px solid rgba(0,184,122,0.35)', borderRadius:12, padding:'8px 20px', textAlign:'center' }}>
                  <div style={{ fontSize:28, fontWeight:900, color:'var(--color-green)', fontFamily:'var(--font-mono)', lineHeight:1 }}>{viableCount}</div>
                  <div style={{ fontSize:10, color:'var(--color-green)', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em' }}>viable{viableCount>1?'s':''}</div>
                </div>
              ) : (
                <div style={{ background:'var(--bg-surface-2)', border:'1px solid var(--border)', borderRadius:12, padding:'8px 20px', textAlign:'center' }}>
                  <div style={{ fontSize:28, fontWeight:900, color:'var(--text-dim)', fontFamily:'var(--font-mono)', lineHeight:1 }}>0</div>
                  <div style={{ fontSize:10, color:'var(--text-dim)', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em' }}>viables</div>
                </div>
              )}

              {/* Scanning stats bar */}
              <div style={{ display:'flex', gap:16, flexWrap:'wrap', alignItems:'center' }}>
                {[
                  { label:'Pares analizados', value:opportunitiesScanned.toLocaleString(), color:'var(--text)' },
                  { label:'Viables (sesión)', value:viableFound.toString(), color:'var(--color-green)' },
                  { label:'Ejecutados',        value:(pnl.totalTrades||0).toString(), color:'var(--color-green)' },
                  { label:'Cerca de viable',   value:nearViableCount.toString(), color:'var(--color-yellow)' },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ textAlign:'center' }}>
                    <div style={{ fontSize:17, fontWeight:900, fontFamily:'var(--font-mono)', color }}>{value}</div>
                    <div style={{ fontSize:9, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:700 }}>{label}</div>
                  </div>
                ))}
              </div>

              {/* Bot controls */}
              <div style={{ marginLeft:'auto', display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
                <div style={{ display:'flex', flexDirection:'column', gap:2, minWidth:130 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'var(--text-dim)', fontWeight:700 }}>
                    <span>Score mínimo</span>
                    <span style={{ color:scoreColor(pendingScore), fontFamily:'var(--font-mono)' }}>{pendingScore}</span>
                  </div>
                  <input type="range" min={0} max={80} step={5} value={pendingScore}
                    onChange={e => {
                      const val = Number(e.target.value); setPending(val);
                      clearTimeout(scoreTimeoutRef.current);
                      scoreTimeoutRef.current = setTimeout(() => applyScore(val), 180);
                    }}
                    style={{ width:'100%', accentColor:'#FF2D78', cursor:'pointer' }}
                  />
                </div>
                <button onClick={toggleBot} style={{
                  background: botOn ? 'linear-gradient(135deg,#FF8C42,#FF2D78)' : 'var(--bg-surface-2)',
                  color: botOn ? '#fff' : 'var(--text-muted)',
                  border: botOn ? 'none' : '1px solid var(--border)',
                  borderRadius:8, padding:'8px 18px', fontWeight:800, fontSize:13, cursor:'pointer',
                  boxShadow: botOn ? '0 2px 12px rgba(255,45,120,0.30)' : 'none',
                  whiteSpace:'nowrap',
                }}>
                  {botOn ? '▶ ACTIVO' : '◎ INACTIVO'}
                </button>
                {botOn && <span style={{ fontSize:10, color:'var(--text-dim)', fontFamily:'var(--font-mono)' }}>↑ {uptime(data?.uptimeMs)}</span>}
              </div>
            </div>

            {/* Rejection breakdown — why nothing is viable */}
            {totalRejected > 0 && viableCount === 0 && (
              <div style={{ display:'flex', gap:10, marginTop:12, flexWrap:'wrap', padding:'8px 0 0' }}>
                <span style={{ fontSize:10, color:'var(--text-dim)', fontWeight:700, alignSelf:'center' }}>Rechazados por:</span>
                {rejectionCounts.fees_slippage > 0 && <span style={{ background:'rgba(240,62,62,0.08)', color:'var(--color-red)', fontSize:10, fontWeight:700, padding:'2px 10px', borderRadius:99, border:'1px solid rgba(240,62,62,0.2)' }}>Fees+Slip: {rejectionCounts.fees_slippage.toLocaleString()}</span>}
                {rejectionCounts.circuit_breaker > 0 && <span style={{ background:'rgba(245,158,11,0.08)', color:'#F59E0B', fontSize:10, fontWeight:700, padding:'2px 10px', borderRadius:99, border:'1px solid rgba(245,158,11,0.2)' }}>Circuit Breaker: {rejectionCounts.circuit_breaker.toLocaleString()}</span>}
                {rejectionCounts.liquidity > 0 && <span style={{ background:'rgba(245,158,11,0.08)', color:'#F59E0B', fontSize:10, fontWeight:700, padding:'2px 10px', borderRadius:99, border:'1px solid rgba(245,158,11,0.2)' }}>Liquidez: {rejectionCounts.liquidity.toLocaleString()}</span>}
                {rejectionCounts.negative_spread > 0 && <span style={{ background:'var(--bg-surface-2)', color:'var(--text-dim)', fontSize:10, fontWeight:700, padding:'2px 10px', borderRadius:99, border:'1px solid var(--border)' }}>Spread−: {rejectionCounts.negative_spread.toLocaleString()}</span>}
                {bestOpportunitySeen && (
                  <span style={{ marginLeft:'auto', fontSize:11, fontFamily:'var(--font-mono)', color:bestOpportunitySeen.netProfit>0?'var(--color-green)':'var(--color-yellow)', fontWeight:700 }}
                    title={`Mejor spread visto: ${bestOpportunitySeen.buyExchange}→${bestOpportunitySeen.sellExchange}`}>
                    Mejor visto: {bestOpportunitySeen.netProfit>=0?'+':''}${bestOpportunitySeen.netProfit.toFixed(4)} ({bestOpportunitySeen.spreadPct}%)
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Opportunity list */}
          <div style={{ padding:'12px', display:'flex', flexDirection:'column', gap:10 }}>
            {opportunities.length === 0 ? (
              <ScanningPulse opportunitiesScanned={opportunitiesScanned} nearViableCount={nearViableCount} bestOpportunitySeen={bestOpportunitySeen} />
            ) : (
              opportunities.slice(0, 10).map((op, i) => (
                <OpportunityHero key={op.id||i} op={op} minScore={minScore} rank={i+1} />
              ))
            )}
          </div>

          {/* Triangular signal */}
          {triangularSignal && (
            <div style={{ margin:'0 12px 12px', background:'linear-gradient(135deg,rgba(88,65,217,0.08),rgba(88,65,217,0.04))', border:'1px solid rgba(88,65,217,0.25)', borderRadius:10, padding:'10px 16px', display:'flex', alignItems:'center', gap:12, fontSize:12 }}>
              <span style={{ fontSize:16, animation:'pulseDot 2s infinite' }}>🔗</span>
              <div style={{ flex:1 }}>
                <span style={{ fontWeight:800, color:'#5741D9', display:'flex', alignItems:'center', gap:6 }}>
                  ESTRATEGIA TRIANGULAR AKTIVA
                  <span style={{ background:'#FF2D78', color:'#fff', fontSize:8, padding:'1px 5px', borderRadius:4 }}>AUTO-EXEC</span>
                </span>
                <span style={{ color:'var(--text-muted)', marginLeft:0, display:'block', fontSize:10 }}>{triangularSignal.path}</span>
              </div>
              <div style={{ textAlign:'right' }}>
                <span style={{ fontFamily:'var(--font-mono)', fontWeight:900, color:'#5741D9', fontSize:14 }}>+{triangularSignal.netPct.toFixed(4)}%</span>
                <div style={{ fontSize:9, color:'var(--text-dim)' }}>Neto proyectado</div>
              </div>
            </div>
          )}

          {/* StatArb signals */}
          {statArbSignals.length > 0 && (
            <div style={{ margin:'0 12px 12px', padding:'10px', background:'var(--bg-surface-3)', borderRadius:10, border:'1px solid var(--border)' }}>
              <div style={{ fontSize:10, fontWeight:700, color:'var(--text-dim)', marginBottom:8, textTransform:'uppercase', letterSpacing:'0.05em' }}>Señales de Arbitraje Estadístico (Mean Reversion)</div>
              <div style={{ display:'flex', gap:10, overflowX:'auto', paddingBottom:4 }}>
                {statArbSignals.map((s, i) => (
                  <div key={i} style={{ background:'#fff', border:'1px solid var(--border)', borderRadius:8, padding:'8px 12px', minWidth:180 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                      <span style={{ fontSize:10, fontWeight:800 }}>{s.buyExchange}→{s.sellExchange}</span>
                      <span style={{ fontSize:10, fontWeight:900, color:s.zScore>0?'var(--color-green)':'var(--color-red)' }}>Z={s.zScore}</span>
                    </div>
                    <div style={{ height:4, background:'var(--bg-surface-3)', borderRadius:2, overflow:'hidden', marginBottom:6 }}>
                      <div style={{ height:'100%', width:`${s.confidence}%`, background:s.zScore>2?'var(--color-green)':'var(--color-yellow)' }} />
                    </div>
                    <div style={{ fontSize:9, color:'var(--text-dim)', display:'flex', justifyContent:'space-between' }}>
                      <span>Confianza {s.confidence.toFixed(0)}%</span>
                      {s.viable && <span style={{ color:'var(--color-green)', fontWeight:800 }}>VIABLE</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        {/* ── P&L + EQUITY STRIP ──────────────────────────────────────────── */}
        <div style={{ display:'grid', gridTemplateColumns:'auto 1fr', gap:16 }}>

          {/* P&L metrics */}
          <Card style={{ padding:'16px 20px', display:'flex', gap:24, alignItems:'center', flexWrap:'wrap' }}>
            <div>
              <div style={{ fontSize:10, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:2 }}>Realized P&L</div>
              <div style={{ fontSize:28, fontWeight:900, color:pnlColor, fontFamily:'var(--font-mono)', lineHeight:1 }}>
                {(pnl.realizedPnl??pnl.totalPnl??0)>=0?'+':''}{fmtP(pnl.realizedPnl??pnl.totalPnl,4)}
              </div>
            </div>
            {[
              { label:'Operaciones',  value: pnl.totalTrades||0 },
              { label:'% Ganadoras', value: `${pnl.winRate||0}%` },
              { label:'Max DD',      value: pnl.maxDrawdown!=null?`-${pnl.maxDrawdown?.toFixed(1)}%`:'—', color:(pnl.maxDrawdown||0)>5?'var(--color-red)':(pnl.maxDrawdown||0)>2?'var(--color-yellow)':'var(--color-green)' },
              ...(dailyPnl!==null?[{ label:'P&L Hoy', value:`${dailyPnl>=0?'+':''}$${Math.abs(dailyPnl).toFixed(2)}`, color:dailyLossBreached?'var(--color-red)':dailyPnl>=0?'var(--color-green)':'var(--color-yellow)' }]:[]),
              ...(roi!=null?[{ label:'ROI', value:`${roi>=0?'+':''}${roi.toFixed(3)}%`, color:roi>=0?'var(--color-green)':'var(--color-red)' }]:[]),
              { label:'Ejec. Media', value: pnl.avgExecutionMs?`${Math.round(pnl.avgExecutionMs)}ms`:'—' },
            ].map(({ label, value, color }) => (
              <div key={label}>
                <div style={{ fontSize:10, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:2 }}>{label}</div>
                <div style={{ fontSize:18, fontWeight:800, color:color||'var(--text)', fontFamily:'var(--font-mono)', lineHeight:1 }}>{value}</div>
              </div>
            ))}
            <span title="Wallets pre-fondeadas en 5 exchanges" style={{ background:'rgba(0,184,122,0.08)', color:'var(--color-green)', fontSize:10, fontWeight:700, padding:'4px 10px', borderRadius:99, border:'1px solid rgba(0,184,122,0.2)', cursor:'help', whiteSpace:'nowrap', alignSelf:'center' }}>
              ⚡ Pre-funded Bilateral
            </span>
          </Card>

          {/* Equity curve */}
          <Card>
            <SectionTitle
              right={equityCurve.length>0 && (
                <span style={{ fontFamily:'var(--font-mono)', fontWeight:800, fontSize:12, color:(equityCurve[equityCurve.length-1]?.pnl||0)>=0?'var(--color-green)':'var(--color-red)' }}>
                  {(equityCurve[equityCurve.length-1]?.pnl||0)>=0?'+':''}${(equityCurve[equityCurve.length-1]?.pnl||0).toFixed(4)}
                </span>
              )}
            >
              Curva de Equity <span style={{ fontSize:10, fontWeight:400, color:'var(--text-dim)' }}>({equityCurve.length} trades)</span>
            </SectionTitle>
            <div style={{ padding:'8px 8px 4px' }}>
              {equityCurve.length < 2 ? (
                <div style={{ height:100, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-dim)', fontSize:12 }}>Esperando operaciones…</div>
              ) : (
                <ResponsiveContainer width="100%" height={100}>
                  <LineChart data={equityCurve} margin={{ top:4, right:12, left:0, bottom:0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                    <XAxis dataKey="label" tick={{ fontSize:7, fill:'var(--text-dim)' }} interval="preserveStartEnd"/>
                    <YAxis tick={{ fontSize:8, fill:'var(--text-dim)' }} tickFormatter={v=>`$${v.toFixed(1)}`} width={44}/>
                    <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="4 2"/>
                    <Tooltip contentStyle={{ background:'var(--bg-surface)', border:'1px solid var(--border)', borderRadius:8, fontSize:11 }} formatter={(v,n)=>[`$${Number(v).toFixed(4)}`, n==='pnl'?'P&L Acum.':'Op']}/>
                    <Line type="monotone" dataKey="pnl" stroke="#FF2D78" strokeWidth={2} dot={{ r:2, fill:'#FF2D78' }} isAnimationActive={false}/>
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>
        </div>

        {/* ── ORDER BOOKS + WALLETS ────────────────────────────────────────── */}
        <div style={{ display:'grid', gridTemplateColumns:'55fr 45fr', gap:16 }}>
          {/* Order Books */}
          <Card>
            <SectionTitle
              sub="Precios bid/ask en tiempo real desde WebSocket feeds"
              right={<span style={{ fontSize:10, color:anyWs?'var(--color-green)':'var(--text-dim)', fontWeight:700 }}>{anyWs?'⬤ WS EN VIVO':'○ HTTP'}</span>}
            >
              Order Books en Vivo <span style={{ fontSize:10, fontWeight:400, color:'var(--text-dim)' }}>({validBooks.length}/5)</span>
            </SectionTitle>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead><tr style={{ background:'var(--bg-surface-2)' }}>
                  {['Exchange','Bid','Ask','Spread%','Latencia','Feed'].map(h=>(
                    <th key={h} style={{ padding:'7px 10px', textAlign:'left', fontWeight:700, fontSize:9, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.06em', whiteSpace:'nowrap' }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {orderBooks.length===0 && <tr><td colSpan={6} style={{ padding:20, textAlign:'center', color:'var(--text-dim)' }}>Conectando…</td></tr>}
                  {orderBooks.map(ob=>(
                    <tr key={ob.exchange} style={{ borderTop:'1px solid var(--border)' }}>
                      <td style={{ padding:'9px 10px', fontWeight:700 }}>
                        <span style={{ display:'flex', alignItems:'center', gap:6 }}>
                          <span style={{ width:7, height:7, borderRadius:'50%', background:EX_COLORS[ob.exchange]||'#999' }}/>
                          {ob.exchange}
                        </span>
                      </td>
                      <td style={{ padding:'9px 10px', fontFamily:'var(--font-mono)', fontWeight:700, color:ob.exchange===bestBidEx?'var(--color-green)':'var(--text)' }}>{ob.error?'—':`$${fmt(ob.bid,2)}`}</td>
                      <td style={{ padding:'9px 10px', fontFamily:'var(--font-mono)', fontWeight:700, color:ob.exchange===bestAskEx?'#0052FF':'var(--text)' }}>{ob.error?'—':`$${fmt(ob.ask,2)}`}</td>
                      <td style={{ padding:'9px 10px', fontFamily:'var(--font-mono)', color:'var(--text-muted)', fontSize:11 }}>{ob.error?'—':`${ob.spreadPct}%`}</td>
                      <td style={{ padding:'9px 10px', fontFamily:'var(--font-mono)', fontSize:11, color:latColor(ob.latencyMs||0) }}>{latLabel(ob.latencyMs||0)}</td>
                      <td style={{ padding:'9px 10px' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                          <WsBadge on={ob.source==='ws'}/>
                          {ob.error
                            ? <span style={{ color:'var(--color-red)', fontSize:9 }}>✗</span>
                            : <span style={{ color:'var(--color-green)', fontSize:9 }}>✓</span>
                          }
                          {feedFreshness[ob.exchange]?.stale && <span style={{ color:'#F59E0B', fontSize:9, fontWeight:700 }}>⚠</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Wallets + latency */}
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            <Card>
              <SectionTitle right={
                <button onClick={handleReset} disabled={resetting}
                  style={{ background:confirmReset?'var(--color-red-dim)':'var(--bg-surface-2)', color:confirmReset?'var(--color-red)':'var(--text-muted)', border:`1px solid ${confirmReset?'rgba(240,62,62,0.25)':'var(--border)'}`, borderRadius:6, padding:'4px 10px', fontSize:11, fontWeight:700, cursor:'pointer' }}
                  onBlur={()=>setConfirm(false)}>
                  {confirmReset?'⚠ Confirmar':'↺ Reiniciar'}
                </button>
              }>Carteras / Saldos</SectionTitle>
              <div style={{ overflowX:'auto' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                  <thead><tr style={{ background:'var(--bg-surface-2)' }}>
                    {['Exchange','BTC','USDT'].map(h=><th key={h} style={{ padding:'6px 12px', textAlign:h==='Exchange'?'left':'right', fontWeight:700, fontSize:9, color:'var(--text-dim)', textTransform:'uppercase' }}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {ALL_EXCHANGES.map(ex=>(
                      <tr key={ex} style={{ borderTop:'1px solid var(--border)' }}>
                        <td style={{ padding:'8px 12px', fontWeight:700 }}><ExDot name={ex}/></td>
                        <td style={{ padding:'8px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:11 }}>{fmt(wallets.BTC?.[ex],4)}</td>
                        <td style={{ padding:'8px 12px', textAlign:'right', fontFamily:'var(--font-mono)', fontSize:11 }}>{wallets.USDT?.[ex]!=null?`$${fmt(wallets.USDT[ex],0)}`:'—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Latency heatmap */}
            <Card>
              <SectionTitle>Latencia por Exchange</SectionTitle>
              <div style={{ padding:'12px 16px', display:'flex', flexDirection:'column', gap:8 }}>
                {orderBooks.filter(ob=>!ob.error).map(ob=>{
                  const pct = ob.source==='ws'?100:Math.max(5,100-(ob.latencyMs/20));
                  return (
                    <div key={ob.exchange} style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <span style={{ width:60, fontSize:11, fontWeight:700, display:'flex', alignItems:'center', gap:5 }}>
                        <span style={{ width:6, height:6, borderRadius:'50%', background:EX_COLORS[ob.exchange]||'#999' }}/>
                        {ob.exchange.slice(0,6)}
                      </span>
                      <div style={{ flex:1, height:7, background:'var(--border)', borderRadius:3, overflow:'hidden' }}>
                        <div style={{ width:`${pct}%`, height:'100%', background:latColor(ob.latencyMs||0), transition:'width 0.4s' }}/>
                      </div>
                      <span style={{ fontSize:11, fontFamily:'var(--font-mono)', fontWeight:700, color:latColor(ob.latencyMs||0), minWidth:32, textAlign:'right' }}>{latLabel(ob.latencyMs||0)}</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
        </div>

        {/* ── TRADE HISTORY ────────────────────────────────────────────────── */}
        <Card>
          <SectionTitle right={
            <div style={{ display:'flex', gap:12, alignItems:'center' }}>
              {pnl.avgNetProfitPct != null && pnl.totalTrades > 0 && (
                <span style={{ fontSize:11, color:'var(--text-dim)', fontFamily:'var(--font-mono)' }}>
                  media/op: <span style={{ color:(pnl.avgNetProfitPct||0)>=0?'var(--color-green)':'var(--color-red)', fontWeight:700 }}>
                    {(pnl.avgNetProfitPct||0)>=0?'+':''}{(pnl.avgNetProfitPct||0).toFixed(4)}%
                  </span>
                </span>
              )}
              <span style={{ fontSize:11, color:'var(--text-dim)' }}>Últimas {history.length} ops</span>
            </div>
          }>Historial de Operaciones</SectionTitle>
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
              <thead><tr style={{ background:'var(--bg-surface-2)' }}>
                {['#','Hora','Compra en','Precio compra','Vende en','Precio venta','BTC','Fees','Slip','Score','Neto','Estado'].map((h,i)=>(
                  <th key={i} style={{ padding:'7px 9px', textAlign:'left', fontWeight:700, fontSize:9, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.05em', whiteSpace:'nowrap' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {history.length===0 && (
                  <tr><td colSpan={12} style={{ padding:24, textAlign:'center' }}>
                    <div style={{ color:'var(--text-dim)', fontSize:13 }}>
                      Bot activo — ejecutará cuando el spread neto supere el mínimo requerido.
                      {opportunitiesScanned>0 && ` ${opportunitiesScanned.toLocaleString()} pares analizados hasta ahora.`}
                    </div>
                  </td></tr>
                )}
                {history.map((t,i)=>(
                  <tr key={t.id||i} style={{ borderTop:'1px solid var(--border)', background: t.synthetic?'rgba(255,200,0,0.03)':'' }}
                    className="row-hover"
                    onClick={() => setSelectedTrade(t)}>
                    <td style={{ padding:'7px 9px', color:'var(--text-dim)', fontWeight:600 }}>
                      {i+1}{t.synthetic&&<span style={{ marginLeft:3, fontSize:8, color:'#F59E0B', fontWeight:800 }}>DEMO</span>}
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
                    <td style={{ padding:'7px 9px' }}><span style={{ background:t.status==='profit'?'var(--color-green-dim)':'var(--color-red-dim)', color:t.status==='profit'?'var(--color-green)':'var(--color-red)', fontWeight:700, fontSize:9, padding:'2px 6px', borderRadius:99 }}>{t.status==='profit'?'▲ GANADA':'▼ PERDIDA'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <style>{`
          @keyframes pulseDot { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.5;transform:scale(0.8)} }
        `}</style>
      </>)}
    </div>
  );
}
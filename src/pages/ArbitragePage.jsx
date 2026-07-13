import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { useArbitrageStream } from '../hooks/useArbitrageStream';
import { useStaleAfter } from '../hooks/useStaleAfter';
import toast from 'react-hot-toast';
import OpportunityHeroCard from '../components/common/OpportunityHero';
import ScanningPulseWidget from '../components/common/ScanningPulse';
import { EX_COLORS, scoreColor, latColor, latLabel, ALL_EXCHANGES,
  fmt, fmtP, uptime, translateRejection,
  Card, SectionTitle, ExDot, WsBadge,
} from '../components/common/ArbitrageSharedComponents';
import { api } from '../api';
import TradeAuditModal from '../components/common/TradeAuditModal';
import Onboarding from '../components/common/Onboarding';
import SystemStatusBar from '../components/common/SystemStatusBar';
import LiveTradeTicker, { TICKER_HEIGHT } from '../components/common/LiveTradeTicker';
import TradeHistoryPanel from '../components/common/TradeHistoryPanel';
import { TradingModeBadge } from '../components/common/TradingPanel';
import ErrorBoundary from '../components/common/ErrorBoundary';
import EngineReadyBanner from '../components/common/EngineReadyBanner';
import PageSkeleton from '../components/common/PageSkeleton';
import { ARBITRAGE_TABS as TABS, TAB_GROUPS } from '../components/common/ArbitrageTabsConfig';
import ArbTabIcons from '../components/common/arbTabIcons';

// Auditoría de comité (2026-07-08), ítem 5 de la hoja de ruta: estos 18
// paneles solo se montan cuando su pestaña está activa (ver el bloque
// `{activeTab==='X' && <Componente/>}` más abajo), pero antes se importaban
// de forma estática al tope del archivo — así que visitar la pestaña por
// defecto ("bot") descargaba el código de las otras 18 pestañas aunque
// nunca se abrieran. El addendum de due diligence del 2026-07-08 midió el
// costo real: ArbitragePage-*.js pesaba 495.77 kB (75.82 kB gzip), el chunk
// más grande del frontend después de chart-vendor. `lazy()` + `Suspense`
// por pestaña (mismo patrón que ya usa App.jsx para las páginas de nivel
// superior) hace que cada panel se descargue solo la primera vez que su
// pestaña se abre.
const TriangularPanelWidget = lazy(() => import('../components/common/TriangularPanel'));
const LiveConfigPanel       = lazy(() => import('../components/common/LiveConfigPanel'));
const TenantBotPanel        = lazy(() => import('../components/common/TenantBotPanel'));
const ExecutiveDashboard    = lazy(() => import('../components/common/ExecutiveDashboard'));
const SpeedBenchmarkPanel   = lazy(() => import('../components/common/SpeedBenchmarkPanel'));
const SpreadHeatmapPanel    = lazy(() => import('../components/common/SpreadHeatmapPanel'));
const CapitalEfficiencyPanel= lazy(() => import('../components/common/CapitalEfficiencyPanel'));
const RebalancePanel        = lazy(() => import('../components/common/RebalancePanel'));
const MicrostructurePanel   = lazy(() => import('../components/common/MicrostructurePanel'));
const QuantAnalyticsPanel   = lazy(() => import('../components/common/QuantAnalyticsPanel'));
const AdaptivePanel         = lazy(() => import('../components/common/AdaptivePanel'));
const StressTestPanel       = lazy(() => import('../components/common/StressTestPanel'));
const AdversarialPanel      = lazy(() => import('../components/common/AdversarialPanel'));
const ReplayPanel           = lazy(() => import('../components/common/ReplayPanel'));
const IntelligencePanel     = lazy(() => import('../components/common/IntelligencePanel'));
const LifecyclePanel        = lazy(() => import('../components/common/LifecyclePanel'));
const AuditedPnlPanel       = lazy(() => import('../components/common/AuditedPnlPanel'));
const WatchdogPanel         = lazy(() => import('../components/common/WatchdogPanel'));

export default function ArbitragePage() {
  const location = useLocation();
  const [botOn,        setBotOn]    = useState(true);
  const [minScore,     setMinScore] = useState(10);
  const [pendingScore, setPending]  = useState(10);
  const [resetting,    setResetting]= useState(false);
  const [confirmReset, setConfirm]  = useState(false);
  const [activeTab,    setActiveTab]= useState('bot');
  const [selectedTrade, setSelectedTrade] = useState(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [rebalanceAlert, setRebalanceAlert] = useState(null);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const lastTradeIdRef  = useRef(null);
  const scoreTimeoutRef = useRef(null);

  useEffect(() => {
    return () => { clearTimeout(scoreTimeoutRef.current); };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const tab = params.get('tab');
    if (tab) setActiveTab(tab);
  }, [location.search]);

  const [localEquityCurve, setLocalEquityCurve] = useState([]);
  const [historyResetSignal, setHistoryResetSignal] = useState(0);

  const { data: sseData, connected: sseOk } = useArbitrageStream();
  const data = sseData ?? null;

  // Auditoría (2026-07): antes, si el stream SSE se caía, el único feedback
  // era un punto de 5px cambiando de color y "SSE"->"–" — y como el hook
  // mergea por delta, los números en pantalla se quedaban CONGELADOS
  // viéndose "en vivo". En una demo, una caída de 20-30s podía pasar
  // completamente inadvertida. Fix: si la desconexión dura más de 3s (para
  // no parpadear en blips normales de reconexión), mostramos un banner
  // explícito de "datos congelados / reconectando" hasta que vuelva sseOk.
  const sseStale = useStaleAfter(sseOk, 3000);

  useEffect(() => {
    if (data?.equityCurve) setLocalEquityCurve(data.equityCurve);
  }, [data?.equityCurve]);

  useEffect(() => {
    if (data?.minScore != null) { setMinScore(data.minScore); setPending(data.minScore); }
  }, [data?.minScore]);

  const toggleBot = useCallback(async () => {
    const next = !botOn; setBotOn(next);
    try { await api.post('/api/arbitrage/bot', { enabled: next, score: minScore }); } catch { /* fire-and-forget */ }
  }, [botOn, minScore]);

  const applyScore = useCallback(async (val) => {
    setMinScore(val);
    try { await api.post('/api/arbitrage/bot', { enabled: botOn, score: val }); } catch { /* fire-and-forget */ }
  }, [botOn]);

  const _lastTrade = data?.lastTrade;
  const _trade     = data?.type === 'trade_executed' ? data?.trade : null;
  useEffect(() => {
    const t = _lastTrade || _trade;
    if (!t || t.id === lastTradeIdRef.current) return;
    lastTradeIdRef.current = t.id;
    const p = Number(t.netProfit);
    const synLabel = t.synthetic ? ' [DEMO]' : '';
    if (p >= 0) toast.success(`↗ ${t.buyExchange}→${t.sellExchange} | +$${p.toFixed(4)}${synLabel}`, { duration:4000 });
    else        toast.error(`↘ ${t.buyExchange}→${t.sellExchange} | $${p.toFixed(4)}`, { duration:3000 });
  }, [_lastTrade, _trade]);

  useEffect(() => {
    const check = async () => {
      try {
        const result = await api.get('/api/arbitrage/rebalance/analyze');
        const highSeverity = (result?.imbalances || []).filter(im => im.severity === 'high');
        if (highSeverity.length > 0) {
          setRebalanceAlert({ imbalances: highSeverity, ts: Date.now() });
        } else {
          setRebalanceAlert(null);
        }
      } catch { /* transient network error */ }
    };
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleReset = async () => {
    if (!confirmReset) { setConfirm(true); return; }
    setResetting(true);
    try {
      await api.post('/api/arbitrage/reset', {});
      toast.success('Wallets reset');
      setLocalEquityCurve([]);
      setHistoryResetSignal(s => s + 1);
    } catch { toast.error('Reset failed'); }
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

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16, padding:'0 2px', paddingBottom: data?.lastTrade ? TICKER_HEIGHT + 8 : 0, transition:'padding-bottom 0.2s ease', position: 'relative' }}>
      {selectedTrade && <TradeAuditModal trade={selectedTrade} onClose={() => setSelectedTrade(null)} />}
      <Onboarding show={showOnboarding} step={onboardingStep} setStep={setOnboardingStep} onDismiss={() => setShowOnboarding(false)} />
      <SystemStatusBar data={data} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <TradingModeBadge />
        <Link to="/settings" style={{ display:'flex', alignItems:'center', gap:5, fontSize: 11, color: 'var(--text-dim)', textDecoration: 'none', fontWeight: 600 }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-primary, #FF2D78)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-dim)'; }}
        >
          <span style={{ display:'flex' }}>{ArbTabIcons.gear}</span>
          Configure pairs & mode →
        </Link>
      </div>

      {sseStale && (
        <div className="banner-enter" style={{ background:'linear-gradient(135deg,rgba(240,62,62,0.14),rgba(240,62,62,0.06))', border:'1px solid rgba(240,62,62,0.45)', borderRadius:10, padding:'10px 16px', display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
          <span style={{ display:'flex', flexShrink:0, color:'#F03E3E' }}>{ArbTabIcons.alertTriangle}</span>
          <div style={{ flex:1, minWidth:200 }}>
            <div style={{ fontWeight:800, fontSize:12, color:'#F03E3E' }}>
              Conexión en vivo perdida — datos congelados
            </div>
            <div style={{ fontSize:11, color:'var(--text-dim)', marginTop:2 }}>
              Los números en pantalla son del último dato recibido, no en tiempo real. Reconectando automáticamente…
            </div>
          </div>
        </div>
      )}

      {rebalanceAlert && rebalanceAlert.imbalances.length > 0 && (
        <div className="banner-enter" style={{ background:'linear-gradient(135deg,rgba(245,158,11,0.12),rgba(240,62,62,0.08))', border:'1px solid rgba(245,158,11,0.40)', borderRadius:10, padding:'10px 16px', display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
          <span style={{ display:'flex', flexShrink:0, color:'#F59E0B' }}>{ArbTabIcons.scale}</span>
          <div style={{ flex:1, minWidth:200 }}>
            <div style={{ fontWeight:800, fontSize:12, color:'#F59E0B' }}>
              Rebalancing required — {rebalanceAlert.imbalances.length} critical imbalance{rebalanceAlert.imbalances.length > 1 ? 's' : ''}
            </div>
            <div style={{ fontSize:11, color:'var(--text-dim)', marginTop:2 }}>
              {rebalanceAlert.imbalances.map(im => im.description).join(' · ')}
            </div>
          </div>
          <button
            onClick={() => setActiveTab('rebalance')}
            style={{ padding:'6px 14px', borderRadius:6, fontWeight:800, fontSize:11, cursor:'pointer', background:'rgba(245,158,11,0.15)', color:'#F59E0B', border:'1px solid rgba(245,158,11,0.35)', whiteSpace:'nowrap' }}>
            View Inventory →
          </button>
          <button
            onClick={() => setRebalanceAlert(null)}
            style={{ display:'flex', alignItems:'center', justifyContent:'center', padding:'6px', borderRadius:6, cursor:'pointer', background:'transparent', color:'var(--text-dim)', border:'1px solid var(--border)' }}>
            {ArbTabIcons.close}
          </button>
        </div>
      )}

      <EngineReadyBanner
        wsStatusMap={wsStatusMap}
        feedFreshness={feedFreshness}
        data={data}
        onConfigClick={() => setActiveTab('control')}
      />

      <div style={{
        background:'var(--bg-surface)', border:'1px solid var(--border)',
        borderRadius:'var(--radius-lg)', padding:'10px 14px',
        minWidth:0, boxShadow:'var(--shadow-card)',
      }}>
        {TAB_GROUPS.map((group, gi) => (
          <div key={group.key} style={{
            display:'flex', alignItems:'center', gap:10, minWidth:0,
            padding: gi === 0 ? '0 0 8px' : '8px 0',
            borderTop: gi === 0 ? 'none' : '1px solid var(--border)',
          }}>
            <span style={{
              flexShrink:0, width:74, textAlign:'center',
              fontSize:9, fontWeight:800, letterSpacing:'0.06em',
              color:group.color, background:`${group.color}14`,
              border:`1px solid ${group.color}2a`,
              borderRadius:6, padding:'3px 6px', textTransform:'uppercase',
            }}>
              {group.label}
            </span>
            <div
              className="arb-tab-scroll"
              style={{ display:'flex', gap:3, minWidth:0, overflowX:'auto', overflowY:'hidden', scrollbarWidth:'thin' }}
            >
              {TABS.filter(t => group.ids.includes(t.id)).map(tab => {
                const active = activeTab === tab.id;
                return (
                  <button key={tab.id} onClick={() => setActiveTab(tab.id)} title={tab.desc} style={{
                    display:'flex', alignItems:'center', gap:6,
                    padding:'6px 12px', borderRadius:8, cursor:'pointer',
                    fontWeight:600, fontSize:11.5, whiteSpace:'nowrap', flexShrink:0,
                    background: active ? `${group.color}14` : 'transparent',
                    color: active ? group.color : 'var(--text-muted)',
                    border: active ? `1px solid ${group.color}33` : '1px solid transparent',
                    transition:'all 0.14s ease',
                  }}
                  onMouseEnter={e => { if (!active) { e.currentTarget.style.background = 'var(--bg-surface-3)'; e.currentTarget.style.color = 'var(--text)'; } }}
                  onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; } }}
                  >
                    <span style={{ display:'flex', opacity: active ? 1 : 0.75 }}>{ArbTabIcons[tab.icon]}</span>
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        <div style={{ display:'flex', alignItems:'center', gap:10, paddingTop:9, marginTop:1, borderTop:'1px solid var(--border)' }}>
          <button
            onClick={() => { setOnboardingStep(0); setShowOnboarding(true); }}
            title="90-second guided tour of the platform"
            style={{ display:'flex', alignItems:'center', gap:5, flexShrink:0, background:'linear-gradient(135deg,#FF8C42,#FF2D78)', color:'#fff', border:'none', borderRadius:7, padding:'5px 12px', fontWeight:800, fontSize:10.5, cursor:'pointer' }}
          >
            <span style={{ display:'flex' }}>{ArbTabIcons.play}</span>
            Tour
          </button>
          <div style={{ display:'flex', gap:10, alignItems:'center', paddingLeft:10, borderLeft:'1px solid var(--border)' }}>
            {Object.entries(wsStatusMap).filter(([k])=>k!=='Coinbase').map(([ex,on])=>(
              <span key={ex} style={{ display:'flex', alignItems:'center', gap:4, fontSize:10.5, fontWeight:700, color:on?'var(--color-green)':'var(--text-dim)' }}>
                <span style={{ width:5, height:5, borderRadius:'50%', flexShrink:0, background:on?'var(--color-green)':'var(--border)', animation:on?'pulseDot 1.5s infinite':'none' }}/>
                {ex.slice(0,3)}
              </span>
            ))}
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:4, fontSize:10.5, fontWeight:700, borderLeft:'1px solid var(--border)', paddingLeft:10 }}>
            <span style={{ width:5, height:5, borderRadius:'50%', flexShrink:0, background:sseOk?'#0052FF':'var(--border)', animation:sseOk?'pulseDot 1.5s infinite':'none' }}/>
            <span style={{ color:sseOk?'#0052FF':'var(--text-dim)' }}>{sseOk?'SSE':'–'}</span>
          </div>
        </div>
      </div>

      {activeTab==='control'       && <ErrorBoundary inline label="Live Config"><Suspense fallback={<PageSkeleton metrics={2} />}><LiveConfigPanel /></Suspense></ErrorBoundary>}
      {activeTab==='mybot'         && <ErrorBoundary inline label="Mi Bot Personal"><Suspense fallback={<PageSkeleton metrics={2} />}><TenantBotPanel /></Suspense></ErrorBoundary>}
      {activeTab==='executive'     && <ErrorBoundary inline label="Executive Dashboard"><Suspense fallback={<PageSkeleton />}><ExecutiveDashboard data={data} /></Suspense></ErrorBoundary>}
      {activeTab==='triangular'    && <ErrorBoundary inline label="Triangular Panel"><Suspense fallback={<PageSkeleton metrics={2} />}><TriangularPanelWidget data={data} /></Suspense></ErrorBoundary>}
      {activeTab==='speed'         && <ErrorBoundary inline label="Speed Benchmark"><Suspense fallback={<PageSkeleton metrics={2} />}><SpeedBenchmarkPanel data={data} /></Suspense></ErrorBoundary>}
      {activeTab==='heatmap'       && <ErrorBoundary inline label="Spread Heatmap"><Suspense fallback={<PageSkeleton metrics={1} />}><SpreadHeatmapPanel data={data} /></Suspense></ErrorBoundary>}
      {activeTab==='capital'       && <ErrorBoundary inline label="Capital Efficiency"><Suspense fallback={<PageSkeleton metrics={2} />}><CapitalEfficiencyPanel data={data} /></Suspense></ErrorBoundary>}
      {activeTab==='rebalance'     && <ErrorBoundary inline label="Rebalance"><Suspense fallback={<PageSkeleton metrics={2} />}><RebalancePanel data={data} /></Suspense></ErrorBoundary>}
      {activeTab==='microstructure'&& <ErrorBoundary inline label="Microstructure"><Suspense fallback={<PageSkeleton metrics={2} />}><MicrostructurePanel /></Suspense></ErrorBoundary>}
      {activeTab==='quant'         && <ErrorBoundary inline label="Quant Analytics"><Suspense fallback={<PageSkeleton metrics={2} />}><QuantAnalyticsPanel data={data} /></Suspense></ErrorBoundary>}
      {activeTab==='adaptive'      && <ErrorBoundary inline label="Adaptive"><Suspense fallback={<PageSkeleton metrics={2} />}><AdaptivePanel data={data} /></Suspense></ErrorBoundary>}
      {activeTab==='stress'        && <ErrorBoundary inline label="Stress Test"><Suspense fallback={<PageSkeleton metrics={2} />}><StressTestPanel data={data} /></Suspense></ErrorBoundary>}
      {activeTab==='adversarial'   && <ErrorBoundary inline label="Adversarial"><Suspense fallback={<PageSkeleton metrics={2} />}><AdversarialPanel /></Suspense></ErrorBoundary>}
      {activeTab==='replay'        && <ErrorBoundary inline label="Replay"><Suspense fallback={<PageSkeleton metrics={2} />}><ReplayPanel /></Suspense></ErrorBoundary>}
      {activeTab==='intelligence'  && <ErrorBoundary inline label="Intelligence"><Suspense fallback={<PageSkeleton metrics={3} />}><IntelligencePanel data={data} opportunities={opportunities} /></Suspense></ErrorBoundary>}
      {activeTab==='lifecycle'     && <ErrorBoundary inline label="Lifecycle"><Suspense fallback={<PageSkeleton metrics={2} />}><LifecyclePanel data={data} /></Suspense></ErrorBoundary>}
      {activeTab==='audit'         && <ErrorBoundary inline label="Audited PnL"><Suspense fallback={<PageSkeleton metrics={2} />}><AuditedPnlPanel data={data} /></Suspense></ErrorBoundary>}
      {activeTab==='watchdog'      && <ErrorBoundary inline label="Watchdog"><Suspense fallback={<PageSkeleton metrics={1} />}><WatchdogPanel /></Suspense></ErrorBoundary>}

      {activeTab==='bot' && (<>

        <div style={{ background:'linear-gradient(135deg,rgba(255,45,120,0.07),rgba(0,82,255,0.05))', border:'1px solid rgba(255,45,120,0.2)', borderRadius:10, padding:'10px 16px', display:'flex', alignItems:'center', gap:12 }}>
          <div style={{ display:'flex', flexShrink:0, color:'var(--color-primary)' }}>{ArbTabIcons.bolt}</div>
          <div style={{ fontSize:11, color:'var(--text-dim)', lineHeight:1.5 }}>
            <b style={{ color:'var(--text)' }}>Engine de detection bilateral in real time.</b>{' '}
            Listens to 5 exchanges via persistent WebSocket, recalculates spreads on every tick and applies composite scoring (gross spread, VWAP, fill probability, historical latency). Only opportunities with score &gt; threshold reach the execution engine — rejected ones show the exact reason.
          </div>
        </div>

        {(() => {
          const totalDetected = opportunitiesScanned || 0;
          const totalViable   = viableCount || 0;
          const totalExecuted = data?.tradesExecuted ?? (pnl.totalTrades || 0);
          const totalRejCounts = rejectionCounts || {};
          const feeRej    = totalRejCounts.fees_slippage    || 0;
          const liqRej    = totalRejCounts.liquidity        || 0;
          const staleRej  = totalRejCounts.stale_book       || 0;
          const cbRej     = totalRejCounts.circuit_breaker  || 0;
          const scoreRej  = totalRejCounts.score_too_low    || (totalDetected - totalViable - feeRej - liqRej - staleRej - cbRej);
          const funnel = [
            { label:'Detectadas',  value: totalDetected, color:'#0052FF',           pct: 100 },
            { label:'Viables',     value: totalViable,   color:'#8b5cf6',           pct: totalDetected > 0 ? (totalViable/totalDetected)*100 : 0 },
            { label:'Ejecutadas',  value: totalExecuted, color:'var(--color-green)', pct: totalDetected > 0 ? (totalExecuted/totalDetected)*100 : 0 },
          ];
          const reasons = [
            { label:'Fees + slippage', value: feeRej,   color:'var(--color-red)' },
            { label:'Liquidity baja',   value: liqRej,   color:'#F59E0B' },
            { label:'Feed stale',      value: staleRej, color:'#F59E0B' },
            { label:'Circuit breaker', value: cbRej,    color:'var(--color-red)' },
            { label:'Score bajo',      value: Math.max(0, scoreRej), color:'var(--text-dim)' },
          ].filter(r => r.value > 0);
          if (totalDetected === 0) return null;
          return (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
              <div className="card" style={{ padding:'12px 16px' }}>
                <div style={{ fontSize:9, fontWeight:900, textTransform:'uppercase', color:'var(--text-dim)', letterSpacing:'0.08em', marginBottom:10 }}>Opportunity Funnel</div>
                {funnel.map(f => (
                  <div key={f.label} style={{ marginBottom:8 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                      <span style={{ fontSize:10, color:'var(--text-dim)' }}>{f.label}</span>
                      <span style={{ fontSize:10, fontWeight:700, fontFamily:'var(--font-mono)', color:f.color }}>{f.value.toLocaleString()}</span>
                    </div>
                    <div style={{ height:5, background:'var(--bg-surface)', borderRadius:3, overflow:'hidden' }}>
                      <div style={{ width:`${Math.min(100,f.pct)}%`, height:'100%', background:f.color, borderRadius:3, transition:'width 0.3s' }} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="card" style={{ padding:'12px 16px' }}>
                <div style={{ fontSize:9, fontWeight:900, textTransform:'uppercase', color:'var(--text-dim)', letterSpacing:'0.08em', marginBottom:10 }}>Motivos de descarte</div>
                {reasons.length === 0 ? (
                  <div style={{ fontSize:11, color:'var(--color-green)', fontWeight:700 }}>✓ All opportunities passed filters</div>
                ) : reasons.map(r => (
                  <div key={r.label} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
                    <span style={{ fontSize:10, color:'var(--text-dim)' }}>{r.label}</span>
                    <span style={{ fontSize:11, fontWeight:800, fontFamily:'var(--font-mono)', color:r.color }}>{r.value.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {dailyLossBreached && (
          <div style={{ background:'var(--color-red-dim)', border:'1px solid rgba(240,62,62,0.35)', borderRadius:'var(--radius)', padding:'10px 16px', display:'flex', alignItems:'center', gap:10 }}>
            <span style={{ display:'flex', color:'var(--color-red)' }}>{ArbTabIcons.alertTriangle}</span>
            <strong style={{ color:'var(--color-red)' }}>Circuit Breaker Global — Bot Stopped.</strong>
            <span style={{ color:'var(--text-muted)', fontSize:12, marginLeft:4 }}>Daily loss reached -$500. P&L today: {dailyPnl!=null?`$${dailyPnl.toFixed(2)}`:'—'}</span>
          </div>
        )}

        <Card glow={viableCount > 0} style={{ overflow:'hidden' }}>
          <div style={{ padding:'18px 20px 14px', borderBottom:'1px solid var(--border)', background: viableCount>0 ? 'linear-gradient(135deg,rgba(0,184,122,0.05),transparent)' : 'transparent' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
              <div>
                <h2 style={{ margin:0, fontSize:18, fontWeight:900, color:'var(--text)', letterSpacing:'-0.02em' }}>
                  Detected Opportunities
                </h2>
                <div style={{ fontSize:11, color:'var(--text-dim)', marginTop:2 }}>
                  Scanning {validBooks.length} exchanges · Event-driven WebSocket · Latency detection &lt; 30ms
                </div>
              </div>

              {viableCount > 0 ? (
                <div style={{ background:'rgba(0,184,122,0.12)', border:'1px solid rgba(0,184,122,0.35)', borderRadius:12, padding:'8px 20px', textAlign:'center' }}>
                  <div style={{ fontSize:28, fontWeight:900, color:'var(--color-green)', fontFamily:'var(--font-mono)', lineHeight:1 }}>{viableCount}</div>
                  <div style={{ fontSize:10, color:'var(--color-green)', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em' }}>viable{viableCount>1?'s':''}</div>
                </div>
              ) : (
                <div style={{ background:'var(--bg-surface-2)', border:'1px solid var(--border)', borderRadius:12, padding:'8px 20px', textAlign:'center' }}>
                  <div style={{ fontSize:28, fontWeight:900, color:'var(--text-dim)', fontFamily:'var(--font-mono)', lineHeight:1 }}>0</div>
                  <div style={{ fontSize:10, color:'var(--text-dim)', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em' }}>viable</div>
                </div>
              )}

              <div style={{ display:'flex', gap:16, flexWrap:'wrap', alignItems:'center' }}>
                {[
                  { label:'Pairs Scanned',   value:opportunitiesScanned.toLocaleString(), color:'var(--text)' },
                  { label:'Viable (session)', value:viableFound.toString(), color:'var(--color-green)' },
                  { label:'Executed',         value:(pnl.totalTrades||0).toString(), color:'var(--color-green)' },
                  { label:'Near Viable',      value:nearViableCount.toString(), color:'var(--color-yellow)' },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ textAlign:'center' }}>
                    <div style={{ fontSize:17, fontWeight:900, fontFamily:'var(--font-mono)', color }}>{value}</div>
                    <div style={{ fontSize:9, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:700 }}>{label}</div>
                  </div>
                ))}
              </div>

              <div style={{ marginLeft:'auto', display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
                <div style={{ display:'flex', flexDirection:'column', gap:2, minWidth:130 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'var(--text-dim)', fontWeight:700 }}>
                    <span>Minimum score</span>
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

            {totalRejected > 0 && viableCount === 0 && (
              <div style={{ display:'flex', gap:10, marginTop:12, flexWrap:'wrap', padding:'8px 0 0' }}>
                <span style={{ fontSize:10, color:'var(--text-dim)', fontWeight:700, alignSelf:'center' }}>Rejected by:</span>
                {rejectionCounts.fees_slippage > 0 && <span style={{ background:'rgba(240,62,62,0.08)', color:'var(--color-red)', fontSize:10, fontWeight:700, padding:'2px 10px', borderRadius:99, border:'1px solid rgba(240,62,62,0.2)' }}>Fees+Slip: {rejectionCounts.fees_slippage.toLocaleString()}</span>}
                {rejectionCounts.circuit_breaker > 0 && <span style={{ background:'rgba(245,158,11,0.08)', color:'#F59E0B', fontSize:10, fontWeight:700, padding:'2px 10px', borderRadius:99, border:'1px solid rgba(245,158,11,0.2)' }}>Circuit Breaker: {rejectionCounts.circuit_breaker.toLocaleString()}</span>}
                {rejectionCounts.liquidity > 0 && <span style={{ background:'rgba(245,158,11,0.08)', color:'#F59E0B', fontSize:10, fontWeight:700, padding:'2px 10px', borderRadius:99, border:'1px solid rgba(245,158,11,0.2)' }}>Liquidity: {rejectionCounts.liquidity.toLocaleString()}</span>}
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

          <div style={{ padding:'12px', display:'flex', flexDirection:'column', gap:10 }}>
            {opportunities.length === 0 ? (
              <ScanningPulseWidget opportunitiesScanned={opportunitiesScanned} nearViableCount={nearViableCount} bestOpportunitySeen={bestOpportunitySeen} />
            ) : (
              opportunities.slice(0, 10).map((op, i) => (
                <OpportunityHeroCard key={op.id||i} op={op} minScore={minScore} rank={i+1} />
              ))
            )}
          </div>

          {triangularSignal && (
            <div style={{ margin:'0 12px 12px', background:'linear-gradient(135deg,rgba(88,65,217,0.08),rgba(88,65,217,0.04))', border:'1px solid rgba(88,65,217,0.25)', borderRadius:10, padding:'10px 16px', display:'flex', alignItems:'center', gap:12, fontSize:12 }}>
              <span style={{ display:'flex', color:'#5741D9', animation:'pulseDot 2s infinite' }}>{ArbTabIcons.triangular}</span>
              <div style={{ flex:1 }}>
                <span style={{ fontWeight:800, color:'#5741D9', display:'flex', alignItems:'center', gap:6 }}>
                  TRIANGULAR STRATEGY ACTIVE
                  <span style={{ background:'#FF2D78', color:'#fff', fontSize:8, padding:'1px 5px', borderRadius:4 }}>AUTO-EXEC</span>
                </span>
                <span style={{ color:'var(--text-muted)', marginLeft:0, display:'block', fontSize:10 }}>{triangularSignal.path}</span>
              </div>
              <div style={{ textAlign:'right' }}>
                <span style={{ fontFamily:'var(--font-mono)', fontWeight:900, color:'#5741D9', fontSize:14 }}>+{triangularSignal.netPct.toFixed(4)}%</span>
                <div style={{ fontSize:9, color:'var(--text-dim)' }}>Projected net</div>
              </div>
            </div>
          )}

          {statArbSignals.length > 0 && (
            <div style={{ margin:'0 12px 12px', padding:'10px', background:'var(--bg-surface-3)', borderRadius:10, border:'1px solid var(--border)' }}>
              <div style={{ fontSize:10, fontWeight:700, color:'var(--text-dim)', marginBottom:8, textTransform:'uppercase', letterSpacing:'0.05em' }}>Statistical Arbitrage Signals (Mean Reversion)</div>
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
                      <span>Confidence {s.confidence.toFixed(0)}%</span>
                      {s.viable && <span style={{ color:'var(--color-green)', fontWeight:800 }}>VIABLE</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        <div style={{ display:'grid', gridTemplateColumns:'auto 1fr', gap:16 }}>

          <Card style={{ padding:'16px 20px', display:'flex', gap:24, alignItems:'center', flexWrap:'wrap' }}>
            <div>
              <div style={{ fontSize:10, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:2 }}>Realized P&L</div>
              <div style={{ fontSize:28, fontWeight:900, color: (pnl.totalTrades||0) === 0 ? 'var(--text-dim)' : pnlColor, fontFamily:'var(--font-mono)', lineHeight:1 }}>
                {(pnl.totalTrades||0) === 0 ? '—' : `${(pnl.realizedPnl??pnl.totalPnl??0)>=0?'+':''}${fmtP(pnl.realizedPnl??pnl.totalPnl,4)}`}
              </div>
            </div>
            {[
              { label:'Operations',  value: pnl.totalTrades||0 },
              { label:'Win Rate',    value: (pnl.totalTrades||0) > 0 ? `${pnl.winRate||0}%` : '—' },
              { label:'Max DD',      value: (pnl.totalTrades||0) > 0 && pnl.maxDrawdown!=null ? `-${pnl.maxDrawdown?.toFixed(1)}%` : '—', color:(pnl.maxDrawdown||0)>5?'var(--color-red)':(pnl.maxDrawdown||0)>2?'var(--color-yellow)':'var(--color-green)' },
              ...(dailyPnl!==null && Math.abs(dailyPnl) >= 0.001 ?[{ label:'P&L Today', value:`${dailyPnl>=0?'+':''}$${Math.abs(dailyPnl).toFixed(2)}`, color:dailyLossBreached?'var(--color-red)':dailyPnl>=0?'var(--color-green)':'var(--color-yellow)' }]:[]),
              ...(roi!=null && (pnl.totalTrades||0) > 0 ?[{ label:'ROI', value:`${roi>=0?'+':''}${roi.toFixed(3)}%`, color:roi>=0?'var(--color-green)':'var(--color-red)' }]:[]),
              { label:'Avg Fill', value: pnl.avgExecutionMs?`${Math.round(pnl.avgExecutionMs)}ms`:'—' },
            ].map(({ label, value, color }) => (
              <div key={label}>
                <div style={{ fontSize:10, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:2 }}>{label}</div>
                <div style={{ fontSize:18, fontWeight:800, color:color||'var(--text)', fontFamily:'var(--font-mono)', lineHeight:1 }}>{value}</div>
              </div>
            ))}
            <span title="Pre-funded wallets on 5 exchanges — no inter-exchange transfers per trade" style={{ background:'rgba(0,184,122,0.08)', color:'var(--color-green)', fontSize:10, fontWeight:700, padding:'4px 10px', borderRadius:99, border:'1px solid rgba(0,184,122,0.2)', cursor:'help', whiteSpace:'nowrap', alignSelf:'center' }}>
              Pre-funded Bilateral
            </span>
          </Card>

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
                <div style={{ height:100, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-dim)', fontSize:12 }}>Esperando operations…</div>
              ) : (
                <ResponsiveContainer width="100%" height={100}>
                  <LineChart data={equityCurve} margin={{ top:4, right:12, left:0, bottom:0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                    <XAxis dataKey="label" tick={{ fontSize:7, fill:'var(--text-dim)' }} interval="preserveStartEnd"/>
                    <YAxis tick={{ fontSize:8, fill:'var(--text-dim)' }} tickFormatter={v=>`$${v.toFixed(1)}`} width={44}/>
                    <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="4 2"/>
                    <Tooltip contentStyle={{ background:'var(--bg-surface)', border:'1px solid var(--border)', borderRadius:8, fontSize:11 }} formatter={(v,n)=>[`$${Number(v).toFixed(4)}`, n==='pnl'?'Cumulative P&L':'Op']}/>
                    <Line type="monotone" dataKey="pnl" stroke="#FF2D78" strokeWidth={2} dot={{ r:2, fill:'#FF2D78' }} isAnimationActive={false}/>
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'55fr 45fr', gap:16 }}>
          <Card>
            <SectionTitle
              sub="Live bid/ask prices via native WebSocket feeds"
              right={<span style={{ fontSize:10, color:anyWs?'var(--color-green)':'var(--text-dim)', fontWeight:700 }}>{anyWs?'⬤ WS EN VIVO':'○ HTTP'}</span>}
            >
              Order Books en Vivo <span style={{ fontSize:10, fontWeight:400, color:'var(--text-dim)' }}>({validBooks.length}/5)</span>
            </SectionTitle>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead><tr style={{ background:'var(--bg-surface-2)' }}>
                  {['Exchange','Bid','Ask','Spread%','Latency','Feed'].map(h=>(
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

          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            <Card>
              <SectionTitle right={
                <button onClick={handleReset} disabled={resetting}
                  style={{ background:confirmReset?'var(--color-red-dim)':'var(--bg-surface-2)', color:confirmReset?'var(--color-red)':'var(--text-muted)', border:`1px solid ${confirmReset?'rgba(240,62,62,0.25)':'var(--border)'}`, borderRadius:6, padding:'4px 10px', fontSize:11, fontWeight:700, cursor:'pointer' }}
                  onBlur={()=>setConfirm(false)}>
                  {confirmReset?'⚠ Confirm':'↺ Reset'}
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

            <Card>
              <SectionTitle>Latency por Exchange</SectionTitle>
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

        <TradeHistoryPanel
          lastTrade={data?.lastTrade}
          opportunitiesScanned={opportunitiesScanned}
          onSelectTrade={setSelectedTrade}
          resetSignal={historyResetSignal}
        />

        <style>{`
          @keyframes pulseDot { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.5;transform:scale(0.8)} }
        `}</style>

        {data?.ethOpportunities?.length > 0 && (
          <Card>
            <SectionTitle
              sub="Full bilateral engine — same 7-factor scoring model as BTC"
              right={<span style={{ fontSize:10, background:'rgba(88,65,217,0.15)', color:'#5741D9', padding:'2px 8px', borderRadius:4, fontWeight:700 }}>ETH BETA</span>}>
              ⬡ ETH Opportunities detected
            </SectionTitle>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                <thead>
                  <tr style={{ borderBottom:'1px solid var(--border)' }}>
                    {['Compra','Price compra','Venta','Price venta','Spread','Net Profit','Score','Status'].map(h => (
                      <th key={h} style={{ padding:'6px 10px', textAlign:'left', fontWeight:600, color:'var(--text-dim)', fontSize:10 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.ethOpportunities.slice(0, 8).map((op, i) => (
                    <tr key={i} style={{ borderBottom:'1px solid var(--border)', background: op.viable ? 'rgba(0,184,122,0.04)' : 'transparent' }}>
                      <td style={{ padding:'6px 10px' }}><ExDot name={op.buyExchange} /></td>
                      <td style={{ padding:'6px 10px', fontFamily:'var(--font-mono)' }}>${Number(op.buyPrice||0).toFixed(2)}</td>
                      <td style={{ padding:'6px 10px' }}><ExDot name={op.sellExchange} /></td>
                      <td style={{ padding:'6px 10px', fontFamily:'var(--font-mono)' }}>${Number(op.sellPrice||0).toFixed(2)}</td>
                      <td style={{ padding:'6px 10px', fontFamily:'var(--font-mono)' }}>{Number(op.spreadPct||0).toFixed(4)}%</td>
                      <td style={{ padding:'6px 10px', fontFamily:'var(--font-mono)', fontWeight:700, color:(op.netProfit||0)>=0?'var(--color-green)':'var(--color-red)' }}>
                        {(op.netProfit||0)>=0?'+':''}{fmtP(op.netProfit,4)}
                      </td>
                      <td style={{ padding:'6px 10px' }}>
                        {op.score != null && <span style={{ background:`${scoreColor(op.score)}20`, color:scoreColor(op.score), fontWeight:800, fontSize:9, padding:'1px 6px', borderRadius:4 }}>{op.score}</span>}
                      </td>
                      <td style={{ padding:'6px 10px' }}>
                        <span style={{ fontSize:9, fontWeight:800, padding:'2px 6px', borderRadius:99, background: op.viable ? 'var(--color-green-dim)' : 'rgba(255,255,255,0.05)', color: op.viable ? 'var(--color-green)' : 'var(--text-dim)' }}>
                          {op.viable ? '▲ VIABLE' : op.rejectionReason ? translateRejection(op.rejectionReason) : '—'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </>)}
      <LiveTradeTicker trade={data?.lastTrade} />
    </div>
  );
}
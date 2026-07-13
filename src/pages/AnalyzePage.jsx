// ─── AnalyzePage.jsx — Dataset Analysis Engine ───────────────────────────
// Advanced dataset analysis pipeline: upload any price CSV and run the full quant stack
// runs the full quantitative stack automatically
import { useState, useRef, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, BarChart, Bar, Cell, ReferenceLine, Legend } from 'recharts';
import { api } from '../api';
import { PageHeader } from '../components/common/PageHeader';
import { ErrorState, EmptyState } from '../components/common/StateViews';
import toast from 'react-hot-toast';

const fmt    = n => n == null ? '—' : n >= 1 ? `$${n.toLocaleString('en',{maximumFractionDigits:2})}` : `$${n?.toFixed(6)}`;
const fmtPct = n => n == null ? '—' : `${n>=0?'+':''}${Number(n).toFixed(2)}%`;

const REGIME_COLORS = {
  LIQUIDITY_COMPRESSION:'#f59e0b', BULLISH_EXPANSION:'#00b87a',
  BEARISH_CONTRACTION:'#f03e3e',   DISTRIBUTION:'#8b5cf6',
  ACCUMULATION:'#3b82f6',          VOLATILE_UNCERTAINTY:'#FF8C42',
};

function KpiCard({ label, value, color, sub }) {
  return (
    <div style={{ background:'var(--bg-surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'12px 14px', boxShadow:'var(--shadow-card)' }}>
      <div style={{ fontSize:9, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:5 }}>{label}</div>
      <div style={{ fontSize:17, fontWeight:900, color:color||'var(--text)', fontFamily:'var(--font-mono)', lineHeight:1.1 }}>{value}</div>
      {sub && <div style={{ fontSize:10, color:'var(--text-dim)', marginTop:3 }}>{sub}</div>}
    </div>
  );
}

function exportCSV(data, filename) {
  const csv = Object.keys(data[0]).join(',') + '\n' + data.map(r => Object.values(r).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function exportJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export default function AnalyzePage() {
  const [result,   setResult]   = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);
  const [filename, setFilename] = useState('');
  const [rawText,  setRawText]  = useState('');
  const [activeTab, setTab]     = useState('overview');
  const fileRef = useRef(null);

  const analyze = useCallback(async (csvText) => {
    setLoading(true); setError(null); setResult(null);
    try {
      // api.post wraps fetch with timeout, retry-backoff, and normalized errors.
      const result = await api.post('/api/dataset/analyze', { csv: csvText });
      setResult(result);
      toast.success(`Dataset analyzed: ${result.stats.rows} rows`);
    } catch (e) { setError(e.message); toast.error(e.message); }
    finally { setLoading(false); }
  }, []);

  const onFile = useCallback(e => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = ev => { const text = ev.target.result; setRawText(text); analyze(text); };
    reader.readAsText(file);
  }, [analyze]);

  const onDrop = useCallback(e => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = ev => { const text = ev.target.result; setRawText(text); analyze(text); };
    reader.readAsText(file);
  }, [analyze]);

  const loadExample = async () => {
    setLoading(true); setError(null);
    try {
      // /api/dataset/example returns CSV text, not JSON — use raw fetch here.
      // api.js is JSON-only; a dedicated non-JSON helper would be over-engineering.
      const r = await fetch('/api/dataset/example');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const csv = await r.text();
      setFilename('kukora_example.csv'); setRawText(csv);
      await analyze(csv);
    } catch (e) { setError(e.message); setLoading(false); }
  };

  const TABS = [
    { id:'overview',  label:'Summary' },
    { id:'chart',     label:'Chart' },
    { id:'regime',    label:'Regime + KCS' },
    { id:'backtest',  label:'Backtest' },
    { id:'forecast',  label:'Forecast' },
    { id:'export',    label:'Export' },
  ];

  const regimeColor = result ? (REGIME_COLORS[result.regime?.id] || '#f59e0b') : '#f59e0b';

  return (
    <div className="page-enter">
      <PageHeader
        title="Dataset Analyzer"
        description="Upload any price CSV and Kukora runs the full quantitative analytics stack automatically"
        badge="CSV"
        badgeColor="var(--color-primary)"
        help="Accepts CSV with columns: date/timestamp + price/close/value + volume (optional). Also accepts JSON. Runs: Regime, Anomalies, Monte Carlo, Backtest, Forecast."
        actions={
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-ghost btn-sm" onClick={loadExample}>Load ejemplo</button>
            <button className="btn btn-primary btn-sm" onClick={() => fileRef.current?.click()}>
              ↑ Upload CSV
            </button>
            <input ref={fileRef} type="file" accept=".csv,.txt,.json" style={{ display:'none' }} onChange={onFile} />
          </div>
        }
      />

      {/* Drop zone */}
      {!result && !loading && (
        <div
          onDrop={onDrop} onDragOver={e => e.preventDefault()}
          onClick={() => fileRef.current?.click()}
          style={{
            border: '2px dashed var(--border-bright)', borderRadius:'var(--radius-xl)',
            padding:'60px 20px', textAlign:'center', cursor:'pointer',
            background:'var(--bg-surface-2)', marginBottom:20, transition:'all 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor='var(--color-primary)'; e.currentTarget.style.background='var(--color-primary-dim)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor='var(--border-bright)'; e.currentTarget.style.background='var(--bg-surface-2)'; }}
        >
          <div style={{ fontSize:40, opacity:0.25, marginBottom:14 }}>↑</div>
          <div style={{ fontSize:15, fontWeight:700, marginBottom:6 }}>Drag your CSV here or click to upload</div>
          <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:16 }}>
            Format: <code style={{ background:'var(--bg-surface-3)', padding:'1px 6px', borderRadius:4, fontFamily:'var(--font-mono)' }}>date, price, volume</code> — columns detected automatically
          </div>
          <div style={{ display:'flex', gap:8, justifyContent:'center', flexWrap:'wrap' }}>
            <button className="btn btn-primary btn-sm" onClick={e => { e.stopPropagation(); fileRef.current?.click(); }}>↑ Upload CSV</button>
            <button className="btn btn-secondary btn-sm" onClick={e => { e.stopPropagation(); loadExample(); }}>Ver ejemplo</button>
          </div>
        </div>
      )}

      {error && <ErrorState error={error} onRetry={() => rawText && analyze(rawText)} style={{ marginBottom:20 }} />}

      {loading && (
        <div style={{ textAlign:'center', padding:60 }}>
          <div className="spinner" style={{ margin:'0 auto 16px', width:28, height:28 }} />
          <div style={{ fontSize:13, fontWeight:600 }}>Ejecutando analysis cuantitativo…</div>
          <div style={{ fontSize:11, color:'var(--text-dim)', marginTop:6 }}>Regime · KCS · Anomalies · Backtest · Forecast</div>
        </div>
      )}

      {result && !loading && (
        <>
          {/* File info bar */}
          <div style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 16px', background:'var(--bg-surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', marginBottom:20, flexWrap:'wrap' }}>
            <span style={{ fontSize:12, fontFamily:'var(--font-mono)', color:'var(--color-primary)', fontWeight:700 }}>{filename || 'dataset'}</span>
            <span style={{ fontSize:11, color:'var(--text-dim)' }}>{result.stats.rows} rows · {result.stats.startDate} → {result.stats.endDate}</span>
            {result.meta.hasVolume && <span style={{ fontSize:9, fontWeight:700, color:'var(--color-blue)', background:'var(--color-blue-dim)', padding:'2px 7px', borderRadius:99 }}>VOLUMEN ✓</span>}
            <button className="btn btn-ghost btn-sm" style={{ marginLeft:'auto', fontSize:11 }} onClick={() => { setResult(null); setFilename(''); setRawText(''); }}>
              ✕ Clear
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()} style={{ fontSize:11 }}>↑ New</button>
          </div>

          {/* KPI row */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(120px, 1fr))', gap:10, marginBottom:20 }}>
            <KpiCard label="Return Total" value={fmtPct(result.stats.totalReturn)} color={result.stats.totalReturn>=0?'var(--color-green)':'var(--color-red)'} />
            <KpiCard label="Price Home" value={fmt(result.stats.startPrice)} />
            <KpiCard label="Price Final"  value={fmt(result.stats.endPrice)} />
            <KpiCard label="Max Drawdown"  value={`-${result.stats.maxDrawdown?.toFixed(2)}%`} color="var(--color-red)" />
            <KpiCard label="Sharpe Ratio"  value={result.stats.sharpeRatio?.toFixed(3)} color={result.stats.sharpeRatio>1?'var(--color-green)':result.stats.sharpeRatio>0?'var(--color-yellow)':'var(--color-red)'} />
            <KpiCard label="Volatility σ" value={`${result.stats.dailyStdDev?.toFixed(2)}%/d`} color="var(--color-yellow)" />
            <KpiCard label="Días positivos" value={result.stats.positiveDays} sub={`de ${result.stats.rows} total`} />
            <KpiCard label="Regime" value={result.regime?.label?.split(' ')[0]} color={regimeColor} sub={`${result.regime?.confidence}% confidence`} />
          </div>

          {/* Tabs */}
          <div className="tab-nav" style={{ marginBottom:20 }}>
            {TABS.map(t => (
              <button key={t.id} className={`tab-btn${activeTab===t.id?' active':''}`} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>

          {/* Overview tab */}
          {activeTab==='overview' && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
              <div className="card">
                <div style={{ fontSize:13, fontWeight:700, marginBottom:14 }}>📊 Statistics descriptivas</div>
                {[
                  ['Return diario medio', fmtPct(result.stats.dailyMean)],
                  ['Daily std. deviation', `${result.stats.dailyStdDev?.toFixed(4)}%`],
                  ['Mejor day', fmtPct(result.stats.bestDay), 'var(--color-green)'],
                  ['Peor day',  fmtPct(result.stats.worstDay), 'var(--color-red)'],
                  ['Max Drawdown', `-${result.stats.maxDrawdown?.toFixed(3)}%`, 'var(--color-red)'],
                  ['Sharpe Ratio (anual)', result.stats.sharpeRatio?.toFixed(3), result.stats.sharpeRatio>1?'var(--color-green)':result.stats.sharpeRatio>0?'var(--color-yellow)':'var(--color-red)'],
                  ['Positive days', `${result.stats.positiveDays}/${result.stats.rows}`, 'var(--color-green)'],
                ].map(([label, value, color]) => (
                  <div key={label} style={{ display:'flex', justifyContent:'space-between', padding:'8px 0', borderBottom:'1px solid var(--border)' }}>
                    <span style={{ fontSize:12, color:'var(--text-muted)' }}>{label}</span>
                    <span style={{ fontSize:12, fontWeight:700, fontFamily:'var(--font-mono)', color:color||'var(--text)' }}>{value}</span>
                  </div>
                ))}
              </div>
              <div className="card">
                <div style={{ fontSize:13, fontWeight:700, marginBottom:14 }}>📈 Distribution de returns diarios</div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={result.chart.returnsDist} margin={{ top:4, right:8, left:0, bottom:0 }}>
                    <CartesianGrid stroke="rgba(0,0,0,0.05)" strokeDasharray="3 3" />
                    <XAxis dataKey="lo" tickFormatter={v=>v?.toFixed(1)+'%'} tick={{ fontSize:9, fill:'var(--text-dim)' }} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize:9, fill:'var(--text-dim)' }} />
                    <Tooltip contentStyle={{ background:'#fff', border:'1px solid var(--border)', borderRadius:8, fontSize:11 }} formatter={v=>[`${v} days`,'Frequency']} />
                    <Bar dataKey="count" radius={[2,2,0,0]}>
                      {result.chart.returnsDist.map((e,i) => <Cell key={i} fill={(e.lo+e.hi)/2>=0?'rgba(0,184,122,0.65)':'rgba(240,62,62,0.65)'} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Chart tab */}
          {activeTab==='chart' && (
            <div className="card">
              <div style={{ fontSize:13, fontWeight:700, marginBottom:4 }}>Price histórico · {result.chart.prices.length} puntos</div>
              <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:16 }}>Price original + SMA20</div>
              <ResponsiveContainer width="100%" height={340}>
                <LineChart data={result.chart.prices} margin={{ top:4, right:16, left:0, bottom:0 }}>
                  <CartesianGrid stroke="rgba(0,0,0,0.05)" strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize:9, fill:'var(--text-dim)' }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize:9, fill:'var(--text-dim)', fontFamily:'var(--font-mono)' }} domain={['auto','auto']} tickFormatter={v=>fmt(v)} />
                  <Tooltip contentStyle={{ background:'#fff', border:'1px solid var(--border)', borderRadius:8, fontSize:11 }} formatter={(v,n)=>[fmt(v), n==='price'?'Price':'SMA20']} />
                  <Legend formatter={n=>n==='price'?'Price':'SMA 20'} />
                  <Line type="monotone" dataKey="price" stroke="#3b82f6" strokeWidth={1.5} dot={false} />
                  <Line type="monotone" dataKey="sma20" stroke="#f59e0b" strokeWidth={1} dot={false} strokeDasharray="4 4" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Regime + KCS tab */}
          {activeTab==='regime' && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
              <div className="card">
                <div style={{ fontSize:11, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:14 }}>Market Regime Engine</div>
                <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:16 }}>
                  <div style={{ width:44, height:44, borderRadius:12, background:`${regimeColor}15`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:22, border:`1px solid ${regimeColor}25`, flexShrink:0 }}>
                    {result.regime?.icon || '◈'}
                  </div>
                  <div>
                    <div style={{ fontSize:18, fontWeight:900, color:regimeColor }}>{result.regime?.label}</div>
                    <div style={{ fontSize:11, color:'var(--text-dim)' }}>Confidence: {result.regime?.confidence}%</div>
                  </div>
                </div>
                <div style={{ height:5, background:'var(--bg-surface-3)', borderRadius:99, overflow:'hidden', marginBottom:12 }}>
                  <div style={{ height:'100%', width:`${result.regime?.confidence}%`, background:regimeColor, borderRadius:99 }} />
                </div>
                <p style={{ fontSize:12, color:'var(--text-muted)', lineHeight:1.6 }}>{result.regime?.description}</p>
                {result.regime?.interpretation && (
                  <div style={{ marginTop:12, padding:'10px 12px', background:'var(--bg-surface-2)', borderRadius:'var(--radius)', border:'1px solid var(--border)', fontSize:11, color:'var(--text-muted)', lineHeight:1.55 }}>
                    {result.regime.interpretation}
                  </div>
                )}
              </div>
              <div className="card">
                <div style={{ fontSize:11, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:14 }}>KCS — Kukora Composite Signal</div>
                <div style={{ textAlign:'center', marginBottom:16 }}>
                  <div style={{ fontSize:52, fontWeight:900, color:result.kcs?.color||'#f59e0b', fontFamily:'var(--font-mono)', lineHeight:1 }}>{result.kcs?.score}</div>
                  <div style={{ fontSize:12, fontWeight:700, color:result.kcs?.color, background:`${result.kcs?.color}15`, padding:'4px 14px', borderRadius:99, display:'inline-block', marginTop:6 }}>{result.kcs?.state}</div>
                </div>
                <p style={{ fontSize:12, color:'var(--text-muted)', lineHeight:1.55, marginBottom:14 }}>{result.kcs?.description}</p>
                {result.kcs?.components && Object.entries(result.kcs.components).map(([k,c]) => {
                  const col = c.score>=60?'var(--color-green)':c.score>=40?'var(--color-yellow)':'var(--color-red)';
                  return (
                    <div key={k} style={{ marginBottom:8 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                        <span style={{ fontSize:11, color:'var(--text-muted)' }}>{c.label}</span>
                        <span style={{ fontSize:11, fontWeight:700, fontFamily:'var(--font-mono)', color:col }}>{c.score}</span>
                      </div>
                      <div style={{ height:4, background:'var(--bg-surface-3)', borderRadius:99, overflow:'hidden' }}>
                        <div style={{ height:'100%', width:`${c.score}%`, background:col, borderRadius:99 }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Backtest tab */}
          {activeTab==='backtest' && (
            <div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))', gap:10, marginBottom:20 }}>
                <KpiCard label="Return Strategy" value={fmtPct(result.backtest.strategy.totalReturn)} color={result.backtest.strategy.totalReturn>=0?'var(--color-green)':'var(--color-red)'} />
                <KpiCard label="Return B&H"        value={fmtPct(result.backtest.buyHold.totalReturn)} color={result.backtest.buyHold.totalReturn>=0?'var(--color-green)':'var(--color-red)'} />
                <KpiCard label="Win Rate"           value={result.backtest.strategy.winRate!=null?`${result.backtest.strategy.winRate}%`:'—'} />
                <KpiCard label="Total Trades"       value={result.backtest.strategy.totalTrades??'—'} />
                <KpiCard label="Max Drawdown"       value={`-${result.backtest.strategy.maxDrawdown?.toFixed(2)}%`} color="var(--color-red)" />
                <KpiCard label="Sharpe Ratio"       value={result.backtest.strategy.sharpeRatio?.toFixed(3)} color={result.backtest.strategy.sharpeRatio>1?'var(--color-green)':'var(--color-yellow)'} />
              </div>
              <div className="card">
                <div style={{ fontSize:13, fontWeight:700, marginBottom:4 }}>Equity Curve — Strategy vs Buy & Hold</div>
                <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:16 }}>Capital inicial $10,000 · SMA Crossover</div>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={result.backtest.equityCurve} margin={{ top:4, right:16, left:0, bottom:0 }}>
                    <CartesianGrid stroke="rgba(0,0,0,0.05)" strokeDasharray="3 3" />
                    <XAxis dataKey="i" tick={{ fontSize:9, fill:'var(--text-dim)' }} />
                    <YAxis tick={{ fontSize:9, fill:'var(--text-dim)', fontFamily:'var(--font-mono)' }} tickFormatter={v=>`$${v?.toFixed(0)}`} domain={['auto','auto']} />
                    <Tooltip contentStyle={{ background:'#fff', border:'1px solid var(--border)', borderRadius:8, fontSize:11 }} formatter={(v,n)=>[`$${v?.toFixed(2)}`,n==='strategy'?'Strategy':'Buy & Hold']} />
                    <ReferenceLine y={10000} stroke="rgba(0,0,0,0.15)" strokeDasharray="4 4" label={{ value:'Capital inicial', position:'right', fontSize:9, fill:'var(--text-dim)' }} />
                    <Legend />
                    <Line type="monotone" dataKey="strategy" stroke="var(--color-primary)" strokeWidth={2} dot={false} name="strategy" />
                    <Line type="monotone" dataKey="buyHold"   stroke="var(--color-blue)"    strokeWidth={1.5} dot={false} name="buyHold" strokeDasharray="5 5" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Forecast tab */}
          {activeTab==='forecast' && (
            <div className="card">
              <div style={{ fontSize:13, fontWeight:700, marginBottom:4 }}>Forecast — 14 days</div>
              <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:16 }}>Model ensemble: SMA drift + Holt-Winters EWM · Interval de confidence 90%</div>
              {result.forecast ? (
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={result.forecast} margin={{ top:4, right:16, left:0, bottom:0 }}>
                    <CartesianGrid stroke="rgba(0,0,0,0.05)" strokeDasharray="3 3" />
                    <XAxis dataKey="h" tickFormatter={v=>`d+${v}`} tick={{ fontSize:10, fill:'var(--text-dim)' }} />
                    <YAxis tick={{ fontSize:9, fill:'var(--text-dim)', fontFamily:'var(--font-mono)' }} tickFormatter={v=>fmt(v)} domain={['auto','auto']} />
                    <Tooltip contentStyle={{ background:'#fff', border:'1px solid var(--border)', borderRadius:8, fontSize:11 }} formatter={(v,n)=>[fmt(v),n==='point'?'Projection':n==='upper'?'Maximum 90%':'Minimum 90%']} />
                    <Legend />
                    <Line type="monotone" dataKey="upper" stroke="rgba(0,184,122,0.35)" strokeWidth={1} dot={false} strokeDasharray="3 3" name="upper" />
                    <Line type="monotone" dataKey="point" stroke="var(--color-primary)" strokeWidth={2.5} dot={{ r:3 }} name="point" />
                    <Line type="monotone" dataKey="lower" stroke="rgba(240,62,62,0.35)" strokeWidth={1} dot={false} strokeDasharray="3 3" name="lower" />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState icon="◌" title="Sin proyecciones" description="El dataset no tiene suficientes datos para el model de forecast" />
              )}
            </div>
          )}

          {/* Export tab */}
          {activeTab==='export' && (
            <div className="card">
              <div style={{ fontSize:13, fontWeight:700, marginBottom:14 }}>Export results</div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px,1fr))', gap:10 }}>
                {[
                  { label:'Statistics completas', desc:'Todas las metrics cuantitativas', icon:'📊', onClick:()=>exportJSON(result.stats,'kukora_stats.json') },
                  { label:'Regime + KCS',           desc:'Regime de market y signal KCS',  icon:'◈', onClick:()=>exportJSON({regime:result.regime,kcs:result.kcs},'kukora_regime_kcs.json') },
                  { label:'Datos de price',         desc:'Serie temporal procesada',        icon:'📈', onClick:()=>exportCSV(result.chart.prices,'kukora_prices.csv') },
                  { label:'Distribution returns',   desc:'Histograma de returns diarios',  icon:'📉', onClick:()=>exportCSV(result.chart.returnsDist,'kukora_returns_dist.csv') },
                  { label:'Equity Curve',            desc:'Strategy vs Buy & Hold',        icon:'⟳', onClick:()=>exportCSV(result.backtest.equityCurve,'kukora_equity.csv') },
                  { label:'Forecast 14d',            desc:'Proyecciones con CI 90%',         icon:'◌', onClick:()=>result.forecast&&exportCSV(result.forecast,'kukora_forecast.csv') },
                  { label:'Analysis completo (JSON)',desc:'Todo el result del analysis',   icon:'💾', onClick:()=>exportJSON(result,'kukora_full_analysis.json') },
                ].map(item => (
                  <button key={item.label} onClick={item.onClick}
                    style={{ display:'flex', alignItems:'flex-start', gap:12, padding:'14px 16px', background:'var(--bg-surface-2)', border:'1px solid var(--border)', borderRadius:'var(--radius)', cursor:'pointer', textAlign:'left', transition:'all 0.13s' }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor='var(--color-primary)'; e.currentTarget.style.background='#fff'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor='var(--border)'; e.currentTarget.style.background='var(--bg-surface-2)'; }}>
                    <span style={{ fontSize:20 }}>{item.icon}</span>
                    <div>
                      <div style={{ fontSize:12, fontWeight:700, marginBottom:2 }}>{item.label}</div>
                      <div style={{ fontSize:10, color:'var(--text-muted)' }}>{item.desc}</div>
                    </div>
                    <span style={{ marginLeft:'auto', fontSize:11, color:'var(--text-dim)' }}>↓</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

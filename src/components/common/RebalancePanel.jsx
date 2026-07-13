/**
 * RebalancePanel.jsx — Kukora
 * Automated rebalancing — inventory analysis, optimal transfer suggestion,
 * simulated execution.
 */
import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { requestArbitrage } from '../../api';
import { Card, EX_COLORS, ALL_EXCHANGES } from './ArbitrageSharedComponents';


function STitle({ children, sub, right }) {
  return (
    <div style={{ padding:'12px 18px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
      <div>
        <div style={{ fontWeight:800, fontSize:13 }}>{children}</div>
        {sub && <div style={{ fontSize:10, color:'var(--text-dim)', marginTop:1 }}>{sub}</div>}
      </div>
      {right}
    </div>
  );
}

function SeverityBadge({ severity }) {
  const map = { high: { bg:'rgba(240,62,62,0.15)', color:'var(--color-red)', label:'⚠ HIGH' }, medium: { bg:'rgba(245,158,11,0.12)', color:'#F59E0B', label:'⚡ MEDIUM' }, low: { bg:'rgba(0,184,122,0.1)', color:'var(--color-green)', label:'✓ LOW' } };
  const s = map[severity] || map.low;
  return <span style={{ fontSize:9, fontWeight:800, padding:'2px 6px', borderRadius:3, background:s.bg, color:s.color }}>{s.label}</span>;
}

export default function RebalancePanel({ data }) {
  const [analysis,   setAnalysis]   = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [history,    setHistory]    = useState([]);
  const [summary,    setSummary]    = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [executing,  setExecuting]  = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [jA, jH] = await Promise.all([
        requestArbitrage('rebalance/analyze'),
        requestArbitrage('rebalance/history'),
      ]);
      if (jA?.ok) setAnalysis(jA.data);
      if (jH?.ok) { setHistory(jH.data); setSummary(jH.summary); }
    } catch { /* network error — panel shows last known rebalance state */ }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => {
    const id = setInterval(fetchAll, 8000);
    return () => clearInterval(id);
  }, [fetchAll]);

  const getSuggestion = async () => {
    setLoading(true);
    try {
      const j = await requestArbitrage('rebalance/suggest');
      if (j?.ok) {
        setSuggestion(j.data.suggestion);
        if (!j.data.suggestion) toast('✓ Balances within optimal thresholds — no rebalancing required', { icon:'⚖️' });
        else toast.success('Suggestion de rebalancing generada');
      }
    } catch (e) { toast.error(e.message); }
    setLoading(false);
  };

  const executeRebalance = async () => {
    if (!suggestion) return;
    setExecuting(true);
    try {
      const j = await requestArbitrage('rebalance/execute', { method: 'POST', body: { suggestion } });
      if (j?.ok) {
        toast.success(`✅ Simulated rebalance executed: ${suggestion.amount} ${suggestion.asset} from ${suggestion.from} → ${suggestion.to}`);
        setSuggestion(null);
        fetchAll();
      } else {
        toast.error(j.data?.reason || 'Error ejecutando rebalancing');
      }
    } catch (e) { toast.error(e.message); }
    setExecuting(false);
  };

  const wallets = data?.wallets || {};
  const usdtByEx = wallets.USDT || {};
  const btcByEx  = wallets.BTC  || {};
  const totalUSDT = Object.values(usdtByEx).reduce((a,b) => a+b, 0);
  const totalBTC  = Object.values(btcByEx).reduce((a,b) => a+b, 0);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

      {/* ── HEADER ──────────────────────────────────────────────────────── */}
      <div style={{ padding:'10px 14px', background:'rgba(0,184,122,0.05)', border:'1px solid rgba(0,184,122,0.18)', borderRadius:'var(--radius)', display:'flex', alignItems:'center', gap:10 }}>
        <span style={{ fontSize:18 }}>⚖️</span>
        <div>
          <div style={{ fontWeight:800, fontSize:13, color:'var(--color-green)' }}>Inventory & Wallets — Rebalancing Inteligente</div>
          <div style={{ fontSize:11, color:'var(--text-dim)', lineHeight:1.55 }}>
            Arbitrage requires pre-funded capital simultaneously on both sides of each trade. This module detects imbalances across exchanges, calculates the optimal transfer with real costs (withdrawal fee + transfer slippage) and simulates execution with immediate wallet effect. Unresolved imbalances directly reduce fill rate.
          </div>
        </div>
        <button onClick={getSuggestion} disabled={loading}
          style={{ marginLeft:'auto', padding:'8px 16px', borderRadius:6, fontWeight:700, fontSize:12, cursor:'pointer', background:'var(--color-green)', color:'#000', border:'none', flexShrink:0 }}>
          {loading ? '⏳' : '🔍 Analyze'}
        </button>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>

        {/* ── DISTRIBUCIÓN ACTUAL ────────────────────────────────────────── */}
        <Card>
          <STitle sub={`Total: $${totalUSDT.toFixed(0)} USDT | ${totalBTC.toFixed(4)} BTC`}>Distribution actual</STitle>
          <div style={{ padding:'10px 16px' }}>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--text-dim)', marginBottom:6 }}>USDT por exchange</div>
            {ALL_EXCHANGES.map(ex => {
              const usdt = usdtByEx[ex] || 0;
              const pct  = totalUSDT > 0 ? usdt / totalUSDT * 100 : 0;
              const isHigh = pct > 70;
              return (
                <div key={ex} style={{ marginBottom:8 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3, fontSize:11 }}>
                    <span style={{ display:'flex', alignItems:'center', gap:5 }}>
                      <span style={{ width:7, height:7, borderRadius:'50%', background:EX_COLORS[ex], display:'inline-block' }}/>
                      {ex}
                    </span>
                    <span style={{ fontWeight:700, color: isHigh ? 'var(--color-red)' : 'var(--text)' }}>
                      ${usdt.toFixed(0)} <span style={{ fontSize:9, color:'var(--text-dim)' }}>({pct.toFixed(1)}%)</span>
                      {isHigh && <span style={{ marginLeft:4, fontSize:9, color:'var(--color-red)' }}>▲ concentrado</span>}
                    </span>
                  </div>
                  <div style={{ height:4, background:'var(--border)', borderRadius:2, overflow:'hidden' }}>
                    <div style={{ width:`${pct}%`, height:'100%', background: isHigh ? 'var(--color-red)' : EX_COLORS[ex], borderRadius:2 }}/>
                  </div>
                </div>
              );
            })}
            <div style={{ marginTop:12, fontSize:11, fontWeight:700, color:'var(--text-dim)', marginBottom:6 }}>BTC por exchange</div>
            {ALL_EXCHANGES.map(ex => {
              const btc = btcByEx[ex] || 0;
              const pct = totalBTC > 0 ? btc / totalBTC * 100 : 0;
              return (
                <div key={ex} style={{ display:'flex', justifyContent:'space-between', fontSize:11, padding:'2px 0' }}>
                  <span style={{ display:'flex', alignItems:'center', gap:5 }}>
                    <span style={{ width:6, height:6, borderRadius:'50%', background:EX_COLORS[ex], display:'inline-block' }}/>
                    {ex}
                  </span>
                  <span style={{ fontWeight:600 }}>{btc.toFixed(4)} BTC <span style={{ color:'var(--text-dim)', fontSize:9 }}>({pct.toFixed(1)}%)</span></span>
                </div>
              );
            })}
          </div>
        </Card>

        {/* ── DESBALANCES + SUGERENCIA ───────────────────────────────────── */}
        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
          <Card>
            <STitle sub={analysis?.healthy ? '✓ Sin desbalances criticals' : `${analysis?.imbalances?.length || 0} desbalance(s) detectado(s)`}>
              Balance analysis
            </STitle>
            <div style={{ padding:'10px 16px' }}>
              {!analysis && <div style={{ color:'var(--text-dim)', fontSize:12 }}>Haz click en &ldquo;Analyze&rdquo; para detectar desbalances</div>}
              {analysis?.healthy && (
                <div style={{ padding:'10px', background:'rgba(0,184,122,0.08)', borderRadius:6, color:'var(--color-green)', fontSize:12, fontWeight:700 }}>
                  ✅ Todos los exchanges dentro de thresholdes optimals
                </div>
              )}
              {analysis?.imbalances?.map((imb, i) => (
                <div key={i} style={{ padding:'8px 10px', background:'rgba(240,62,62,0.06)', border:'1px solid rgba(240,62,62,0.2)', borderRadius:6, marginBottom:6 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                    <span style={{ fontSize:11, fontWeight:700 }}>{imb.exchange}</span>
                    <SeverityBadge severity={imb.severity} />
                  </div>
                  <div style={{ fontSize:11, color:'var(--text-dim)' }}>{imb.description}</div>
                  {imb.excessUSD  && <div style={{ fontSize:10, color:'var(--color-red)', marginTop:2 }}>Exceso: ${imb.excessUSD.toFixed(0)}</div>}
                  {imb.deficitUSD && <div style={{ fontSize:10, color:'var(--color-red)', marginTop:2 }}>Deficit: ${imb.deficitUSD.toFixed(0)}</div>}
                </div>
              ))}
            </div>
          </Card>

          {/* ── SUGERENCIA DE REBALANCEO ─────────────────────────────────── */}
          {suggestion && (
            <Card style={{ border:'1px solid rgba(0,184,122,0.3)', background:'rgba(0,184,122,0.04)' }}>
              <STitle sub="Movimiento optimal calculado con costos reales">Suggestion de rebalancing</STitle>
              <div style={{ padding:'12px 16px' }}>
                <div style={{ fontSize:14, fontWeight:800, marginBottom:8 }}>
                  {suggestion.amount} {suggestion.asset}
                  <span style={{ color:'var(--text-dim)', margin:'0 8px' }}>→</span>
                  <span style={{ color:EX_COLORS[suggestion.from] }}>{suggestion.from}</span>
                  <span style={{ color:'var(--text-dim)', margin:'0 6px' }}>⟶</span>
                  <span style={{ color:EX_COLORS[suggestion.to] }}>{suggestion.to}</span>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginBottom:10 }}>
                  {[
                    ['Withdrawal fee',  `${suggestion.asset === 'BTC' ? suggestion.withdrawalFee + ' BTC' : '$' + suggestion.withdrawalFee}`],
                    ['Spread estimado', `$${suggestion.estimatedSpreadCost}`],
                    ['Costo total',     `$${suggestion.netCost}`, 'var(--color-red)'],
                    ['Beneficio neto',  `$${suggestion.netBenefit}`, 'var(--color-green)'],
                  ].map(([label, val, color]) => (
                    <div key={label} style={{ fontSize:11 }}>
                      <div style={{ color:'var(--text-dim)' }}>{label}</div>
                      <div style={{ fontWeight:800, color: color || 'var(--text)' }}>{val}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize:10, color:'var(--text-dim)', marginBottom:10, background:'rgba(0,184,122,0.06)', padding:'6px 8px', borderRadius:4 }}>
                  {suggestion.expectedImpact}
                </div>
                <button onClick={executeRebalance} disabled={executing}
                  style={{ width:'100%', padding:'10px', borderRadius:7, fontWeight:800, fontSize:13, cursor:'pointer', background:'linear-gradient(135deg,#00B87A,#0099CC)', color:'#fff', border:'none', opacity: executing ? 0.7 : 1 }}>
                  {executing ? '⏳ Running...' : `✅ Execute rebalancing (simulated)`}
                </button>
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* ── HISTORIAL ──────────────────────────────────────────────────────── */}
      {history.length > 0 && (
        <Card>
          <STitle sub={`${summary?.total || 0} rebalancings | Costo total: $${summary?.totalCost || 0}`}>
            History de rebalancings
          </STitle>
          {summary?.autoRebalance && (
            <div style={{
              fontSize: 11, marginBottom: 10, padding: '6px 10px', borderRadius: 4,
              background: summary.autoRebalance.enabled ? 'rgba(0,184,122,0.06)' : 'var(--bg-elevated)',
              color: summary.autoRebalance.enabled ? 'var(--color-green)' : 'var(--text-dim)',
              display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
            }}>
              <span>{summary.autoRebalance.enabled ? '🔄 Auto-rebalanceo: ACTIVO' : '⏸ Auto-rebalanceo: inactivo (configurable en Live Config)'}</span>
              {summary.autoRebalance.enabled && (
                <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>
                  · severidad mínima: {summary.autoRebalance.minSeverity}
                  · último disparo automático: {summary.autoRebalance.lastAutoExecutionTs ? new Date(summary.autoRebalance.lastAutoExecutionTs).toLocaleString() : 'ninguno todavía'}
                </span>
              )}
            </div>
          )}
          {summary?.costRatio && (
            <div style={{
              fontSize: 11, marginBottom: 10, padding: '6px 10px', borderRadius: 4,
              background: summary.costRatio.alert ? 'rgba(255,90,90,0.10)' : 'rgba(0,184,122,0.06)',
              color: summary.costRatio.alert ? 'var(--color-red)' : 'var(--text-dim)',
              fontWeight: summary.costRatio.alert ? 700 : 400,
            }}>
              {summary.costRatio.ratioPct !== null
                ? `Costo de rebalanceo: ${summary.costRatio.ratioPct}% del profit realizado del período (umbral de alerta: ${summary.costRatio.alertThresholdPct}%)${summary.costRatio.alert ? ' ⚠️ por encima del umbral' : ''}`
                : summary.costRatio.note}
            </div>
          )}
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
              <thead>
                <tr style={{ borderBottom:'1px solid var(--border)' }}>
                  {['Time','Asset','From','To','Amount','Cost','Net benefit','Reason'].map(h => (
                    <th key={h} style={{ padding:'6px 10px', textAlign:'left', fontWeight:600, color:'var(--text-dim)', fontSize:10 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 15).map((r, i) => (
                  <tr key={i} style={{ borderBottom:'1px solid var(--border)' }}>
                    <td style={{ padding:'6px 10px', color:'var(--text-dim)' }}>{new Date(r.ts).toLocaleTimeString()}</td>
                    <td style={{ padding:'6px 10px', fontWeight:700 }}>{r.asset}</td>
                    <td style={{ padding:'6px 10px', color:EX_COLORS[r.from] }}>{r.from}</td>
                    <td style={{ padding:'6px 10px', color:EX_COLORS[r.to] }}>{r.to}</td>
                    <td style={{ padding:'6px 10px' }}>{r.amount} {r.asset}</td>
                    <td style={{ padding:'6px 10px', color:'var(--color-red)' }}>${r.netCost}</td>
                    <td style={{ padding:'6px 10px', color:'var(--color-green)', fontWeight:700 }}>${r.netBenefit}</td>
                    <td style={{ padding:'6px 10px', color:'var(--text-dim)', maxWidth:160, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

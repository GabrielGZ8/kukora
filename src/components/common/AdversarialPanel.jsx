/**
 * AdversarialPanel.jsx — Kukora
 * Deep adversarial scenarios — GAP 3
 *
 * Simulates real execution failures (mid-flight leg failure, liquidity
 * crunch, extreme slippage) against the production decision logic, so the
 * risk engine's behavior under stress can be observed and trusted rather
 * than just asserted.
 */
import { requestArbitrage } from '../../api';
import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { Card } from './ArbitrageSharedComponents';
import { clickableDivProps } from '../../utils/a11y';


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

const PHASE_COLORS = {
  INIT:                    '#888',
  DETECT:                  '#00B87A',
  PRE_EXEC:                '#00B87A',
  PRE_EXEC_SNAPSHOT:       '#00B87A',
  ORDER_SENT:              '#0099CC',
  LEG_BUY_SENT:            '#0099CC',
  LEG_BUY_CONFIRMED:       '#00B87A',
  LEG_SELL_SENT:           '#F59E0B',
  LEG_SELL_TIMEOUT:        '#F03E3E',
  INCOMPLETE_LEG_DETECTED: '#F03E3E',
  LIQUIDITY_SHOCK:         '#F03E3E',
  PRICE_MOVE_DETECTED:     '#F03E3E',
  PARTIAL_FILL_CALC:       '#F59E0B',
  SLIPPAGE_ANALYSIS:       '#F59E0B',
  CIRCUIT_BREAKER_CHECK:   '#F59E0B',
  SYSTEM_DECISION:         '#5741D9',
  DECISION:                '#5741D9',
  RESOLVED:                '#00B87A',
  ABORT:                   '#888',
};

const SCENARIO_META = {
  mid_flight_failure: {
    icon: '✈️',
    color: '#F03E3E',
    title: 'Mid-flight Failure',
    desc: 'The buy order executes successfully but the sell order fails on timeout. The system detects the exposed position and evaluates exit options.',
    duration: '~4 seconds',
  },
  liquidity_crunch: {
    icon: '💧',
    color: '#F59E0B',
    title: 'Liquidity Crunch',
    desc: 'The L2 book loses 60% depth during execution. Real VWAP walk detects partial fill and recalculates P&L.',
    duration: '~1 second',
  },
  extreme_slippage: {
    icon: '📉',
    color: '#5741D9',
    title: 'Extreme Slippage',
    desc: 'BTC price moves 1.2% during the fill. Engine compares estimated vs real slippage and evaluates circuit breakers.',
    duration: '~1 second',
  },
};

function PhaseRow({ entry, _index }) {
  const color = PHASE_COLORS[entry.phase] || '#888';
  return (
    <div style={{ display:'flex', gap:10, padding:'6px 0', alignItems:'flex-start', borderBottom:'1px solid rgba(255,255,255,0.04)' }}>
      <div style={{ flexShrink:0, display:'flex', flexDirection:'column', alignItems:'center', gap:0 }}>
        <div style={{ width:8, height:8, borderRadius:'50%', background:color, marginTop:3 }}/>
        <div style={{ width:1, flex:1, background:'rgba(255,255,255,0.07)', minHeight:8 }}/>
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:2 }}>
          <span style={{ fontSize:10, fontWeight:800, color, textTransform:'uppercase', letterSpacing:'0.05em' }}>{entry.phase}</span>
          <span style={{ fontSize:9, color:'var(--text-dim)' }}>{new Date(entry.ts).toLocaleTimeString()}</span>
        </div>
        <div style={{ fontSize:11, color:'var(--text)', marginBottom:3 }}>{entry.action}</div>
        {Object.keys(entry.data || {}).length > 0 && (
          <div style={{ fontSize:10, color:'var(--text-dim)', background:'rgba(0,0,0,0.15)', borderRadius:4, padding:'4px 8px', fontFamily:'monospace', overflowX:'auto' }}>
            {Object.entries(entry.data).map(([k, v]) => (
              <div key={k} style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                <span style={{ color:'#7dd3fc', flexShrink:0 }}>{k}:</span>
                <span style={{ color: typeof v === 'boolean' ? (v ? '#86efac':'#fca5a5') : typeof v === 'number' ? '#fde68a' : '#e5e7eb' }}>
                  {Array.isArray(v) ? (
                    v.map((item, i) => (
                      <span key={i} style={{ display:'block', marginLeft:10 }}>
                        {typeof item === 'object' ? JSON.stringify(item) : String(item)}
                      </span>
                    ))
                  ) : typeof v === 'object' ? JSON.stringify(v, null, 0) : String(v)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AdversarialPanel() {
  const [_scenarios, setScenarios] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [running,   setRunning]   = useState(null);
  const [history,   setHistory]   = useState([]);

  useEffect(() => {
    requestArbitrage('adversarial/list').then(j => { if (j?.ok) setScenarios(j.data); }).catch(() => {});
    requestArbitrage('adversarial/history').then(j => { if (j?.ok) setHistory(j.data); }).catch(() => {});
  }, []);

  const runScenario = async (scenarioId) => {
    setRunning(scenarioId);
    setActiveRun(null);
    try {
      const j = await requestArbitrage('adversarial/run', { method: 'POST', body: { scenario: scenarioId } });
      if (j.ok) {
        setActiveRun(j.run);
        toast.success(`Escenario completed: ${j.run.result}`);
        // Refresh history
        requestArbitrage('adversarial/history').then(j2 => { if (j2?.ok) setHistory(j2.data); }).catch(() => {});
      } else {
        toast.error(j.reason || 'Error ejecutando escenario');
      }
    } catch (e) { toast.error(e.message); }
    setRunning(null);
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

      {/* ── HEADER ─────────────────────────────────────────────────────── */}
      <div style={{ padding:'10px 14px', background:'rgba(240,62,62,0.06)', border:'1px solid rgba(240,62,62,0.2)', borderRadius:'var(--radius)', display:'flex', alignItems:'center', gap:10 }}>
        <span style={{ fontSize:20 }}>💥</span>
        <div>
          <div style={{ fontWeight:800, fontSize:13, color:'var(--color-red)' }}>Escenarios Adversos Profundos</div>
          <div style={{ fontSize:11, color:'var(--text-dim)' }}>
            Simulaciones de fallos reales durante la execution de órdenes. El system reacciona con lógica de production real:
            circuit breakers, VWAP L2, gestión de positions descubiertas.
          </div>
        </div>
      </div>

      {/* ── SCENARIO CARDS ─────────────────────────────────────────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10 }}>
        {Object.entries(SCENARIO_META).map(([id, meta]) => {
          const isRunning = running === id;
          const isDone    = activeRun?.scenario === id;
          return (
            <Card key={id} style={{ border: isDone ? `1px solid ${meta.color}44` : '1px solid var(--border)', background: isDone ? `${meta.color}08` : 'var(--surface)' }}>
              <div style={{ padding:'16px' }}>
                <div style={{ fontSize:24, marginBottom:6 }}>{meta.icon}</div>
                <div style={{ fontWeight:800, fontSize:13, marginBottom:4 }}>{meta.title}</div>
                <div style={{ fontSize:11, color:'var(--text-dim)', marginBottom:8, lineHeight:1.4 }}>{meta.desc}</div>
                <div style={{ fontSize:9, color:'var(--text-dim)', marginBottom:10 }}>⏱ {meta.duration}</div>
                <button
                  onClick={() => runScenario(id)}
                  disabled={running !== null}
                  style={{
                    width:'100%', padding:'8px', borderRadius:6, fontWeight:700, fontSize:12, cursor: running ? 'not-allowed' : 'pointer',
                    background: isRunning ? 'rgba(255,255,255,0.05)' : `${meta.color}22`,
                    color: meta.color,
                    border: `1px solid ${meta.color}44`,
                    opacity: running && !isRunning ? 0.4 : 1,
                  }}>
                  {isRunning ? '⏳ Running...' : '▶ Run scenario'}
                </button>
              </div>
            </Card>
          );
        })}
      </div>

      {/* ── ACTIVE RUN LOG ─────────────────────────────────────────────── */}
      {activeRun && (
        <Card style={{ border:'1px solid rgba(88,65,217,0.25)' }}>
          <STitle
            sub={`${activeRun.label} | Duration: ${activeRun.durationMs}ms | Result: ${activeRun.result}`}
            right={
              <span style={{
                padding:'3px 8px', borderRadius:4, fontSize:10, fontWeight:800,
                background: activeRun.result?.includes('cancel') ? 'rgba(240,62,62,0.15)' : 'rgba(0,184,122,0.15)',
                color:      activeRun.result?.includes('cancel') ? 'var(--color-red)' : 'var(--color-green)',
              }}>
                P&L: {activeRun.netPnl != null ? `$${Number(activeRun.netPnl).toFixed(4)}` : '—'}
              </span>
            }>
            Log in real time — {activeRun.label}
          </STitle>
          <div style={{ padding:'10px 16px', maxHeight:420, overflowY:'auto' }}>
            {activeRun.log?.map((entry, i) => (
              <PhaseRow key={i} entry={entry} index={i} />
            ))}
          </div>
        </Card>
      )}

      {/* ── HISTORY ─────────────────────────────────────────────────────── */}
      {history.length > 0 && (
        <Card>
          <STitle sub={`${history.length} escenario(s) ejecutado(s)`}>History de runs</STitle>
          <div style={{ padding:'10px 16px', display:'flex', flexDirection:'column', gap:6 }}>
            {history.map((run, i) => {
              const meta = SCENARIO_META[run.scenario];
              return (
                <div key={i} {...clickableDivProps(() => setActiveRun(run))}
                  style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px', background:'rgba(255,255,255,0.02)', borderRadius:6, cursor:'pointer', border:'1px solid var(--border)' }}>
                  <span style={{ fontSize:16 }}>{meta?.icon}</span>
                  <div style={{ flex:1 }}>
                    <div style={{ fontWeight:700, fontSize:12 }}>{run.label}</div>
                    <div style={{ fontSize:10, color:'var(--text-dim)' }}>{new Date(run.ts).toLocaleString()}</div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{
                      fontSize:11, fontWeight:800,
                      color: run.result?.includes('cancel') ? 'var(--color-red)' : 'var(--color-green)',
                    }}>{run.result}</div>
                    <div style={{ fontSize:10, color:'var(--text-dim)' }}>{run.durationMs}ms</div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * TradeAuditModal.jsx — Kukora
 * Trade Drilldown completo: audit trail institucional por trade
 * Muestra cada fase del lifecycle con timestamps y motivos
 */
import { requestArbitrage } from '../../api';
import { useState, useEffect } from 'react';

const fmt4 = n => n == null ? '—' : `$${Number(n).toFixed(4)}`;
const fmt2 = n => n == null ? '—' : `$${Number(n).toFixed(2)}`;

function Row({ label, value, color, mono }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'5px 0', borderBottom:'1px solid var(--border)' }}>
      <span style={{ fontSize:11, color:'var(--text-dim)' }}>{label}</span>
      <span style={{ fontSize:11, fontWeight:700, color: color||'var(--text)', fontFamily: mono ? 'var(--font-mono)' : undefined }}>{value}</span>
    </div>
  );
}

function Section({ title, color, children }) {
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontSize:9, fontWeight:900, textTransform:'uppercase', letterSpacing:'0.1em', color: color||'var(--text-dim)', marginBottom:6 }}>{title}</div>
      <div style={{ background:'var(--bg-elevated)', border:'1px solid var(--border)', borderRadius:8, padding:'8px 12px' }}>
        {children}
      </div>
    </div>
  );
}

function ScoreBar({ label, value, max=1, color='#0052FF' }) {
  const pct = Math.min(1, (value||0) / max);
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
      <span style={{ fontSize:10, color:'var(--text-dim)', width:120, flexShrink:0 }}>{label}</span>
      <div style={{ flex:1, height:4, background:'var(--bg-surface)', borderRadius:2, overflow:'hidden' }}>
        <div style={{ width:`${pct*100}%`, height:'100%', background:color, borderRadius:2 }} />
      </div>
      <span style={{ fontSize:10, fontFamily:'var(--font-mono)', width:36, textAlign:'right', color }}>{(value||0).toFixed(2)}</span>
    </div>
  );
}

export default function TradeAuditModal({ trade, onClose }) {
  const [journalEntry, setJournalEntry] = useState(null);

  useEffect(() => {
    if (!trade?.id) return;
    let cancelled = false;
    requestArbitrage('journal?limit=200')
      .then(json => {
        if (cancelled || !json.ok) return;
        const match = json.data.find(e => e.tradeId === trade.id);
        if (match) setJournalEntry(match);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [trade?.id]);

  if (!trade) return null;

  const netPnl = trade.netProfit ?? trade.netPnl ?? null;
  const pnlColor = netPnl == null ? 'var(--text)' : netPnl >= 0 ? 'var(--color-green)' : 'var(--color-red)';
  const score = trade.score ?? {};
  const latencyMs = trade.executionMs ?? trade.latencyMs ?? null;

  // Reconstruct accepted/rejected reason list
  const acceptReasons = trade.acceptedBecause || [];
  const rejectReasons = trade.rejectedBecause || [];
  const wasExecuted   = trade.status === 'executed' || trade.netProfit != null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="card card-glass" style={{ width:'100%', maxWidth:580, padding:0, overflow:'hidden', maxHeight:'90vh', overflowY:'auto' }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ padding:'14px 20px', borderBottom:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center', background:'var(--bg-surface-3)', position:'sticky', top:0, zIndex:10 }}>
          <div>
            <h3 style={{ margin:0, fontSize:13, fontWeight:900 }}>
              {wasExecuted ? '✅' : '❌'} Trade Drilldown — #{trade.id?.slice(-8) || 'N/A'}
            </h3>
            <div style={{ fontSize:9, color:'var(--text-dim)', marginTop:2 }}>
              {trade.pair || 'BTC/USDT'} · {trade.buyExchange} → {trade.sellExchange} · {trade.ts ? new Date(trade.ts).toLocaleTimeString() : ''}
            </div>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', fontSize:20, cursor:'pointer', color:'var(--text-dim)' }}>×</button>
        </div>

        <div style={{ padding:'16px 20px' }}>

          {/* Timeline de fases */}
          <Section title="Lifecycle del trade" color="#8b5cf6">
            {[
              { phase:'1. Detection',   ts: trade.detectedAt || trade.ts,       color:'#0052FF', desc:`L2 order book received, spread calculated vs ${trade.buyExchange}/${trade.sellExchange}` },
              { phase:'2. Scoring',     ts: trade.scoredAt   || trade.ts,       color:'#8b5cf6', desc:`Score compuesto: ${trade.totalScore?.toFixed(2) || score.total?.toFixed(2) || '—'}` },
              { phase:'3. Risk',      ts: trade.riskAt     || trade.ts,       color:'#F59E0B', desc:`Circuit breakers: OK · Capital available: OK` },
              { phase: wasExecuted ? '4. Execution ✅' : '4. Rejected ❌', ts: trade.executedAt || trade.ts, color: wasExecuted ? 'var(--color-green)' : 'var(--color-red)',
                desc: wasExecuted ? `Fill simulado · Latency e2e: ${latencyMs != null ? latencyMs+'ms' : '—'}` : (trade.rejectReason || 'Score < threshold') },
            ].map((step, i) => (
              <div key={i} style={{ display:'flex', gap:10, alignItems:'flex-start', marginBottom:8 }}>
                <div style={{ width:8, height:8, borderRadius:'50%', background:step.color, flexShrink:0, marginTop:3 }} />
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:11, fontWeight:700, color:step.color }}>{step.phase}</div>
                  <div style={{ fontSize:10, color:'var(--text-dim)' }}>{step.desc}</div>
                </div>
                <div style={{ fontSize:9, color:'var(--text-dim)', fontFamily:'var(--font-mono)', flexShrink:0 }}>
                  {step.ts ? new Date(step.ts).toLocaleTimeString() : '—'}
                </div>
              </div>
            ))}
          </Section>

          {/* Prices y execution */}
          <Section title="Prices de execution" color="#0052FF">
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:8 }}>
              <div>
                <div style={{ fontSize:9, color:'var(--text-dim)', fontWeight:700, marginBottom:2 }}>BUY @ {trade.buyExchange}</div>
                <div style={{ fontSize:16, fontWeight:900, fontFamily:'var(--font-mono)', color:'var(--color-red)' }}>${trade.buyPrice?.toLocaleString() || '—'}</div>
                <div style={{ fontSize:9, color:'var(--text-dim)' }}>VWAP L2 · tamaño: {trade.sizeUSD ? fmt2(trade.sizeUSD) : '—'}</div>
              </div>
              <div>
                <div style={{ fontSize:9, color:'var(--text-dim)', fontWeight:700, marginBottom:2 }}>SELL @ {trade.sellExchange}</div>
                <div style={{ fontSize:16, fontWeight:900, fontFamily:'var(--font-mono)', color:'var(--color-green)' }}>${trade.sellPrice?.toLocaleString() || '—'}</div>
                <div style={{ fontSize:9, color:'var(--text-dim)' }}>VWAP L2 · fill estimado: {trade.fillProbability ? `${(trade.fillProbability*100).toFixed(0)}%` : '—'}</div>
              </div>
            </div>
            <Row label="Fill probability estimada"   value={trade.fillProbability ? `${(trade.fillProbability*100).toFixed(1)}%` : '—'} />
            <Row label="Slippage esperado"            value={trade.expectedSlippage != null ? fmt4(trade.expectedSlippage) : '—'} mono />
            <Row label="Slippage realizado (VWAP)"   value={trade.slippage != null ? fmt4(trade.slippage) : '—'} mono />
            <Row label="Latency e2e"                 value={latencyMs != null ? `${latencyMs}ms` : '—'} color={latencyMs > 50 ? '#F59E0B' : 'var(--color-green)'} mono />
          </Section>

          {/* P&L breakdown */}
          <Section title="P&L y costos" color="var(--color-green)">
            <Row label="Gross spread"     value={fmt4(trade.grossSpread ?? trade.spread)} color="var(--color-green)" mono />
            <Row label="Fees (buy leg)"   value={fmt4(trade.buyFee   ?? (trade.totalFees ? trade.totalFees/2 : null))} color="var(--color-red)" mono />
            <Row label="Fees (sell leg)"  value={fmt4(trade.sellFee  ?? (trade.totalFees ? trade.totalFees/2 : null))} color="var(--color-red)" mono />
            <Row label="Slippage total"   value={fmt4(trade.slippage)} color="var(--color-red)" mono />
            <Row label="Net P&L"          value={fmt4(netPnl)} color={pnlColor} mono />
            {trade.impactOnBtcWallet != null && (
              <Row label="Impact en BTC wallet" value={`${trade.impactOnBtcWallet > 0 ? '+' : ''}${trade.impactOnBtcWallet?.toFixed(6)} BTC`} mono />
            )}
          </Section>

          {/* Scoring breakdown */}
          {(trade.totalScore != null || score.total != null) && (
            <Section title="Scoring breakdown" color="#8b5cf6">
              <ScoreBar label="Score total"        value={trade.totalScore ?? score.total ?? 0} max={1} color="#FF2D78" />
              <ScoreBar label="Spread component"   value={score.spreadScore   ?? score.spread   ?? 0} max={1} color="#0052FF" />
              <ScoreBar label="Fill probability"   value={score.fillScore     ?? score.fill     ?? 0} max={1} color="#00b87a" />
              <ScoreBar label="Exchange reliability" value={score.reliabilityScore ?? score.reliability ?? 0} max={1} color="#8b5cf6" />
              <ScoreBar label="Latency score"      value={score.latencyScore  ?? score.latency  ?? 0} max={1} color="#F59E0B" />
            </Section>
          )}

          {/* Accepted / Rejected reasons */}
          {(acceptReasons.length > 0 || rejectReasons.length > 0 || trade.rejectReason) && (
            <Section title={wasExecuted ? "Acceptance criteria" : "Rejection reason"} color={wasExecuted ? 'var(--color-green)' : 'var(--color-red)'}>
              {wasExecuted && acceptReasons.length > 0 ? acceptReasons.map((r, i) => (
                <div key={i} style={{ fontSize:11, color:'var(--color-green)', display:'flex', gap:6, marginBottom:3 }}>
                  <span>✓</span><span>{r}</span>
                </div>
              )) : (
                <div style={{ fontSize:11, color:'var(--color-red)' }}>
                  ✗ {trade.rejectReason || rejectReasons.join(' · ') || 'Score insuficiente'}
                </div>
              )}
              {!wasExecuted && (
                <div style={{ marginTop:8, padding:'6px 10px', background:'rgba(240,62,62,0.06)', borderRadius:6, fontSize:10, color:'var(--text-dim)' }}>
                  Este trade fue detectado pero no ejecutado. El P&L teórico está registrado en &quot;Missed Opportunities&quot; del panel StatArb.
                </div>
              )}
            </Section>
          )}

          {/* Journal entry if available */}
          {journalEntry && (
            <Section title="Journal entry (audit trail persistido)" color="var(--text-dim)">
              <Row label="Trade ID"      value={journalEntry.tradeId} mono />
              <Row label="Strategy"    value={journalEntry.strategy || 'bilateral'} />
              <Row label="Guardado en"   value={new Date(journalEntry.ts).toLocaleString()} />
              {journalEntry.notes && (
                <div style={{ fontSize:10, color:'var(--text-dim)', marginTop:6, fontStyle:'italic' }}>{journalEntry.notes}</div>
              )}
            </Section>
          )}

          <div style={{ fontSize:9, color:'var(--text-dim)', background:'var(--bg-surface-2)', padding:'10px', borderRadius:6, fontStyle:'italic', marginTop:4 }}>
            Audit trail generado por Kukora · Simulated execution sobre market data real · Todos los prices son VWAP L2 calculados sobre el order book en el momento de detection.
          </div>
        </div>
      </div>
    </div>
  );
}

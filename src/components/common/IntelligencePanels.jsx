import React from 'react';

const fmtMs = ms => ms == null ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms/1000).toFixed(1)}s`;

// ─── Exchange Health Center ──────────────────────────────────────────
export function ExchangeHealthCenter({ health = [] }) {
  return (
    <div className="terminal-card">
      <div className="terminal-header">◈ EXCHANGE_HEALTH_CENTER [REAL_TIME]</div>
      <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {health.map(h => (
          <div key={h.exchange} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11 }}>
            <div className={`health-dot ${h.status === 'Connected' ? 'online' : h.status === 'Disconnected' ? 'offline' : 'warning'}`} />
            <span style={{ width: 65, fontWeight: 700 }}>{h.exchange}</span>
            <span style={{ flex: 1, color: h.status === 'Connected' ? 'var(--color-green)' : 'var(--text-dim)' }}>
              {h.status === 'Connected' ? fmtMs(h.latency) : h.status}
            </span>
            {h.reconnects > 0 && <span style={{ color: 'var(--color-red)', fontSize: 9 }}>({h.reconnects} RECON)</span>}
            <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{new Date(h.lastUpdate).toLocaleTimeString()}</span>
          </div>
        ))}
        {(!health || health.length === 0) && <div style={{ fontSize: 10, color: 'var(--text-dim)', textAlign: 'center' }}>Awaiting initial handshake...</div>}
      </div>
    </div>
  );
}

// ─── Market Intelligence Panel ──────────────────────────────────────
export function MarketIntelligencePanel({ intelligence }) {
  if (!intelligence) return null;
  const { regime, risk, strategy, volatility } = intelligence;
  
  return (
    <div className="terminal-card" style={{ height: '100%' }}>
      <div className="terminal-header">◈ MARKET_REGIME_DETECTION [AI_LAYER]</div>
      <div style={{ padding: '15px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 700 }}>REGIME</div>
          <div style={{ fontSize: 16, fontWeight: 900, color: 'var(--color-primary)' }}>{regime}</div>
        </div>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 700 }}>RISK LEVEL</div>
            <div style={{ fontSize: 12, fontWeight: 800, color: risk === 'High' ? 'var(--color-red)' : risk === 'Medium' ? 'var(--color-yellow)' : 'var(--color-green)' }}>
              {risk.toUpperCase()}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 700 }}>VOLATILITY</div>
            <div style={{ fontSize: 12, fontWeight: 800 }}>{volatility} BP</div>
          </div>
        </div>

        <div style={{ borderTop: '1px solid #eee', paddingTop: 10 }}>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 700, marginBottom: 4 }}>RECOMMENDED STRATEGY</div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>{strategy}</div>
        </div>
      </div>
    </div>
  );
}

// ─── AI Analyst Panel ───────────────────────────────────────────────
export function AIAnalystPanel({ intelligence, bestOpp }) {
  return (
    <div className="terminal-card">
      <div className="terminal-header">◈ KUKORA_AI_ANALYST [DETERMINISTIC_LOGIC]</div>
      <div style={{ padding: '15px' }}>
        <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.5, fontStyle: 'italic' }}>
          "{intelligence?.aiAnalyst || 'Analyzing current market conditions for cross-exchange inefficiencies...'}"
        </div>
        {bestOpp && bestOpp.netProfit > 2 && (
          <div style={{ marginTop: 12, padding: '8px', background: 'rgba(0,184,122,0.05)', borderRadius: 4, border: '1px solid rgba(0,184,122,0.1)' }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--color-green)' }}>SIGNAL:</span>
            <span style={{ fontSize: 11, marginLeft: 6 }}>Exceptional opportunity detected in {bestOpp.buyExchange}→{bestOpp.sellExchange} path. Higher capitalize recommended.</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Jury Impact Metrics (KPIs) ─────────────────────────────────────
export function JuryImpactMetrics({ stats }) {
  const { totalOpps = 0, totalTrades = 0, avgLatency = 0, avgSlippage = 0, successRate = 0 } = stats || {};
  
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
      {[
        { label: 'Opps Detected', value: totalOpps.toLocaleString(), color: 'var(--text)' },
        { label: 'Trades Executed', value: totalTrades, color: 'var(--color-green)' },
        { label: 'Avg Latency', value: `${avgLatency}ms`, color: 'var(--color-blue)' },
        { label: 'Avg Slippage', value: `${(avgSlippage * 100).toFixed(3)}%`, color: 'var(--color-yellow)' },
        { label: 'Success Rate', value: `${(successRate * 100).toFixed(1)}%`, color: 'var(--color-green)' },
      ].map(m => (
        <div key={m.label} style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 15px' }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' }}>{m.label}</div>
          <div style={{ fontSize: 18, fontWeight: 900, color: m.color, fontFamily: 'var(--font-mono)' }}>{m.value}</div>
        </div>
      ))}
    </div>
  );
}

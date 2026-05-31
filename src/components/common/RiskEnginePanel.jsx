import React from 'react';

export function RiskEnginePanel({ data }) {
  const protections = [
    { label: 'Stale Feed Protection', status: data?.feedFreshness ? 'ACTIVE' : 'WARNING', info: 'Auto-disable > 5s' },
    { label: 'Min Spread Threshold', status: 'ACTIVE', info: `${data?._MIN_SPREAD_PCT || 0.005}%` },
    { label: 'Liquidity Filter', status: 'ACTIVE', info: 'Min 50% Depth' },
    { label: 'Daily Drawdown Limit', status: data?.dailyLossBreached ? 'BREACHED' : 'ACTIVE', info: '-$500 Limit' },
    { label: 'Slippage Guard', status: 'ACTIVE', info: 'L2 VWAP Model' },
    { label: 'Exchange Exposure', status: 'ACTIVE', info: 'Max 0.05 BTC / execution' },
  ];

  return (
    <div className="terminal-card">
      <div className="terminal-header">◈ RISK_MANAGEMENT_ENGINE [CIRCUIT_BREAKERS]</div>
      <div style={{ padding: '15px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {protections.map(p => (
          <div key={p.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700 }}>{p.label}</div>
              <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>{p.info}</div>
            </div>
            <div style={{ 
              fontSize: 9, fontWeight: 900, padding: '2px 8px', borderRadius: 4,
              background: p.status === 'ACTIVE' ? 'var(--color-green-dim)' : 'var(--color-red-dim)',
              color: p.status === 'ACTIVE' ? 'var(--color-green)' : 'var(--color-red)',
              border: `1px solid ${p.status === 'ACTIVE' ? 'rgba(0,184,122,0.2)' : 'rgba(240,62,62,0.2)'}`
            }}>
              {p.status}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

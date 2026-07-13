/**
 * V17StatusBar.jsx — Kukora v17
 * Barra de estado institucional: circuit breaker, P&L auditado,
 * modo paper/live, watchdog, reconciliación.
 */
import { requestArbitrage } from '../../api';
import { useState, useEffect } from 'react';

const fmtUSD = n => n == null ? '—' : `${n >= 0 ? '+' : ''}$${Math.abs(n).toFixed(2)}`;

function Pill({ color, bg, border, children, pulse }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      background: bg, border: `1px solid ${border}`, borderRadius: 99,
      padding: '3px 10px', fontSize: 10, fontWeight: 700, color,
      animation: pulse ? 'v17pulse 1.5s ease-in-out infinite' : undefined,
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function Dot({ color, pulse }) {
  return (
    <span style={{
      width: 6, height: 6, borderRadius: '50%', background: color,
      display: 'inline-block', flexShrink: 0,
      animation: pulse ? 'v17pulse 1.5s ease-in-out infinite' : undefined,
    }} />
  );
}

export default function V17StatusBar({ data }) {
  const [alertHistory, setAlertHistory] = useState([]);
  const [tradingMode, setTradingMode]   = useState(null);

  useEffect(() => {
    requestArbitrage('alerts/history?limit=5')
      .then(d => d?.history && setAlertHistory(d.history))
      .catch(() => {});
    requestArbitrage('trading-mode')
      .then(d => d && setTradingMode(d))
      .catch(() => {});
  }, []);

  const auditPnl   = data?.auditedPnl;
  const watchdog   = data?.watchdogStatus;
  const mode       = data?.tradingMode || tradingMode?.mode || 'paper';

  // Circuit breaker: from riskStatus in SSE or from opportunities flag
  const cbActive   = !!(data?.opportunities?.some?.(o => o.circuitBreaker));

  const modeStyle = mode === 'live'
    ? { color: '#ef4444', bg: 'rgba(239,68,68,0.1)',  border: 'rgba(239,68,68,0.3)'  }
    : { color: '#0052FF', bg: 'rgba(0,82,255,0.1)',   border: 'rgba(0,82,255,0.3)'   };

  const cbStyle = cbActive
    ? { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.35)' }
    : { color: '#00b87a', bg: 'rgba(0,184,122,0.08)',  border: 'rgba(0,184,122,0.2)'  };

  const pnlVal    = auditPnl?.realizedPnl ?? 0;
  const pnlColor  = pnlVal >= 0 ? '#00b87a' : '#ef4444';
  const reconcOK  = auditPnl?.reconciled !== false;

  const critAlerts = alertHistory.filter(a => a.severity === 'critical' || a.severity === 'warn');

  return (
    <>
      <style>{`@keyframes v17pulse{0%,100%{opacity:1}50%{opacity:.5}}`}</style>

      <div style={{
        background: 'var(--bg-surface)',
        border: `1px solid ${cbActive ? 'rgba(245,158,11,0.4)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-lg, 12px)',
        padding: '10px 14px',
        display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center',
        marginBottom: 12,
        boxShadow: cbActive ? '0 0 20px rgba(245,158,11,0.07)' : 'none',
      }}>

        {/* Trading mode */}
        <Pill {...modeStyle}>
          <Dot color={modeStyle.color} pulse={mode === 'live'} />
          {mode === 'live' ? '🔴 LIVE TRADING' : '📄 PAPER TRADING'}
        </Pill>

        {/* Circuit breaker */}
        <Pill {...cbStyle} pulse={cbActive}>
          <Dot color={cbStyle.color} pulse={cbActive} />
          {cbActive ? '⚠ CIRCUIT BREAKER ACTIVO' : '✓ Motor operando'}
        </Pill>

        {/* Audited P&L */}
        {auditPnl && (
          <Pill
            color={pnlColor}
            bg={`${pnlVal >= 0 ? 'rgba(0,184,122' : 'rgba(239,68,68'},0.08)`}
            border={`${pnlVal >= 0 ? 'rgba(0,184,122' : 'rgba(239,68,68'},0.25)`}
          >
            P&L Auditado: {fmtUSD(auditPnl.realizedPnl)}
          </Pill>
        )}

        {/* Reconciliation */}
        {auditPnl && (
          <Pill
            color={reconcOK ? '#00b87a' : '#ef4444'}
            bg={reconcOK ? 'rgba(0,184,122,0.06)' : 'rgba(239,68,68,0.1)'}
            border={reconcOK ? 'rgba(0,184,122,0.2)' : 'rgba(239,68,68,0.3)'}
          >
            {reconcOK ? '✓ Reconciled' : `⚠ ${auditPnl.reconcErrors} audit errors`}
          </Pill>
        )}

        {/* Win rate */}
        {auditPnl?.winRate != null && (
          <Pill color="#94a3b8" bg="rgba(148,163,184,0.06)" border="rgba(148,163,184,0.15)">
            Win {auditPnl.winRate}% ({auditPnl.winningTrades}/{auditPnl.totalTrades})
          </Pill>
        )}

        {/* Watchdog */}
        {watchdog && (
          <Pill
            color={watchdog.exchanges?.healthy ? '#64748b' : '#f59e0b'}
            bg="rgba(100,116,139,0.06)"
            border="rgba(100,116,139,0.15)"
          >
            🐕 {watchdog.uptimeHuman}
            {watchdog.memory?.heapMB > 0 && ` · ${watchdog.memory.heapMB}MB`}
            {!watchdog.exchanges?.healthy && ` · ⚠ ${watchdog.exchanges.stale.length} stale`}
          </Pill>
        )}

        {/* Unrealized MTM */}
        {auditPnl?.unrealizedPnl != null && (
          <Pill color="#64748b" bg="transparent" border="rgba(100,116,139,0.12)">
            MTM: {fmtUSD(auditPnl.unrealizedPnl)}
          </Pill>
        )}

        {/* Download report */}
        <a href="/api/arbitrage/report/html" target="_blank" rel="noreferrer" style={{
          marginLeft: 'auto', fontSize: 10, fontWeight: 700,
          color: 'var(--text-dim)', background: 'var(--bg-elevated)',
          border: '1px solid var(--border)', borderRadius: 6,
          padding: '4px 10px', textDecoration: 'none',
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>
          ↓ Report
        </a>
      </div>

      {/* Critical alert ribbon */}
      {critAlerts.slice(0, 1).map(a => (
        <div key={a.ts} style={{
          background: a.severity === 'critical' ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.08)',
          border: `1px solid ${a.severity === 'critical' ? 'rgba(239,68,68,0.3)' : 'rgba(245,158,11,0.25)'}`,
          borderRadius: 8, padding: '6px 14px', fontSize: 11,
          color: a.severity === 'critical' ? '#ef4444' : '#f59e0b',
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
        }}>
          <span style={{ fontWeight: 800 }}>{a.severity === 'critical' ? '🚨' : '⚠️'} ALERTA</span>
          <span style={{ color: 'var(--text-dim)' }}>{a.title}</span>
          <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--text-dim)' }}>
            {new Date(a.ts).toLocaleTimeString()}
          </span>
        </div>
      ))}
    </>
  );
}

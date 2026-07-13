/**
 * CapitalEfficiencyPanel.jsx — Kukora
 *
 * Improvement #4: "Capital efficiency metric" — el ROI real no es sobre el
 * profit por trade, sino sobre el capital total inmovilizado para poder
 * operar el model pre-funded.
 *
 * Improvement #6: "Rebalance cost simulator" — el model pre-funded evita fees
 * de transferencia por trade, pero acumula desequilibrio entre exchanges
 * which eventually requires rebalancing. This panel projects when and at what
 * costo, en base a los trades reales ejecutados.
 */
import { useState, useEffect } from 'react';

const fmt    = (n, d = 2) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtUSD = (n, d = 2) => (n == null || isNaN(n)) ? '—' : `$${fmt(n, d)}`;

const EX_COLORS = { Binance: '#F0B90B', Kraken: '#5741D9', Bybit: '#F7A600', Coinbase: '#0052FF', OKX: '#aaa' };

function StatTile({ label, value, sub, color }) {
  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)', padding: '14px 18px',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
      <span style={{ fontSize: 22, fontWeight: 900, fontFamily: 'var(--font-mono)', color: color || 'var(--text)', lineHeight: 1 }}>{value}</span>
      {sub && <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{sub}</span>}
    </div>
  );
}

export default function CapitalEfficiencyPanel({ data }) {
  // These fields only arrive every ~7 ticks (throttled server-side) —
  // retain the last known value across ticks where they're absent.
  const [capEff, setCapEff] = useState(null);
  const [rebalance, setRebalance] = useState(null);

  useEffect(() => { if (data?.capitalEfficiency) setCapEff(data.capitalEfficiency); }, [data?.capitalEfficiency]);
  useEffect(() => { if (data?.rebalanceProjection) setRebalance(data.rebalanceProjection); }, [data?.rebalanceProjection]);

  if (!capEff) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>Calculando metrics de capital…</div>;
  }

  const roiColor = capEff.roiAnnualizedPct == null ? 'var(--text-dim)'
    : capEff.roiAnnualizedPct >= 0 ? 'var(--color-green)' : 'var(--color-red)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{
        padding: '12px 18px',
        background: 'linear-gradient(135deg, rgba(255,45,120,0.06), rgba(88,65,217,0.06))',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
      }}>
        <div style={{ fontWeight: 900, fontSize: 16, letterSpacing: '-0.02em' }}>📊 Capital Efficiency</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, lineHeight:1.55 }}>
          The pre-funded model locks capital across 5 exchanges to eliminate counterparty risk during execution. Real ROI is not measured per trade — it is measured against total committed capital. This panel calculates effective capital utilization, hourly ROI, idle capital (funds not participating in any opportunity) and projects infrastructure break-even.
        </div>
      </div>

      {/* KPI Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        <StatTile label="Capital en Uso" value={fmtUSD(capEff.capitalDeployedUSD, 0)} sub={`${fmt(capEff.totalBtcHeld, 4)} BTC + ${fmtUSD(capEff.totalUsdtHeld, 0)}`} />
        <StatTile label="P&L Session" value={`${capEff.realizedPnlSession >= 0 ? '+' : ''}${fmtUSD(capEff.realizedPnlSession, 4)}`} color={capEff.realizedPnlSession >= 0 ? 'var(--color-green)' : 'var(--color-red)'} sub={`${capEff.totalTradesSession} trades · ${capEff.uptimeHours}h active`} />
        <StatTile label="Projected Annualized ROI" value={capEff.roiAnnualizedPct != null ? `${capEff.roiAnnualizedPct >= 0 ? '+' : ''}${capEff.roiAnnualizedPct}%` : '—'} color={roiColor} sub="session extrapolation, not a guarantee" />
        <StatTile label="Break-even Infraestructura" value={capEff.infraBreakEvenDays != null ? `${capEff.infraBreakEvenDays}d` : '—'} sub={`costo mensual ref. ${fmtUSD(capEff.monthlyInfraCostUSD, 0)}`} />
      </div>

      {capEff.note && (
        <div style={{ fontSize: 11, color: 'var(--color-yellow)', fontStyle: 'italic', padding: '8px 14px', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 'var(--radius)' }}>
          ⚠ {capEff.note}
        </div>
      )}

      {/* Projection breakdown */}
      <div className="card" style={{ padding: '14px 18px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
          Profit Projection (linear extrapolation of current session)
        </div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          {[
            { label: 'Por hour', value: capEff.profitPerHourProjected },
            { label: 'Por day', value: capEff.profitPerDayProjected },
            { label: 'Por year', value: capEff.profitPerYearProjected },
          ].map(({ label, value }) => (
            <div key={label}>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 700, textTransform: 'uppercase' }}>{label}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: 16, color: value >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>
                {value >= 0 ? '+' : ''}{fmtUSD(value, value < 100 ? 4 : 2)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Rebalance projection */}
      {rebalance && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontWeight: 800, fontSize: 13 }}>🔄 Simulador de Costo de Rebalancing</div>
            {rebalance.rebalanceNeeded ? (
              <span style={{ background: 'rgba(245,158,11,0.12)', color: '#F59E0B', fontWeight: 800, fontSize: 11, padding: '3px 10px', borderRadius: 99, border: '1px solid rgba(245,158,11,0.3)' }}>
                ⚠ Rebalancing recommended ahour
              </span>
            ) : (
              <span style={{ background: 'rgba(0,184,122,0.1)', color: 'var(--color-green)', fontWeight: 800, fontSize: 11, padding: '3px 10px', borderRadius: 99, border: '1px solid rgba(0,184,122,0.25)' }}>
                ✓ Balances dentro de rango
              </span>
            )}
          </div>
          <div style={{ padding: '14px 18px' }}>
            <div style={{ fontSize: 12, marginBottom: 12 }}>
              {rebalance.hoursUntilRebalance != null ? (
                <>At the current trade rate, in <b style={{ fontFamily: 'var(--font-mono)' }}>~{rebalance.hoursUntilRebalance}h</b> the imbalance between exchanges will reach the threshold of {rebalance.rebalanceThresholdPct}%.</>
              ) : rebalance.rebalanceNeeded ? (
                <>El desequilibrio entre exchanges ya superó el threshold de {rebalance.rebalanceThresholdPct}% — se recomienda mover fondos para restaurar balances iniciales.</>
              ) : (
                <>Aún no hay suficientes trades en esta session para proyectar cuándo será necesario rebalancear.</>
              )}
              {rebalance.estimatedRebalanceCostUSD != null && (
                <> Costo estimado de la ronda: <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-red)' }}>-{fmtUSD(rebalance.estimatedRebalanceCostUSD)}</b> en withdrawal fees + slippage de transferencia on-chain.</>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rebalance.drifts.map(d => {
                const maxDriftHere = Math.max(d.btcDriftPct, d.usdtDriftPct);
                const pct = Math.min(100, (maxDriftHere / rebalance.rebalanceThresholdPct) * 100);
                return (
                  <div key={d.exchange} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ width: 70, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: EX_COLORS[d.exchange] || '#999' }} />
                      {d.exchange}
                    </span>
                    <div style={{ flex: 1, height: 7, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? 'var(--color-red)' : pct >= 60 ? 'var(--color-yellow)' : 'var(--color-green)', transition: 'width 0.5s' }} />
                    </div>
                    <span style={{ width: 110, fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-dim)', textAlign: 'right' }}>
                      BTC {d.btcDriftPct}% · USDT {d.usdtDriftPct}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

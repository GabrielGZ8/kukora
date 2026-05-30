/**
 * ExecutiveDashboard.jsx — Kukora Hackathon
 *
 * One-screen judge-facing summary with ALL key metrics:
 * opportunities, trades, profit, latency, risk, reliability,
 * best opportunity, predicted opportunity.
 *
 * Consumes data from the SSE stream (tick payload) already
 * enriched with intelligence modules. No extra fetch needed.
 */
import { useMemo } from 'react';

const fmt    = (n, d = 2) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtMs  = ms => ms == null ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;

// ─── Risk badge ────────────────────────────────────────────────────────────
function RiskBadge({ status }) {
  const cfg = {
    'STABLE':    { bg: 'rgba(0,184,122,0.10)',  border: 'rgba(0,184,122,0.35)',  color: '#00B87A', icon: '✓' },
    'CAUTION':   { bg: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.35)', color: '#F59E0B', icon: '⚠' },
    'HIGH RISK': { bg: 'rgba(240,62,62,0.10)',  border: 'rgba(240,62,62,0.35)',  color: '#F03E3E', icon: '🛑' },
  };
  const c = cfg[status] || cfg['STABLE'];
  return (
    <span style={{
      background: c.bg, border: `1px solid ${c.border}`,
      color: c.color, fontWeight: 800, fontSize: 11,
      padding: '3px 10px', borderRadius: 99, letterSpacing: '0.04em',
    }}>
      {c.icon} {status || 'STABLE'}
    </span>
  );
}

// ─── KPI Tile ──────────────────────────────────────────────────────────────
function Tile({ label, value, sub, color, icon, pulse, wide }) {
  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: '14px 18px',
      display: 'flex', flexDirection: 'column', gap: 4,
      gridColumn: wide ? 'span 2' : undefined,
      position: 'relative', overflow: 'hidden',
    }}>
      <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {icon && <span style={{ marginRight: 4 }}>{icon}</span>}{label}
      </span>
      <span style={{
        fontSize: wide ? 28 : 22, fontWeight: 900,
        fontFamily: 'var(--font-mono)',
        color: color || 'var(--text)',
        lineHeight: 1,
      }}>
        {pulse && (
          <span style={{
            display: 'inline-block', width: 7, height: 7,
            borderRadius: '50%', background: color || 'var(--color-green)',
            marginRight: 6, verticalAlign: 'middle',
            animation: 'pulseDot 1.5s ease-in-out infinite',
          }} />
        )}
        {value}
      </span>
      {sub && <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>{sub}</span>}
    </div>
  );
}

// ─── Exchange Reliability Mini-table ──────────────────────────────────────
function ReliabilityTable({ data = [] }) {
  if (!data.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {data.map(({ exchange, score }) => (
        <div key={exchange} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 60, fontSize: 11, fontWeight: 700, color: 'var(--text)' }}>{exchange}</span>
          <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              width: `${score}%`, height: '100%', borderRadius: 3,
              background: score >= 70 ? 'var(--color-green)' : score >= 40 ? 'var(--color-yellow)' : 'var(--color-red)',
              transition: 'width 0.5s',
            }} />
          </div>
          <span style={{ width: 36, fontSize: 11, fontWeight: 800, fontFamily: 'var(--font-mono)', color: score >= 70 ? 'var(--color-green)' : score >= 40 ? 'var(--color-yellow)' : 'var(--color-red)', textAlign: 'right' }}>{score}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Predicted Opportunity Card ────────────────────────────────────────────
function PredictedCard({ pred }) {
  if (!pred) return (
    <div style={{ color: 'var(--text-dim)', fontSize: 12, padding: 8 }}>
      Acumulando datos históricos…
    </div>
  );
  return (
    <div style={{
      background: 'linear-gradient(135deg, rgba(88,65,217,0.08), rgba(88,65,217,0.03))',
      border: '1px solid rgba(88,65,217,0.25)', borderRadius: 'var(--radius)',
      padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <span style={{ fontSize: 20 }}></span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 800, color: '#5741D9', fontSize: 13 }}>
          {pred.pair}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
          {pred.currentlyActive ? '● Activa ahora' : '○ No activa'}
          {pred.historicalSuccessRate != null && ` · ${pred.historicalSuccessRate}% win hist.`}
          {pred.expectedProfit != null && ` · E[P]=$${pred.expectedProfit.toFixed(4)}`}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontWeight: 900, fontSize: 18, fontFamily: 'var(--font-mono)', color: '#5741D9' }}>
          {pred.probability}%
        </div>
        <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>probabilidad</div>
      </div>
    </div>
  );
}

// ─── Best Opportunity Card ─────────────────────────────────────────────────
function BestOppCard({ opp }) {
  if (!opp) return <div style={{ color: 'var(--text-dim)', fontSize: 12, padding: 8 }}>Sin datos de sesión aún…</div>;
  return (
    <div style={{
      background: opp.netProfit >= 0 ? 'rgba(0,184,122,0.06)' : 'var(--bg-surface-2)',
      border: `1px solid ${opp.netProfit >= 0 ? 'rgba(0,184,122,0.35)' : 'var(--border)'}`,
      borderRadius: 'var(--radius)', padding: '10px 14px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    }}>
      <div>
        <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--text)' }}>
          {opp.buyExchange} → {opp.sellExchange}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
          Spread {opp.spreadPct}% · Break-even {opp.breakEvenPct}%
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{
          fontWeight: 900, fontSize: 16, fontFamily: 'var(--font-mono)',
          color: opp.netProfit >= 0 ? 'var(--color-green)' : 'var(--color-red)',
        }}>
          {opp.netProfit >= 0 ? '+' : ''}${opp.netProfit.toFixed(4)}
        </div>
        <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>mejor de sesión</div>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────
export default function ExecutiveDashboard({ data }) {
  const pnl               = data?.pnl               || {};
  const volatility        = data?.volatilityStatus   || {};
  const reliability       = data?.reliabilityLeaderboard || [];
  const exRanking         = data?.exchangeRanking    || [];
  const predicted         = data?.predictiveRanking?.[0];
  const bestOpp           = data?.bestOpportunitySeen;
  const nearViable        = data?.nearViableCount    || 0;
  const rejections        = data?.rejectionCounts    || {};
  const scanned           = data?.opportunitiesScanned || 0;
  const viable            = data?.viableFound        || 0;
  const trades            = pnl.totalTrades          || 0;
  const winRate           = pnl.winRate              || 0;
  const connectedWs       = data?.wsStatus
    ? Object.values(data.wsStatus).filter(Boolean).length
    : 0;
  const bestExchange      = exRanking[0]?.exchange   || '—';
  const avgLatency        = useMemo(() => {
    const valid = exRanking.filter(e => e.avgLatency != null);
    if (!valid.length) return null;
    return Math.round(valid.reduce((s, e) => s + e.avgLatency, 0) / valid.length);
  }, [exRanking]);
  const reliabilityAvg    = useMemo(() => {
    if (!reliability.length) return 0;
    return Math.round(reliability.reduce((s, e) => s + e.score, 0) / reliability.length);
  }, [reliability]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 18px',
        background: 'linear-gradient(135deg, rgba(255,45,120,0.06), rgba(88,65,217,0.06))',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
      }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 16, letterSpacing: '-0.02em' }}>
             Executive Dashboard
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
            Kukora · Arbitrage Bot · Coding Challenge Mexico — Bitcoin Arbitrage
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <RiskBadge status={volatility.status} />
          <span style={{
            background: 'rgba(0,82,255,0.08)', border: '1px solid rgba(0,82,255,0.25)',
            color: '#0052FF', fontWeight: 800, fontSize: 11,
            padding: '3px 10px', borderRadius: 99,
          }}>
             {connectedWs}/5 WS · Event-driven
          </span>
        </div>
      </div>

      {/* KPI Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        <Tile icon="" label="Oportunidades Totales"  value={scanned.toLocaleString()} color="var(--text)" />
        <Tile icon="" label="Oportunidades Viables"  value={viable.toLocaleString()} color="var(--color-green)" pulse={viable > 0} />
        <Tile icon="" label="Trades Ejecutados"      value={trades.toLocaleString()} color="var(--color-green)" />
        <Tile icon="⚠" label="Cerca Viables"           value={nearViable.toLocaleString()} color="var(--color-yellow)" sub="dentro del doble del mínimo" />

        <Tile icon="" label="P&L Hoy"
          value={pnl.totalPnl != null ? `$${pnl.totalPnl >= 0 ? '+' : ''}${fmt(pnl.totalPnl, 4)}` : '—'}
          color={pnl.totalPnl >= 0 ? 'var(--color-green)' : 'var(--color-red)'}
          sub={`Session P&L`} />
        <Tile icon="" label="Win Rate"
          value={winRate ? `${winRate.toFixed(1)}%` : '—'}
          color={winRate >= 60 ? 'var(--color-green)' : winRate >= 40 ? 'var(--color-yellow)' : 'var(--text-dim)'}
          sub={`${trades} trades`} />
        <Tile icon="⏱" label="Latencia Promedio"
          value={avgLatency != null ? fmtMs(avgLatency) : '—'}
          color={avgLatency != null && avgLatency < 100 ? 'var(--color-green)' : 'var(--color-yellow)'}
          sub="avg 5 exchanges" />
        <Tile icon="🛡" label="Reliability Score"
          value={`${reliabilityAvg}/100`}
          color={reliabilityAvg >= 70 ? 'var(--color-green)' : reliabilityAvg >= 40 ? 'var(--color-yellow)' : 'var(--color-red)'}
          sub="composite WS + latency" />

        <Tile icon="" label="Exchanges Conectados"
          value={`${connectedWs}/5`}
          color="var(--color-green)" sub="5 exchanges WS" />
        <Tile icon="" label="Mejor Exchange"
          value={bestExchange}
          color="var(--color-green)" sub="por success rate + reliability" />
        <Tile icon="" label="Rec. Fees/Slip"
          value={(rejections.fees_slippage || 0).toLocaleString()}
          color="var(--color-red)" sub="spread insuficiente" />
        <Tile icon="" label="Rec. Circuit Breaker"
          value={(rejections.circuit_breaker || 0).toLocaleString()}
          color="var(--color-yellow)" sub="spread fuera de rango" />
      </div>

      {/* Bottom row: Reliability + Best Opp + Predicted */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>

        {/* Reliability Leaderboard */}
        <div style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', padding: '14px 18px',
        }}>
          <div style={{ fontWeight: 800, fontSize: 12, marginBottom: 12 }}>
            🛡 Exchange Reliability
          </div>
          <ReliabilityTable data={reliability} />
        </div>

        {/* Best Opportunity Seen */}
        <div style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', padding: '14px 18px',
        }}>
          <div style={{ fontWeight: 800, fontSize: 12, marginBottom: 12 }}>
             Mejor Oportunidad (Sesión)
          </div>
          <BestOppCard opp={bestOpp} />

          {/* Break-even dashboard micro */}
          {bestOpp && (
            <div style={{
              display: 'flex', gap: 12, marginTop: 10,
              padding: '8px 10px', background: 'var(--bg-surface-2)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            }}>
              {[
                { label: 'Spread', val: `${bestOpp.spreadPct}%`, color: 'var(--color-green)' },
                { label: 'Break-even', val: `${bestOpp.breakEvenPct}%`, color: 'var(--color-yellow)' },
                { label: 'Edge', val: `+${Math.max(0, bestOpp.spreadPct - bestOpp.breakEvenPct).toFixed(4)}%`, color: 'var(--color-green)' },
              ].map(({ label, val, color }) => (
                <div key={label} style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
                  <div style={{ fontSize: 14, fontWeight: 900, fontFamily: 'var(--font-mono)', color }}>{val}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Predicted Next Opportunity */}
        <div style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)', padding: '14px 18px',
        }}>
          <div style={{ fontWeight: 800, fontSize: 12, marginBottom: 12 }}>
             Próxima Oportunidad Predicha
          </div>
          <PredictedCard pred={predicted} />

          {/* Vol status mini */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginTop: 10, padding: '8px 10px',
            background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)' }}>Volatilidad BTC</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 60, height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  width: `${volatility.score || 0}%`, height: '100%', borderRadius: 3,
                  background: volatility.score >= 70 ? 'var(--color-red)' : volatility.score >= 35 ? 'var(--color-yellow)' : 'var(--color-green)',
                  transition: 'width 0.5s',
                }} />
              </div>
              <span style={{ fontSize: 11, fontWeight: 800, fontFamily: 'var(--font-mono)' }}>
                {volatility.score || 0}/100
              </span>
              <RiskBadge status={volatility.status || 'STABLE'} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
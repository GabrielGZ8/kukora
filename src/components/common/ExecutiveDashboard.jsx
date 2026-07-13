/**
 * ExecutiveDashboard.jsx — Kukora
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
      Accumulating historical data…
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
          {pred.currentlyActive ? '● Activa ahour' : '○ No activa'}
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
  if (!opp) return <div style={{ color: 'var(--text-dim)', fontSize: 12, padding: 8 }}>No session data yet…</div>;
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
        <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>mejor de la sesión</div>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────
export default function ExecutiveDashboard({ data }) {
  const pnl               = data?.pnl               || {};
  const volatility        = data?.volatilityStatus   || {};
  const reliability       = useMemo(() => data?.reliabilityLeaderboard || [], [data?.reliabilityLeaderboard]);
  const exRanking         = useMemo(() => data?.exchangeRanking    || [], [data?.exchangeRanking]);
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
  // config en vivo
  const engineConfig      = data?.engineConfig       || {};
  const configChangedKeys = Array.isArray(data?.configChanged) ? data.configChanged : [];
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
             ▣ Executive Dashboard — Judge Mode
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, lineHeight:1.5 }}>
            Consolidated operational view. All KPIs in one screen — detection, execution, capital, risk and latency.
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
        <Tile icon="" label="Total Opportunities"  value={scanned.toLocaleString()} color="var(--text)" />
        <Tile icon="" label="Viable Opportunities"  value={viable.toLocaleString()} color="var(--color-green)" pulse={viable > 0} />
        <Tile icon="" label="Trades Ejecutados"      value={trades.toLocaleString()} color="var(--color-green)" />
        <Tile icon="⚠" label="Near Viable"           value={nearViable.toLocaleString()} color="var(--color-yellow)" sub="within double the minimum" />

        <Tile icon="" label="P&L Neto"
          value={pnl.totalPnl != null ? `${pnl.totalPnl >= 0 ? '+' : '-'}$${fmt(Math.abs(pnl.totalPnl), 4)}` : '—'}
          color={pnl.totalPnl >= 0 ? 'var(--color-green)' : 'var(--color-red)'}
          sub="Realizado + MTM" />
        <Tile icon="" label="Capture Rate"
          value={pnl.captureRate != null ? `${pnl.captureRate}%` : (trades > 0 && scanned > 0 ? `${((trades/scanned)*100).toFixed(1)}%` : '—')}
          color="var(--color-green)"
          sub="trades / opportunities" />
        <Tile icon="" label="Win Rate"
          value={winRate ? `${winRate.toFixed(1)}%` : '—'}
          color={winRate >= 60 ? 'var(--color-green)' : winRate >= 40 ? 'var(--color-yellow)' : 'var(--text-dim)'}
          sub={`${trades} trades`} />
        <Tile icon="⏱" label="Latency Average"
          value={avgLatency != null ? fmtMs(avgLatency) : '—'}
          color={avgLatency != null && avgLatency < 100 ? 'var(--color-green)' : 'var(--color-yellow)'}
          sub="avg 5 exchanges" />
        <Tile icon="🛡" label="Reliability Score"
          value={`${reliabilityAvg}/100`}
          color={reliabilityAvg >= 70 ? 'var(--color-green)' : reliabilityAvg >= 40 ? 'var(--color-yellow)' : 'var(--color-red)'}
          sub="composite WS + latency" />

        <Tile icon="" label="Exchanges Connecteds"
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
             Mejor Opportunity (Session)
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
             Next Predicted Opportunity
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

      {/* ── v16: CONFIGURACIÓN ACTIVA DEL MOTOR ───────────────────────────────
          Muestra el status en vivo de liveConfig — 
      */}
      <div style={{
        background: configChangedKeys.length > 0
          ? 'rgba(245,158,11,0.04)'
          : 'var(--bg-surface)',
        border: configChangedKeys.length > 0
          ? '1px solid rgba(245,158,11,0.25)'
          : '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)', padding: '14px 18px',
      }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 12 }}>
            ⚙️ Active engine configuration
          </div>
          {configChangedKeys.length > 0 ? (
            <span style={{ fontSize:9, fontWeight:800, padding:'2px 8px', borderRadius:4, background:'rgba(245,158,11,0.15)', color:'#F59E0B', border:'1px solid rgba(245,158,11,0.3)' }}>
              ⚡ {configChangedKeys.length} param{configChangedKeys.length > 1 ? 's' : ''} modified vs default
            </span>
          ) : (
            <span style={{ fontSize:9, fontWeight:700, padding:'2px 8px', borderRadius:4, background:'rgba(0,184,122,0.08)', color:'var(--color-green)', border:'1px solid rgba(0,184,122,0.2)' }}>
              ✓ Defaults active
            </span>
          )}
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(5, 1fr)', gap:8 }}>
          {[
            { key:'minScore',            label:'Min Score',      unit:'pts',  icon:'🎯' },
            { key:'tradeAmountBTC',      label:'Trade Size',     unit:'BTC',  icon:'💎' },
            { key:'feeMode',             label:'Fee Mode',       unit:'',     icon:'💸' },
            { key:'minNetProfitUSD',     label:'Min Profit',     unit:'USD',  icon:'💰' },
            { key:'minSpreadPct',        label:'Min Spread',     unit:'%',    icon:'📊' },
            { key:'maxSpreadPct',        label:'Max Spread',     unit:'%',    icon:'📈' },
            { key:'maxDailyLossUSD',     label:'Max Loss/day',   unit:'USD',  icon:'🛑' },
            { key:'cooldownMs',          label:'Cooldown',       unit:'ms',   icon:'⏱' },
            { key:'minTriangularNetPct', label:'Min Triangular', unit:'%',    icon:'△' },
            { key:'activeExchanges',     label:'Exchanges',      unit:'',     icon:'🔗' },
          ].map(({ key, label, unit, icon }) => {
            const val     = engineConfig[key];
            const changed = configChangedKeys.includes(key);
            const display = key === 'activeExchanges'
              ? (Array.isArray(val) ? `${val.length}/5` : '5/5')
              : val != null
                ? (typeof val === 'number'
                    ? (Number.isInteger(val) ? val : val.toFixed(key === 'tradeAmountBTC' ? 3 : key.includes('Pct') || key === 'minTriangularNetPct' ? 4 : 2))
                    : val)
                : '—';
            return (
              <div key={key} style={{
                padding:'8px 10px', borderRadius:6,
                background: changed ? 'rgba(245,158,11,0.08)' : 'rgba(255,255,255,0.02)',
                border: changed ? '1px solid rgba(245,158,11,0.25)' : '1px solid var(--border)',
              }}>
                <div style={{ fontSize:9, color:'var(--text-dim)', marginBottom:2 }}>{icon} {label}</div>
                <div style={{ fontSize:13, fontWeight:800, fontFamily:'var(--font-mono)', color: changed ? '#F59E0B' : 'var(--text)' }}>
                  {String(display)}{unit && <span style={{ fontSize:9, color:'var(--text-dim)', marginLeft:2 }}>{unit}</span>}
                </div>
                {changed && <div style={{ fontSize:8, color:'#F59E0B', marginTop:1 }}>↑ modified</div>}
              </div>
            );
          })}
        </div>
        {configChangedKeys.length === 0 && (
          <div style={{ marginTop:10, fontSize:10, color:'var(--text-dim)' }}>
            Use the <strong>⚙️ Parameters</strong> tab to change any parameter live — effect is immediate without system restart.
          </div>
        )}
      </div>
    </div>
  );
}
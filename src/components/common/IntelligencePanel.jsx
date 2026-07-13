/**
 * IntelligencePanel.jsx — Kukora
 *
 * Shows:
 *   - Exchange Performance Ranking
 *   - Exchange Reliability Leaderboard
 *   - Volatility Risk Filter
 *   - Historical Learning Engine
 *   - Predictive Opportunity Ranking
 *   - Fill Probability per opportunity
 */

const fmt4 = n => (n == null || isNaN(n)) ? '—' : Number(n).toFixed(4);
const fmtMs = ms => ms == null ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;

const EX_COLORS = { Binance: '#F0B90B', Kraken: '#5741D9', Bybit: '#F7A600', Coinbase: '#0052FF', OKX: '#aaa' };
const scoreColor = s => s >= 70 ? 'var(--color-green)' : s >= 40 ? 'var(--color-yellow)' : 'var(--color-red)';

function Section({ title, children, right }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }}>
      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 800, fontSize: 13 }}>{title}</span>
        {right}
      </div>
      <div style={{ padding: '14px 18px' }}>{children}</div>
    </div>
  );
}

function ScoreBar({ score, max = 100, color }) {
  const c = color || scoreColor(score);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${(score / max) * 100}%`, height: '100%', background: c, borderRadius: 3, transition: 'width 0.5s' }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 800, fontFamily: 'var(--font-mono)', color: c, minWidth: 32, textAlign: 'right' }}>{score}</span>
    </div>
  );
}

function RiskStatus({ status, score }) {
  const colors = { 'STABLE': 'var(--color-green)', 'CAUTION': 'var(--color-yellow)', 'HIGH RISK': 'var(--color-red)' };
  const color = colors[status] || 'var(--color-green)';
  const icons  = { 'STABLE': '✓', 'CAUTION': '⚠', 'HIGH RISK': '🛑' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{
          background: `${color}18`, border: `1px solid ${color}55`,
          color, fontWeight: 800, fontSize: 15,
          padding: '6px 18px', borderRadius: 99,
        }}>
          {icons[status] || '✓'} {status || 'STABLE'}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 900, fontSize: 20, color }}>{score || 0}/100</span>
      </div>
      <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{
          width: `${score || 0}%`, height: '100%', borderRadius: 4,
          background: color, transition: 'width 0.5s',
        }} />
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>
        Based on: BTC price variance (rolling 60 ticks) · short-term momentum · spread instability.
        {score >= 70 && ' 🛑 Execution blocked — high risk.'}
        {score >= 35 && score < 70 && ' ⚠ Position size reduced.'}
        {score < 35 && ' System operando normalmente.'}
      </p>
    </div>
  );
}

function PredictiveCard({ pred, rank }) {
  if (!pred) return null;
  return (
    <div style={{
      background: rank === 0 ? 'linear-gradient(135deg, rgba(88,65,217,0.08), rgba(88,65,217,0.02))' : 'var(--bg-surface-2)',
      border: `1px solid ${rank === 0 ? 'rgba(88,65,217,0.3)' : 'var(--border)'}`,
      borderRadius: 'var(--radius)', padding: '12px 14px',
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <span style={{ fontSize: 20 }}>{rank === 0 ? '🥇' : rank === 1 ? '🥈' : '🥉'}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 800, fontSize: 13, color: rank === 0 ? '#5741D9' : 'var(--text)' }}>
          {pred.pair}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
          {pred.historicalSuccessRate != null && (
            <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
              Win hist: <strong style={{ color: 'var(--color-green)' }}>{pred.historicalSuccessRate}%</strong>
            </span>
          )}
          {pred.expectedProfit != null && (
            <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
              E[P]: <strong style={{ color: 'var(--color-green)' }}>${fmt4(pred.expectedProfit)}</strong>
            </span>
          )}
          <span style={{ fontSize: 10, color: pred.currentlyActive ? 'var(--color-green)' : 'var(--text-dim)' }}>
            {pred.currentlyActive ? '● Activa' : '○ Inactiva'}
          </span>
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontWeight: 900, fontSize: 20, fontFamily: 'var(--font-mono)', color: rank === 0 ? '#5741D9' : 'var(--text)' }}>
          {pred.probability}%
        </div>
        <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>prob.</div>
      </div>
    </div>
  );
}

export default function IntelligencePanel({ data, opportunities = [] }) {
  const exRanking    = data?.exchangeRanking        || [];
  const reliability  = data?.reliabilityLeaderboard || [];
  const volatility   = data?.volatilityStatus       || {};
  const learning     = data?.historicalLearning     || [];
  const predicted    = data?.predictiveRanking      || [];

  // Find top viable opportunity for fill probability display
  const topViable = opportunities.find(op => op.viable);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Top row: Exchange Ranking + Reliability */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>

        {/* Exchange Performance Ranking */}
        <Section title=" Exchange Performance Ranking">
          {exRanking.length === 0 ? (
            <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>Acumulando datos de session…</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr style={{ background: 'var(--bg-surface-2)' }}>
                {['#', 'Exchange', 'Opps', 'Ejecutadas', 'Win%', 'Latency', 'Fill%'].map(h => (
                  <th key={h} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 700, fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {exRanking.map((ex, i) => (
                  <tr key={ex.exchange} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 8px', fontWeight: 900, fontSize: 11, color: i === 0 ? '#F0B90B' : 'var(--text-dim)' }}>
                      {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`}
                    </td>
                    <td style={{ padding: '8px 8px', fontWeight: 700 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: EX_COLORS[ex.exchange] || '#aaa' }} />
                        {ex.exchange}
                      </span>
                    </td>
                    <td style={{ padding: '8px 8px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{ex.opportunitiesSeen.toLocaleString()}</td>
                    <td style={{ padding: '8px 8px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-green)' }}>{ex.opportunitiesExecuted}</td>
                    <td style={{ padding: '8px 8px', fontFamily: 'var(--font-mono)', fontSize: 11, color: ex.successRate != null ? (ex.successRate >= 60 ? 'var(--color-green)' : 'var(--color-yellow)') : 'var(--text-dim)' }}>
                      {ex.successRate != null ? `${ex.successRate}%` : '—'}
                    </td>
                    <td style={{ padding: '8px 8px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{ex.avgLatency != null ? fmtMs(ex.avgLatency) : '—'}</td>
                    <td style={{ padding: '8px 8px', fontFamily: 'var(--font-mono)', fontSize: 11, color: ex.avgFillProbability != null && ex.avgFillProbability >= 80 ? 'var(--color-green)' : 'var(--text-muted)' }}>
                      {ex.avgFillProbability != null ? `${ex.avgFillProbability}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        {/* Reliability Leaderboard */}
        <Section title="🛡 Exchange Reliability Score">
          {reliability.length === 0 ? (
            <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>Acumulando metrics WS…</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {reliability.map((entry, i) => (
                <div key={entry.exchange} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 14, width: 20 }}>{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  '}</span>
                  <span style={{ width: 68, fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: EX_COLORS[entry.exchange] || '#aaa' }} />
                    {entry.exchange}
                  </span>
                  <div style={{ flex: 1 }}>
                    <ScoreBar score={entry.score} />
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', minWidth: 80, textAlign: 'right' }}>
                    {entry.staleCount > 0 && <span title="Stale feeds" style={{ marginRight: 4 }}>⚠{entry.staleCount}</span>}
                    {entry.wsDrops > 0 && <span title="WS drops">↻{entry.wsDrops}</span>}
                  </div>
                </div>
              ))}
              <p style={{ fontSize: 10, color: 'var(--text-dim)', margin: '4px 0 0' }}>
                Formula: WS uptime (40%) + Stale rate (30%) + Latency (20%) + Reconnections (10%)
              </p>
            </div>
          )}
        </Section>
      </div>

      {/* Volatility Filter */}
      <Section
        title=" Volatility Risk Filter"
        right={<span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Rolling 60 ticks BTC</span>}
      >
        <RiskStatus status={volatility.status} score={volatility.score} />
      </Section>

      {/* Predictive + Learning side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>

        {/* Predictive Ranking */}
        <Section title=" Predictive Opportunity Ranking">
          {predicted.length === 0 ? (
            <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
              Predictions appear after accumulating historical detections
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {predicted.map((pred, i) => <PredictiveCard key={pred.pair} pred={pred} rank={i} />)}
              <p style={{ fontSize: 10, color: 'var(--text-dim)', margin: '4px 0 0' }}>
                Based on: historical frequency (35%) · win rate (40%) · exchange latency (15%) · spread persistence (10%)
              </p>
            </div>
          )}
        </Section>

        {/* Historical Learning */}
        <Section title=" Historical Learning Engine">
          {learning.length === 0 ? (
            <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
              El engine de aprendizaje registra patrones de detection y execution
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {learning.slice(0, 6).map(entry => (
                <div key={entry.pair} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 10px',
                  background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 12 }}>{entry.pair}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                      {entry.detections} det · {entry.executions} exec · {entry.successes}✓ {entry.failures}✗
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: 900, fontSize: 15, fontFamily: 'var(--font-mono)', color: 'var(--color-green)' }}>
                      {entry.confidenceScore}%
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>confidence</div>
                  </div>
                </div>
              ))}
              <p style={{ fontSize: 10, color: 'var(--text-dim)', margin: '4px 0 0' }}>
                Confidence = sample size (40%) + win rate (40%) + detection frequency (20%). No AI — pure heuristic.
              </p>
            </div>
          )}
        </Section>
      </div>

      {/* Fill Probability Section — Always rendered to prevent layout shifts */}
      <Section title="🎯 Fill Probability Engine — Opportunity Actual">
        {!topViable ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: 13, minHeight: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            Searching opportunity viable para calculate probabilidad de execution...
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
              {/* Big score */}
              <div style={{ textAlign: 'center', minWidth: 80 }}>
                <div style={{ fontWeight: 900, fontSize: 40, fontFamily: 'var(--font-mono)', color: topViable.fillProbability >= 80 ? 'var(--color-green)' : topViable.fillProbability >= 50 ? 'var(--color-yellow)' : 'var(--color-red)' }}>
                  {topViable.fillProbability ?? '—'}%
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>Fill Probability</div>
              </div>
              {/* Breakdown */}
              {topViable.fillProbabilityBreakdown && (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {[
                    { label: 'Depth Score (40%)',    val: topViable.fillProbabilityBreakdown.depthScore },
                    { label: 'Spread Score (25%)',   val: topViable.fillProbabilityBreakdown.spreadScore },
                    { label: 'Latency Score (20%)',  val: topViable.fillProbabilityBreakdown.latencyScore },
                    { label: 'Liquidity Score (15%)',val: topViable.fillProbabilityBreakdown.liquidityScore },
                  ].map(({ label, val }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, width: 160, color: 'var(--text-dim)' }}>{label}</span>
                      <div style={{ flex: 1, height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ width: `${val}%`, height: '100%', background: scoreColor(val), borderRadius: 3 }} />
                      </div>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, minWidth: 24, textAlign: 'right', color: scoreColor(val) }}>{val}</span>
                    </div>
                  ))}
                </div>
              )}
              {/* Context */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150 }}>
                {[
                  { label: 'Par',           val: `${topViable.buyExchange} → ${topViable.sellExchange}` },
                  { label: 'Spread',        val: `${topViable.spreadPct}%` },
                  { label: 'Buy Fill',      val: `${topViable.buyFillPct ?? '—'}%` },
                  { label: 'Sell Fill',     val: `${topViable.sellFillPct ?? '—'}%` },
                  { label: 'Feed',          val: topViable.buySource === 'ws' && topViable.sellSource === 'ws' ? 'WS ×2' : 'Mixed' },
                  ...(topViable.recommendedSize != null ? [{ label: 'Tamyear Rec.', val: `${topViable.recommendedSize} BTC` }] : []),
                ].map(({ label, val }) => (
                  <div key={label} style={{ display: 'flex', gap: 8 }}>
                    <span style={{ fontSize: 10, color: 'var(--text-dim)', width: 80 }}>{label}:</span>
                    <span style={{ fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{val}</span>
                  </div>
                ))}
              </div>
            </div>
            <p style={{ fontSize: 10, color: 'var(--text-dim)', margin: '8px 0 0' }}>
              Fill Probability = Depth (40%) + Spread Edge vs Break-even (25%) + WS latency (20%) + Slippage method (15%). No usa valores aleatorios.
            </p>
          </>
        )}
      </Section>
    </div>
  );
}
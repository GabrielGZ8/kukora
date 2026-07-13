/**
 * QuantAnalyticsPanel.jsx — Kukora
 *
 * Dos capacidades news en un panel:
 *
 * TAB 1 — StatArb Cuantitativo
 *   Displays the Statistical Arbitrage signal using the correct model: log-spread
 *   estacionario, EWMA incremental (RiskMetrics λ=0.94), Z-score vs threshold,
 *   Bollinger Bands sobre el spread, y half-life de mean-reversion via AR(1).
 *   Differencedor: No comparable platform.
 *
 * TAB 2 — Missed Opportunities (Capture Rate)
 *   How much profit did the engine leave on the table? Breakdown by reason: cooldown,
 *   fingerprint, score bajo, daily stop-loss. Capture rate = trades ejecutados
 *   / (executed + missed). This self-analysis capability is what distinguishes
 *   a un system de trading serio de un prototype.
 */
import { requestArbitrage } from '../../api';
import { useState, useEffect, useCallback, useMemo } from 'react';

const fmtUSD = n => n == null || isNaN(n) ? '—' : `$${Number(n).toFixed(2)}`;
const fmtNum = (n, d = 2) => n == null || isNaN(n) ? '—' : Number(n).toFixed(d);

// ── StatArb Panel ──────────────────────────────────────────────────────────
function StatArbTab({ data }) {
  const signals   = useMemo(() => data?.statArbSignals || [], [data?.statArbSignals]);
  const pairs     = useMemo(() => data?.statArbSummary || [], [data?.statArbSummary]);
  const [retained, setRetained] = useState({ signals: [], pairs: [] });

  // Retain last non-empty values so the panel doesn't go blank between ticks
  useEffect(() => {
    if (signals.length)     setRetained(p => ({ ...p, signals }));
    if (pairs.length)       setRetained(p => ({ ...p, pairs }));
  }, [signals, pairs]);

  const { signals: sig, pairs: prs } = retained;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        <b>Model:</b> Z-score on <code>log(bid_B / ask_A)</code> — stationary and dimensionless signal (institutional pairs trading standard).
        Media y varianza calculadas con EWMA λ=0.94 (RiskMetrics). Half-life estimado via regresión AR(1): pares con half-life &gt;200 periods
        son trendles, no mean-reverting, y se descalifican.
      </div>

      {/* Active signals */}
      {sig.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Signales activas ({sig.length})
          </div>
          {sig.map((s, i) => {
            const zColor = s.zScore > 0 ? 'var(--color-green)' : 'var(--color-red)';
            return (
              <div key={i} style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 800, fontSize: 13 }}>{s.buyExchange} → {s.sellExchange}</span>
                  <span style={{ fontSize: 10, background: s.viable ? 'rgba(0,184,122,0.1)' : 'var(--bg-surface-2)', color: s.viable ? 'var(--color-green)' : 'var(--text-dim)', padding: '2px 8px', borderRadius: 99, fontWeight: 700 }}>
                    {s.viable ? 'VIABLE' : s.direction}
                  </span>
                  {s.isStrong && <span style={{ fontSize: 10, background: 'rgba(255,45,120,0.1)', color: '#FF2D78', padding: '2px 8px', borderRadius: 99, fontWeight: 800 }}>FUERTE</span>}
                  {!s.isMeanReverting && <span style={{ fontSize: 10, background: 'rgba(245,158,11,0.1)', color: '#F59E0B', padding: '2px 8px', borderRadius: 99 }}>trending — no mean-reverting</span>}
                  <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)' }}>confidence {s.confidence}%</span>
                </div>
                <div style={{ display: 'flex', gap: 20, fontSize: 11, fontFamily: 'var(--font-mono)', flexWrap: 'wrap' }}>
                  <span>Z: <b style={{ color: zColor, fontSize: 14 }}>{fmtNum(s.zScore, 3)}</b></span>
                  <span>log-spread: <b>{fmtNum(s.logSpread, 5)}</b></span>
                  <span>EWMA μ: <b>{fmtNum(s.ewmaMean, 5)}</b></span>
                  <span>EWMA σ: <b>{fmtNum(s.ewmaStd, 5)}</b></span>
                  {s.halfLife != null && <span>half-life: <b style={{ color: s.halfLife < 50 ? 'var(--color-green)' : s.halfLife < 150 ? 'var(--color-yellow)' : 'var(--color-red)' }}>{s.halfLife}p</b></span>}
                  <span>gross spread: <b>{fmtNum(s.pctSpread, 4)}%</b></span>
                  <span>muestras: <b>{s.samples}</b></span>
                </div>
                {s.bollinger && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 9, color: 'var(--text-dim)', width: 60 }}>Bollinger %B</span>
                    <div style={{ flex: 1, height: 6, background: 'var(--bg-surface-2)', borderRadius: 3, position: 'relative' }}>
                      <div style={{ position: 'absolute', left: `${s.bollinger.pct_b * 100}%`, top: -2, width: 10, height: 10, borderRadius: '50%', background: zColor, transform: 'translateX(-50%)' }} />
                    </div>
                    <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-dim)', width: 36 }}>{(s.bollinger.pct_b * 100).toFixed(0)}%</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* All tracked pairs */}
      {prs.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Todos los pares monitoreados ({prs.length})
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: 'var(--bg-surface-2)' }}>
                {['Pair', 'Samples', 'EWMA μ (log)', 'Half-Life', 'Mean-Reverting'].map(h => (
                  <th key={h} style={{ padding: '6px 12px', textAlign: 'left', fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {prs.map(p => (
                <tr key={p.pair} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '7px 12px', fontWeight: 700 }}>{p.pair}</td>
                  <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)' }}>{p.samples}</td>
                  <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', color: p.ewmaMean > 0 ? 'var(--color-green)' : 'var(--color-red)' }}>{fmtNum(p.ewmaMean, 6)}</td>
                  <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', color: !p.halfLife ? 'var(--text-dim)' : p.halfLife < 50 ? 'var(--color-green)' : p.halfLife < 150 ? 'var(--color-yellow)' : 'var(--color-red)' }}>
                    {p.halfLife != null ? `${p.halfLife}p` : '—'}
                  </td>
                  <td style={{ padding: '7px 12px' }}>
                    <span style={{ fontSize: 9, fontWeight: 800, color: p.isMeanReverting ? 'var(--color-green)' : 'var(--text-dim)' }}>
                      {p.isMeanReverting ? '✓ Sí' : '✕ No'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!sig.length && !prs.length && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
          Acumulando history de prices… Se necesitan ≥30 ticks por par para calculate Z-score EWMA y half-life AR(1).
        </div>
      )}
    </div>
  );
}

// ── Missed Opportunities Panel ─────────────────────────────────────────────
const REASON_LABELS = {
  cooldown:       { label: 'Cooldown between trades', color: '#5741D9', desc: 'System respected the minimum interval between executions to avoid simultaneous trades' },
  fingerprint:    { label: 'Repeated fingerprint', color: '#F0B90B', desc: 'Same spread detected <5s ago — high probability of stale data' },
  score_too_low:  { label: 'Score below threshold', color: '#F59E0B', desc: 'Opportunity was viable but its composite score fell below the configured minimum' },
  circuit_breaker:{ label: 'Circuit breaker', color: 'var(--color-red)', desc: 'Spread was outside the valid range (too small or too large)' },
  daily_loss:     { label: 'Daily loss stop', color: 'var(--color-red)', desc: 'El engine de risk detuvo operations por loss diaria acumulada' },
  liquidity:      { label: 'Insufficient liquidity', color: '#aaa', desc: 'Order book lacked sufficient depth for the trade size' },
  other:          { label: 'Otras razones', color: '#aaa', desc: '' },
};

function MissedTab({ data }) {
  const [summary, setSummary] = useState(null);
  const [recent,  setRecent]  = useState([]);

  const fetchMissed = useCallback(async () => {
    try {
      const j = await requestArbitrage('missed?limit=20');
      if (j?.ok) { setSummary(j.summary); setRecent(j.recent); }
    } catch { /* keep previous */ }
  }, []);

  useEffect(() => {
    // Also update from SSE payload for the summary (comes every 5 ticks)
    if (data?.missedSummary) setSummary(data.missedSummary);
  }, [data?.missedSummary]);

  useEffect(() => {
    fetchMissed();
    const t = setInterval(fetchMissed, 5000);
    return () => clearInterval(t);
  }, [fetchMissed]);

  if (!summary) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>Acumulando datos…</div>;

  const captureColor = summary.captureRate == null ? 'var(--text-dim)'
    : summary.captureRate >= 60 ? 'var(--color-green)'
    : summary.captureRate >= 30 ? 'var(--color-yellow)' : 'var(--color-red)';

  const maxByReason = Math.max(1, ...Object.values(summary.byReason).map(v => v.count));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        El ROI real no es solo lo que ganaste — es qué tan eficientemente capturaste las opportunities que el market ofreció.
        <b> Capture rate</b> = trades ejecutados ÷ (ejecutados + perdidos). Esta metric es estándar en market-making institucional.
      </div>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        {[
          { label: 'Capture Rate', value: summary.captureRate != null ? `${summary.captureRate}%` : '—', color: captureColor },
          { label: 'Trades ejecutados', value: summary.totalExecutedCount, color: 'var(--color-green)' },
          { label: 'Missed Opportunities', value: summary.totalMissedCount, color: 'var(--text-dim)' },
          { label: 'Missed Profit Left on Table', value: fmtUSD(summary.totalMissedProfit), color: 'var(--color-red)' },
        ].map(k => (
          <div key={k.label} className="card" style={{ padding: '12px 14px', textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', fontWeight: 700, marginBottom: 6 }}>{k.label}</div>
            <div style={{ fontSize: 22, fontWeight: 900, fontFamily: 'var(--font-mono)', color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* By reason */}
      <div className="card" style={{ padding: '14px 18px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>By reason</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {Object.entries(summary.byReason)
            .filter(([, v]) => v.count > 0)
            .sort(([, a], [, b]) => b.count - a.count)
            .map(([key, v]) => {
              const meta = REASON_LABELS[key] || { label: key, color: '#aaa' };
              return (
                <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                    <span style={{ fontWeight: 700, color: meta.color }}>{meta.label}</span>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{v.count} miss · <span style={{ color: 'var(--color-red)' }}>-{fmtUSD(v.profit)}</span></span>
                  </div>
                  <div style={{ height: 6, background: 'var(--bg-surface-2)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${(v.count / maxByReason) * 100}%`, background: meta.color, opacity: 0.6 }} />
                  </div>
                  {meta.desc && <div style={{ fontSize: 9, color: 'var(--text-dim)', fontStyle: 'italic' }}>{meta.desc}</div>}
                </div>
              );
            })}
          {!Object.values(summary.byReason).some(v => v.count > 0) && (
            <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>No missed opportunities recorded in this session yet.</div>
          )}
        </div>
      </div>

      {/* Recent missed */}
      {recent.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Últimas perdidas
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: 'var(--bg-surface-2)' }}>
                {['Pair', 'Reason', 'Lost profit', 'Score', 'Time'].map(h => (
                  <th key={h} style={{ padding: '6px 12px', textAlign: 'left', fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recent.slice(0, 15).map((m, i) => {
                const meta = REASON_LABELS[m.reason] || { label: m.reason, color: '#aaa' };
                return (
                  <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 12px', fontWeight: 700 }}>{m.pair}</td>
                    <td style={{ padding: '6px 12px' }}><span style={{ fontSize: 9, fontWeight: 700, color: meta.color }}>{meta.label}</span></td>
                    <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', color: 'var(--color-red)' }}>-{fmtUSD(m.netProfit)}</td>
                    <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>{m.score}</td>
                    <td style={{ padding: '6px 12px', fontSize: 10, color: 'var(--text-dim)' }}>{new Date(m.ts).toLocaleTimeString('es-MX')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────
export default function QuantAnalyticsPanel({ data }) {
  const [tab, setTab] = useState('statarrb');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        padding: '12px 18px',
        background: 'linear-gradient(135deg, rgba(87,65,217,0.08), rgba(255,45,120,0.05))',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
      }}>
        <div style={{ fontWeight: 900, fontSize: 16, letterSpacing: '-0.02em' }}>∿ StatArb — Module Cuantitativo</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4, lineHeight:1.55 }}>
          Module complementario al engine de arbitraje bilateral. Calcula signales statistics sobre el log-spread entre pares de exchanges usando EWMA (λ=0.94) y AR(1) para estimar el half-life de mean-reversion. Cuando el Z-score supera el threshold, el spread tiene alta probabilidad de revertir — signal que puede usarse como filtro de confirmación en la execution. El Capture Rate mide qué percentage del P&L teórico available fue capturado realmente por el engine.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        {[
          { id: 'statarrb', label: '📈 StatArb — Log-Spread EWMA' },
          { id: 'missed',   label: '💸 Capture Rate & Misses' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '7px 16px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
            border: tab === t.id ? '1px solid #5741D9' : '1px solid var(--border)',
            background: tab === t.id ? 'rgba(87,65,217,0.08)' : 'var(--bg-surface)',
            color: tab === t.id ? '#5741D9' : 'var(--text)',
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'statarrb' && <StatArbTab data={data} />}
      {tab === 'missed'   && <MissedTab  data={data} />}
    </div>
  );
}

/**
 * AdaptivePanel.jsx — Kukora
 *
 * Dos systems que ahour funcionan con datos reales (antes estaban connecteds
 * pero no data):
 *
 * TAB 1 — Exchange Reliability (Dynamic)
 *   Muestra el reliability score de cada exchange basado en el comportamiento
 *   real del WS en los lasts 5 minutes: freshness, error rate, latency vs
 *   baseline. Exchanges with reliability < 85 receive a penalty
 *   automatically applied to opportunity scoring (getDynamicPenalty).
 *
 * TAB 2 — Adaptive Parameter Recommendation
 *   After each executed trade, the system runs a mini parameter sweep
 *   con walk-forward validation para determinar si los parameters actuales
 *   (minScore=65, cooldown=3s) son optimals para la session actual. Si encuentra
 *   a significantly better configuration, it is reported here.
 */
import { requestArbitrage } from '../../api';
import { useState, useEffect, useCallback } from 'react';
import AlertsConfigPanel from './AlertsConfigPanel';

const EX_COLORS = { Binance: '#F0B90B', Kraken: '#5741D9', Bybit: '#F7A600', Coinbase: '#0052FF', OKX: '#aaa' };
const fmtMs = ms => ms == null ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms/1000).toFixed(1)}s`;

function ReliabilityBar({ score }) {
  const color = score >= 85 ? 'var(--color-green)' : score >= 60 ? 'var(--color-yellow)' : 'var(--color-red)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 8, background: 'var(--bg-surface-2)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${score}%`, height: '100%', background: color, transition: 'width 0.4s', borderRadius: 4 }} />
      </div>
      <span style={{ width: 36, fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 800, color, textAlign: 'right' }}>{score}</span>
    </div>
  );
}

// ── Reliability Tab ─────────────────────────────────────────────────────────
function ReliabilityTab({ data }) {
  const [scores, setScores]   = useState([]);
  const [retained, setRetained] = useState([]);

  const fetchScores = useCallback(async () => {
    try {
      const j = await requestArbitrage('reliability');
      if (j?.ok && j.data?.length) { setScores(j.data); setRetained(j.data); }
    } catch { /* keep previous */ }
  }, []);

  // Also consume from SSE payload (every 8 ticks)
  useEffect(() => {
    if (data?.reliabilityScores?.length) {
      setScores(data.reliabilityScores);
      setRetained(data.reliabilityScores);
    }
  }, [data?.reliabilityScores]);

  useEffect(() => {
    fetchScores();
    const t = setInterval(fetchScores, 8000);
    return () => clearInterval(t);
  }, [fetchScores]);

  const display = scores.length ? scores : retained;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        Reliability score por exchange en los lasts 5 minutes, basado en: frescura del feed (40%), rate de errores WS (30%), y latency vs baseline (30%).
        Exchanges with score &lt;85 receive an automatic penalty in opportunity scoring.
      </div>

      {!display.length && (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
          Acumulando datos de WS... Available en ~30 seconds de operation.
        </div>
      )}

      {display.map(ex => (
        <div key={ex.exchange} className="card" style={{
          padding: '14px 18px',
          border: ex.reliabilityScore < 60 ? '1px solid rgba(240,62,62,0.3)' :
                  ex.reliabilityScore < 85 ? '1px solid rgba(245,158,11,0.25)' : '1px solid var(--border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: EX_COLORS[ex.exchange] || '#999', flexShrink: 0 }} />
            <span style={{ fontWeight: 800, fontSize: 13 }}>{ex.exchange}</span>
            {ex.penalty > 0 && (
              <span style={{ fontSize: 9, fontWeight: 800, color: 'var(--color-red)', background: 'rgba(240,62,62,0.08)', padding: '2px 8px', borderRadius: 99, border: '1px solid rgba(240,62,62,0.2)' }}>
                −{ex.penalty} pts de scoring
              </span>
            )}
            {ex.reliabilityScore >= 85 && (
              <span style={{ fontSize: 9, fontWeight: 800, color: 'var(--color-green)', background: 'rgba(0,184,122,0.08)', padding: '2px 8px', borderRadius: 99 }}>
                ✓ Saludable
              </span>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
              {ex.lastUpdateAgoMs != null ? `last update: ${fmtMs(ex.lastUpdateAgoMs)}` : '—'}
            </span>
          </div>
          <ReliabilityBar score={ex.reliabilityScore} />
          <div style={{ display: 'flex', gap: 18, marginTop: 8, fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
            <span>eventos recents: <b>{ex.recentEvents}</b></span>
            {ex.baselineLatencyMs != null && <span>latency baseline: <b>{fmtMs(ex.baselineLatencyMs)}</b></span>}
            <span>penalty: <b style={{ color: ex.penalty > 0 ? 'var(--color-red)' : 'var(--text-dim)' }}>−{ex.penalty}</b></span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Adaptive Recommendation Tab ─────────────────────────────────────────────
function AdaptiveTab({ data }) {
  const [rec, setRec]       = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchRec = useCallback(async () => {
    try {
      const j = await requestArbitrage('adaptive-recommendation');
      if (j?.ok) setRec(j.data);
    } catch { /* keep previous */ }
    finally { setLoading(false); }
  }, []);

  // Also consume from SSE (every 15 ticks)
  useEffect(() => {
    if (data?.adaptiveRecommendation !== undefined) {
      setRec(data.adaptiveRecommendation);
      setLoading(false);
    }
  }, [data?.adaptiveRecommendation]);

  useEffect(() => {
    fetchRec();
    const t = setInterval(fetchRec, 30_000); // refresh every 30s
    return () => clearInterval(t);
  }, [fetchRec]);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>Calculando…</div>;

  if (!rec) return (
    <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
      La recomendación adaptiva se genera después de ≥10 trades ejecutados.
      El system necesita history real para optimizar — esto es intencional:
      no tiene sentido optimizar parameters con 2 trades.
    </div>
  );

  const upliftColor = rec.upliftPct == null ? 'var(--text-dim)'
    : rec.upliftPct > 10 ? 'var(--color-green)'
    : rec.upliftPct < -5 ? 'var(--color-red)' : 'var(--color-yellow)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        Basado en {rec.basedOnTrades} trades y {rec.viableOps} opportunities viables de esta session.
        Walk-forward validation: sweep en el 70% de datos, validación en el 30% out-of-sample.
        Solo se recomienda cambiar si el uplift out-of-sample es &gt;10%.
      </div>

      {/* Uplift callout */}
      {rec.isSignificant && (
        <div style={{
          padding: '12px 16px', borderRadius: 'var(--radius-lg)',
          background: 'rgba(0,184,122,0.07)', border: '1px solid rgba(0,184,122,0.25)',
        }}>
          <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--color-green)', marginBottom: 6 }}>
            ★ Opportunity de improvement detectada
          </div>
          <div style={{ fontSize: 12 }}>{rec.message}</div>
        </div>
      )}
      {!rec.isSignificant && (
        <div style={{
          padding: '12px 16px', borderRadius: 'var(--radius-lg)',
          background: 'rgba(87,65,217,0.05)', border: '1px solid rgba(87,65,217,0.15)',
        }}>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{rec.message}</div>
        </div>
      )}

      {/* Current vs Best */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div className="card" style={{ padding: '14px 18px', border: '1px solid rgba(0,82,255,0.2)' }}>
          <div style={{ fontSize: 9, fontWeight: 800, color: '#0052FF', textTransform: 'uppercase', marginBottom: 8 }}>● Config actual</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span>minScore: <b style={{ fontFamily: 'var(--font-mono)' }}>{rec.current.minScore}</b></span>
            <span>cooldown: <b style={{ fontFamily: 'var(--font-mono)' }}>{rec.current.cooldownMs / 1000}s</b></span>
            <span>P&L (val): <b style={{ fontFamily: 'var(--font-mono)', color: rec.current.validatePnl >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>
              {rec.current.validatePnl >= 0 ? '+' : ''}${rec.current.validatePnl?.toFixed(4)}
            </b></span>
            <span>Sharpe: <b style={{ fontFamily: 'var(--font-mono)' }}>{rec.current.validateSharpe}</b></span>
          </div>
        </div>

        <div className="card" style={{ padding: '14px 18px', border: `1px solid ${rec.isSignificant ? 'rgba(0,184,122,0.3)' : 'var(--border)'}` }}>
          <div style={{ fontSize: 9, fontWeight: 800, color: rec.isSignificant ? 'var(--color-green)' : 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 8 }}>
            {rec.isSignificant ? '★ Recommended config' : '◦ Optimal config found'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            <span>minScore: <b style={{ fontFamily: 'var(--font-mono)' }}>{rec.best.minScore}</b></span>
            <span>cooldown: <b style={{ fontFamily: 'var(--font-mono)' }}>{rec.best.cooldownMs / 1000}s</b></span>
            <span>P&L (val): <b style={{ fontFamily: 'var(--font-mono)', color: rec.best.validatePnl >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>
              {rec.best.validatePnl >= 0 ? '+' : ''}${rec.best.validatePnl?.toFixed(4)}
            </b></span>
            <span>Sharpe: <b style={{ fontFamily: 'var(--font-mono)' }}>{rec.best.validateSharpe}</b></span>
            <span>Robustez: <b style={{ fontFamily: 'var(--font-mono)', color: (rec.best.stability || 0) > 0.7 ? 'var(--color-green)' : 'var(--color-yellow)' }}>{rec.best.stability}</b></span>
          </div>
        </div>
      </div>

      {/* Uplift */}
      {rec.upliftPct != null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Uplift out-of-sample estimado:</span>
          <span style={{ fontSize: 18, fontWeight: 900, fontFamily: 'var(--font-mono)', color: upliftColor }}>
            {rec.upliftPct >= 0 ? '+' : ''}{rec.upliftPct}%
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>Confidence: <b>{rec.confidence}</b> ({rec.basedOnTrades} trades)</span>
        </div>
      )}

      {/* Top results table */}
      {rec.topResults?.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' }}>
            Top {rec.topResults.length} combinaciones (out-of-sample)
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: 'var(--bg-surface-2)' }}>
                {['minScore', 'Cooldown', 'P&L (val)', 'Sharpe', 'Trades'].map(h => (
                  <th key={h} style={{ padding: '6px 14px', textAlign: 'left', fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rec.topResults.map((r, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--border)', background: i === 0 ? 'rgba(0,184,122,0.04)' : undefined }}>
                  <td style={{ padding: '6px 14px', fontFamily: 'var(--font-mono)' }}>{i === 0 ? '★ ' : ''}{r.minScore}</td>
                  <td style={{ padding: '6px 14px', fontFamily: 'var(--font-mono)' }}>{r.cooldownMs / 1000}s</td>
                  <td style={{ padding: '6px 14px', fontFamily: 'var(--font-mono)', color: r.pnl >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>
                    {r.pnl >= 0 ? '+' : ''}${r.pnl?.toFixed(4)}
                  </td>
                  <td style={{ padding: '6px 14px', fontFamily: 'var(--font-mono)' }}>{r.sharpe}</td>
                  <td style={{ padding: '6px 14px', fontFamily: 'var(--font-mono)' }}>{r.trades}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function AdaptivePanel({ data }) {
  const [tab, setTab] = useState('reliability');

  // Badge: number of exchanges with reliability < 85
  const degraded = (data?.reliabilityScores || []).filter(s => s.reliabilityScore < 85).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        padding: '12px 18px',
        background: 'linear-gradient(135deg, rgba(87,65,217,0.07), rgba(0,184,122,0.05))',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
      }}>
        <div style={{ fontWeight: 900, fontSize: 16, letterSpacing: '-0.02em' }}>🔁 System Adaptivo</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
          Reliability dinámica de exchanges (penaliza el scoring in real time) · Recomendación adaptiva de parameters con walk-forward validation
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        {[
          { id: 'reliability', label: `📡 Exchange Reliability${degraded > 0 ? ` (${degraded} degraded)` : ''}` },
          { id: 'adaptive',   label: '🎯 Optimal Parameters' },
          { id: 'alerts',     label: '🔔 Automatic Alerts' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '7px 16px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
            border: tab === t.id ? '1px solid #5741D9' : '1px solid var(--border)',
            background: tab === t.id ? 'rgba(87,65,217,0.08)' : 'var(--bg-surface)',
            color: tab === t.id ? '#5741D9' : degraded > 0 && t.id === 'reliability' ? 'var(--color-yellow)' : 'var(--text)',
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'reliability' && <ReliabilityTab data={data} />}
      {tab === 'adaptive'    && <AdaptiveTab    data={data} />}
      {tab === 'alerts'      && <AlertsConfigPanel />}
    </div>
  );
}

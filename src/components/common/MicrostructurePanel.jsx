/**
 * MicrostructurePanel.jsx — Kukora
 *
 * Improvement #7: "Opportunity decay curve" — duration de vida media de
 * opportunities por par de exchanges (media, p50, p90).
 *
 * Improvement #8: "Latency racing visualization" — cuando un movimiento de
 * real price move occurs, which exchange reports it first and how long the others
 * take to reflect it. This propagation divergence is the reason why
 * que el arbitraje existe.
 */
import { requestArbitrage } from '../../api';
import { useState, useEffect, useCallback } from 'react';

const EX_COLORS = { Binance: '#F0B90B', Kraken: '#5741D9', Bybit: '#F7A600', Coinbase: '#0052FF', OKX: '#aaa' };
const fmtMs = ms => ms == null ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;

function DecayCurveTable() {
  const [curve, setCurve] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchCurve = useCallback(async () => {
    try {
      const json = await requestArbitrage('decay-curve');
      if (json?.ok) setCurve(json.data);
    } catch { /* keep previous */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchCurve();
    const t = setInterval(fetchCurve, 8000);
    return () => clearInterval(t);
  }, [fetchCurve]);

  if (loading) return <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>Calculando distribution…</div>;
  if (!curve.length) return (
    <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
      Not enough expired opportunities to build the distribution yet. This accumulates with engine operation time.
    </div>
  );

  const maxMean = Math.max(...curve.map(c => c.p90Ms), 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {curve.map(c => {
        const [buy, sell] = c.pair.split('→');
        return (
          <div key={c.pair} style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 10, borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: EX_COLORS[buy] }}>{buy}</span>→<span style={{ color: EX_COLORS[sell] }}>{sell}</span>
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{c.sampleCount} muestras</span>
            </div>
            <div style={{ position: 'relative', height: 20, background: 'var(--bg-surface-2)', borderRadius: 4 }}>
              {/* p90 bar (background, lighter) */}
              <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${(c.p90Ms / maxMean) * 100}%`, background: 'rgba(0,184,122,0.15)', borderRadius: 4 }} />
              {/* mean bar (foreground, solid) */}
              <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${(c.meanMs / maxMean) * 100}%`, background: 'rgba(0,184,122,0.55)', borderRadius: 4 }} />
            </div>
            <div style={{ display: 'flex', gap: 16, fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
              <span>media: <b style={{ color: 'var(--text)' }}>{fmtMs(c.meanMs)}</b></span>
              <span>p50: <b style={{ color: 'var(--text)' }}>{fmtMs(c.p50Ms)}</b></span>
              <span>p90: <b style={{ color: 'var(--text)' }}>{fmtMs(c.p90Ms)}</b></span>
              <span>max: <b style={{ color: 'var(--text)' }}>{fmtMs(c.maxMs)}</b></span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LatencyRacingFeed() {
  const [rounds, setRounds] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchRacing = useCallback(async () => {
    try {
      const json = await requestArbitrage('latency-racing?limit=15');
      if (json?.ok) { setRounds(json.rounds); setLeaderboard(json.leaderboard); }
    } catch { /* keep previous */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchRacing();
    const t = setInterval(fetchRacing, 3000);
    return () => clearInterval(t);
  }, [fetchRacing]);

  if (loading) return <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>Esperando movimientos de price…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {leaderboard.length > 0 && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {leaderboard.map(l => (
            <div key={l.exchange} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: EX_COLORS[l.exchange] }} />
              <b>{l.exchange}</b>
              <span style={{ color: 'var(--text-dim)' }}>lidera {l.winRatePct}% ({l.wins})</span>
            </div>
          ))}
        </div>
      )}

      {!rounds.length && (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
          No price propagation round detected yet (requires 2+ exchanges moving price within a ~400ms window).
        </div>
      )}

      {rounds.map((r, i) => {
        const maxDelta = Math.max(...r.updates.map(u => u.deltaMs), 1);
        return (
          <div key={r.startTs + i} className="card" style={{ padding: '10px 14px' }}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 8 }}>
              {new Date(r.startTs).toLocaleTimeString('en-US')} · led by <b style={{ color: EX_COLORS[r.leader] }}>{r.leader}</b> · total propagation {fmtMs(r.spanMs)}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {r.updates.map(u => (
                <div key={u.exchange} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 64, fontSize: 10, fontWeight: 700, color: EX_COLORS[u.exchange] }}>{u.exchange}</span>
                  <div style={{ flex: 1, height: 6, background: 'var(--bg-surface-2)', borderRadius: 3, position: 'relative' }}>
                    <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${Math.max(2, (u.deltaMs / maxDelta) * 100)}%`, background: EX_COLORS[u.exchange], borderRadius: 3, opacity: u.deltaMs === 0 ? 1 : 0.55 }} />
                  </div>
                  <span style={{ width: 50, fontSize: 10, fontFamily: 'var(--font-mono)', textAlign: 'right' }}>{u.deltaMs === 0 ? 'primero' : `+${fmtMs(u.deltaMs)}`}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function MicrostructurePanel() {
  const [tab, setTab] = useState('decay');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        padding: '12px 18px',
        background: 'linear-gradient(135deg, rgba(255,45,120,0.06), rgba(88,65,217,0.06))',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
      }}>
        <div style={{ fontWeight: 900, fontSize: 16, letterSpacing: '-0.02em' }}>🔬 Microestructura de Market</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
          Insights reales sobre por qué existe el arbitraje: cuánto dura una opportunity y qué exchange propaga primero los movimientos de price.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        {[{ id: 'decay', label: '⏳ Decay Curve' }, { id: 'racing', label: '🏁 Latency Racing' }].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
            border: tab === t.id ? '1px solid #FF2D78' : '1px solid var(--border)',
            background: tab === t.id ? 'rgba(255,45,120,0.08)' : 'var(--bg-surface)',
            color: tab === t.id ? '#FF2D78' : 'var(--text)',
          }}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: '16px 18px' }}>
        {tab === 'decay' ? <DecayCurveTable /> : <LatencyRacingFeed />}
      </div>
    </div>
  );
}

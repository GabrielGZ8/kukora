/**
 * SummaryPage.jsx — Kukora
 *
 * v10: loads the best moment of the day (from /api/arbitrage/replays/best)
 * and accumulated session statistics (not just the instantaneous status).
 */
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useArbitrageStream } from '../hooks/useArbitrageStream';
import SystemHealthStrip from '../components/common/SystemHealthStrip';
import { api } from '../api';

const fmt    = (n, d = 2) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtUSD = (n, d = 2) => (n == null || isNaN(n)) ? '—' : `$${fmt(n, d)}`;
const pct    = n => (n == null || isNaN(n)) ? '—' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(2)}%`;

function ArchStep({ icon, label, sub, color }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, minWidth: 90 }}>
      <div style={{
        width: 48, height: 48, borderRadius: 12, background: `${color}15`, border: `1px solid ${color}40`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
      }}>{icon}</div>
      <div style={{ fontSize: 10, fontWeight: 800, textAlign: 'center', lineHeight: 1.2 }}>{label}</div>
      <div style={{ fontSize: 8, color: 'var(--text-dim)', textAlign: 'center', maxWidth: 90, lineHeight: 1.3 }}>{sub}</div>
    </div>
  );
}

function Arrow() {
  return <div style={{ fontSize: 16, color: 'var(--border)', marginTop: 12, flexShrink: 0 }}>→</div>;
}

function KPI({ label, value, color, sub, highlight }) {
  return (
    <div style={{
      flex: 1, textAlign: 'center', padding: '12px 8px',
      background: highlight ? `${highlight}08` : undefined,
      borderRadius: highlight ? 10 : 0,
      border: highlight ? `1px solid ${highlight}25` : undefined,
    }}>
      <div style={{ fontSize: 8, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 900, fontFamily: 'var(--font-mono)', color: color || 'var(--text)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

// ─── Daily Stats Panel ────────────────────────────────────────────────────────

function DailyStatsPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get('/api/arbitrage/daily-stats?days=7')
      .then(data => { if (!cancelled) setData(data); })
      .catch(() => { /* keep empty state — server may not have data yet */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="card" style={{ padding: '14px 20px' }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>📅 Operation History</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Loading...</div>
      </div>
    );
  }

  if (!data || !data.days || !data.days.length) {
    return (
      <div className="card" style={{ padding: '14px 20px' }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>📅 Operation History</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>No trades yet in this session. Historical data will appear here after the first executed trade.</div>
      </div>
    );
  }

  const { days, totals } = data;

  return (
    <div className="card" style={{ padding: '14px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>📅 Operation History</div>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 2 }}>Real accumulated data — persists across restarts</div>
        </div>
        {totals && (
          <div style={{ display: 'flex', gap: 16, fontSize: 10 }}>
            <span><b style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-green)' }}>{totals.trades}</b> <span style={{ color: 'var(--text-dim)' }}>trades totales</span></span>
            <span><b style={{ fontFamily: 'var(--font-mono)', color: totals.pnl >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>{totals.pnl >= 0 ? '+' : ''}{fmtUSD(totals.pnl)}</b> <span style={{ color: 'var(--text-dim)' }}>P&L total</span></span>
            {totals.avgCaptureRate != null && (
              <span><b style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-yellow)' }}>{totals.avgCaptureRate}%</b> <span style={{ color: 'var(--text-dim)' }}>capture rate prom.</span></span>
            )}
          </div>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['Date', 'Trades', 'Net P&L', 'Win Rate', 'Fees', 'Capture Rate', 'Best Opportunity'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 700, color: 'var(--text-dim)', fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((d, i) => (
              <tr key={d.date} style={{ borderBottom: i < days.length - 1 ? '1px solid var(--border)' : 'none', background: d.isToday ? 'rgba(0,184,122,0.04)' : 'transparent' }}>
                <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)', fontSize: 9, whiteSpace: 'nowrap' }}>
                  {d.date}
                  {d.isToday && <span style={{ marginLeft: 5, fontSize: 7, background: 'rgba(0,184,122,0.15)', color: 'var(--color-green)', padding: '1px 4px', borderRadius: 3, fontWeight: 700 }}>HOY</span>}
                </td>
                <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{d.trades ?? '—'}</td>
                <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)', fontWeight: 700, color: (d.pnl || 0) >= 0 ? 'var(--color-green)' : 'var(--color-red)', whiteSpace: 'nowrap' }}>
                  {d.pnl != null ? `${d.pnl >= 0 ? '+' : ''}${fmtUSD(d.pnl, 4)}` : '—'}
                </td>
                <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)' }}>
                  {d.winRate != null ? `${d.winRate}%` : '—'}
                </td>
                <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                  {d.fees != null ? fmtUSD(d.fees, 4) : '—'}
                </td>
                <td style={{ padding: '6px 8px', fontFamily: 'var(--font-mono)' }}>
                  {d.captureRate != null ? `${d.captureRate}%` : '—'}
                </td>
                <td style={{ padding: '6px 8px', fontSize: 9, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                  {d.bestOpp
                    ? <span><b style={{ color: 'var(--text)' }}>{d.bestOpp.pair}</b> · <span style={{ color: 'var(--color-green)', fontFamily: 'var(--font-mono)' }}>+{fmtUSD(d.bestOpp.netProfit, 4)}</span> · {d.bestOpp.spreadPct?.toFixed(4)}%</span>
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── E2E Latency Panel ────────────────────────────────────────────────────────

function E2ELatencyPanel() {
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.get('/api/arbitrage/e2e-latency?samples=60')
        .then(data => { if (!cancelled) setData(data); })
        .catch(() => { /* transient — retry on next interval */ });
    };
    load();
    const id = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const latColor = ms => ms == null ? 'var(--text-dim)' : ms < 20 ? 'var(--color-green)' : ms < 60 ? 'var(--color-yellow)' : 'var(--color-red)';

  if (!data || data.sampleCount === 0) {
    return (
      <div className="card" style={{ padding: '14px 20px' }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>⚡ E2E Pipeline Latency</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Acumulando muestras — aparece tras los primeros ticks de WebSocket...</div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: '14px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>⚡ E2E Pipeline Latency</div>
        <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>WS raw → detectOpportunities() complete · {data.sampleCount} samples</div>
      </div>

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {[
          { label: 'p50 E2E', value: data.e2e?.p50, unit: 'ms', note: 'mediana' },
          { label: 'p95 E2E', value: data.e2e?.p95, unit: 'ms', note: '95th percentile' },
          { label: 'p99 E2E', value: data.e2e?.p99, unit: 'ms', note: '99th percentile' },
          { label: 'getOrderBooks', value: data.bookRecv?.p50, unit: 'ms', note: 'p50 fetch books' },
          { label: 'detectOpps', value: data.detect?.p50, unit: 'ms', note: 'p50 engine O(n²)' },
          { label: 'Last tick', value: data.recentMs, unit: 'ms', note: 'most recent' },
        ].map(({ label, value, unit, note }) => (
          <div key={label} style={{ flex: 1, minWidth: 90, textAlign: 'center', padding: '10px 6px', background: 'var(--bg-surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 7, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 900, fontFamily: 'var(--font-mono)', color: latColor(value), lineHeight: 1 }}>
              {value != null ? `${value}` : '—'}
              {value != null && <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-dim)' }}>{unit}</span>}
            </div>
            <div style={{ fontSize: 8, color: 'var(--text-dim)', marginTop: 3 }}>{note}</div>
          </div>
        ))}
      </div>

      {/* By exchange breakdown */}
      {data.byExchange && Object.keys(data.byExchange).length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {Object.entries(data.byExchange).map(([ex, s]) => (
            <div key={ex} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: 'var(--bg-surface)', borderRadius: 6, border: '1px solid var(--border)', fontSize: 9 }}>
              <span style={{ fontWeight: 700 }}>{ex}</span>
              <span style={{ color: latColor(s.p50), fontFamily: 'var(--font-mono)' }}>{s.p50}ms p50</span>
              <span style={{ color: 'var(--text-dim)' }}>· {s.count} samples</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SummaryPage() {
  const navigate = useNavigate();
  const { data }  = useArbitrageStream();

  const [bestMoment, setBestMoment]  = useState(null);
  const [sessionBest, setSessionBest] = useState({ pnl: null, trades: null, roi: null, avgAdvantage: null });
  const sessionBestRef = useRef({ pnl: null, trades: null, roi: null, avgAdvantage: null });

  // Load best replay of the day
  useEffect(() => {
    let cancelled = false;
    api.get('/api/arbitrage/replays/best')
      .then(data => { if (!cancelled && data) setBestMoment(data); })
      .catch(() => { /* no replay data yet — silently ignore */ });
    return () => { cancelled = true; };
  }, []);

  // Update session best — retain peak values, don't reset to zero on quiet ticks
  useEffect(() => {
    const prev = sessionBestRef.current;
    const pnl     = data?.pnl?.totalPnl ?? data?.pnl?.realizedPnl ?? prev.pnl;
    const trades  = data?.capitalEfficiency?.totalTradesSession ?? data?.history?.length ?? prev.trades;
    const roi     = data?.capitalEfficiency?.roiAnnualizedPct ?? prev.roi;
    const avgAdv  = data?.speedBenchmark?.avgAdvantageMs ?? prev.avgAdvantage;
    sessionBestRef.current = { pnl, trades, roi, avgAdvantage: avgAdv };
    setSessionBest({ pnl, trades, roi, avgAdvantage: avgAdv });
  }, [data]);

  const wsConnected = data?.wsStatus ? Object.values(data.wsStatus).filter(Boolean).length : 0;
  const captureRate  = data?.missedSummary?.captureRate;
  const missedProfit = data?.missedSummary?.totalMissedProfit;
  // Only show missed profit sub-label when it's a meaningful negative value (> $0.01 missed)
  const missedProfitLabel = (missedProfit != null && Math.abs(missedProfit) >= 0.01)
    ? `left on table: -$${Math.abs(missedProfit).toFixed(2)}`
    : undefined;
  const { pnl, trades, roi, avgAdvantage } = sessionBest;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1100, margin: '0 auto', padding: '4px 2px' }}>
      {/* Header */}
      <div style={{ textAlign: 'center', padding: '6px 0' }}>
        <div style={{ fontSize: 26, fontWeight: 900, letterSpacing: '-0.03em', background: 'linear-gradient(135deg,#FF2D78,#5741D9)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>
          Kukora — Multi-Exchange Bitcoin Arbitrage
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
          Detection event-driven &lt;30ms · 5 exchanges · StatArb EWMA + AR(1) half-life · Persistence across restarts · 29 automated tests
        </div>
      </div>

      <SystemHealthStrip />

      {/* Architecture */}
      <div className="card" style={{ padding: '16px 20px' }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 12 }}>Arquitectura</div>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', gap: 3, flexWrap: 'wrap' }}>
          <ArchStep icon="📡" label="WebSocket Feeds" sub="5 exchanges <30ms event-driven" color="#F0B90B" />
          <Arrow />
          <ArchStep icon="🔍" label="Detection" sub="20 pairs VWAP L2 + StatArb EWMA" color="#5741D9" />
          <Arrow />
          <ArchStep icon="🧮" label="Costos Reales" sub="Fees + slippage + withdrawal" color="#0052FF" />
          <Arrow />
          <ArchStep icon="🛡️" label="Risk Engine" sub="5 circuit breakers + daily stop" color="#F59E0B" />
          <Arrow />
          <ArchStep icon="✅" label="Execution" sub="Score ≥ threshold + fingerprint" color="#00b87a" />
          <Arrow />
          <ArchStep icon="💾" label="Persistencia" sub="MongoDB — survives restarts" color="#FF2D78" />
        </div>
      </div>

      {/* Live KPIs */}
      <div className="card" style={{ padding: '14px 20px' }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 12 }}>Live Session</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <KPI label="Live Exchanges" value={`${wsConnected}/5`} color={wsConnected >= 4 ? 'var(--color-green)' : 'var(--color-yellow)'} highlight={wsConnected >= 4 ? '#00b87a' : '#F59E0B'} />
          <KPI label="Trades Executed" value={trades ?? '—'} />
          <KPI label="Session P&L" value={pnl != null && Math.abs(pnl) >= 0.001 ? `${pnl >= 0 ? '+' : ''}${fmtUSD(pnl)}` : '—'} color={pnl > 0 ? 'var(--color-green)' : pnl < 0 ? 'var(--color-red)' : 'var(--text-dim)'} highlight={pnl > 0.01 ? '#00b87a' : undefined} />
          <KPI label="Annualized ROI" value={roi != null && (trades ?? 0) > 0 ? pct(roi) : '—'} color={roi >= 0 ? 'var(--color-green)' : 'var(--color-red)'} sub="session projection" />
          <KPI label="WS Advantage" value={avgAdvantage != null ? `+${avgAdvantage}ms` : '—'} color="var(--color-green)" sub="vs polling baseline" />
          <KPI label="Capture Rate" value={captureRate != null ? `${captureRate}%` : '—'} sub={missedProfitLabel} />
        </div>
      </div>

      {/* E2E Latency Panel — v12 */}
      <E2ELatencyPanel />

      {/* Best moment of the day */}
      {bestMoment?.opportunity && (
        <div className="card" style={{ padding: '14px 18px', background: 'linear-gradient(135deg, rgba(0,184,122,0.05), rgba(0,82,255,0.04))', border: '1px solid rgba(0,184,122,0.2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ fontWeight: 800, fontSize: 12 }}>⭐ Best moment of the day</span>
            <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{new Date(bestMoment.ts).toLocaleString('es-MX')}</span>
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12 }}>
            <div><span style={{ color: 'var(--text-dim)' }}>Par: </span><b>{bestMoment.pair}</b></div>
            <div><span style={{ color: 'var(--text-dim)' }}>Neto: </span><b style={{ color: 'var(--color-green)', fontFamily: 'var(--font-mono)' }}>+{fmtUSD(bestMoment.opportunity?.netProfit, 4)}</b></div>
            <div><span style={{ color: 'var(--text-dim)' }}>Spread: </span><b style={{ fontFamily: 'var(--font-mono)' }}>{bestMoment.opportunity?.spreadPct?.toFixed(4)}%</b></div>
            <div><span style={{ color: 'var(--text-dim)' }}>Detection: </span><b style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-green)' }}>{bestMoment.detectionLatencyMs ?? 0}ms</b></div>
            <div><span style={{ color: 'var(--text-dim)' }}>Score: </span><b style={{ fontFamily: 'var(--font-mono)' }}>{bestMoment.opportunity?.score}</b></div>
            {bestMoment.executedTrade && <span style={{ color: '#0052FF', fontWeight: 800 }}>✓ Ejecutado</span>}
          </div>
        </div>
      )}

      {/* Daily Stats — v12 */}
      <DailyStatsPanel />

      {/* 3 differentiators */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <div className="card" style={{ padding: '14px 16px' }}>
          <div style={{ fontSize: 18, marginBottom: 8 }}>⚡</div>
          <div style={{ fontWeight: 800, fontSize: 12, marginBottom: 6 }}>Event-driven real, no polling</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5 }}>Native WebSockets with live latency measured per exchange. Speed Benchmark compares visually against an 800ms polling model on every tick. This isn&apos;t documentation — it&apos;s measurement.</div>
        </div>
        <div className="card" style={{ padding: '14px 16px' }}>
          <div style={{ fontSize: 18, marginBottom: 8 }}>📐</div>
          <div style={{ fontWeight: 800, fontSize: 12, marginBottom: 6 }}>Institutional quantitative StatArb</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5 }}>Z-score on stationary log-spread (not an absolute USD difference). Incremental EWMA λ=0.94. Half-life via AR(1) to qualify cointegration. The same model real pairs-trading desks use.</div>
        </div>
        <div className="card" style={{ padding: '14px 16px' }}>
          <div style={{ fontSize: 18, marginBottom: 8 }}>🔬</div>
          <div style={{ fontWeight: 800, fontSize: 12, marginBottom: 6 }}>Self-aware: knows what it&apos;s missing</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5 }}>Capture rate in real time: what % of viable opportunities were executed vs. lost to cooldown, fingerprint, or score. Persistence across restarts via MongoDB. 29 automated tests.</div>
        </div>
      </div>

      {/* CTA */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 10, paddingTop: 4, paddingBottom: 20, flexWrap:'wrap' }}>
        <button onClick={() => navigate('/arbitrage')} style={{
          background: 'linear-gradient(135deg,#FF8C42,#FF2D78)', color: '#fff', border: 'none',
          borderRadius: 10, padding: '10px 24px', fontWeight: 800, fontSize: 13, cursor: 'pointer',
          boxShadow: '0 4px 20px rgba(255,45,120,0.3)',
        }}>
          Ver el bot en vivo →
        </button>
        <button onClick={() => navigate('/arbitrage?tab=control')} style={{
          background: 'linear-gradient(135deg,rgba(0,184,122,0.15),rgba(0,153,204,0.15))',
          color: 'var(--color-green)', border: '1px solid rgba(0,184,122,0.3)',
          borderRadius: 10, padding: '10px 24px', fontWeight: 800, fontSize: 13, cursor: 'pointer',
        }}>
          ⚙️ Panel de Control
        </button>
        <button onClick={() => navigate('/arbitrage?tab=adversarial')} style={{
          background: 'rgba(240,62,62,0.08)', color: 'var(--color-red)', border: '1px solid rgba(240,62,62,0.25)',
          borderRadius: 10, padding: '10px 24px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
        }}>
          💥 Escenarios adversos
        </button>
        <button onClick={() => navigate('/arbitrage?tab=replay')} style={{
          background: 'var(--bg-surface)', color: 'var(--text)', border: '1px solid var(--border)',
          borderRadius: 10, padding: '10px 24px', fontWeight: 700, fontSize: 13, cursor: 'pointer',
        }}>
          ⏮ Replay del mejor momento
        </button>
      </div>
    </div>
  );
}
/**
 * ArbBacktestPage.jsx — Kukora
 *
 * Backtest real de la strategy de arbitraje sobre los datos de session.
 * Parameter sweep + walk-forward validation + stress scenarios.
 * Reemplaza el BacktestPage previous que usaba SMA/RSI/Bollinger sobre BTC.
 */
import { useState, useEffect, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, BarChart, Bar } from 'recharts';
import { api, ApiError } from '../api';

const fmtUSD = (n, d = 2) => n == null ? '—' : `${n >= 0 ? '+' : ''}$${Math.abs(n).toFixed(d)}`;
const pct    = n => n == null ? '—' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(1)}%`;

const EX_COLORS = { Binance: '#F0B90B', Kraken: '#5741D9', Bybit: '#F7A600', Coinbase: '#0052FF', OKX: '#aaa' };

function MetricCard({ label, value, color, sub, warning }) {
  return (
    <div style={{ flex: 1, background: 'var(--bg-surface)', border: `1px solid ${warning ? 'rgba(245,158,11,0.4)' : 'var(--border)'}`, borderRadius: 'var(--radius-lg)', padding: '12px 16px', textAlign: 'center' }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 900, fontFamily: 'var(--font-mono)', color: color || 'var(--text)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function SweepResultRow({ r, isBest, isCurrent }) {
  const v = r.validate;
  return (
    <tr style={{
      borderTop: '1px solid var(--border)',
      background: isBest ? 'rgba(0,184,122,0.05)' : isCurrent ? 'rgba(0,82,255,0.04)' : undefined,
    }}>
      <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
        {isBest && <span style={{ marginRight: 5, fontSize: 9, color: 'var(--color-green)', fontWeight: 800 }}>★</span>}
        {isCurrent && <span style={{ marginRight: 5, fontSize: 9, color: '#0052FF', fontWeight: 800 }}>●</span>}
        {r.params.minScore}
      </td>
      <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.params.cooldownMs / 1000}s</td>
      <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, color: v.totalNetProfit >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>{fmtUSD(v.totalNetProfit)}</td>
      <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{v.sharpeRatio}</td>
      <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, color: v.maxDrawdown > 2 ? 'var(--color-red)' : 'var(--text-dim)' }}>{v.maxDrawdown}%</td>
      <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{v.captureRate}%</td>
      <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{v.tradesExecuted}</td>
      <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, color: r.sharpeStability != null && r.sharpeStability < 0.5 ? 'var(--color-red)' : r.sharpeStability > 0.8 ? 'var(--color-green)' : 'var(--color-yellow)' }}>
        {r.sharpeStability != null ? r.sharpeStability : '—'}
      </td>
    </tr>
  );
}

export default function ArbBacktestPage() {
  const [summary,  setSummary]  = useState(null);
  const [sweep,    setSweep]    = useState(null);
  const [sweeping, setSweeping] = useState(false);
  const [simResult, setSimResult] = useState(null);
  const [simParams, setSimParams] = useState({ minScore: 65, cooldownMs: 3000, feeMultiplier: 1.0 });
  const [simming, setSimming] = useState(false);
  const [tab, setTab] = useState('sweep');
  const [error, setError] = useState(null);
  const [institutional, setInstitutional] = useState(null);
  const [institutionalLoading, setInstitutionalLoading] = useState(false);
  const [institutionalError, setInstitutionalError] = useState(null);

  const loadSummary = useCallback(async () => {
    try {
      const data = await api.get('/api/arbitrage/arb-backtest/summary');
      setSummary(data);
    } catch { /* keep previous — polling will retry */ }
  }, []);

  // Connects the orphaned GET /api/arbitrage/arb-backtest/institutional
  // endpoint (Sharpe/Sortino/Calmar/Kelly/VaR/Omega over the live opportunity
  // log) — it existed server-side with no frontend caller (audit roadmap #1).
  const loadInstitutional = useCallback(async () => {
    setInstitutionalLoading(true);
    setInstitutionalError(null);
    try {
      const data = await api.get('/api/arbitrage/arb-backtest/institutional');
      if (data?.metrics?.error) setInstitutionalError(data.metrics.error);
      else setInstitutional(data);
    } catch (e) { setInstitutionalError(e instanceof ApiError ? e.message : 'Connection error'); }
    finally { setInstitutionalLoading(false); }
  }, []);

  const runSweep = useCallback(async () => {
    setSweeping(true);
    setError(null);
    try {
      const data = await api.get('/api/arbitrage/arb-backtest/sweep');
      if (!data?.error) setSweep(data);
      else setError(data.error || 'Sweep failed');
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Connection error'); }
    finally { setSweeping(false); }
  }, []);

  const runSimulation = useCallback(async () => {
    setSimming(true);
    try {
      const data = await api.post('/api/arbitrage/arb-backtest/simulate', simParams);
      setSimResult(data);
    } catch { /* noop — keep previous result */ }
    finally { setSimming(false); }
  }, [simParams]);

  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => { const t = setInterval(loadSummary, 15000); return () => clearInterval(t); }, [loadSummary]);
  useEffect(() => { if (tab === 'institutional' && !institutional && !institutionalLoading) loadInstitutional(); }, [tab, institutional, institutionalLoading, loadInstitutional]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{ padding: '12px 18px', background: 'linear-gradient(135deg, rgba(87,65,217,0.08), rgba(255,45,120,0.05))', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }}>
        <div style={{ fontWeight: 900, fontSize: 16, letterSpacing: '-0.02em' }}>🔭 Arb Backtest Engine</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
          Parameter sweep + walk-forward validation sobre los datos reales de la session actual. No es SMA Crossover sobre BTC/USD — es la strategy de arbitraje real, con sus fees, slippage y cooldowns reales.
        </div>
      </div>

      {/* Session summary */}
      {summary && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <MetricCard label="Ops en el log" value={summary.totalOps} />
          <MetricCard label="Opportunities viables" value={summary.viableOps} />
          <MetricCard label="Rate de viabilidad" value={pct(summary.viableRate)} color={summary.viableRate > 5 ? 'var(--color-green)' : 'var(--text-dim)'} />
          <MetricCard label="Spread average viable" value={`${summary.avgViableSpread?.toFixed(4)}%`} />
          <MetricCard label="Score average viable" value={summary.avgViableScore} />
          {summary.bestOpportunity && <MetricCard label="Mejor opportunity" value={fmtUSD(summary.bestOpportunity.netProfit, 4)} sub={summary.bestOpportunity.pair} color="var(--color-green)" />}
        </div>
      )}

      {!summary?.totalOps && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }}>
          El opportunity log se llena mientras el bot opera. Activa el bot y espera algunos minutes para ver datos de backtest reales.
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8 }}>
        {[
          { id: 'sweep', label: '🔬 Parameter Sweep' },
          { id: 'simulate', label: '▶ Simulation Custom' },
          { id: 'pairs', label: '📊 Analysis by Pair' },
          { id: 'temporal', label: '⏰ Distribution Temporal' },
          { id: 'institutional', label: '🏛 Institutional Metrics' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
            border: tab === t.id ? '1px solid #5741D9' : '1px solid var(--border)',
            background: tab === t.id ? 'rgba(87,65,217,0.08)' : 'var(--bg-surface)',
            color: tab === t.id ? '#5741D9' : 'var(--text)',
          }}>{t.label}</button>
        ))}
      </div>

      {/* ── Tab: Sweep ──────────────────────────────────────────────────────── */}
      {tab === 'sweep' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={runSweep} disabled={sweeping || !summary?.viableOps} style={{
              background: 'linear-gradient(135deg,#5741D9,#FF2D78)', color: '#fff', border: 'none',
              borderRadius: 8, padding: '9px 20px', fontWeight: 800, fontSize: 12, cursor: sweeping ? 'not-allowed' : 'pointer', opacity: sweeping ? 0.6 : 1,
            }}>
              {sweeping ? 'Calculando sweep…' : '▶ Correr Parameter Sweep'}
            </button>
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              {35} combinations × walk-forward 70%/30% — ~100ms on a typical session dataset
            </div>
          </div>

          {error && <div style={{ color: 'var(--color-red)', fontSize: 12, padding: '8px 12px', background: 'rgba(240,62,62,0.06)', borderRadius: 8 }}>{error}</div>}

          {sweep && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Best vs current */}
              {sweep.best && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div className="card" style={{ padding: '14px 18px', border: '1px solid rgba(0,184,122,0.3)' }}>
                    <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--color-green)', textTransform: 'uppercase', marginBottom: 8 }}>★ Mejor config encontrada (out-of-sample)</div>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12 }}>
                      <span>minScore: <b style={{ fontFamily: 'var(--font-mono)' }}>{sweep.best.params.minScore}</b></span>
                      <span>cooldown: <b style={{ fontFamily: 'var(--font-mono)' }}>{sweep.best.params.cooldownMs / 1000}s</b></span>
                      <span>P&L: <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-green)' }}>{fmtUSD(sweep.best.netProfit)}</b></span>
                      <span>Sharpe: <b style={{ fontFamily: 'var(--font-mono)' }}>{sweep.best.sharpe}</b></span>
                      <span>MaxDD: <b style={{ fontFamily: 'var(--font-mono)' }}>{sweep.best.maxDrawdown}%</b></span>
                      <span>Robustez: <b style={{ fontFamily: 'var(--font-mono)', color: sweep.best.sharpeStability > 0.7 ? 'var(--color-green)' : 'var(--color-yellow)' }}>{sweep.best.sharpeStability ?? '—'}</b></span>
                    </div>
                  </div>
                  <div className="card" style={{ padding: '14px 18px', border: '1px solid rgba(0,82,255,0.2)' }}>
                    <div style={{ fontSize: 10, fontWeight: 800, color: '#0052FF', textTransform: 'uppercase', marginBottom: 8 }}>● Config actual en production (minScore=65, cooldown=3s)</div>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12 }}>
                      <span>P&L: <b style={{ fontFamily: 'var(--font-mono)', color: sweep.currentConfig.totalNetProfit >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>{fmtUSD(sweep.currentConfig.totalNetProfit)}</b></span>
                      <span>Sharpe: <b style={{ fontFamily: 'var(--font-mono)' }}>{sweep.currentConfig.sharpeRatio}</b></span>
                      <span>Capture: <b style={{ fontFamily: 'var(--font-mono)' }}>{sweep.currentConfig.captureRate}%</b></span>
                      <span>Trades: <b style={{ fontFamily: 'var(--font-mono)' }}>{sweep.currentConfig.tradesExecuted}</b></span>
                    </div>
                  </div>
                </div>
              )}

              {/* Stress scenarios */}
              {sweep.stressScenarios?.length > 0 && (
                <div className="card" style={{ padding: '14px 18px' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                    Stress scenarios (on best config, across all data)
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {sweep.stressScenarios.map(s => (
                      <div key={s.feeMultiplier} style={{ flex: 1, textAlign: 'center', padding: '10px', background: 'var(--bg-surface-2)', borderRadius: 8 }}>
                        <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 700, marginBottom: 4 }}>{s.label}</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 900, fontSize: 16, color: s.result.totalNetProfit >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>{fmtUSD(s.result.totalNetProfit)}</div>
                        <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 2 }}>{s.result.tradesExecuted} trades · Sharpe {s.result.sharpeRatio}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Sweep table */}
              <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
                <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' }}>
                  Top {sweep.topResults?.length} combinaciones (out-of-sample, 30% de la session)
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-surface-2)' }}>
                      {['minScore', 'Cooldown', 'P&L (val)', 'Sharpe', 'MaxDD', 'Capture', 'Trades', 'Robustez'].map(h => (
                        <th key={h} style={{ padding: '7px 12px', textAlign: 'left', fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(sweep.topResults || []).map((r, i) => (
                      <SweepResultRow key={i} r={r} isBest={i === 0} isCurrent={r.params.minScore === 65 && r.params.cooldownMs === 3000} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Custom simulation ──────────────────────────────────────────── */}
      {tab === 'simulate' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card" style={{ padding: '14px 18px', display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            {[
              { key: 'minScore', label: 'Min Score', min: 40, max: 90, step: 5 },
              { key: 'cooldownMs', label: 'Cooldown (ms)', min: 500, max: 10000, step: 500 },
              { key: 'feeMultiplier', label: 'Fee Multiplier', min: 0.5, max: 3, step: 0.5 },
            ].map(({ key, label, min, max, step }) => (
              <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' }}>{label}: <b style={{ color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{simParams[key]}</b></label>
                <input type="range" min={min} max={max} step={step} value={simParams[key]} onChange={e => setSimParams(p => ({ ...p, [key]: key === 'feeMultiplier' ? parseFloat(e.target.value) : parseInt(e.target.value) }))} style={{ width: 160 }} />
              </div>
            ))}
            <button onClick={runSimulation} disabled={simming} style={{
              background: '#5741D9', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontWeight: 800, fontSize: 12, cursor: 'pointer', opacity: simming ? 0.6 : 1,
            }}>
              {simming ? 'Simulando…' : '▶ Simulate'}
            </button>
          </div>

          {simResult && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {[
                  { label: 'P&L Total', value: fmtUSD(simResult.totalNetProfit), color: simResult.totalNetProfit >= 0 ? 'var(--color-green)' : 'var(--color-red)' },
                  { label: 'Trades', value: simResult.tradesExecuted },
                  { label: 'Sharpe', value: simResult.sharpeRatio },
                  { label: 'Max DD', value: `${simResult.maxDrawdown}%`, color: simResult.maxDrawdown > 3 ? 'var(--color-red)' : 'var(--text)' },
                  { label: 'Capture', value: `${simResult.captureRate}%` },
                  { label: 'Win Rate', value: `${simResult.winRate}%` },
                  { label: 'Profit Factor', value: simResult.profitFactor === 999 ? '∞' : simResult.profitFactor },
                ].map(k => <MetricCard key={k.label} label={k.label} value={k.value} color={k.color} />)}
              </div>

              {simResult.equityCurve?.length > 1 && (
                <div className="card" style={{ padding: '14px 18px' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', marginBottom: 8, textTransform: 'uppercase' }}>Equity Curve (simulada)</div>
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={simResult.equityCurve} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="ts" tickFormatter={ts => new Date(ts).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} tick={{ fontSize: 8, fill: 'var(--text-dim)' }} />
                      <YAxis tick={{ fontSize: 9, fill: 'var(--text-dim)' }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} width={42} />
                      <Tooltip contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', fontSize: 11 }} formatter={(v) => [`$${v.toLocaleString()}`, 'Equity']} />
                      <Line type="monotone" dataKey="equity" stroke="var(--color-green)" strokeWidth={2} dot={false} isAnimationActive={false} />
                      <ReferenceLine y={100000} stroke="var(--border)" strokeDasharray="4 4" label={{ value: 'Capital inicial', fontSize: 8 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Pair analysis ──────────────────────────────────────────────── */}
      {tab === 'pairs' && (
        <div className="card" style={{ padding: 0 }}>
          {!summary?.pairAnalysis?.length ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>No data yet. The engine needs to run to accumulate pair statistics.</div>
          ) : (
            <>
              <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' }}>
                Performance por par (datos reales de session)
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ background: 'var(--bg-surface-2)' }}>
                    {['Par', 'Vistas', 'Viables', '% Viable', 'Avg Profit', 'Mejor', 'Total Profit', 'Slippage Model'].map(h => (
                      <th key={h} style={{ padding: '7px 12px', textAlign: 'left', fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {summary.pairAnalysis.map(p => {
                    const [buy, sell] = p.pair.split('→');
                    return (
                      <tr key={p.pair} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '7px 12px', fontWeight: 700, fontSize: 12 }}>
                          <span style={{ color: EX_COLORS[buy] }}>{buy}</span>
                          <span style={{ color: 'var(--text-dim)' }}>→</span>
                          <span style={{ color: EX_COLORS[sell] }}>{sell}</span>
                        </td>
                        <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)' }}>{p.seen}</td>
                        <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)' }}>{p.viable}</td>
                        <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', color: p.viableRate > 10 ? 'var(--color-green)' : 'var(--text-dim)' }}>{p.viableRate}%</td>
                        <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', color: (p.avgNetProfit || 0) >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>{p.avgNetProfit != null ? fmtUSD(p.avgNetProfit, 4) : '—'}</td>
                        <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', color: 'var(--color-green)' }}>{p.bestNetProfit != null ? fmtUSD(p.bestNetProfit, 4) : '—'}</td>
                        <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', fontWeight: 700, color: p.totalProfit >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>{fmtUSD(p.totalProfit)}</td>
                        <td style={{ padding: '7px 12px', fontSize: 10, color: 'var(--text-dim)' }}>{p.dominantSlipMethod || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {/* ── Tab: Temporal distribution ─────────────────────────────────────── */}
      {tab === 'temporal' && (
        <div className="card" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 12 }}>
            Opportunities viables por ventana de 5 minutes
          </div>
          {!summary?.temporalBuckets?.length ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>No data yet.</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={summary.temporalBuckets} margin={{ top: 4, right: 8, left: 0, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="time" tick={{ fontSize: 9, fill: 'var(--text-dim)' }} angle={-45} textAnchor="end" />
                <YAxis tick={{ fontSize: 9, fill: 'var(--text-dim)' }} />
                <Tooltip contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', fontSize: 11 }} />
                <Bar dataKey="count" fill="var(--color-green)" opacity={0.7} name="Opportunities viables" />
              </BarChart>
            </ResponsiveContainer>
          )}
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 8 }}>
            Identifies which time windows of the day generate more arbitrage opportunities — useful for deciding when the engine should be most active.
          </div>
        </div>
      )}

      {/* ── Tab: Institutional metrics ────────────────────────────────────── */}
      {tab === 'institutional' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={loadInstitutional} disabled={institutionalLoading} style={{
              background: 'linear-gradient(135deg,#5741D9,#FF2D78)', color: '#fff', border: 'none',
              borderRadius: 8, padding: '9px 20px', fontWeight: 800, fontSize: 12, cursor: institutionalLoading ? 'not-allowed' : 'pointer', opacity: institutionalLoading ? 0.6 : 1,
            }}>
              {institutionalLoading ? 'Recalculando…' : '↻ Recalcular'}
            </button>
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              Sharpe / Sortino / Calmar / Omega / VaR 95% / Kelly Criterion sobre la config activa (minScore/cooldown de liveConfig).
            </div>
          </div>

          {institutionalError && <div style={{ color: 'var(--color-red)', fontSize: 12, padding: '8px 12px', background: 'rgba(240,62,62,0.06)', borderRadius: 8 }}>{institutionalError}</div>}

          {!institutional && !institutionalLoading && !institutionalError && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }}>
              Sin datos todavía — hacé click en &quot;Recalcular&quot; o esperá a que el opportunity log tenga actividad.
            </div>
          )}

          {institutional?.metrics && !institutional.metrics.error && (
            <>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <MetricCard label="Grade" value={institutional.metrics.grade} color={
                  institutional.metrics.grade?.startsWith('A') ? 'var(--color-green)' :
                  institutional.metrics.grade?.startsWith('B') ? 'var(--color-yellow)' : 'var(--color-red)'
                } />
                <MetricCard label="Sharpe" value={institutional.metrics.sharpeRatio} />
                <MetricCard label="Sortino" value={institutional.metrics.sortinoRatio} />
                <MetricCard label="Calmar" value={institutional.metrics.calmarRatio} />
                <MetricCard label="Omega" value={institutional.metrics.omegaRatio} />
                <MetricCard label="Total Return" value={pct(institutional.metrics.totalReturn)} color={institutional.metrics.totalReturn >= 0 ? 'var(--color-green)' : 'var(--color-red)'} />
                <MetricCard label="Annualized" value={pct(institutional.metrics.annualizedReturn)} />
              </div>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <MetricCard label="Max Drawdown" value={`${institutional.metrics.maxDrawdownPct ?? '—'}%`} warning={institutional.metrics.maxDrawdownPct > 5} />
                <MetricCard label="Recovery Factor" value={institutional.metrics.recoveryFactor} />
                <MetricCard label="Time in DD" value={`${institutional.metrics.timeInDrawdownPct ?? '—'}%`} />
                <MetricCard label="Win Rate" value={`${institutional.metrics.winRate ?? '—'}%`} />
                <MetricCard label="Profit Factor" value={institutional.metrics.profitFactor === 999 ? '∞' : institutional.metrics.profitFactor} />
                <MetricCard label="Expectancy" value={fmtUSD(institutional.metrics.expectancy, 4)} />
                <MetricCard label="VaR 95%" value={fmtUSD(institutional.metrics.valueAtRisk95)} color="var(--color-red)" />
              </div>

              {institutional.metrics.kellyCriterion && (
                <div className="card" style={{ padding: '14px 18px' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 10 }}>Kelly Criterion — sizing óptimo</div>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12 }}>
                    <span>Full Kelly: <b style={{ fontFamily: 'var(--font-mono)' }}>{institutional.metrics.kellyCriterion.fullKelly}%</b></span>
                    <span>Half Kelly (recomendado): <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-green)' }}>{institutional.metrics.kellyCriterion.halfKelly}%</b></span>
                    {institutional.report?.riskManagement?.impliedLeverage && (
                      <span>Leverage implícito: <b style={{ fontFamily: 'var(--font-mono)' }}>{institutional.report.riskManagement.impliedLeverage}</b></span>
                    )}
                  </div>
                </div>
              )}

              {institutional.report?.disclaimer && (
                <div style={{ fontSize: 10, color: 'var(--text-dim)', fontStyle: 'italic' }}>{institutional.report.disclaimer}</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

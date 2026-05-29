import { useState, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { api } from '../api';

const COINS = [
  { id: 'bitcoin', label: 'BTC – Bitcoin' },
  { id: 'ethereum', label: 'ETH – Ethereum' },
  { id: 'solana', label: 'SOL – Solana' },
  { id: 'binancecoin', label: 'BNB – BNB' },
  { id: 'ripple', label: 'XRP – Ripple' },
  { id: 'cardano', label: 'ADA – Cardano' },
  { id: 'dogecoin', label: 'DOGE – Dogecoin' },
];

const STRATEGIES = [
  { id: 'sma_crossover',      label: 'SMA Crossover',      desc: 'Compra SMA10 cruza SMA30 ↑, vende al cruzar ↓' },
  { id: 'rsi_reversion',      label: 'RSI Mean Reversion', desc: 'Compra RSI < 30, vende RSI > 70' },
  { id: 'bollinger_breakout', label: 'Bollinger Breakout',  desc: 'Compra al romper banda superior, vende en media' },
];

const fmt = (n) => n == null ? '—' : n >= 1 ? `$${n.toLocaleString('en', { maximumFractionDigits: 2 })}` : `$${n?.toFixed(5)}`;
const fmtPct = (n) => n == null ? '—' : `${n >= 0 ? '+' : ''}${Number(n)?.toFixed(2)}%`;

function MetricBadge({ label, value, accent }) {
  return (
    <div style={{ background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)', padding: '12px 16px', border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: accent || 'var(--text)' }}>{value}</div>
    </div>
  );
}

function StrategyCard({ result, isActive, onClick }) {
  if (!result) return null;
  const retColor = result.totalReturn >= 0 ? 'var(--color-green)' : 'var(--color-red)';
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--bg-surface)',
        borderRadius: 'var(--radius)',
        padding: '14px 16px',
        border: `1.5px solid ${isActive ? 'var(--color-primary)' : 'var(--border)'}`,
        cursor: 'pointer',
        boxShadow: isActive ? '0 0 0 3px var(--color-primary-glow)' : 'none',
        transition: 'all 0.15s',
      }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>{result.strategy}</div>
      <div style={{ fontSize: 22, fontWeight: 900, color: retColor, marginBottom: 4 }}>{fmtPct(result.totalReturn)}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        Win rate: <b style={{ color: 'var(--text)' }}>{result.winRate != null ? `${result.winRate}%` : '—'}</b> ·{' '}
        Trades: <b style={{ color: 'var(--text)' }}>{result.totalTrades}</b>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
        MaxDD: <b style={{ color: 'var(--color-red)' }}>{fmtPct(-result.maxDrawdown)}</b>
      </div>
    </div>
  );
}


const exportCSV = (data, filename) => {
  if (!data?.length) return;
  const csv = Object.keys(data[0]).join(',') + '\n' + data.map(r => Object.values(r).join(',')).join('\n');
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], {type:'text/csv'})), download: filename });
  a.click();
};

const exportJSON = (data, filename) => {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(data,null,2)], {type:'application/json'})), download: filename });
  a.click();
};

export default function BacktestPage() {
  const [coin, setCoin] = useState('bitcoin');
  const [strategy, setStrategy] = useState('sma_crossover');
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [allData, setAllData] = useState(null);
  const [error, setError] = useState(null);
  const [activeStrategy, setActiveStrategy] = useState(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [single, all] = await Promise.all([
        api.get(`/api/crypto/coin/${coin}/backtest?days=${days}&strategy=${strategy}`),
        api.get(`/api/crypto/coin/${coin}/backtest?days=${days}&all=true`),
      ]);
      setData(single);
      setAllData(all);
      setActiveStrategy(strategy);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [coin, strategy, days]);

  const cardStyle = { background: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)', padding: '20px 24px', border: '1px solid var(--border)', boxShadow: 'var(--shadow-card)', marginBottom: 20 };
  const selectStyle = { padding: '8px 12px', borderRadius: 'var(--radius)', border: '1px solid var(--border-bright)', background: 'var(--bg-surface)', fontSize: 13, color: 'var(--text)', cursor: 'pointer' };
  const labelStyle = { fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6, display: 'block' };

  // Build equity chart data
  const equityData = data ? data.strategy.equity.map((v, i) => ({
    i,
    strategy: +v.toFixed(2),
    benchmark: data.benchmark?.equity[i] != null ? +data.benchmark.equity[i].toFixed(2) : null,
  })) : [];

  // Entry/exit markers
  const trades = data?.strategy?.trades || [];

  const displayedResult = allData && activeStrategy ? allData[activeStrategy] : data?.strategy;

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 22, fontWeight: 900, letterSpacing: '-0.5px', marginBottom: 4 }}>
          <span style={{ background: 'var(--brand-gradient)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Backtesting</span> Engine
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Simulación de estrategias sobre datos históricos reales</p>
      </div>

      {/* Controls */}
      <div style={{ ...cardStyle, display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
        <div>
          <span style={labelStyle}>Activo</span>
          <select style={selectStyle} value={coin} onChange={e => setCoin(e.target.value)}>
            {COINS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <span style={labelStyle}>Estrategia</span>
          <select style={selectStyle} value={strategy} onChange={e => setStrategy(e.target.value)}>
            {STRATEGIES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <span style={labelStyle}>Período</span>
          <select style={selectStyle} value={days} onChange={e => setDays(Number(e.target.value))}>
            {[60, 90, 180, 365].map(d => <option key={d} value={d}>{d} días</option>)}
          </select>
        </div>
        <button className="btn btn-primary" onClick={run} disabled={loading} style={{ height: 38 }}>
          {loading ? '⟳ Ejecutando...' : '▶ Ejecutar backtest'}
        </button>
      </div>

      {/* Strategy description */}
      <div style={{ marginBottom: 16 }}>
        {STRATEGIES.filter(s => s.id === strategy).map(s => (
          <div key={s.id} style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 14px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', display: 'inline-block' }}>
            📋 {s.desc}
          </div>
        ))}
      </div>

      {error && (
        <div style={{ ...cardStyle, background: 'var(--color-red-dim)', border: '1px solid var(--color-red)', color: 'var(--color-red)', fontSize: 13 }}>
          ⚠ {error}
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <div className="spinner" style={{ margin: '0 auto 12px' }} />
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Simulando {days} días de trading…</div>
        </div>
      )}

      {data && !loading && (
        <>
          {/* Strategy comparison cards */}
          {allData && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Comparativa de Estrategias</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                {STRATEGIES.map(s => (
                  <StrategyCard
                    key={s.id}
                    result={allData[s.id]}
                    isActive={activeStrategy === s.id}
                    onClick={() => setActiveStrategy(s.id)}
                  />
                ))}
                <StrategyCard result={allData.buy_and_hold} isActive={activeStrategy === 'buy_and_hold'} onClick={() => setActiveStrategy('buy_and_hold')} />
              </div>
            </div>
          )}

          {/* KPI metrics */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14, marginBottom: 20 }}>
            <MetricBadge label="Retorno Total" value={fmtPct(data.strategy.totalReturn)} accent={data.strategy.totalReturn >= 0 ? 'var(--color-green)' : 'var(--color-red)'} />
            <MetricBadge label="Buy & Hold" value={fmtPct(data.benchmark?.totalReturn)} accent={data.benchmark?.totalReturn >= 0 ? 'var(--color-green)' : 'var(--color-red)'} />
            <MetricBadge label="Win Rate" value={data.strategy.winRate != null ? `${data.strategy.winRate}%` : '—'} accent="var(--color-blue)" />
            <MetricBadge label="Total Trades" value={data.strategy.totalTrades} />
            <MetricBadge label="Max Drawdown" value={fmtPct(-data.strategy.maxDrawdown)} accent="var(--color-red)" />
            <MetricBadge label="Sharpe Ratio" value={data.strategy.sharpeRatio?.toFixed(3) || '—'} accent="var(--color-purple)" />
            <div style={{display:'flex',gap:6,gridColumn:'span 2'}}>
              <button className="btn btn-ghost btn-sm" onClick={()=>exportCSV(equityData,'kukora_equity.csv')}>↓ Equity CSV</button>
              <button className="btn btn-ghost btn-sm" onClick={()=>exportJSON(data,'kukora_backtest.json')}>↓ Resultados JSON</button>
            </div>
          </div>

          {/* Equity Curve */}
          <div style={cardStyle}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>Equity Curve — Capital $10,000 inicial</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
              <span style={{ color: 'var(--color-primary)' }}>■</span> {data.strategy.strategy} ·{' '}
              <span style={{ color: 'var(--color-blue)' }}>■</span> Buy & Hold (benchmark)
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={equityData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="i" tick={{ fontSize: 10, fill: 'var(--text-dim)' }} label={{ value: 'Días', position: 'insideRight', offset: -4, fontSize: 10 }} />
                <YAxis tickFormatter={v => `$${(v/1000).toFixed(1)}k`} tick={{ fontSize: 10, fill: 'var(--text-dim)' }} width={58} />
                <Tooltip
                  contentStyle={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }}
                  formatter={(v, name) => [`$${v.toLocaleString('en', { maximumFractionDigits: 0 })}`, name === 'strategy' ? data.strategy.strategy : 'Buy & Hold']}
                />
                <ReferenceLine y={10000} stroke="var(--border-bright)" strokeDasharray="4 2" />
                <Line dataKey="benchmark" dot={false} stroke="var(--color-blue)" strokeWidth={1.5} strokeDasharray="5 3" isAnimationActive={false} />
                <Line dataKey="strategy"  dot={false} stroke="var(--color-primary)" strokeWidth={2.5} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Trades table */}
          {trades.length > 0 && (
            <div style={cardStyle}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 16 }}>
                Trades Individuales ({trades.length})
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid var(--border-bright)' }}>
                      {['#', 'Entrada', 'Salida', 'P&L %', 'Duración', 'Estado'].map(h => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg-surface-2)' }}>
                        <td style={{ padding: '8px 12px', color: 'var(--text-dim)', fontWeight: 600 }}>{i + 1}</td>
                        <td style={{ padding: '8px 12px', fontWeight: 600 }}>{fmt(t.entry)}</td>
                        <td style={{ padding: '8px 12px', fontWeight: 600 }}>{fmt(t.exit)}</td>
                        <td style={{ padding: '8px 12px', fontWeight: 700, color: t.pnlPct >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>
                          {fmtPct(t.pnlPct)}
                        </td>
                        <td style={{ padding: '8px 12px', color: 'var(--text-muted)' }}>{t.duration}d</td>
                        <td style={{ padding: '8px 12px' }}>
                          {t.open
                            ? <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-yellow)', background: 'var(--color-yellow-dim)', padding: '2px 8px', borderRadius: 99 }}>ABIERTO</span>
                            : <span style={{ fontSize: 10, fontWeight: 700, color: t.pnlPct >= 0 ? 'var(--color-green)' : 'var(--color-red)', background: t.pnlPct >= 0 ? 'var(--color-green-dim)' : 'var(--color-red-dim)', padding: '2px 8px', borderRadius: 99 }}>
                                {t.pnlPct >= 0 ? 'WIN' : 'LOSS'}
                              </span>
                          }
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {!data && !loading && !error && (
        <div style={{ ...cardStyle, textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>◎</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Selecciona un activo y estrategia para iniciar</div>
          <div style={{ fontSize: 12, marginTop: 8 }}>Simulación sobre datos históricos reales de CoinGecko</div>
        </div>
      )}
    </div>
  );
}

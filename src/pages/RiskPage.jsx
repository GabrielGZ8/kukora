import { useState } from 'react';
import { usePolling } from '../hooks/usePolling';
import { api } from '../api';
import { ErrorState, EmptyState } from '../components/common/StateViews';
import { RadarChart, Radar, PolarGrid, PolarAngleAxis, ResponsiveContainer, Tooltip } from 'recharts';

const COINS = [
  { id: 'bitcoin',     label: 'BTC', color: '#F7931A' },
  { id: 'ethereum',    label: 'ETH', color: '#627EEA' },
  { id: 'solana',      label: 'SOL', color: '#9945FF' },
  { id: 'binancecoin', label: 'BNB', color: '#F0B90B' },
  { id: 'ripple',      label: 'XRP', color: '#346AA9' },
  { id: 'cardano',     label: 'ADA', color: '#0033AD' },
];
const PERIODS = [{ label: '7d', days: 7 }, { label: '30d', days: 30 }, { label: '90d', days: 90 }];
const GRADE_CFG = {
  A: { color: 'var(--color-green)',  bg: 'var(--color-green-dim)',  label: 'Riesgo Bajo' },
  B: { color: 'var(--color-blue)',   bg: 'var(--color-blue-dim)',   label: 'Riesgo Moderado' },
  C: { color: 'var(--color-yellow)', bg: 'var(--color-yellow-dim)', label: 'Riesgo Alto' },
  D: { color: 'var(--color-red)',    bg: 'var(--color-red-dim)',    label: 'Riesgo Muy Alto' },
};
const REGIME_CFG = {
  trending_up:   { icon: '▲', color: 'var(--color-green)' },
  trending_down: { icon: '▼', color: 'var(--color-red)' },
  ranging:       { icon: '↔', color: 'var(--color-yellow)' },
  volatile:      { icon: '🌪', color: 'var(--color-red)' },
};

function CorrCell({ value }) {
  const abs = Math.abs(value);
  const bg  = value === 1 ? 'var(--bg-surface-3)'
    : abs >= 0.7 ? value > 0 ? 'rgba(0,184,122,0.18)' : 'rgba(240,62,62,0.18)'
    : abs >= 0.4 ? value > 0 ? 'rgba(0,184,122,0.09)' : 'rgba(240,62,62,0.09)'
    : 'transparent';
  const color = value === 1 ? 'var(--text-dim)'
    : abs >= 0.5 ? value > 0 ? 'var(--color-green)' : 'var(--color-red)'
    : 'var(--text-muted)';
  return (
    <td style={{ padding: '10px 14px', textAlign: 'center', background: bg, color, fontWeight: abs >= 0.5 ? 700 : 400, fontSize: 12, border: '1px solid var(--border)', transition: 'background 0.2s' }}>
      {value === 1 ? '—' : value?.toFixed(3)}
    </td>
  );
}

function RiskGauge({ score, grade }) {
  const cfg  = GRADE_CFG[grade] || GRADE_CFG.C;
  const pct  = score / 100;
  const r    = 54, cx = 70, cy = 70;
  const circ = Math.PI * r; // half circle
  const dash = circ * pct;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <svg width={140} height={80} viewBox="0 0 140 80">
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke="var(--bg-surface-3)" strokeWidth={14} strokeLinecap="round" />
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke={cfg.color} strokeWidth={14} strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`} style={{ transition: 'stroke-dasharray 0.8s ease' }} />
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize={22} fontWeight={900} fill={cfg.color}>{score}</text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontSize={10} fill="var(--text-muted)">/ 100</text>
      </svg>
      <span style={{ fontSize: 11, fontWeight: 800, color: cfg.color, background: cfg.bg, padding: '3px 10px', borderRadius: 99, marginTop: -4 }}>
        Grade {grade} · {cfg.label}
      </span>
    </div>
  );
}

export default function RiskPage() {
  const [coin, setCoin]         = useState(COINS[0]);
  const [period, setPeriod]     = useState(PERIODS[1]);
  const [showReport, setShowReport] = useState(false);
  const corrCoins = COINS.map(c => c.id).join(',');

  const { data: risk, loading: rL } = usePolling(
    () => api.get(`/api/crypto/coin/${coin.id}/risk?days=${period.days}`),
    120_000, [coin.id, period.days]
  );

  const { data: corr, loading: cL } = usePolling(
    () => api.get(`/api/crypto/correlation?coins=${corrCoins}&days=${period.days}`),
    180_000, [period.days]
  );

  const radarData = risk?.risk?.components ? Object.entries(risk.risk.components).map(([k, v]) => ({
    metric: k === 'volatility' ? 'Volatilidad' : k === 'drawdown' ? 'Drawdown' : k === 'var95' ? 'VaR 95%' : 'Sesgo',
    value: v,
  })) : [];

  const regime = risk?.regime;
  const regimeCfg = REGIME_CFG[regime?.regime] || { icon: '?', color: 'var(--text-muted)' };
  const sr = risk?.supportResistance;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>◉ Risk Engine</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Análisis de riesgo cuantitativo · VaR · Sharpe · Sortino · Correlación</p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {PERIODS.map(p => (
            <button key={p.label} className={`btn btn-sm ${period.days === p.days ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setPeriod(p)}>{p.label}</button>
          ))}
          {risk && (
            <button className="btn btn-sm btn-secondary" onClick={() => setShowReport(true)} style={{ marginLeft: 6 }}>
              📄 Reporte
            </button>
          )}
        </div>
      </div>

      {/* Coin selector */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {COINS.map(c => (
          <button key={c.id} onClick={() => setCoin(c)}
            className={`btn ${coin.id === c.id ? 'btn-primary' : 'btn-secondary'}`}
            style={coin.id === c.id ? {} : { borderLeft: `3px solid ${c.color}` }}>
            {c.label}
          </button>
        ))}
      </div>

      {rL ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><div className="spinner" /></div>
      ) : risk ? (
        <>
          {/* Top row: gauge + regime + raw metrics */}
          <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr 1fr', gap: 16, marginBottom: 20 }}>
            {/* Risk Score Gauge */}
            <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Risk Score</div>
              <RiskGauge score={risk.risk.score} grade={risk.risk.grade} />
            </div>

            {/* Regime */}
            <div className="card">
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>Régimen de Mercado</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                <span style={{ fontSize: 32 }}>{regimeCfg.icon}</span>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: regimeCfg.color }}>{regime?.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Período {period.label}</div>
                </div>
              </div>
              {[
                { label: 'Volatilidad diaria', value: `${((regime?.vol || 0) * 100).toFixed(2)}%` },
                { label: 'Fuerza tendencia',   value: `${regime?.trend > 0 ? '+' : ''}${regime?.trend || 0}%` },
                { label: 'Drawdown período',   value: `${regime?.drawdown || 0}%` },
              ].map(r => (
                <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-muted)' }}>{r.label}</span>
                  <span style={{ fontWeight: 700 }}>{r.value}</span>
                </div>
              ))}
            </div>

            {/* Raw risk metrics */}
            <div className="card">
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>Métricas de Riesgo</div>
              {[
                { label: 'Sharpe Ratio',   value: risk.risk.raw?.sharpe,  good: v => v > 1,    fmt: v => v?.toFixed(4) },
                { label: 'Sortino Ratio',  value: risk.risk.raw?.sortino, good: v => v > 1,    fmt: v => v?.toFixed(4) },
                { label: 'Calmar Ratio',   value: risk.risk.raw?.calmar,  good: v => v > 0.5,  fmt: v => v?.toFixed(4) },
                { label: 'VaR 95% (1d)',   value: risk.risk.raw?.var95,   good: () => false,   fmt: v => `${v?.toFixed(2)}%` },
                { label: 'Volatilidad',    value: risk.risk.raw?.vol,     good: () => false,   fmt: v => `${(v*100)?.toFixed(2)}%` },
                { label: 'Skewness',       value: risk.risk.raw?.skew,    good: v => v > 0,    fmt: v => v?.toFixed(4) },
              ].map(r => (
                <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-muted)' }}>{r.label}</span>
                  <span style={{ fontWeight: 700, color: r.value != null ? (r.good(r.value) ? 'var(--color-green)' : 'var(--color-red)') : 'var(--text-dim)' }}>
                    {r.value != null ? r.fmt(r.value) : '—'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Radar + Support/Resistance */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
            {/* Radar */}
            <div className="card">
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 16 }}>Perfil de Riesgo (Radar)</div>
              <ResponsiveContainer width="100%" height={220}>
                <RadarChart data={radarData}>
                  <PolarGrid stroke="var(--border)" />
                  <PolarAngleAxis dataKey="metric" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
                  <Radar name="Riesgo" dataKey="value" stroke={coin.color} fill={coin.color} fillOpacity={0.18} strokeWidth={2} />
                  <Tooltip formatter={(v) => [`${v}`, 'Score de riesgo']} />
                </RadarChart>
              </ResponsiveContainer>
            </div>

            {/* Support & Resistance */}
            <div className="card">
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 16 }}>Soporte & Resistencia</div>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-red)', marginBottom: 8 }}>Resistencias</div>
                {(sr?.resistances || []).slice(-3).reverse().map((r, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 10px', background: 'var(--color-red-dim)', borderRadius: 'var(--radius-sm)', marginBottom: 6, border: '1px solid rgba(240,62,62,0.2)' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>R{i + 1}</span>
                    <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--color-red)' }}>${r.toLocaleString('en', { maximumFractionDigits: 2 })}</span>
                  </div>
                ))}
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-green)', marginBottom: 8 }}>Soportes</div>
                {(sr?.supports || []).slice(-3).map((s, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 10px', background: 'var(--color-green-dim)', borderRadius: 'var(--radius-sm)', marginBottom: 6, border: '1px solid rgba(0,184,122,0.2)' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>S{i + 1}</span>
                    <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--color-green)' }}>${s.toLocaleString('en', { maximumFractionDigits: 2 })}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {/* Correlation Matrix */}
      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 20 }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800 }}>Matriz de Correlación</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Correlación de Pearson entre retornos · {period.label} · verde=positiva, rojo=negativa</div>
          </div>
          {cL && <div className="spinner" />}
        </div>
        {corr?.matrix && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr style={{ background: 'var(--bg-surface-2)' }}>
                  <th style={{ padding: '10px 14px', fontSize: 11, color: 'var(--text-muted)', textAlign: 'left', border: '1px solid var(--border)' }}>Asset</th>
                  {corr.ids.map(id => (
                    <th key={id} style={{ padding: '10px 14px', fontSize: 11, fontWeight: 700, color: 'var(--text)', textAlign: 'center', border: '1px solid var(--border)' }}>
                      {COINS.find(c => c.id === id)?.label || id}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {corr.ids.map(rowId => (
                  <tr key={rowId}>
                    <td style={{ padding: '10px 14px', fontWeight: 700, fontSize: 12, border: '1px solid var(--border)', background: 'var(--bg-surface-2)' }}>
                      {COINS.find(c => c.id === rowId)?.label || rowId}
                    </td>
                    {corr.ids.map(colId => (
                      <CorrCell key={colId} value={corr.matrix[rowId][colId]} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Report Modal */}
      {showReport && risk && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.35)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
          onClick={e => { if(e.target===e.currentTarget) setShowReport(false); }}>
          <div style={{ background:'var(--bg-elevated)', borderRadius:'var(--radius-xl)', padding:'28px 32px', maxWidth:560, width:'100%', boxShadow:'var(--shadow-lg)', maxHeight:'85vh', overflowY:'auto' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <div style={{ fontSize:15, fontWeight:800 }}>📄 Reporte de Riesgo — {coin.label}</div>
              <button onClick={() => setShowReport(false)} style={{ background:'none', border:'none', fontSize:18, cursor:'pointer', color:'var(--text-muted)' }}>✕</button>
            </div>
            <pre style={{ fontFamily:'monospace', fontSize:12, lineHeight:1.8, whiteSpace:'pre-wrap', color:'var(--text)', background:'var(--bg-surface-2)', padding:16, borderRadius:'var(--radius)' }}>
{`KUKORA RISK REPORT
═══════════════════════════════════
Activo:    ${coin.label}
Período:   ${period.label}
Fecha:     ${new Date().toLocaleDateString('es-MX')}

SCORE DE RIESGO
───────────────────────────────────
Score:     ${risk.risk?.score} / 100
Grade:     ${risk.risk?.grade} (${GRADE_CFG[risk.risk?.grade]?.label || '—'})

Componentes:
  Volatilidad:    ${risk.risk?.components?.volatility?.toFixed(1) || '—'}
  Drawdown:       ${risk.risk?.components?.drawdown?.toFixed(1) || '—'}
  VaR 95%:        ${risk.risk?.components?.var95?.toFixed(1) || '—'}
  Sesgo:          ${risk.risk?.components?.skewPenalty?.toFixed(1) || '—'}

RÉGIMEN DE MERCADO
───────────────────────────────────
Régimen:          ${risk.regime?.label || '—'}
Volatilidad:      ${((risk.regime?.vol || 0)*100).toFixed(2)}%
Tendencia:        ${risk.regime?.trend > 0 ? '+' : ''}${risk.regime?.trend || 0}%
Drawdown período: ${risk.regime?.drawdown || 0}%

SOPORTE & RESISTENCIA
───────────────────────────────────
Resistencias: ${(risk.supportResistance?.resistances || []).slice(-3).reverse().map(r => '$'+r.toLocaleString('en',{maximumFractionDigits:2})).join(', ') || '—'}
Soportes:     ${(risk.supportResistance?.supports || []).slice(-3).map(s => '$'+s.toLocaleString('en',{maximumFractionDigits:2})).join(', ') || '—'}

CONCLUSIÓN
───────────────────────────────────
${risk.risk?.grade === 'A' ? 'Riesgo BAJO. Volatilidad controlada. Adecuado para estrategias de largo plazo.' :
  risk.risk?.grade === 'B' ? 'Riesgo MODERADO. Requiere gestión activa y stops definidos.' :
  risk.risk?.grade === 'C' ? 'Riesgo ALTO. Solo para alta tolerancia al riesgo, horizonte corto.' :
  'Riesgo MUY ALTO. Máxima precaución, posición reducida.'}

─────────────────────────────────
Generado por kukora · Quantitative Crypto`}
            </pre>
            <div style={{ display:'flex', gap:8, marginTop:16, justifyContent:'flex-end' }}>
              <button className="btn btn-secondary btn-sm"
                onClick={() => {
                  const text = document.querySelector('[data-report-text]')?.textContent;
                  navigator.clipboard.writeText(text || '');
                }}>
                📋 Copiar
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => setShowReport(false)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

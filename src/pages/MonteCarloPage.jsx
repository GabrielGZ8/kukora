import { useState, useCallback, useRef, useEffect } from 'react';
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api } from '../api';
import { PageHeader } from '../components/common/PageHeader';
import { HelpBadge } from '../components/common/TooltipHint';

const COINS = [
  { id: 'bitcoin',     label: 'BTC ·  Bitcoin' },
  { id: 'ethereum',    label: 'ETH ·  Ethereum' },
  { id: 'solana',      label: 'SOL ·  Solana' },
  { id: 'binancecoin', label: 'BNB ·  BNB' },
  { id: 'ripple',      label: 'XRP ·  XRP' },
  { id: 'cardano',     label: 'ADA ·  Cardano' },
  { id: 'dogecoin',    label: 'DOGE · Dogecoin' },
  { id: 'avalanche-2', label: 'AVAX · Avalanche' },
];

const fmt   = n => n == null ? '—' : n >= 1 ? `$${n.toLocaleString('en', { maximumFractionDigits: 2 })}` : `$${n?.toFixed(5)}`;
const fmtPct = n => n == null ? '—' : `${n >= 0 ? '+' : ''}${n?.toFixed(2)}%`;

function MonteCarloCanvas({ data }) {
  const canvasRef  = useRef(null);
  const animRef    = useRef(null);
  const progressRef = useRef(0);

  useEffect(() => {
    if (!data) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const dpr = window.devicePixelRatio || 1;
    canvas.width  = canvas.offsetWidth  * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.scale(dpr, dpr);

    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    const PAD = { t: 16, r: 16, b: 32, l: 64 };
    const pw = W - PAD.l - PAD.r;
    const ph = H - PAD.t - PAD.b;

    const { paths, S0, horizon } = data;

    // Pre-compute percentiles at each time step
    const getPct = (idx) => {
      const vals = paths.map(p => p[idx]).sort((a, b) => a - b);
      return {
        p5:  vals[Math.floor(0.05 * vals.length)],
        p25: vals[Math.floor(0.25 * vals.length)],
        p50: vals[Math.floor(0.50 * vals.length)],
        p75: vals[Math.floor(0.75 * vals.length)],
        p95: vals[Math.floor(0.95 * vals.length)],
      };
    };
    const pcts = Array.from({ length: horizon + 1 }, (_, i) => getPct(i));

    const allVals = pcts.flatMap(p => [p.p5, p.p95]).filter(Boolean);
    const minV = Math.min(...allVals) * 0.97;
    const maxV = Math.max(...allVals) * 1.03;

    const toX = t => PAD.l + (t / horizon) * pw;
    const toY = v => PAD.t + ph - ((v - minV) / (maxV - minV)) * ph;

    const sample = paths.filter((_, i) => i % Math.max(1, Math.floor(paths.length / 100)) === 0);

    progressRef.current = 0;

    const draw = () => {
      progressRef.current = Math.min(1, progressRef.current + 0.018);
      const prog = progressRef.current;
      const curT = Math.min(horizon, Math.floor(prog * horizon));

      ctx.clearRect(0, 0, W, H);

      // Background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);

      // Grid lines (horizontal)
      ctx.strokeStyle = 'rgba(0,0,0,0.05)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const v = minV + (i / 4) * (maxV - minV);
        const y = toY(v);
        ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();

        // Y labels
        ctx.fillStyle = 'rgba(107,114,128,0.8)';
        ctx.font = '10px Inter, system-ui';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(fmt(v), PAD.l - 6, y);
      }

      // X axis labels
      ctx.fillStyle = 'rgba(107,114,128,0.8)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let d = 0; d <= 5; d++) {
        const t = Math.round((d / 5) * horizon);
        ctx.fillText(`d${t}`, toX(t), H - PAD.b + 6);
      }

      if (curT < 1) { animRef.current = requestAnimationFrame(draw); return; }

      // Draw sampled paths
      sample.forEach(path => {
        const final = path[horizon] || path[path.length - 1];
        const pctGain = (final - S0) / S0;
        ctx.beginPath();
        ctx.moveTo(toX(0), toY(path[0]));
        for (let t = 1; t <= curT; t++) ctx.lineTo(toX(t), toY(path[t]));
        ctx.strokeStyle = pctGain > 0 ? 'rgba(0,184,122,0.12)' : 'rgba(240,62,62,0.12)';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.stroke();
      });

      // Cone P25-P75
      ctx.beginPath();
      ctx.moveTo(toX(0), toY(pcts[0].p25));
      for (let t = 1; t <= curT; t++) ctx.lineTo(toX(t), toY(pcts[t].p25));
      for (let t = curT; t >= 0; t--) ctx.lineTo(toX(t), toY(pcts[t].p75));
      ctx.closePath();
      ctx.fillStyle = 'rgba(59,130,246,0.06)';
      ctx.fill();

      // Outer cone P5-P95
      ctx.beginPath();
      ctx.moveTo(toX(0), toY(pcts[0].p5));
      for (let t = 1; t <= curT; t++) ctx.lineTo(toX(t), toY(pcts[t].p5));
      for (let t = curT; t >= 0; t--) ctx.lineTo(toX(t), toY(pcts[t].p95));
      ctx.closePath();
      ctx.fillStyle = 'rgba(59,130,246,0.025)';
      ctx.fill();

      // Percentile lines
      const lines = [
        { key: 'p5',  color: '#f03e3e', w: 1.5, dash: [4,4],  label: 'P5' },
        { key: 'p25', color: '#f59e0b', w: 1.5, dash: [],      label: 'P25' },
        { key: 'p50', color: '#3b82f6', w: 2.5, dash: [],      label: 'P50' },
        { key: 'p75', color: '#8b5cf6', w: 1.5, dash: [],      label: 'P75' },
        { key: 'p95', color: '#00b87a', w: 1.5, dash: [4,4],  label: 'P95' },
      ];

      lines.forEach(({ key, color, w, dash, label }) => {
        ctx.beginPath();
        ctx.moveTo(toX(0), toY(pcts[0][key]));
        for (let t = 1; t <= curT; t++) ctx.lineTo(toX(t), toY(pcts[t][key]));
        ctx.strokeStyle = color;
        ctx.lineWidth   = w;
        ctx.setLineDash(dash);
        ctx.stroke();
        ctx.setLineDash([]);

        if (curT >= Math.floor(horizon * 0.85) && pcts[curT]?.[key]) {
          const lx = toX(curT) + 5;
          const ly = toY(pcts[curT][key]);
          ctx.font = '700 9px Inter, system-ui';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = color;
          ctx.fillText(`${label} ${fmt(pcts[curT][key])}`, lx, ly);
        }
      });

      if (prog < 1) animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [data]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: 380, display: 'block', borderRadius: 'var(--radius)' }}
    />
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

export default function MonteCarloPage() {
  const [coin, setCoin]           = useState('bitcoin');
  const [horizon, setHorizon]     = useState(30);
  const [sims, setSims]           = useState(500);
  const [target, setTarget]       = useState('');
  const [loading, setLoading]     = useState(false);
  const [data, setData]           = useState(null);
  const [error, setError]         = useState(null);

  const run = useCallback(async () => {
    setLoading(true); setError(null); setData(null);
    try {
      const p = new URLSearchParams({ days: 60, horizon, simulations: sims });
      if (target) p.set('target', target);
      const r = await api.get(`/api/crypto/coin/${coin}/montecarlo?${p}`);
      setData(r);
    } catch (e) { setError(e.message || 'Error al ejecutar la simulación'); }
    finally { setLoading(false); }
  }, [coin, horizon, sims, target]);

  const selectStyle = {
    padding: '8px 12px', borderRadius: 'var(--radius)', fontSize: 13,
    border: '1px solid var(--border-bright)', background: 'var(--bg-surface)',
    color: 'var(--text)', cursor: 'pointer', fontFamily: 'var(--font-ui)',
    outline: 'none',
  };

  return (
    <div className="page-enter">
      <PageHeader
        title="Monte Carlo Simulation"
        description="Geometric Brownian Motion · abanico probabilístico animado · percentiles P5/P50/P95"
        help="Simula miles de trayectorias de precio usando el modelo GBM (dS = μS·dt + σS·dW). Los parámetros μ y σ se calibran con datos históricos reales."
      />

      {/* Controls */}
      <div className="card" style={{ marginBottom: 20, padding: '18px 20px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
          {[
            {
              label: 'Activo',
              el: (
                <select style={selectStyle} value={coin} onChange={e => setCoin(e.target.value)}>
                  {COINS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              ),
            },
            {
              label: 'Horizonte',
              el: (
                <select style={selectStyle} value={horizon} onChange={e => setHorizon(Number(e.target.value))}>
                  {[7, 14, 30, 60, 90].map(d => <option key={d} value={d}>{d} días</option>)}
                </select>
              ),
            },
            {
              label: 'Simulaciones',
              el: (
                <select style={selectStyle} value={sims} onChange={e => setSims(Number(e.target.value))}>
                  {[200, 300, 500, 800].map(n => <option key={n} value={n}>{n} paths</option>)}
                </select>
              ),
            },
            {
              label: 'Precio objetivo ($)',
              el: (
                <input
                  className="input"
                  style={{ width: 150 }}
                  type="number"
                  placeholder="ej. 100000"
                  value={target}
                  onChange={e => setTarget(e.target.value)}
                />
              ),
            },
          ].map(({ label, el }) => (
            <div key={label}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>{label}</div>
              {el}
            </div>
          ))}
          <button className="btn btn-primary" onClick={run} disabled={loading} style={{ alignSelf: 'flex-end' }}>
            {loading ? '⟳ Simulando…' : '▶ Ejecutar GBM'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: '12px 16px', background: 'var(--color-red-dim)', border: '1px solid rgba(240,62,62,0.25)', borderRadius: 'var(--radius)', color: 'var(--color-red)', fontSize: 13, marginBottom: 16 }}>
          ⚠ {error}
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: 80 }}>
          <div className="spinner" style={{ margin: '0 auto 14px' }} />
          <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 600 }}>Generando {sims} trayectorias GBM…</div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>dS = μS·dt + σS·dW</div>
        </div>
      )}

      {data && !loading && (
        <>
          {/* KPI row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 18 }}>
            {[
              { label: 'Precio Actual',    value: fmt(data.S0),                                    accent: '#0f1117' },
              { label: 'Precio Esperado',  value: fmt(data.mean),                                   accent: 'var(--color-blue)' },
              { label: 'Retorno EV',       value: fmtPct(data.expectedReturn), accent: (data.expectedReturn || 0) >= 0 ? 'var(--color-green)' : 'var(--color-red)' },
              { label: 'P10 Bajista',      value: fmt(data.percentiles?.p10 || data.percentiles?.p5), accent: 'var(--color-red)' },
              { label: 'P50 Mediana',      value: fmt(data.percentiles?.p50),                       accent: 'var(--color-blue)' },
              { label: 'P90 Alcista',      value: fmt(data.percentiles?.p90 || data.percentiles?.p95), accent: 'var(--color-green)' },
              { label: 'Volatilidad σ',    value: `${data.sigma?.toFixed(2)}%/d`,                   accent: 'var(--color-yellow)' },
              { label: 'Drift μ',          value: `${data.mu?.toFixed(3)}%/d`,                      accent: 'var(--color-purple)' },
            ].map(({ label, value, accent }) => (
              <div key={label} style={{ background: '#fff', borderRadius: 'var(--radius)', padding: '12px 14px', border: '1px solid var(--border)', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 5 }}>{label}</div>
                <div style={{ fontSize: 15, fontWeight: 900, color: accent, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
              </div>
            ))}
          </div>

          {/* Export buttons */}
          <div style={{ display:'flex', gap:8, marginBottom:16 }}>
            <button className="btn btn-ghost btn-sm" onClick={()=>exportJSON({percentiles:data.percentiles,expectedReturn:data.expectedReturn,sigma:data.sigma,mu:data.mu},'kukora_montecarlo.json')}>↓ Resultados JSON</button>
            <button className="btn btn-ghost btn-sm" onClick={()=>exportCSV(data.histogram,'kukora_distribution.csv')}>↓ Distribución CSV</button>
          </div>

          {/* Target probability */}
          {data.target != null && (
            <div style={{ background: 'linear-gradient(135deg, rgba(255,140,66,0.05), rgba(255,45,120,0.05))', border: '1px solid rgba(255,45,120,0.15)', borderRadius: 'var(--radius-lg)', padding: '18px 20px', marginBottom: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 12 }}>
                🎯 Objetivo: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{fmt(data.target)}</span>
              </div>
              <div style={{ display: 'flex', gap: 32 }}>
                <div>
                  <div style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>P(precio &gt; objetivo)</div>
                  <div style={{ fontSize: 32, fontWeight: 900, color: 'var(--color-green)', fontFamily: 'var(--font-mono)' }}>{data.probAbove}%</div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>P(precio &lt; objetivo)</div>
                  <div style={{ fontSize: 32, fontWeight: 900, color: 'var(--color-red)', fontFamily: 'var(--font-mono)' }}>{data.probBelow}%</div>
                </div>
              </div>
            </div>
          )}

          {/* Animated canvas */}
          <div className="card" style={{ marginBottom: 18, padding: '18px 20px' }}>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Abanico Probabilístico</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{data.paths?.length} trayectorias GBM · horizonte {data.horizon}d · verde = alcistas · rojo = bajistas</div>
            </div>
            <MonteCarloCanvas data={data} />
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 12 }}>
              {[
                { color: '#f03e3e', label: 'P5 (bajista extremo)', dash: true },
                { color: '#f59e0b', label: 'P25' },
                { color: '#3b82f6', label: 'P50 (mediana)', bold: true },
                { color: '#8b5cf6', label: 'P75' },
                { color: '#00b87a', label: 'P95 (alcista extremo)', dash: true },
              ].map(({ color, label, dash, bold }) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                  <div style={{ width: 20, height: bold ? 2.5 : 1.5, background: color, borderRadius: 1, opacity: dash ? 0.7 : 1 }} />
                  {label}
                </div>
              ))}
            </div>
          </div>

          {/* Histogram */}
          <div className="card" style={{ padding: '18px 20px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Distribución Final de Precios</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
              Frecuencia al día {data.horizon} · {data.paths?.length} simulaciones
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={data.histogram} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="rgba(0,0,0,0.05)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="lo"
                  tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v?.toFixed(0)}
                  tick={{ fontSize: 9, fill: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}
                />
                <YAxis tick={{ fontSize: 9, fill: 'var(--text-dim)' }} />
                <Tooltip
                  contentStyle={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }}
                  formatter={v => [`${v} simulaciones`, 'Frecuencia']}
                />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {data.histogram?.map((entry, i) => (
                    <Cell key={i} fill={(entry.lo + entry.hi) / 2 >= data.S0 ? 'rgba(0,184,122,0.65)' : 'rgba(240,62,62,0.65)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {!data && !loading && !error && (
        <div style={{ textAlign: 'center', padding: 80, color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 48, marginBottom: 12, opacity: 0.2 }}>⟳</div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Configura y ejecuta la simulación</div>
          <div style={{ fontSize: 12, marginTop: 6, color: 'var(--text-dim)' }}>Geometric Brownian Motion · dS = μS·dt + σS·dW</div>
        </div>
      )}
    </div>
  );
}

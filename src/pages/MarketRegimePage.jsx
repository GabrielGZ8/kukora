import { useState, useEffect } from 'react';
import { usePolling } from '../hooks/usePolling';
import { api } from '../api';
import { PageHeader } from '../components/common/PageHeader';

const COINS_DEFAULT = 'bitcoin,ethereum,solana,binancecoin,ripple';

const REGIME_META = {
  LIQUIDITY_COMPRESSION:  { icon: '⟁', color: '#f59e0b', bg: 'rgba(245,158,11,0.07)',  border: 'rgba(245,158,11,0.20)' },
  BULLISH_EXPANSION:      { icon: '▲', color: '#00b87a', bg: 'rgba(0,184,122,0.07)',   border: 'rgba(0,184,122,0.20)' },
  BEARISH_CONTRACTION:    { icon: '▼', color: '#f03e3e', bg: 'rgba(240,62,62,0.07)',   border: 'rgba(240,62,62,0.20)' },
  DISTRIBUTION:           { icon: '◈', color: '#8b5cf6', bg: 'rgba(139,92,246,0.07)',  border: 'rgba(139,92,246,0.20)' },
  ACCUMULATION:           { icon: '◎', color: '#3b82f6', bg: 'rgba(59,130,246,0.07)',  border: 'rgba(59,130,246,0.20)' },
  VOLATILE_UNCERTAINTY:   { icon: '⚡', color: '#FF8C42', bg: 'rgba(255,140,66,0.07)', border: 'rgba(255,140,66,0.20)' },
};

function ConfidenceBar({ value, color }) {
  const [w, setW] = useState(0);
  useEffect(() => { const t = setTimeout(() => setW(value), 120); return () => clearTimeout(t); }, [value]);
  return (
    <div style={{ height: 5, background: 'var(--bg-surface-3)', borderRadius: 99, overflow: 'hidden' }}>
      <div style={{
        height: '100%', width: `${w}%`, background: color,
        borderRadius: 99, transition: 'width 0.9s cubic-bezier(0.4,0,0.2,1)',
      }} />
    </div>
  );
}

function KCSGauge({ kcs }) {
  const score = kcs?.score || 50;
  const color = kcs?.color || '#f59e0b';
  const r = 58, cx = 74, cy = 74;
  const circ = 2 * Math.PI * r;
  const [dash, setDash] = useState(0);
  useEffect(() => { const t = setTimeout(() => setDash(circ * (score / 100)), 200); return () => clearTimeout(t); }, [score, circ]);

  if (!kcs) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <svg width={148} height={148} viewBox="0 0 148 148">
          {/* Track */}
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--bg-surface-3)" strokeWidth={10} />
          {/* Score arc */}
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={10}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circ}`}
            strokeDashoffset={circ * 0.25}
            style={{ transition: 'stroke-dasharray 1s cubic-bezier(0.4,0,0.2,1)' }} />
          {/* Score text */}
          <text x={cx} y={cy - 6} textAnchor="middle" fontSize={30} fontWeight={900}
            fill={color} fontFamily="var(--font-mono)">{score}</text>
          <text x={cx} y={cy + 12} textAnchor="middle" fontSize={9} fill="var(--text-dim)" fontWeight={700}>
            KCS SCORE
          </text>
          <text x={cx} y={cy + 26} textAnchor="middle" fontSize={10} fill={color} fontWeight={800}>
            {kcs.bias || '—'}
          </text>
        </svg>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'inline-block', fontSize: 11, fontWeight: 800, color,
          background: `${color}15`, padding: '4px 12px', borderRadius: 99,
          border: `1px solid ${color}25`, marginBottom: 10,
        }}>
          {kcs.state || '—'}
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55, margin: 0 }}>
          {kcs.description}
        </p>
      </div>
    </div>
  );
}

function KCSBreakdown({ components }) {
  if (!components) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 18 }}>
      {Object.entries(components).map(([key, c]) => {
        const color = c.score >= 60 ? 'var(--color-green)' : c.score >= 40 ? 'var(--color-yellow)' : 'var(--color-red)';
        return (
          <div key={key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>{c.label}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color, fontFamily: 'var(--font-mono)' }}>
                {c.score} <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>({Math.round(c.weight * 100)}%)</span>
              </span>
            </div>
            <ConfidenceBar value={c.score} color={color} />
          </div>
        );
      })}
    </div>
  );
}

function SignalPill({ signal }) {
  const pos = ['Bullish', 'Positivo', 'Normal', 'Fuerte subida'];
  const neg = ['Bearish', 'Negative', 'Risk', 'Strong drop', 'Compressed (caution)'];
  const isPos = pos.some(w => signal.interpretation.includes(w));
  const isNeg = neg.some(w => signal.interpretation.includes(w));
  const color = isPos ? 'var(--color-green)' : isNeg ? 'var(--color-red)' : 'var(--color-yellow)';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>{signal.name}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)', color }}>{signal.value}</span>
        <span style={{ fontSize: 9, fontWeight: 700, color, background: `${color}15`, padding: '2px 7px', borderRadius: 99 }}>
          {signal.interpretation}
        </span>
      </div>
    </div>
  );
}

function AssetRow({ asset }) {
  const meta = REGIME_META[asset.regime?.id] || REGIME_META.VOLATILE_UNCERTAINTY;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{
        width: 32, height: 32, borderRadius: 9,
        background: meta.bg, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        fontSize: 14, flexShrink: 0,
      }}>
        {meta.icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }}>{asset.id}</div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{asset.regime?.label}</div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: meta.color, fontFamily: 'var(--font-mono)' }}>{asset.regime?.confidence}%</div>
        <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>confidence</div>
      </div>
    </div>
  );
}


const exportJSON = (data, filename) => {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(data,null,2)], {type:'application/json'})), download: filename });
  a.click();
};

export default function MarketRegimePage() {
  const { data, loading } = usePolling(
    () => api.get(`/api/crypto/regime?coins=${COINS_DEFAULT}&days=30`),
    120_000, []
  );

  const consensus = data?.consensus;
  const kcs       = data?.kcs;
  const assets    = data?.assets || [];
  const meta      = consensus ? (REGIME_META[consensus.id] || REGIME_META.VOLATILE_UNCERTAINTY) : null;
  const firstAsset = assets[0]?.regime;

  return (
    <div className="page-enter">
      <PageHeader
        title="Market Regime Engine"
        description="Detection cuantitativa del regime de market actual · analysis multi-signal in real time"
        badge="AI"
        live
        actions={data && <button className="btn btn-ghost btn-sm" onClick={()=>exportJSON(data,'kukora_regime.json')}>↓ Export JSON</button>}
        help="Clasifica el market en 6 regímenes usando volatility normalizada, trend MA y momentum. Se actualiza cada 2 minutes."
      />

      {loading && (
        <div style={{ textAlign: 'center', padding: 80 }}>
          <div className="spinner" style={{ margin: '0 auto 14px' }} />
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Analizando regime de market…</div>
        </div>
      )}

      {!loading && consensus && meta && (
        <>
          {/* Hero regime card */}
          <div style={{
            background: '#fff',
            border: `1px solid ${meta.border}`,
            borderLeft: `4px solid ${meta.color}`,
            borderRadius: 'var(--radius-xl)',
            padding: '28px 32px',
            marginBottom: 20,
            boxShadow: '0 2px 16px rgba(0,0,0,0.06)',
          }}>
            {/* Status row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
              <div className="pulse-dot" />
              <span style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Kukora AI · Market Regime Detected
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-dim)' }}>
                {assets.length} actives analizados · 30d
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32 }}>
              {/* Left: Regime identity */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
                  <div style={{
                    width: 52, height: 52, borderRadius: 14,
                    background: meta.bg, display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                    fontSize: 24, border: `1px solid ${meta.border}`, flexShrink: 0,
                  }}>
                    {meta.icon}
                  </div>
                  <div>
                    <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>ACTIVE REGIME</div>
                    <div style={{ fontSize: 22, fontWeight: 900, color: meta.color, lineHeight: 1.1 }}>{consensus.label}</div>
                  </div>
                </div>

                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>Confidence del model</span>
                    <span style={{ fontSize: 12, fontWeight: 800, color: meta.color, fontFamily: 'var(--font-mono)' }}>{consensus.confidence}%</span>
                  </div>
                  <ConfidenceBar value={consensus.confidence} color={meta.color} />
                </div>

                <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, margin: 0, padding: '12px 14px', background: meta.bg, borderRadius: 'var(--radius)', borderLeft: `2px solid ${meta.color}` }}>
                  {consensus.description}
                </p>

                {firstAsset?.breakoutProbability && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, padding: '12px 14px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                    <div>
                      <div style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Prob. Breakout 7d</div>
                      <div style={{ fontSize: 28, fontWeight: 900, color: meta.color, fontFamily: 'var(--font-mono)', lineHeight: 1 }}>{firstAsset.breakoutProbability}%</div>
                    </div>
                    <div style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                      Probabilidad histórica de movimiento expansivo en los nexts 7 days
                    </div>
                  </div>
                )}
              </div>

              {/* Right: Signals */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
                  Signales del System
                </div>
                {(firstAsset?.signals || []).map((s, i) => (
                  <SignalPill key={i} signal={s} />
                ))}
                {firstAsset?.interpretation && (
                  <div style={{ marginTop: 14, padding: '12px 14px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Interpretación Cuantitativa
                    </div>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55, margin: 0 }}>
                      {firstAsset.interpretation}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* KCS + Asset regimes */}
          <div className="grid-2" style={{ marginBottom: 20 }}>
            {/* KCS Panel */}
            <div className="card">
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 16 }}>
                KCS — Kukora Composite Signal
              </div>
              <KCSGauge kcs={kcs} />
              <KCSBreakdown components={kcs?.components} />
            </div>

            {/* Per-asset regimes */}
            <div className="card">
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
                Regime por Asset
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 14 }}>Analysis individual · 30 days</div>
              {assets.map(a => <AssetRow key={a.id} asset={a} />)}
            </div>
          </div>
        </>
      )}

      {!loading && !consensus && (
        <div style={{ textAlign: 'center', padding: 80, color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.3 }}>◈</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>No data availables</div>
          <div style={{ fontSize: 12, marginTop: 6 }}>Verifica la conexión con CoinGecko</div>
        </div>
      )}
    </div>
  );
}

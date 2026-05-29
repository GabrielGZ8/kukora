import { usePolling } from '../hooks/usePolling';
import { api } from '../api';
import { MetricCard, MetricGrid } from '../components/common/MetricCard';
import { CoinTable } from '../components/common/CoinTable';
import { Sparkline } from '../components/common/Sparkline';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/common/PageHeader';
import { MarketPulse } from '../components/common/MarketPulse';

const fmtB = n => n >= 1e12 ? `$${(n/1e12).toFixed(2)}T` : `$${(n/1e9).toFixed(2)}B`;
const fmtP = n => n == null ? '—' : `${n>=0?'+':''}${n.toFixed(2)}%`;

const REGIME_COLORS = {
  LIQUIDITY_COMPRESSION:  '#f59e0b',
  BULLISH_EXPANSION:      '#00b87a',
  BEARISH_CONTRACTION:    '#f03e3e',
  DISTRIBUTION:           '#8b5cf6',
  ACCUMULATION:           '#3b82f6',
  VOLATILE_UNCERTAINTY:   '#FF8C42',
};

const REGIME_ICONS = {
  LIQUIDITY_COMPRESSION: '⟁',
  BULLISH_EXPANSION:     '▲',
  BEARISH_CONTRACTION:   '▼',
  DISTRIBUTION:          '◈',
  ACCUMULATION:          '◎',
  VOLATILE_UNCERTAINTY:  '~',
};

function calcFearGreed(coins) {
  if (!coins.length) return { score: 50, label: 'Neutral', color: '#f59e0b' };
  const pcts = coins.map(c => c.price_change_percentage_24h || 0).filter(Boolean);
  const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const variance = pcts.reduce((a, b) => a + (b - mean) ** 2, 0) / pcts.length;
  const stdDev = Math.sqrt(variance);
  const positiveRatio = pcts.filter(p => p > 0).length / pcts.length;
  const momentumScore = Math.max(0, Math.min(100, 50 + mean * 3));
  const volPenalty = Math.min(30, stdDev * 2);
  const breadthBonus = (positiveRatio - 0.5) * 40;
  const score = Math.round(Math.max(0, Math.min(100, momentumScore + breadthBonus - volPenalty)));
  let label, color;
  if (score <= 25)      { label = 'Miedo Extremo'; color = '#f03e3e'; }
  else if (score <= 45) { label = 'Miedo';          color = '#FF8C42'; }
  else if (score <= 55) { label = 'Neutral';         color = '#f59e0b'; }
  else if (score <= 75) { label = 'Codicia';         color = '#00b87a'; }
  else                  { label = 'Codicia Extrema'; color = '#059669'; }
  return { score, label, color };
}

function FearGreedArc({ score, label, color }) {
  const r = 50, cx = 66, cy = 66;
  const circ = Math.PI * r;
  const dash = circ * (score / 100);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <svg width={132} height={76} viewBox="0 0 132 76">
        <path d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`}
          fill="none" stroke="var(--bg-surface-3)" strokeWidth={11} strokeLinecap="round" />
        <path d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`}
          fill="none" stroke={color} strokeWidth={11} strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
          style={{ transition: 'stroke-dasharray 0.8s ease' }} />
        <text x={cx} y={cy - 6} textAnchor="middle" fontSize={24} fontWeight={900}
          fill={color} fontFamily="var(--font-mono)">{score}</text>
        <text x={cx} y={cy + 10} textAnchor="middle" fontSize={9}
          fill="var(--text-dim)" fontWeight={600}>/ 100</text>
      </svg>
      <span style={{
        fontSize: 11, fontWeight: 700, color,
        background: `${color}15`, padding: '3px 10px', borderRadius: 99,
        border: `1px solid ${color}25`,
      }}>{label}</span>
    </div>
  );
}

function RegimeBanner({ regime, kcs, onClick }) {
  if (!regime) return null;
  const color = REGIME_COLORS[regime.id] || '#f59e0b';
  const icon  = REGIME_ICONS[regime.id]  || '◈';

  return (
    <div
      onClick={onClick}
      style={{
        background: '#fff',
        border: `1px solid ${color}30`,
        borderLeft: `4px solid ${color}`,
        borderRadius: 'var(--radius-xl)',
        padding: '18px 22px',
        marginBottom: 24,
        cursor: 'pointer',
        boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
        transition: 'box-shadow var(--transition)',
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 20,
      }}
      onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 4px 20px rgba(0,0,0,0.10)'; }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = '0 2px 12px rgba(0,0,0,0.06)'; }}
    >
      {/* Label chip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <div style={{
          width: 34, height: 34, borderRadius: 10,
          background: `${color}15`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 16, flexShrink: 0,
        }}>
          {icon}
        </div>
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>
            Kukora AI · Régimen de Mercado
          </div>
          <div style={{ fontSize: 15, fontWeight: 800, color, lineHeight: 1 }}>{regime.label}</div>
        </div>
      </div>

      {/* Confidence bar */}
      <div style={{ flex: '1 1 140px', minWidth: 120 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
          <span style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>Confianza</span>
          <span style={{ fontSize: 10, fontWeight: 800, color, fontFamily: 'var(--font-mono)' }}>{regime.confidence}%</span>
        </div>
        <div style={{ height: 5, background: 'var(--bg-surface-3)', borderRadius: 99, overflow: 'hidden' }}>
          <div style={{
            height: '100%', width: `${regime.confidence}%`,
            background: color, borderRadius: 99, transition: 'width 0.8s ease',
          }} />
        </div>
      </div>

      {/* KCS score */}
      {kcs && (
        <div style={{ display: 'flex', gap: 16, flexShrink: 0 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>KCS</div>
            <div style={{ fontSize: 24, fontWeight: 900, color: kcs.color, fontFamily: 'var(--font-mono)', lineHeight: 1 }}>{kcs.score}</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Estado</div>
            <div style={{ fontSize: 10, fontWeight: 800, color: kcs.color, background: `${kcs.color}15`, padding: '3px 8px', borderRadius: 99, whiteSpace: 'nowrap' }}>{kcs.state}</div>
          </div>
        </div>
      )}

      <span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>Ver detalle →</span>
    </div>
  );
}

function MoverRow({ coin: c, up }) {
  const pct   = c.price_change_percentage_24h;
  const color = up ? 'var(--color-green)' : 'var(--color-red)';
  const price = c.current_price >= 1
    ? `$${c.current_price.toLocaleString('en', { maximumFractionDigits: 2 })}`
    : `$${c.current_price?.toFixed(4)}`;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
      <img src={c.image} alt={c.name} style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {c.symbol?.toUpperCase()}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
      </div>
      <Sparkline data={(c.sparkline_in_7d?.price || []).slice(-20)} width={52} height={24} positive={up} />
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 12, fontFamily: 'var(--font-mono)' }}>{price}</div>
        <div style={{ fontSize: 11, fontWeight: 700, color, fontFamily: 'var(--font-mono)' }}>
          {pct >= 0 ? '+' : ''}{pct?.toFixed(2)}%
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { data: mkt,  loading: mL } = usePolling(() => api.markets(50),   30000);
  const { data: g,    loading: gL } = usePolling(() => api.global(),       60000);
  const { data: ov               } = usePolling(() => api.overview(),      60000);
  const { data: rd               } = usePolling(
    () => api.get('/api/crypto/regime?coins=bitcoin,ethereum,solana,binancecoin,ripple&days=30'),
    180_000, []
  );

  const coins   = mkt?.coins   || [];
  const gainers = mkt?.gainers || [];
  const losers  = mkt?.losers  || [];
  const mcap    = g?.total_market_cap?.usd;
  const mcapChg = g?.market_cap_change_percentage_24h_usd;
  const btcDom  = g?.market_cap_percentage?.btc;
  const vol24   = g?.total_volume?.usd;
  const active  = g?.active_cryptocurrencies;

  const fg = calcFearGreed(coins);
  const positiveCoins = coins.filter(c => (c.price_change_percentage_24h || 0) > 0).length;
  const breadthPct = coins.length ? Math.round(positiveCoins / coins.length * 100) : 0;

  const topAnomalies = (ov?.coins || [])
    .sort((a, b) => (b.anomaly?.score || 0) - (a.anomaly?.score || 0))
    .slice(0, 3);

  return (
    <div className="page-enter">
      <PageHeader
        title="Dashboard"
        description="Vista general del mercado · actualización en vivo"
        live
      />

      {/* AI Regime Banner */}
      <RegimeBanner
        regime={rd?.consensus}
        kcs={rd?.kcs}
        onClick={() => navigate('/regime')}
      />

      {/* Live Market Pulse */}
      <MarketPulse coins={coins} globalData={g} />

      {/* KPI metrics */}
      <MetricGrid>
        <MetricCard label="Market Cap Total"  value={gL ? '…' : fmtB(mcap || 0)}             icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>} accent="primary" loading={gL} trend={mcapChg} />
        <MetricCard label="Volumen 24h"        value={gL ? '…' : fmtB(vol24 || 0)}             icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="12" width="4" height="9"/><rect x="10" y="7" width="4" height="14"/><rect x="17" y="3" width="4" height="18"/></svg>} accent="blue"    loading={gL} />
        <MetricCard label="Dominancia BTC"     value={gL ? '…' : `${btcDom?.toFixed(1)}%`}     icon="₿"  accent="yellow"  loading={gL} sub="del mercado total" />
        <MetricCard label="Cryptos Activas"    value={gL ? '…' : active?.toLocaleString()}      icon="◈"  accent="purple"  loading={gL} />
      </MetricGrid>

      {/* Fear & Greed + Breadth */}
      <div className="grid-2" style={{ marginBottom: 24 }}>
        {/* Fear & Greed */}
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <FearGreedArc score={fg.score} label={fg.label} color={fg.color} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>Fear & Greed Index</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.4 }}>
              Calculado desde volatilidad y momentum del mercado en tiempo real
            </div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {[
                { r: [0,25],  l: 'Miedo Extremo', c: '#f03e3e' },
                { r: [25,45], l: 'Miedo',          c: '#FF8C42' },
                { r: [45,55], l: 'Neutral',         c: '#f59e0b' },
                { r: [55,75], l: 'Codicia',         c: '#00b87a' },
                { r: [75,100],l: 'Extrema',         c: '#059669' },
              ].map(z => (
                <span key={z.l} style={{
                  fontSize: 9, fontWeight: 700, color: z.c,
                  background: `${z.c}15`, padding: '2px 7px', borderRadius: 99,
                  opacity: fg.score >= z.r[0] && fg.score < z.r[1] ? 1 : 0.3,
                  border: `1px solid ${z.c}25`,
                }}>
                  {z.l}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Market Breadth */}
        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Market Breadth 24h</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
            {positiveCoins} de {coins.length} activos en positivo
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
            <div style={{
              fontSize: 34, fontWeight: 900,
              color: breadthPct > 50 ? 'var(--color-green)' : 'var(--color-red)',
              fontFamily: 'var(--font-mono)', flexShrink: 0,
            }}>
              {breadthPct}%
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ height: 8, background: 'var(--bg-surface-3)', borderRadius: 99, overflow: 'hidden', marginBottom: 6 }}>
                <div style={{
                  width: `${breadthPct}%`, height: '100%',
                  background: breadthPct > 50
                    ? 'linear-gradient(90deg, var(--color-green), #059669)'
                    : 'linear-gradient(90deg, var(--color-red), #c01f1f)',
                  borderRadius: 99, transition: 'width 0.6s ease',
                }} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {breadthPct > 66 ? 'Mercado mayoritariamente alcista'
                  : breadthPct > 50 ? 'Leve sesgo positivo'
                  : breadthPct > 33 ? 'Leve sesgo negativo'
                  : 'Mercado mayoritariamente bajista'}
              </div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div style={{ background: 'var(--color-green-dim)', borderRadius: 'var(--radius)', padding: '10px 12px' }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--color-green)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>↑ Positivos</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--color-green)', fontFamily: 'var(--font-mono)' }}>{positiveCoins}</div>
            </div>
            <div style={{ background: 'var(--color-red-dim)', borderRadius: 'var(--radius)', padding: '10px 12px' }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--color-red)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>↓ Negativos</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--color-red)', fontFamily: 'var(--font-mono)' }}>{coins.length - positiveCoins}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Anomaly signals */}
      {topAnomalies.length > 0 && (
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="section-header" style={{ marginBottom: 12 }}>
            <div>
              <div className="section-title">Señales Detectadas</div>
              <div className="section-sub">Top 3 por anomaly + intelligence score</div>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/intelligence')}>Ver todas →</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
            {topAnomalies.map(c => (
              <div
                key={c.id}
                onClick={() => navigate('/intelligence')}
                style={{
                  background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)',
                  padding: '12px 14px', border: '1px solid var(--border)',
                  cursor: 'pointer', transition: 'all var(--transition)',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.background = '#fff'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--bg-surface-2)'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  {c.image && <img src={c.image} alt="" style={{ width: 24, height: 24, borderRadius: '50%', flexShrink: 0 }} onError={e => e.target.style.display = 'none'} />}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 12, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.symbol?.toUpperCase()}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</div>
                  </div>
                  {c.anomaly?.level !== 'low' && (
                    <span style={{ marginLeft: 'auto', fontSize: 8, fontWeight: 800, color: '#FF8C42', background: 'rgba(255,140,66,0.12)', padding: '1px 5px', borderRadius: 4, flexShrink: 0 }}></span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  Trend: <b style={{ color: c.trendRaw === 'bullish' ? 'var(--color-green)' : c.trendRaw === 'bearish' ? 'var(--color-red)' : 'var(--color-yellow)' }}>{c.trend}</b>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                  24h: <b style={{ color: (c.change24h || 0) >= 0 ? 'var(--color-green)' : 'var(--color-red)', fontFamily: 'var(--font-mono)' }}>{fmtP(c.change24h)}</b>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Gainers / Losers */}
      <div className="grid-2" style={{ marginBottom: 24 }}>
        <div className="card">
          <div className="section-header">
            <div>
              <div className="section-title">Top Gainers 24h</div>
              <div className="section-sub">Mejor rendimiento del día</div>
            </div>
          </div>
          {mL
            ? <div style={{ textAlign: 'center', padding: 32 }}><div className="spinner" /></div>
            : gainers.map(c => <MoverRow key={c.id} coin={c} up />)
          }
        </div>
        <div className="card">
          <div className="section-header">
            <div>
              <div className="section-title"> Top Losers 24h</div>
              <div className="section-sub">Mayor caída del día</div>
            </div>
          </div>
          {mL
            ? <div style={{ textAlign: 'center', padding: 32 }}><div className="spinner" /></div>
            : losers.map(c => <MoverRow key={c.id} coin={c} up={false} />)
          }
        </div>
      </div>

      {/* Markets table */}
      <div className="card">
        <div className="section-header" style={{ marginBottom: 16 }}>
          <div>
            <div className="section-title">Mercados · Top 50</div>
            <div className="section-sub">Por market cap · actualización cada 30s</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div className="pulse-dot" />
            <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 600 }}>LIVE</span>
          </div>
        </div>
        <CoinTable coins={coins} />
      </div>
    </div>
  );
}

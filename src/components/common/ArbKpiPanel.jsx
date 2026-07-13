/**
 * ArbKpiPanel — Panel de KPIs ejecutivos del motor de arbitraje.
 *
 * Muestra en /dashboard:
 *   1. PnL del día (hoy) + comparación vs yesterday
 *   2. Trades hoy vs yesterday
 *   3. Mejor spread detectado en sesión
 *   4. Uptime del engine
 *   5. Exchange más activo (por opportunitiesExecuted)
 *
 * Fuentes de datos:
 *   - GET /api/arbitrage/daily-stats?days=2  → hoy + ayer
 *   - GET /api/arbitrage/executive           → uptimeMs, bestOpportunitySeen, bestExchange
 *
 * Diseño: misma paleta que el resto de la app (CSS vars), sin deps externas.
 */

import { usePolling } from '../../hooks/usePolling';
import { api } from '../../api';
import { useNavigate } from 'react-router-dom';

const PINK  = '#FF2D78';
const GREEN = '#00b87a';

// ─── Formatters ────────────────────────────────────────────────────────────

function fmtPnl(n) {
  if (n == null || n === 0) return '$0.00';
  const abs = Math.abs(n);
  const str = abs >= 1000 ? `$${(abs / 1000).toFixed(2)}k` : `$${abs.toFixed(2)}`;
  return (n >= 0 ? '+' : '-') + str;
}

function fmtUptime(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0)   return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtSpread(n) {
  if (n == null) return '—';
  return `${(n * 100).toFixed(3)}%`;
}

function delta(today, yesterday) {
  if (yesterday == null || yesterday === 0) return null;
  return ((today - yesterday) / Math.abs(yesterday)) * 100;
}

// ─── Sub-components ────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, subColor, loading, onClick, accent }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--bg-surface)',
        border: `1px solid ${accent ? accent + '33' : 'var(--border)'}`,
        borderRadius: 14,
        padding: '18px 20px',
        display: 'flex', flexDirection: 'column', gap: 6,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        boxShadow: accent ? `0 0 0 0px ${accent}22` : 'none',
        minWidth: 0,
      }}
      onMouseEnter={e => {
        if (!onClick) return;
        e.currentTarget.style.borderColor = accent || 'var(--border-bright)';
        e.currentTarget.style.boxShadow = `0 4px 18px ${accent || PINK}22`;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = accent ? accent + '33' : 'var(--border)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{
        fontSize: 24, fontWeight: 900, lineHeight: 1,
        color: accent || 'var(--text)',
        opacity: loading ? 0.3 : 1,
        transition: 'opacity 0.2s',
      }}>
        {loading ? '…' : value}
      </div>
      {sub && (
        <div style={{ fontSize: 12, fontWeight: 600, color: subColor || 'var(--text-muted)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function DeltaBadge({ pct }) {
  if (pct == null) return null;
  const up = pct >= 0;
  return (
    <span style={{
      fontSize: 11, fontWeight: 700,
      color: up ? GREEN : '#f03e3e',
      background: up ? 'rgba(0,184,122,0.10)' : 'rgba(240,62,62,0.10)',
      padding: '2px 7px', borderRadius: 20,
    }}>
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}% vs yesterday
    </span>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function ArbKpiPanel() {
  const navigate = useNavigate();

  const { data: statsRaw, loading: statsL } =
    usePolling(() => api.arb.dailyStats(2), 60_000);

  const { data: exec, loading: execL } =
    usePolling(() => api.arb.executive(), 30_000);

  // daily-stats returns an array sorted by date desc (today first)
  const stats    = Array.isArray(statsRaw) ? statsRaw : [];
  const today    = stats.find(d => d.isToday) || stats[0] || null;
  const yesterday = stats.find(d => !d.isToday) || stats[1] || null;

  const pnlToday     = today?.pnl     ?? null;
  const pnlYesterday = yesterday?.pnl ?? null;
  const pnlDelta     = pnlToday != null && pnlYesterday != null ? delta(pnlToday, pnlYesterday) : null;

  const tradesToday     = today?.trades     ?? null;
  const tradesYesterday = yesterday?.trades ?? null;
  const tradesDelta     = tradesToday != null && tradesYesterday != null ? delta(tradesToday, tradesYesterday) : null;

  // bestOpportunitySeen shape: { spread, buyExchange, sellExchange, pair, ts }
  const bestOpp     = exec?.bestOpportunitySeen ?? null;
  const bestSpread  = bestOpp?.spread ?? bestOpp?.netSpread ?? null;

  const uptimeMs    = exec?.uptimeMs ?? null;
  const bestExchange = exec?.bestExchange ?? '—';

  return (
    <section style={{ marginBottom: 28 }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14,
      }}>
        <div style={{
          fontSize: 13, fontWeight: 800, color: 'var(--text)',
          letterSpacing: '-0.2px',
        }}>
          Motor de Arbitraje
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          background: 'rgba(0,184,122,0.10)',
          border: '1px solid rgba(0,184,122,0.25)',
          borderRadius: 20, padding: '3px 10px',
          fontSize: 11, fontWeight: 700, color: GREEN,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', background: GREEN, display: 'inline-block',
            animation: 'arbpulse 2s ease-in-out infinite',
          }} />
          LIVE
        </div>
        <button
          onClick={() => navigate('/arbitrage')}
          style={{
            marginLeft: 'auto',
            fontSize: 12, fontWeight: 700, color: 'var(--text-muted)',
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '4px 8px',
          }}
        >
          Ver motor →
        </button>
      </div>

      {/* KPI grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 12,
      }}>
        {/* PnL del día */}
        <KpiCard
          label="PnL Hoy"
          value={pnlToday != null ? fmtPnl(pnlToday) : '—'}
          sub={
            pnlDelta != null
              ? <DeltaBadge pct={pnlDelta} />
              : pnlYesterday != null ? `Yesterday: ${fmtPnl(pnlYesterday)}` :  'No historical data'
          }
          subColor={pnlToday != null ? (pnlToday >= 0 ? GREEN : '#f03e3e') : undefined}
          loading={statsL}
          accent={pnlToday != null ? (pnlToday >= 0 ? GREEN : '#f03e3e') : undefined}
          onClick={() => navigate('/arbitrage')}
        />

        {/* Trades hoy */}
        <KpiCard
          label="Trades Hoy"
          value={tradesToday ?? '—'}
          sub={
            tradesDelta != null
              ? <DeltaBadge pct={tradesDelta} />
              : tradesYesterday != null ? `Yesterday: ${tradesYesterday}` : null
          }
          loading={statsL}
          onClick={() => navigate('/arbitrage')}
        />

        {/* Mejor spread */}
        <KpiCard
          label="Mejor Spread"
          value={bestSpread != null ? fmtSpread(bestSpread) : '—'}
          sub={bestOpp?.pair
            ? `${bestOpp.pair} · ${bestOpp.buyExchange || '?'} → ${bestOpp.sellExchange || '?'}`
            : 'Current session'}
          loading={execL}
          accent={PINK}
          onClick={() => navigate('/arbitrage')}
        />

        {/* Uptime del engine */}
        <KpiCard
          label="Uptime Engine"
          value={fmtUptime(uptimeMs)}
          sub={uptimeMs != null ? 'Engine corriendo' : 'Sin datos'}
          loading={execL}
          accent={uptimeMs != null ? GREEN : undefined}
        />

        {/* Exchange más activo */}
        <KpiCard
          label="Exchange Top"
          value={bestExchange}
          sub="Mayor actividad hoy"
          loading={execL}
          onClick={() => navigate('/arbitrage')}
        />
      </div>

      <style>{`
        @keyframes arbpulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>
    </section>
  );
}

import { useState, useEffect } from 'react';
import { api } from '../api';
import { useTranslation } from '../i18n/I18nContext';

const TIMELINE = [
  {
    period: '2024 Q1',
    title: 'Core Engine',
    desc: 'Bilateral O(n²) detection across 5 exchanges via native WebSockets. VWAP L2 pricing replaces midprice assumptions. Sub-30ms opportunity detection established as baseline.',
  },
  {
    period: '2024 Q2',
    title: 'Risk & Execution Layer',
    desc: 'Full trade state machine (DETECTED → SCORING → APPROVED → FILLED / FAILED / ROLLED_BACK). Advanced risk engine with circuit breakers, drawdown controls and per-exchange exposure limits.',
  },
  {
    period: '2024 Q3',
    title: 'Quantitative Analytics',
    desc: 'StatArb engine with EWMA, Z-score and AR(1) half-life estimation. Spread heatmap, momentum engine and fill probability model. Microstructure decay curves and latency racing benchmarks.',
  },
  {
    period: '2024 Q4',
    title: 'Observability & Intelligence',
    desc: 'Structured observability service with root-cause analysis. ML scoring pipeline with pluggable model registry. Market regime detection and adaptive position sizing.',
  },
  {
    period: '2025 Q1–Q2',
    title: 'Operational Maturity',
    desc: 'Hot-reloadable live configuration without process restarts. Predictive rebalancing with depletion forecasting. Adversarial scenario suite. Institutional P&L reconciliation with CSV/HTML export.',
  },
  {
    period: '2025 Q3–Q4',
    title: 'Platform Consolidation',
    desc: 'Walk-forward backtesting with parameter sweep. Trade drilldown with 4-phase audit trail. Replay engine for historical moment reproduction. Executive dashboard with cross-module KPIs.',
  },
];

const PRINCIPLES = [
  {
    icon: '∿',
    title: 'Explainability First',
    desc: 'Every decision — execution, rejection, sizing — is traceable to specific model inputs and configurable thresholds. No black boxes.',
  },
  {
    icon: '⊕',
    title: 'Real Market Data',
    desc: 'Live L2 order books via native WebSockets across 5 exchanges. VWAP-weighted fills reflect real market microstructure, not theoretical mid-prices.',
  },
  {
    icon: '⛊',
    title: 'Institutional Risk Model',
    desc: 'Pre-funded bilateral architecture eliminates settlement risk. Circuit breakers, daily loss limits and per-exchange exposure caps operate independently.',
  },
  {
    icon: '◈',
    title: 'Observable by Design',
    desc: 'Every subsystem emits structured events. Rejected opportunities, partial fills, rebalance triggers and latency outliers are all captured and surfaced.',
  },
];

const STACK = [
  { layer: 'Data Ingestion',    tech: 'Native WebSockets',     detail: '5 exchanges · L2 order books · < 5ms feed latency' },
  { layer: 'Detection Engine',  tech: 'Node.js event loop',    detail: 'O(n²) bilateral · VWAP L2 · < 30ms detection' },
  { layer: 'Scoring Model',     tech: 'Pluggable ML pipeline', detail: 'Profit · Liquidity · Persistence · Latency · Confidence' },
  { layer: 'Risk Controls',     tech: 'Multi-layer guards',    detail: 'Circuit breaker · Daily stop · Per-exchange exposure' },
  { layer: 'State Machine',     tech: 'Deterministic FSM',     detail: '12 states · Partial fills · Rollback · Emergency exit' },
  { layer: 'Persistence',       tech: 'MongoDB Atlas',         detail: 'Trade journal · Daily stats · Replay snapshots' },
  { layer: 'API Layer',         tech: 'Express + SSE',         detail: 'Server-Sent Events · 150ms push cycle · REST endpoints' },
  { layer: 'Frontend',          tech: 'React + Vite',          detail: 'Recharts · Lightweight Charts · Live SSE stream' },
];

const MODULES = [
  { name: 'Arbitrage Engine',       path: '/arbitrage',    desc: 'Live bilateral detection, ML scoring, P&L tracking' },
  { name: 'Arb Backtest',           path: '/arb-backtest', desc: 'Walk-forward analysis, parameter sweep, session replay' },
  { name: 'Advanced Risk Engine',   path: '/risk',         desc: 'VaR, beta, drawdown, circuit breakers, exposure caps' },
  { name: 'StatArb Engine',         path: '/analytics-ta', desc: 'EWMA Z-score, AR(1) half-life, mean-reversion signals' },
  { name: 'Market Regime',          path: '/regime',       desc: 'Trend/range/crisis detection, volatility clustering' },
  { name: 'Monte Carlo Simulator',  path: '/montecarlo',   desc: 'GBM paths, confidence bands, tail risk quantification' },
  { name: 'Predictive Rebalancer',  path: '/dashboard',    desc: 'Depletion forecasting, pre-emptive capital reallocation' },
  { name: 'Observability Service',  path: '/dashboard',    desc: 'Structured event emission, root-cause analysis, watchdog' },
];

const ADR_LINKS = [
  { id: 'ADR-001', title: 'VWAP L2 vs Mid-price', summary: 'Using VWAP-weighted L2 depth instead of theoretical mid-price for fill modeling.' },
  { id: 'ADR-002', title: 'Log-Spread Stationarity', summary: 'Log-spread is preferred over raw spread for stationarity properties in the StatArb engine.' },
  { id: 'ADR-003', title: 'Pre-funded Bilateral Settlement', summary: 'Eliminates settlement latency and counterparty risk at the cost of idle capital.' },
  { id: 'ADR-004', title: 'Event-driven vs Polling', summary: 'Dual-path: WebSocket events for latency-critical detection, 150ms polling as redundancy.' },
];

function TimelineItem({ period, title, desc, last }) {
  return (
    <div style={{ display: 'flex', gap: 20, position: 'relative' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
        <div style={{
          width: 10, height: 10, borderRadius: '50%',
          background: 'var(--color-primary)', border: '2px solid var(--color-primary-glow)',
          flexShrink: 0, marginTop: 4,
        }} />
        {!last && <div style={{ width: 1, flex: 1, background: 'var(--border-bright)', marginTop: 6 }} />}
      </div>
      <div style={{ paddingBottom: last ? 0 : 28 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-primary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>
          {period}
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 5 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>{desc}</div>
      </div>
    </div>
  );
}

function StatusDot({ ok }) {
  return (
    <span style={{
      display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
      background: ok ? 'var(--color-green)' : 'var(--color-red)',
      boxShadow: ok ? '0 0 0 0 rgba(0,184,122,0.4)' : 'none',
      animation: ok ? 'pulseAnim 2s infinite' : 'none',
      flexShrink: 0,
    }} />
  );
}

export default function AboutPage() {
  const { t } = useTranslation();
  const [health, setHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(true);

  useEffect(() => {
    api.system.health()
      .then(d => { setHealth(d); setHealthLoading(false); })
      .catch(() => setHealthLoading(false));
  }, []);

  const uptime = health?.uptime
    ? health.uptime < 60
      ? `${health.uptime}s`
      : health.uptime < 3600
      ? `${Math.floor(health.uptime / 60)}m ${health.uptime % 60}s`
      : `${Math.floor(health.uptime / 3600)}h ${Math.floor((health.uptime % 3600) / 60)}m`
    : null;

  return (
    <div className="page-enter" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <div style={{
        padding: '52px 52px',
        background: 'var(--brand-gradient)',
        borderRadius: 'var(--radius-xl)',
        color: '#fff',
        position: 'relative',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-lg)',
      }}>
        <div style={{ position: 'absolute', top: -60, right: -60, width: 320, height: 320, background: 'rgba(255,255,255,0.06)', borderRadius: '50%' }} />
        <div style={{ position: 'absolute', bottom: -80, right: 100, width: 240, height: 240, background: 'rgba(255,255,255,0.03)', borderRadius: '50%' }} />
        <div style={{ position: 'absolute', top: 30, right: 220, width: 80, height: 80, background: 'rgba(255,255,255,0.05)', borderRadius: '50%' }} />

        <div style={{ position: 'relative' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', opacity: 0.75, textTransform: 'uppercase', marginBottom: 16 }}>
            Platform · v2.0 · Paper Trading
          </div>
          <h1 style={{ margin: 0, fontSize: 48, fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1 }}>
            {t('about.title')}
          </h1>
          <p style={{ margin: '16px 0 0', fontSize: 17, opacity: 0.88, fontWeight: 400, maxWidth: 580, lineHeight: 1.6 }}>
            {t('about.subtitle')}
          </p>

          <div style={{ display: 'flex', gap: 12, marginTop: 32, flexWrap: 'wrap' }}>
            {[
              { label: '5 Exchanges', sub: 'Live WebSocket feeds' },
              { label: '< 30ms', sub: 'Detection latency' },
              { label: 'Pre-funded', sub: 'Bilateral settlement' },
              { label: 'Paper Trading', sub: 'Real prices · Sim fills' },
            ].map(b => (
              <div key={b.label} style={{
                background: 'rgba(255,255,255,0.14)',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: 10, padding: '10px 18px',
              }}>
                <div style={{ fontSize: 14, fontWeight: 800 }}>{b.label}</div>
                <div style={{ fontSize: 10, opacity: 0.75, marginTop: 2 }}>{b.sub}</div>
              </div>
            ))}
            {!healthLoading && (
              <div style={{
                background: health ? 'rgba(0,184,122,0.2)' : 'rgba(240,62,62,0.2)',
                border: `1px solid ${health ? 'rgba(0,184,122,0.4)' : 'rgba(240,62,62,0.4)'}`,
                borderRadius: 10, padding: '10px 18px',
              }}>
                <div style={{ fontSize: 14, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 7 }}>
                  <StatusDot ok={!!health} />
                  {health ? t('about.systemOnline') : t('about.systemOffline')}
                </div>
                <div style={{ fontSize: 10, opacity: 0.75, marginTop: 2 }}>
                  {health
                    ? health.db?.connected
                      ? `DB connected · ${uptime ? `up ${uptime}` : 'running'}`
                      : `In-memory mode · ${uptime ? `up ${uptime}` : 'running'}`
                    : 'API unreachable'}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Live System Health ─────────────────────────────────────────────── */}
      {health && (
        <div className="card" style={{ padding: '20px 24px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 16 }}>
            {t('about.liveSystemStatus')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 16 }}>
            {[
              { label: 'Service', value: health.service || 'kukora-api', mono: false },
              { label: 'Version', value: `v${health.version || '2.0.0'}`, mono: true },
              { label: 'Environment', value: health.env || '—', mono: false },
              { label: 'Uptime', value: uptime || '—', mono: true },
              { label: 'Heap Used', value: health.memory ? `${health.memory.heapUsedMb} MB` : '—', mono: true },
              { label: 'Database', value: health.db?.connected ? `Connected · ${health.db.latencyMs ?? '?'}ms` : 'In-memory', mono: true },
            ].map(m => (
              <div key={m.label}>
                <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 5 }}>{m.label}</div>
                <div style={{ fontSize: 13, fontWeight: 700, fontFamily: m.mono ? 'var(--font-mono)' : 'var(--font-ui)', color: 'var(--text)' }}>{m.value}</div>
              </div>
            ))}
          </div>
          {health.engine && (
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)', display: 'flex', gap: 32, flexWrap: 'wrap' }}>
              {[
                { label: 'Engine', value: health.engine.running ? 'Running' : 'Stopped', ok: health.engine.running },
                { label: 'Opportunities', value: (health.engine.opportunitiesDetected ?? 0).toLocaleString() },
                { label: 'Trades Executed', value: (health.engine.tradesExecuted ?? 0).toLocaleString() },
                { label: 'Daily P&L', value: health.engine.dailyPnl != null ? `$${Number(health.engine.dailyPnl).toFixed(2)}` : '—' },
              ].map(m => (
                <div key={m.label}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>{m.label}</div>
                  <div style={{
                    fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)',
                    color: m.ok === true ? 'var(--color-green)' : m.ok === false ? 'var(--color-red)' : 'var(--text)',
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}>
                    {m.ok != null && <StatusDot ok={m.ok} />}
                    {m.value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Design Principles ─────────────────────────────────────────────── */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 14 }}>
          {t('about.designPrinciples')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
          {PRINCIPLES.map(p => (
            <div key={p.title} className="card" style={{ padding: '20px 18px' }}>
              <div style={{ fontSize: 22, marginBottom: 10, color: 'var(--color-primary)' }}>{p.icon}</div>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 7 }}>{p.title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>{p.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Timeline + Stack ───────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <div className="card">
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 20 }}>
            {t('about.developmentTimeline')}
          </div>
          <div>
            {TIMELINE.map((t, i) => (
              <TimelineItem key={t.period} {...t} last={i === TIMELINE.length - 1} />
            ))}
          </div>
        </div>

        <div className="card">
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 20 }}>
            {t('about.technicalArchitecture')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {STACK.map((s, i) => (
              <div key={s.layer} style={{
                display: 'grid', gridTemplateColumns: '120px 140px 1fr',
                gap: 12, padding: '10px 0',
                borderBottom: i < STACK.length - 1 ? '1px solid var(--border)' : 'none',
                alignItems: 'start',
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', paddingTop: 1 }}>
                  {s.layer}
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{s.tech}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{s.detail}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Platform Modules ──────────────────────────────────────────────── */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 14 }}>
          {t('about.platformModules')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {MODULES.map(m => (
            <a key={m.name} href={m.path} style={{ textDecoration: 'none' }}>
              <div className="card" style={{ padding: '16px 18px', cursor: 'pointer', height: '100%' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>{m.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{m.desc}</div>
              </div>
            </a>
          ))}
        </div>
      </div>

      {/* ── Architecture Decision Records ─────────────────────────────────── */}
      <div className="card">
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 16 }}>
          {t('about.architectureDecisions')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          {ADR_LINKS.map(adr => (
            <div key={adr.id} style={{
              padding: '14px 16px',
              background: 'var(--bg-surface-3)',
              borderRadius: 10,
              border: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 6 }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
                  color: 'var(--color-primary)', background: 'var(--color-primary-dim)',
                  padding: '2px 7px', borderRadius: 5,
                }}>{adr.id}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{adr.title}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{adr.summary}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 14, fontSize: 11, color: 'var(--text-dim)' }}>
          Full ADR documents available in <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-surface-3)', padding: '1px 6px', borderRadius: 4 }}>docs/</code> directory.
          See <a href="/docs" style={{ color: 'var(--color-primary)' }}>Documentation</a> for inline rendering.
        </div>
      </div>

      {/* ── Lead Engineer + Contact ───────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 24 }}>
        <div className="card">
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 16 }}>
            {t('about.leadEngineer')}
          </div>
          <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
            {/* m-6 fix: personal avatar removed from repo — use initials placeholder */}
            <div
              style={{
                width: 72, height: 72, borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary, #7c3aed))',
                border: '2px solid var(--border-bright)', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 24, fontWeight: 700, color: '#fff', letterSpacing: 1,
              }}
              aria-label="Avatar"
            >
              <img
                  src="/avatar.jpg"
                  alt="Gabriel G.Z."
                  style={{
                    width: 71, height: 71, borderRadius: '50%',
                    objectFit: 'cover',
                    objectPosition: 'center top',
                    border: '4px solid rgba(255,255,255,0.4)',
                    flexShrink: 0
                  }}
                />
            </div>
            <div>
              <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 4 }}>Gabriel G. Z.</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.6 }}>
                Mechatronics Engineer — Full-stack platform architecture,
                execution engine design, risk model implementation and market microstructure.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {['Hecho ❤️ en MEXICO'].map(tag => (
                  <span key={tag} style={{
                    background: 'var(--bg-surface-3)', border: '1px solid var(--border-bright)',
                    borderRadius: 6, padding: '3px 9px', fontSize: 11, fontWeight: 600,
                  }}>{tag}</span>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card" style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 14 }}>
              {t('about.contact')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <a href="mailto:gabrielgarziaz@gmail.com"
                style={{ fontSize: 12, color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                gabrielgarziaz@gmail.com
              </a>
              <a href="https://www.linkedin.com/in/gabrielgarzia/" target="_blank" rel="noopener noreferrer"
                style={{ fontSize: 12, color: 'var(--text-muted)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg>
                linkedin.com/in/gabrielgarzia
              </a>
              <a href="https://github.com/GabrielGZ8" target="_blank" rel="noopener noreferrer"
                style={{ fontSize: 12, color: 'var(--text-muted)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
                github.com/GabrielGZ8
              </a>
            </div>
          </div>

          <div className="card" style={{ borderLeft: '3px solid var(--color-primary)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>
              {t('about.systemStatus')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              {t('about.statusFeeds')}



            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
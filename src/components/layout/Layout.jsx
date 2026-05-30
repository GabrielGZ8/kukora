import { useState, useEffect, useCallback, useRef } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import LiveAnomalyBanner from '../common/LiveAnomalyBanner';
import Onboarding from '../common/Onboarding';
import { useOnboarding } from '../../hooks/useOnboarding';
import { TooltipHint } from '../common/TooltipHint';
import { useAlertMonitor } from '../../hooks/useAlertMonitor';


// ─── Nav SVG Icons ───────────────────────────────────────────────────────
const NavIcons = {
  arbitrage: <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>,
  dashboard: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>,
  docs:      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
  alerts:    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
  portfolio: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>,
  watchlist: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
  markets:   <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>,
  analyze:   <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>,
  compare:   <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
  risk:      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  forecast:  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>,
  intel:     <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>,
  analytics: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="12" width="4" height="9"/><rect x="10" y="7" width="4" height="14"/><rect x="17" y="3" width="4" height="18"/></svg>,
  regime:    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>,
  heatmap:   <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>,
  galaxy:    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="2"/><path d="M12 2a10 10 0 0 1 7.39 16.74"/><path d="M12 22A10 10 0 0 1 4.61 5.26"/><path d="M12 8a4 4 0 0 1 0 8"/><path d="M12 16a4 4 0 0 1 0-8"/></svg>,
  montecarlo:<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="m7 16 4-8 4 8"/><path d="m9 12 6 0"/></svg>,
  backtest:  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.43"/></svg>,
};

const NAV = [
  // ─── Core (siempre visible) ───────────────────────────────────────────
  { path: '/arbitrage',    label: 'Arbitrage Bot',        icon: NavIcons.arbitrage, group: 'core',     badge: 'LIVE', tip: 'Sistema de arbitraje multi-exchange en tiempo real' },
  { path: '/dashboard',    label: 'Dashboard',            icon: NavIcons.dashboard, group: 'core' },
  { path: '/docs',         label: 'Documentación',        icon: NavIcons.docs, group: 'core',     tip: 'Fórmulas, scoring, arquitectura y modelos matemáticos' },
  // ─── Herramientas (siempre visible) ─────────────────────────────────
  { path: '/alerts',       label: 'Alerts',               icon: NavIcons.alerts, group: 'tools' },
  { path: '/portfolio',    label: 'Portfolio',            icon: NavIcons.portfolio, group: 'tools' },
  { path: '/watchlist',    label: 'Watchlist',            icon: NavIcons.watchlist, group: 'tools' },
  { path: '/markets',      label: 'Markets',              icon: NavIcons.markets, group: 'tools' },
  // ─── Avanzado (análisis cuantitativo) ───────────────────────────────
  { path: '/analyze',      label: 'Dataset Analyzer',     icon: NavIcons.analyze,    group: 'advanced', badge: '↑CSV', tip: 'Sube cualquier CSV de precios y ejecuta el stack cuantitativo completo' },
  { path: '/compare',      label: 'Comparar Activos',     icon: NavIcons.compare,    group: 'advanced', tip: 'Compara hasta 4 activos: retornos normalizados, Sharpe, drawdown' },
  { path: '/risk',         label: 'Risk Engine',          icon: NavIcons.risk,       group: 'advanced', tip: 'VaR histórico, Beta, Sharpe y métricas de riesgo' },
  { path: '/intelligence', label: 'Intelligence',         icon: NavIcons.intel,      group: 'advanced', tip: 'Scoring multi-factor y detección de oportunidades' },
  { path: '/analytics',    label: 'Analytics',            icon: NavIcons.analytics,  group: 'advanced', tip: 'Análisis técnico avanzado con indicadores' },
  { path: '/heatmap',      label: 'Heatmap',              icon: NavIcons.heatmap,    group: 'advanced' },
  // ─── Módulos de investigación cuantitativa (experimentales) ──────────
  { path: '/forecast',     label: 'Forecast',             icon: NavIcons.forecast,   group: 'research', tip: 'Proyecciones de precio con intervalos de confianza' },
  { path: '/regime',       label: 'Market Regime',        icon: NavIcons.regime,     group: 'research', badge: 'AI',   tip: 'Detección de régimen de mercado (tendencia/rango/crisis)' },
  { path: '/galaxy',       label: 'Correlation Galaxy',   icon: NavIcons.galaxy,     group: 'research', badge: 'LIVE', tip: 'Red animada de correlaciones entre activos' },
  { path: '/montecarlo',   label: 'Monte Carlo',          icon: NavIcons.montecarlo, group: 'research', tip: 'Simulación GBM con miles de trayectorias de precio' },
  { path: '/backtest',     label: 'Backtest',             icon: NavIcons.backtest,   group: 'research', tip: 'Prueba estrategias sobre datos históricos' },
];

const GROUP_LABELS = {
  core:     'Principal',
  tools:    'Herramientas',
  advanced: 'Análisis Cuantitativo',
  research: '🔬 Investigación',
};

// ─── Altura compartida logo/topbar — debe ser idéntica ───────────────────
const HEADER_H = 56;

// ─── BirdsAnimation ─────────────────────────────────────────────────────
// Pájaros SVG animados: grupos naturales (3-4, 1, 2-3, 1...) según mercado
// Total 14 slots: bullish=14, neutral=9, bearish=5
const TOTAL_BIRDS = 14;

// Grupos escalonados: cada grupo arranca en X diferente y viaja junto
// bullish: 3+4+3+2+1+1  neutral: 3+1+3+1+1  bearish: 1+3+1
const GROUPS = {
  bullish: [
    { size: 3, xBase: -40,   yBase: 14, spread: 16 },
    { size: 4, xBase: -240,  yBase: 22, spread: 20 },
    { size: 3, xBase: -480,  yBase: 10, spread: 14 },
    { size: 2, xBase: -660,  yBase: 30, spread: 12 },
    { size: 1, xBase: -820,  yBase: 18, spread: 0  },
    { size: 1, xBase: -1000, yBase: 28, spread: 0  },
  ],
  neutral: [
    { size: 3, xBase: -60,  yBase: 16, spread: 16 },
    { size: 1, xBase: -280, yBase: 26, spread: 0  },
    { size: 3, xBase: -500, yBase: 12, spread: 14 },
    { size: 1, xBase: -720, yBase: 32, spread: 0  },
    { size: 1, xBase: -900, yBase: 20, spread: 0  },
  ],
  bearish: [
    { size: 1, xBase: -80,  yBase: 28, spread: 0  },
    { size: 3, xBase: -320, yBase: 20, spread: 12 },
    { size: 1, xBase: -600, yBase: 34, spread: 0  },
  ],
};

function birdPath(wing) {
  const up = wing * 8;
  return `M 0,0 Q -11,${-up - 3} -20,${-up + 3}`;
}
function birdPathRight(wing) {
  const up = wing * 8;
  return `M 0,0 Q 11,${-up - 3} 20,${-up + 3}`;
}

function initBirds(trend, speedMult) {
  const groups = GROUPS[trend] || GROUPS.neutral;
  const birds = [];
  groups.forEach((g, gi) => {
    for (let k = 0; k < g.size; k++) {
      // Within a group, birds are offset slightly in X and Y
      const xOff = k * (g.spread * 0.6) * (Math.random() * 0.4 + 0.8);
      const yOff = k * (g.spread * 0.4) * (Math.random() * 0.6 - 0.3);
      birds.push({
        id: birds.length,
        x: g.xBase - xOff,
        y: g.yBase + yOff + (Math.random() - 0.5) * 4,
        groupSpeed: (0.45 + Math.random() * 0.2) * speedMult,
        // Birds in same group move at nearly same speed
        speed: (0.45 + Math.random() * 0.2 + gi * 0.04) * speedMult,
        scale: 0.52 + Math.random() * 0.32,
        wingPhase: Math.random() * Math.PI * 2,
        wingSpeed: 1.1 + Math.random() * 0.6,
        yDrift: (Math.random() - 0.5) * 0.10,
        groupId: gi,
      });
    }
  });
  // Pad to TOTAL_BIRDS with inactive
  while (birds.length < TOTAL_BIRDS) {
    birds.push({ id: birds.length, x: -9999, y: 0, speed: 0, scale: 0, wingPhase: 0, wingSpeed: 1, yDrift: 0, inactive: true });
  }
  return birds;
}

function BirdsAnimation({ marketTrend = 'neutral' }) {
  const svgRef = useRef(null);
  const birds  = useRef([]);

  const cfgMap = {
    bullish: { speedMult: 1.35, opacity: 0.62 },
    bearish: { speedMult: 0.68, opacity: 0.44 },
    neutral: { speedMult: 1.00, opacity: 0.56 },
  };
  const cfg = cfgMap[marketTrend] || cfgMap.neutral;

  useEffect(() => {
    birds.current = initBirds(marketTrend, cfg.speedMult);
  }, [marketTrend]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    let raf, t = 0;

    const getW = () => svg.getBoundingClientRect().width || 1000;

    const tick = () => {
      t++;
      const W = getW();
      birds.current.forEach((b) => {
        if (b.inactive) return;
        b.x += b.speed;
        b.y += b.yDrift;
        if (b.y < 5)  { b.y = 5;  b.yDrift =  Math.abs(b.yDrift); }
        if (b.y > 46) { b.y = 46; b.yDrift = -Math.abs(b.yDrift); }
        if (b.x > W + 80) {
          b.x = -80 - Math.random() * 120;
          b.y = 8 + Math.random() * 34;
          b.yDrift = (Math.random() - 0.5) * 0.10;
        }

        const wing = Math.sin(t * b.wingSpeed * 0.07 + b.wingPhase);
        const el = svg.querySelector(`#brd-${b.id}`);
        if (!el) return;

        el.setAttribute('transform',
          `translate(${b.x.toFixed(1)},${b.y.toFixed(1)}) scale(${b.scale.toFixed(2)})`
        );
        el.querySelector('.lw')?.setAttribute('d', birdPath(wing));
        el.querySelector('.rw')?.setAttribute('d', birdPathRight(wing));
      });
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [marketTrend]);

  return (
    <svg
      ref={svgRef}
      style={{
        position: 'absolute', left: 0, top: 0,
        width: '100%', height: '100%',
        pointerEvents: 'none', overflow: 'hidden',
      }}
      aria-hidden="true"
    >
      {Array.from({ length: TOTAL_BIRDS }, (_, i) => (
        <g
          key={i}
          id={`brd-${i}`}
          style={{ opacity: cfg.opacity, transition: 'opacity 0.6s' }}
        >
          <circle cx={0} cy={0} r={2.0} fill="#6b7280" />
          <path className="lw" d={birdPath(0)} fill="none" stroke="#6b7280" strokeWidth={2.6} strokeLinecap="round" />
          <path className="rw" d={birdPathRight(0)} fill="none" stroke="#6b7280" strokeWidth={2.6} strokeLinecap="round" />
        </g>
      ))}
    </svg>
  );
}

export default function Layout() {
  const [open, setOpen]       = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [time, setTime]       = useState('');
  const [lastUpdate, setLastUpdate] = useState(null);
  const [marketTrend, setMkt] = useState('neutral');
  const location              = useLocation();
  const navigate              = useNavigate();
  const onboarding            = useOnboarding();
  useAlertMonitor(); // global alert monitoring — runs regardless of active page
  const currentNav            = NAV.find(n => location.pathname.startsWith(n.path));
  const page                  = currentNav?.label || '';

  // Clock
  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setTime(now.toLocaleTimeString('es-MX', { hour12: false }));
      if (!lastUpdate || now - lastUpdate > 30000) setLastUpdate(now);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Detect market trend for bird animation
  useEffect(() => {
    let cancelled = false;
    fetch('/api/crypto/markets?limit=20')
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => {
        if (cancelled) return;
        const coins = d?.data?.coins || d?.coins || [];
        if (!coins.length) return;
        const avg = coins.reduce((a, c) => a + (c.price_change_percentage_24h || 0), 0) / coins.length;
        setMkt(avg > 1.5 ? 'bullish' : avg < -1.5 ? 'bearish' : 'neutral');
      })
      .catch(() => {}); // silently keep 'neutral' on any error
    return () => { cancelled = true; };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handle = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if (e.key === '?') { e.preventDefault(); onboarding.open(); }
      if (e.key === '[') setOpen(o => !o);
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [onboarding]);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-base)' }}>

      {/* ── Sidebar ───────────────────────────────────────────────────── */}
      <aside style={{
        width: 'var(--sidebar-width)',
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        position: 'fixed', top: 0, left: 0, height: '100vh', zIndex: 100,
        transform: open ? 'translateX(0)' : 'translateX(-224px)',
        transition: 'transform 0.2s ease',
        boxShadow: '2px 0 16px rgba(0,0,0,0.06)',
      }}>

        {/* ── Logo area — misma altura exacta que el topbar ─────────── */}
        <div style={{
          height: HEADER_H,
          display: 'flex', alignItems: 'center',
          padding: '0 16px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          gap: 10,
        }}>
          <img
            src="/favicon.png"
            alt="kukora"
            style={{ width: 30, height: 30, borderRadius: 7, objectFit: 'contain', flexShrink: 0 }}
            onError={e => { e.target.style.display = 'none'; }}
          />
          <div style={{ minWidth: 0 }}>
            {/* Nombre con degradado platino */}
            <div style={{
              fontSize: 18, fontWeight: 900, letterSpacing: '-0.5px',
              lineHeight: 1.1,
              background: 'var(--brand-gradient)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}>
              kukora
            </div>
            <div style={{
              fontSize: 9, color: 'var(--text-dim)',
              fontWeight: 600, letterSpacing: '0.08em',
              textTransform: 'uppercase', lineHeight: 1, marginTop: 2,
            }}>
              Quantitative Crypto
            </div>
          </div>
        </div>

        <nav style={{ flex: 1, padding: '6px 8px', overflowY: 'auto', overflowX: 'hidden' }}>
          {['core', 'tools', 'advanced'].map(group => {
            const items = NAV.filter(n => n.group === group);
            const isAdvanced = group === 'advanced';
            const isGroupActive = items.some(n => location.pathname.startsWith(n.path));
            // Auto-open advanced if current page is in it
            const showItems = isAdvanced ? (advancedOpen || isGroupActive) : true;

            return (
              <div key={group} style={{ marginBottom: 2 }}>
                <div
                  onClick={isAdvanced ? () => setAdvancedOpen(o => !o) : undefined}
                  style={{
                    fontSize: 9, fontWeight: 800, color: 'var(--text-dim)',
                    letterSpacing: '0.10em', textTransform: 'uppercase',
                    padding: '10px 10px 4px', userSelect: 'none',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    cursor: isAdvanced ? 'pointer' : 'default',
                  }}
                >
                  <span>{GROUP_LABELS[group]}</span>
                  {isAdvanced && (
                    <span style={{ fontSize: 9, transition: 'transform 0.2s', display: 'inline-block', transform: showItems ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                      ›
                    </span>
                  )}
                </div>
                {showItems && items.map(item => {
                  const link = (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      style={({ isActive }) => ({
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '7px 10px', borderRadius: 8,
                        fontSize: 12.5, fontWeight: isActive ? 700 : 500,
                        color: isActive ? 'var(--color-primary)' : 'var(--text-muted)',
                        background: isActive ? 'var(--color-primary-dim)' : 'transparent',
                        border: isActive ? '1px solid rgba(255,45,120,0.15)' : '1px solid transparent',
                        textDecoration: 'none',
                        transition: 'all 0.13s ease',
                        marginBottom: 1, minWidth: 0,
                        outline: 'none',
                      })}
                      onMouseEnter={e => {
                        if (!e.currentTarget.getAttribute('aria-current')) {
                          e.currentTarget.style.background = 'var(--bg-surface-2)';
                          e.currentTarget.style.color = 'var(--text)';
                        }
                      }}
                      onMouseLeave={e => {
                        if (!e.currentTarget.getAttribute('aria-current')) {
                          e.currentTarget.style.background = '';
                          e.currentTarget.style.color = '';
                        }
                      }}
                    >
                      <span style={{ width: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{item.icon}</span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                      {item.badge && (
                        <span style={{
                          fontSize: 8, fontWeight: 800, flexShrink: 0,
                          color: item.badge === 'AI' ? 'var(--color-primary)' : 'var(--color-blue)',
                          background: item.badge === 'AI' ? 'var(--color-primary-dim)' : 'var(--color-blue-dim)',
                          padding: '1px 5px', borderRadius: 4, letterSpacing: '0.04em',
                        }}>
                          {item.badge}
                        </span>
                      )}
                    </NavLink>
                  );

                  return item.tip ? (
                    <TooltipHint key={item.path} text={item.tip} position="right">
                      {link}
                    </TooltipHint>
                  ) : link;
                })}
              </div>
            );
          })}
        </nav>

        {/* Bottom: live clock + help */}
        <div style={{ padding: '8px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 10px', fontSize: 11, color: 'var(--text-muted)',
            background: 'var(--bg-surface-2)', borderRadius: 8, marginBottom: 6,
          }}>
            <div className="pulse-dot" />
            <span style={{ fontWeight: 600, flex: 1 }}>Live · {time}</span>
          </div>
          <button
            onClick={onboarding.open}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 10px', fontSize: 11, color: 'var(--text-dim)',
              background: 'none', border: 'none', borderRadius: 8,
              cursor: 'pointer', fontFamily: 'var(--font-ui)', fontWeight: 500,
              transition: 'all 0.13s', textAlign: 'left',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface-2)'; e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-dim)'; }}
          >
            <span style={{ fontSize: 12 }}>?</span>
            <span>Guía de usuario</span>
            <kbd style={{
              marginLeft: 'auto', fontSize: 9, fontWeight: 700,
              background: 'var(--bg-surface-3)', border: '1px solid var(--border)',
              borderRadius: 4, padding: '1px 5px', fontFamily: 'var(--font-mono)',
              color: 'var(--text-dim)',
            }}>?</kbd>
          </button>
        </div>
      </aside>

      {/* ── Main ──────────────────────────────────────────────────────── */}
      <main style={{
        flex: 1,
        marginLeft: open ? 'var(--sidebar-width)' : 0,
        transition: 'margin-left 0.2s ease',
        display: 'flex', flexDirection: 'column', minHeight: '100vh',
      }}>

        {/* ── Topbar — misma altura exacta que el logo del sidebar ───── */}
        <header style={{
          height: HEADER_H,
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 20px',
          position: 'sticky', top: 0, zIndex: 50,
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
          flexShrink: 0,
          gap: 12,
          overflow: 'hidden', // para contener la animación
        }}>
          {/* Pájaros animados — capa decorativa de fondo */}
          <BirdsAnimation marketTrend={marketTrend} />

          {/* Left — sobre los pájaros */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1, position: 'relative', zIndex: 1 }}>
            <button
              onClick={() => setOpen(o => !o)}
              title="Colapsar sidebar [[]"
              style={{
                background: 'none', border: 'none',
                color: 'var(--text-muted)', fontSize: 17,
                padding: '4px 6px', borderRadius: 6,
                cursor: 'pointer', lineHeight: 1, flexShrink: 0,
                transition: 'all 0.13s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface-2)'; e.currentTarget.style.color = 'var(--text)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-muted)'; }}
            >
              ☰
            </button>

            <span style={{ color: 'var(--border-bright)', fontSize: 16, flexShrink: 0, userSelect: 'none' }}>›</span>

            <span style={{
              fontSize: 13, fontWeight: 700, color: 'var(--text)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {page}
            </span>

            {currentNav?.badge && (
              <span style={{
                fontSize: 8, fontWeight: 800, flexShrink: 0,
                textTransform: 'uppercase', letterSpacing: '0.06em',
                color: currentNav.badge === 'AI' ? 'var(--color-primary)' : 'var(--color-blue)',
                background: currentNav.badge === 'AI' ? 'var(--color-primary-dim)' : 'var(--color-blue-dim)',
                padding: '2px 7px', borderRadius: 99,
              }}>
                {currentNav.badge}
              </span>
            )}
          </div>

          {/* Right */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, position: 'relative', zIndex: 1 }}>
            {/* Market trend indicator sutil */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                color: marketTrend === 'bullish' ? 'var(--color-green)' : marketTrend === 'bearish' ? 'var(--color-red)' : 'var(--text-dim)',
                opacity: 0.7,
              }}>
                {marketTrend === 'bullish' ? '▲' : marketTrend === 'bearish' ? '▼' : '—'}
              </span>
            </div>

            {lastUpdate && (
              <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                ↺ {lastUpdate.toLocaleTimeString('es-MX', { hour12: false, hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div className="pulse-dot" />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>CoinGecko</span>
            </div>

            <div style={{ width: 1, height: 18, background: 'var(--border)' }} />

            <button
              onClick={onboarding.open}
              title="Abrir guía de usuario"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, borderRadius: 8,
                background: 'var(--bg-surface-2)',
                border: '1px solid var(--border)',
                color: 'var(--text-muted)', fontSize: 12, fontWeight: 700,
                cursor: 'pointer', transition: 'all 0.13s',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.color = 'var(--color-primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
            >
              ?
            </button>
          </div>
        </header>

        {/* Page content */}
        <div style={{ flex: 1, padding: '24px', maxWidth: 1440, width: '100%', margin: '0 auto' }}>
          <Outlet />
        </div>
      </main>

      <LiveAnomalyBanner />
      <Onboarding
        show={onboarding.show}
        step={onboarding.step}
        setStep={onboarding.setStep}
        onDismiss={onboarding.dismiss}
      />
    </div>
  );
}

// ─── Onboarding.jsx v3 — Mapa completo del sistema kukora ──────────────────
// Cubre: arbitrage bot, análisis cuantitativo, herramientas y módulos de investigación.
// Tono: directo, técnico, orientado al jurado del hackathon.

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const PINK   = '#FF2D78';
const INDIGO = '#5741D9';
const GREEN  = '#00b87a';
const AMBER  = '#F59E0B';
const BLUE   = '#3b82f6';
const PURPLE = '#8b5cf6';

const STEPS = [
  // ── 0: ¿Qué es kukora? ──────────────────────────────────────────────────
  {
    id: 'what',
    emoji: '⚡',
    title: 'Kukora — Bot de arbitraje BTC en tiempo real',
    subtitle: '5 exchanges · detección < 30ms · ejecución simulada completa',
    description: 'Kukora monitorea simultáneamente Binance, Kraken, Bybit, OKX y Coinbase vía WebSockets. Cuando detecta que el Ask de un exchange es menor que el Bid de otro, calcula la ganancia neta real (fees + slippage + liquidez) y ejecuta la operación simulada en milisegundos.',
    visual: 'arb_diagram',
    action: 'Ver la arquitectura →',
    skip: 'Ir al bot directamente',
    color: PINK,
  },

  // ── 1: Arquitectura técnica ──────────────────────────────────────────────
  {
    id: 'architecture',
    emoji: '🔗',
    title: 'Arquitectura event-driven de alta frecuencia',
    subtitle: 'WebSockets → detección → scoring → ejecución → wallet update',
    steps: [
      { icon: '📡', label: 'WebSocket feeds', desc: 'Binance bookTicker+depth5@100ms · Kraken book v2 · Bybit tickers+orderbook.50 · OKX books5 · Coinbase ticker. Watchdog reconecta automáticamente si un feed se congela >5s.' },
      { icon: '🔍', label: 'Detección de spread', desc: 'Evalúa los 20 pares posibles entre los 5 exchanges en <1ms. Spread neto = gross – taker fees – slippage VWAP real del L2 – withdrawal fee amortizado.' },
      { icon: '🛡️', label: 'Circuit breakers', desc: 'Spread < 0.005% → ruido de mercado. Spread > 3% → dato obsoleto. Daily loss > $500 → bot pausado. Liquidez < 50% del volumen → orden parcial.' },
      { icon: '✅', label: 'Ejecución & wallets', desc: 'Score ≥ 10 + net > $0.05 + fingerprint único (5s TTL) → ejecuta. Wallets se actualizan en ambos exchanges. Equity curve crece en tiempo real.' },
    ],
    action: 'Ver la inteligencia →',
    color: INDIGO,
  },

  // ── 2: Inteligencia avanzada ─────────────────────────────────────────────
  {
    id: 'intelligence',
    emoji: '🧠',
    title: 'Sistema de inteligencia multi-capa',
    subtitle: 'No solo detecta oportunidades — aprende, predice y prioriza',
    features: [
      { icon: '🎯', label: 'Score 0-100',          desc: 'Combina profit%, fill probability, latencia, spread persistence y calidad del feed WS.', color: PINK },
      { icon: '📊', label: 'Stat Arb (Z-Score)',   desc: 'Detecta desviaciones estadísticas (Z > 2σ) en el diferencial histórico entre pares.', color: INDIGO },
      { icon: '🔺', label: 'Arbitraje Triangular', desc: 'Señales de 3 legs (A→B→C) con cálculo de netPct > 0.05% antes de auto-ejecución.', color: PURPLE },
      { icon: '📈', label: 'Exchange Ranking',      desc: 'Aprende qué exchanges tienen mejor latencia y confiabilidad para priorizar los pares.', color: GREEN },
      { icon: '🔮', label: 'Predictive Ranking',   desc: 'Predice qué pares tendrán mayor spread en los próximos ticks basado en historial.', color: AMBER },
      { icon: '♻️', label: 'Lifecycle tracking',   desc: 'Ciclo de vida de cada oportunidad: nacimiento, pico de spread, expiración.', color: BLUE },
    ],
    action: 'Ver las pantallas →',
    color: GREEN,
  },

  // ── 3: Pantallas principales (Core) ──────────────────────────────────────
  {
    id: 'screens_core',
    emoji: '🏆',
    title: 'Pantallas principales del bot',
    subtitle: 'Sección "Principal" en el menú lateral',
    tabs: [
      {
        icon: '⚡', label: '/arbitrage — Bot en vivo',
        desc: 'Executive Dashboard + order books en tiempo real + oportunidades detectadas + historial de trades + curva de equity. La pantalla principal para el jurado.',
        path: '/arbitrage', color: PINK,
      },
      {
        icon: '📊', label: '/dashboard — Resumen ejecutivo',
        desc: 'P&L session, win rate, trades ejecutados, exchanges conectados, volatilidad BTC y métricas clave del bot en un solo vistazo.',
        path: '/dashboard', color: INDIGO,
      },
      {
        icon: '📄', label: '/docs — Documentación técnica',
        desc: 'Fórmulas exactas de fee, slippage VWAP, break-even, score 0-100, circuit breakers y arquitectura. Para auditar el sistema matemáticamente.',
        path: '/docs', color: BLUE,
      },
    ],
    action: 'Ver herramientas →',
    color: PINK,
  },

  // ── 4: Herramientas ───────────────────────────────────────────────────────
  {
    id: 'screens_tools',
    emoji: '🛠️',
    title: 'Herramientas de gestión',
    subtitle: 'Sección "Herramientas" en el menú lateral',
    tabs: [
      {
        icon: '🔔', label: '/alerts — Sistema de alertas',
        desc: 'Configura alertas de precio, P&L y spread. Recibe notificaciones en tiempo real vía SSE cuando se disparan las condiciones.',
        path: '/alerts', color: AMBER,
      },
      {
        icon: '💼', label: '/portfolio — Gestión de portafolio',
        desc: 'Registra y monitorea posiciones en múltiples activos. Calcula P&L, distribución de capital y rendimiento histórico.',
        path: '/portfolio', color: GREEN,
      },
      {
        icon: '⭐', label: '/watchlist — Lista de seguimiento',
        desc: 'Sigue tus activos favoritos con precios en tiempo real, variaciones 24h y alertas personalizadas.',
        path: '/watchlist', color: BLUE,
      },
      {
        icon: '📈', label: '/markets — Mercados globales',
        desc: 'Vista de los principales activos cripto: precios, market cap, volumen 24h y variaciones. Datos de CoinGecko.',
        path: '/markets', color: PURPLE,
      },
    ],
    action: 'Ver análisis cuantitativo →',
    color: AMBER,
  },

  // ── 5: Análisis cuantitativo ─────────────────────────────────────────────
  {
    id: 'screens_advanced',
    emoji: '📐',
    title: 'Análisis Cuantitativo',
    subtitle: 'Sección colapsable "Análisis Cuantitativo" en el menú — click para expandir',
    tabs: [
      {
        icon: '📂', label: '/analyze — Dataset Analyzer',
        desc: 'Sube cualquier CSV de precios y ejecuta el stack cuantitativo completo: retornos, VaR, Sharpe, drawdown, correlaciones.',
        path: '/analyze', color: PINK,
      },
      {
        icon: '⚖️', label: '/compare — Comparar Activos',
        desc: 'Compara hasta 4 activos: retornos normalizados, ratio de Sharpe, máximo drawdown, beta y correlación entre ellos.',
        path: '/compare', color: INDIGO,
      },
      {
        icon: '⚠️', label: '/risk — Risk Engine',
        desc: 'VaR histórico, Conditional VaR (CVaR), Beta vs BTC, Sharpe y Sortino. Métricas de riesgo institucionales.',
        path: '/risk', color: AMBER,
      },
      {
        icon: '🧬', label: '/intelligence — Intelligence Panel',
        desc: 'Rankings de exchanges, volatilidad de mercado, lifecycle de oportunidades y predicciones. Feed de inteligencia del bot.',
        path: '/intelligence', color: GREEN,
      },
      {
        icon: '📊', label: '/analytics — Price Analytics',
        desc: 'Gráficos de precio histórico, max/min/avg por periodo, volumen y distribución de retornos por activo.',
        path: '/analytics', color: BLUE,
      },
      {
        icon: '🌡️', label: '/heatmap — Heatmap de Rendimientos',
        desc: 'Mapa de calor de rendimientos por activo y periodo de tiempo. Identifica patrones estacionales y activos calientes.',
        path: '/heatmap', color: PURPLE,
      },
    ],
    action: 'Ver módulos de investigación →',
    color: INDIGO,
  },

  // ── 6: Investigación cuantitativa ────────────────────────────────────────
  {
    id: 'screens_research',
    emoji: '🔬',
    title: 'Módulos de Investigación',
    subtitle: 'Sub-sección "🔬 Investigación" dentro de Análisis Cuantitativo',
    tabs: [
      {
        icon: '📉', label: '/analytics-ta — Análisis Técnico',
        desc: 'RSI, MACD, Bollinger Bands con gráficos de velas TradingView (lightweight-charts). Señales técnicas automáticas.',
        path: '/analytics-ta', color: PINK,
      },
      {
        icon: '🔭', label: '/forecast — Forecast de Precio',
        desc: 'Proyecciones de precio usando regresión + GBM con intervalos de confianza del 80% y 95%. Horizonte 7/30/90 días.',
        path: '/forecast', color: INDIGO,
      },
      {
        icon: '🌀', label: '/regime — Market Regime',
        desc: 'Detección de régimen de mercado: tendencia alcista, tendencia bajista o rango lateral. Usa volatilidad y momentum.',
        path: '/regime', color: AMBER, badge: 'AI',
      },
      {
        icon: '🌐', label: '/galaxy — Correlation Galaxy',
        desc: 'Red animada de correlaciones entre activos cripto. Nodos se acercan cuando los activos están correlacionados.',
        path: '/galaxy', color: BLUE, badge: 'LIVE',
      },
      {
        icon: '🎲', label: '/montecarlo — Monte Carlo',
        desc: 'Simulación GBM con 500+ trayectorias de precio. Calcula distribución de escenarios y probabilidades de retorno.',
        path: '/montecarlo', color: GREEN,
      },
      {
        icon: '⏮️', label: '/backtest — Backtesting',
        desc: 'Prueba estrategias de trading sobre datos históricos. Calcula P&L, drawdown, win rate y métricas de rendimiento.',
        path: '/backtest', color: PURPLE,
      },
    ],
    action: '¡Explorar el bot! →',
    color: PURPLE,
  },
];

// ─── ArbDiagram ─────────────────────────────────────────────────────────────
function ArbDiagram() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0, padding: '16px 0', flexWrap: 'wrap' }}>
      <div style={{ background: 'rgba(240,185,11,0.08)', border: '1px solid rgba(240,185,11,0.3)', borderRadius: 12, padding: '14px 18px', textAlign: 'center', minWidth: 120 }}>
        <div style={{ fontSize: 10, color: '#F0B90B', fontWeight: 800, marginBottom: 6, letterSpacing: '0.08em' }}>BINANCE</div>
        <div style={{ fontSize: 22, fontWeight: 900, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>$70,000</div>
        <div style={{ marginTop: 8, background: '#F0B90B', color: '#000', fontWeight: 800, fontSize: 10, padding: '3px 10px', borderRadius: 99 }}>COMPRAR ↑</div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>fee: $70.00</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 12px' }}>
        <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 2, fontWeight: 700 }}>SPREAD BRUTO</div>
        <div style={{ fontSize: 18, color: PINK, fontWeight: 900, fontFamily: 'var(--font-mono)' }}>+$250</div>
        <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 1 }}>− fees $140.25</div>
        <div style={{ width: 40, height: 2, background: `linear-gradient(90deg,#F0B90B,${PINK})`, margin: '6px 0', borderRadius: 2 }} />
        <div style={{ fontSize: 14, color: GREEN, fontWeight: 900, fontFamily: 'var(--font-mono)' }}>= +$109.75</div>
        <div style={{ fontSize: 9, color: GREEN, marginTop: 1 }}>ganancia neta</div>
      </div>

      <div style={{ background: 'rgba(87,65,217,0.08)', border: '1px solid rgba(87,65,217,0.3)', borderRadius: 12, padding: '14px 18px', textAlign: 'center', minWidth: 120 }}>
        <div style={{ fontSize: 10, color: INDIGO, fontWeight: 800, marginBottom: 6, letterSpacing: '0.08em' }}>KRAKEN</div>
        <div style={{ fontSize: 22, fontWeight: 900, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>$70,250</div>
        <div style={{ marginTop: 8, background: INDIGO, color: '#fff', fontWeight: 800, fontSize: 10, padding: '3px 10px', borderRadius: 99 }}>VENDER ↓</div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>fee: $70.25</div>
      </div>
    </div>
  );
}

// ─── StepDots ────────────────────────────────────────────────────────────────
function StepDots({ total, current, onGoTo }) {
  return (
    <div style={{ display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
      {Array.from({ length: total }).map((_, i) => (
        <button key={i} onClick={() => onGoTo(i)} title={`Paso ${i+1}`} style={{
          width: i === current ? 18 : 7, height: 7, borderRadius: 99, border: 'none', cursor: 'pointer',
          background: i === current ? STEPS[current].color : 'var(--border)',
          transition: 'all 0.25s', padding: 0, flexShrink: 0,
        }} />
      ))}
    </div>
  );
}

// ─── NavPill ─────────────────────────────────────────────────────────────────
function NavPill({ path, color }) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(path)}
      style={{
        fontSize: 10, fontWeight: 700, color, background: `${color}14`,
        border: `1px solid ${color}30`, borderRadius: 6,
        padding: '2px 8px', cursor: 'pointer', fontFamily: 'var(--font-mono)',
        transition: 'all 0.13s', flexShrink: 0,
      }}
      onMouseEnter={e => { e.currentTarget.style.background = `${color}28`; }}
      onMouseLeave={e => { e.currentTarget.style.background = `${color}14`; }}
    >
      {path}
    </button>
  );
}

// ─── Main export ─────────────────────────────────────────────────────────────
export default function Onboarding({ show, step, setStep, onDismiss }) {
  const navigate    = useNavigate();
  const overlayRef  = useRef(null);
  const [animating, setAnimating] = useState(false);
  const s = STEPS[step] || STEPS[0];

  useEffect(() => {
    if (!show) return;
    const handler = (e) => {
      if (e.key === 'Escape') onDismiss();
      if (e.key === 'ArrowRight' && step < STEPS.length - 1) goNext();
      if (e.key === 'ArrowLeft'  && step > 0)                setStep(step - 1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [show, step]);

  const goNext = () => {
    if (step >= STEPS.length - 1) { onDismiss(); navigate('/arbitrage'); return; }
    setAnimating(true);
    setTimeout(() => { setStep(step + 1); setAnimating(false); }, 110);
  };
  const dismiss = () => { onDismiss(); navigate('/arbitrage'); };

  if (!show) return null;

  return (
    <div
      ref={overlayRef}
      onClick={e => { if (e.target === overlayRef.current) dismiss(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)',
        zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
      }}
    >
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 20,
        width: '100%', maxWidth: 660,
        maxHeight: 'calc(100vh - 40px)',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 32px 80px rgba(0,0,0,0.5)',
        overflow: 'hidden',
        opacity: animating ? 0 : 1, transform: animating ? 'translateY(6px)' : 'translateY(0)',
        transition: 'opacity 0.11s, transform 0.11s',
      }}>

        {/* Color bar */}
        <div style={{ height: 4, background: `linear-gradient(90deg, ${s.color}, ${s.color}88)`, flexShrink: 0 }} />

        {/* Header */}
        <div style={{ padding: '22px 28px 0', display: 'flex', alignItems: 'flex-start', gap: 14, flexShrink: 0 }}>
          <div style={{
            width: 46, height: 46, borderRadius: 12, flexShrink: 0,
            background: `${s.color}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
          }}>{s.emoji}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 900, color: 'var(--text)', lineHeight: 1.2, marginBottom: 3 }}>{s.title}</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', fontWeight: 500 }}>{s.subtitle}</div>
          </div>
          <button onClick={dismiss} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: 4, flexShrink: 0 }}>×</button>
        </div>

        {/* Body — scrollable */}
        <div style={{ padding: '18px 28px', flex: 1, overflowY: 'auto' }}>

          {/* 0: what */}
          {s.id === 'what' && (<>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, margin: '0 0 14px' }}>{s.description}</p>
            <ArbDiagram />
            <div style={{ background: 'rgba(0,184,122,0.06)', border: '1px solid rgba(0,184,122,0.2)', borderRadius: 10, padding: '10px 14px', marginTop: 6 }}>
              <div style={{ fontSize: 11, color: GREEN, fontWeight: 800, marginBottom: 3 }}>⚡ Modelo Pre-funded Bilateral</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>Wallets fondadas en los 5 exchanges desde el inicio. Cada trade ejecuta compra y venta simultáneamente — sin transferencias entre exchanges, sin delay de liquidación.</div>
            </div>
          </>)}

          {/* 1: architecture */}
          {s.id === 'architecture' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {s.steps.map((st, i) => (
                <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--bg-surface-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>{st.icon}</div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text)', marginBottom: 2 }}>{st.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{st.desc}</div>
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 6, background: `${INDIGO}09`, border: `1px solid ${INDIGO}25`, borderRadius: 10, padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 16 }}>🎯</span>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  <strong style={{ color: INDIGO }}>Break-even real:</strong> 0.05 BTC a $100k → notional $5,000 → fees ≈$10 → slippage ≈$5 → se necesita spread &gt; 0.03% para ser rentable neto.
                </div>
              </div>
            </div>
          )}

          {/* 2: intelligence */}
          {s.id === 'intelligence' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {s.features.map((f, i) => (
                <div key={i} style={{ background: `${f.color}09`, border: `1px solid ${f.color}25`, borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ fontSize: 18, marginBottom: 6 }}>{f.icon}</div>
                  <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text)', marginBottom: 3 }}>{f.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.45 }}>{f.desc}</div>
                </div>
              ))}
            </div>
          )}

          {/* 3, 4, 5, 6: pantallas con tabs */}
          {['screens_core','screens_tools','screens_advanced','screens_research'].includes(s.id) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {s.tabs.map((t, i) => (
                <div key={i} style={{
                  display: 'flex', gap: 12, alignItems: 'flex-start',
                  background: 'var(--bg-surface-2)', borderRadius: 10,
                  padding: '10px 14px', border: '1px solid var(--border)',
                }}>
                  <span style={{ fontSize: 20, flexShrink: 0, lineHeight: 1, marginTop: 1 }}>{t.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, fontWeight: 800, color: t.color }}>{t.label}</span>
                      {t.badge && (
                        <span style={{ fontSize: 8, fontWeight: 800, color: t.color, background: `${t.color}18`, padding: '1px 5px', borderRadius: 4, letterSpacing: '0.06em' }}>{t.badge}</span>
                      )}
                      {t.path && <NavPill path={t.path} color={t.color} />}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.45 }}>{t.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '0 28px 20px', flexShrink: 0 }}>
          <StepDots total={STEPS.length} current={step} onGoTo={setStep} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
            {step > 0 && (
              <button onClick={() => setStep(step - 1)} style={{
                background: 'var(--bg-surface-2)', border: '1px solid var(--border)',
                color: 'var(--text-muted)', borderRadius: 10, padding: '9px 18px',
                fontWeight: 700, fontSize: 12, cursor: 'pointer',
              }}>
                ← Atrás
              </button>
            )}
            <button onClick={goNext} style={{
              flex: 1, background: `linear-gradient(135deg, ${s.color}, ${s.color}bb)`,
              color: '#fff', border: 'none', borderRadius: 10, padding: '11px 22px',
              fontWeight: 800, fontSize: 13, cursor: 'pointer',
              boxShadow: `0 4px 14px ${s.color}44`,
            }}>
              {s.id === 'screens_research' ? '¡Explorar el bot! →' : s.action}
            </button>
          </div>
          {step === 0 && (
            <button onClick={dismiss} style={{
              display: 'block', width: '100%', marginTop: 8,
              background: 'none', border: 'none', color: 'var(--text-dim)',
              fontSize: 11, cursor: 'pointer', textDecoration: 'underline',
              textDecorationColor: 'var(--border)',
            }}>
              {s.skip}
            </button>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: 'var(--text-dim)', marginTop: 10 }}>
            <span>Paso {step + 1} de {STEPS.length}</span>
            <span>
              <kbd style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 4px', fontSize: 9 }}>←</kbd>
              {' '}<kbd style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 4px', fontSize: 9 }}>→</kbd>
              {' '}navegar · {' '}
              <kbd style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 4px', fontSize: 9 }}>Esc</kbd>
              {' '}cerrar
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

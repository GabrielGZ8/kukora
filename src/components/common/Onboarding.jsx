// ─── Onboarding.jsx — System guided tour ──────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const PINK   = '#FF2D78';
const INDIGO = '#5741D9';
const GREEN  = '#00b87a';
const AMBER  = '#F59E0B';
const BLUE   = '#3b82f6';
const PURPLE = '#8b5cf6';

const STEPS = [
  {
    id: 'what',
    emoji: '⚡',
    title: 'Kukora — Motor de arbitraje BTC en tiempo real',
    subtitle: '5 exchanges · detección < 30ms · ejecución simulada completa',
    description: 'Kukora monitorea simultáneamente Binance, Kraken, Bybit, OKX y Coinbase vía WebSockets nativos. Cuando detecta que el ask en un exchange está por debajo del bid en otro, calcula la ganancia neta real (comisiones + slippage + liquidez) y ejecuta la operación simulada en milisegundos.',
    visual: 'arb_diagram',
    action: 'Ver la arquitectura →',
    skip: 'Ir directo al motor',
    color: PINK,
  },
  {
    id: 'architecture',
    emoji: '🔗',
    title: 'Arquitectura de alta frecuencia orientada a eventos',
    subtitle: 'WebSockets → detección → scoring → ejecución → actualización de wallet',
    steps: [
      { icon: '📡', label: 'Feeds WebSocket', desc: 'Binance bookTicker+depth5@100ms · Kraken book v2 · Bybit tickers+orderbook.50 · OKX books5 · Coinbase ticker. El watchdog reconecta automáticamente si algún feed se congela > 5s.' },
      { icon: '🔍', label: 'Detección de spread', desc: 'Evalúa los 20 pares de exchanges en menos de 1ms. Spread neto = bruto − comisiones taker − slippage VWAP L2 − comisión de retiro amortizada.' },
      { icon: '🛡️', label: 'Circuit breakers', desc: 'Spread < 0.005% → ruido de mercado. Spread > 3% → datos obsoletos. Pérdida diaria > $500 → motor pausado. Liquidez < 50% del volumen → llenado parcial.' },
      { icon: '✅', label: 'Ejecución y wallets', desc: 'Score ≥ 10 + neto > $0.05 + huella única (TTL 5s) → ejecuta. Wallets actualizadas en ambos exchanges. La curva de equity se actualiza en tiempo real.' },
    ],
    action: 'Ver el sistema de inteligencia →',
    color: INDIGO,
  },
  {
    id: 'intelligence',
    emoji: '🧠',
    title: 'Sistema de inteligencia multi-capa',
    subtitle: 'No solo detecta — aprende, predice y prioriza',
    features: [
      { icon: '🎯', label: 'Score 0–100',          desc: 'Combina % de ganancia, probabilidad de llenado, latencia, persistencia del spread y calidad del feed WS.',              color: PINK   },
      { icon: '📊', label: 'Stat Arb (Z-Score)',   desc: 'Detecta desviaciones estadísticas (Z > 2σ) en el diferencial histórico entre pares.',              color: INDIGO },
      { icon: '🔺', label: 'Arbitraje Triangular', desc: 'Rutas de 3 tramos dentro del mismo exchange (A→B→C) con umbral netPct > 0.05% antes de auto-ejecutar.',          color: PURPLE },
      { icon: '📈', label: 'Ranking de Exchanges',  desc: 'Aprende qué exchanges tienen mejor latencia y confiabilidad para priorizar pares.',                    color: GREEN  },
      { icon: '🔮', label: 'Ranking Predictivo',   desc: 'Predice qué pares tendrán mayor spread en los próximos ticks según el historial de la sesión.',           color: AMBER  },
      { icon: '♻️', label: 'Seguimiento de Ciclo de Vida', desc: 'Ciclo de vida completo de la oportunidad: nacimiento, pico de spread, expiración. Curvas de decaimiento por par.',                 color: BLUE   },
    ],
    action: 'Ver las pantallas principales →',
    color: GREEN,
  },
  {
    id: 'screens_core',
    emoji: '🏆',
    title: 'Pantallas principales de arbitraje',
    subtitle: 'Sección "Sistema de Arbitraje" en el menú lateral',
    tabs: [
      { icon: '⚡', label: '/arbitrage — Motor en Vivo',
        desc: 'Panel Ejecutivo + order books en tiempo real + oportunidades detectadas + historial de operaciones + curva de equity. Pantalla operativa principal.',
        path: '/arbitrage', color: PINK },
      { icon: '📊', label: '/dashboard — Resumen Ejecutivo',
        desc: 'P&L de la sesión, win rate, operaciones ejecutadas, exchanges conectados, volatilidad de BTC y métricas clave del motor de un vistazo.',
        path: '/dashboard', color: INDIGO },
      { icon: '📄', label: '/docs — Documentación',
        desc: 'Fórmulas exactas de comisiones, slippage VWAP, punto de equilibrio, scoring 0–100, circuit breakers y arquitectura. Para auditoría matemática del sistema.',
        path: '/docs', color: BLUE },
    ],
    action: 'Ver herramientas operativas →',
    color: PINK,
  },
  {
    id: 'screens_tools',
    emoji: '🛠️',
    title: 'Herramientas operativas',
    subtitle: 'Sección "Herramientas" en el menú lateral',
    tabs: [
      { icon: '🔔', label: '/alerts — Sistema de alertas',
        desc: 'Configura alertas de precio, P&L y spread. Recibe notificaciones en tiempo real vía SSE cuando se cumplen las condiciones.',
        path: '/alerts', color: AMBER },
      { icon: '💼', label: '/portfolio — Gestión de portafolio',
        desc: 'Rastrea y monitorea posiciones en múltiples activos. Calcula P&L, distribución de capital y desempeño histórico.',
        path: '/portfolio', color: GREEN },
      { icon: '⭐', label: '/watchlist — Lista de seguimiento',
        desc: 'Sigue tus activos con precios en tiempo real, cambios de 24h y alertas personalizadas.',
        path: '/watchlist', color: BLUE },
      { icon: '📈', label: '/markets — Mercados globales',
        desc: 'Principales activos cripto: precios, capitalización de mercado, volumen 24h y cambios. Datos vía API de CoinGecko.',
        path: '/markets', color: PURPLE },
    ],
    action: 'Ver análisis cuantitativo →',
    color: AMBER,
  },
  {
    id: 'screens_advanced',
    emoji: '📐',
    title: 'Análisis Cuantitativo',
    subtitle: 'Sección colapsable "Análisis Cuantitativo" en el menú lateral',
    tabs: [
      { icon: '📂', label: '/analyze — Analizador de Dataset',
        desc: 'Sube cualquier CSV de precios y corre el stack cuantitativo completo: retornos, VaR, Sharpe, drawdown, correlaciones.',
        path: '/analyze', color: PINK },
      { icon: '⚖️', label: '/compare — Comparar Activos',
        desc: 'Compara hasta 4 activos: retornos normalizados, ratio de Sharpe, drawdown máximo, beta y correlación cruzada.',
        path: '/compare', color: INDIGO },
      { icon: '⚠️', label: '/risk — Motor de Riesgo',
        desc: 'VaR histórico, VaR Condicional (CVaR), Beta vs BTC, Sharpe y Sortino. Métricas de riesgo institucionales.',
        path: '/risk', color: AMBER },
      { icon: '🧬', label: '/intelligence — Panel de Inteligencia',
        desc: 'Ranking de exchanges, volatilidad de mercado, ciclo de vida de oportunidades y predicciones. Feed de inteligencia del motor.',
        path: '/intelligence', color: GREEN },
      { icon: '📊', label: '/analytics — Analítica de Precios',
        desc: 'Gráficos de precio históricos, máx/mín/prom por período, volumen y distribución de retornos por activo.',
        path: '/analytics', color: BLUE },
      { icon: '🌡️', label: '/heatmap — Mapa de Calor de Desempeño',
        desc: 'Mapa de calor de retornos por activo y período. Identifica patrones estacionales y activos en tendencia.',
        path: '/heatmap', color: PURPLE },
    ],
    action: 'Ver módulos de investigación →',
    color: INDIGO,
  },
  {
    id: 'screens_research',
    emoji: '🔬',
    title: 'Módulos de Investigación',
    subtitle: 'Subsección "🔬 Investigación" dentro de Análisis Cuantitativo',
    tabs: [
      { icon: '📉', label: '/analytics-ta — Análisis Técnico',
        desc: 'RSI, MACD, Bandas de Bollinger con gráficos de velas (lightweight-charts). Señales técnicas automáticas.',
        path: '/analytics-ta', color: PINK },
      { icon: '🔭', label: '/forecast — Pronóstico de Precio',
        desc: 'Proyecciones de precio usando regresión + GBM con intervalos de confianza de 80% y 95%. Horizonte de 7/30/90 días.',
        path: '/forecast', color: INDIGO },
      { icon: '🌀', label: '/regime — Régimen de Mercado',
        desc: 'Detección de régimen de mercado: tendencia alcista, bajista o rango lateral. Usa señales de volatilidad y momentum.',
        path: '/regime', color: AMBER, badge: 'AI' },
      { icon: '🌐', label: '/galaxy — Galaxia de Correlación',
        desc: 'Red de correlación animada entre activos cripto. Los nodos se acercan cuando los activos están correlacionados.',
        path: '/galaxy', color: BLUE, badge: 'LIVE' },
      { icon: '🎲', label: '/montecarlo — Monte Carlo',
        desc: 'Simulación GBM con más de 500 trayectorias de precio. Calcula la distribución de escenarios y probabilidades de retorno.',
        path: '/montecarlo', color: GREEN },
      { icon: '⏮️', label: '/backtest — Backtest de Estrategia',
        desc: 'Prueba estrategias de trading con datos históricos. Calcula P&L, drawdown, win rate y métricas de desempeño.',
        path: '/backtest', color: PURPLE },
    ],
    action: 'Abrir el motor →',
    color: PURPLE,
  },
];

function ArbDiagram() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0, padding: '16px 0', flexWrap: 'wrap' }}>
      <div style={{ background: 'rgba(240,185,11,0.08)', border: '1px solid rgba(240,185,11,0.3)', borderRadius: 12, padding: '14px 18px', textAlign: 'center', minWidth: 120 }}>
        <div style={{ fontSize: 10, color: '#F0B90B', fontWeight: 800, marginBottom: 6, letterSpacing: '0.08em' }}>BINANCE</div>
        <div style={{ fontSize: 22, fontWeight: 900, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>$70,000</div>
        <div style={{ marginTop: 8, background: '#F0B90B', color: '#000', fontWeight: 800, fontSize: 10, padding: '3px 10px', borderRadius: 99 }}>COMPRAR ↑</div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>comisión: $70.00</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 12px' }}>
        <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 2, fontWeight: 700 }}>SPREAD BRUTO</div>
        <div style={{ fontSize: 18, color: PINK, fontWeight: 900, fontFamily: 'var(--font-mono)' }}>+$250</div>
        <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 1 }}>− comisiones $140.25</div>
        <div style={{ width: 40, height: 2, background: `linear-gradient(90deg,#F0B90B,${PINK})`, margin: '6px 0', borderRadius: 2 }} />
        <div style={{ fontSize: 14, color: GREEN, fontWeight: 900, fontFamily: 'var(--font-mono)' }}>= +$109.75</div>
        <div style={{ fontSize: 9, color: GREEN, marginTop: 1 }}>ganancia neta</div>
      </div>

      <div style={{ background: 'rgba(87,65,217,0.08)', border: '1px solid rgba(87,65,217,0.3)', borderRadius: 12, padding: '14px 18px', textAlign: 'center', minWidth: 120 }}>
        <div style={{ fontSize: 10, color: INDIGO, fontWeight: 800, marginBottom: 6, letterSpacing: '0.08em' }}>KRAKEN</div>
        <div style={{ fontSize: 22, fontWeight: 900, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>$70,250</div>
        <div style={{ marginTop: 8, background: INDIGO, color: '#fff', fontWeight: 800, fontSize: 10, padding: '3px 10px', borderRadius: 99 }}>VENDER ↓</div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>comisión: $70.25</div>
      </div>
    </div>
  );
}

function StepDots({ total, current, onGoTo }) {
  return (
    <div style={{ display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
      {Array.from({ length: total }).map((_, i) => (
        <button key={i} onClick={() => onGoTo(i)} title={`Step ${i+1}`} style={{
          width: i === current ? 18 : 7, height: 7, borderRadius: 99, border: 'none', cursor: 'pointer',
          background: i === current ? STEPS[current].color : 'var(--border)',
          transition: 'all 0.25s', padding: 0, flexShrink: 0,
        }} />
      ))}
    </div>
  );
}

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

export default function Onboarding({ show, step, setStep, onDismiss }) {
  const navigate    = useNavigate();
  const overlayRef  = useRef(null);
  const [animating, setAnimating] = useState(false);
  const s = STEPS[step] || STEPS[0];

  const goNext = useCallback(() => {
    if (step >= STEPS.length - 1) { onDismiss(); navigate('/arbitrage'); return; }
    setAnimating(true);
    setTimeout(() => { setStep(step + 1); setAnimating(false); }, 110);
  }, [step, onDismiss, navigate, setStep]);

  useEffect(() => {
    if (!show) return;
    const handler = (e) => {
      if (e.key === 'Escape') onDismiss();
      if (e.key === 'ArrowRight' && step < STEPS.length - 1) goNext();
      if (e.key === 'ArrowLeft'  && step > 0)                setStep(step - 1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [show, step, goNext, onDismiss, setStep]);

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

        <div style={{ height: 4, background: `linear-gradient(90deg, ${s.color}, ${s.color}88)`, flexShrink: 0 }} />

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

        <div style={{ padding: '18px 28px', flex: 1, overflowY: 'auto' }}>

          {s.id === 'what' && (<>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, margin: '0 0 14px' }}>{s.description}</p>
            <ArbDiagram />
            <div style={{ background: 'rgba(0,184,122,0.06)', border: '1px solid rgba(0,184,122,0.2)', borderRadius: 10, padding: '10px 14px', marginTop: 6 }}>
              <div style={{ fontSize: 11, color: GREEN, fontWeight: 800, marginBottom: 3 }}>⚡ Modelo Bilateral Pre-fondeado</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>Wallets fondeadas en los 5 exchanges desde el inicio. Cada operación ejecuta compra y venta simultáneamente — sin transferencias entre exchanges, sin demora de liquidación.</div>
            </div>
          </>)}

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
                  <strong style={{ color: INDIGO }}>Punto de equilibrio real:</strong> 0.05 BTC a $100k → nocional $5,000 → comisiones ≈$10 → slippage ≈$5 → requiere spread &gt; 0.03% para neto positivo.
                </div>
              </div>
            </div>
          )}

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
              {s.id === 'screens_research' ? 'Abrir el motor →' : s.action}
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

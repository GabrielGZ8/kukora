// ─── Onboarding.jsx v2 — Judge-first, arbitrage-first ─────────────────────
// First 10 seconds: what does Kukora do? → Bot is scanning live markets for
// price differences between exchanges and executing profitable trades.
// Progressive disclosure: simple → how → depth.

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const STEPS = [
  {
    id: 'what',
    emoji: '⚡',
    title: 'Kukora detecta oportunidades de arbitraje de Bitcoin',
    subtitle: 'en tiempo real, en 5 exchanges simultáneos',
    description: 'Cuando Bitcoin vale $103,200 en Binance y $103,350 en Kraken, Kukora compra en el exchange barato y vende en el caro — en milisegundos. Ganancia: $150 por BTC, menos comisiones.',
    visual: 'arb_diagram',
    action: '¿Cómo funciona? →',
    skip: 'Ir al bot directamente',
    color: '#FF2D78',
  },
  {
    id: 'how',
    emoji: '🔗',
    title: 'WebSockets a 5 exchanges, detección < 30ms',
    subtitle: 'Arquitectura event-driven de alta frecuencia',
    steps: [
      { icon: '📡', label: 'Feed en vivo', desc: 'WebSockets a Binance, Kraken, Bybit, OKX y Coinbase — datos de orden book cada 100ms' },
      { icon: '🔍', label: 'Detección', desc: 'El motor evalúa los 20 pares posibles entre los 5 exchanges al instante, calcula el spread neto real' },
      { icon: '🧮', label: 'Cálculo neto', desc: 'Descuenta comisiones (0.1%-0.26%), slippage VWAP real del L2, y valida liquidez ≥ 80%' },
      { icon: '✅', label: 'Ejecución', desc: 'Si spread neto > $0.01 y score ≥ 10, ejecuta: compra en A, vende en B simultáneamente' },
    ],
    action: 'Ver la inteligencia →',
    color: '#5741D9',
  },
  {
    id: 'intelligence',
    emoji: '🧠',
    title: 'Más allá del spread: inteligencia real',
    subtitle: 'No solo detecta — aprende y predice',
    features: [
      { icon: '📊', label: 'Score 0-100', desc: 'Cada oportunidad recibe un score basado en spread, fill probability, latencia y calidad de feed', color: '#FF2D78' },
      { icon: '🎯', label: 'Fill Probability', desc: 'Probabilidad cuantitativa de ejecución: depth score + spread edge + latency score + volatilidad', color: '#5741D9' },
      { icon: '📈', label: 'Exchange Ranking', desc: 'Aprende qué exchanges tienen mejor latencia y confiabilidad para priorizar pares', color: '#00b87a' },
      { icon: '🔮', label: 'Predictive Ranking', desc: 'Predice qué pares tendrán spread mayor en los próximos segundos basado en historial', color: '#F59E0B' },
    ],
    action: 'Ver las pantallas →',
    color: '#00b87a',
  },
  {
    id: 'screens',
    emoji: '🏆',
    title: '4 vistas para entender todo el sistema',
    subtitle: 'Desde el jurado hasta el ingeniero',
    tabs: [
      { icon: '🏆', label: 'Executive Dashboard', desc: 'Resumen ejecutivo: P&L, operaciones, tasa de éxito, exchanges conectados. Para evaluar el sistema en 30 segundos.', color: '#FF2D78' },
      { icon: '⚡', label: 'Bot & Order Books', desc: 'El motor en vivo: precios de los 5 exchanges, oportunidades detectadas, historial de trades y curva de equity.', color: '#5741D9' },
      { icon: '🧠', label: 'Intelligence', desc: 'Rankings de exchanges, volatilidad BTC, aprendizaje histórico y predicciones de próximas oportunidades.', color: '#00b87a' },
      { icon: '📊', label: 'Lifecycle Analytics', desc: 'Ciclo de vida de cada oportunidad: cuánto duran, qué spread máximo alcanzan, y por qué se cierran.', color: '#F59E0B' },
    ],
    action: '¡Ver el bot en acción! →',
    color: '#FF2D78',
  },
];

function ArbDiagram() {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap: 0, padding: '20px 0', flexWrap: 'wrap',
    }}>
      {/* Exchange A */}
      <div style={{
        background: 'rgba(240,185,11,0.08)', border: '1px solid rgba(240,185,11,0.3)',
        borderRadius: 12, padding: '16px 20px', textAlign: 'center', minWidth: 130,
      }}>
        <div style={{ fontSize: 11, color: '#F0B90B', fontWeight: 800, marginBottom: 6, letterSpacing: '0.08em' }}>BINANCE</div>
        <div style={{ fontSize: 24, fontWeight: 900, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>$103,200</div>
        <div style={{ marginTop: 8, background: '#F0B90B', color: '#000', fontWeight: 800, fontSize: 11, padding: '4px 12px', borderRadius: 99 }}>COMPRAR ↑</div>
      </div>

      {/* Arrow + profit */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 16px' }}>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 4, fontWeight: 700 }}>SPREAD BRUTO</div>
        <div style={{ fontSize: 20, color: '#FF2D78', fontWeight: 900, fontFamily: 'var(--font-mono)' }}>+$150</div>
        <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 2 }}>- fees $20</div>
        <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>- slip $5</div>
        <div style={{ width: 48, height: 2, background: 'linear-gradient(90deg,#F0B90B,#FF2D78)', margin: '8px 0', borderRadius: 2 }} />
        <div style={{ fontSize: 16, color: 'var(--color-green)', fontWeight: 900, fontFamily: 'var(--font-mono)' }}>= +$125 neto</div>
        <div style={{ fontSize: 9, color: 'var(--color-green)', marginTop: 2 }}>0.12% por BTC</div>
      </div>

      {/* Exchange B */}
      <div style={{
        background: 'rgba(87,65,217,0.08)', border: '1px solid rgba(87,65,217,0.3)',
        borderRadius: 12, padding: '16px 20px', textAlign: 'center', minWidth: 130,
      }}>
        <div style={{ fontSize: 11, color: '#5741D9', fontWeight: 800, marginBottom: 6, letterSpacing: '0.08em' }}>KRAKEN</div>
        <div style={{ fontSize: 24, fontWeight: 900, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>$103,350</div>
        <div style={{ marginTop: 8, background: '#5741D9', color: '#fff', fontWeight: 800, fontSize: 11, padding: '4px 12px', borderRadius: 99 }}>VENDER ↓</div>
      </div>
    </div>
  );
}

function StepDots({ total, current, onGoTo }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', marginTop: 8 }}>
      {Array.from({ length: total }).map((_, i) => (
        <button key={i} onClick={() => onGoTo(i)} style={{
          width: i === current ? 20 : 8,
          height: 8, borderRadius: 99, border: 'none', cursor: 'pointer',
          background: i === current ? STEPS[current].color : 'var(--border)',
          transition: 'all 0.25s', padding: 0,
        }} />
      ))}
    </div>
  );
}

export default function Onboarding({ show, step, setStep, onDismiss }) {
  const navigate = useNavigate();
  const overlayRef = useRef(null);
  const [animating, setAnimating] = useState(false);
  const s = STEPS[step] || STEPS[0];

  useEffect(() => {
    if (!show) return;
    const handler = (e) => {
      if (e.key === 'Escape') onDismiss();
      if (e.key === 'ArrowRight' && step < STEPS.length - 1) goNext();
      if (e.key === 'ArrowLeft' && step > 0) setStep(step - 1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [show, step]);

  const goNext = () => {
    if (step >= STEPS.length - 1) {
      onDismiss();
      navigate('/arbitrage');
      return;
    }
    setAnimating(true);
    setTimeout(() => { setStep(step + 1); setAnimating(false); }, 120);
  };

  const dismiss = () => { onDismiss(); navigate('/arbitrage'); };

  if (!show) return null;

  return (
    <div ref={overlayRef} onClick={e => { if (e.target === overlayRef.current) dismiss(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(8px)',
        zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}>
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 20,
        width: '100%', maxWidth: 640, boxShadow: '0 32px 80px rgba(0,0,0,0.5)',
        overflow: 'hidden',
        opacity: animating ? 0 : 1, transform: animating ? 'translateY(6px)' : 'translateY(0)',
        transition: 'opacity 0.12s, transform 0.12s',
      }}>

        {/* Color bar */}
        <div style={{ height: 4, background: `linear-gradient(90deg, ${s.color}, ${s.color}88)` }} />

        {/* Header */}
        <div style={{ padding: '28px 32px 0', display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <div style={{
            width: 52, height: 52, borderRadius: 14, flexShrink: 0,
            background: `${s.color}18`, display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 26,
          }}>{s.emoji}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 900, color: 'var(--text)', lineHeight: 1.2, marginBottom: 4 }}>{s.title}</div>
            <div style={{ fontSize: 13, color: 'var(--text-dim)', fontWeight: 500 }}>{s.subtitle}</div>
          </div>
          <button onClick={dismiss} style={{
            background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer',
            fontSize: 20, lineHeight: 1, padding: 4, flexShrink: 0,
          }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 32px' }}>

          {/* Step 0: what */}
          {s.id === 'what' && (<>
            <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.65, margin: '0 0 16px' }}>{s.description}</p>
            <ArbDiagram />
            <div style={{ background: 'rgba(0,184,122,0.06)', border: '1px solid rgba(0,184,122,0.2)', borderRadius: 10, padding: '12px 16px', marginTop: 4 }}>
              <div style={{ fontSize: 12, color: 'var(--color-green)', fontWeight: 800, marginBottom: 4 }}>⚡ Modelo Pre-funded Bilateral</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Las wallets ya están fondadas en los 5 exchanges. Cada trade ejecuta compra y venta simultáneamente, sin transferencias entre exchanges. Sin delay de liquidación.</div>
            </div>
          </>)}

          {/* Step 1: how */}
          {s.id === 'how' && (<>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {s.steps.map((st, i) => (
                <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--bg-surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>{st.icon}</div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', marginBottom: 2 }}>{st.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{st.desc}</div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 16, background: 'rgba(87,65,217,0.06)', border: '1px solid rgba(87,65,217,0.2)', borderRadius: 10, padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 18 }}>🎯</span>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                <strong style={{ color: '#5741D9' }}>Break-even real:</strong> con 0.01 BTC a $100k → notional $1,000 → fees ~$2 → spread mínimo 0.03% para ser rentable. El bot solo ejecuta cuando hay certeza matemática de ganancia neta.
              </div>
            </div>
          </>)}

          {/* Step 2: intelligence */}
          {s.id === 'intelligence' && (<>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {s.features.map((f, i) => (
                <div key={i} style={{ background: `${f.color}09`, border: `1px solid ${f.color}25`, borderRadius: 12, padding: '14px 16px' }}>
                  <div style={{ fontSize: 20, marginBottom: 8 }}>{f.icon}</div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', marginBottom: 4 }}>{f.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{f.desc}</div>
                </div>
              ))}
            </div>
          </>)}

          {/* Step 3: screens */}
          {s.id === 'screens' && (<>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {s.tabs.map((t, i) => (
                <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center', background: 'var(--bg-surface-2)', borderRadius: 10, padding: '12px 16px', border: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 22, flexShrink: 0 }}>{t.icon}</span>
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: t.color }}>{t.label}</span>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>{t.desc}</div>
                  </div>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: t.color, flexShrink: 0 }} />
                </div>
              ))}
            </div>
          </>)}
        </div>

        {/* Footer */}
        <div style={{ padding: '0 32px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <StepDots total={STEPS.length} current={step} onGoTo={setStep} />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {step > 0 && (
              <button onClick={() => setStep(step - 1)} style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', color: 'var(--text-muted)', borderRadius: 10, padding: '10px 20px', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                ← Atrás
              </button>
            )}
            <button onClick={goNext} style={{
              flex: 1, background: `linear-gradient(135deg, ${s.color}, ${s.color}cc)`,
              color: '#fff', border: 'none', borderRadius: 10, padding: '12px 24px',
              fontWeight: 800, fontSize: 14, cursor: 'pointer',
              boxShadow: `0 4px 16px ${s.color}44`,
            }}>
              {s.action}
            </button>
          </div>
          {step === 0 && (
            <button onClick={dismiss} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--border)' }}>
              {s.skip}
            </button>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: 'var(--text-dim)' }}>
            <span>Paso {step + 1} de {STEPS.length}</span>
            <span>Presiona <kbd style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px', fontSize: 10 }}>→</kbd> para avanzar, <kbd style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px', fontSize: 10 }}>Esc</kbd> para saltar</span>
          </div>
        </div>
      </div>
    </div>
  );
}
// ─── Onboarding.jsx ───────────────────────────────────────────────────────
// Modal de onboarding de 5 pasos con animaciones suaves y navegación
// Props: show, step, setStep, onDismiss

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

const STEPS = [
  {
    id: 'welcome',
    icon: '/favicon.png',
    iconFallback: '◈',
    title: 'Bienvenido a Kukora',
    subtitle: 'Quant Intelligence OS',
    description: 'Kukora es tu plataforma de análisis cuantitativo para criptomonedas. Datos en tiempo real, modelos matemáticos y señales de mercado en un solo lugar.',
    features: [
      { icon: '◈', label: 'Market Regime Engine', desc: 'IA que detecta el régimen de mercado actual' },
      { icon: '⟳', label: 'Monte Carlo GBM',      desc: 'Simulación probabilística de precios' },
      { icon: '⬡', label: 'Correlation Galaxy',   desc: 'Red animada de correlaciones en vivo' },
    ],
    action: 'Empezar tour →',
    skip: 'Saltar y explorar solo',
    color: 'var(--color-primary)',
  },
  {
    id: 'dashboard',
    icon: '▣',
    title: 'Dashboard',
    subtitle: 'Tu centro de control',
    description: 'El dashboard agrega las métricas más importantes: market cap global, fear & greed calculado en tiempo real, breadth del mercado y las señales de anomalía más relevantes.',
    tips: [
      { icon: '💡', text: 'El banner de "Market Regime" arriba del dashboard es clickeable — te lleva al análisis completo.' },
      { icon: '📊', text: 'El Fear & Greed se calcula automáticamente con datos reales de volatilidad y momentum.' },
      { icon: '🎯', text: 'Las "Señales Detectadas" muestran las cryptos con mayor anomaly score en este momento.' },
    ],
    action: 'Siguiente →',
    path: '/dashboard',
    color: '#3b82f6',
  },
  {
    id: 'regime',
    icon: '◈',
    title: 'Market Regime Engine',
    subtitle: 'IA cuantitativa',
    description: 'El motor de régimen analiza volatilidad normalizada, tendencia de medias móviles y momentum para clasificar el mercado en 6 estados posibles.',
    regimes: [
      { icon: '⟁', label: 'Liquidity Compression', color: '#f59e0b', desc: 'Volatilidad comprimida, precede expansiones' },
      { icon: '▲', label: 'Bullish Expansion',      color: '#00b87a', desc: 'Momentum positivo sostenido' },
      { icon: '▼', label: 'Bearish Contraction',    color: '#f03e3e', desc: 'Presión vendedora dominante' },
      { icon: '◈', label: 'Distribution',           color: '#8b5cf6', desc: 'Smart money reduciendo exposición' },
      { icon: '◎', label: 'Accumulation',           color: '#3b82f6', desc: 'Acumulación institucional silenciosa' },
      { icon: '⚡', label: 'Volatile Uncertainty',  color: '#FF8C42', desc: 'Señales contradictorias' },
    ],
    action: 'Siguiente →',
    path: '/regime',
    color: '#f59e0b',
  },
  {
    id: 'tools',
    icon: '⟳',
    title: 'Herramientas Cuantitativas',
    subtitle: 'Análisis de grado institucional',
    description: 'Kukora incluye un conjunto completo de herramientas matemáticas para analizar el mercado con rigor.',
    tools: [
      { icon: '⟳', label: 'Monte Carlo',        color: '#3b82f6', desc: 'Simula miles de trayectorias de precio con GBM', path: '/montecarlo' },
      { icon: '⬡', label: 'Correlation Galaxy', color: '#8b5cf6', desc: 'Red animada de correlaciones entre activos', path: '/galaxy' },
      { icon: '◌', label: 'Forecast',           color: '#00b87a', desc: 'Proyecciones con intervalos de confianza', path: '/forecast' },
      { icon: '◉', label: 'Risk Engine',        color: '#f03e3e', desc: 'VaR, Beta, Sharpe y métricas de riesgo', path: '/risk' },
      { icon: '◎', label: 'Backtest',           color: '#FF8C42', desc: 'Prueba estrategias históricas de trading', path: '/backtest' },
      { icon: '⬡', label: 'Intelligence',       color: '#f59e0b', desc: 'Scoring multi-factor y detección de oportunidades', path: '/intelligence' },
      { icon: '⇄', label: 'Comparar Activos',    color: '#06b6d4', desc: 'Compara hasta 4 activos: Sharpe, drawdown, retornos', path: '/compare' },
    ],
    action: 'Siguiente →',
    color: '#8b5cf6',
  },
  {
    id: 'shortcuts',
    icon: '⌨',
    title: 'Tips & Shortcuts',
    subtitle: 'Sácale el máximo',
    description: 'Kukora está diseñado para ser rápido e intuitivo. Aquí hay algunos atajos y consejos para trabajar más eficientemente.',
    shortcuts: [
      { keys: ['?'],          desc: 'Abrir esta guía en cualquier momento' },
      { keys: ['☰'],         desc: 'Colapsar/expandir el sidebar' },
      { keys: ['AI'],        desc: 'Badge en sidebar = análisis con inteligencia artificial' },
      { keys: ['LIVE'],      desc: 'Badge en sidebar = datos en tiempo real' },
      { keys: ['🚨'],        desc: 'Banner flotante = anomalía de alta severidad detectada' },
    ],
    hints: [
      'Los datos se actualizan automáticamente — no necesitas recargar la página.',
      'En Monte Carlo puedes ingresar un precio objetivo para ver la probabilidad histórica.',
      'La Correlation Galaxy reacciona al hover — pasa el mouse sobre un nodo para ver sus correlaciones.',
    ],
    action: '¡Empezar a explorar!',
    color: 'var(--color-primary)',
  },
];

function ProgressDots({ total, current, onGoTo }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      {Array.from({ length: total }).map((_, i) => (
        <button
          key={i}
          onClick={() => onGoTo(i)}
          style={{
            width: i === current ? 20 : 6,
            height: 6,
            borderRadius: 99,
            background: i === current ? 'var(--color-primary)' : 'var(--bg-surface-3)',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            transition: 'all 0.25s ease',
          }}
        />
      ))}
    </div>
  );
}

function StepWelcome({ step }) {
  return (
    <div style={{ textAlign: 'center', padding: '8px 0 4px' }}>
      <div style={{ marginBottom: 20 }}>
        <img
          src={step.icon}
          alt="kukora"
          style={{ width: 64, height: 64, borderRadius: 16, objectFit: 'contain', boxShadow: '0 4px 20px rgba(255,45,120,0.2)' }}
          onError={e => { e.target.style.display = 'none'; e.target.parentNode.innerHTML = `<div style="width:64px;height:64px;border-radius:16px;background:linear-gradient(135deg,#FF8C42,#FF2D78);display:flex;align-items:center;justify-content:center;font-size:28px;margin:0 auto">◈</div>`; }}
        />
      </div>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.10em', marginBottom: 8 }}>
        {step.subtitle}
      </div>
      <h2 style={{ fontSize: 26, fontWeight: 900, marginBottom: 12, letterSpacing: '-0.5px' }}>{step.title}</h2>
      <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.65, maxWidth: 380, margin: '0 auto 24px' }}>
        {step.description}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'left' }}>
        {step.features.map(f => (
          <div key={f.label} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '10px 14px', background: 'var(--bg-surface-2)',
            borderRadius: 'var(--radius)', border: '1px solid var(--border)',
          }}>
            <span style={{ fontSize: 16, width: 24, textAlign: 'center', flexShrink: 0 }}>{f.icon}</span>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 1 }}>{f.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{f.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StepWithTips({ step }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12, flexShrink: 0,
          background: `${step.color}15`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 20, border: `1px solid ${step.color}25`,
        }}>
          {step.icon}
        </div>
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>{step.subtitle}</div>
          <h3 style={{ fontSize: 18, fontWeight: 900, letterSpacing: '-0.3px' }}>{step.title}</h3>
        </div>
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 20 }}>{step.description}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {step.tips?.map((tip, i) => (
          <div key={i} style={{
            display: 'flex', gap: 10, alignItems: 'flex-start',
            padding: '10px 12px', background: 'var(--bg-surface-2)',
            borderRadius: 'var(--radius)', border: '1px solid var(--border)',
          }}>
            <span style={{ fontSize: 15, flexShrink: 0, lineHeight: 1.3 }}>{tip.icon}</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>{tip.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StepRegime({ step }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0, background: `${step.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, border: `1px solid ${step.color}25` }}>
          {step.icon}
        </div>
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>{step.subtitle}</div>
          <h3 style={{ fontSize: 18, fontWeight: 900, letterSpacing: '-0.3px' }}>{step.title}</h3>
        </div>
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 16 }}>{step.description}</p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {step.regimes.map(r => (
          <div key={r.label} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 10px', background: `${r.color}08`,
            borderRadius: 'var(--radius)', border: `1px solid ${r.color}20`,
          }}>
            <span style={{ fontSize: 14, flexShrink: 0 }}>{r.icon}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: r.color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</div>
              <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StepTools({ step, onNavigate }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0, background: `${step.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, border: `1px solid ${step.color}25` }}>
          {step.icon}
        </div>
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>{step.subtitle}</div>
          <h3 style={{ fontSize: 18, fontWeight: 900, letterSpacing: '-0.3px' }}>{step.title}</h3>
        </div>
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 16 }}>{step.description}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {step.tools.map(t => (
          <div
            key={t.label}
            onClick={() => onNavigate(t.path)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 12px', background: 'var(--bg-surface-2)',
              borderRadius: 'var(--radius)', border: '1px solid var(--border)',
              cursor: 'pointer', transition: 'all 0.15s ease',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = t.color; e.currentTarget.style.background = `${t.color}08`; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--bg-surface-2)'; }}
          >
            <span style={{ fontSize: 14, width: 20, textAlign: 'center', flexShrink: 0 }}>{t.icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 1 }}>{t.label}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.desc}</div>
            </div>
            <span style={{ fontSize: 10, color: 'var(--text-dim)', flexShrink: 0 }}>→</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StepShortcuts({ step }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0, background: 'var(--color-primary-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, border: '1px solid rgba(255,45,120,0.15)' }}>
          {step.icon}
        </div>
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>{step.subtitle}</div>
          <h3 style={{ fontSize: 18, fontWeight: 900, letterSpacing: '-0.3px' }}>{step.title}</h3>
        </div>
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 16 }}>{step.description}</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
        {step.shortcuts.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              {s.keys.map(k => (
                <kbd key={k} style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: 24, padding: '2px 6px', fontSize: 11, fontWeight: 700,
                  background: 'var(--bg-surface-2)', border: '1px solid var(--border-bright)',
                  borderRadius: 5, fontFamily: 'var(--font-mono)', color: 'var(--text)',
                  boxShadow: '0 2px 0 rgba(0,0,0,0.08)',
                }}>{k}</kbd>
              ))}
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{s.desc}</span>
          </div>
        ))}
      </div>

      <div style={{ padding: '12px 14px', background: 'linear-gradient(135deg, rgba(255,140,66,0.06), rgba(255,45,120,0.06))', borderRadius: 'var(--radius)', border: '1px solid rgba(255,45,120,0.12)' }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>Consejos rápidos</div>
        {step.hints.map((h, i) => (
          <div key={i} style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: i < step.hints.length - 1 ? 6 : 0, paddingLeft: 10, borderLeft: '2px solid rgba(255,45,120,0.3)' }}>
            {h}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Onboarding({ show, step, setStep, onDismiss }) {
  const navigate  = useNavigate();
  const overlayRef = useRef(null);
  const modalRef   = useRef(null);

  // Keyboard navigation
  useEffect(() => {
    if (!show) return;
    const handle = (e) => {
      if (e.key === 'Escape') onDismiss();
      if (e.key === 'ArrowRight' && step < STEPS.length - 1) setStep(s => s + 1);
      if (e.key === 'ArrowLeft'  && step > 0)               setStep(s => s - 1);
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [show, step, onDismiss, setStep]);

  if (!show) return null;

  const current = STEPS[step];
  const isFirst = step === 0;
  const isLast  = step === STEPS.length - 1;

  const handleAction = () => {
    if (isLast) {
      onDismiss();
    } else {
      setStep(s => s + 1);
    }
  };

  const handleNavigate = (path) => {
    onDismiss();
    navigate(path);
  };

  return (
    <div
      ref={overlayRef}
      onClick={e => { if (e.target === overlayRef.current) onDismiss(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15,17,23,0.55)',
        backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
        animation: 'fadeIn 0.2s ease',
      }}
    >
      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes slideUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      <div
        ref={modalRef}
        style={{
          background: '#fff',
          borderRadius: 20,
          width: '100%', maxWidth: 480,
          maxHeight: '90vh',
          overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 24px 60px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)',
          animation: 'slideUp 0.25s ease',
        }}
      >
        {/* Header bar */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 20px', borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Kukora · Guía {step + 1}/{STEPS.length}
          </div>
          <button
            onClick={onDismiss}
            style={{
              background: 'none', border: 'none', fontSize: 18,
              color: 'var(--text-dim)', cursor: 'pointer', padding: '2px 6px',
              borderRadius: 6, lineHeight: 1, transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface-3)'; e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-dim)'; }}
          >
            ✕
          </button>
        </div>

        {/* Scrollable content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '22px 24px' }}>
          {step === 0 && <StepWelcome step={current} />}
          {step === 1 && <StepWithTips step={current} />}
          {step === 2 && <StepRegime step={current} />}
          {step === 3 && <StepTools step={current} onNavigate={handleNavigate} />}
          {step === 4 && <StepShortcuts step={current} />}
        </div>

        {/* Footer */}
        <div style={{
          padding: '14px 20px',
          borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0, background: 'var(--bg-surface-2)',
        }}>
          <ProgressDots total={STEPS.length} current={step} onGoTo={setStep} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {isFirst && (
              <button
                onClick={onDismiss}
                style={{ background: 'none', border: 'none', fontSize: 12, color: 'var(--text-dim)', cursor: 'pointer', padding: '4px 8px', borderRadius: 6 }}
              >
                {current.skip}
              </button>
            )}
            {!isFirst && (
              <button
                onClick={() => setStep(s => s - 1)}
                className="btn btn-ghost btn-sm"
              >
                ← Anterior
              </button>
            )}
            <button
              onClick={handleAction}
              className="btn btn-primary btn-sm"
              style={{ minWidth: 120 }}
            >
              {current.action}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

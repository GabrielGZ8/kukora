// ─── DocsPage.jsx — Interactive Mathematical Documentation ───────────────
import { useState } from 'react';
import { PageHeader } from '../components/common/PageHeader';

const Code = ({ children }) => (
  <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 5, padding: '1px 6px', color: 'var(--color-primary)' }}>
    {children}
  </code>
);

const Formula = ({ children, label }) => (
  <div style={{ margin: '14px 0', padding: '14px 18px', background: 'linear-gradient(135deg, rgba(255,45,120,0.04), rgba(255,140,66,0.04))', border: '1px solid rgba(255,45,120,0.15)', borderRadius: 'var(--radius-lg)', borderLeft: '3px solid var(--color-primary)' }}>
    {label && <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{label}</div>}
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: 'var(--text)', lineHeight: 1.7 }}>{children}</div>
  </div>
);

const Section = ({ id, title, icon, children, active, onClick }) => (
  <div id={id} style={{ marginBottom: 6 }}>
    <button
      onClick={onClick}
      style={{
        width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px', borderRadius: 'var(--radius)', border: 'none',
        background: active ? 'var(--color-primary-dim)' : 'var(--bg-surface-2)',
        color: active ? 'var(--color-primary)' : 'var(--text-muted)',
        cursor: 'pointer', fontFamily: 'var(--font-ui)', fontWeight: 600, fontSize: 13,
        transition: 'all 0.13s',
        borderLeft: active ? '2px solid var(--color-primary)' : '2px solid transparent',
      }}
    >
      <span>{icon}</span>
      <span>{title}</span>
      <span style={{ marginLeft: 'auto', fontSize: 12 }}>{active ? '▲' : '▼'}</span>
    </button>
    {active && <div style={{ padding: '16px 20px 20px', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 var(--radius) var(--radius)', marginBottom: 2 }}>{children}</div>}
  </div>
);

const Prop = ({ name, weight, desc, color }) => (
  <div style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)', alignItems: 'flex-start' }}>
    <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: color || 'var(--color-primary)', background: `${color || 'var(--color-primary)'}12`, padding: '1px 7px', borderRadius: 4, flexShrink: 0 }}>{name}</code>
    {weight && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', background: 'var(--bg-surface-2)', padding: '2px 6px', borderRadius: 99, flexShrink: 0 }}>{weight}</span>}
    <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{desc}</span>
  </div>
);

const DOCS = [
  {
    id: 'gbm', icon: '⟳', title: 'Monte Carlo — Geometric Brownian Motion',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          El modelo GBM (Geometric Brownian Motion) es el estándar en finanzas cuantitativas para modelar trayectorias de precios estocásticos. Asume que los retornos logarítmicos siguen un proceso de Wiener con drift constante.
        </p>
        <Formula label="Ecuación diferencial estocástica">
          dS = μS·dt + σS·dW
        </Formula>
        <Formula label="Solución analítica (discretizada)">
          S(t+1) = S(t) · exp((μ - σ²/2)·Δt + σ·√Δt·Z)
        </Formula>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: 14 }}>
          Donde <Code>μ</Code> es el drift (retorno medio diario histórico), <Code>σ</Code> es la volatilidad (desviación estándar de retornos), <Code>Δt = 1/252</Code> (días de trading), y <Code>Z ~ N(0,1)</Code> es un número aleatorio normal estándar.
        </div>
        <Formula label="Estimación de parámetros desde datos históricos">
          μ = mean(ln(Sₜ/Sₜ₋₁)) · 252{'\n'}
          σ = std(ln(Sₜ/Sₜ₋₁)) · √252
        </Formula>
        <div style={{ padding: '12px 14px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text)' }}>Limitaciones conocidas:</strong> GBM asume distribución log-normal de retornos y volatilidad constante. En la práctica, los activos crypto exhiben fat tails, volatility clustering y saltos discontinuos. El modelo es útil como baseline probabilístico, no como predictor puntual.
        </div>
      </>
    ),
  },
  {
    id: 'kcs', icon: '◈', title: 'KCS — Kukora Composite Signal',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          El KCS es una métrica propietaria multi-factor que agrega 7 dimensiones del mercado en un score único de 0–100. Inspirado en índices institucionales como el Fear & Greed de CNN Money y los composite indicators de Bloomberg.
        </p>
        <Formula label="Score compuesto ponderado">
          KCS = Σ (wᵢ · scoreᵢ)
        </Formula>
        <div style={{ marginBottom: 14 }}>
          {[
            { name: 'Momentum 7/14d', w: '20%', desc: 'Retorno relativo ponderado en ventanas de 7 y 14 días. 7d tiene peso 0.6, 14d tiene 0.4.', color: '#FF2D78' },
            { name: 'Volatility Stability', w: '15%', desc: 'score = 100 − σ_daily × 8. Mayor volatilidad = menor score. Penaliza incertidumbre.', color: '#f59e0b' },
            { name: 'Market Breadth', w: '15%', desc: '% de activos en positivo 24h. >50% = score > 50. Mide salud general del mercado.', color: '#3b82f6' },
            { name: 'Liquidity Flow', w: '20%', desc: 'Volumen relativo vs media 7 días. score = (vol_hoy / vol_medio) × 50. Cap: 100.', color: '#00b87a' },
            { name: 'RSI Quality', w: '15%', desc: 'RSI 14 períodos. Zona óptima 45–65 score=80. Extremos (>80 o <20) score=20–25.', color: '#8b5cf6' },
            { name: 'BTC Dominance', w: '10%', desc: 'Dom >60%: risk-off, score=25. Dom <40%: altseason, score=75. 50%: neutro, score=55.', color: '#F7931A' },
            { name: 'Sentiment', w: '5%', desc: 'Proxy de sentimiento basado en momentum normalizado. Puede alimentarse con datos externos.', color: '#06b6d4' },
          ].map(p => <Prop key={p.name} {...p} />)}
        </div>
        <div style={{ padding: '12px 14px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Interpretación del score</div>
          {[['≥ 72','RISK ON — condiciones favorables. Múltiples señales convergiendo positivamente.','var(--color-green)'],['55–71','CAUTIOUSLY BULLISH — sesgo positivo moderado. Confirmar breadth.','var(--color-blue)'],['45–54','EQUILIBRIUM — señales balanceadas. Esperar catalizador.','var(--color-yellow)'],['30–44','CAUTIOUSLY BEARISH — deterioro gradual. Reducir exposición.','#FF8C42'],['< 30','RISK OFF — condiciones adversas. Preservar capital.','var(--color-red)']].map(([range,desc,color]) => (
            <div key={range} style={{ display: 'flex', gap: 10, marginBottom: 4 }}>
              <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color, fontWeight: 700, flexShrink: 0, width: 50 }}>{range}</code>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{desc}</span>
            </div>
          ))}
        </div>
      </>
    ),
  },
  {
    id: 'regime', icon: '⟁', title: 'Market Regime Engine',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          El Market Regime Engine clasifica el mercado en uno de 6 estados discretos usando un sistema de scoring multi-señal. Cada señal contribuye puntos al régimen candidato; gana el que acumula más puntos ponderados.
        </p>
        <div style={{ marginBottom: 14 }}>
          {[
            { name: 'Volatilidad Normalizada', w: 'σ_recent / σ_hist', desc: '<0.75 = comprimida (apunta a Liquidity Compression). >1.4 = expandida (apunta a Volatile Uncertainty).', color: '#f59e0b' },
            { name: 'Tendencia MA', w: '(SMA10-SMA20)/SMA20', desc: '>0.3 → bullish. <−0.3 → bearish. Entre −0.2 y 0.2 → lateral.', color: '#3b82f6' },
            { name: 'Momentum 7/14d', w: 'ret7×0.6+ret14×0.4', desc: '>0.3 → positivo. <−0.3 → negativo. Amplifica o atenúa la señal de tendencia.', color: '#00b87a' },
            { name: 'Retorno Reciente', w: 'Δ% del día', desc: '>3% → fuerte subida. <−3% → fuerte caída. Señal de confirmación de momentum.', color: '#FF2D78' },
          ].map(p => <Prop key={p.name} {...p} />)}
        </div>
        <Formula label="Scoring de régimen (ejemplo: Bullish Expansion)">
          score_BULLISH = {'\n'}
          {'  '}(trend {'>'} 0.3 ? 40 : trend {'>'} 0.1 ? 20 : 0){'\n'}
          {'  '}+ (momentum {'>'} 0.3 ? 35 : momentum {'>'} 0.1 ? 15 : 0){'\n'}
          {'  '}+ (0.9 {'<'} normVol {'<'} 1.6 ? 15 : 0){'\n'}
          {'  '}+ (recentRet {'>'} 2 ? 10 : 0)
        </Formula>
        <Formula label="Confianza del modelo">
          confidence = 50 + (score_max − score_2nd) × 0.8
        </Formula>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 14 }}>
          {[['⟁','Liquidity Compression','#f59e0b'],['▲','Bullish Expansion','#00b87a'],['▼','Bearish Contraction','#f03e3e'],['◈','Distribution','#8b5cf6'],['◎','Accumulation','#3b82f6'],['⚡','Volatile Uncertainty','#FF8C42']].map(([icon,label,color]) => (
            <div key={label} style={{ padding: '10px 12px', background: `${color}10`, borderRadius: 'var(--radius)', border: `1px solid ${color}25`, textAlign: 'center' }}>
              <div style={{ fontSize: 18, marginBottom: 4 }}>{icon}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color }}>{label}</div>
            </div>
          ))}
        </div>
      </>
    ),
  },
  {
    id: 'backtest', icon: '◎', title: 'Backtest Engine — Estrategias',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          El backtester simula estrategias de trading sobre datos históricos con capital inicial de $10,000. Incluye 3 estrategias y un benchmark Buy & Hold. No considera comisiones ni slippage.
        </p>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>SMA Crossover</div>
          <Formula label="Señal de entrada">compra: SMA(10) cruza SMA(30) hacia arriba{'\n'}vende: SMA(10) cruza SMA(30) hacia abajo</Formula>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, marginTop: 14 }}>RSI Mean Reversion</div>
          <Formula label="Indicador RSI (Relative Strength Index)">
            RS = mean(gains, 14) / mean(losses, 14){'\n'}
            RSI = 100 − 100/(1+RS){'\n'}
            compra: RSI {'<'} 30 · vende: RSI {'>'} 70
          </Formula>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, marginTop: 14 }}>Bollinger Breakout</div>
          <Formula label="Bandas de Bollinger (período 20, 2σ)">
            BB_upper = SMA(20) + 2·σ{'\n'}
            BB_lower = SMA(20) − 2·σ{'\n'}
            compra: precio cruza BB_upper · vende: precio toca SMA(20)
          </Formula>
        </div>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>Métricas de evaluación</div>
        {[
          ['Sharpe Ratio', 'Sharpe = (μ_portfolio − r_f) / σ_portfolio × √365', 'Compensación riesgo/retorno. {'>'} 1 es bueno, {'>'} 2 es excelente.'],
          ['Max Drawdown', 'MDD = max((peak − trough) / peak) × 100', 'Caída máxima desde un pico. Mide el peor escenario histórico.'],
          ['Win Rate', 'WR = trades_ganadores / total_trades × 100', '% de operaciones cerradas con ganancia.'],
        ].map(([name, formula, desc]) => (
          <div key={name} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4, color: 'var(--color-primary)' }}>{name}</div>
            <Formula>{formula}</Formula>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>{desc}</div>
          </div>
        ))}
      </>
    ),
  },
  {
    id: 'risk', icon: '◉', title: 'Risk Engine — VaR & Métricas',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          El Risk Engine calcula métricas de riesgo estándar en finanzas cuantitativas usando el método histórico no-paramétrico.
        </p>
        <Formula label="Value at Risk histórico (95%)">
          VaR₉₅ = −percentil(retornos_diarios, 5) × capital
        </Formula>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.6 }}>
          Interpretación: "Hay un 5% de probabilidad de perder más de VaR₉₅ en un día dado". No asume distribución normal — usa la distribución empírica de retornos históricos.
        </div>
        <Formula label="Beta vs BTC benchmark">
          β = Cov(r_asset, r_btc) / Var(r_btc)
        </Formula>
        <Formula label="Sortino Ratio (solo penaliza downside)">
          Sortino = (μ − r_f) / σ_downside{'\n'}
          σ_downside = std(min(r, 0))
        </Formula>
        <Formula label="Calmar Ratio">
          Calmar = retorno_anualizado / max_drawdown
        </Formula>
        <div style={{ padding: '12px 14px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text)' }}>Nota sobre VaR histórico:</strong> A diferencia del VaR paramétrico (que asume normalidad), el método histórico captura fat tails y distribuciones asimétricas naturalmente. Sin embargo, asume que el pasado es representativo del futuro — limitación importante en activos de alta volatilidad como crypto.
        </div>
      </>
    ),
  },
  {
    id: 'forecast', icon: '◌', title: 'Forecast — Modelo Ensemble',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          El modelo de forecast usa un ensemble de dos métodos que capturan diferentes componentes de la serie temporal: tendencia de corto plazo (SMA drift) y alisamiento exponencial (Holt-Winters EWM).
        </p>
        <Formula label="SMA Drift Model">
          drift = (SMA_k_fin − SMA_k_ini) / SMA_k_ini / k{'\n'}
          Ŝ(t+h) = S(t) × (1 + drift)^h
        </Formula>
        <Formula label="Holt-Winters EWM (suavizado doble)">
          L(t) = α·S(t) + (1−α)·(L(t−1) + B(t−1)){'\n'}
          B(t) = β·(L(t)−L(t−1)) + (1−β)·B(t−1){'\n'}
          Ŝ(t+h) = L(t) + h·B(t)
        </Formula>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.6 }}>
          Parámetros: <Code>α = 0.3</Code> (nivel), <Code>β = 0.1</Code> (trend). El ensemble pondera ambos modelos igualmente.
        </div>
        <Formula label="Intervalo de confianza 90%">
          IC₉₀ = Ŝ(t+h) ± 1.645 · σ_residual · √h
        </Formula>
        <div style={{ padding: '12px 14px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text)' }}>Limitaciones:</strong> Los modelos de series temporales son susceptibles a cambios estructurales abruptos (black swans). Los intervalos de confianza asumen errores estacionarios. El forecast es indicativo, no predictivo.
        </div>
      </>
    ),
  },
  {
    id: 'anomaly', icon: '🚨', title: 'Anomaly Detection Engine',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          El detector de anomalías identifica comportamientos estadísticamente inusuales en las series de precios usando múltiples métricas.
        </p>
        <Formula label="Z-score de retorno">
          z = (r_t − μ_retornos) / σ_retornos{'\n'}
          anomalía si |z| {'>'} 2.5
        </Formula>
        <Formula label="Volatility ratio">
          vr = σ_reciente(7d) / σ_histórica{'\n'}
          spike si vr {'>'} 2.0
        </Formula>
        <div style={{ marginTop: 14 }}>
          {[['LOW (0–39)','Comportamiento normal dentro de rangos esperados.','var(--color-green)'],['MEDIUM (40–69)','Desviación notable. Monitorear evolución.','var(--color-yellow)'],['HIGH (70–100)','Anomalía significativa. Probable evento de mercado.','var(--color-red)']].map(([level,desc,color]) => (
            <div key={level} style={{ display:'flex',gap:10,padding:'8px 0',borderBottom:'1px solid var(--border)' }}>
              <code style={{ fontFamily:'var(--font-mono)',fontSize:11,color,fontWeight:700,flexShrink:0,width:110 }}>{level}</code>
              <span style={{ fontSize:12,color:'var(--text-muted)' }}>{desc}</span>
            </div>
          ))}
        </div>
      </>
    ),
  },
  {
    id: 'stack', icon: '🏗', title: 'Stack Técnico',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 16 }}>
          Kukora está construido con un stack moderno orientado a rendimiento y mantenibilidad.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[
            { label: 'Frontend', items: ['React 18 · Vite 5', 'Recharts (gráficas)', 'Lightweight Charts (OHLC)', 'react-hot-toast', 'react-router-dom v6'] },
            { label: 'Backend', items: ['Node.js + Express 4', 'Mongoose + MongoDB Atlas', 'express-rate-limit', 'CoinGecko Public API', 'Request queue (350ms/req)'] },
            { label: 'Modelos Cuantitativos', items: ['GBM (Monte Carlo)', 'SMA/EMA/RSI/Bollinger', 'Holt-Winters EWM Forecast', 'Market Regime Engine', 'KCS Composite Signal'] },
            { label: 'Deploy', items: ['Vercel (frontend)', 'Railway (backend)', 'MongoDB Atlas (free tier)', 'GitHub Actions CI/CD', 'ENV: MONGODB_URI, PORT'] },
          ].map(({ label, items }) => (
            <div key={label} style={{ background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)', padding: '12px 14px', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-primary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
              {items.map(i => <div key={i} style={{ fontSize: 11, color: 'var(--text-muted)', padding: '3px 0', borderBottom: '1px solid var(--border)', display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ color: 'var(--color-green)', fontSize: 9 }}>●</span>{i}
              </div>)}
            </div>
          ))}
        </div>
      </>
    ),
  },
];

export default function DocsPage() {
  const [active, setActive] = useState('gbm');

  return (
    <div className="page-enter">
      <PageHeader
        title="Documentación Técnica"
        description="Modelos matemáticos, fórmulas y fundamentos cuantitativos detrás de Kukora"
        help="Esta documentación demuestra el rigor matemático del sistema. Cada modelo tiene sus fórmulas, limitaciones y contexto."
      />
      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 20, alignItems: 'flex-start' }}>
        {/* Sidebar nav */}
        <div style={{ position: 'sticky', top: 78 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.09em', padding: '0 4px', marginBottom: 8 }}>Contenido</div>
          {DOCS.map(d => (
            <button key={d.id} onClick={() => setActive(d.id)} style={{
              width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 10px', borderRadius: 7, border: 'none',
              background: active === d.id ? 'var(--color-primary-dim)' : 'transparent',
              color: active === d.id ? 'var(--color-primary)' : 'var(--text-muted)',
              cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: active === d.id ? 700 : 500,
              transition: 'all 0.13s', marginBottom: 1,
            }}>
              <span style={{ width: 18, textAlign: 'center', flexShrink: 0, fontSize: 13 }}>{d.icon}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title.split('—')[0].trim()}</span>
            </button>
          ))}
        </div>
        {/* Content */}
        <div>
          {DOCS.filter(d => d.id === active).map(d => (
            <div key={d.id} className="card page-enter" style={{ padding: '24px 28px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 24 }}>{d.icon}</span>
                <div>
                  <h2 style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.3px' }}>{d.title}</h2>
                </div>
              </div>
              {d.content()}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
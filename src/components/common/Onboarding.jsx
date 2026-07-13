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
    title: 'Kukora — Real-time BTC arbitrage engine',
    subtitle: '5 exchanges · detection < 30ms · full simulated execution',
    description: 'Kukora simultaneously monitors Binance, Kraken, Bybit, OKX and Coinbase via native WebSockets. When it detects that the ask on one exchange is below the bid on another, it calculates real net profit (fees + slippage + liquidity) and executes the simulated trade in milliseconds.',
    visual: 'arb_diagram',
    action: 'See the architecture →',
    skip: 'Go directly to the engine',
    color: PINK,
  },
  {
    id: 'architecture',
    emoji: '🔗',
    title: 'High-frequency event-driven architecture',
    subtitle: 'WebSockets → detection → scoring → execution → wallet update',
    steps: [
      { icon: '📡', label: 'WebSocket feeds', desc: 'Binance bookTicker+depth5@100ms · Kraken book v2 · Bybit tickers+orderbook.50 · OKX books5 · Coinbase ticker. Watchdog reconnects automatically if any feed freezes > 5s.' },
      { icon: '🔍', label: 'Spread detection', desc: 'Evaluates all 20 exchange pairs in under 1ms. Net spread = gross − taker fees − VWAP L2 slippage − amortized withdrawal fee.' },
      { icon: '🛡️', label: 'Circuit breakers', desc: 'Spread < 0.005% → market noise. Spread > 3% → stale data. Daily loss > $500 → engine paused. Liquidity < 50% of volume → partial fill.' },
      { icon: '✅', label: 'Execution & wallets', desc: 'Score ≥ 10 + net > $0.05 + unique fingerprint (5s TTL) → executes. Wallets updated on both exchanges. Equity curve updates in real time.' },
    ],
    action: 'See the intelligence lyesterday →',
    color: INDIGO,
  },
  {
    id: 'intelligence',
    emoji: '🧠',
    title: 'Multi-lyesterday intelligence system',
    subtitle: 'Not just detection — it learns, predicts and prioritizes',
    features: [
      { icon: '🎯', label: 'Score 0–100',          desc: 'Combines profit%, fill probability, latency, spread persistence and WS feed quality.',              color: PINK   },
      { icon: '📊', label: 'Stat Arb (Z-Score)',   desc: 'Detects statistical deviations (Z > 2σ) in the historical differential between pairs.',              color: INDIGO },
      { icon: '🔺', label: 'Triangular Arb',       desc: '3-leg intra-exchange routes (A→B→C) with netPct > 0.05% threshold before auto-execution.',          color: PURPLE },
      { icon: '📈', label: 'Exchange Ranking',      desc: 'Learns which exchanges have better latency and reliability to prioritize pairs.',                    color: GREEN  },
      { icon: '🔮', label: 'Predictive Ranking',   desc: 'Predicts which pairs will have higher spread in the next ticks based on session history.',           color: AMBER  },
      { icon: '♻️', label: 'Lifecycle Tracking',   desc: 'Full opportunity lifecycle: birth, spread peak, expiration. Decay curves per pair.',                 color: BLUE   },
    ],
    action: 'See the main screens →',
    color: GREEN,
  },
  {
    id: 'screens_core',
    emoji: '🏆',
    title: 'Core arbitrage screens',
    subtitle: '"Arbitrage System" section in the sidebar',
    tabs: [
      { icon: '⚡', label: '/arbitrage — Live Engine',
        desc: 'Executive Dashboard + real-time order books + detected opportunities + trade history + equity curve. Primary operational screen.',
        path: '/arbitrage', color: PINK },
      { icon: '📊', label: '/dashboard — Executive Summary',
        desc: 'Session P&L, win rate, executed trades, connected exchanges, BTC volatility and key engine metrics at a glance.',
        path: '/dashboard', color: INDIGO },
      { icon: '📄', label: '/docs — Documentation',
        desc: 'Exact fee formulas, VWAP slippage, break-even, 0–100 scoring, circuit breakers and architecture. For mathematical audit of the system.',
        path: '/docs', color: BLUE },
    ],
    action: 'See operational tools →',
    color: PINK,
  },
  {
    id: 'screens_tools',
    emoji: '🛠️',
    title: 'Operational tools',
    subtitle: '"Tools" section in the sidebar',
    tabs: [
      { icon: '🔔', label: '/alerts — Alert system',
        desc: 'Configure price, P&L and spread alerts. Receive real-time notifications via SSE when conditions trigger.',
        path: '/alerts', color: AMBER },
      { icon: '💼', label: '/portfolio — Portfolio management',
        desc: 'Track and monitor positions across multiple assets. Calculates P&L, capital distribution and historical performance.',
        path: '/portfolio', color: GREEN },
      { icon: '⭐', label: '/watchlist — Watchlist',
        desc: 'Follow your assets with real-time prices, 24h changes and custom alerts.',
        path: '/watchlist', color: BLUE },
      { icon: '📈', label: '/markets — Global markets',
        desc: 'Top crypto assets: prices, market cap, 24h volume and changes. Data via CoinGecko API.',
        path: '/markets', color: PURPLE },
    ],
    action: 'See quantitative analysis →',
    color: AMBER,
  },
  {
    id: 'screens_advanced',
    emoji: '📐',
    title: 'Quantitative Analysis',
    subtitle: 'Collapsible "Quantitative Analysis" section in the sidebar',
    tabs: [
      { icon: '📂', label: '/analyze — Dataset Analyzer',
        desc: 'Upload any price CSV and run the full quant stack: returns, VaR, Sharpe, drawdown, correlations.',
        path: '/analyze', color: PINK },
      { icon: '⚖️', label: '/compare — Asset Compare',
        desc: 'Compare up to 4 assets: normalized returns, Sharpe ratio, maximum drawdown, beta and cross-correlation.',
        path: '/compare', color: INDIGO },
      { icon: '⚠️', label: '/risk — Risk Engine',
        desc: 'Historical VaR, Conditional VaR (CVaR), Beta vs BTC, Sharpe and Sortino. Institutional risk metrics.',
        path: '/risk', color: AMBER },
      { icon: '🧬', label: '/intelligence — Intelligence Panel',
        desc: 'Exchange rankings, market volatility, opportunity lifecycle and predictions. Engine intelligence feed.',
        path: '/intelligence', color: GREEN },
      { icon: '📊', label: '/analytics — Price Analytics',
        desc: 'Historical price charts, max/min/avg by period, volume and return distribution per asset.',
        path: '/analytics', color: BLUE },
      { icon: '🌡️', label: '/heatmap — Performance Heatmap',
        desc: 'Return heatmap by asset and time period. Identify seasonal patterns and trending assets.',
        path: '/heatmap', color: PURPLE },
    ],
    action: 'See research modules →',
    color: INDIGO,
  },
  {
    id: 'screens_research',
    emoji: '🔬',
    title: 'Research Modules',
    subtitle: '"🔬 Research" sub-section within Quantitative Analysis',
    tabs: [
      { icon: '📉', label: '/analytics-ta — Technical Analysis',
        desc: 'RSI, MACD, Bollinger Bands with candlestick charts (lightweight-charts). Automatic technical signals.',
        path: '/analytics-ta', color: PINK },
      { icon: '🔭', label: '/forecast — Price Forecast',
        desc: 'Price projections using regression + GBM with 80% and 95% confidence intervals. 7/30/90-day horizon.',
        path: '/forecast', color: INDIGO },
      { icon: '🌀', label: '/regime — Market Regime',
        desc: 'Market regime detection: uptrend, downtrend or sideways range. Uses volatility and momentum signals.',
        path: '/regime', color: AMBER, badge: 'AI' },
      { icon: '🌐', label: '/galaxy — Correlation Galaxy',
        desc: 'Animated correlation network across crypto assets. Nodes move closer when assets are correlated.',
        path: '/galaxy', color: BLUE, badge: 'LIVE' },
      { icon: '🎲', label: '/montecarlo — Monte Carlo',
        desc: 'GBM simulation with 500+ price trajectories. Computes scenario distribution and return probabilities.',
        path: '/montecarlo', color: GREEN },
      { icon: '⏮️', label: '/backtest — Strategy Backtest',
        desc: 'Test trading strategies on historical data. Computes P&L, drawdown, win rate and performance metrics.',
        path: '/backtest', color: PURPLE },
    ],
    action: 'Open the engine →',
    color: PURPLE,
  },
];

function ArbDiagram() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0, padding: '16px 0', flexWrap: 'wrap' }}>
      <div style={{ background: 'rgba(240,185,11,0.08)', border: '1px solid rgba(240,185,11,0.3)', borderRadius: 12, padding: '14px 18px', textAlign: 'center', minWidth: 120 }}>
        <div style={{ fontSize: 10, color: '#F0B90B', fontWeight: 800, marginBottom: 6, letterSpacing: '0.08em' }}>BINANCE</div>
        <div style={{ fontSize: 22, fontWeight: 900, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>$70,000</div>
        <div style={{ marginTop: 8, background: '#F0B90B', color: '#000', fontWeight: 800, fontSize: 10, padding: '3px 10px', borderRadius: 99 }}>BUY ↑</div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>fee: $70.00</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 12px' }}>
        <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 2, fontWeight: 700 }}>GROSS SPREAD</div>
        <div style={{ fontSize: 18, color: PINK, fontWeight: 900, fontFamily: 'var(--font-mono)' }}>+$250</div>
        <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 1 }}>− fees $140.25</div>
        <div style={{ width: 40, height: 2, background: `linear-gradient(90deg,#F0B90B,${PINK})`, margin: '6px 0', borderRadius: 2 }} />
        <div style={{ fontSize: 14, color: GREEN, fontWeight: 900, fontFamily: 'var(--font-mono)' }}>= +$109.75</div>
        <div style={{ fontSize: 9, color: GREEN, marginTop: 1 }}>net profit</div>
      </div>

      <div style={{ background: 'rgba(87,65,217,0.08)', border: '1px solid rgba(87,65,217,0.3)', borderRadius: 12, padding: '14px 18px', textAlign: 'center', minWidth: 120 }}>
        <div style={{ fontSize: 10, color: INDIGO, fontWeight: 800, marginBottom: 6, letterSpacing: '0.08em' }}>KRAKEN</div>
        <div style={{ fontSize: 22, fontWeight: 900, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>$70,250</div>
        <div style={{ marginTop: 8, background: INDIGO, color: '#fff', fontWeight: 800, fontSize: 10, padding: '3px 10px', borderRadius: 99 }}>SELL ↓</div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4 }}>fee: $70.25</div>
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
              <div style={{ fontSize: 11, color: GREEN, fontWeight: 800, marginBottom: 3 }}>⚡ Pre-funded Bilateral Model</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>Wallets funded across all 5 exchanges from the start. Each trade executes buy and sell simultaneously — no inter-exchange transfers, no settlement delay.</div>
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
                  <strong style={{ color: INDIGO }}>Real break-even:</strong> 0.05 BTC at $100k → notional $5,000 → fees ≈$10 → slippage ≈$5 → requires spread &gt; 0.03% for positive net.
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
                ← Back
              </button>
            )}
            <button onClick={goNext} style={{
              flex: 1, background: `linear-gradient(135deg, ${s.color}, ${s.color}bb)`,
              color: '#fff', border: 'none', borderRadius: 10, padding: '11px 22px',
              fontWeight: 800, fontSize: 13, cursor: 'pointer',
              boxShadow: `0 4px 14px ${s.color}44`,
            }}>
              {s.id === 'screens_research' ? 'Open the engine →' : s.action}
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
            <span>Step {step + 1} of {STEPS.length}</span>
            <span>
              <kbd style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 4px', fontSize: 9 }}>←</kbd>
              {' '}<kbd style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 4px', fontSize: 9 }}>→</kbd>
              {' '}navigate · {' '}
              <kbd style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 4px', fontSize: 9 }}>Esc</kbd>
              {' '}close
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── DocsPage.jsx — Interactive Mathematical Documentation ───────────────
import { useState } from 'react';
import { PageHeader } from '../components/common/PageHeader';
import { useTranslation } from '../i18n/I18nContext';

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

const Prop = ({ name, weight, desc, color }) => (
  <div style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)', alignItems: 'flex-start' }}>
    <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: color || 'var(--color-primary)', background: `${color || 'var(--color-primary)'}12`, padding: '1px 7px', borderRadius: 4, flexShrink: 0 }}>{name}</code>
    {weight && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', background: 'var(--bg-surface-2)', padding: '2px 6px', borderRadius: 99, flexShrink: 0 }}>{weight}</span>}
    <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{desc}</span>
  </div>
);

// ─── API Reference component (Swagger-lite, sin deps externas) ──────────────

const METHOD_COLORS = {
  GET:    { bg: 'rgba(59,130,246,0.12)',  text: '#3b82f6' },
  POST:   { bg: 'rgba(0,184,122,0.12)',   text: '#00b87a' },
  PATCH:  { bg: 'rgba(245,158,11,0.12)',  text: '#f59e0b' },
  DELETE: { bg: 'rgba(240,62,62,0.12)',   text: '#f03e3e' },
};

function MethodBadge({ method }) {
  const c = METHOD_COLORS[method] || METHOD_COLORS.GET;
  return (
    <span style={{
      fontSize: 10, fontWeight: 800, letterSpacing: '0.05em',
      background: c.bg, color: c.text,
      padding: '2px 7px', borderRadius: 4, flexShrink: 0,
    }}>{method}</span>
  );
}

function EndpointRow({ method, path, desc, auth = true, params }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 0', cursor: 'pointer',
        }}
      >
        <MethodBadge method={method} />
        <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)', flex: 1 }}>{path}</code>
        {auth && (
          <span style={{ fontSize: 10, color: 'var(--text-dim)', background: 'var(--bg-surface-2)', padding: '1px 6px', borderRadius: 4, flexShrink: 0 }}>
            🔒 auth
          </span>
        )}
        <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 4 }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div style={{ padding: '0 0 14px 28px' }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, margin: '0 0 8px' }}>{desc}</p>
          {params && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {params.map(([name, type, required, d]) => (
                <div key={name} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11 }}>
                  <code style={{ fontFamily: 'var(--font-mono)', color: required ? '#FF2D78' : 'var(--color-primary)', minWidth: 120 }}>{name}</code>
                  <span style={{ color: 'var(--text-dim)', minWidth: 60 }}>{type}</span>
                  {required && <span style={{ color: '#FF2D78', fontWeight: 700, fontSize: 10 }}>required</span>}
                  <span style={{ color: 'var(--text-muted)' }}>{d}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ApiSection({ title, color, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{
        fontSize: 11, fontWeight: 800, color, textTransform: 'uppercase',
        letterSpacing: '0.08em', marginBottom: 4, paddingBottom: 8,
        borderBottom: `2px solid ${color}33`,
      }}>{title}</div>
      {children}
    </div>
  );
}

function ApiReferenceContent() {
  return (
    <>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 20 }}>
        Referencia curada de los endpoints principales de Kukora. Todos los endpoints
        protegidos requieren <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>Authorization: Bearer &lt;access_token&gt;</code>.
        Responses follow the envelope <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{'{ ok: true, data: ... }'}</code> on success and{' '}
        <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{'{ ok: false, error: "..." }'}</code> en error.
      </p>

      <ApiSection title="Auth  ·  /api/auth" color="#3b82f6">
        <EndpointRow method="POST" path="/api/auth/register" auth={false} desc="Registra un nuevo usuario. Devuelve accessToken + refreshToken (httpOnly cookie)."
          params={[['name','string',false,'Display name'],['email','string',true,'Unique email'],['password','string',true,'Minimum 8 characters']]} />
        <EndpointRow method="POST" path="/api/auth/login" auth={false} desc="Inicia sesión. Devuelve accessToken (JWT, 15min) + refreshToken en cookie httpOnly."
          params={[['email','string',true,''],['password','string',true,'']]} />
        <EndpointRow method="POST" path="/api/auth/refresh" auth={false} desc="Rota el refreshToken y devuelve un accessToken nuevo. Lee el RT desde la cookie httpOnly." />
        <EndpointRow method="POST" path="/api/auth/logout" desc="Invalida el refreshToken del usuario en base de datos." />
        <EndpointRow method="GET"  path="/api/auth/me" desc="Devuelve el perfil completo del usuario autenticado (sin passwordHash ni refreshTokenHash)." />
        <EndpointRow method="PATCH" path="/api/auth/me" desc="Actualiza campos del perfil. Whitelist: name, onboardingDone."
          params={[['name','string',false,'Display name'],['onboardingDone','boolean',false,'Marca el wizard de onboarding como completado']]} />
        <EndpointRow method="POST" path="/api/auth/change-password" desc="Cambia la contraseña. Exige la contraseña actual. Invalida el refreshToken (fuerza re-login)."
          params={[['currentPassword','string',true,''],['newPassword','string',true,'Minimum 8 characters']]} />
        <EndpointRow method="POST" path="/api/auth/stream-ticket" desc="Cambia el accessToken (enviado en el header Authorization) por un ticket efímero de un solo uso (TTL 30s), usado para autenticar conexiones SSE/EventSource — que no pueden enviar headers — sin nunca poner un JWT real en una URL." />
      </ApiSection>

      <ApiSection title="Notificaciones  ·  /api/notifications" color="#00b87a">
        <EndpointRow method="GET"  path="/api/notifications/stream" desc="SSE: stream de notificaciones en tiempo real. Auth via stream ticket de un solo uso (?ticket=, obtenido en POST /api/auth/stream-ticket) — EventSource no puede enviar headers, así que nunca se pone un JWT real en la URL. Emite frame init al conectar + eventos tipo 'notification' cuando el engine los genera." />
        <EndpointRow method="GET"  path="/api/notifications" desc="Historial paginado de notificaciones. Incluye unreadCount. Fallback a [] si Mongo no está disponible."
          params={[['limit','number',false,'Default 10, max 50'],['offset','number',false,'For pagination']]} />
        <EndpointRow method="PATCH" path="/api/notifications/:id/read" desc="Marca una notificación como leída por el usuario autenticado (sin afectar a otros usuarios — readBy es per-user)." />
        <EndpointRow method="POST" path="/api/notifications/read-all" desc="Marca todas las notificaciones del historial actual como leídas por el usuario autenticado." />
      </ApiSection>

      <ApiSection title="Arbitraje  ·  /api/arbitrage" color="#FF2D78">
        <EndpointRow method="GET"  path="/api/arbitrage/stream" desc="SSE principal del motor. Emite frame init (config, uptime, wallets) y ticks con oportunidades detectadas en tiempo real. Campo uptimeMs disponible en cada tick." />
        <EndpointRow method="GET"  path="/api/arbitrage/executive" desc="Snapshot ejecutivo completo: PnL, trades, success rate, uptime, exchange ranking, best opportunity seen, lifecycle summary. Fuente primaria para dashboards." />
        <EndpointRow method="GET"  path="/api/arbitrage/daily-stats" desc="Estadísticas diarias persistidas (Mongo con fallback a memoria). Devuelve array por día con { trades, pnl, bestOpp, isToday }."
          params={[['days','number',false,'Number of days to return. Default 7, max 30']]} />
        <EndpointRow method="GET"  path="/api/arbitrage/live" desc="Oportunidades vivas en este momento: order books procesados, spread calculado, viabilidad. Para debug y visualización en tiempo real." />
        <EndpointRow method="POST" path="/api/arbitrage/bot" desc="Activa o desactiva el bot de arbitraje."
          params={[['enabled','boolean',true,'true = enable, false = disable'],['minScore','number',false,'Override del threshold mínimo de score (0–100)']]} />
        <EndpointRow method="GET"  path="/api/arbitrage/wallets" desc="Estado actual de los wallets simulados por exchange (BTC y USDT)." />
        <EndpointRow method="GET"  path="/api/arbitrage/history" desc="Historial de trades ejecutados en la sesión. Incluye netProfit, fees, slippage, latency por trade." />
      </ApiSection>

      <ApiSection title="Configuración  ·  /api/arbitrage/config  +  /api/trading" color="#f59e0b">
        <EndpointRow method="GET"  path="/api/arbitrage/config" desc="Parámetros del engine en vivo: minNetProfitUSD, maxSpreadPct, circuit breakers, timeouts." />
        <EndpointRow method="POST" path="/api/arbitrage/config" desc="Actualiza parámetros en vivo sin reiniciar el engine. Cambios surten efecto inmediatamente."
          params={[['minNetProfitUSD','number',false,'Net profit floor per trade'],['maxSpreadPct','number',false,'Maximum spread considered viable'],['tradeAmountUSD','number',false,'Trade size in USDT']]} />
        <EndpointRow method="GET"  path="/api/trading/mode" desc="Modo activo del motor: 'paper' (simulado) o 'live'." />
        <EndpointRow method="POST" path="/api/trading/mode" desc="Cambia el modo del motor."
          params={[['mode','string',true,"'paper' | 'live'"]]} />
        <EndpointRow method="GET"  path="/api/trading/pairs" desc="Pares activos configurados para el motor." />
        <EndpointRow method="POST" path="/api/trading/pairs" desc="Reemplaza la lista de pares activos."
          params={[['pairs','string[]',true,"Ej: ['BTC/USDT','ETH/USDT']"]]} />
      </ApiSection>

      <ApiSection title="Analytics  ·  /api/arbitrage" color="#8b5cf6">
        <EndpointRow method="GET" path="/api/arbitrage/intelligence" desc="Intelligence report: detección de patrones de spread, correlación entre exchanges, predicción de próxima oportunidad." />
        <EndpointRow method="GET" path="/api/arbitrage/spread-heatmap" desc="Heatmap de spread promedio por par × exchange en las últimas N horas. Para identificar pares con mayor dispersión de precio." />
        <EndpointRow method="GET" path="/api/arbitrage/execution-quality" desc="Métricas de calidad de ejecución: fill rate, slippage real vs estimado, latencia percentile (p50/p95/p99)." />
        <EndpointRow method="GET" path="/api/arbitrage/arb-backtest/summary" desc="Resumen del último backtest de arbitraje ejecutado: total opps, win rate, Sharpe, max drawdown." />
      </ApiSection>
    </>
  );
}

const DOCS = [
  // ── SISTEMA DE ARBITRAJE ─────────────────────────────────────────────────
  {
    id: 'arb_cost_model', icon: '🧮', title: 'Model de Costos — Arbitraje Real',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          The most common mistake in arbitrage systems is calculating profit from gross spread. Kukora calculates net profit after all real execution costs. An opportunity that appears profitable on gross terms can be negative or marginal on net.
        </p>
        <Formula label="P&L neto por trade">
          {'grossProfit = (sellPrice − buyPrice) × amount\n'}
          {'buyFee      = buyPrice  × amount × TAKER_FEE[buyExchange]\n'}
          {'sellFee     = sellPrice × amount × TAKER_FEE[sellExchange]\n'}
          {'slippage    = VWAP_walk(orderBook, amount)   ← no un % fijo\n'}
          {'netProfit   = grossProfit − buyFee − sellFee − slippage'}
        </Formula>
        <div style={{ marginBottom: 14 }}>
          {[
            { name: 'Binance',  w: '0.10%', desc: 'Fee taker. Break-even minimum para par Binance↔Binance: 0.030% gross spread.', color: '#F0B90B' },
            { name: 'OKX',     w: '0.10%', desc: 'Fee taker. Mismo break-even que Binance en pares cruzados.', color: '#aaa' },
            { name: 'Bybit',   w: '0.10%', desc: 'Fee taker. Liquidity comparable a OKX en BTC/USDT.', color: '#F7A600' },
            { name: 'Kraken',  w: '0.26%', desc: 'Taker fee (level 0). Raises break-even to 0.046% — narrower opportunities are rarely executable.', color: '#5741D9' },
            { name: 'Coinbase',w: '0.60%', desc: 'Fee taker Advanced Trade. Binance↔Coinbase requiere >0.10% spread — raramente viable.', color: '#0052FF' },
          ].map(p => <Prop key={p.name} name={p.name} weight={p.w} desc={p.desc} color={p.color} />)}
        </div>
        <Formula label="Slippage VWAP (cuando hay datos L2)">
          {'Para un trade de Q BTC:\n'}
          {'consumed = 0 ; cost = 0\n'}
          {'for each level [price, qty] in orderBook.asks:\n'}
          {'  fill = min(qty, Q − consumed)\n'}
          {'  cost += fill × price\n'}
          {'  consumed += fill\n'}
          {'VWAP = cost / Q\n'}
          {'slippage = (VWAP − midPrice) × Q'}
        </Formula>
        <div style={{ padding: '12px 14px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text)' }}>Fallback when no L2 data available:</strong> slippage = 0.05% × amount × price. This is the conservative worst case. With real L2 data (Binance, OKX, Bybit), calculated slippage is typically lower.
        </div>
      </>
    ),
  },
  {
    id: 'arb_scoring', icon: '📊', title: 'Composite Opportunity Score (0–100)',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          No toda opportunity con netProfit {">"} 0 se ejecuta. El system calcula un composite score de 7 factores para priorizar las de mayor quality. Solo pasan al execution path las que superan el threshold configurado (default: 65).
        </p>
        <Formula label="Score compuesto">
          {'score = profScore×0.30 + liqScore×0.20 + persScore×0.20\n'}
          {'      + latScore×0.15 + confScore×0.15\n'}
          {'      − feePenalty − stalePenalty − reliabilityPenalty'}
        </Formula>
        <div style={{ marginBottom: 14 }}>
          {[
            { name: 'profScore (30%)',    w: '0–100', desc: 'How much the spread exceeds break-even. profScore = (netProfit / minNetProfit) × 30, capped at 100.', color: '#FF2D78' },
            { name: 'liqScore (20%)',     w: '0–100', desc: 'Fill probability × 100. Computed by fillProbabilityEngine from order book depth, feed latency and slippage method.', color: '#00b87a' },
            { name: 'persScore (20%)',    w: '0–100', desc: 'Persistence Z-score: how many consecutive ticks this opportunity has been detected. Signals reappearing across multiple ticks are more reliable.', color: '#3b82f6' },
            { name: 'latScore (15%)',     w: '0–100', desc: 'WS feed quality. Latency <20ms = 100. >300ms = 50. HTTP fallback = 20.', color: '#f59e0b' },
            { name: 'confScore (15%)',    w: '0–100', desc: 'fillProbabilityEngine confidence score — sum of depthScore + spreadScore + latencyScore + liquidityScore + volatilityScore.', color: '#8b5cf6' },
            { name: 'feePenalty (−5)',    w: '0 or 5', desc: 'Fixed penalty when either exchange is Coinbase (high fees reduce net reliability).', color: '#ff6b6b' },
            { name: 'stalePenalty (0–3)', w: '0–3',   desc: 'Feed staleness penalty. feedAgeMs > 3000ms: −3. > 1500ms: −1.', color: '#ff6b6b' },
            { name: 'reliabilityPenalty',w: '0–25',  desc: 'Dynamic penalty based on WS feed behavior over the last 5 min. Exchanges with frequent errors or high latency receive up to −25 points.', color: '#ff6b6b' },
          ].map(p => <Prop key={p.name} name={p.name} weight={p.w} desc={p.desc} color={p.color} />)}
        </div>
      </>
    ),
  },
  {
    id: 'arb_circuit_breakers', icon: '🛡️', title: 'Circuit Breakers — 5 Protection Levels',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          An opportunity may pass the positive netProfit calculation but still not be executable. Circuit breakers are structural conditions that invalidate execution regardless of profit.
        </p>
        {[
          { nivel: '1', label: 'Spread too narrow', formula: 'spreadPct < breakEvenPct', desc: 'Gross spread does not cover the fee + estimated slippage break-even. Execution would guarantee a net loss.' },
          { nivel: '2', label: 'Spread demasiado grande',  formula: 'spreadPct > MAX_SPREAD_PCT (4%)', desc: 'Un spread anormalmente grande (>4%) es signal de dato corrupto, feed con lag severo, o price fantasma. No es una opportunity real.' },
          { nivel: '3', label: 'Liquidity insuficiente',    formula: 'fillProbability < 0.50', desc: 'El order book no tiene suficiente profundidad para el tamyear de trade solicitado (default: 0.05 BTC). La probabilidad de fill completo es menor al 50%.' },
          { nivel: '4', label: 'Stale feed',               formula: 'feedAgeMs > STALE_FEED_MS (5000ms)', desc: 'Most recent price is over 5 seconds old without update. In 5 seconds BTC can move 0.1%+ — the opportunity may no longer exist.' },
          { nivel: '5', label: 'Daily loss stop',          formula: 'dailyPnl < MAX_DAILY_LOSS (−$500)', desc: 'Cumulative session losses exceed the limit. Engine pauses automatically until next session reset.' },
        ].map(cb => (
          <div key={cb.nivel} style={{ display: 'flex', gap: 14, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'rgba(240,62,62,0.1)', border: '1px solid rgba(240,62,62,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 900, color: 'var(--color-red)', flexShrink: 0 }}>{cb.nivel}</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 3 }}>{cb.label}</div>
              <code style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--color-primary)', background: 'var(--bg-surface-2)', padding: '2px 6px', borderRadius: 4 }}>{cb.formula}</code>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.5 }}>{cb.desc}</div>
            </div>
          </div>
        ))}
      </>
    ),
  },
  {
    id: 'arb_statarb', icon: '📈', title: 'StatArb — Log-Spread EWMA + AR(1) Half-Life',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          Statistical arbitrage detects when the spread between two exchanges diverges significantly from its historical mean, signaling a probable reversion. Kukora&apos;s implementation uses a mathematically correct model, unlike most implementations that use absolute price differences.
        </p>
        <Formula label="Why log-spread and NOT absolute price difference">
          {'INCORRECTO: signal = bid_B − ask_A  (en USD)\n'}
          {'  → No estacionario: si BTC sube de $60k a $100k,\n'}
          {'    el mismo spread de $280 representa 0.467% vs 0.280%\n\n'}
          {'CORRECTO: logSpread = log(bid_B / ask_A)  (adimensional)\n'}
          {'  → Estacionario: independing del nivel de price\n'}
          {'  → Institutional standard (Gatev, Goetzmann & Rouwenhorst 1999)'}
        </Formula>
        <Formula label="EWMA incremental (RiskMetrics, λ = 0.94)">
          {'μ_t = λ·μ_{t-1} + (1−λ)·logSpread_t\n'}
          {'σ²_t = λ·σ²_{t-1} + (1−λ)·(logSpread_t − μ_{t-1})²\n'}
          {'Z_t  = (logSpread_t − μ_t) / √σ²_t'}
        </Formula>
        <div style={{ padding: '12px 14px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 14 }}>
          <strong style={{ color: 'var(--text)' }}>λ = 0.94:</strong> standard RiskMetrics decay factor. Gives ~30 periods of effective half-life — more weight to recent data, gradually discards older observations. Update is O(1) per tick: no historical array iteration.
        </div>
        <Formula label="Half-life de mean-reversion via AR(1)">
          {'Regression: ΔS_t = α + β·S_{t-1} + ε\n'}
          {'halfLife = −ln(2) / ln(1 + β)\n\n'}
          {'β < 0: mean-reverting (valid for StatArb)\n'}
          {'β ≥ 0: trending (automatically disqualified)\n'}
          {'halfLife > 200 periods: descalificado (no cointegrado)'}
        </Formula>
        <Formula label="Threshold de signal">
          {'|Z| > 2.0 → signal   (ejecutable si viable)\n'}
          {'|Z| > 2.5 → signal fuerte (alta confidence)\n'}
          {'Additional confirmation: Bollinger %B on the series'}
        </Formula>
      </>
    ),
  },
  {
    id: 'arb_prefunded', icon: '💼', title: 'Pre-funded Model — Why Not Transfer Arbitrage',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          Two bilateral arbitrage archetypes exist: <strong>transfer arbitrage</strong> (buy on A, transfer to B, sell on B) and <strong>pre-funded arbitrage</strong> (wallets already funded on both exchanges). Kukora uses pre-funded because it is the only practical way to do Bitcoin arbitrage in 2024.
        </p>
        <div style={{ marginBottom: 14 }}>
          {[
            { name: 'Transfer Arb',  w: 'NOT viable', desc: 'Bitcoin on-chain confirmation: 10–60 minutes. An arbitrage opportunity disappears in seconds. By the time the transfer arrives, the spread has closed.', color: '#ff6b6b' },
            { name: 'Pre-funded',    w: '✓ Viable',  desc: 'Capital already positioned across all 5 exchanges. Buy and sell execute in parallel, no transfer wait. Execution latency: <100ms.', color: '#00b87a' },
          ].map(p => <Prop key={p.name} name={p.name} weight={p.w} desc={p.desc} color={p.color} />)}
        </div>
        <Formula label="Costo real del model pre-funded">
          {'Capital inmovilizado = Σ (BTC_i × btcPrice + USDT_i) por exchange\n'}
          {'  Default: 1 BTC + $110,000 USDT × 5 exchanges = ~$660k USD\n\n'}
          {'ROI real = profit_anualizado / capital_inmovilizado\n'}
          {'  (no sobre el profit por trade — visible en Capital Efficiency)'}
        </Formula>
        <Formula label="Periodic rebalancing">
          {'Con el tiempo: USDT fluye a "buy exchanges", BTC a "sell exchanges"\n'}
          {'Drift > 15% → rebalancing recommended\n'}
          {'Costo de rebalancing: withdrawal fees de BTC + slippage on-chain\n'}
          {'Estimated: $25–56 USD per round (2 exchanges involved)'}
        </Formula>
      </>
    ),
  },
  {
    id: 'arb_walkforward', icon: '🔭', title: 'Arb Backtest — Walk-Forward Validation',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          The arbitrage strategy backtest runs on the <strong>real opportunityLog</strong> from the current session — not on historical BTC prices. This is the critical distinction: backtesting an arbitrage strategy requires inter-exchange spread data, not BTC price itself.
        </p>
        <Formula label="Walk-forward validation">
          {'oppLog total: N entradas (con timestamps)\n'}
          {'Train set:    primeros 70% por tiempo\n'}
          {'Validate set: lasts 30% por tiempo\n\n'}
          {'Para cada (minScore, cooldownMs):\n'}
          {'  simulate(train)   → train metrics\n'}
          {'  simulate(validate) → out-of-sample metrics\n\n'}
          {'compositeScore = 0.4×pnl_val + 30×sharpe_val\n'}
          {'               + 0.3×captureRate_val − 2×maxDD_val\n'}
          {'Solo se reporta el out-of-sample — nunca el train solo.'}
        </Formula>
        <div style={{ padding: '12px 14px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text)' }}>Sharpe Stability:</strong> ratio validate_sharpe / train_sharpe. Cerca de 1.0 = parameters robustos (generalizan bien). {'<'}0.5 = posible overfitting al train set. {'>'} 1.0 = el model improvement out-of-sample (ideal pero raro).
        </div>
      </>
    ),
  },
  {
    id: 'gbm', icon: '⟳', title: 'Monte Carlo — Geometric Brownian Motion',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          The GBM model (Geometric Brownian Motion) is the standard in quantitative finance for modeling stochastic price trajectories. It assumes that logarithmic returns follow a Wiener process with constant drift.
        </p>
        <Formula label="Stochastic differential equation">
          dS = μS·dt + σS·dW
        </Formula>
        <Formula label="Analytical solution (discretized)">
          S(t+1) = S(t) · exp((μ - σ²/2)·Δt + σ·√Δt·Z)
        </Formula>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: 14 }}>
          Where <Code>μ</Code> is the drift (mean historical daily return), <Code>σ</Code> is volatility (standard deviation of returns), <Code>Δt = 1/252</Code> (trading days), and <Code>Z ~ N(0,1)</Code> is a standard normal random number.
        </div>
        <Formula label="Parameter estimation from historical data">
          μ = mean(ln(Sₜ/Sₜ₋₁)) · 252{'\n'}
          σ = std(ln(Sₜ/Sₜ₋₁)) · √252
        </Formula>
        <div style={{ padding: '12px 14px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text)' }}>Known limitations:</strong> GBM assumes log-normal return distribution and constant volatility. In practice, crypto assets exhibit fat tails, volatility clustering and discontinuous jumps. The model is useful as a probabilistic baseline, not a point predictor.
        </div>
      </>
    ),
  },
  {
    id: 'kcs', icon: '◈', title: 'KCS — Kukora Composite Signal',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          KCS is a proprietary multi-factor metric that aggregates 7 market dimensions into a single 0–100 score. Inspired by institutional indices such as CNN Money&apos;s Fear &amp; Greed and Bloomberg composite indicators.
        </p>
        <Formula label="Score compuesto ponderado">
          KCS = Σ (wᵢ · scoreᵢ)
        </Formula>
        <div style={{ marginBottom: 14 }}>
          {[
            { name: 'Momentum 7/14d', w: '20%', desc: 'Return relativo ponderado en ventanas de 7 y 14 days. 7d tiene peso 0.6, 14d tiene 0.4.', color: '#FF2D78' },
            { name: 'Volatility Stability', w: '15%', desc: 'score = 100 − σ_daily × 8. Mayor volatility = menor score. Penaliza incertidumbre.', color: '#f59e0b' },
            { name: 'Market Breadth', w: '15%', desc: '% de actives en positivo 24h. >50% = score > 50. Mide salud general del market.', color: '#3b82f6' },
            { name: 'Liquidity Flow', w: '20%', desc: 'Volume relativo vs media 7 days. score = (vol_today / vol_medio) × 50. Cap: 100.', color: '#00b87a' },
            { name: 'RSI Quality', w: '15%', desc: 'RSI 14 periods. Optimal zone 45–65 score=80. Extremes (>80 or <20) score=20–25.', color: '#8b5cf6' },
            { name: 'BTC Dominance', w: '10%', desc: 'Dom >60%: risk-off, score=25. Dom <40%: altseason, score=75. 50%: neutral, score=55.', color: '#F7931A' },
            { name: 'Sentiment', w: '5%', desc: 'Proxy de sentimiento basado en momentum normalizado. Puede alimentarse con datos externos.', color: '#06b6d4' },
          ].map(p => <Prop key={p.name} {...p} />)}
        </div>
        <div style={{ padding: '12px 14px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Score interpretation</div>
          {[['≥ 72','RISK ON — favorable conditions. Multiple signals converging positively.','var(--color-green)'],['55–71','CAUTIOUSLY BULLISH — moderate positive bias. Confirm breadth.','var(--color-blue)'],['45–54','EQUILIBRIUM — balanced signals. Wait for catalyst.','var(--color-yellow)'],['30–44','CAUTIOUSLY BEARISH — gradual deterioration. Reduce exposure.','#FF8C42'],['< 30','RISK OFF — adverse conditions. Preserve capital.','var(--color-red)']].map(([range,desc,color]) => (
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
          The Market Regime Engine classifies the market into one of 6 discrete states using a multi-signal scoring system. Each signal contributes points to the candidate regime; the one with the most weighted points wins.
        </p>
        <div style={{ marginBottom: 14 }}>
          {[
            { name: 'Volatility Normalizada', w: 'σ_recent / σ_hist', desc: '<0.75 = comprimida (apunta a Liquidity Compression). >1.4 = expandida (apunta a Volatile Uncertainty).', color: '#f59e0b' },
            { name: 'Trend MA', w: '(SMA10-SMA20)/SMA20', desc: '>0.3 → bullish. <−0.3 → bearish. Entre −0.2 y 0.2 → lateral.', color: '#3b82f6' },
            { name: 'Momentum 7/14d', w: 'ret7×0.6+ret14×0.4', desc: '>0.3 → positivo. <−0.3 → negativo. Amplifica o atenúa la signal de trend.', color: '#00b87a' },
            { name: 'Return Recent', w: 'Δ% of day', desc: '>3% → strong rise. <−3% → strong drop. Momentum confirmation signal.', color: '#FF2D78' },
          ].map(p => <Prop key={p.name} {...p} />)}
        </div>
        <Formula label="Scoring de regime (ejemplo: Bullish Expansion)">
          score_BULLISH = {'\n'}
          {'  '}(trend {'>'} 0.3 ? 40 : trend {'>'} 0.1 ? 20 : 0){'\n'}
          {'  '}+ (momentum {'>'} 0.3 ? 35 : momentum {'>'} 0.1 ? 15 : 0){'\n'}
          {'  '}+ (0.9 {'<'} normVol {'<'} 1.6 ? 15 : 0){'\n'}
          {'  '}+ (recentRet {'>'} 2 ? 10 : 0)
        </Formula>
        <Formula label="Confidence del model">
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
    id: 'backtest', icon: '◎', title: 'Backtest Engine — Strategys',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          The backtester simulates trading strategies on historical data with $10,000 initial capital. Includes 3 strategies and a Buy & Hold benchmark. Does not account for fees or slippage.
        </p>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>SMA Crossover</div>
          <Formula label="Signal de entrada">compra: SMA(10) cruza SMA(30) hacia arriba{'\n'}vende: SMA(10) cruza SMA(30) hacia abajo</Formula>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, marginTop: 14 }}>RSI Mean Reversion</div>
          <Formula label="Indicator RSI (Relative Strength Index)">
            RS = mean(gains, 14) / mean(losses, 14){'\n'}
            RSI = 100 − 100/(1+RS){'\n'}
            compra: RSI {'<'} 30 · vende: RSI {'>'} 70
          </Formula>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, marginTop: 14 }}>Bollinger Breakout</div>
          <Formula label="Bands de Bollinger (period 20, 2σ)">
            BB_upper = SMA(20) + 2·σ{'\n'}
            BB_lower = SMA(20) − 2·σ{'\n'}
            compra: price cruza BB_upper · vende: price toca SMA(20)
          </Formula>
        </div>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>Metrics de evaluation</div>
        {[
          ['Sharpe Ratio', 'Sharpe = (μ_portfolio − r_f) / σ_portfolio × √365', 'Compensación risk/return. {'>'} 1 es bueno, {'>'} 2 es excelente.'],
          ['Max Drawdown', 'MDD = max((peak − trough) / peak) × 100', 'Caída máxima since un pico. Mide el peor escenario histórico.'],
          ['Win Rate', 'WR = trades_ganadores / total_trades × 100', '% de operations cerradas con profit.'],
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
    id: 'risk', icon: '◉', title: 'Risk Engine — VaR & Metrics',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          The Risk Engine calculates standard quantitative finance risk metrics using the non-parametric historical method.
        </p>
        <Formula label="Historical Value at Risk (95%)">
          VaR₉₅ = −percentil(returns_diarios, 5) × capital
        </Formula>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.6 }}>
          Interpretation: &ldquo;There is a 5% probability of losing more than VaR₉₅ on any given day&rdquo;. Does not assume normal distribution — uses the empirical distribution of historical returns.
        </div>
        <Formula label="Beta vs BTC benchmark">
          β = Cov(r_asset, r_btc) / Var(r_btc)
        </Formula>
        <Formula label="Sortino Ratio (solo penaliza downside)">
          Sortino = (μ − r_f) / σ_downside{'\n'}
          σ_downside = std(min(r, 0))
        </Formula>
        <Formula label="Calmar Ratio">
          Calmar = return_anualizado / max_drawdown
        </Formula>
        <div style={{ padding: '12px 14px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text)' }}>Note on historical VaR:</strong> Unlike parametric VaR (which assumes normality), the historical method naturally captures fat tails and asymmetric distributions. However, it assumes the past is representative of the future — an important limitation with high-volatility assets like crypto.
        </div>
      </>
    ),
  },
  {
    id: 'forecast', icon: '◌', title: 'Forecast — Model Ensemble',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          The forecast model uses an ensemble of two methods that capture different components of the time series: short-term trend (SMA drift) and exponential smoothing (Holt-Winters EWM).
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
          Parameters: <Code>α = 0.3</Code> (level), <Code>β = 0.1</Code> (trend). The ensemble weights both models equally.
        </div>
        <Formula label="Interval de confidence 90%">
          IC₉₀ = Ŝ(t+h) ± 1.645 · σ_residual · √h
        </Formula>
        <div style={{ padding: '12px 14px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--text)' }}>Limitaciones:</strong> Los models de series temporales son susceptibles a changes estructurales abruptos (black swans). Los intervals de confidence asumen errores estacionarios. El forecast es indicativo, no predictivo.
        </div>
      </>
    ),
  },
  {
    id: 'anomaly', icon: '🚨', title: 'Anomaly Detection Engine',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 14 }}>
          The anomaly detector identifies statistically unusual behavior in price series using multiple metrics.
        </p>
        <Formula label="Z-score de return">
          z = (r_t − μ_returns) / σ_returns{'\n'}
          anomaly if |z| {'>'} 2.5
        </Formula>
        <Formula label="Volatility ratio">
          vr = σ_recent(7d) / σ_histórica{'\n'}
          spike si vr {'>'} 2.0
        </Formula>
        <div style={{ marginTop: 14 }}>
          {[['LOW (0–39)','Comportamiento normal dentro de rangos esperados.','var(--color-green)'],['MEDIUM (40–69)','Desviación noteble. Monitorear evolución.','var(--color-yellow)'],['HIGH (70–100)','Anomalía significativa. Probable evento de market.','var(--color-red)']].map(([level,desc,color]) => (
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
          Kukora está construido con un stack moderno orientado a performance y mantenibilidad.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[
            { label: 'Frontend', items: ['React 18 · Vite 5', 'Recharts (gráficas)', 'Lightweight Charts (OHLC)', 'react-hot-toast', 'react-router-dom v6'] },
            { label: 'Backend', items: ['Node.js + Express 4', 'Mongoose + MongoDB Atlas', 'express-rate-limit', 'CoinGecko Public API', 'Request queue (350ms/req)'] },
            { label: 'Models Cuantitativos', items: ['GBM (Monte Carlo)', 'SMA/EMA/RSI/Bollinger', 'Holt-Winters EWM Forecast', 'Market Regime Engine', 'KCS Composite Signal'] },
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
  {
    id: 'v16_arch', icon: '⚙️', title: 'Arquitectura v16 — Config en vivo · Rebalancing · Adversarial',
    content: () => (
      <>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.65, marginBottom: 16 }}>
          La version 16 agrega tres modules de production al engine existente, designed to address the platform&apos;s three core operational requirements with real, demonstrable evidence.
        </p>

        {/* liveConfig */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8, display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ background:'rgba(245,158,11,0.15)', color:'#F59E0B', padding:'2px 8px', borderRadius:4, fontSize:10 }}>CRITERIO #1</span>
            liveConfig.js — Configuration mutable en caliente
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 10 }}>
            10 parameters del engine de arbitraje cambiables since la UI sin reset Railway. El engine llama <code style={{ fontFamily:'var(--font-mono)', fontSize:11 }}>liveConfig.get(&apos;key&apos;)</code> en cada ciclo de 150ms — costo O(1), sin I/O.
          </p>
          {[
            ['minScore',            '0–100 pts',    'Puntuación mínima para execute un trade. Upload = filter trades marginales.'],
            ['tradeAmountBTC',      '0.001–0.5 BTC','Tamyear de position por trade. Afecta gross profit, fees y slippage.'],
            ['feeMode',             'taker|maker',  'Maker fees (0.01% Bybit) reducen el break-even ~60% vs taker (0.1%).'],
            ['minSpreadPct',        '0.0001–5%',    'Circuit breaker inferior: spreads menores a este valor se ignoran.'],
            ['maxSpreadPct',        '1–20%',        'Circuit breaker superior: spreads mayores indican feed obsoleto o error.'],
            ['maxDailyLossUSD',     '≤ 0 USD',      'El bot para cuando la loss diaria alcanza este threshold.'],
            ['cooldownMs',          '50–30000 ms',  'Minimum entre ejecuciones. Evita ráfagas de órdenes en volatility alta.'],
            ['minTriangularNetPct', '0.001–2%',     'Threshold para rutas triangulares. Baja = más opportunities detectadas.'],
            ['activeExchanges',     'array',        'Exchanges enableds para el engine bilateral. Coinbase se puede excluir por fees altos.'],
            ['minNetProfitUSD',     '0–100 USD',    'Profit neta mínima en USD. Upload en markets de alta volatility.'],
          ].map(([param, range, desc]) => (
            <div key={param} style={{ display:'flex', gap:10, padding:'6px 0', borderBottom:'1px solid var(--border)', alignItems:'flex-start' }}>
              <code style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'#F59E0B', flexShrink:0, width:160 }}>{param}</code>
              <code style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-dim)', flexShrink:0, width:100 }}>{range}</code>
              <span style={{ fontSize:11, color:'var(--text-muted)' }}>{desc}</span>
            </div>
          ))}
        </div>

        {/* rebalanceEngine */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8, display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ background:'rgba(0,184,122,0.12)', color:'var(--color-green)', padding:'2px 8px', borderRadius:4, fontSize:10 }}>CRITERIO #3</span>
            rebalanceEngine.js — Rebalancing automatic inteligente
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 10 }}>
            Detecta desbalances entre exchanges y calcula el movimiento optimal con costos reales. Simulated execution que actualiza los wallets internos.
          </p>
          {[
            ['analyzeBalance(btcPrice)',       'Detecta concentración USDT >70% o déficit BTC <10% por exchange. Devuelve imbalances[] con severidad.'],
            ['suggestRebalance(btcPrice)',      'Calcula amount optimal a mover, exchange origen/destino, costo real (withdrawal fee + spread 0.1%) y beneficio neto estimado.'],
            ['executeRebalance(suggestion)',    'Simula la execution: descuenta del exchange origen, acredita al destino, persiste en history. Solo actúa si netBenefit > $25.'],
          ].map(([fn, desc]) => (
            <div key={fn} style={{ display:'flex', gap:10, padding:'7px 0', borderBottom:'1px solid var(--border)', alignItems:'flex-start' }}>
              <code style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--color-green)', flexShrink:0, width:200 }}>{fn}</code>
              <span style={{ fontSize:11, color:'var(--text-muted)' }}>{desc}</span>
            </div>
          ))}
        </div>

        {/* adversarialScenarios */}
        <div>
          <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8, display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ background:'rgba(240,62,62,0.12)', color:'var(--color-red)', padding:'2px 8px', borderRadius:4, fontSize:10 }}>CRITERIO #2</span>
            adversarialScenarios.js — Escenarios adversos profundos
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 10 }}>
            Tres simulaciones de fallos reales durante la execution. Cada escenario emite fases{' '}
            <code style={{ fontFamily:'var(--font-mono)', fontSize:11 }}>{'{phase, action, data}'}</code>{' '}
            visibles in real time en la UI con decisión del system documentada.
          </p>
          {[
            ['mid_flight_failure',  'Compra ejecutada, venta timeout 3000ms. System detecta position descubierta, calcula risk de market (P&L si el price cae 1%/3%), evalúa 3 opciones de salida y decide según threshold de loss.'],
            ['liquidity_crunch',    'Libro L2 pierde 60% de profundidad durante el fill. VWAP walk recalcula partial fill (fillable < requested). System evalúa si el P&L degradado sigue superando minNetProfitUSD.'],
            ['extreme_slippage',    'BTC sube 1.2% durante el fill. Compara slippage estimado (0.05%) vs real (1.2%). Evalúa si el circuit breaker de maxSpreadPct habría cancelado el trade. Muestra qué parameters de liveConfig habrían mitigado el dyear.'],
          ].map(([id, desc]) => (
            <div key={id} style={{ display:'flex', gap:10, padding:'7px 0', borderBottom:'1px solid var(--border)', alignItems:'flex-start' }}>
              <code style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--color-red)', flexShrink:0, width:180 }}>{id}</code>
              <span style={{ fontSize:11, color:'var(--text-muted)' }}>{desc}</span>
            </div>
          ))}
          <div style={{ marginTop:12, padding:'10px 12px', background:'rgba(88,65,217,0.06)', border:'1px solid rgba(88,65,217,0.2)', borderRadius:'var(--radius)', fontSize:11, color:'var(--text-muted)', lineHeight:1.6 }}>
            <strong style={{ color:'var(--text)' }}>Vinculación pedagógica:</strong> el escenario <code style={{ fontFamily:'var(--font-mono)', fontSize:10 }}>extreme_slippage</code> muestra explícitamente qué parameters del Panel de Control (minNetProfitUSD, maxSpreadPct) habrían activado el circuit breaker antes. 
          </div>
        </div>
      </>
    ),
  },
  {
    id: 'api_reference', icon: '🔌', title: 'API Reference',
    content: () => <ApiReferenceContent />,
  },
];

export default function DocsPage() {
  const { t } = useTranslation();
  const [active, setActive] = useState('gbm');

  return (
    <div className="page-enter">
      <PageHeader
        title={t('nav.docs')}
        description="Models matemáticos, fórmulas y fundamentos cuantitativos detrás de Kukora"
        help="Esta documentación demuestra el rigor matemático del system. Cada model tiene sus fórmulas, limitaciones y contexto."
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
/**
 * SpeedBenchmarkPanel.jsx — Kukora
 *
 * Improvement #2: "Speed benchmark in real time". Convierte la arquitectura
 * event-driven en algo que  lo que un poller REST de
 * 800ms (documented standard) would have taken at that same
 * instant. When a viable opportunity is active, highlights in red how much
 * additional time a polling bot would have taken to detect it.
 */
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';

const EX_COLORS = { Binance: '#F0B90B', Kraken: '#5741D9', Bybit: '#F7A600', Coinbase: '#0052FF', OKX: '#aaa' };

function ExBar({ exchange, data, maxMs }) {
  if (!data) return null;
  const { wsLatencyMs, pollingDelayMs, advantageMs, isEventDriven } = data;
  const wsWidthPct = Math.min(100, (wsLatencyMs / maxMs) * 100);
  const pollWidthPct = Math.min(100, (pollingDelayMs / maxMs) * 100);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 70, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: EX_COLORS[exchange] || '#999' }} />
          {exchange}
        </span>
        {!isEventDriven && (
          <span style={{ fontSize: 9, color: 'var(--text-dim)', background: 'var(--bg-surface-2)', padding: '1px 6px', borderRadius: 4 }}>HTTP fallback</span>
        )}
      </div>

      {/* WS bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 70, fontSize: 9, color: 'var(--color-green)', fontWeight: 700 }}>Kukora WS</span>
        <div style={{ flex: 1, height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ width: `${Math.max(2, wsWidthPct)}%`, height: '100%', background: 'var(--color-green)', transition: 'width 0.3s' }} />
        </div>
        <span style={{ width: 56, fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 800, color: 'var(--color-green)', textAlign: 'right' }}>{wsLatencyMs}ms</span>
      </div>

      {/* Polling bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 70, fontSize: 9, color: 'var(--color-red)', fontWeight: 700 }}>Polling 800ms</span>
        <div style={{ flex: 1, height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ width: `${Math.max(2, pollWidthPct)}%`, height: '100%', background: 'var(--color-red)', opacity: 0.6, transition: 'width 0.3s' }} />
        </div>
        <span style={{ width: 56, fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 800, color: 'var(--color-red)', textAlign: 'right' }}>{pollingDelayMs}ms</span>
      </div>

      {isEventDriven && advantageMs > 0 && (
        <div style={{ fontSize: 10, color: 'var(--color-red)', fontWeight: 700, paddingLeft: 78 }}>
          ⚡ Polling would have arrived {advantageMs}ms later
        </div>
      )}
    </div>
  );
}

export default function SpeedBenchmarkPanel({ data }) {
  const benchmark = data?.speedBenchmark;
  const history    = data?.speedBenchmarkHistory || [];
  const opportunities = data?.opportunities || [];
  const topViable = opportunities.find(o => o.viable);

  if (!benchmark) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>Calculando benchmark…</div>;
  }

  const perExchange = benchmark.perExchange || {};
  const allLatencies = Object.values(perExchange).flatMap(d => [d.wsLatencyMs, d.pollingDelayMs]);
  const maxMs = Math.max(400, ...allLatencies);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 18px',
        background: 'linear-gradient(135deg, rgba(255,45,120,0.06), rgba(88,65,217,0.06))',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', flexWrap: 'wrap', gap: 10,
      }}>
        <div>
          <div style={{ fontWeight: 900, fontSize: 16, letterSpacing: '-0.02em' }}>⚡ Speed Benchmark en Vivo</div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
            Latency real medida por WebSocket vs. polling REST simulado cada {benchmark.pollingIntervalMs}ms
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 22, fontWeight: 900, fontFamily: 'var(--font-mono)', color: 'var(--color-green)' }}>
            +{benchmark.avgAdvantageMs}ms
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>ventaja average</div>
        </div>
      </div>

      {/* Top opportunity callout */}
      {topViable && (
        <div style={{
          padding: '10px 16px', background: 'rgba(240,62,62,0.06)', border: '1px solid rgba(240,62,62,0.25)',
          borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--text)',
        }}>
          <b style={{ color: 'var(--color-red)' }}>Opportunity activa ahour:</b> {topViable.buyExchange} → {topViable.sellExchange}.
          An 800ms polling bot would have had, on average, an additional delay of{' '}
          <b style={{ fontFamily: 'var(--font-mono)' }}>{benchmark.pollingAvgWaitMs}ms</b> solo por el interval de muestreo,
          antes de sumar la latency de red propia de cada exchange.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Per-exchange bars */}
        <div className="card" style={{ padding: '12px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Por exchange
          </div>
          {Object.keys(perExchange).length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>No data yet…</div>
          )}
          {Object.entries(perExchange).map(([ex, d]) => (
            <ExBar key={ex} exchange={ex} data={d} maxMs={maxMs} />
          ))}
        </div>

        {/* Live history chart */}
        <div className="card" style={{ padding: '12px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Latency WS — lasts minutes
          </div>
          {history.length < 2 ? (
            <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
              Acumulando muestras…
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={history} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="ts" tickFormatter={ts => new Date(ts).toLocaleTimeString('es-MX', { minute: '2-digit', second: '2-digit' })} tick={{ fontSize: 8, fill: 'var(--text-dim)' }} />
                <YAxis tick={{ fontSize: 9, fill: 'var(--text-dim)' }} tickFormatter={v => `${v}ms`} width={40} />
                <Tooltip
                  contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }}
                  labelFormatter={ts => new Date(ts).toLocaleTimeString('es-MX')}
                  formatter={(v, n) => [`${v}ms`, n]}
                />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {Object.keys(EX_COLORS).map(ex => (
                  <Line key={ex} type="monotone" dataKey={ex} stroke={EX_COLORS[ex]} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div style={{ fontSize: 10, color: 'var(--text-dim)', fontStyle: 'italic', padding: '0 4px' }}>
        Metodología: la latency WS es el delta real entre el timestamp que el exchange incluye en su mensaje y el momento en que Kukora lo procesa.
        El retraso de polling simula un poller REST de {benchmark.pollingIntervalMs}ms usando el tiempo de espera average esperado (mitad del interval) más la latency de red medida — no es una cifra inventada, es el model estándar de espera para sondeos a interval fijo.
      </div>
    </div>
  );
}

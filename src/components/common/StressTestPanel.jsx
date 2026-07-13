/**
 * StressTestPanel.jsx — Kukora
 *
 * Improvement #9: "Stress test mode". Activa escenarios adversos REALES —
 * the detection/circuit-breaker engine processes exactly the same logic
 * as in production, just with order books intentionally transformed.
 */
import { useState, useEffect } from 'react';
import { requestArbitrage } from '../../api';

const FALLBACK_EXCHANGES = ['Binance', 'Kraken', 'Bybit', 'OKX', 'Coinbase'];

// postJSON replaced by requestArbitrage from api.js (injects auth + retry)

export default function StressTestPanel({ data }) {
  const [exchange, setExchange] = useState('Binance');
  const [multiplier, setMultiplier] = useState(2);
  const [dropPct, setDropPct] = useState(3);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [allExchanges, setAllExchanges] = useState(FALLBACK_EXCHANGES);

  useEffect(() => {
    requestArbitrage('config')
      .then(j => {
        const exList = j?.schema?.activeExchanges?.options;
        if (Array.isArray(exList) && exList.length > 0) setAllExchanges(exList);
      })
      .catch(() => {});
  }, []);

  const activeScenario = data?.stressTest;
  const opportunities = data?.opportunities || [];
  const viableCount = opportunities.filter(o => o.viable).length;
  const circuitBreakerCount = opportunities.filter(o => o.circuitBreaker).length;

  const activate = async (type, params) => {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await requestArbitrage('stress-test/activate', { method: 'POST', body: { type, ...params } });
      if (!result.ok) setFeedback({ type: 'error', msg: result.reason || 'Error al activar el escenario' });
      else setFeedback({ type: 'success', msg: `Escenario "${result.scenario.label}" activado` });
    } catch {
      setFeedback({ type: 'error', msg: 'No se pudo conectar con el servidor' });
    } finally { setBusy(false); }
  };

  const deactivate = async () => {
    setBusy(true);
    try {
      await requestArbitrage('stress-test/deactivate', { method: 'POST' });
      setFeedback({ type: 'success', msg: 'Escenario desactivado — vuelta a operation normal' });
    } catch {
      setFeedback({ type: 'error', msg: 'No se pudo desactivar' });
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        padding: '12px 18px',
        background: 'linear-gradient(135deg, rgba(240,62,62,0.07), rgba(245,158,11,0.05))',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
      }}>
        <div style={{ fontWeight: 900, fontSize: 16, letterSpacing: '-0.02em' }}>🧪 Stress Test Mode</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
          These scenarios feed the REAL engine with modified data — not theater, it is the same circuit breaker and viability logic reacting live.
        </div>
      </div>

      {activeScenario ? (
        <div style={{
          padding: '14px 18px', borderRadius: 'var(--radius-lg)',
          background: 'rgba(240,62,62,0.08)', border: '1px solid rgba(240,62,62,0.3)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10,
        }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--color-red)' }}>⚠ ESCENARIO ACTIVO: {activeScenario.label}</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
              Asset since hace {Math.round(activeScenario.activeForMs / 1000)}s
              {activeScenario.params?.exchange && <> · Exchange: <b>{activeScenario.params.exchange}</b></>}
              {activeScenario.feeMultiplier > 1 && <> · Fees ×{activeScenario.feeMultiplier}</>}
            </div>
          </div>
          <button disabled={busy} onClick={deactivate} style={{
            background: 'var(--color-red)', color: '#fff', border: 'none', borderRadius: 8,
            padding: '8px 16px', fontWeight: 800, fontSize: 12, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
          }}>
            Desactivar y back a la normalidad
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {/* Exchange down */}
          <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontWeight: 800, fontSize: 13 }}>📡 ¿Qué pasa si {exchange} cae?</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Simulates total disconnection of an exchange — removes it from the feed, as would happen if its WebSocket dropped.</div>
            <select value={exchange} onChange={e => setExchange(e.target.value)} style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-surface)', fontSize: 12 }}>
              {allExchanges.map(ex => <option key={ex} value={ex}>{ex}</option>)}
            </select>
            <button disabled={busy} onClick={() => activate('exchange_down', { exchange })} style={{
              background: 'var(--bg-surface-3)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '8px 12px', fontWeight: 700, fontSize: 12, cursor: busy ? 'not-allowed' : 'pointer',
            }}>
              Simulate caída
            </button>
          </div>

          {/* Fee spike */}
          <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontWeight: 800, fontSize: 13 }}>💸 ¿Y si los fees suben?</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Multiplies trading fees on all exchanges, live, to see how many opportunities become non-viable.</div>
            <select value={multiplier} onChange={e => setMultiplier(Number(e.target.value))} style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-surface)', fontSize: 12 }}>
              <option value={1.5}>×1.5 (fees +50%)</option>
              <option value={2}>×2 (fees al doble)</option>
              <option value={3}>×3 (fees al triple)</option>
            </select>
            <button disabled={busy} onClick={() => activate('fee_spike', { multiplier })} style={{
              background: 'var(--bg-surface-3)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '8px 12px', fontWeight: 700, fontSize: 12, cursor: busy ? 'not-allowed' : 'pointer',
            }}>
              Simulate alza de fees
            </button>
          </div>

          {/* Flash crash */}
          <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontWeight: 800, fontSize: 13 }}>📉 ¿Y si hay un flash crash?</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Applies a sudden price drop on one exchange — tests the excessive-spread circuit breaker.</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={exchange} onChange={e => setExchange(e.target.value)} style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-surface)', fontSize: 12 }}>
                {allExchanges.map(ex => <option key={ex} value={ex}>{ex}</option>)}
              </select>
              <select value={dropPct} onChange={e => setDropPct(Number(e.target.value))} style={{ width: 70, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-surface)', fontSize: 12 }}>
                <option value={1}>-1%</option>
                <option value={3}>-3%</option>
                <option value={5}>-5%</option>
              </select>
            </div>
            <button disabled={busy} onClick={() => activate('flash_crash', { exchange, dropPct })} style={{
              background: 'var(--bg-surface-3)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '8px 12px', fontWeight: 700, fontSize: 12, cursor: busy ? 'not-allowed' : 'pointer',
            }}>
              Simulate flash crash
            </button>
          </div>
        </div>
      )}

      {feedback && (
        <div style={{ fontSize: 12, padding: '8px 14px', borderRadius: 8, color: feedback.type === 'error' ? 'var(--color-red)' : 'var(--color-green)', background: feedback.type === 'error' ? 'rgba(240,62,62,0.06)' : 'rgba(0,184,122,0.06)' }}>
          {feedback.type === 'error' ? '✕ ' : '✓ '}{feedback.msg}
        </div>
      )}

      {/* Live reaction readout */}
      <div className="card" style={{ padding: '14px 18px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
          Reacción del engine en vivo
        </div>
        <div style={{ display: 'flex', gap: 24 }}>
          <div>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', fontWeight: 700 }}>Opportunities viables</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 900, fontSize: 22, color: viableCount > 0 ? 'var(--color-green)' : 'var(--text-dim)' }}>{viableCount}</div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', fontWeight: 700 }}>Circuit breakers actives</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 900, fontSize: 22, color: circuitBreakerCount > 0 ? 'var(--color-red)' : 'var(--text-dim)' }}>{circuitBreakerCount}</div>
          </div>
          <div>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', fontWeight: 700 }}>Exchanges reportando</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 900, fontSize: 22 }}>{data?.orderBooks?.filter(o => !o.error).length ?? '—'}/5</div>
          </div>
        </div>
      </div>
    </div>
  );
}

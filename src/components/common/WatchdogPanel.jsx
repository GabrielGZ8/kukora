/**
 * WatchdogPanel.jsx — Kukora
 * Salud del proceso: uptime, memoria, exchange staleness,
 * history completo de alerts operationales.
 */
import { requestArbitrage } from '../../api';
import { useState, useEffect } from 'react';
import { useAuth } from '../../state/AuthContext';

const SEV_COLOR = { critical: '#ef4444', warn: '#f59e0b', info: '#00b87a', debug: '#64748b' };
const SEV_ICON  = { critical: '🚨', warn: '⚠️', info: 'ℹ️', debug: '🔹' };

// ─── Circuit breaker control (auditoría comité, Sesión 34, P0 #2) ─────────
// Antes de esta sesión, /api/arbitrage/risk/status y
// POST /risk/circuit-breaker/reset existían en el backend pero ningún
// componente de la UI los consumía — eran endpoints "decorativos", solo
// alcanzables vía curl/Postman. Este componente los conecta de verdad:
// muestra el estado real del circuit breaker (activo/inactivo, motivo,
// drawdown actual) y da a un operador admin dos acciones reales — resetear
// un breaker ya disparado, o dispararlo manualmente (kill switch) ANTES de
// que un trigger automático (drawdown/daily-loss/fallas consecutivas) lo
// detecte solo.
function CircuitBreakerControl() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [risk, setRisk]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [busy, setBusy]         = useState(false);
  const [reason, setReason]     = useState('');
  const [msg, setMsg]           = useState(null);

  const refresh = () => {
    requestArbitrage('risk/status')
      .then(j => setRisk(j?.data || null))
      .catch(() => setRisk(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); const id = setInterval(refresh, 10_000); return () => clearInterval(id); }, []);

  const cb = risk?.circuitBreaker;
  const active = !!cb?.active;

  const doReset = async () => {
    setBusy(true); setMsg(null);
    try {
      await requestArbitrage('risk/circuit-breaker/reset', { method: 'POST' });
      setMsg({ ok: true, text: 'Circuit breaker reseteado.' });
      refresh();
    } catch (e) {
      setMsg({ ok: false, text: e.message || 'Error al resetear.' });
    } finally { setBusy(false); }
  };

  const doActivate = async () => {
    if (reason.trim().length < 3) {
      setMsg({ ok: false, text: 'El motivo debe tener al menos 3 caracteres — un kill switch sin motivo registrado no es auditable.' });
      return;
    }
    setBusy(true); setMsg(null);
    try {
      const j = await requestArbitrage('risk/circuit-breaker/activate', { method: 'POST', body: { reason } });
      setMsg({
        ok: true,
        text: j?.data?.alreadyActive
          ? `Ya estaba activo (motivo original: "${j.data.reason}").`
          : 'Sistema detenido manualmente. Requiere reset explícito para reanudar.',
      });
      setReason('');
      refresh();
    } catch (e) {
      setMsg({ ok: false, text: e.message || 'Error al activar el kill switch.' });
    } finally { setBusy(false); }
  };

  return (
    <div style={{ background: 'var(--bg-elevated)', border: `1px solid ${active ? 'rgba(239,68,68,0.4)' : 'var(--border)'}`, borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>{active ? '🔴' : '🟢'}</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 12 }}>Circuit Breaker</div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
              {loading ? 'Cargando…' : active ? `ACTIVO — ${cb.reason || 'sin motivo registrado'}` : 'Inactivo — sistema operando normalmente'}
            </div>
          </div>
        </div>
        {risk?.drawdown && (
          <div style={{ fontSize: 10, color: 'var(--text-dim)', textAlign: 'right' }}>
            Drawdown: <b style={{ color: 'var(--text)' }}>{risk.drawdown.pct ?? '—'}%</b> / máx {risk.drawdown.maxAllowedPct}%
          </div>
        )}
      </div>

      {!isAdmin && (
        <div style={{ fontSize: 10, color: 'var(--text-dim)', opacity: 0.7 }}>
          Solo un usuario con rol admin puede resetear o activar el circuit breaker manualmente.
        </div>
      )}

      {isAdmin && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {active ? (
            <button
              onClick={doReset}
              disabled={busy}
              style={{ alignSelf: 'flex-start', background: 'var(--accent, #00b87a)', color: '#04140d', border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 11, fontWeight: 800, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}
            >
              {busy ? 'Reseteando…' : '↺ Resetear circuit breaker'}
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="text"
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="Motivo del halt manual (obligatorio, min. 3 caracteres)"
                style={{ flex: '1 1 260px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', fontSize: 11, color: 'var(--text)' }}
              />
              <button
                onClick={doActivate}
                disabled={busy}
                style={{ background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 14px', fontSize: 11, fontWeight: 800, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1, whiteSpace: 'nowrap' }}
              >
                {busy ? 'Deteniendo…' : '🛑 Kill switch — detener ahora'}
              </button>
            </div>
          )}
          {msg && (
            <div style={{ fontSize: 10, color: msg.ok ? 'var(--accent, #00b87a)' : '#ef4444' }}>{msg.text}</div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color, sub }) {
  return (
    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 800, fontSize: 15, color: color || 'var(--text)' }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 9, color: 'var(--text-dim)', opacity: 0.6, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function WatchdogPanel() {
  const [status, setStatus]   = useState(null);
  const [alerts, setAlerts]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter]   = useState('all');

  const refresh = () => {
    Promise.all([
      requestArbitrage('watchdog/status').catch(() => null),
      requestArbitrage('alerts/history?limit=50').catch(() => null),
    ]).then(([s, a]) => {
      if (s) setStatus(s);
      if (a?.history) setAlerts(a.history);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(() => { refresh(); const id = setInterval(refresh, 15_000); return () => clearInterval(id); }, []);

  const filtered = filter === 'all' ? alerts : alerts.filter(a => a.severity === filter);
  const critCount = alerts.filter(a => a.severity === 'critical').length;
  const warnCount = alerts.filter(a => a.severity === 'warn').length;

  if (loading) return <div style={{ padding: 20, fontSize: 12, color: 'var(--text-dim)' }}>Loading status del watchdog…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* ── NARRATIVE HEADER ──────────────────────────────────────────────── */}
      <div style={{ background:'rgba(255,45,120,0.06)', border:'1px solid rgba(255,45,120,0.18)', borderRadius:10, padding:'12px 16px', display:'flex', alignItems:'flex-start', gap:12 }}>
        <div style={{ fontSize:22, flexShrink:0 }}>🛡</div>
        <div>
          <div style={{ fontWeight:800, fontSize:13, marginBottom:2 }}>Risk & Salud del System</div>
          <div style={{ fontSize:11, color:'var(--text-dim)', lineHeight:1.5 }}>
            Operational protection layer for the arbitrage engine. Monitors active circuit breakers, stale feeds, disconnected exchanges, real-time drawdown and high latency. A single downed exchange or stale feed can cause the engine to execute at incorrect prices — this panel is the first place to check when something fails.
          </div>
        </div>
      </div>

      {/* Circuit breaker control — real kill switch, wired to /risk/status */}
      <CircuitBreakerControl />

      {/* Process health */}
      {status && (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: 13 }}>🐕 Watchdog — Salud del Proceso</div>
              <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 2 }}>{status.hostname} · PID {status.pid} · {status.nodeVersion}</div>
            </div>
            <button onClick={refresh} style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, padding: '5px 12px', fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', cursor: 'pointer' }}>
              ↻ Refresh
            </button>
          </div>

          <div style={{ padding: '14px 16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 8, marginBottom: 14 }}>
              <StatCard label="Uptime"       value={status.uptimeHuman}                    color="#00b87a" />
              <StatCard label="Heap Memory"  value={`${status.memory?.heapMB}MB`}          color={status.memory?.heapMB > status.memory?.warnMB ? '#f59e0b' : '#00b87a'} sub={`warn >${status.memory?.warnMB}MB`} />
              <StatCard label="RSS Memory"   value={`${status.memory?.rssMB}MB`}           color="#94a3b8" />
              <StatCard label="Exchanges"    value={status.exchanges?.healthy ? '✓ All healthy' : `⚠ ${status.exchanges?.stale?.length} stale`} color={status.exchanges?.healthy ? '#00b87a' : '#f59e0b'} />
              <StatCard label="Last HB"    value={new Date(status.lastHeartbeatTs).toLocaleTimeString()} color="#94a3b8" sub="heartbeat" />
              <StatCard label="Status"       value={status.isShuttingDown ? '⛔ Shutting down' : '✓ Running'} color={status.isShuttingDown ? '#ef4444' : '#00b87a'} />
            </div>

            {/* Stale exchanges */}
            {status.exchanges?.stale?.length > 0 && (
              <div style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', marginBottom: 6 }}>⚠ Feeds Stale (sin update)</div>
                {status.exchanges.stale.map(e => (
                  <div key={e.exchange} style={{ fontSize: 11, color: 'var(--text-dim)', padding: '2px 0' }}>
                    <span style={{ color: '#f59e0b', fontWeight: 700 }}>{e.exchange}</span>: {e.offlineSecs}s no data
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Alert history */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 13 }}>🔔 History de Alerts</div>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 2 }}>
              {critCount > 0 && <span style={{ color: '#ef4444', fontWeight: 700, marginRight: 8 }}>🚨 {critCount} critical</span>}
              {warnCount > 0 && <span style={{ color: '#f59e0b', fontWeight: 700, marginRight: 8 }}>⚠️ {warnCount} warnings</span>}
              {alerts.length} total
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {['all', 'critical', 'warn', 'info'].map(f => (
              <button key={f} onClick={() => setFilter(f)} style={{
                background: filter === f ? 'var(--bg-surface)' : 'transparent',
                border: `1px solid ${filter === f ? 'var(--border)' : 'transparent'}`,
                borderRadius: 6, padding: '3px 10px', fontSize: 9, fontWeight: 700,
                color: filter === f ? 'var(--text)' : 'var(--text-dim)', cursor: 'pointer',
              }}>
                {f === 'all' ? 'Todas' : f}
              </button>
            ))}
          </div>
        </div>

        <div style={{ padding: '0 16px' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '16px 0', fontSize: 11, color: 'var(--text-dim)' }}>
              {alerts.length === 0 ? 'No alerts in this session. All systems nominal.' : 'No alerts match this filter.'}
            </div>
          ) : (
            filtered.map((a, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 0', borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none' }}>
                <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>{SEV_ICON[a.severity] || 'ℹ️'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: SEV_COLOR[a.severity] || 'var(--text)' }}>{a.title}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 3 }}>
                    <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{new Date(a.ts).toLocaleString()}</span>
                    <span style={{ fontSize: 9, color: 'var(--text-dim)', fontFamily: 'monospace' }}>{a.event}</span>
                    <span style={{ fontSize: 9, fontWeight: 700, color: a.sent ? '#00b87a' : '#64748b' }}>
                      {a.sent ? '✓ Sent' : '— Not sent'}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * TenantComparisonPage.jsx — Kukora
 *
 * Iniciativa 4 del plan competitivo: demo visual de la infraestructura
 * multi-tenant (tenantBotState/tenantConfig/tenantExecution/tenantRiskGuard,
 * ADR-017) — dos tenants sintéticos con perfiles de riesgo opuestos,
 * corriendo sobre el MISMO motor de ejecución real de 150ms que usaría
 * cualquier usuario real. No hay simulación paralela: prender la demo
 * aquí es exactamente lo mismo que dos usuarios reales prendiendo su bot
 * desde /api/tenant-bot/toggle, con overrides de config distintos.
 */
import { useState, useEffect, useCallback } from 'react';
import { api, ApiError } from '../api';

const fmtUSD = (n, d = 2) => n == null ? '—' : `${n >= 0 ? '+' : ''}$${Math.abs(n).toFixed(d)}`;

function TenantCard({ label, color, data }) {
  if (!data) return null;
  const { botStatus, wallets, pnl, trades, history, configOverrides, risk } = data;
  const realized = pnl?.realizedPnl ?? 0;

  return (
    <div style={{ flex: 1, minWidth: 320, background: 'var(--bg-surface)', border: `1px solid ${color}44`, borderRadius: 'var(--radius-lg)', padding: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontWeight: 900, fontSize: 15, color }}>{label}</div>
        <span style={{
          fontSize: 10, fontWeight: 800, padding: '3px 10px', borderRadius: 6,
          background: botStatus.enabled ? 'rgba(0,184,122,0.12)' : 'rgba(100,116,139,0.12)',
          color: botStatus.enabled ? 'var(--color-green)' : 'var(--text-dim)',
        }}>
          {botStatus.enabled ? '● RUNNING' : '○ STOPPED'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 100 }}>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>P&amp;L Realizado</div>
          <div style={{ fontSize: 18, fontWeight: 900, fontFamily: 'var(--font-mono)', color: realized >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>{fmtUSD(realized)}</div>
        </div>
        <div style={{ flex: 1, minWidth: 100 }}>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Trades</div>
          <div style={{ fontSize: 18, fontWeight: 900, fontFamily: 'var(--font-mono)' }}>{trades ?? 0}</div>
        </div>
        <div style={{ flex: 1, minWidth: 100 }}>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Risk Guard</div>
          <div style={{ fontSize: 13, fontWeight: 800, color: risk?.active ? 'var(--color-red)' : 'var(--color-green)' }}>{risk?.active ? 'TRIPPED' : 'OK'}</div>
        </div>
      </div>

      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Config Overrides</div>
      <div style={{ display: 'flex', gap: 14, fontFamily: 'var(--font-mono)', fontSize: 12, marginBottom: 14 }}>
        <span>minScore: <strong>{configOverrides?.minScore ?? '—'}</strong></span>
        <span>tradeAmountBTC: <strong>{configOverrides?.tradeAmountBTC ?? '—'}</strong></span>
      </div>

      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Wallets</div>
      <div style={{ display: 'flex', gap: 14, fontFamily: 'var(--font-mono)', fontSize: 11, marginBottom: 14, flexWrap: 'wrap' }}>
        {wallets && Object.entries(wallets).map(([asset, byExchange]) => {
          const total = Object.values(byExchange || {}).reduce((s, v) => s + (v || 0), 0);
          return <span key={asset}>{asset}: <strong>{total.toFixed(asset === 'USDT' ? 2 : 6)}</strong></span>;
        })}
      </div>

      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Últimos trades</div>
      {history?.length ? (
        <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', maxHeight: 140, overflowY: 'auto' }}>
          {history.map((t, i) => (
            <div key={t.id || i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderTop: '1px solid var(--border)' }}>
              <span style={{ color: 'var(--text-dim)' }}>{t.buyExchange}→{t.sellExchange}</span>
              <span style={{ color: (t.netProfit ?? 0) >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>{fmtUSD(t.netProfit, 3)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Sin trades todavía — el motor real necesita oportunidades viables en el mercado actual.</div>
      )}
    </div>
  );
}

export default function TenantComparisonPage() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get('/api/tenant-demo/status');
      setStatus(data);
      setError(null);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Connection error'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { const t = setInterval(loadStatus, 5000); return () => clearInterval(t); }, [loadStatus]);

  const running = status?.conservative?.botStatus?.enabled || status?.aggressive?.botStatus?.enabled;

  const runAction = useCallback(async (path) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/tenant-demo/${path}`, {});
      await loadStatus();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Connection error'); }
    finally { setBusy(false); }
  }, [loadStatus]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ padding: '12px 18px', background: 'linear-gradient(135deg, rgba(0,184,122,0.08), rgba(87,65,217,0.05))', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }}>
        <div style={{ fontWeight: 900, fontSize: 16, letterSpacing: '-0.02em' }}>🧪 Comparación Multi-Tenant (Demo)</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
          Dos tenants sintéticos con perfiles de riesgo opuestos, corriendo sobre el mismo motor de ejecución
          multi-tenant real (ADR-017) que usaría cualquier usuario real — mismo loop de 150ms, mismos overrides
          de config, mismo risk guard. No es una simulación aparte.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button
          onClick={() => runAction('start')}
          disabled={busy}
          style={{ padding: '8px 16px', fontSize: 12, fontWeight: 700, borderRadius: 'var(--radius-md)', border: '1px solid var(--color-green)', background: 'rgba(0,184,122,0.1)', color: 'var(--color-green)', cursor: busy ? 'default' : 'pointer' }}
        >
          ▶ Iniciar demo
        </button>
        <button
          onClick={() => runAction('stop')}
          disabled={busy || !running}
          style={{ padding: '8px 16px', fontSize: 12, fontWeight: 700, borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text)', cursor: (busy || !running) ? 'default' : 'pointer', opacity: (busy || !running) ? 0.5 : 1 }}
        >
          ■ Detener
        </button>
        <button
          onClick={() => runAction('reset')}
          disabled={busy}
          style={{ padding: '8px 16px', fontSize: 12, fontWeight: 700, borderRadius: 'var(--radius-md)', border: '1px solid var(--color-red)', background: 'rgba(239,68,68,0.08)', color: 'var(--color-red)', cursor: busy ? 'default' : 'pointer' }}
        >
          ↺ Reset completo
        </button>
        {loading && <span style={{ fontSize: 11, color: 'var(--text-dim)', alignSelf: 'center' }}>Actualizando…</span>}
      </div>

      {error && (
        <div style={{ padding: 12, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 'var(--radius-md)', color: 'var(--color-red)', fontSize: 12 }}>
          {error}
        </div>
      )}

      {!status?.conservative?.botStatus && !loading && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }}>
          Ningún tenant demo activo todavía. Presiona &ldquo;Iniciar demo&rdquo; para arrancar dos tenants con perfiles de riesgo opuestos.
        </div>
      )}

      {status && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <TenantCard label="Conservador (minScore 80, 0.005 BTC/trade)" color="#00b87a" data={status.conservative} />
          <TenantCard label="Agresivo (minScore 40, 0.02 BTC/trade)" color="#f59e0b" data={status.aggressive} />
        </div>
      )}
    </div>
  );
}

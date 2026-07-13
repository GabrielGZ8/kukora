// ─── AlertsPage.jsx — Price Alerts with MongoDB + localStorage fallback ───
import { useState, useEffect, useCallback } from 'react';
import { usePolling } from '../hooks/usePolling';
import { api } from '../api';
import { PageHeader } from '../components/common/PageHeader';
import { EmptyState, SyncBadge } from '../components/common/StateViews';
import toast from 'react-hot-toast';

const STORAGE_KEY   = 'kukora_alerts_v1';
const COINS_LIST = [
  { id: 'bitcoin', symbol: 'BTC' }, { id: 'ethereum', symbol: 'ETH' },
  { id: 'solana', symbol: 'SOL' }, { id: 'binancecoin', symbol: 'BNB' },
  { id: 'ripple', symbol: 'XRP' }, { id: 'cardano', symbol: 'ADA' },
  { id: 'dogecoin', symbol: 'DOGE' }, { id: 'avalanche-2', symbol: 'AVAX' },
  { id: 'polkadot', symbol: 'DOT' }, { id: 'chainlink', symbol: 'LINK' },
];

const fmt = n => n == null ? '—' : n >= 1
  ? `$${n.toLocaleString('en', { maximumFractionDigits: 2 })}`
  : `$${n.toFixed(5)}`;

// ─── localStorage helpers ──────────────────────────────────────────────────
const ls_load = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } };
const ls_save = a  => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(a)); } catch { /* private browsing */ } };

// ─── Normalize server alert → local shape ─────────────────────────────────
const normalizeAlert = a => ({
  id:               a._id || a.id,
  coinId:           a.coinId,
  symbol:           a.symbol || a.coinName || a.coinId?.toUpperCase(),
  type:             a.condition || a.type,
  price:            a.price,
  triggered:        a.triggered || false,
  triggeredAt:      a.triggeredAt || null,
  triggeredAt_price:a.triggeredAt_price || null,
  createdAt:        a.createdAt || Date.now(),
  _serverSynced:    true,
});

export default function AlertsPage() {
  const [alerts,      setAlerts]      = useState(ls_load);
  const [serverOk,    setServerOk]    = useState(false);
  const [loadingInit, setLoadingInit] = useState(true);
  const [prices,      setPrices]      = useState({});
  const [form,        setForm]        = useState({ coinId: 'bitcoin', type: 'above', price: '' });
  const [showAdd,     setShowAdd]     = useState(false);

  // ── Load from server or fallback ─────────────────────────────────────────
  const loadAlerts = useCallback(async () => {
    setLoadingInit(true);
    try {
      const data = await api.alerts.list();
      const normalized = (Array.isArray(data) ? data : []).map(normalizeAlert);
      setAlerts(normalized);
      ls_save(normalized);
      setServerOk(true);
    } catch {
      // Server unavailable — use localStorage
      setServerOk(false);
      setAlerts(ls_load());
    } finally {
      setLoadingInit(false);
    }
  }, []);

  useEffect(() => { loadAlerts(); }, [loadAlerts]);

  // ── Live prices every 30s ─────────────────────────────────────────────────
  const { data: mkt } = usePolling(() => api.markets(50), 30_000);
  useEffect(() => {
    if (!mkt?.coins) return;
    const map = {};
    mkt.coins.forEach(c => { map[c.id] = c.current_price; });
    setPrices(map);
  }, [mkt]);

  // ── Create alert ──────────────────────────────────────────────────────────
  const addAlert = async () => {
    const price = parseFloat(form.price);
    if (!form.coinId || isNaN(price) || price <= 0) {
      toast.error('Enter a valid price'); return;
    }
    const coin = COINS_LIST.find(c => c.id === form.coinId);
    const payload = {
      coinId:    form.coinId,
      coinName:  coin?.symbol || form.coinId,
      symbol:    coin?.symbol || form.coinId.toUpperCase(),
      condition: form.type,
      type:      form.type,
      price,
    };

    try {
      if (serverOk) {
        const created = await api.alerts.create(payload);
        const next = [normalizeAlert(created), ...alerts];
        setAlerts(next); ls_save(next);
      } else {
        const local = { ...payload, id: Date.now(), triggered: false, createdAt: Date.now() };
        const next = [local, ...alerts];
        setAlerts(next); ls_save(next);
      }
      setForm(f => ({ ...f, price: '' }));
      setShowAdd(false);
      toast.success(`Alert created: ${coin?.symbol} ${form.type === 'above' ? '≥' : '≤'} ${fmt(price)}`);
    } catch (e) {
      toast.error(e.message || 'Failed to create alert');
    }
  };

  // ── Delete alert ──────────────────────────────────────────────────────────
  const removeAlert = async (id) => {
    const next = alerts.filter(a => a.id !== id);
    setAlerts(next); ls_save(next);
    try { if (serverOk) await api.alerts.delete(id); } catch { /* server delete is best-effort; localStorage is source of truth */ }
    toast.success('Alert deleted');
  };

  // ── Reset triggered alert ─────────────────────────────────────────────────
  const resetAlert = async (id) => {
    const next = alerts.map(a => a.id === id ? { ...a, triggered: false, triggeredAt: null } : a);
    setAlerts(next); ls_save(next);
    try { if (serverOk) await api.alerts.update(id, { triggered: false }); } catch { /* best-effort server sync */ }
    toast.success('Alert reactivada');
  };

  const active    = alerts.filter(a => !a.triggered);
  const triggered = alerts.filter(a => a.triggered);

  const sel = { padding: '8px 12px', borderRadius: 'var(--radius)', width: '100%', border: '1px solid var(--border-bright)', background: 'var(--bg-surface)', color: 'var(--text)', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-ui)', outline: 'none' };

  return (
    <div className="page-enter">
      <PageHeader
        title="Alerts de Price"
        description="Notifications cuando un active alcance tu price objetivo · monitoring cada 30s"
        live
        badge={serverOk ? 'MongoDB' : 'Local'}
        badgeColor={serverOk ? 'var(--color-green)' : 'var(--color-yellow)'}
        help="Las alerts se monitorizan en background aunque cambies de página. Se guardan en MongoDB si está available."
        actions={
          <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(s => !s)}>
            {showAdd ? '✕ Cancel' : '+ New alert'}
          </button>
        }
      />

      {/* Add form */}
      {showAdd && (
        <div className="card" style={{ marginBottom: 20, padding: '18px 20px', border: '1px solid rgba(255,45,120,0.2)' }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>Configure alert</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Asset</div>
              <select style={sel} value={form.coinId} onChange={e => setForm(f => ({ ...f, coinId: e.target.value }))}>
                {COINS_LIST.map(c => <option key={c.id} value={c.id}>{c.symbol}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Condition</div>
              <select style={sel} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                <option value="above">Price ≥ objetivo</option>
                <option value="below">Price ≤ objetivo</option>
              </select>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
                Price objetivo ($)
                {prices[form.coinId] && <span style={{ fontWeight: 400, color: 'var(--text-dim)', marginLeft: 6 }}>actual: {fmt(prices[form.coinId])}</span>}
              </div>
              <input className="input" type="number" min="0" step="any" placeholder="ej. 100000"
                value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))}
                onKeyDown={e => e.key === 'Enter' && addAlert()} />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button className="btn btn-primary btn-sm" onClick={addAlert}>Create alert</button>
            <SyncBadge serverAvailable={serverOk} />
          </div>
        </div>
      )}

      {/* Active alerts */}
      <div className="card" style={{ marginBottom: 16, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="pulse-dot" />
          <span style={{ fontSize: 13, fontWeight: 700 }}>Alerts activas</span>
          <span style={{ fontSize: 11, color: 'var(--text-dim)', background: 'var(--bg-surface-2)', padding: '1px 8px', borderRadius: 99, fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{active.length}</span>
          <span style={{ marginLeft: 'auto' }}><SyncBadge serverAvailable={serverOk} /></span>
        </div>
        {loadingInit ? (
          <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><div className="spinner" /></div>
        ) : active.length === 0 ? (
          <EmptyState icon="🔔" title="Sin alerts activas"
            description="Crea una alert para recibir notifications cuando el price alcance tu objetivo"
            action="+ Create alert" onAction={() => setShowAdd(true)} />
        ) : (
          active.map(a => {
            const current = prices[a.coinId];
            const dist = current && a.price ? Math.abs((a.price - current) / current * 100) : null;
            const pct  = current && a.price ? (current / a.price) * 100 : 0;
            const near = dist != null && dist < 5;
            return (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ width: 34, height: 34, borderRadius: 10, background: near ? 'var(--color-yellow-dim)' : 'var(--bg-surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0, border: near ? '1px solid rgba(245,158,11,0.3)' : '1px solid var(--border)' }}>
                  {near ? '⚡' : '🔔'}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 3 }}>
                    <span style={{ fontWeight: 800, fontSize: 13, fontFamily: 'var(--font-mono)' }}>{a.symbol}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{a.type === 'above' ? 'sube a' : 'baja a'}</span>
                    <span style={{ fontWeight: 700, fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--color-primary)' }}>{fmt(a.price)}</span>
                    {near && <span style={{ fontSize: 9, fontWeight: 800, color: 'var(--color-yellow)', background: 'var(--color-yellow-dim)', padding: '1px 6px', borderRadius: 99 }}>CERCA</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <span>Actual: <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{current ? fmt(current) : '…'}</b></span>
                    {dist != null && <span>Distancia: <b style={{ fontFamily: 'var(--font-mono)' }}>{dist.toFixed(2)}%</b></span>}
                  </div>
                </div>
                {/* Progress bar */}
                {current && a.price && (
                  <div style={{ width: 80, flexShrink: 0 }}>
                    <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 4, textAlign: 'right' }}>
                      {Math.min(100, pct).toFixed(0)}%
                    </div>
                    <div style={{ height: 4, background: 'var(--bg-surface-3)', borderRadius: 99, overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 99, width: `${Math.min(100, pct)}%`, background: near ? 'var(--color-yellow)' : 'var(--color-green)', transition: 'width 0.5s' }} />
                    </div>
                  </div>
                )}
                <button onClick={() => removeAlert(a.id)}
                  style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 14, padding: '4px', borderRadius: 6 }}
                  onMouseEnter={e => e.currentTarget.style.color = 'var(--color-red)'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--text-dim)'}>✕</button>
              </div>
            );
          })
        )}
      </div>

      {/* Triggered */}
      {triggered.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Disparadas</span>
            <span style={{ fontSize: 11, color: 'var(--text-dim)', background: 'var(--bg-surface-2)', padding: '1px 8px', borderRadius: 99, fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{triggered.length}</span>
          </div>
          {triggered.map(a => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: '1px solid var(--border)', opacity: 0.72 }}>
              <span style={{ fontSize: 18 }}>✅</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>
                  {a.symbol} {a.type === 'above' ? '≥' : '≤'} {fmt(a.price)}
                </div>
                {a.triggeredAt && (
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
                    Disparada{a.triggeredAt_price ? ` a ${fmt(a.triggeredAt_price)}` : ''} · {new Date(a.triggeredAt).toLocaleString('es-MX')}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button onClick={() => resetAlert(a.id)} className="btn btn-ghost btn-sm" style={{ fontSize: 11 }}>Reactivar</button>
                <button onClick={() => removeAlert(a.id)}
                  style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 14, padding: '4px', borderRadius: 6 }}>✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

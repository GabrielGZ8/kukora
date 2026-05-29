// ─── WatchlistPage.jsx — MongoDB + localStorage fallback ──────────────────
import { useState, useEffect, useCallback } from 'react';
import { usePolling } from '../hooks/usePolling';
import { api } from '../api';
import { CoinTable } from '../components/common/CoinTable';
import { PageHeader } from '../components/common/PageHeader';
import { EmptyState, SyncBadge } from '../components/common/StateViews';
import toast from 'react-hot-toast';

const DEFAULTS    = ['bitcoin','ethereum','solana','binancecoin','ripple','cardano'];
const STORAGE_KEY = 'kukora_watchlist_v1';

const ls_load = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || JSON.stringify(DEFAULTS)); } catch { return DEFAULTS; } };
const ls_save = l  => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(l)); } catch {} };

export default function WatchlistPage() {
  const [list,      setList]      = useState(ls_load);
  const [serverOk,  setServerOk]  = useState(false);
  const [search,    setSearch]    = useState('');

  const { data: mkt, loading } = usePolling(() => api.markets(100), 30_000);
  const coins    = (mkt?.coins || []).filter(c => list.includes(c.id));
  const allCoins = mkt?.coins || [];

  // ── Load from server ──────────────────────────────────────────────────────
  const loadWatchlist = useCallback(async () => {
    try {
      const data = await api.watchlist.get();
      const coins_list = Array.isArray(data) ? data : (data?.coins || DEFAULTS);
      setList(coins_list);
      ls_save(coins_list);
      setServerOk(true);
    } catch {
      setServerOk(false);
      setList(ls_load());
    }
  }, []);

  useEffect(() => { loadWatchlist(); }, [loadWatchlist]);

  // ── Toggle coin ───────────────────────────────────────────────────────────
  const toggle = async (id) => {
    const adding = !list.includes(id);
    const next   = adding ? [...list, id] : list.filter(x => x !== id);
    setList(next);
    ls_save(next);
    try { if (serverOk) await api.watchlist.save(next); } catch {}
    toast.success(adding ? '★ Agregado a watchlist' : 'Eliminado de watchlist');
  };

  const suggestions = search.length > 1
    ? allCoins.filter(c =>
        !list.includes(c.id) &&
        (c.name.toLowerCase().includes(search.toLowerCase()) ||
         c.symbol.toLowerCase().includes(search.toLowerCase()))
      ).slice(0, 5)
    : [];

  return (
    <div className="page-enter">
      <PageHeader
        title="Watchlist"
        description="Tus activos favoritos · actualización cada 30s"
        live
        badge={serverOk ? 'MongoDB' : 'Local'}
        badgeColor={serverOk ? 'var(--color-green)' : 'var(--color-yellow)'}
        actions={
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <SyncBadge serverAvailable={serverOk} />
            <input className="input" placeholder="Buscar y agregar…" style={{ width: 190 }}
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        }
      />

      {/* Search suggestions */}
      {suggestions.length > 0 && (
        <div className="card" style={{ marginBottom: 16, padding: '8px 12px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Agregar a watchlist</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {suggestions.map(c => (
              <button key={c.id} onClick={() => { toggle(c.id); setSearch(''); }}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 99, background: 'var(--bg-surface-2)', border: '1px solid var(--border)', cursor: 'pointer', fontSize: 12, fontWeight: 600, transition: 'all 0.13s' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.color = 'var(--color-primary)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = ''; }}>
                {c.image && <img src={c.image} alt="" style={{ width: 16, height: 16, borderRadius: '50%' }} />}
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{c.symbol?.toUpperCase()}</span>
                <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>{c.name}</span>
                <span style={{ color: 'var(--color-green)', fontWeight: 800 }}>+</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Watchlist table */}
      {loading && !coins.length ? (
        <div style={{ textAlign: 'center', padding: 60 }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
      ) : coins.length === 0 ? (
        <EmptyState icon="★" title="Tu watchlist está vacía"
          description="Busca un activo arriba para agregarlo a tu lista de seguimiento"
          action="Ver mercados" onAction={() => window.location.href = '/markets'} />
      ) : (
        <>
          <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                {coins.length} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>activos en seguimiento</span>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => { setList([]); ls_save([]); if (serverOk) api.watchlist.save([]); }}
                style={{ fontSize: 11 }}>Limpiar todo</button>
            </div>
            <CoinTable coins={coins} onSelect={c => toggle(c.id)} compact />
          </div>
          {/* Quick-remove chips */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {coins.map(c => (
              <button key={c.id} onClick={() => toggle(c.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 99, background: 'var(--bg-surface)', border: '1px solid var(--border)', cursor: 'pointer', fontSize: 11, fontWeight: 600, transition: 'all 0.13s' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-red-dim)'; e.currentTarget.style.borderColor = 'rgba(240,62,62,0.3)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-surface)'; e.currentTarget.style.borderColor = 'var(--border)'; }}>
                {c.image && <img src={c.image} alt="" style={{ width: 14, height: 14, borderRadius: '50%' }} />}
                <span style={{ fontFamily: 'var(--font-mono)' }}>{c.symbol?.toUpperCase()}</span>
                <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>✕</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

import { useState } from 'react';
import { usePolling } from '../hooks/usePolling';
import { api } from '../api';
import { CoinTable } from '../components/common/CoinTable';
import { PageHeader } from '../components/common/PageHeader';

const exportCSV = (coins) => {
  const headers = ['rank','id','name','symbol','price','change_1h','change_24h','change_7d','market_cap','volume_24h'];
  const rows = coins.map((c, i) => [
    i + 1,
    c.id,
    c.name,
    c.symbol?.toUpperCase(),
    c.current_price,
    c.price_change_percentage_1h_in_currency?.toFixed(2) || '',
    c.price_change_percentage_24h?.toFixed(2) || '',
    c.price_change_percentage_7d_in_currency?.toFixed(2) || '',
    c.market_cap,
    c.total_volume,
  ]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kukora_markets_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

export default function MarketsPage() {
  const [search, setSearch] = useState('');
  const { data: mkt, loading, ts } = usePolling(() => api.markets(100), 30000);

  const coins = (mkt?.coins || []).filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q);
  });

  return (
    <div>
      <PageHeader
        title="Mercados Crypto"
        description={ts ? `Top 100 · Actualizado ${ts.toLocaleTimeString('es-MX')}` : 'Top 100 · Cargando...'}
        live
        actions={
          <div style={{ display:'flex', gap:10, alignItems:'center' }}>
          <input
            className="input"
            placeholder="Buscar moneda..."
            style={{ width:200 }}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => exportCSV(mkt?.coins || [])}
            disabled={!mkt?.coins?.length}
            title="Exportar tabla completa como CSV">
            ⬇ Exportar CSV
          </button>
          </div>
        }
      />

      <div className="card">
        {loading && !mkt
          ? <div style={{ padding:60, textAlign:'center' }}><div className="spinner" /></div>
          : <CoinTable coins={coins} />
        }
      </div>
    </div>
  );
}

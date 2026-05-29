// ─── PortfolioPage.jsx — Portfolio tracker with MongoDB + localStorage ─────
import { useState, useEffect, useCallback } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from '../api';
import { PageHeader } from '../components/common/PageHeader';
import { EmptyState, SyncBadge, SkeletonMetrics } from '../components/common/StateViews';
import toast from 'react-hot-toast';

const COLORS = ['#FF2D78','#FF8C42','#3b82f6','#00b87a','#8b5cf6','#f59e0b','#06b6d4','#ec4899'];
const STORAGE_KEY = 'kukora_portfolio_v2';
const POPULAR = [
  { id:'bitcoin',symbol:'BTC' },{ id:'ethereum',symbol:'ETH' },
  { id:'solana',symbol:'SOL' },{ id:'binancecoin',symbol:'BNB' },
  { id:'ripple',symbol:'XRP' },{ id:'cardano',symbol:'ADA' },
  { id:'dogecoin',symbol:'DOGE' },{ id:'avalanche-2',symbol:'AVAX' },
  { id:'polkadot',symbol:'DOT' },{ id:'chainlink',symbol:'LINK' },
];

const fmt    = (n, d=2) => { if (n == null) return '—'; if (Math.abs(n)>=1e6) return `$${(n/1e6).toFixed(2)}M`; if (Math.abs(n)>=1e3) return `$${n.toLocaleString('en',{maximumFractionDigits:d})}`; if (Math.abs(n)>=1) return `$${n.toFixed(d)}`; return `$${n.toFixed(5)}`; };
const fmtPct = n => n == null ? '—' : `${n>=0?'+':''}${n.toFixed(2)}%`;
const fmtN   = n => n == null ? '—' : n>=1 ? n.toLocaleString('en',{maximumFractionDigits:4}) : n.toFixed(6);

const ls_load = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]'); } catch { return []; } };
const ls_save = p => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch {} };

// Normalize server holding → local shape
const norm = h => ({
  id:        h._id || h.id,
  coinId:    h.coinId,
  symbol:    h.symbol,
  amount:    h.quantity || h.amount,
  avgPrice:  h.entryPrice || h.avgPrice,
  addedAt:   h.entryDate || h.addedAt || Date.now(),
  _server:   !!h._id,
});

export default function PortfolioPage() {
  const [holdings,  setHoldings]  = useState(ls_load);
  const [prices,    setPrices]    = useState({});
  const [serverOk,  setServerOk]  = useState(false);
  const [loading,   setLoading]   = useState(true);
  const [pricesLoading, setPL]    = useState(false);
  const [showAdd,   setShowAdd]   = useState(false);
  const [form,      setForm]      = useState({ coinId:'bitcoin', amount:'', avgPrice:'' });

  // ── Load from server ──────────────────────────────────────────────────────
  const loadHoldings = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.portfolio.list();
      const items = (Array.isArray(data) ? data : []).map(norm);
      setHoldings(items); ls_save(items); setServerOk(true);
    } catch {
      setServerOk(false); setHoldings(ls_load());
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadHoldings(); }, [loadHoldings]);

  // ── Load prices ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!holdings.length) return;
    setPL(true);
    // Fetch individual prices to avoid limit=250 issue
    const ids = [...new Set(holdings.map(h => h.coinId))];
    api.get('/api/crypto/markets?limit=100')
      .then(d => {
        const map = {};
        (d?.coins || []).forEach(c => { map[c.id] = { price:c.current_price, change24h:c.price_change_percentage_24h, image:c.image, name:c.name, symbol:c.symbol?.toUpperCase() }; });
        // For any missing ids, fetch individually
        const missing = ids.filter(id => !map[id]);
        return Promise.all(missing.map(id =>
          api.get(`/api/crypto/markets?limit=100`).catch(() => null)
        )).then(() => map);
      })
      .then(map => { setPrices(map); setPL(false); })
      .catch(() => setPL(false));
  }, [holdings.length]);

  // ── Add holding ───────────────────────────────────────────────────────────
  const addHolding = async () => {
    const amount   = parseFloat(form.amount);
    const avgPrice = parseFloat(form.avgPrice);
    if (!form.coinId || isNaN(amount) || amount <= 0) { toast.error('Completa los campos correctamente'); return; }
    const coin = POPULAR.find(c => c.id === form.coinId);

    // Merge if existing
    const existingIdx = holdings.findIndex(h => h.coinId === form.coinId);
    if (existingIdx >= 0) {
      const old = holdings[existingIdx];
      const totalAmt  = old.amount + amount;
      const totalCost = old.amount*(old.avgPrice||0) + amount*(avgPrice||0);
      const merged    = { ...old, amount:totalAmt, avgPrice:avgPrice?totalCost/totalAmt:old.avgPrice };
      const next = holdings.map((h,i) => i===existingIdx ? merged : h);
      setHoldings(next); ls_save(next);
      toast.success('Posición promediada');
      setForm(f => ({ ...f, amount:'', avgPrice:'' })); setShowAdd(false); return;
    }

    const payload = { coinId:form.coinId, coinName:coin?.symbol||form.coinId, symbol:coin?.symbol||form.coinId.toUpperCase(), quantity:amount, entryPrice:isNaN(avgPrice)?0:avgPrice };

    try {
      if (serverOk) {
        const created = await api.portfolio.create(payload);
        const next = [...holdings, norm(created)];
        setHoldings(next); ls_save(next);
      } else {
        const local = { ...payload, id:Date.now(), amount, avgPrice:isNaN(avgPrice)?null:avgPrice, addedAt:Date.now() };
        const next = [...holdings, local];
        setHoldings(next); ls_save(next);
      }
      setForm(f => ({ ...f, amount:'', avgPrice:'' })); setShowAdd(false);
      toast.success('Posición agregada');
    } catch(e) { toast.error(e.message||'Error al agregar'); }
  };

  // ── Remove holding ────────────────────────────────────────────────────────
  const removeHolding = async (id) => {
    const next = holdings.filter(h => h.id !== id);
    setHoldings(next); ls_save(next);
    try { if (serverOk) await api.portfolio.delete(id); } catch {}
    toast.success('Posición eliminada');
  };

  // ── Computed ──────────────────────────────────────────────────────────────
  const enriched = holdings.map(h => {
    const p = prices[h.coinId];
    const currentValue = p ? h.amount * p.price : null;
    const costBasis    = h.avgPrice ? h.amount * h.avgPrice : null;
    const pnl          = currentValue!=null && costBasis!=null ? currentValue-costBasis : null;
    const pnlPct       = pnl!=null && costBasis ? (pnl/costBasis)*100 : null;
    return { ...h, ...p, currentValue, costBasis, pnl, pnlPct };
  });

  const totalValue  = enriched.reduce((a,h) => a+(h.currentValue||0), 0);
  const totalCost   = enriched.reduce((a,h) => a+(h.costBasis||0), 0);
  const totalPnL    = totalValue - totalCost;
  const totalPnLPct = totalCost>0 ? (totalPnL/totalCost)*100 : null;
  const best  = [...enriched].sort((a,b) => (b.pnlPct||-999)-(a.pnlPct||-999))[0];
  const worst = [...enriched].sort((a,b) => (a.pnlPct||999)-(b.pnlPct||999))[0];
  const pieData = enriched.filter(h => (h.currentValue||0)>0)
    .map(h => ({ name:h.symbol||h.coinId, value:h.currentValue }))
    .sort((a,b) => b.value-a.value);

  const sel = { padding:'8px 12px', borderRadius:'var(--radius)', width:'100%', border:'1px solid var(--border-bright)', background:'var(--bg-surface)', color:'var(--text)', fontSize:13, cursor:'pointer', fontFamily:'var(--font-ui)', outline:'none' };

  return (
    <div className="page-enter">
      <PageHeader
        title="Portfolio"
        description="P&L en tiempo real · persistencia multi-sesión"
        live={holdings.length>0}
        badge={serverOk ? 'MongoDB' : 'Local'}
        badgeColor={serverOk ? 'var(--color-green)' : 'var(--color-yellow)'}
        help="Las posiciones se guardan en MongoDB si está disponible. En modo local, solo persisten en este navegador."
        actions={
          <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(s => !s)}>
            {showAdd ? '✕ Cancelar' : '+ Agregar posición'}
          </button>
        }
      />

      {/* Add form */}
      {showAdd && (
        <div className="card" style={{ marginBottom:20, padding:'18px 20px', border:'1px solid rgba(255,45,120,0.2)' }}>
          <div style={{ fontSize:13, fontWeight:700, marginBottom:14 }}>Nueva posición</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:12, marginBottom:14 }}>
            <div>
              <div style={{ fontSize:10, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:6 }}>Activo</div>
              <select style={sel} value={form.coinId} onChange={e => setForm(f => ({ ...f, coinId:e.target.value }))}>
                {POPULAR.map(c => <option key={c.id} value={c.id}>{c.symbol} · {c.id}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize:10, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:6 }}>Cantidad</div>
              <input className="input" type="number" placeholder="ej. 0.5" min="0" step="any"
                value={form.amount} onChange={e => setForm(f => ({ ...f, amount:e.target.value }))} />
            </div>
            <div>
              <div style={{ fontSize:10, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:6 }}>
                Precio entrada ($) <span style={{ fontWeight:400, color:'var(--text-dim)' }}>opcional</span>
              </div>
              <input className="input" type="number" placeholder="ej. 45000" min="0" step="any"
                value={form.avgPrice} onChange={e => setForm(f => ({ ...f, avgPrice:e.target.value }))} />
            </div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <button className="btn btn-primary btn-sm" onClick={addHolding}>Agregar</button>
            <SyncBadge serverAvailable={serverOk} />
          </div>
        </div>
      )}

      {loading ? (
        <SkeletonMetrics count={4} />
      ) : holdings.length === 0 ? (
        <EmptyState icon="◎" title="Tu portfolio está vacío"
          description="Agrega tus posiciones para ver el P&L en tiempo real y análisis de allocación"
          action="+ Agregar primera posición" onAction={() => setShowAdd(true)} />
      ) : (
        <>
          {/* KPI Summary */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(130px, 1fr))', gap:12, marginBottom:20 }}>
            {[
              { label:'Valor Total',     value:fmt(totalValue),    color:'var(--text)' },
              { label:'Costo Base',      value:fmt(totalCost),     color:'var(--text-muted)' },
              { label:'P&L Total',       value:fmt(totalPnL),      color:totalPnL>=0?'var(--color-green)':'var(--color-red)', sub:fmtPct(totalPnLPct) },
              { label:'Mejor posición',  value:best?.symbol||'—',  color:'var(--color-green)', sub:fmtPct(best?.pnlPct) },
              { label:'Peor posición',   value:worst?.symbol||'—', color:'var(--color-red)',   sub:fmtPct(worst?.pnlPct) },
              { label:'Posiciones',      value:holdings.length,    color:'var(--color-blue)' },
            ].map(({ label, value, color, sub }) => (
              <div key={label} className="card" style={{ padding:'14px 16px' }}>
                <div style={{ fontSize:9, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:6 }}>{label}</div>
                <div style={{ fontSize:18, fontWeight:900, color, fontFamily:'var(--font-mono)', lineHeight:1.1 }}>{value}</div>
                {sub && <div style={{ fontSize:11, color, marginTop:3, fontWeight:600, fontFamily:'var(--font-mono)' }}>{sub}</div>}
              </div>
            ))}
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'260px 1fr', gap:16, marginBottom:20 }}>
            {/* Allocation pie */}
            <div className="card">
              <div style={{ fontSize:13, fontWeight:700, marginBottom:14 }}>Allocación</div>
              {pieData.length>0 ? (
                <>
                  <ResponsiveContainer width="100%" height={170}>
                    <PieChart>
                      <Pie data={pieData} cx="50%" cy="50%" innerRadius={46} outerRadius={72} dataKey="value" paddingAngle={2}>
                        {pieData.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={{ background:'#fff', border:'1px solid var(--border)', borderRadius:8, fontSize:11 }} formatter={v => [fmt(v),'Valor']} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ display:'flex', flexDirection:'column', gap:4, marginTop:8 }}>
                    {pieData.map((d,i) => (
                      <div key={d.name} style={{ display:'flex', alignItems:'center', gap:8, fontSize:11 }}>
                        <div style={{ width:7, height:7, borderRadius:'50%', background:COLORS[i%COLORS.length], flexShrink:0 }} />
                        <span style={{ fontWeight:600, fontFamily:'var(--font-mono)', flex:1 }}>{d.name}</span>
                        <span style={{ color:'var(--text-muted)' }}>{totalValue>0?((d.value/totalValue)*100).toFixed(1):0}%</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div style={{ textAlign:'center', padding:40, color:'var(--text-dim)', fontSize:12 }}>Cargando precios…</div>
              )}
            </div>

            {/* Holdings table */}
            <div className="card" style={{ padding:0, overflow:'hidden' }}>
              <div style={{ padding:'13px 18px', borderBottom:'1px solid var(--border)', fontSize:13, fontWeight:700, display:'flex', alignItems:'center', gap:10 }}>
                Posiciones {pricesLoading && <div className="spinner" style={{ width:14, height:14 }} />}
              </div>
              <div style={{ overflowX:'auto' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                  <thead>
                    <tr style={{ background:'var(--bg-surface-2)' }}>
                      {['Activo','Cantidad','Precio Actual','Entrada','Valor','P&L','P&L %','24h',''].map(h => (
                        <th key={h} style={{ padding:'8px 12px', textAlign:h==='Activo'?'left':'right', fontSize:9, fontWeight:700, color:'var(--text-dim)', textTransform:'uppercase', letterSpacing:'0.07em', borderBottom:'1px solid var(--border)', whiteSpace:'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {enriched.map((h,i) => (
                      <tr key={h.id}
                        onMouseEnter={e => e.currentTarget.style.background='var(--bg-surface-2)'}
                        onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                        <td style={{ padding:'10px 12px', borderBottom:'1px solid var(--border)' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                            <div style={{ width:6, height:6, borderRadius:'50%', background:COLORS[i%COLORS.length], flexShrink:0 }} />
                            {h.image && <img src={h.image} alt="" style={{ width:22, height:22, borderRadius:'50%' }} onError={e=>e.target.style.display='none'} />}
                            <div>
                              <div style={{ fontWeight:700, fontFamily:'var(--font-mono)' }}>{h.symbol||h.coinId.toUpperCase()}</div>
                              <div style={{ fontSize:10, color:'var(--text-dim)' }}>{h.name||h.coinId}</div>
                            </div>
                          </div>
                        </td>
                        <td style={{ padding:'10px 12px', textAlign:'right', borderBottom:'1px solid var(--border)', fontFamily:'var(--font-mono)', fontWeight:600 }}>{fmtN(h.amount)}</td>
                        <td style={{ padding:'10px 12px', textAlign:'right', borderBottom:'1px solid var(--border)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{h.price?fmt(h.price):'…'}</td>
                        <td style={{ padding:'10px 12px', textAlign:'right', borderBottom:'1px solid var(--border)', color:'var(--text-muted)', fontFamily:'var(--font-mono)' }}>{h.avgPrice?fmt(h.avgPrice):'—'}</td>
                        <td style={{ padding:'10px 12px', textAlign:'right', borderBottom:'1px solid var(--border)', fontWeight:700, fontFamily:'var(--font-mono)' }}>{fmt(h.currentValue)}</td>
                        <td style={{ padding:'10px 12px', textAlign:'right', borderBottom:'1px solid var(--border)', fontWeight:700, fontFamily:'var(--font-mono)', color:h.pnl==null?'var(--text-dim)':h.pnl>=0?'var(--color-green)':'var(--color-red)' }}>{fmt(h.pnl)}</td>
                        <td style={{ padding:'10px 12px', textAlign:'right', borderBottom:'1px solid var(--border)', fontWeight:700, fontFamily:'var(--font-mono)', color:h.pnlPct==null?'var(--text-dim)':h.pnlPct>=0?'var(--color-green)':'var(--color-red)' }}>{fmtPct(h.pnlPct)}</td>
                        <td style={{ padding:'10px 12px', textAlign:'right', borderBottom:'1px solid var(--border)', fontFamily:'var(--font-mono)', fontSize:11, color:h.change24h==null?'var(--text-dim)':h.change24h>=0?'var(--color-green)':'var(--color-red)' }}>{h.change24h!=null?`${h.change24h>=0?'+':''}${h.change24h.toFixed(2)}%`:'—'}</td>
                        <td style={{ padding:'10px 8px', borderBottom:'1px solid var(--border)' }}>
                          <button onClick={() => removeHolding(h.id)} style={{ background:'none', border:'none', color:'var(--text-dim)', cursor:'pointer', fontSize:14, padding:'2px 4px', borderRadius:4, lineHeight:1 }}
                            onMouseEnter={e => e.currentTarget.style.color='var(--color-red)'}
                            onMouseLeave={e => e.currentTarget.style.color='var(--text-dim)'}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div style={{ fontSize:11, color:'var(--text-dim)', textAlign:'center' }}>
            {serverOk ? '☁ Datos sincronizados con MongoDB · persisten entre sesiones y dispositivos' : '💾 Datos en localStorage · solo en este navegador. Levanta MongoDB para persistencia real.'}
          </div>
        </>
      )}
    </div>
  );
}

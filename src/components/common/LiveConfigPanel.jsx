/**
 * LiveConfigPanel.jsx — Kukora
 * Live configuration panel — hot-reload parameters. Effect is immediate: the engine reads liveConfig on every cycle.
 *
 * Two layers of parameters are rendered:
 *   1. PARAM_META — a curated set of the 8 "core" knobs every operator tunes
 *      day-to-day (score threshold, trade size, spreads, cooldown). These
 *      get the full slider treatment with hand-written descriptions.
 *   2. GROUP_SECTIONS — every *other* schema-declared parameter
 *      (execution, risk, capital, rebalancing, scoring — ~24 more keys),
 *      rendered generically straight from `GET /api/arbitrage/config`'s
 *      `schema` field. This is what closes the gap between what the engine
 *      can actually be tuned to do (liveConfig.js has ~32 validated,
 *      hot-reloadable parameters) and what the UI previously exposed
 *      (8 of them). Nothing here is hardcoded twice — add a parameter to
 *      the backend schema and it appears here automatically, grouped and
 *      typed correctly (number/boolean/enum/weights), with no frontend
 *      change required.
 */
import { useState, useEffect, useCallback } from 'react';
import { requestArbitrage } from '../../api';
import toast from 'react-hot-toast';

// I-2 fix: exchanges loaded from server schema — not hardcoded here.
// Fallback list so the panel renders before the first API response.
const FALLBACK_EXCHANGES = ['Binance', 'Kraken', 'Bybit', 'OKX', 'Coinbase'];
const EX_COLORS = { Binance:'#F0B90B', Kraken:'#5741D9', Bybit:'#F7A600', Coinbase:'#0052FF', OKX:'#aaa' };

// Groups covered by the curated core sliders / dedicated widgets below —
// excluded from the generic "advanced parameters" renderer so nothing
// shows up twice.
const CORE_KEYS = new Set([
  'minScore', 'tradeAmountBTC', 'minNetProfitUSD', 'minSpreadPct', 'maxSpreadPct',
  'maxDailyLossUSD', 'cooldownMs', 'minTriangularNetPct',
  'feeMode', 'activeExchanges', 'tradingMode',
]);

const GROUP_META = {
  execution:   { label: 'Ejecución',    icon: '⚡', desc: 'Slippage, latencia, timeouts y reintentos de órdenes' },
  risk:        { label: 'Riesgo',       icon: '🛡️', desc: 'Drawdown, exposición máxima, circuit breakers, stops' },
  capital:     { label: 'Capital',      icon: '💰', desc: 'Modo de asignación, reservas, distribución por exchange/estrategia' },
  rebalancing: { label: 'Rebalanceo',   icon: '⚖️', desc: 'Umbrales y límites del motor de rebalanceo automático' },
  scoring:     { label: 'Scoring',      icon: '◈', desc: 'Pesos del score compuesto de oportunidades' },
};
const GROUP_ORDER = ['execution', 'risk', 'capital', 'rebalancing', 'scoring'];

function Card({ children, style }) {
  return (
    <div className="card" style={{ borderRadius:'var(--radius)', border:'1px solid var(--border)', background:'var(--surface)', ...style }}>
      {children}
    </div>
  );
}
function STitle({ children, sub, right }) {
  return (
    <div style={{ padding:'12px 18px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
      <div>
        <div style={{ fontWeight:800, fontSize:13, color:'var(--text)' }}>{children}</div>
        {sub && <div style={{ fontSize:10, color:'var(--text-dim)', marginTop:1 }}>{sub}</div>}
      </div>
      {right}
    </div>
  );
}

// Generic control for one schema-declared parameter. Handles the 4 types
// the backend schema uses beyond core sliders: number (incl. nullable),
// boolean, enum, and weights (an object of numeric sub-keys, e.g.
// scoringWeights or capitalPerExchange).
// Generic snake_case -> Title Case formatter for enum option buttons, so
// any schema-declared enum (present or future) reads as a human label
// ("Ioc Protected") instead of a raw backend value ("ioc_protected") — the
// raw value is still available via the button's title tooltip.
function formatEnumLabel(value) {
  return String(value)
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function SchemaField({ paramKey, meta, value, onChange }) {
  const label = paramKey.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());

  if (meta.readOnly) {
    return (
      <div style={{ display:'flex', justifyContent:'space-between', padding:'6px 0', fontSize:11 }}>
        <div>
          <div style={{ fontWeight:700 }}>{label}</div>
          <div style={{ fontSize:9.5, color:'var(--text-dim)' }}>{meta.desc}</div>
        </div>
        <span style={{ fontWeight:800, color:'var(--text-dim)' }}>{String(value)} <span style={{ fontSize:9 }}>(read-only)</span></span>
      </div>
    );
  }

  if (meta.type === 'boolean') {
    return (
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'6px 0' }}>
        <div style={{ maxWidth:'70%' }}>
          <div style={{ fontSize:11.5, fontWeight:700 }}>{label}</div>
          <div style={{ fontSize:9.5, color:'var(--text-dim)' }}>{meta.desc}</div>
        </div>
        <button
          onClick={() => onChange(!value)}
          style={{
            width:40, height:22, borderRadius:11, border:'none', cursor:'pointer', position:'relative',
            background: value ? 'var(--color-green)' : 'var(--bg-elevated)', flexShrink:0,
          }}>
          <span style={{ position:'absolute', top:2, left: value ? 20 : 2, width:18, height:18, borderRadius:'50%', background:'#fff', transition:'left 0.15s' }} />
        </button>
      </div>
    );
  }

  if (meta.type === 'enum') {
    return (
      <div style={{ padding:'6px 0' }}>
        <div style={{ fontSize:11.5, fontWeight:700, marginBottom:2 }}>{label}</div>
        <div style={{ fontSize:9.5, color:'var(--text-dim)', marginBottom:6 }}>{meta.desc}</div>
        <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
          {meta.options.map(opt => (
            <button key={opt} onClick={() => onChange(opt)} title={opt}
              style={{
                padding:'4px 10px', borderRadius:6, fontSize:10.5, fontWeight:700, cursor:'pointer',
                border: value === opt ? '2px solid var(--color-primary)' : '1px solid var(--border)',
                background: value === opt ? 'rgba(0,153,204,0.1)' : 'var(--bg-elevated)',
                color: value === opt ? 'var(--color-primary)' : 'var(--text-dim)',
                transition: 'all var(--transition)',
              }}>{formatEnumLabel(opt)}</button>
          ))}
        </div>
      </div>
    );
  }

  if (meta.type === 'weights') {
    const obj = value && typeof value === 'object' ? value : {};
    const sum = meta.keys.reduce((s, k) => s + (Number(obj[k]) || 0), 0);
    const sumOk = Math.abs(sum - 1) < 0.02;
    return (
      <div style={{ padding:'8px 0' }}>
        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
          <div style={{ fontSize:11.5, fontWeight:700 }}>{label}</div>
          <span style={{ fontSize:10, fontWeight:800, color: sumOk ? 'var(--color-green)' : 'var(--color-yellow)' }}>
            Σ {sum.toFixed(2)}
          </span>
        </div>
        <div style={{ fontSize:9.5, color:'var(--text-dim)', marginBottom:6 }}>{meta.desc}</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'4px 10px' }}>
          {meta.keys.map(k => (
            <div key={k} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:6 }}>
              <span style={{ fontSize:10, color:'var(--text-dim)' }}>{k}</span>
              <input type="number" min={meta.min} max={meta.max} step={meta.step}
                value={obj[k] ?? 0}
                onChange={e => {
                  const v = parseFloat(e.target.value);
                  if (isNaN(v)) return;
                  onChange({ ...obj, [k]: v });
                }}
                style={{ width:58, textAlign:'center', fontSize:10, fontFamily:'var(--font-mono)', fontWeight:700, background:'var(--bg-elevated)', border:'1px solid var(--border)', borderRadius:4, padding:'1px 4px', color:'var(--text)' }}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // number (possibly nullable)
  const isNull = meta.nullable && (value === null || value === undefined);
  return (
    <div style={{ padding:'6px 0' }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
        <div style={{ fontSize:11.5, fontWeight:700 }}>{label}</div>
        {meta.nullable && (
          <label style={{ display:'flex', alignItems:'center', gap:4, fontSize:9.5, color:'var(--text-dim)', cursor:'pointer' }}>
            <input type="checkbox" checked={!isNull} onChange={e => onChange(e.target.checked ? (meta.min ?? 0) : null)} />
            activo
          </label>
        )}
      </div>
      <div style={{ fontSize:9.5, color:'var(--text-dim)', marginBottom:6 }}>{meta.desc}</div>
      {!isNull && (
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <input type="range" min={meta.min} max={meta.max} step={meta.step} value={Number(value)}
            onChange={e => onChange(parseFloat(e.target.value))}
            style={{ flex:1, accentColor:'var(--color-primary)', cursor:'pointer' }} />
          <input type="number" min={meta.min} max={meta.max} step={meta.step} value={Number(value)}
            onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) onChange(v); }}
            style={{ width:66, textAlign:'center', fontSize:10, fontFamily:'var(--font-mono)', fontWeight:700, background:'var(--bg-elevated)', border:'1px solid var(--border)', borderRadius:4, padding:'1px 4px', color:'var(--text)' }} />
          {meta.unit && <span style={{ fontSize:9.5, color:'var(--text-dim)', width:26 }}>{meta.unit}</span>}
        </div>
      )}
    </div>
  );
}

const PARAM_META = {
  minScore:            { label:'Min Score', unit:'pts', min:0,     max:100,   step:1,   desc:'Minimum score required to execute a trade (0–100). Increase to filter lower-quality opportunities.' },
  tradeAmountBTC:      { label:'Trade Size', unit:'BTC', min:0.001, max:0.5,   step:0.001, decimals:3, desc:'Position size per trade. Increase for higher potential profit, decrease to reduce risk exposure.' },
  minNetProfitUSD:     { label:'Min Net Profit', unit:'USD', min:0, max:50,    step:0.01, decimals:2, desc:'Minimum net profit required to execute (USD). Increase in high-fee market conditions.' },
  minSpreadPct:        { label:'Min Spread', unit:'%', min:0.0001, max:1,    step:0.001, decimals:4, desc:'Circuit breaker inferior: ignora spreads menores a este valor.' },
  maxSpreadPct:        { label:'Max Spread', unit:'%', min:1,     max:20,    step:0.1,   decimals:2, desc:'Circuit breaker superior: spreads mayores indican feed obsoleto.' },
  maxDailyLossUSD:     { label:'Max Daily Loss', unit:'USD', min:-10000, max:-1, step:10, desc:'Engine pauses when daily loss reaches this value. Always negative.' },
  cooldownMs:          { label:'Cooldown', unit:'ms', min:50,    max:10000, step:50,   desc:'Minimum milliseconds entre ejecuciones. Sube para reducir frequency.' },
  minTriangularNetPct: { label:'Min Triangular', unit:'%', min:0.001, max:2, step:0.005, decimals:3, desc:'Minimum net profit to execute triangular (%). Lower = more opportunities.' },
};

export default function LiveConfigPanel() {
  const [cfg,     setCfg]     = useState(null);
  const [draft,   setDraft]   = useState({});
  const [history, setHistory] = useState([]);
  const [changed, setChanged] = useState([]);
  const [loading, setLoading] = useState(false);
  const [allExchanges,    setAllExchanges]    = useState(FALLBACK_EXCHANGES);
  const [activeExchanges, setActiveExchanges] = useState(FALLBACK_EXCHANGES);
  const [schema,  setSchema]  = useState({});
  const [openGroups, setOpenGroups] = useState({});

  const fetchConfig = useCallback(async () => {
    try {
      const j = await requestArbitrage('config');
      if (j?.ok) {
        setCfg(j.data);
        setDraft(j.data);
        setHistory(j.history || []);
        setChanged(j.changed || []);
        setSchema(j.schema || {});
        // I-2 fix: load available exchanges from server schema (single source of truth)
        const schemaExchanges = j.schema?.activeExchanges?.options;
        const knownExchanges = Array.isArray(schemaExchanges) && schemaExchanges.length > 0
          ? schemaExchanges
          : FALLBACK_EXCHANGES;
        setAllExchanges(knownExchanges);
        setActiveExchanges(j.data.activeExchanges || knownExchanges);
      }
    } catch { /* network error — panel shows last known config */ }
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  // Polling every 5s to see changes applied by the engine
  useEffect(() => {
    const id = setInterval(fetchConfig, 5000);
    return () => clearInterval(id);
  }, [fetchConfig]);

  const handleSlider = (key, val) => {
    const meta = PARAM_META[key];
    const numVal = meta.decimals ? parseFloat(val) : parseInt(val, 10);
    setDraft(d => ({ ...d, [key]: numVal }));
  };

  const toggleExchange = (ex) => {
    setActiveExchanges(prev => {
      if (prev.includes(ex)) {
        if (prev.length <= 1) { toast.error('At least 1 exchange must remain active'); return prev; }
        return prev.filter(e => e !== ex);
      }
      return [...prev, ex];
    });
  };

  const applyChanges = async () => {
    setLoading(true);
    try {
      const patch = { ...draft, activeExchanges };
      const j = await requestArbitrage('config', { method: 'POST', body: patch });
      if (j.ok || (j.applied && j.applied.length > 0)) {
        toast.success(`✅ ${j.applied?.length || 0} parámetro(s) aplicado(s) en caliente`);
        fetchConfig();
      } else if (!j.ok && j.error) {
        toast.error(`Error: ${j.error}`);
      } else {
        toast.error(`Errores: ${j.rejected?.map(e => e.key).join(', ')}`);
      }
    } catch (e) { toast.error(e.message); }
    setLoading(false);
  };

  const resetDefaults = async () => {
    setLoading(true);
    try {
      const j = await requestArbitrage('config/reset', { method: 'POST' });
      if (j?.ok) { toast.success('Parameters reset to defaults'); fetchConfig(); }
    } catch (e) { toast.error(e.message); }
    setLoading(false);
  };

  // Import config from a previously exported JSON file
  const importConfig = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const { exportedAt, ...configKeys } = parsed;
        const knownKeys = [...new Set([...Object.keys(PARAM_META), ...Object.keys(schema), 'feeMode', 'activeExchanges'])];
        const patch = Object.fromEntries(Object.entries(configKeys).filter(([k]) => knownKeys.includes(k)));
        if (Object.keys(patch).length === 0) { toast.error('No recognized configuration parameters in JSON'); return; }
        if (patch.activeExchanges) { setActiveExchanges(patch.activeExchanges); }
        setDraft(d => ({ ...d, ...patch }));
        toast.success(`✅ Config importada: ${Object.keys(patch).length} parámetro(s) cargado(s). Revisa y aplica.`, { duration: 5000 });
      } catch { toast.error('Failed to parse JSON — please check the format'); }
    };
    input.click();
  };

  const setDraftKey = (key, val) => setDraft(d => ({ ...d, [key]: val }));

  const toggleGroup = (g) => setOpenGroups(o => ({ ...o, [g]: !o[g] }));

  if (!cfg) return (
    <div style={{ padding:40, textAlign:'center', color:'var(--text-dim)' }}>Loading configuration...</div>
  );

  // Everything the schema declares that isn't already covered by the
  // curated core sliders or the dedicated fee/exchange widgets, grouped by
  // its `group` field. This is what surfaces the other ~24 hot-reloadable
  // parameters (execution, risk, capital, rebalancing, scoring) that the
  // engine already validates and applies, but which had no UI before.
  const advancedByGroup = GROUP_ORDER.reduce((acc, g) => {
    const keys = Object.entries(schema).filter(([k, m]) => m.group === g && !CORE_KEYS.has(k));
    if (keys.length > 0) acc[g] = keys;
    return acc;
  }, {});
  const advancedChangedCount = Object.values(advancedByGroup).flat()
    .filter(([k]) => changed.includes(k)).length;

  const hasChanges = JSON.stringify(draft) !== JSON.stringify(cfg) ||
    JSON.stringify(activeExchanges.sort()) !== JSON.stringify((cfg.activeExchanges || allExchanges).sort());

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

      {/* ── HEADER BADGE ───────────────────────────────────────────────── */}
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', background:'rgba(0,184,122,0.06)', borderRadius:'var(--radius)', border:'1px solid rgba(0,184,122,0.2)' }}>
        <span style={{ fontSize:18 }}>⚙️</span>
        <div>
          <div style={{ fontWeight:800, fontSize:13, color:'var(--color-green)' }}>Configuration en vivo — efecto inmediato</div>
          <div style={{ fontSize:11, color:'var(--text-dim)' }}>
            Changes se aplican sin restart. El engine lee estos parameters en cada ciclo de 150ms.
            {changed.length > 0 && <span style={{ color:'var(--color-yellow)', marginLeft:8 }}>⚡ {changed.length} parameter(s) modified vs defaults</span>}
          </div>
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>

        {/* ── SLIDERS ───────────────────────────────────────────────────── */}
        <Card>
          <STitle sub="All changes take effect immediately — no restart required">Engine parameters</STitle>
          <div style={{ padding:'10px 16px', display:'flex', flexDirection:'column', gap:14 }}>
            {Object.entries(PARAM_META).map(([key, meta]) => {
              const val    = draft[key] ?? cfg[key];
              const defVal = cfg[key];
              const isDiff = val !== defVal;
              return (
                <div key={key}>
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                    <div>
                      <span style={{ fontSize:12, fontWeight:700, color: isDiff ? 'var(--color-yellow)' : 'var(--text)' }}>
                        {meta.label}
                        {isDiff && <span style={{ marginLeft:5, fontSize:9, background:'rgba(245,158,11,0.15)', color:'#F59E0B', padding:'1px 5px', borderRadius:3, fontWeight:800 }}>MODIFICADO</span>}
                      </span>
                      <div style={{ fontSize:10, color:'var(--text-dim)', marginTop:1 }}>{meta.desc}</div>
                    </div>
                    <div style={{ textAlign:'right', flexShrink:0, marginLeft:8 }}>
                      <span style={{ fontWeight:800, fontSize:13, color: isDiff ? 'var(--color-yellow)' : 'var(--text)' }}>
                        {meta.decimals ? Number(val).toFixed(meta.decimals) : val} <span style={{ fontSize:10, color:'var(--text-dim)' }}>{meta.unit}</span>
                      </span>
                      {isDiff && <div style={{ fontSize:9, color:'var(--text-dim)' }}>default: {meta.decimals ? Number(defVal).toFixed(meta.decimals) : defVal}</div>}
                    </div>
                  </div>
                  <input
                    type="range"
                    min={meta.min} max={meta.max} step={meta.step}
                    value={val}
                    onChange={e => handleSlider(key, e.target.value)}
                    style={{ width:'100%', accentColor: isDiff ? '#F59E0B' : 'var(--color-green)', cursor:'pointer' }}
                  />
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:9, color:'var(--text-dim)' }}>
                    <span>{meta.min}</span>
                    <input
                      type="number"
                      min={meta.min} max={meta.max} step={meta.step}
                      value={meta.decimals ? Number(val).toFixed(meta.decimals) : val}
                      onChange={e => {
                        const v = parseFloat(e.target.value);
                        if (!isNaN(v) && v >= meta.min && v <= meta.max) handleSlider(key, v);
                      }}
                      style={{ width:70, textAlign:'center', fontSize:10, fontFamily:'var(--font-mono)', fontWeight:700, background:'var(--bg-elevated)', border:'1px solid var(--border)', borderRadius:4, padding:'1px 4px', color: isDiff ? 'var(--color-yellow)' : 'var(--text)' }}
                    />
                    <span>{meta.max}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

          {/* ── FEE MODE ─────────────────────────────────────────────────── */}
          <Card>
            <STitle sub="Afecta fees en cada cálculo de opportunity">Modo de fees</STitle>
            <div style={{ padding:'12px 16px', display:'flex', gap:8 }}>
              {['taker','maker'].map(mode => (
                <button key={mode}
                  onClick={() => setDraft(d => ({ ...d, feeMode: mode }))}
                  style={{
                    flex:1, padding:'8px 0', borderRadius:6, fontSize:12, fontWeight:700, cursor:'pointer',
                    border: draft.feeMode === mode ? '2px solid var(--color-green)' : '1px solid var(--border)',
                    background: draft.feeMode === mode ? 'rgba(0,184,122,0.1)' : 'var(--surface)',
                    color: draft.feeMode === mode ? 'var(--color-green)' : 'var(--text-dim)',
                  }}>
                  {mode === 'taker' ? '⚡ Taker (0.1%)' : '🎯 Maker (0.01%)'}
                </button>
              ))}
            </div>
            <div style={{ padding:'0 16px 12px', fontSize:10, color:'var(--text-dim)' }}>
              Maker = limit orders (0.01% en Bybit). Taker = market orders (0.1% en Binance).
              Maker baja el threshold de rentabilidad ~60%.
            </div>
          </Card>

          {/* ── EXCHANGES ACTIVOS ────────────────────────────────────────── */}
          <Card>
            <STitle sub="Exchanges deshabilitados se excluyen del engine bilateral">Exchanges activos</STitle>
            <div style={{ padding:'12px 16px', display:'flex', flexWrap:'wrap', gap:8 }}>
              {allExchanges.map(ex => {
                const active = activeExchanges.includes(ex);
                return (
                  <button key={ex} onClick={() => toggleExchange(ex)}
                    style={{
                      padding:'6px 12px', borderRadius:6, fontSize:11, fontWeight:700, cursor:'pointer',
                      border: active ? `2px solid ${EX_COLORS[ex] || '#888'}` : '1px solid var(--border)',
                      background: active ? `${EX_COLORS[ex] || '#888'}18` : 'var(--surface)',
                      color: active ? (EX_COLORS[ex] || '#888') : 'var(--text-dim)',
                    }}>
                    <span style={{ width:7, height:7, borderRadius:'50%', background: active ? (EX_COLORS[ex] || '#888') : '#555', display:'inline-block', marginRight:5 }}/>
                    {ex}
                  </button>
                );
              })}
            </div>
            <div style={{ padding:'0 16px 12px', fontSize:10, color:'var(--text-dim)' }}>
              {activeExchanges.length}/{allExchanges.length} exchanges activos.
              Desactivar Coinbase reduce el impacto del fee 0.60%.
            </div>
          </Card>

          {/* ── APPLY BUTTON ──────────────────────────────────────────────── */}
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={applyChanges} disabled={loading || !hasChanges}
              style={{
                flex:1, padding:'11px 0', borderRadius:8, fontWeight:800, fontSize:13, cursor: hasChanges ? 'pointer' : 'not-allowed',
                background: hasChanges ? 'linear-gradient(135deg,#00B87A,#0099CC)' : 'var(--surface)',
                color: hasChanges ? '#fff' : 'var(--text-dim)',
                border: hasChanges ? 'none' : '1px solid var(--border)',
                opacity: loading ? 0.7 : 1,
              }}>
              {loading ? '⏳ Applying...' : hasChanges ? '⚡ Apply changes' : '✓ No pending changes'}
            </button>
            <button onClick={resetDefaults} disabled={loading}
              style={{ padding:'11px 16px', borderRadius:8, fontWeight:700, fontSize:12, cursor:'pointer', background:'var(--surface)', color:'var(--text-dim)', border:'1px solid var(--border)' }}>
              Reset
            </button>
            <button
              title="Export configuration como JSON"
              onClick={() => {
                const blob = new Blob([JSON.stringify({ ...draft, activeExchanges, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a'); a.href = url; a.download = `kukora-config-${Date.now()}.json`; a.click();
                URL.revokeObjectURL(url);
              }}
              style={{ padding:'11px 12px', borderRadius:8, fontWeight:700, fontSize:12, cursor:'pointer', background:'rgba(0,82,255,0.08)', color:'#0052FF', border:'1px solid rgba(0,82,255,0.25)' }}>
              ↓ JSON
            </button>
            <button
              title="Importar configuration desde JSON exportado previamente"
              onClick={importConfig}
              style={{ padding:'11px 12px', borderRadius:8, fontWeight:700, fontSize:12, cursor:'pointer', background:'rgba(139,92,246,0.08)', color:'#8b5cf6', border:'1px solid rgba(139,92,246,0.25)' }}>
              ↑ Import
            </button>
          </div>

          {/* ── CURRENT STATE SUMMARY ─────────────────────────────────────── */}
          <Card style={{ background:'rgba(0,0,0,0.1)' }}>
            <STitle sub="Current engine state">Active parameters</STitle>
            <div style={{ padding:'10px 16px', display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px 12px' }}>
              {[
                ['minScore',            'Min Score',       `${cfg.minScore} pts`],
                ['tradeAmountBTC',      'Trade Size',      `${cfg.tradeAmountBTC} BTC`],
                ['feeMode',             'Fee Mode',        cfg.feeMode?.toUpperCase()],
                ['minNetProfitUSD',     'Min Profit',      `$${cfg.minNetProfitUSD}`],
                ['minSpreadPct',        'Min Spread',      `${cfg.minSpreadPct}%`],
                ['maxDailyLossUSD',     'Max Loss/day',    `$${cfg.maxDailyLossUSD}`],
                ['cooldownMs',          'Cooldown',        `${cfg.cooldownMs}ms`],
                ['minTriangularNetPct', 'Min Triangular',  `${cfg.minTriangularNetPct}%`],
              ].map(([key, label, display]) => (
                <div key={key} style={{ display:'flex', justifyContent:'space-between', fontSize:11 }}>
                  <span style={{ color:'var(--text-dim)' }}>{label}</span>
                  <span style={{ fontWeight:700, color: changed.includes(key) ? 'var(--color-yellow)' : 'var(--text)' }}>
                    {display}
                  </span>
                </div>
              ))}
            </div>
          </Card>

        </div>
      </div>

      {/* ── ADVANCED PARAMETERS (schema-driven, ~24 more knobs) ───────────── */}
      {Object.keys(advancedByGroup).length > 0 && (
        <Card>
          <STitle sub={`${Object.values(advancedByGroup).flat().length} parámetros adicionales validados y hot-reloadable por el engine`}
            right={advancedChangedCount > 0 && (
              <span style={{ fontSize:10, background:'rgba(245,158,11,0.15)', color:'#F59E0B', padding:'2px 8px', borderRadius:10, fontWeight:800 }}>
                {advancedChangedCount} modificado(s)
              </span>
            )}>
            Parámetros avanzados — ejecución, riesgo, capital, rebalanceo, scoring
          </STitle>
          <div style={{ padding:'8px 16px' }}>
            {GROUP_ORDER.filter(g => advancedByGroup[g]).map(g => {
              const isOpen = openGroups[g] !== false; // default open
              const groupChanged = advancedByGroup[g].filter(([k]) => changed.includes(k)).length;
              return (
                <div key={g} style={{ borderBottom:'1px solid var(--border)', paddingBottom:8, marginBottom:8 }}>
                  <button onClick={() => toggleGroup(g)}
                    style={{ width:'100%', display:'flex', justifyContent:'space-between', alignItems:'center', background:'none', border:'none', cursor:'pointer', padding:'6px 0', color:'var(--text)' }}>
                    <span style={{ fontSize:12, fontWeight:800 }}>
                      {GROUP_META[g].icon} {GROUP_META[g].label}
                      {groupChanged > 0 && <span style={{ marginLeft:6, fontSize:9, color:'var(--color-yellow)' }}>({groupChanged} modificado{groupChanged > 1 ? 's' : ''})</span>}
                    </span>
                    <span style={{ fontSize:11, color:'var(--text-dim)' }}>{isOpen ? '▾' : '▸'}</span>
                  </button>
                  <div style={{ fontSize:9.5, color:'var(--text-dim)', marginBottom: isOpen ? 8 : 0 }}>{GROUP_META[g].desc}</div>
                  {isOpen && (
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'2px 24px' }}>
                      {advancedByGroup[g].map(([key, meta]) => (
                        <SchemaField key={key} paramKey={key} meta={meta}
                          value={draft[key] !== undefined ? draft[key] : cfg[key]}
                          onChange={(v) => setDraftKey(key, v)} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* ── HISTORY ───────────────────────────────────────────────────────── */}
      {history.length > 0 && (
        <Card>
          <STitle sub={`${history.length} change(s) en esta session`}>History de configuration</STitle>
          <div style={{ padding:'8px 16px', maxHeight:220, overflowY:'auto' }}>
            {history.slice(0, 15).map((entry, i) => (
              <div key={i} style={{ display:'flex', gap:10, alignItems:'flex-start', padding:'6px 0', borderBottom: i < Math.min(history.length - 1, 14) ? '1px solid var(--border)' : 'none' }}>
                <span style={{ fontSize:9, color:'var(--text-dim)', whiteSpace:'nowrap', flexShrink:0 }}>
                  {new Date(entry.ts).toLocaleTimeString()}
                </span>
                <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
                  {(entry.changes || []).map((c, ci) => (
                    <span key={ci} style={{ fontSize:10, background:'rgba(245,158,11,0.1)', color:'#F59E0B', padding:'1px 6px', borderRadius:3 }}>
                      {c.key}: {JSON.stringify(c.prev)} → {JSON.stringify(c.next)}
                    </span>
                  ))}
                </div>
                <span style={{ fontSize:9, color:'var(--text-dim)', flexShrink:0, marginLeft:'auto' }}>{entry.source}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * TenantBotPanel.jsx — Kukora
 *
 * "Mi Bot Personal": the per-user paper-trading bot (ADR-017), distinct
 * from the shared/demo bot controlled by the main "Opportunities" tab.
 * Talks to /api/tenant-bot/* via useTenantBot. Every user gets their own
 * isolated wallet, P&L, trade history, config overrides and risk-guard
 * circuit breaker — this panel is the first (and, until now, only) place
 * any of that is actually reachable from the UI; the backend primitives
 * existed for several sessions with zero HTTP/UI surface.
 *
 * Config UX notes:
 *  - Parameters are edited as a local draft and applied in ONE batched
 *    "Guardar" call — not per-field auto-save — because these routes share
 *    a 10 req/min per-uid budget with the bot toggle and risk-reset (see
 *    server/index.js financialControlLimiter). Auto-saving every slider
 *    tick would burn that budget in seconds.
 *  - Unlike LiveConfigPanel (which re-seeds its draft from every 5s poll,
 *    silently discarding in-progress edits), this panel seeds the draft
 *    ONCE on load and only re-seeds on an explicit "Descartar cambios" or
 *    after a successful save — so a slow typist doesn't lose their edits
 *    to their own background poll.
 *  - scoringWeights is auto-normalized to sum to 1.0 on save (the backend
 *    validator rejects anything else) so nudging one slider doesn't force
 *    the user to manually rebalance five others first.
 */
import { useState, useEffect, useMemo, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useTenantBot } from '../../hooks/useTenantBot';
import { EX_COLORS, fmt, fmtP } from './ArbitrageSharedComponents';

// Curated subset of the ~40 schema-declared parameters — the ones that
// meaningfully shape an individual's paper-trading strategy. Grouping
// comes straight from schema[key].group, so there's no duplicated
// metadata to drift out of sync with liveConfig.js.
const TENANT_KEYS = [
  'minScore', 'tradeAmountBTC', 'feeMode', 'minSpreadPct', 'maxSpreadPct', 'minNetProfitUSD', 'activeExchanges',
  'maxSlippagePct', 'orderExecutionPolicy', 'allowPartialFills', 'cooldownMs',
  'maxDrawdownPct', 'maxPositionValueUSD', 'maxDailyLossUSD',
  'scoringWeights',
];
const GROUP_META = {
  core:      { label: 'Estrategia', icon: '🎯' },
  execution: { label: 'Ejecución',  icon: '⚡' },
  risk:      { label: 'Riesgo',     icon: '🛡️' },
  scoring:   { label: 'Scoring',    icon: '◈' },
};
const GROUP_ORDER = ['core', 'execution', 'risk', 'scoring'];
const WEIGHT_KEYS = ['liquidity', 'spread', 'volatility', 'execution', 'reliability', 'latency'];

function Card({ children, style }) {
  return (
    <div style={{ borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'var(--bg-surface)', ...style }}>
      {children}
    </div>
  );
}
function STitle({ children, sub, right }) {
  return (
    <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div>
        <div style={{ fontWeight: 800, fontSize: 13, color: 'var(--text)' }}>{children}</div>
        {sub && <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 1 }}>{sub}</div>}
      </div>
      {right}
    </div>
  );
}
function StatChip({ label, value, color }) {
  return (
    <div style={{ padding: '8px 14px', borderRadius: 8, background: 'var(--bg-elevated)', border: '1px solid var(--border)', minWidth: 100 }}>
      <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: color || 'var(--text)', marginTop: 2 }}>{value}</div>
    </div>
  );
}

/** Sum a per-exchange wallet bucket (e.g. wallets.BTC = { Binance: 0.4, Kraken: 0.3, ... }) into a single total. */
function sumBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return 0;
  return Object.values(bucket).reduce((s, v) => s + (Number(v) || 0), 0);
}

function formatLabel(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
}
function formatEnumLabel(value) {
  return String(value).split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Generic control for one schema-declared parameter — number/boolean/enum/multiselect/weights. */
function Field({ paramKey, meta, value, onChange, exchangeOptions }) {
  const label = formatLabel(paramKey);
  if (!meta) return null;

  if (meta.type === 'boolean') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700 }}>{label}</div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>{meta.desc}</div>
        </div>
        <button
          onClick={() => onChange(!value)}
          style={{
            width: 40, height: 22, borderRadius: 99, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0,
            background: value ? 'var(--color-green, #22C55E)' : 'var(--bg-elevated)',
            transition: 'background 0.15s',
          }}
        >
          <span style={{
            position: 'absolute', top: 2, left: value ? 20 : 2, width: 18, height: 18, borderRadius: '50%',
            background: '#fff', transition: 'left 0.15s',
          }} />
        </button>
      </div>
    );
  }

  if (meta.type === 'enum') {
    return (
      <div style={{ padding: '8px 0' }}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 6 }}>{meta.desc}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {meta.options.map(opt => (
            <button key={opt} onClick={() => onChange(opt)} title={opt} style={{
              padding: '5px 12px', borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: 'pointer',
              border: `1px solid ${value === opt ? 'var(--color-primary, #FF2D78)' : 'var(--border)'}`,
              background: value === opt ? 'rgba(255,45,120,0.12)' : 'var(--bg-elevated)',
              color: value === opt ? 'var(--color-primary, #FF2D78)' : 'var(--text-dim)',
            }}>{formatEnumLabel(opt)}</button>
          ))}
        </div>
      </div>
    );
  }

  if (meta.type === 'multiselect') {
    const active = Array.isArray(value) ? value : [];
    const options = exchangeOptions?.length ? exchangeOptions : meta.options;
    return (
      <div style={{ padding: '8px 0' }}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 6 }}>{meta.desc}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {options.map(ex => {
            const isActive = active.includes(ex);
            const color = EX_COLORS[ex] || 'var(--color-primary)';
            return (
              <button key={ex} onClick={() => {
                if (isActive) {
                  if (active.length <= 1) { toast.error('Debe quedar al menos un exchange activo'); return; }
                  onChange(active.filter(e => e !== ex));
                } else {
                  onChange([...active, ex]);
                }
              }} style={{
                padding: '5px 12px', borderRadius: 99, fontSize: 11, fontWeight: 700, cursor: 'pointer',
                border: `1px solid ${isActive ? color : 'var(--border)'}`,
                background: isActive ? `${color}22` : 'var(--bg-elevated)',
                color: isActive ? color : 'var(--text-dim)',
              }}>{ex}</button>
            );
          })}
        </div>
      </div>
    );
  }

  if (meta.type === 'weights') {
    const w = value && typeof value === 'object' ? value : {};
    const sum = (meta.keys || WEIGHT_KEYS).reduce((s, k) => s + (Number(w[k]) || 0), 0);
    const nearOne = Math.abs(sum - 1) <= 0.02;
    return (
      <div style={{ padding: '8px 0' }}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 8 }}>{meta.desc}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(meta.keys || WEIGHT_KEYS).map(k => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 78, fontSize: 10.5, fontWeight: 700, color: 'var(--text-dim)', flexShrink: 0 }}>{formatLabel(k)}</div>
              <input type="range" min={0} max={1} step={0.01} value={w[k] ?? 0}
                onChange={e => onChange({ ...w, [k]: parseFloat(e.target.value) })}
                style={{ flex: 1, accentColor: 'var(--color-primary, #FF2D78)', height: 4 }} />
              <div style={{ width: 40, fontSize: 11, fontWeight: 800, textAlign: 'right', flexShrink: 0 }}>{((w[k] ?? 0) * 100).toFixed(0)}%</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 6, fontSize: 10, fontWeight: 700, color: nearOne ? 'var(--color-green, #22C55E)' : '#F59E0B' }}>
          Suma: {(sum * 100).toFixed(0)}% {!nearOne && '— se normalizará automáticamente al guardar'}
        </div>
      </div>
    );
  }

  // number (default)
  const decimals = meta.step && meta.step < 1 ? String(meta.step).split('.')[1]?.length || 2 : 0;
  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ fontSize: 12, fontWeight: 700 }}>{label}</div>
        <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--color-primary, #FF2D78)' }}>
          {Number(value).toFixed(decimals)}{meta.unit ? ` ${meta.unit}` : ''}
        </div>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-dim)', margin: '2px 0 6px' }}>{meta.desc}</div>
      <input type="range" min={meta.min} max={meta.max} step={meta.step}
        value={value ?? meta.min}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--color-primary, #FF2D78)', height: 4 }} />
    </div>
  );
}

function normalizeWeights(w, keys) {
  const total = keys.reduce((s, k) => s + (Number(w[k]) || 0), 0);
  if (total <= 0) return w;
  const out = {};
  keys.forEach(k => { out[k] = +((Number(w[k]) || 0) / total).toFixed(4); });
  // Floating point safety net: force the last key to absorb any residual
  // so the sum is exactly 1.0 and never fails the backend's ±0.01 check.
  const runningSum = keys.slice(0, -1).reduce((s, k) => s + out[k], 0);
  out[keys[keys.length - 1]] = +(1 - runningSum).toFixed(4);
  return out;
}

export default function TenantBotPanel() {
  const {
    status, schema, globalConfig, loading, error,
    toggleBot, saveConfig, clearOverride, resetAllOverrides, resetRisk,
  } = useTenantBot();

  const [draft, setDraft] = useState(null);
  const [initialDraft, setInitialDraft] = useState(null);
  const [toggling, setToggling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resettingRisk, setResettingRisk] = useState(false);

  // Seed the draft ONCE per real data arrival — not on every 5s poll — so
  // in-progress edits survive the background refresh. See file header.
  useEffect(() => {
    if (!schema || !globalConfig || !status || draft) return;
    const seeded = {};
    TENANT_KEYS.forEach(k => {
      seeded[k] = Object.prototype.hasOwnProperty.call(status.configOverrides || {}, k)
        ? status.configOverrides[k]
        : globalConfig[k];
    });
    setDraft(seeded);
    setInitialDraft(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, globalConfig, status]);

  const discardChanges = useCallback(() => {
    if (initialDraft) setDraft({ ...initialDraft });
  }, [initialDraft]);

  const hasChanges = useMemo(() => {
    if (!draft || !initialDraft) return false;
    return TENANT_KEYS.some(k => JSON.stringify(draft[k]) !== JSON.stringify(initialDraft[k]));
  }, [draft, initialDraft]);

  const handleToggle = async () => {
    setToggling(true);
    try {
      const next = !status?.botStatus?.enabled;
      const res = await toggleBot(next);
      if (res.ok) toast.success(next ? '✅ Tu bot personal está encendido' : '⏸ Tu bot personal está pausado');
    } catch (e) { toast.error(e.message); }
    finally { setToggling(false); }
  };

  const handleSave = async () => {
    if (!draft || !initialDraft) return;
    const patch = {};
    TENANT_KEYS.forEach(k => {
      if (JSON.stringify(draft[k]) !== JSON.stringify(initialDraft[k])) patch[k] = draft[k];
    });
    if (patch.scoringWeights) {
      patch.scoringWeights = normalizeWeights(patch.scoringWeights, WEIGHT_KEYS);
    }
    if (Object.keys(patch).length === 0) return;

    setSaving(true);
    try {
      const result = await saveConfig(patch);
      const appliedCount = result?.applied?.length || 0;
      if (result?.rejected?.length) {
        toast.error(`No se aplicó: ${result.rejected.map(r => `${r.key} (${r.reason})`).join(', ')}`);
      }
      if (appliedCount > 0) {
        toast.success(`✅ ${appliedCount} parámetro(s) guardado(s)`);
        const merged = { ...draft };
        result.applied.forEach(a => { merged[a.key] = a.next; });
        setDraft(merged);
        setInitialDraft(merged);
      }
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  const handleClearOverride = async (key) => {
    try {
      await clearOverride(key);
      const fallback = globalConfig?.[key];
      setDraft(prev => ({ ...prev, [key]: fallback }));
      setInitialDraft(prev => ({ ...prev, [key]: fallback }));
      toast.success(`↺ ${formatLabel(key)} vuelve al valor global`);
    } catch (e) { toast.error(e.message); }
  };

  const handleResetAll = async () => {
    try {
      await resetAllOverrides();
      const seeded = {};
      TENANT_KEYS.forEach(k => { seeded[k] = globalConfig?.[k]; });
      setDraft(seeded);
      setInitialDraft(seeded);
      toast.success('↺ Todos tus parámetros vuelven al valor global');
    } catch (e) { toast.error(e.message); }
  };

  const handleResetRisk = async () => {
    setResettingRisk(true);
    try {
      await resetRisk();
      toast.success('✅ Circuit breaker reiniciado');
    } catch (e) { toast.error(e.message); }
    finally { setResettingRisk(false); }
  };

  if (loading && !status) {
    return <Card style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>Cargando tu bot personal…</Card>;
  }
  if (error && !status) {
    return <Card style={{ padding: 24, textAlign: 'center', color: '#F59E0B', fontSize: 12 }}>{error}</Card>;
  }

  const botOn = !!status?.botStatus?.enabled;
  const wallets = status?.wallets || {};
  const pnl = status?.pnl || {};
  const risk = status?.risk || {};
  const history = status?.history || [];
  const exchangeOptions = schema?.activeExchanges?.options || [];
  const overrides = status?.configOverrides || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header / toggle */}
      <Card>
        <STitle
          sub="Tu propio paper-trading bot, aislado del bot compartido — tu propio wallet, P&L y configuración"
          right={
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderRadius: 99,
              background: botOn ? 'rgba(34,197,94,0.10)' : 'rgba(148,163,184,0.10)',
              border: `1px solid ${botOn ? 'rgba(34,197,94,0.3)' : 'var(--border)'}`,
              fontSize: 10, fontWeight: 800, color: botOn ? 'var(--color-green, #22C55E)' : 'var(--text-dim)',
            }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', animation: botOn ? 'pulseDot 1.5s infinite' : 'none' }} />
              {botOn ? 'ENCENDIDO' : 'APAGADO'}
            </div>
          }
        >
          🤖 Mi Bot Personal
        </STitle>
        <div style={{ padding: 18 }}>
          <button
            onClick={handleToggle}
            disabled={toggling}
            style={{
              padding: '10px 20px', borderRadius: 8, fontWeight: 800, fontSize: 12, cursor: toggling ? 'not-allowed' : 'pointer',
              border: 'none', opacity: toggling ? 0.6 : 1,
              background: botOn ? 'rgba(239,68,68,0.15)' : 'var(--color-green, #22C55E)',
              color: botOn ? 'var(--color-red, #EF4444)' : '#000',
            }}
          >
            {toggling ? '...' : botOn ? '⏸ Apagar mi bot' : '▶ Encender mi bot'}
          </button>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
            <StatChip label="BTC" value={fmt(sumBucket(wallets.BTC), 4)} />
            <StatChip label="ETH" value={fmt(sumBucket(wallets.ETH), 3)} />
            <StatChip label="XRP" value={fmt(sumBucket(wallets.XRP), 1)} />
            <StatChip label="USDT" value={fmt(sumBucket(wallets.USDT), 0)} />
            <StatChip label="P&L Total" value={fmtP(pnl.totalPnl, 2)} color={(pnl.totalPnl || 0) >= 0 ? 'var(--color-green, #22C55E)' : 'var(--color-red, #EF4444)'} />
            <StatChip label="Trades" value={pnl.totalTrades || 0} />
            <StatChip label="Win Rate" value={`${fmt(pnl.winRate, 1)}%`} />
          </div>
        </div>
      </Card>

      {/* Risk guard */}
      <Card>
        <STitle sub="Circuit breaker aislado — drawdown, pérdidas consecutivas y tamaño de posición para TU wallet">🛡️ Mi Risk Guard</STitle>
        <div style={{ padding: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          {risk.active ? (
            <>
              <div>
                <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--color-red, #EF4444)' }}>⛔ Circuit breaker activo</div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>{risk.reason}</div>
              </div>
              <button onClick={handleResetRisk} disabled={resettingRisk} style={{
                padding: '8px 16px', borderRadius: 7, fontWeight: 700, fontSize: 11, cursor: 'pointer',
                border: '1px solid rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.1)', color: 'var(--color-red, #EF4444)',
                opacity: resettingRisk ? 0.6 : 1,
              }}>{resettingRisk ? '...' : 'Reiniciar breaker'}</button>
            </>
          ) : (
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-green, #22C55E)' }}>✓ Sin bloqueos activos</div>
          )}
        </div>
      </Card>

      {/* Config */}
      <Card>
        <STitle
          sub="Parámetros propios — se aplican sobre la config global solo para tu bot"
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              {hasChanges && (
                <button onClick={discardChanges} style={{ padding: '6px 12px', borderRadius: 7, fontWeight: 700, fontSize: 11, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-dim)' }}>
                  Descartar cambios
                </button>
              )}
              {Object.keys(overrides).length > 0 && (
                <button onClick={handleResetAll} style={{ padding: '6px 12px', borderRadius: 7, fontWeight: 700, fontSize: 11, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-dim)' }}>
                  ↺ Restaurar todo
                </button>
              )}
              <button onClick={handleSave} disabled={!hasChanges || saving} style={{
                padding: '6px 16px', borderRadius: 7, fontWeight: 800, fontSize: 11, cursor: (!hasChanges || saving) ? 'not-allowed' : 'pointer',
                border: 'none', background: hasChanges ? 'var(--color-green, #22C55E)' : 'var(--bg-elevated)',
                color: hasChanges ? '#000' : 'var(--text-dim)', opacity: saving ? 0.6 : 1,
              }}>{saving ? 'Guardando…' : 'Guardar mis parámetros'}</button>
            </div>
          }
        >
          ⚙️ Configuración personal
        </STitle>
        <div style={{ padding: '4px 18px 18px' }}>
          {!draft && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>Cargando esquema…</div>}
          {draft && GROUP_ORDER.map(groupKey => {
            const keysInGroup = TENANT_KEYS.filter(k => schema?.[k]?.group === groupKey);
            if (keysInGroup.length === 0) return null;
            const meta = GROUP_META[groupKey];
            return (
              <div key={groupKey} style={{ marginTop: 14 }}>
                <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.06em', color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 2 }}>
                  {meta.icon} {meta.label}
                </div>
                <div style={{ borderTop: '1px solid var(--border)' }} />
                {keysInGroup.map(key => (
                  <div key={key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, borderBottom: '1px solid var(--border)' }}>
                    <div style={{ flex: 1 }}>
                      <Field
                        paramKey={key}
                        meta={schema[key]}
                        value={draft[key]}
                        onChange={v => setDraft(prev => ({ ...prev, [key]: v }))}
                        exchangeOptions={exchangeOptions}
                      />
                    </div>
                    {Object.prototype.hasOwnProperty.call(overrides, key) && (
                      <button
                        onClick={() => handleClearOverride(key)}
                        title="Volver al valor global (borra tu override)"
                        style={{ marginTop: 10, flexShrink: 0, fontSize: 9, fontWeight: 700, padding: '3px 8px', borderRadius: 6, cursor: 'pointer', border: '1px solid rgba(0,82,255,0.3)', background: 'rgba(0,82,255,0.08)', color: '#0052FF' }}
                      >override</button>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </Card>

      {/* Recent history */}
      <Card>
        <STitle sub="Últimos trades ejecutados por tu bot personal">📋 Historial reciente</STitle>
        <div style={{ padding: history.length ? 0 : 18 }}>
          {history.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>Sin trades todavía — enciende tu bot para empezar</div>
          ) : (
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              {history.slice(0, 10).map((t, i) => (
                <div key={t.id || i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 18px', borderBottom: i < history.length - 1 ? '1px solid var(--border)' : 'none', fontSize: 11 }}>
                  <span style={{ color: 'var(--text-dim)' }}>{t.ts ? new Date(t.ts).toLocaleTimeString() : '—'}</span>
                  <span style={{ fontWeight: 700 }}>{t.asset || 'BTC'}</span>
                  <span style={{ color: 'var(--text-dim)' }}>{t.buyExchange} → {t.sellExchange}</span>
                  <span style={{ fontWeight: 800, color: (t.netProfit || 0) >= 0 ? 'var(--color-green, #22C55E)' : 'var(--color-red, #EF4444)' }}>
                    {fmtP(t.netProfit, 2)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

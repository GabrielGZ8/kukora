// RiskProfileSection.jsx — refinamiento post-Sesión 34
// ("Profundidad y parametrización" — ver server/domain/risk/userRiskProfileService.js).
//
// Deja que cada usuario fije límites de riesgo propios (position size, daily
// loss, slippage, exchanges habilitados), siempre más estrictos o iguales al
// default global — nunca más laxos. `effective` refleja el valor que
// REALMENTE rige ahora mismo (ya recortado contra el límite global vigente),
// para que la UI nunca prometa un número más laxo del que en la práctica se
// aplica en `_runInstitutionalRiskGate()` de liveExecution.js.
import { useState, useEffect } from 'react';
import { api } from '../../api';
import { card, cardHeader, cardBody, label, input, btnPrimary, SectionTitle, StatusPill } from './settingsHelpers';

const ALL_EXCHANGES = ['Binance', 'Kraken', 'Bybit', 'OKX', 'Coinbase'];

const FIELD_DEFS = [
  { key: 'maxPositionValueUSD', title: 'Tamaño máximo de posición', unit: 'USD', placeholder: 'ej. 2000', hint: 'Nunca más laxo que el límite global de la plataforma.' },
  { key: 'maxDailyLossUSD',     title: 'Pérdida diaria máxima',     unit: 'USD', placeholder: 'ej. -100', hint: 'Debe ser 0 o negativo — tu propio circuit breaker de pérdida diaria.' },
  { key: 'maxSlippagePct',      title: 'Slippage máximo tolerado',  unit: '%',   placeholder: 'ej. 0.05', hint: 'Bloquea la ejecución si el slippage estimado supera este %.' },
  { key: 'maxDrawdownPct',      title: 'Drawdown máximo (informativo)', unit: '%', placeholder: 'ej. 5', hint: 'Nota: el circuit breaker de drawdown sigue siendo global — este campo queda para referencia futura.' },
];

function RiskProfileSection() {
  const [profile, setProfile]     = useState(null);
  const [effective, setEffective] = useState(null);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);
  const [error, setError]         = useState('');
  const [drafts, setDrafts]       = useState({});
  const [exchanges, setExchanges] = useState(null); // null = "usar default global (todos)"

  const refresh = () => {
    api.trading.getRiskProfile()
      .then(res => {
        const data = res?.data || res;
        setProfile(data.profile);
        setEffective(data.effective || {});
        setExchanges(data.profile?.activeExchanges || null);
      })
      .catch(() => setError('No se pudo cargar tu perfil de riesgo.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  function draftValue(key) {
    if (key in drafts) return drafts[key];
    const raw = profile?.[key];
    return raw == null ? '' : String(raw);
  }

  function setDraft(key, val) {
    setDrafts(prev => ({ ...prev, [key]: val }));
  }

  function toggleExchange(ex) {
    const base = exchanges || ALL_EXCHANGES;
    const cur = base.includes(ex) ? base.filter(e => e !== ex) : [...base, ex];
    setExchanges(cur.length === ALL_EXCHANGES.length ? null : cur);
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const updates = {};
      for (const { key } of FIELD_DEFS) {
        if (!(key in drafts)) continue;
        const raw = drafts[key];
        updates[key] = raw === '' ? null : Number(raw);
      }
      // activeExchanges: solo se manda si el usuario restringió algo — si
      // volvió a "todos", se manda null explícito para limpiar el override.
      if (exchanges !== undefined) updates.activeExchanges = exchanges;

      const res = await api.trading.setRiskProfile(updates);
      const data = res?.data || res;
      setProfile(data.profile);
      setEffective(data.effective || {});
      setDrafts({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e.message || 'No se pudo guardar tu perfil de riesgo.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;

  const hasAnyOverride = profile && FIELD_DEFS.some(f => profile[f.key] != null) || (profile?.activeExchanges);

  return (
    <div style={card}>
      <div style={cardHeader}>
        <SectionTitle
          icon="🎯"
          title="Perfil de riesgo personal"
          subtitle="Límites propios sobre tu capital — siempre iguales o más estrictos que el límite global del sistema."
        />
        {hasAnyOverride && <StatusPill type="info">Overrides activos</StatusPill>}
      </div>

      <div style={cardBody}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginBottom: 22 }}>
          {FIELD_DEFS.map(f => {
            const effVal = effective?.[f.key];
            return (
              <div key={f.key}>
                <label style={label}>{f.title}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="number"
                    step="any"
                    value={draftValue(f.key)}
                    onChange={e => setDraft(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    style={{ ...input, flex: 1 }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>{f.unit}</span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.4 }}>
                  {f.hint}
                  {effVal != null && (
                    <div style={{ marginTop: 2 }}>
                      Vigente ahora: <b style={{ color: 'var(--text)' }}>{effVal}{f.unit === '%' ? '%' : ` ${f.unit}`}</b>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ marginBottom: 22 }}>
          <label style={label}>Exchanges habilitados para tu propio trading en vivo</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {ALL_EXCHANGES.map(ex => {
              const active = (exchanges || ALL_EXCHANGES).includes(ex);
              return (
                <button
                  key={ex}
                  onClick={() => toggleExchange(ex)}
                  style={{
                    padding: '6px 14px', borderRadius: 99, fontSize: 11, fontWeight: 700,
                    cursor: 'pointer', border: `1px solid ${active ? 'var(--color-primary)' : 'var(--border)'}`,
                    background: active ? 'rgba(255,45,120,0.10)' : 'var(--bg-elevated)',
                    color: active ? 'var(--color-primary)' : 'var(--text-dim)',
                  }}
                >
                  {ex}{active && ' ✓'}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
            Restringe en cuáles exchanges se te permite ejecutar — útil si solo configuraste API keys en algunos.
          </div>
        </div>

        {error && (
          <div style={{ marginBottom: 14 }}>
            <StatusPill type="error">✕ {error}</StatusPill>
          </div>
        )}

        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            ...btnPrimary,
            background: saved ? 'rgba(34,197,94,0.15)' : 'var(--color-green, #22C55E)',
            color: saved ? 'var(--color-green, #22C55E)' : '#000',
            border: saved ? '1px solid var(--color-green, #22C55E)' : 'none',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Guardando…' : saved ? '✓ Guardado' : 'Guardar perfil de riesgo'}
        </button>
      </div>
    </div>
  );
}

export { RiskProfileSection };

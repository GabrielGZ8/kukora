import { useState, useEffect, useRef } from 'react';
import { useTradingMode } from '../../hooks/useTradingMode';

/**
 * TradingPanel — LIVE/PAPER mode switch + active pair selector + capital
 * allocation sliders. Drop into ArbitragePage or a Settings page.
 */

const PAIR_COLORS = {
  'BTC/USDT': '#F7931A',
  'ETH/USDT': '#627EEA',
  'SOL/USDT': '#9945FF',
  'BNB/USDT': '#F3BA2F',
  'XRP/USDT': '#00AAE4',
};

export function TradingModeBadge({ compact = false }) {
  const { mode, loading } = useTradingMode();
  if (loading) return null;
  const isLive = mode === 'live';
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: compact ? '2px 8px' : '4px 10px',
      borderRadius: 99,
      background: isLive ? 'rgba(239,68,68,0.12)' : 'rgba(34,197,94,0.10)',
      border: `1px solid ${isLive ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.3)'}`,
      fontSize: compact ? 9 : 10,
      fontWeight: 800,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color: isLive ? 'var(--color-red, #EF4444)' : 'var(--color-green, #22C55E)',
    }}>
      <span style={{
        width: 5, height: 5, borderRadius: '50%',
        background: isLive ? 'var(--color-red, #EF4444)' : 'var(--color-green, #22C55E)',
      }} />
      {isLive ? 'LIVE' : 'PAPER'}
    </div>
  );
}

export default function TradingPanel() {
  const { mode, liveEnabled, loading, setMode, pairs, setPairs, userConfig, supported } = useTradingMode();
  const [changing, setChanging] = useState(false);
  const [error, setError]       = useState('');
  const [localPairs, setLocalPairs] = useState(null);
  const [localAlloc, setLocalAlloc] = useState(null);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const savedTimerRef = useRef(null);

  // Cleanup on unmount to avoid state update on unmounted component
  useEffect(() => () => clearTimeout(savedTimerRef.current), []);

  const activePairs = localPairs || pairs;
  const alloc        = localAlloc || userConfig?.allocation || {};

  async function handleModeToggle() {
    const next = mode === 'paper' ? 'live' : 'paper';
    if (next === 'live' && !liveEnabled) {
      setError('Live trading is disabled. Set LIVE_TRADING_ENABLED=true and configure Binance API keys in your environment.');
      return;
    }
    if (next === 'live') {
      const confirmed = window.confirm('⚠️ Switch to LIVE mode?\n\nReal orders will be placed on the exchange.\nMake sure your API keys are configured correctly.');
      if (!confirmed) return;
    }
    setChanging(true);
    setError('');
    try { await setMode(next); } catch (e) { setError(e.message); }
    finally { setChanging(false); }
  }

  function togglePair(pair) {
    const cur = [...activePairs];
    const idx = cur.indexOf(pair);
    if (idx >= 0) {
      if (cur.length === 1) return; // keep at least 1 pair active
      cur.splice(idx, 1);
    } else {
      cur.push(pair);
    }
    setLocalPairs(cur);
    const eq = {};
    cur.forEach(p => { eq[p] = +(1 / cur.length).toFixed(3); });
    setLocalAlloc(eq);
  }

  function setAllocPct(pair, pct) {
    const v = Math.max(0, Math.min(100, Number(pct)));
    setLocalAlloc(prev => ({ ...(prev || alloc), [pair]: v / 100 }));
  }

  async function handleSavePairs() {
    setSaving(true);
    setError('');
    try {
      await setPairs({ pairs: activePairs, allocation: alloc });
      setSaved(true);
      setLocalPairs(null);
      setLocalAlloc(null);
      clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;

  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 12, overflow: 'hidden',
    }}>
      <div style={{
        padding: '14px 18px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Trading Configuration
        </div>
        <TradingModeBadge />
      </div>

      <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Mode toggle */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
            Execution Mode
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {['paper', 'live'].map(m => (
              <button
                key={m}
                onClick={m !== mode ? handleModeToggle : undefined}
                disabled={changing || (m === 'live' && !liveEnabled)}
                style={{
                  flex: 1, padding: '9px 0', borderRadius: 8,
                  fontSize: 12, fontWeight: 700, cursor: (m === mode || changing) ? 'default' : 'pointer',
                  border: `1px solid ${mode === m ? (m === 'live' ? 'rgba(239,68,68,0.5)' : 'rgba(34,197,94,0.5)') : 'var(--border)'}`,
                  background: mode === m ? (m === 'live' ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.08)') : 'var(--bg-elevated)',
                  color: mode === m ? (m === 'live' ? 'var(--color-red, #EF4444)' : 'var(--color-green, #22C55E)') : 'var(--text-dim)',
                  opacity: (m === 'live' && !liveEnabled) ? 0.4 : 1,
                  transition: 'all 0.15s',
                }}
              >
                {m === 'live' ? 'Live' : 'Paper'}
                {m === 'live' && !liveEnabled && <span style={{ fontSize: 9, display: 'block', marginTop: 2, fontWeight: 500 }}>requires env var</span>}
              </button>
            ))}
          </div>
          {!liveEnabled && (
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 6 }}>
              Set <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-elevated)', padding: '1px 4px', borderRadius: 3 }}>LIVE_TRADING_ENABLED=true</code> plus Binance API keys to enable live mode.
            </div>
          )}
        </div>

        {/* Pair selector */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
            Active Pairs
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(supported.length ? supported : Object.keys(PAIR_COLORS)).map(pair => {
              const active = activePairs.includes(pair);
              const color  = PAIR_COLORS[pair] || 'var(--color-primary)';
              return (
                <button
                  key={pair}
                  onClick={() => togglePair(pair)}
                  style={{
                    padding: '5px 12px', borderRadius: 99, fontSize: 11, fontWeight: 700,
                    cursor: 'pointer', transition: 'all 0.15s',
                    border: `1px solid ${active ? color : 'var(--border)'}`,
                    background: active ? `${color}18` : 'var(--bg-elevated)',
                    color: active ? color : 'var(--text-dim)',
                  }}
                >
                  {pair.replace('/USDT', '')}
                </button>
              );
            })}
          </div>
        </div>

        {/* Capital allocation */}
        {activePairs.length > 1 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
              Capital Allocation
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {activePairs.map(pair => {
                const pct   = Math.round((alloc[pair] || 0) * 100);
                const color = PAIR_COLORS[pair] || 'var(--color-primary)';
                return (
                  <div key={pair} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 36, fontSize: 10, fontWeight: 700, color, flexShrink: 0 }}>
                      {pair.replace('/USDT', '')}
                    </div>
                    <input
                      type="range" min={0} max={100} value={pct}
                      onChange={e => setAllocPct(pair, e.target.value)}
                      style={{ flex: 1, accentColor: color }}
                    />
                    <div style={{ width: 32, fontSize: 11, fontWeight: 700, color: 'var(--text)', textAlign: 'right', flexShrink: 0 }}>
                      {pct}%
                    </div>
                  </div>
                );
              })}
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
                Total: {activePairs.reduce((s, p) => s + Math.round((alloc[p] || 0) * 100), 0)}% (normalized on save)
              </div>
            </div>
          </div>
        )}

        {error && (
          <div style={{
            padding: '8px 12px', borderRadius: 8, fontSize: 12,
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
            color: 'var(--color-red, #EF4444)',
          }}>
            {error}
          </div>
        )}

        <button
          onClick={handleSavePairs}
          disabled={saving}
          style={{
            padding: '10px 0', borderRadius: 8, fontSize: 12, fontWeight: 700,
            cursor: saving ? 'not-allowed' : 'pointer',
            background: saved ? 'rgba(34,197,94,0.15)' : 'var(--color-green, #22C55E)',
            color: saved ? 'var(--color-green, #22C55E)' : '#000',
            border: saved ? '1px solid var(--color-green, #22C55E)' : 'none',
            transition: 'all 0.2s',
          }}
        >
          {saving ? 'Saving...' : saved ? 'Saved' : 'Save Configuration'}
        </button>
      </div>
    </div>
  );
}

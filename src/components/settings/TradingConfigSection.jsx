import { useState } from 'react';
import { useTradingMode } from '../../hooks/useTradingMode';
import { card, cardHeader, cardBody, label, btnPrimary, SectionTitle, StatusPill } from './settingsHelpers';
import { useTranslation } from '../../i18n/I18nContext';

// ─── Trading Config Section ─────────────────────────────────────────────────
const PAIR_COLORS = {
  'BTC/USDT': '#F7931A', 'ETH/USDT': '#627EEA',
  'SOL/USDT': '#9945FF', 'BNB/USDT': '#F3BA2F', 'XRP/USDT': '#00AAE4',
};
const PAIR_LOGOS = {
  'BTC/USDT': '₿', 'ETH/USDT': 'Ξ', 'SOL/USDT': '◎', 'BNB/USDT': '⬡', 'XRP/USDT': '✕',
};

function TradingConfigSection() {
  const { t } = useTranslation();
  const { mode, liveEnabled, loading, setMode, pairs, setPairs, userConfig, supported } = useTradingMode();
  const [changingMode, setChangingMode] = useState(false);
  const [localPairs, setLocalPairs]     = useState(null);
  const [localAlloc, setLocalAlloc]     = useState(null);
  const [saving, setSaving]             = useState(false);
  const [saved, setSaved]               = useState(false);
  const [modeStatus, setModeStatus]     = useState(null);
  const [pairError, setPairError]       = useState('');

  const activePairs = localPairs || pairs;
  const alloc       = localAlloc || userConfig?.allocation || {};
  const allPairs    = supported.length ? supported : Object.keys(PAIR_COLORS);

  function togglePair(pair) {
    const cur = [...activePairs];
    const idx = cur.indexOf(pair);
    if (idx >= 0) {
      if (cur.length === 1) { setPairError(t('settingsSections.trading.minOnePair')); return; }
      cur.splice(idx, 1);
    } else {
      cur.push(pair);
    }
    setPairError('');
    setLocalPairs(cur);
    const eq = {};
    cur.forEach(p => { eq[p] = +(1 / cur.length).toFixed(4); });
    setLocalAlloc(eq);
  }

  function setAllocPct(pair, pct) {
    const v = Math.max(0, Math.min(100, Number(pct)));
    setLocalAlloc(prev => ({ ...(prev || alloc), [pair]: +(v / 100).toFixed(4) }));
  }

  async function handleModeToggle(next) {
    if (next === mode) return;
    if (next === 'live' && !liveEnabled) return;
    if (next === 'live') {
      const ok = window.confirm(t('settingsSections.trading.confirmLiveSwitch'));
      if (!ok) return;
    }
    setChangingMode(true);
    setModeStatus(null);
    try {
      await setMode(next);
      setModeStatus('ok');
    } catch (e) {
      setModeStatus('error');
    } finally {
      setChangingMode(false);
      setTimeout(() => setModeStatus(null), 2500);
    }
  }

  async function handleSavePairs() {
    setSaving(true);
    setPairError('');
    try {
      await setPairs({ pairs: activePairs, allocation: alloc });
      setSaved(true);
      setLocalPairs(null);
      setLocalAlloc(null);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setPairError(e.message || t('settingsSections.trading.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;

  const isLive  = mode === 'live';
  const allocSum = activePairs.reduce((s, p) => s + Math.round((alloc[p] || 0) * 100), 0);

  return (
    <div style={card}>
      <div style={cardHeader}>
        <SectionTitle icon="⚙️" title={t('settingsSections.trading.title')} subtitle={t('settingsSections.trading.subtitle')} />
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '4px 12px', borderRadius: 99,
          background: isLive ? 'rgba(239,68,68,0.12)' : 'rgba(34,197,94,0.10)',
          border: `1px solid ${isLive ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.3)'}`,
          fontSize: 10, fontWeight: 800, letterSpacing: '0.06em',
          color: isLive ? 'var(--color-red, #EF4444)' : 'var(--color-green, #22C55E)',
        }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', animation: 'pulse 2s infinite' }} />
          {isLive ? `⚡ ${t('settingsSections.trading.liveBadge')}` : `📄 ${t('settingsSections.trading.paperBadge')}`}
        </div>
      </div>

      <div style={cardBody}>
        {/* Mode selector */}
        <div style={{ marginBottom: 28 }}>
          <label style={label}>{t('settingsSections.trading.executionMode')}</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {['paper', 'live'].map(m => {
              const active = mode === m;
              const isLiveOpt = m === 'live';
              const locked = isLiveOpt && !liveEnabled;
              return (
                <button
                  key={m}
                  onClick={() => handleModeToggle(m)}
                  disabled={changingMode || locked}
                  style={{
                    padding: '14px 0', borderRadius: 10, fontSize: 13, fontWeight: 700,
                    cursor: locked || changingMode ? 'not-allowed' : 'pointer',
                    border: `1px solid ${active ? (isLiveOpt ? 'rgba(239,68,68,0.5)' : 'rgba(34,197,94,0.5)') : 'var(--border)'}`,
                    background: active
                      ? (isLiveOpt ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.08)')
                      : 'var(--bg-elevated)',
                    color: active
                      ? (isLiveOpt ? 'var(--color-red, #EF4444)' : 'var(--color-green, #22C55E)')
                      : 'var(--text-dim)',
                    opacity: locked ? 0.4 : 1,
                    transition: 'all 0.15s',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                  }}
                >
                  <span style={{ fontSize: 22 }}>{isLiveOpt ? '⚡' : '📄'}</span>
                  <span>{isLiveOpt ? t('settingsSections.trading.liveTrading') : t('settingsSections.trading.paperTrading')}</span>
                  {locked && (
                    <span style={{ fontSize: 9, fontWeight: 500, opacity: 0.7 }}>
                      LIVE_TRADING_ENABLED=false
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {!liveEnabled && (
            <div style={{
              marginTop: 10, padding: '10px 14px', borderRadius: 8,
              background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
              fontSize: 11, color: '#F59E0B',
            }}>
              {t('settingsSections.trading.enableLivePrefix')}{' '}
              <code style={{ fontFamily: 'var(--font-mono)', background: 'rgba(245,158,11,0.15)', padding: '1px 5px', borderRadius: 3 }}>
                LIVE_TRADING_ENABLED=true
              </code>{' '}
              {t('settingsSections.trading.enableLiveAnd')} <code style={{ fontFamily: 'var(--font-mono)', background: 'rgba(245,158,11,0.15)', padding: '1px 5px', borderRadius: 3 }}>BINANCE_API_KEY</code> / <code style={{ fontFamily: 'var(--font-mono)', background: 'rgba(245,158,11,0.15)', padding: '1px 5px', borderRadius: 3 }}>BINANCE_API_SECRET</code> {t('settingsSections.trading.enableLiveSuffix')}
            </div>
          )}
          {modeStatus && (
            <div style={{ marginTop: 10 }}>
              <StatusPill type={modeStatus === 'ok' ? 'success' : 'error'}>
                {modeStatus === 'ok' ? `✓ ${t('settingsSections.trading.modeUpdated')}` : `✕ ${t('settingsSections.trading.modeChangeFailed')}`}
              </StatusPill>
            </div>
          )}
        </div>

        {/* Active pairs */}
        <div style={{ marginBottom: 28 }}>
          <label style={label}>{t('settingsSections.trading.activePairs')}</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {allPairs.map(pair => {
              const active = activePairs.includes(pair);
              const color  = PAIR_COLORS[pair] || 'var(--color-primary)';
              const logo   = PAIR_LOGOS[pair] || '◆';
              return (
                <button
                  key={pair}
                  onClick={() => togglePair(pair)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 16px', borderRadius: 99, fontSize: 12, fontWeight: 700,
                    cursor: 'pointer', transition: 'all 0.15s',
                    border: `1px solid ${active ? color : 'var(--border)'}`,
                    background: active ? `${color}18` : 'var(--bg-elevated)',
                    color: active ? color : 'var(--text-dim)',
                  }}
                >
                  <span style={{ fontSize: 14 }}>{logo}</span>
                  {pair.replace('/USDT', '')}
                  {active && <span style={{ fontSize: 9, opacity: 0.7 }}>✓</span>}
                </button>
              );
            })}
          </div>
          {pairError && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-red, #EF4444)' }}>{pairError}</div>
          )}
        </div>

        {/* Capital allocation */}
        {activePairs.length > 1 && (
          <div style={{ marginBottom: 24 }}>
            <label style={label}>{t('settingsSections.trading.capitalAllocation')} <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>{t('settingsSections.trading.allocTotalPrefix')} {allocSum}%{allocSum !== 100 && ` ${t('settingsSections.trading.allocWillNormalize')}`}</span></label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {activePairs.map(pair => {
                const pct   = Math.round((alloc[pair] || 0) * 100);
                const color = PAIR_COLORS[pair] || 'var(--color-primary)';
                const logo  = PAIR_LOGOS[pair] || '◆';
                return (
                  <div key={pair} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 52, display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                      <span style={{ fontSize: 14 }}>{logo}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color }}>{pair.replace('/USDT', '')}</span>
                    </div>
                    <input
                      type="range" min={0} max={100} value={pct}
                      onChange={e => setAllocPct(pair, e.target.value)}
                      style={{ flex: 1, accentColor: color, height: 4 }}
                    />
                    <div style={{ width: 36, fontSize: 12, fontWeight: 800, color: 'var(--text)', textAlign: 'right', flexShrink: 0 }}>
                      {pct}%
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleSavePairs}
            disabled={saving}
            style={{
              ...btnPrimary,
              background: saved ? 'rgba(34,197,94,0.15)' : 'var(--color-green, #22C55E)',
              color: saved ? 'var(--color-green, #22C55E)' : '#000',
              border: saved ? '1px solid var(--color-green, #22C55E)' : 'none',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? t('settingsSections.trading.saving') : saved ? `✓ ${t('settingsSections.trading.saved')}` : t('settingsSections.trading.savePairConfig')}
          </button>
        </div>
      </div>
    </div>
  );
}

export { TradingConfigSection };

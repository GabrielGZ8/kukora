import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api';
import { card, cardHeader, cardBody, label, input, btnPrimary, btnSecondary, SectionTitle, StatusPill } from './settingsHelpers';
import { useTranslation } from '../../i18n/I18nContext';

// ─── Per-user live-trading toggle (checkpoint-37) ──────────────────────────
// Separate from TradingConfigSection's mode selector above, which is the
// GLOBAL paper/live switch (LIVE_TRADING_ENABLED, operator-controlled). A
// trade only ever executes live when BOTH that global switch AND this
// per-user toggle allow it (see liveExecution.js's
// _requireUserLiveModeEnabled()). Reuses the same 2FA mechanism already
// built for the global switch (server/application/twoFactor.js via
// /api/trading/2fa/*) rather than inventing a second one.
//
// hasExchange is passed down from ExchangeCredentialsSection (lifted state
// in SettingsPage-adjacent parent) so this section doesn't need its own
// redundant fetch just to know whether the "connect an exchange first" gate
// should show.
function LiveModeSection({ hasExchange }) {
  const { t } = useTranslation();

  const [status, setStatus]   = useState(null); // { enabled, enabledAt, disclaimerText }
  const [loadError, setLoadError] = useState('');

  const [twofa, setTwofa]     = useState(null); // { enabled, pendingSetup }
  const [setupData, setSetupData] = useState(null); // { secret, otpauthUrl }
  const [settingUp2fa, setSettingUp2fa] = useState(false);
  const [confirmToken, setConfirmToken] = useState('');
  const [confirming2fa, setConfirming2fa] = useState(false);
  const [twofaError, setTwofaError] = useState('');

  const [showConfirm, setShowConfirm] = useState(false);
  const [disclaimerChecked, setDisclaimerChecked] = useState(false);
  const [enableToken, setEnableToken] = useState('');
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState('');
  const [disabling, setDisabling] = useState(false);

  const load = useCallback(async () => {
    try {
      const [liveModeData, twofaData] = await Promise.all([
        api.liveMode.status(),
        api.trading.get2faStatus(),
      ]);
      setStatus(liveModeData);
      setTwofa(twofaData);
    } catch (e) {
      setLoadError(e.message || 'Failed to load');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSetup2fa() {
    setSettingUp2fa(true);
    setTwofaError('');
    try {
      const data = await api.trading.setup2fa();
      setSetupData(data);
    } catch (e) {
      setTwofaError(e.message || t('settingsSections.liveMode.setup2faFailed'));
    } finally {
      setSettingUp2fa(false);
    }
  }

  async function handleConfirm2fa() {
    if (!confirmToken.trim()) return;
    setConfirming2fa(true);
    setTwofaError('');
    try {
      await api.trading.confirm2fa(confirmToken.trim());
      setSetupData(null);
      setConfirmToken('');
      await load();
    } catch (e) {
      setTwofaError(e.message || t('settingsSections.liveMode.confirm2faFailed'));
    } finally {
      setConfirming2fa(false);
    }
  }

  function openConfirm() {
    setEnableError('');
    setDisclaimerChecked(false);
    setEnableToken('');
    setShowConfirm(true);
  }

  async function handleEnable() {
    if (!disclaimerChecked || !enableToken.trim()) return;
    setEnabling(true);
    setEnableError('');
    try {
      await api.liveMode.enable(enableToken.trim());
      setShowConfirm(false);
      await load();
    } catch (e) {
      setEnableError(e.message || t('settingsSections.liveMode.enableFailed'));
    } finally {
      setEnabling(false);
    }
  }

  async function handleDisable() {
    setDisabling(true);
    try {
      await api.liveMode.disable();
      await load();
    } catch (e) {
      setLoadError(e.message || t('settingsSections.liveMode.disableFailed'));
    } finally {
      setDisabling(false);
    }
  }

  if (!status || !twofa) {
    return (
      <div style={card}>
        <div style={cardHeader}>
          <SectionTitle icon="⚡" title={t('settingsSections.liveMode.title')} subtitle={t('settingsSections.liveMode.subtitle')} />
        </div>
        <div style={cardBody}>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>…</div>
          {loadError && <div style={{ fontSize: 11, color: 'var(--color-red, #EF4444)', marginTop: 6 }}>{loadError}</div>}
        </div>
      </div>
    );
  }

  const isLive = status.enabled;

  return (
    <div style={card}>
      <div style={cardHeader}>
        <SectionTitle icon="⚡" title={t('settingsSections.liveMode.title')} subtitle={t('settingsSections.liveMode.subtitle')} />
        {/* Persistent, always-visible mode indicator — same visual criterion
            (pulsing dot + pill) as TradingConfigSection's global badge and
            SystemHealthStrip's status dot, so "which mode is active" reads
            consistently everywhere in the app. */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 12px', borderRadius: 99,
          background: isLive ? 'rgba(239,68,68,0.12)' : 'rgba(148,163,184,0.10)',
          border: `1px solid ${isLive ? 'rgba(239,68,68,0.4)' : 'var(--border)'}`,
          fontSize: 10, fontWeight: 800, letterSpacing: '0.06em',
          color: isLive ? 'var(--color-red, #EF4444)' : 'var(--text-dim)',
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', background: 'currentColor',
            boxShadow: isLive ? '0 0 6px currentColor' : 'none',
            animation: isLive ? 'pulse 2s infinite' : 'none',
          }} />
          {isLive ? `🔴 ${t('settingsSections.liveMode.statusLive')}` : `⚪ ${t('settingsSections.liveMode.statusPaper')}`}
        </div>
      </div>

      <div style={cardBody}>
        {loadError && <div style={{ fontSize: 11, color: 'var(--color-red, #EF4444)', marginBottom: 14 }}>{loadError}</div>}

        {isLive ? (
          <div>
            {status.enabledAt && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 14 }}>
                {t('settingsSections.liveMode.enabledSince')} {new Date(status.enabledAt).toLocaleString()}
              </div>
            )}
            <button
              onClick={handleDisable}
              disabled={disabling}
              style={{ ...btnSecondary, color: 'var(--color-red, #EF4444)', borderColor: 'rgba(239,68,68,0.3)' }}
            >
              {disabling ? t('settingsSections.liveMode.disabling') : `⏸ ${t('settingsSections.liveMode.disableButton')}`}
            </button>
          </div>
        ) : (
          <div>
            {/* Gate 1: needs a connected exchange */}
            {!hasExchange && (
              <div style={{
                padding: '10px 14px', borderRadius: 8, marginBottom: 16,
                background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
                fontSize: 12, color: '#F59E0B',
              }}>
                ⚠️ {t('settingsSections.liveMode.needExchangePrefix')}
              </div>
            )}

            {/* Gate 2: needs 2FA set up */}
            {hasExchange && !twofa.enabled && (
              <div style={{ marginBottom: 16 }}>
                <div style={{
                  padding: '10px 14px', borderRadius: 8, marginBottom: 12,
                  background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
                  fontSize: 12, color: '#F59E0B',
                }}>
                  ⚠️ {t('settingsSections.liveMode.need2faPrefix')}
                </div>

                {!setupData ? (
                  <button onClick={handleSetup2fa} disabled={settingUp2fa} style={btnPrimary}>
                    {settingUp2fa ? t('settingsSections.liveMode.settingUp2fa') : t('settingsSections.liveMode.setup2faButton')}
                  </button>
                ) : (
                  <div style={{
                    padding: 16, borderRadius: 10, background: 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                  }}>
                    <div style={{ marginBottom: 10 }}>
                      <label style={label}>{t('settingsSections.liveMode.secretLabel')}</label>
                      <div style={{
                        fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700,
                        color: 'var(--text)', wordBreak: 'break-all', userSelect: 'all',
                        padding: '8px 10px', background: 'var(--bg-surface)', borderRadius: 6,
                      }}>
                        {setupData.secret}
                      </div>
                    </div>
                    <div style={{ marginBottom: 14 }}>
                      <label style={label}>{t('settingsSections.liveMode.otpauthLabel')}</label>
                      <div style={{
                        fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)',
                        wordBreak: 'break-all', userSelect: 'all',
                      }}>
                        {setupData.otpauthUrl}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <div>
                        <label style={label}>{t('settingsSections.liveMode.confirmCodeLabel')}</label>
                        <input
                          style={{ ...input, width: 140 }}
                          type="text" inputMode="numeric" maxLength={10}
                          value={confirmToken}
                          onChange={e => setConfirmToken(e.target.value)}
                          placeholder={t('settingsSections.liveMode.confirmCodePlaceholder')}
                        />
                      </div>
                      <button
                        onClick={handleConfirm2fa}
                        disabled={confirming2fa || !confirmToken.trim()}
                        style={{ ...btnPrimary, opacity: (!confirmToken.trim() || confirming2fa) ? 0.5 : 1 }}
                      >
                        {confirming2fa ? t('settingsSections.liveMode.confirming') : t('settingsSections.liveMode.confirm2faButton')}
                      </button>
                    </div>
                  </div>
                )}
                {twofaError && <div style={{ fontSize: 11, color: 'var(--color-red, #EF4444)', marginTop: 8 }}>{twofaError}</div>}
              </div>
            )}

            {hasExchange && twofa.enabled && (
              <div style={{ marginBottom: 16 }}>
                <StatusPill type="success">✓ {t('settingsSections.liveMode.twofaEnabled')}</StatusPill>
              </div>
            )}

            {/* Enable button — only meaningfully clickable once both gates pass;
                the confirm panel itself re-validates against the real
                requirements server-side regardless. */}
            {!showConfirm ? (
              <button
                onClick={openConfirm}
                disabled={!hasExchange || !twofa.enabled}
                style={{ ...btnPrimary, background: 'var(--color-red, #EF4444)', opacity: (!hasExchange || !twofa.enabled) ? 0.4 : 1 }}
              >
                ⚡ {t('settingsSections.liveMode.enableButton')}
              </button>
            ) : (
              <div style={{
                padding: 18, borderRadius: 10,
                background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.3)',
              }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--color-red, #EF4444)', marginBottom: 10 }}>
                  ⚠️ {t('settingsSections.liveMode.confirmTitle')}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.5, marginBottom: 14 }}>
                  {status.disclaimerText}
                </div>

                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 14, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={disclaimerChecked}
                    onChange={e => setDisclaimerChecked(e.target.checked)}
                    style={{ marginTop: 2, cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: 12, color: 'var(--text)' }}>
                    {t('settingsSections.liveMode.disclaimerCheckbox')}
                  </span>
                </label>

                <div style={{ marginBottom: 14 }}>
                  <label style={label}>{t('settingsSections.liveMode.confirmCodeForEnable')}</label>
                  <input
                    style={{ ...input, width: 160 }}
                    type="text" inputMode="numeric" maxLength={10}
                    value={enableToken}
                    onChange={e => setEnableToken(e.target.value)}
                    placeholder={t('settingsSections.liveMode.confirmCodePlaceholder')}
                  />
                </div>

                {enableError && <div style={{ fontSize: 11, color: 'var(--color-red, #EF4444)', marginBottom: 10 }}>{enableError}</div>}

                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    onClick={handleEnable}
                    disabled={enabling || !disclaimerChecked || !enableToken.trim()}
                    style={{
                      ...btnPrimary, background: 'var(--color-red, #EF4444)',
                      opacity: (enabling || !disclaimerChecked || !enableToken.trim()) ? 0.4 : 1,
                    }}
                  >
                    {enabling ? t('settingsSections.liveMode.settingUp2fa') : `⚡ ${t('settingsSections.liveMode.confirmEnableButton')}`}
                  </button>
                  <button onClick={() => setShowConfirm(false)} disabled={enabling} style={btnSecondary}>
                    {t('settingsSections.liveMode.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export { LiveModeSection };

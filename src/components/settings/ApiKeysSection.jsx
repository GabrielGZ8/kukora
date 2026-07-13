import { useState } from 'react';
import { api } from '../../api';
import { card, cardHeader, cardBody, label, input, btnSecondary, SectionTitle, StatusPill } from './settingsHelpers';
import { useTranslation } from '../../i18n/I18nContext';

// ─── API Keys Section ─────────────────────────────────────────────────────
// Nota H-10: BINANCE_API_KEY/BINANCE_API_SECRET son nombres de variables de
// entorno (documentación técnica), quedan en inglés a propósito — mismo
// criterio que SystemInfoSection.jsx.
function ApiKeysSection() {
  const { t } = useTranslation();
  const [apiKey, setApiKey]       = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [testing, setTesting]     = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [showSecret, setShowSecret] = useState(false);

  async function handleTest() {
    if (!apiKey || !apiSecret) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.trading.testConn({ exchange: 'Binance', apiKey, apiSecret });
      setTestResult({ ok: result.connected || result.ok, msg: result.message || (result.ok ? t('settingsSections.apiKeys.testSuccess') : t('settingsSections.apiKeys.testFailure')) });
    } catch (e) {
      setTestResult({ ok: false, msg: e.message || t('settingsSections.apiKeys.testFailed') });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div style={card}>
      <div style={cardHeader}>
        <SectionTitle icon="🔑" title={t('settingsSections.apiKeys.title')} subtitle={t('settingsSections.apiKeys.subtitle')} />
      </div>
      <div style={cardBody}>
        <div style={{
          padding: '12px 16px', borderRadius: 8, marginBottom: 20,
          background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
          fontSize: 12, color: '#F59E0B',
        }}>
          ⚠️ {t('settingsSections.apiKeys.warningIntro')} <strong>{t('settingsSections.apiKeys.warningStrong')}</strong> {t('settingsSections.apiKeys.warningMid')} <code style={{ fontFamily: 'var(--font-mono)' }}>BINANCE_API_KEY</code> {t('common.and')} <code style={{ fontFamily: 'var(--font-mono)' }}>BINANCE_API_SECRET</code>. {t('settingsSections.apiKeys.warningOutro')}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
          <div>
            <label style={label}>{t('settingsSections.apiKeys.keyLabel')}</label>
            <input
              style={input}
              type="text"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={t('settingsSections.apiKeys.keyPlaceholder')}
              autoComplete="off"
            />
          </div>
          <div>
            <label style={label}>{t('settingsSections.apiKeys.secretLabel')}</label>
            <div style={{ position: 'relative' }}>
              <input
                style={{ ...input, paddingRight: 40 }}
                type={showSecret ? 'text' : 'password'}
                value={apiSecret}
                onChange={e => setApiSecret(e.target.value)}
                placeholder={t('settingsSections.apiKeys.secretPlaceholder')}
                autoComplete="off"
              />
              <button
                onClick={() => setShowSecret(s => !s)}
                style={{
                  position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer', fontSize: 14,
                  color: 'var(--text-dim)', padding: 4,
                }}
              >
                {showSecret ? '🙈' : '👁️'}
              </button>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleTest}
            disabled={testing || !apiKey || !apiSecret}
            style={{ ...btnSecondary, opacity: (!apiKey || !apiSecret) ? 0.4 : 1 }}
          >
            {testing ? `🔄 ${t('settingsSections.apiKeys.testing')}` : `🔌 ${t('settingsSections.apiKeys.testButton')}`}
          </button>
          {testResult && (
            <StatusPill type={testResult.ok ? 'success' : 'error'}>
              {testResult.ok ? '✓' : '✕'} {testResult.msg}
            </StatusPill>
          )}
        </div>
      </div>
    </div>
  );
}

export { ApiKeysSection };

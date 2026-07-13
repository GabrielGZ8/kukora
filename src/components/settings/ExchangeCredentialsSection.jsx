import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api';
import { card, cardHeader, cardBody, label, input, btnPrimary, btnSecondary, SectionTitle, StatusPill } from './settingsHelpers';
import { useTranslation } from '../../i18n/I18nContext';

// ─── Per-user exchange credentials (checkpoint-37) ─────────────────────────
// Distinct from ApiKeysSection.jsx above (which only tests a connection
// against the platform-wide env-var keys and never persists anything).
// This section lets the signed-in user connect, list, and disconnect THEIR
// OWN exchange API keys — see server/routes/userExchangeCredentials.routes.js.
//
// Same list of exchanges liveExecution.js's EXCHANGE_ENV_KEYS supports.
// Kept here (not imported) since that's a server-only module — mirroring
// the list is the same tradeoff tradingValidation.js already accepts
// (adding a new exchange means updating the server list; the server
// itself returns a clear error for anything unsupported).
const EXCHANGES = [
  { id: 'binance',  label: 'Binance' },
  { id: 'bybit',    label: 'Bybit' },
  { id: 'kraken',   label: 'Kraken' },
  { id: 'okx',      label: 'OKX' },
  { id: 'coinbase', label: 'Coinbase' },
];

function ExchangeCredentialsSection({ onChanged }) {
  const { t } = useTranslation();
  const [exchanges, setExchanges] = useState(null); // null = loading
  const [loadError, setLoadError] = useState('');

  const [formExchange, setFormExchange]     = useState(EXCHANGES[0].id);
  const [apiKey, setApiKey]                 = useState('');
  const [apiSecret, setApiSecret]           = useState('');
  const [apiPassphrase, setApiPassphrase]   = useState('');
  const [showSecret, setShowSecret]         = useState(false);
  const [connecting, setConnecting]         = useState(false);
  const [connectResult, setConnectResult]   = useState(null); // { ok, msg, warning }
  const [disconnectingId, setDisconnectingId] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.exchangeCredentials.list();
      setExchanges(data.exchanges || []);
      onChanged?.(data.exchanges || []);
    } catch (e) {
      setLoadError(e.message || 'Failed to load');
      setExchanges([]);
    }
  }, [onChanged]);

  useEffect(() => { load(); }, [load]);

  async function handleConnect() {
    if (!apiKey.trim() || !apiSecret.trim()) return;
    setConnecting(true);
    setConnectResult(null);
    try {
      const data = await api.exchangeCredentials.connect({
        exchange: formExchange,
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim(),
        ...(formExchange === 'okx' && apiPassphrase.trim() ? { apiPassphrase: apiPassphrase.trim() } : {}),
      });
      setConnectResult({ ok: true, msg: `${t('settingsSections.exchangeAccounts.connectSuccess')}: ${data.exchange}`, warning: data.warning || null });
      setApiKey(''); setApiSecret(''); setApiPassphrase('');
      await load();
    } catch (e) {
      setConnectResult({ ok: false, msg: e.message || 'Connection failed' });
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect(exchange) {
    if (!window.confirm(t('settingsSections.exchangeAccounts.disconnectConfirm'))) return;
    setDisconnectingId(exchange);
    try {
      await api.exchangeCredentials.disconnect(exchange);
      await load();
    } catch (e) {
      setConnectResult({ ok: false, msg: e.message });
    } finally {
      setDisconnectingId(null);
    }
  }

  const connectedIds = new Set((exchanges || []).map(e => e.exchange));

  return (
    <div style={card}>
      <div style={cardHeader}>
        <SectionTitle icon="🏦" title={t('settingsSections.exchangeAccounts.title')} subtitle={t('settingsSections.exchangeAccounts.subtitle')} />
      </div>
      <div style={cardBody}>
        {/* Connected exchanges list */}
        <div style={{ marginBottom: 24 }}>
          {exchanges === null && (
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>…</div>
          )}
          {exchanges && exchanges.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              {t('settingsSections.exchangeAccounts.noExchanges')}
            </div>
          )}
          {exchanges && exchanges.length > 0 && exchanges.map(ex => (
            <div key={ex.exchange} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 16px', borderRadius: 8,
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              marginBottom: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 18 }}>🔌</span>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', textTransform: 'capitalize' }}>
                    {ex.exchange}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
                    {t('settingsSections.exchangeAccounts.connectedOn')} {new Date(ex.connectedAt).toLocaleString()}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <StatusPill type="success">✓ {t('settingsSections.exchangeAccounts.connected')}</StatusPill>
                <button
                  onClick={() => handleDisconnect(ex.exchange)}
                  disabled={disconnectingId === ex.exchange}
                  style={{ ...btnSecondary, padding: '6px 14px', color: 'var(--color-red, #EF4444)', borderColor: 'rgba(239,68,68,0.3)' }}
                >
                  {disconnectingId === ex.exchange ? t('settingsSections.exchangeAccounts.disconnecting') : t('settingsSections.exchangeAccounts.disconnect')}
                </button>
              </div>
            </div>
          ))}
          {loadError && <div style={{ fontSize: 11, color: 'var(--color-red, #EF4444)', marginTop: 6 }}>{loadError}</div>}
        </div>

        {/* Connect form */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 20 }}>
          <label style={label}>{t('settingsSections.exchangeAccounts.connectNew')}</label>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 10, marginBottom: 16 }}>
            <div>
              <label style={label}>{t('settingsSections.exchangeAccounts.exchangeLabel')}</label>
              <select
                style={{ ...input, cursor: 'pointer' }}
                value={formExchange}
                onChange={e => setFormExchange(e.target.value)}
              >
                {EXCHANGES.map(ex => (
                  <option key={ex.id} value={ex.id}>
                    {ex.label}{connectedIds.has(ex.id) ? ` (${t('settingsSections.exchangeAccounts.connected')})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={label}>{t('settingsSections.exchangeAccounts.apiKeyLabel')}</label>
              <input
                style={input}
                type="text"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={t('settingsSections.exchangeAccounts.apiKeyPlaceholder')}
                autoComplete="off"
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: formExchange === 'okx' ? '1fr 1fr' : '1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <label style={label}>{t('settingsSections.exchangeAccounts.apiSecretLabel')}</label>
              <div style={{ position: 'relative' }}>
                <input
                  style={{ ...input, paddingRight: 40 }}
                  type={showSecret ? 'text' : 'password'}
                  value={apiSecret}
                  onChange={e => setApiSecret(e.target.value)}
                  placeholder={t('settingsSections.exchangeAccounts.apiSecretPlaceholder')}
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
            {formExchange === 'okx' && (
              <div>
                <label style={label}>{t('settingsSections.exchangeAccounts.apiPassphraseLabel')}</label>
                <input
                  style={input}
                  type={showSecret ? 'text' : 'password'}
                  value={apiPassphrase}
                  onChange={e => setApiPassphrase(e.target.value)}
                  placeholder={t('settingsSections.exchangeAccounts.apiPassphrasePlaceholder')}
                  autoComplete="off"
                />
              </div>
            )}
          </div>

          <div style={{
            padding: '10px 14px', borderRadius: 8, marginBottom: 16,
            background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)',
            fontSize: 11, color: '#818CF8',
          }}>
            ℹ️ {t('settingsSections.exchangeAccounts.securityNote')}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button
              onClick={handleConnect}
              disabled={connecting || !apiKey.trim() || !apiSecret.trim()}
              style={{ ...btnPrimary, opacity: (connecting || !apiKey.trim() || !apiSecret.trim()) ? 0.5 : 1 }}
            >
              {connecting ? `🔄 ${t('settingsSections.exchangeAccounts.connecting')}` : `🔌 ${t('settingsSections.exchangeAccounts.connectButton')}`}
            </button>
            {connectResult && (
              <StatusPill type={connectResult.ok ? 'success' : 'error'}>
                {connectResult.ok ? '✓' : '✕'} {connectResult.msg}
              </StatusPill>
            )}
          </div>
          {connectResult?.warning && (
            <div style={{
              marginTop: 10, padding: '10px 14px', borderRadius: 8,
              background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)',
              fontSize: 11, color: '#F59E0B',
            }}>
              {t('settingsSections.exchangeAccounts.withdrawalWarningPrefix')} {connectResult.warning}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export { ExchangeCredentialsSection };

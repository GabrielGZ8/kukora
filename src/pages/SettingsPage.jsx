// SettingsPage — refactored (Round 7, audit 4.3: split large components).
// Each section extracted to src/components/settings/ for independent maintainability.
import { useState } from 'react';
import { ProfileSection }      from '../components/settings/ProfileSection';
import { TradingConfigSection } from '../components/settings/TradingConfigSection';
import { RiskProfileSection }   from '../components/settings/RiskProfileSection';
import { ApiKeysSection }       from '../components/settings/ApiKeysSection';
import { ExchangeCredentialsSection } from '../components/settings/ExchangeCredentialsSection';
import { LiveModeSection }      from '../components/settings/LiveModeSection';
import { SecuritySection }      from '../components/settings/SecuritySection';
import { AuditLogSection }      from '../components/settings/AuditLogSection';
import { SystemInfoSection }    from '../components/settings/SystemInfoSection';
import { useTranslation } from '../i18n/I18nContext';

// ─── Page tabs ──────────────────────────────────────────────────────────────
// Nota H-10: labels de las pestañas quedan como llaves i18n (settings.tabs.*),
// el resto de TABS (id, icon) no es texto visible traducible.
const TABS = [
  { id: 'profile',  labelKey: 'settings.tabs.profile',  icon: '' },
  { id: 'trading',  labelKey: 'settings.tabs.trading',  icon: '' },
  { id: 'keys',     labelKey: 'settings.tabs.keys',     icon: '' },
  { id: 'security', labelKey: 'settings.tabs.security', icon: '' },
  { id: 'audit',    labelKey: 'settings.tabs.audit',    icon: '' },
  { id: 'system',   labelKey: 'settings.tabs.system',   icon: '' },
];

// ─── Main SettingsPage ──────────────────────────────────────────────────────
export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('profile');
  const { t } = useTranslation();
  // Lifted so LiveModeSection knows whether to show its "connect an
  // exchange first" gate without re-fetching the list itself — updated by
  // ExchangeCredentialsSection every time its list loads/changes (connect,
  // disconnect).
  const [connectedExchanges, setConnectedExchanges] = useState([]);

  return (
    <div style={{ fontFamily: 'var(--font-ui)', maxWidth: 860, margin: '0 auto' }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{
          fontSize: 24, fontWeight: 900, color: 'var(--text)',
          letterSpacing: '-0.5px', margin: 0,
        }}>
          {t('settings.title')}
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 4 }}>
          {t('settings.subtitle')}
        </p>
      </div>

      <div style={{
        display: 'flex', gap: 4, marginBottom: 24, padding: 4,
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: 12, overflowX: 'auto',
      }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', borderRadius: 8, fontSize: 12, fontWeight: 600,
              cursor: 'pointer', border: 'none', flexShrink: 0, transition: 'all 0.13s',
              background: activeTab === tab.id ? 'var(--color-primary, #FF2D78)' : 'transparent',
              color: activeTab === tab.id ? '#fff' : 'var(--text-muted)',
            }}
          >
            <span>{tab.icon}</span>
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {activeTab === 'profile'  && <ProfileSection />}
      {activeTab === 'trading'  && <><TradingConfigSection /><RiskProfileSection /></>}
      {activeTab === 'keys'     && (
        <>
          <ExchangeCredentialsSection onChanged={setConnectedExchanges} />
          <LiveModeSection hasExchange={connectedExchanges.length > 0} />
          <ApiKeysSection />
        </>
      )}
      {activeTab === 'security' && <SecuritySection />}
      {activeTab === 'audit'    && <AuditLogSection />}
      {activeTab === 'system'   && <SystemInfoSection />}
    </div>
  );
}

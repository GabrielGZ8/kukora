import { useState } from 'react';
import { useAuth } from '../../state/AuthContext';
import { card, cardHeader, cardBody, label, btnSecondary, SectionTitle, StatusPill } from './settingsHelpers';
import { useTranslation } from '../../i18n/I18nContext';

// ─── Security Section ──────────────────────────────────────────────────────
function SecuritySection() {
  const { logout } = useAuth();
  const { t } = useTranslation();
  const [sessions] = useState([{ device: t('settingsSections.security.currentSession'), active: true, ts: new Date().toISOString() }]);

  return (
    <div style={card}>
      <div style={cardHeader}>
        <SectionTitle icon="🔒" title={t('settingsSections.security.title')} subtitle={t('settingsSections.security.subtitle')} />
      </div>
      <div style={cardBody}>
        <div style={{ marginBottom: 20 }}>
          <label style={label}>{t('settingsSections.security.activeSessions')}</label>
          {sessions.map((s, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 16px', borderRadius: 8,
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              marginBottom: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 18 }}>💻</span>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{s.device}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
                    {new Date(s.ts).toLocaleString()}
                  </div>
                </div>
              </div>
              <StatusPill type="success">{t('settingsSections.security.active')}</StatusPill>
            </div>
          ))}
        </div>

        <button
          onClick={logout}
          style={{
            ...btnSecondary,
            color: 'var(--color-red, #EF4444)',
            borderColor: 'rgba(239,68,68,0.3)',
            display: 'flex', alignItems: 'center', gap: 7,
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          {t('settingsSections.security.signOutAll')}
        </button>
      </div>
    </div>
  );
}

export { SecuritySection };

import { useState, useEffect } from 'react';
import { api } from '../../api';
import { useAuth } from '../../state/AuthContext';
import { card, cardHeader, cardBody, label, input, btnPrimary, SectionTitle, StatusPill } from './settingsHelpers';
import { useTranslation } from '../../i18n/I18nContext';

// ─── Profile Section ────────────────────────────────────────────────────────
function ProfileSection() {
  const { t } = useTranslation();
  const { user, updateUser } = useAuth();
  const [name, setName]     = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null); // 'ok' | 'error'
  const [msg, setMsg]       = useState('');

  useEffect(() => {
    if (user?.name) setName(user.name);
    else if (user?.email) setName(user.email.split('@')[0]);
  }, [user]);

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    setStatus(null);
    try {
      await api.profile.update({ name: name.trim() });
      updateUser({ name: name.trim() });
      setStatus('ok');
      setMsg(t('settingsSections.profile.updateSuccess'));
    } catch (e) {
      setStatus('error');
      setMsg(e.message || t('settingsSections.profile.updateFailed'));
    } finally {
      setSaving(false);
      setTimeout(() => setStatus(null), 3000);
    }
  }

  const initial = (user?.name || user?.email || 'U').charAt(0).toUpperCase();

  return (
    <div style={card}>
      <div style={cardHeader}>
        <SectionTitle icon="👤" title={t('settingsSections.profile.title')} subtitle={t('settingsSections.profile.subtitle')} />
      </div>
      <div style={cardBody}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 28 }}>
          <div style={{
            width: 64, height: 64, borderRadius: 16, flexShrink: 0,
            background: 'linear-gradient(135deg, var(--color-primary, #FF2D78), #5741D9)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 26, fontWeight: 900, color: '#fff',
            boxShadow: '0 4px 16px rgba(255,45,120,0.3)',
          }}>
            {initial}
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>
              {user?.name || user?.email?.split('@')[0] || 'User'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>{user?.email}</div>
            <div style={{ marginTop: 6 }}>
              <StatusPill type="info">{user?.role || 'user'}</StatusPill>
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
          <div>
            <label style={label}>{t('settingsSections.profile.displayName')}</label>
            <input
              style={input}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t('settingsSections.profile.namePlaceholder')}
              maxLength={80}
            />
          </div>
          <div>
            <label style={label}>{t('settingsSections.profile.email')}</label>
            <input
              style={{ ...input, opacity: 0.6, cursor: 'not-allowed' }}
              value={user?.email || ''}
              readOnly
            />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}
          >
            {saving ? t('settingsSections.profile.saving') : t('settingsSections.profile.saveChanges')}
          </button>
          {status && (
            <StatusPill type={status === 'ok' ? 'success' : 'error'}>
              {status === 'ok' ? '✓' : '✕'} {msg}
            </StatusPill>
          )}
        </div>
      </div>
    </div>
  );
}

export { ProfileSection };

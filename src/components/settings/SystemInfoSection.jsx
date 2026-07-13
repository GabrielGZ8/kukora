import { card, cardHeader, cardBody, SectionTitle, StatusPill } from './settingsHelpers';
import { useTranslation } from '../../i18n/I18nContext';

// ─── Environment / System Info Section ─────────────────────────────────────
// Nota H-10: los `desc` de cada env var son documentación técnica dirigida a
// quien despliega el servidor, no copy de UI para el usuario final — quedan
// en inglés a propósito, mismo criterio que nombres de variables/código.
function SystemInfoSection() {
  const { t } = useTranslation();
  const vars = [
    { key: 'MONGODB_URI',             desc: 'MongoDB connection string' },
    { key: 'JWT_SECRET',              desc: 'JWT signing secret (64-char hex)' },
    { key: 'JWT_REFRESH_SECRET',      desc: 'Refresh token secret (64-char hex)' },
    { key: 'LIVE_TRADING_ENABLED',    desc: 'Enable real order placement' },
    { key: 'BINANCE_API_KEY',         desc: 'Binance API key for live trading' },
    { key: 'BINANCE_API_SECRET',      desc: 'Binance API secret for live trading' },
  ];

  return (
    <div style={card}>
      <div style={cardHeader}>
        <SectionTitle icon="🖥️" title={t('settingsSections.system.title')} subtitle={t('settingsSections.system.subtitle')} />
      </div>
      <div style={cardBody}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {vars.map(v => (
            <div key={v.key} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', borderRadius: 8,
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <code style={{
                  fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
                  color: 'var(--color-primary, #FF2D78)', flexShrink: 0,
                }}>
                  {v.key}
                </code>
                <span style={{ fontSize: 11, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  — {v.desc}
                </span>
              </div>
              <div style={{ flexShrink: 0, marginLeft: 12 }}>
                <StatusPill type="info">{t('settingsSections.system.required')}</StatusPill>
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          {t('settingsSections.system.seePrefix')} <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-elevated)', padding: '1px 5px', borderRadius: 3 }}>.env.example</code> {t('settingsSections.system.seeSuffix')}
        </div>
      </div>
    </div>
  );
}

export { SystemInfoSection };

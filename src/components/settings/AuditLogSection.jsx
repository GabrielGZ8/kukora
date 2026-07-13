import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api';
import { card, cardHeader, cardBody, btnSecondary, SectionTitle, StatusPill } from './settingsHelpers';
import { useTranslation } from '../../i18n/I18nContext';

// ─── Audit Log Section ─────────────────────────────────────────────────────
function AuditLogSection() {
  const [log, setLog]         = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const { t } = useTranslation();

  const fetchLog = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.trading.getAudit();
      setLog(data?.log || []);
    } catch (e) {
      setError(t('settingsSections.audit.fetchError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { fetchLog(); }, [fetchLog]);

  return (
    <div style={card}>
      <div style={cardHeader}>
        <SectionTitle icon="📋" title={t('settingsSections.audit.title')} subtitle={t('settingsSections.audit.subtitle')} />
        <button onClick={fetchLog} style={{ ...btnSecondary, padding: '6px 14px', fontSize: 11 }}>
          ↺ {t('common.refresh')}
        </button>
      </div>
      <div style={{ ...cardBody, padding: '0' }}>
        {loading ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>{t('common.loading')}</div>
        ) : error ? (
          <div style={{ padding: '24px', color: 'var(--color-red, #EF4444)', fontSize: 12 }}>{error}</div>
        ) : log.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 12 }}>
            {t('settingsSections.audit.empty')}
          </div>
        ) : (
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {[
                    t('settingsSections.audit.colTime'),
                    t('settingsSections.audit.colAction'),
                    t('settingsSections.audit.colExchange'),
                    t('settingsSections.audit.colAmount'),
                    t('settingsSections.audit.colPrice'),
                    t('settingsSections.audit.colStatus'),
                  ].map(h => (
                    <th key={h} style={{
                      padding: '8px 14px', textAlign: 'left', fontWeight: 700,
                      color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em',
                      fontSize: 10, background: 'var(--bg-elevated)',
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {log.map((entry, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)', transition: 'background 0.1s' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = ''; }}
                  >
                    <td style={{ padding: '9px 14px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                      {entry.ts ? new Date(entry.ts).toLocaleTimeString() : '—'}
                    </td>
                    <td style={{ padding: '9px 14px', fontWeight: 700, color: 'var(--text)' }}>
                      {entry.action || entry.type || '—'}
                    </td>
                    <td style={{ padding: '9px 14px', color: 'var(--text)' }}>{entry.exchange || '—'}</td>
                    <td style={{ padding: '9px 14px', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                      {entry.amount ? `${entry.amount} BTC` : '—'}
                    </td>
                    <td style={{ padding: '9px 14px', fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                      {entry.price ? `$${Number(entry.price).toLocaleString()}` : '—'}
                    </td>
                    <td style={{ padding: '9px 14px' }}>
                      <StatusPill type={entry.status === 'ok' || entry.ok ? 'success' : 'error'}>
                        {entry.status || (entry.ok ? 'ok' : 'failed')}
                      </StatusPill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export { AuditLogSection };

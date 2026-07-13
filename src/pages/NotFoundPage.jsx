import { useNavigate } from 'react-router-dom';
import { useTranslation } from '../i18n/I18nContext';

const PINK = '#FF2D78';
const GREEN = '#00b87a';

export default function NotFoundPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <div style={{
      minHeight: '70vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 24,
    }}>
      <div style={{
        fontSize: 13, fontWeight: 800, color: GREEN, letterSpacing: '-0.5px', marginBottom: 18,
      }}>
        kukora
      </div>

      <div style={{
        fontSize: 88, fontWeight: 900, lineHeight: 1,
        background: `linear-gradient(135deg, ${PINK}, ${GREEN})`,
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        marginBottom: 8,
      }}>
        404
      </div>

      <h1 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)', margin: '0 0 8px' }}>
        {t('notFound.title')}
      </h1>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 360, lineHeight: 1.6, margin: '0 0 28px' }}>
        {t('notFound.description')}
      </p>

      <div style={{ display: 'flex', gap: 10 }}>
        <button
          onClick={() => navigate(-1)}
          style={{
            padding: '11px 20px', borderRadius: 10, fontSize: 13, fontWeight: 700,
            background: 'var(--bg-surface-2)', border: '1px solid var(--border)',
            color: 'var(--text-muted)', cursor: 'pointer',
          }}
        >
          {t('notFound.goBack')}
        </button>
        <button
          onClick={() => navigate('/arbitrage')}
          style={{
            padding: '11px 22px', borderRadius: 10, fontSize: 13, fontWeight: 800,
            background: `linear-gradient(135deg, ${PINK}, ${GREEN})`,
            border: 'none', color: '#fff', cursor: 'pointer',
            boxShadow: `0 4px 14px ${PINK}33`,
          }}
        >
          {t('notFound.backToDashboard')}
        </button>
      </div>
    </div>
  );
}

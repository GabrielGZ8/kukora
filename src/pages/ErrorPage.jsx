import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../i18n/I18nContext';

const PINK  = '#FF2D78';
const GREEN = '#00b87a';

function buildErrorConfigs(t) {
  return {
    500: {
      code: '500',
      title: t('errorPage.code500Title'),
      description: t('errorPage.code500Description'),
      icon: '⚙️',
    },
    503: {
      code: '503',
      title: t('errorPage.code503Title'),
      description: t('errorPage.code503Description'),
      icon: '🔧',
    },
    default: {
      code: 'Error',
      title: t('errorPage.defaultTitle'),
      description: t('errorPage.defaultDescription'),
      icon: '⚠️',
    },
  };
}

/**
 * ErrorPage — full-page error screen for HTTP 500 / 503 (and generic errors).
 *
 * Usage:
 *   navigate('/error?code=500')   → HTTP 500
 *   navigate('/error?code=503')   → HTTP 503
 *   navigate('/error')            → generic error
 *
 * Props (optional, for embedding without navigation):
 *   code       — number | string  (500 | 503 | ...)
 *   message    — string           (custom description override)
 *   onRetry    — () => void       (if provided, shows a "Try again" button)
 *   onBack     — () => void       (if provided, overrides the navigate(-1) button)
 */
export default function ErrorPage({ code: propCode, message: propMessage, onRetry, onBack }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { t } = useTranslation();

  const code   = String(propCode ?? params.get('code') ?? 'default');
  const ERROR_CONFIGS = buildErrorConfigs(t);
  const config = ERROR_CONFIGS[code] || ERROR_CONFIGS.default;

  const handleBack = onBack ?? (() => navigate(-1));
  const handleHome = () => navigate('/arbitrage');

  return (
    <div style={{
      minHeight: '70vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      textAlign: 'center', padding: 24,
    }}>
      {/* Brand label */}
      <div style={{
        fontSize: 13, fontWeight: 800, color: GREEN,
        letterSpacing: '-0.5px', marginBottom: 18,
      }}>
        kukora
      </div>

      {/* Error icon */}
      <div style={{
        width: 64, height: 64, borderRadius: 18, marginBottom: 16,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(255,45,120,0.10)',
        border: '1px solid rgba(255,45,120,0.20)',
        fontSize: 28,
      }}>
        {config.icon}
      </div>

      {/* Error code */}
      <div style={{
        fontSize: code.length <= 3 ? 80 : 52,
        fontWeight: 900,
        lineHeight: 1,
        background: `linear-gradient(135deg, ${PINK}, ${GREEN})`,
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        marginBottom: 10,
      }}>
        {config.code}
      </div>

      {/* Title */}
      <h1 style={{
        fontSize: 18, fontWeight: 800,
        color: 'var(--text)', margin: '0 0 10px',
      }}>
        {config.title}
      </h1>

      {/* Description */}
      <p style={{
        fontSize: 13, color: 'var(--text-muted)',
        maxWidth: 400, lineHeight: 1.65, margin: '0 0 28px',
      }}>
        {propMessage || config.description}
      </p>

      {/* Status badge */}
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 12px', borderRadius: 20, marginBottom: 28,
        background: 'rgba(255,45,120,0.08)',
        border: '1px solid rgba(255,45,120,0.20)',
        fontSize: 11, fontWeight: 700, color: PINK, letterSpacing: '0.04em',
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: PINK, display: 'inline-block',
          animation: 'pulse 2s ease-in-out infinite',
        }} />
        {t('errorPage.statusBadge')}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          onClick={handleBack}
          style={{
            padding: '11px 20px', borderRadius: 10,
            fontSize: 13, fontWeight: 700, cursor: 'pointer',
            background: 'var(--bg-surface-2)',
            border: '1px solid var(--border)',
            color: 'var(--text-muted)',
          }}
        >
          {t('notFound.goBack')}
        </button>

        {onRetry && (
          <button
            onClick={onRetry}
            style={{
              padding: '11px 22px', borderRadius: 10,
              fontSize: 13, fontWeight: 800, cursor: 'pointer',
              background: 'var(--bg-surface-2)',
              border: `1px solid ${PINK}55`,
              color: PINK,
            }}
          >
            {t('errorPage.tryAgain')}
          </button>
        )}

        <button
          onClick={handleHome}
          style={{
            padding: '11px 22px', borderRadius: 10,
            fontSize: 13, fontWeight: 800, cursor: 'pointer',
            background: `linear-gradient(135deg, ${PINK}, ${GREEN})`,
            border: 'none', color: '#fff',
            boxShadow: `0 4px 14px ${PINK}33`,
          }}
        >
          {t('notFound.backToDashboard')}
        </button>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}

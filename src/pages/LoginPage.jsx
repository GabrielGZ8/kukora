import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../state/AuthContext';
import AuthLayout from '../components/auth/AuthLayout';
import FormField from '../components/auth/FormField';
import PasswordField from '../components/auth/PasswordField';
import GoogleButton from '../components/auth/GoogleButton';
import { AuthDivider, SubmitButton } from '../components/auth/AuthBits';
import { isFirebaseConfigured } from '../firebase';
import { useTranslation } from '../i18n/I18nContext';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function googleErrorMessage(err, t) {
  switch (err?.code) {
    case 'auth/popup-blocked':
      return t('auth.googleErrors.popupBlocked');
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return null; // user-initiated cancel — no need to alarm them
    case 'auth/network-request-failed':
      return t('auth.googleErrors.networkError');
    case 'not-configured':
      return t('auth.googleErrors.notConfigured');
    case 'GOOGLE_UNAVAILABLE':
      return t('auth.googleErrors.unavailable');
    case 'GOOGLE_TOKEN_INVALID':
      return t('auth.googleErrors.tokenInvalid');
    default:
      return err?.message || t('auth.googleErrors.genericFailed');
  }
}

export default function LoginPage() {
  const { login, loginWithGoogle } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);

  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  function validate() {
    const errs = {};
    if (!email.trim()) errs.email = t('auth.validation.emailRequired');
    else if (!EMAIL_RE.test(email.trim())) errs.email = t('auth.validation.emailInvalid');
    if (!password) errs.password = t('auth.validation.passwordRequired');
    return errs;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;

    setLoading(true);
    try {
      // "Remember me" governs whether we'd want a longer-lived session; the
      // refresh cookie itself is always httpOnly/secure server-side, so this
      // is recorded for UX continuity rather than changing token lifetimes.
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('kukora-remember', remember ? '1' : '0');
      }
      await login(email.trim(), password);
      navigate('/executive');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogle() {
    setError('');
    setGoogleLoading(true);
    try {
      await loginWithGoogle();
      navigate('/executive');
    } catch (err) {
      const msg = googleErrorMessage(err, t);
      if (msg) setError(msg);
    } finally {
      setGoogleLoading(false);
    }
  }

  function handleForgotPassword(e) {
    e.preventDefault();
    toast(t('auth.login.passwordResetToast'), { duration: 4000 });
  }

  return (
    <AuthLayout
      eyebrow={t('auth.login.eyebrow')}
      title={t('auth.login.title')}
      subtitle={t('auth.login.subtitle')}
    >
      <form onSubmit={handleSubmit} noValidate>
        <FormField
          name="email"
          label={t('auth.login.emailLabel')}
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder={t('auth.login.emailPlaceholder')}
          autoComplete="email"
          autoFocus
          required
          disabled={loading || googleLoading}
          error={fieldErrors.email}
        />

        <PasswordField
          name="password"
          label={t('auth.login.passwordLabel')}
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="••••••••"
          autoComplete="current-password"
          required
          disabled={loading || googleLoading}
          error={fieldErrors.password}
        />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={remember}
              onChange={e => setRemember(e.target.checked)}
              disabled={loading || googleLoading}
              style={{ width: 16, height: 16, accentColor: 'var(--color-primary)', cursor: 'pointer' }}
            />
            {t('auth.login.rememberMe')}
          </label>
          <a href="#" onClick={handleForgotPassword} style={{ fontSize: 13, color: 'var(--color-primary)', fontWeight: 600, textDecoration: 'none' }}>
            {t('auth.login.forgotPassword')}
          </a>
        </div>

        {error && (
          <div role="alert" style={{
            padding: '10px 14px', borderRadius: 10, marginBottom: 16,
            background: 'var(--color-red-dim)', border: '1px solid rgba(240,62,62,0.3)',
            color: 'var(--color-red)', fontSize: 13, lineHeight: 1.4,
          }}>
            {error}
          </div>
        )}

        <SubmitButton loading={loading} disabled={googleLoading}>
          {loading ? t('auth.login.signingIn') : t('auth.login.signIn')}
        </SubmitButton>
      </form>

      <AuthDivider />

      <GoogleButton
        onClick={handleGoogle}
        loading={googleLoading}
        disabled={loading || !isFirebaseConfigured}
        label={isFirebaseConfigured ? t('auth.login.continueWithGoogle') : t('auth.login.googleUnavailable')}
      />

      <p style={{ textAlign: 'center', marginTop: 24, fontSize: 13.5, color: 'var(--text-dim)' }}>
        {t('auth.login.noAccount')}{' '}
        <Link to="/register" style={{ color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 600 }}>
          {t('auth.login.createOne')}
        </Link>
      </p>
    </AuthLayout>
  );
}

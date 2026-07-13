import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../state/AuthContext';
import AuthLayout from '../components/auth/AuthLayout';
import FormField from '../components/auth/FormField';
import PasswordField from '../components/auth/PasswordField';
import PasswordStrength from '../components/auth/PasswordStrength';
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

export default function RegisterPage() {
  const { register, loginWithGoogle } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [name, setName]         = useState('');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');

  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [success, setSuccess]   = useState(false);

  function validate() {
    const errs = {};
    if (!email.trim()) errs.email = t('auth.validation.emailRequired');
    else if (!EMAIL_RE.test(email.trim())) errs.email = t('auth.validation.emailInvalid');
    if (!password) errs.password = t('auth.validation.passwordRequired');
    else if (password.length < 8) errs.password = t('auth.validation.passwordTooShort');
    if (!confirm) errs.confirm = t('auth.validation.confirmRequired');
    else if (password !== confirm) errs.confirm = t('auth.validation.passwordsMismatch');
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
      await register(email.trim(), password, name.trim());
      setSuccess(true);
      // Brief confirmation before moving on — feels less abrupt than an
      // instant redirect on what is, for the user, a meaningful action.
      setTimeout(() => navigate('/executive'), 600);
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

  return (
    <AuthLayout
      eyebrow={t('auth.register.eyebrow')}
      title={t('auth.register.title')}
      subtitle={t('auth.register.subtitle')}
    >
      <form onSubmit={handleSubmit} noValidate>
        <FormField
          name="name"
          label={t('auth.register.fullNameLabel')}
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={t('auth.register.namePlaceholder')}
          autoComplete="name"
          autoFocus
          disabled={loading || googleLoading || success}
        />

        <FormField
          name="email"
          label={t('auth.login.emailLabel')}
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder={t('auth.login.emailPlaceholder')}
          autoComplete="email"
          required
          disabled={loading || googleLoading || success}
          error={fieldErrors.email}
        />

        <PasswordField
          name="password"
          label={t('auth.login.passwordLabel')}
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder={t('auth.register.passwordPlaceholder')}
          autoComplete="new-password"
          required
          disabled={loading || googleLoading || success}
          error={fieldErrors.password}
        />
        <PasswordStrength password={password} />

        <PasswordField
          name="confirm"
          label={t('auth.register.confirmLabel')}
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          placeholder={t('auth.register.confirmPlaceholder')}
          autoComplete="new-password"
          required
          disabled={loading || googleLoading || success}
          error={fieldErrors.confirm}
        />

        {error && (
          <div role="alert" style={{
            padding: '10px 14px', borderRadius: 10, marginBottom: 16, marginTop: 4,
            background: 'var(--color-red-dim)', border: '1px solid rgba(240,62,62,0.3)',
            color: 'var(--color-red)', fontSize: 13, lineHeight: 1.4,
          }}>
            {error}
          </div>
        )}

        {success && (
          <div role="status" style={{
            padding: '10px 14px', borderRadius: 10, marginBottom: 16,
            background: 'var(--color-green-dim)', border: '1px solid rgba(0,184,122,0.3)',
            color: 'var(--color-green)', fontSize: 13, fontWeight: 600,
          }}>
            {t('auth.register.successMessage')}
          </div>
        )}

        <SubmitButton loading={loading} disabled={googleLoading || success}>
          {loading ? t('auth.register.creatingAccount') : success ? t('auth.register.accountCreated') : t('auth.register.createAccount')}
        </SubmitButton>
      </form>

      <AuthDivider />

      <GoogleButton
        onClick={handleGoogle}
        loading={googleLoading}
        disabled={loading || success || !isFirebaseConfigured}
        label={isFirebaseConfigured ? t('auth.register.signUpWithGoogle') : t('auth.login.googleUnavailable')}
      />

      <p style={{ textAlign: 'center', marginTop: 24, fontSize: 13.5, color: 'var(--text-dim)' }}>
        {t('auth.register.alreadyHaveAccount')}{' '}
        <Link to="/login" style={{ color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 600 }}>
          {t('auth.login.signIn')}
        </Link>
      </p>
    </AuthLayout>
  );
}

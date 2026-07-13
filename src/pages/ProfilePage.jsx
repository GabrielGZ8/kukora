/**
 * ProfilePage — /profile
 *
 * Muestra:
 *   - Avatar generativo con iniciales + gradiente
 *   - Nombre, email, fecha de registro, último login
 *   - Stats del engine (trades totales, PnL sesión, exchange top)
 *   - Formulario de cambio de contraseña
 *
 * Tras cambio de contraseña exitoso → logout forzado (el backend invalida
 * el refresh token; el JWT actual expira pronto de todos modos).
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api } from '../api';
import { useAuth } from '../state/AuthContext';
import { usePolling } from '../hooks/usePolling';
import { PageHeader } from '../components/common/PageHeader';
import { useTranslation } from '../i18n/I18nContext';

const PINK  = '#FF2D78';
const GREEN = '#00b87a';
const GRAD  = `linear-gradient(135deg, ${PINK}, #5741D9)`;

// ─── Avatar generativo ──────────────────────────────────────────────────────
function UserAvatar({ name, email, avatarUrl, size = 64 }) {
  const initial = (name || email || 'U').charAt(0).toUpperCase();
  const radius  = Math.round(size * 0.22);
  if (avatarUrl) {
    return (
      <img src={avatarUrl} alt="" referrerPolicy="no-referrer" style={{
        width: size, height: size, borderRadius: radius, objectFit: 'cover',
        flexShrink: 0, boxShadow: `0 6px 24px ${PINK}33`,
      }} onError={e => { e.target.style.display = 'none'; }} />
    );
  }
  return (
    <div style={{
      width: size, height: size, borderRadius: radius,
      background: GRAD,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: Math.round(size * 0.38), fontWeight: 900,
      color: '#fff', flexShrink: 0,
      boxShadow: `0 6px 24px ${PINK}33`,
    }}>
      {initial}
    </div>
  );
}

// ─── Stat card ──────────────────────────────────────────────────────────────
function StatCard({ label, value, loading }) {
  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '16px 18px', flex: 1, minWidth: 130,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--text)', opacity: loading ? 0.3 : 1 }}>
        {loading ? '…' : (value ?? '—')}
      </div>
    </div>
  );
}

// ─── Section wrapper ────────────────────────────────────────────────────────
function Section({ title, children }) {
  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 16, padding: '24px',
      marginBottom: 20,
    }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', marginBottom: 18 }}>{title}</div>
      {children}
    </div>
  );
}

// ─── Input field ─────────────────────────────────────────────────────────────
function Field({ label, type = 'text', value, onChange, placeholder, disabled }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 200 }}>
      <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        style={{
          background: 'var(--bg-base)',
          border: '1px solid var(--border)',
          borderRadius: 10, padding: '10px 14px',
          fontSize: 13, color: 'var(--text)',
          outline: 'none', width: '100%',
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? 'not-allowed' : 'text',
        }}
        onFocus={e  => { e.currentTarget.style.borderColor = PINK; }}
        onBlur={e   => { e.currentTarget.style.borderColor = 'var(--border)'; }}
      />
    </div>
  );
}

// ─── Date formatter ────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-MX', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

function fmtPnl(n) {
  if (n == null) return '—';
  const abs = Math.abs(n);
  const str = abs >= 1000 ? `$${(abs / 1000).toFixed(2)}k` : `$${abs.toFixed(2)}`;
  return (n >= 0 ? '+' : '-') + str;
}

// ─── Main ────────────────────────────────────────────────────────────────────
export default function ProfilePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  // Profile data (fresh from server)
  const [profileData, setProfileData] = useState(null);
  const [profileLoading, setProfileLoading] = useState(true);

  // Edit name
  const [editName, setEditName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameEditing, setNameEditing] = useState(false);

  // Change password form
  const [pwForm, setPwForm]       = useState({ current: '', next: '', confirm: '' });
  const [pwLoading, setPwLoading] = useState(false);

  // Fetch profile from /api/auth/me on mount
  // Note: api.profile.get() resolves to { user: {...} } (the server wraps
  // the record in a `user` key) — it must be unwrapped here, otherwise
  // every field (name, createdAt, lastLoginAt...) reads as undefined and
  // falls back to placeholders even though the data loaded successfully.
  useEffect(() => {
    api.profile.get()
      .then(d => { setProfileData(d?.user || null); setEditName(d?.user?.name || ''); })
      .catch(() => { setProfileData(null); })
      .finally(() => setProfileLoading(false));
  }, []);

  // Engine stats (30s polling — global motor, not per-user)
  const { data: exec, loading: execL } = usePolling(() => api.arb.executive(), 30_000);

  const displayUser = profileData || user;

  // ─── Handlers ────────────────────────────────────────────────────────────

  async function handleSaveName() {
    if (!editName.trim()) return;
    setSavingName(true);
    try {
      const res = await api.profile.update({ name: editName.trim() });
      setProfileData(prev => ({ ...prev, ...(res?.user || { name: editName.trim() }) }));
      setNameEditing(false);
      toast.success('Nombre actualizado');
    } catch (e) {
      toast.error(e.message || 'Error al guardar');
    } finally {
      setSavingName(false);
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    if (!pwForm.current) return toast.error('Enter your current password');
    if (pwForm.next.length < 8) return toast.error('New password must be at least 8 characters');
    if (pwForm.next !== pwForm.confirm) return toast.error('Passwords do not match');

    setPwLoading(true);
    try {
      await api.profile.changePassword({
        currentPassword: pwForm.current,
        newPassword: pwForm.next,
      });
      toast.success('Password changed. Signing out for security…', { duration: 3000 });
      // Backend invalida el refresh token — hay que hacer logout forzado
      setTimeout(() => { logout(); navigate('/login'); }, 2500);
    } catch (e) {
      toast.error(e.message || 'Failed to change password');
    } finally {
      setPwLoading(false);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="page-enter" style={{ maxWidth: 720, margin: '0 auto' }}>
      <PageHeader title={t('profile.title')} description={t('profile.description')} />

      {/* Identity */}
      <Section title={t('profile.account')}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
          <UserAvatar name={displayUser?.name} email={displayUser?.email} avatarUrl={displayUser?.avatarUrl} size={64} />

          <div style={{ flex: 1, minWidth: 220 }}>
            {/* Name edit */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              {nameEditing ? (
                <>
                  <input
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    style={{
                      background: 'var(--bg-base)', border: `1px solid ${PINK}`,
                      borderRadius: 8, padding: '6px 12px', fontSize: 18,
                      fontWeight: 800, color: 'var(--text)', outline: 'none', minWidth: 0, flex: 1,
                    }}
                    onKeyDown={e => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') setNameEditing(false); }}
                    autoFocus
                  />
                  <button
                    onClick={handleSaveName}
                    disabled={savingName}
                    style={{
                      padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 800,
                      background: `linear-gradient(135deg, ${PINK}, ${GREEN})`,
                      border: 'none', color: '#fff', cursor: 'pointer',
                    }}
                  >
                    {savingName ? '…' : 'Guardar'}
                  </button>
                  <button
                    onClick={() => { setNameEditing(false); setEditName(displayUser?.name || ''); }}
                    style={{
                      padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                      background: 'var(--bg-surface-2)', border: '1px solid var(--border)',
                      color: 'var(--text-muted)', cursor: 'pointer',
                    }}
                  >
                    Cancelar
                  </button>
                </>
              ) : (
                <>
                  <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)' }}>
                    {profileLoading ? '…' : (displayUser?.name || 'Sin nombre')}
                  </span>
                  <button
                    onClick={() => setNameEditing(true)}
                    style={{
                      fontSize: 11, fontWeight: 700, color: 'var(--text-dim)',
                      background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                    }}
                  >
                    ✏️
                  </button>
                </>
              )}
            </div>

            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
              {displayUser?.email}
              {displayUser?.authProvider === 'google' && (
                <span style={{
                  fontSize: 10.5, fontWeight: 700, color: 'var(--color-blue)',
                  background: 'var(--color-blue-dim)', padding: '2px 8px', borderRadius: 999,
                  textTransform: 'uppercase', letterSpacing: '0.04em',
                }}>
                  Google account
                </span>
              )}
            </div>

            {/* Dates */}
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 10 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Miembro desde</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  {profileLoading ? '…' : fmtDate(profileData?.createdAt)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Last access</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  {profileLoading ? '…' : fmtDate(profileData?.lastLoginAt)}
                </div>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* Engine stats */}
      <Section title={t('profile.engineStats')}>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.6 }}>
          El motor de arbitraje es compartido entre todos los usuarios — estas métricas reflejan la
          sesión global actual, no son por usuario individual.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <StatCard label="Trades ejecutados"  value={exec?.tradesExecuted}        loading={execL} />
          <StatCard label="PnL sesión"         value={fmtPnl(exec?.profitSession)} loading={execL} />
          <StatCard label="Exchange top"       value={exec?.bestExchange}          loading={execL} />
          <StatCard label="Exchanges conectados" value={exec?.connectedExchanges}  loading={execL} />
        </div>
        <button
          onClick={() => navigate('/arbitrage')}
          style={{
            marginTop: 16, padding: '10px 20px', borderRadius: 10,
            fontSize: 13, fontWeight: 800, cursor: 'pointer',
            background: `linear-gradient(135deg, ${PINK}, ${GREEN})`,
            border: 'none', color: '#fff',
            boxShadow: `0 4px 14px ${PINK}22`,
          }}
        >
          Ir al motor →
        </button>
      </Section>

      {/* Change password */}
      <Section title={t('profile.changePassword')}>
        {displayUser?.authProvider === 'google' ? (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px',
            background: 'var(--color-blue-dim)', borderRadius: 10, fontSize: 13,
            color: 'var(--text-muted)', lineHeight: 1.5,
          }}>
            <span style={{ fontSize: 16 }}>🔒</span>
            Tu cuenta inicia sesión con Google — no tiene una contraseña local que cambiar.
            Administra la seguridad de tu cuenta desde tu cuenta de Google.
          </div>
        ) : (
        <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field
            label="Contraseña actual"
            type="password"
            value={pwForm.current}
            onChange={e => setPwForm(p => ({ ...p, current: e.target.value }))}
            placeholder="Tu contraseña actual"
            disabled={pwLoading}
          />
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Field
              label="Nueva contraseña"
              type="password"
              value={pwForm.next}
              onChange={e => setPwForm(p => ({ ...p, next: e.target.value }))}
              placeholder="Mínimo 8 caracteres"
              disabled={pwLoading}
            />
            <Field
              label="Confirmar nueva contraseña"
              type="password"
              value={pwForm.confirm}
              onChange={e => setPwForm(p => ({ ...p, confirm: e.target.value }))}
              placeholder="Repite la nueva contraseña"
              disabled={pwLoading}
            />
          </div>

          <p style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, margin: 0 }}>
            Por seguridad, al cambiar la contraseña se cerrará la sesión automáticamente y tendrás que volver a iniciar sesión.
          </p>

          <div>
            <button
              type="submit"
              disabled={pwLoading || !pwForm.current || !pwForm.next || !pwForm.confirm}
              style={{
                padding: '11px 24px', borderRadius: 10, fontSize: 13, fontWeight: 800, cursor: 'pointer',
                background: pwLoading ? 'var(--bg-surface-2)' : `linear-gradient(135deg, ${PINK}, #5741D9)`,
                border: 'none', color: pwLoading ? 'var(--text-muted)' : '#fff',
                boxShadow: pwLoading ? 'none' : `0 4px 14px ${PINK}33`,
                transition: 'all 0.15s',
                opacity: (!pwForm.current || !pwForm.next || !pwForm.confirm) ? 0.5 : 1,
              }}
            >
              {pwLoading ? 'Changing…' : 'Change password'}
            </button>
          </div>
        </form>
        )}
      </Section>
    </div>
  );
}
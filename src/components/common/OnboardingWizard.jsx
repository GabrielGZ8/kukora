// ─── OnboardingWizard.jsx — Post-registration account setup ──────────────
// Distinct from Onboarding.jsx (the product tour): this wizard configures
// the account itself — display name/theme, active trading pairs, and an
// explicit paper-vs-live trading acknowledgement — and is gated by
// `user.onboardingDone` (persisted server-side), not localStorage.
//
// Step 1: display name + theme preference
// Step 2: active trading pairs (api.trading.setPairs)
// Step 3: confirm paper mode + explain what live trading means

import { useState } from 'react';
import { useAuth } from '../../state/AuthContext';
import { useTradingMode } from '../../hooks/useTradingMode';
import { api } from '../../api';

const PINK  = '#FF2D78';
const GREEN = '#00b87a';
const AMBER = '#F59E0B';

const PAIR_COLORS = {
  'BTC/USDT': '#F7931A', 'ETH/USDT': '#627EEA',
  'SOL/USDT': '#9945FF', 'BNB/USDT': '#F3BA2F', 'XRP/USDT': '#00AAE4',
};
const PAIR_LOGOS = {
  'BTC/USDT': '₿', 'ETH/USDT': 'Ξ', 'SOL/USDT': '◎', 'BNB/USDT': '⬡', 'XRP/USDT': '✕',
};

function StepDots({ total, current }) {
  return (
    <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginBottom: 4 }}>
      {Array.from({ length: total }).map((_, i) => (
        <span key={i} style={{
          width: i === current ? 22 : 7, height: 7, borderRadius: 99,
          background: i === current ? PINK : i < current ? GREEN : 'var(--border-bright)',
          transition: 'all 0.2s',
        }} />
      ))}
    </div>
  );
}

export default function OnboardingWizard({ onComplete }) {
  const { user, updateUser } = useAuth();
  const { setPairs, supported, loading: tradingLoading } = useTradingMode();

  const [step, setStep]           = useState(0);
  const [name, setName]           = useState(user?.name || '');
  const [theme, setTheme]         = useState(() => localStorage.getItem('kukora-theme') || 'light');
  const [selectedPairs, setSelectedPairs] = useState(['BTC/USDT']);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');

  const TOTAL_STEPS = 3;

  function applyTheme(next) {
    setTheme(next);
    if (next === 'dark') document.documentElement.classList.add('dark-theme');
    else document.documentElement.classList.remove('dark-theme');
    try { localStorage.setItem('kukora-theme', next); } catch { /* private browsing */ }
  }

  function togglePair(pair) {
    setSelectedPairs(prev => {
      if (prev.includes(pair)) {
        if (prev.length === 1) return prev; // keep at least one active pair
        return prev.filter(p => p !== pair);
      }
      return [...prev, pair];
    });
  }

  async function goNext() {
    setError('');

    if (step === 0) {
      if (!name.trim()) { setError('Please enter a display name.'); return; }
      setStep(1);
      return;
    }

    if (step === 1) {
      setSaving(true);
      try {
        await setPairs({ pairs: selectedPairs });
        setStep(2);
      } catch (e) {
        setError(e.message || 'Could not save trading pairs. You can change this later in Settings.');
        setStep(2); // non-blocking — pair selection isn't critical enough to trap the user
      } finally {
        setSaving(false);
      }
      return;
    }

    // Step 2 — finish
    setSaving(true);
    try {
      await api.profile.update({ name: name.trim(), onboardingDone: true });
      updateUser({ name: name.trim(), onboardingDone: true });
      onComplete?.();
    } catch (e) {
      setError(e.message || 'Could not finish setup. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  function goBack() {
    setError('');
    if (step > 0) setStep(step - 1);
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 20,
        width: '100%', maxWidth: 480, maxHeight: 'calc(100vh - 40px)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 32px 80px rgba(0,0,0,0.5)',
      }}>
        <div style={{ height: 4, background: `linear-gradient(90deg, ${PINK}, ${GREEN})`, flexShrink: 0 }} />

        <div style={{ padding: '26px 28px 0', textAlign: 'center', flexShrink: 0 }}>
          <div style={{ fontSize: 28, fontWeight: 900, color: GREEN, letterSpacing: '-1px', marginBottom: 4 }}>kukora</div>
          <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 18 }}>Let&apos;s set up your account</div>
        </div>

        <div style={{ padding: '0 28px 18px', flex: 1, overflowY: 'auto' }}>

          {step === 0 && (
            <div>
              <h3 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', marginBottom: 4 }}>How should we call you?</h3>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 18, lineHeight: 1.5 }}>
                This name appears in the topbar and on your profile.
              </p>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                Display name
              </label>
              <input
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Your name"
                maxLength={80}
                style={{
                  width: '100%', padding: '11px 14px', borderRadius: 8, fontSize: 14,
                  background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                  color: 'var(--text)', outline: 'none', boxSizing: 'border-box', marginBottom: 22,
                  fontFamily: 'var(--font-ui)',
                }}
              />
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                Theme
              </label>
              <div style={{ display: 'flex', gap: 10 }}>
                {[
                  { id: 'light', label: '☀️ Light' },
                  { id: 'dark',  label: '🌙 Dark' },
                ].map(t => (
                  <button
                    key={t.id}
                    onClick={() => applyTheme(t.id)}
                    style={{
                      flex: 1, padding: '12px 0', borderRadius: 10, fontSize: 13, fontWeight: 700,
                      cursor: 'pointer', transition: 'all 0.15s',
                      background: theme === t.id ? 'var(--color-primary-dim)' : 'var(--bg-elevated)',
                      border: `1px solid ${theme === t.id ? 'var(--color-primary)' : 'var(--border)'}`,
                      color: theme === t.id ? 'var(--color-primary)' : 'var(--text-muted)',
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 1 && (
            <div>
              <h3 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', marginBottom: 4 }}>Which pairs do you want to trade?</h3>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 18, lineHeight: 1.5 }}>
                The engine only scans pairs you activate here. You can change this anytime in Settings.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(supported.length ? supported : ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT']).map(pair => {
                  const active = selectedPairs.includes(pair);
                  const color  = PAIR_COLORS[pair] || PINK;
                  return (
                    <button
                      key={pair}
                      onClick={() => togglePair(pair)}
                      disabled={tradingLoading}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '12px 14px', borderRadius: 10, cursor: 'pointer',
                        background: active ? `${color}12` : 'var(--bg-elevated)',
                        border: `1px solid ${active ? color : 'var(--border)'}`,
                        transition: 'all 0.15s', textAlign: 'left',
                      }}
                    >
                      <span style={{
                        width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                        background: `${color}18`, color,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 15, fontWeight: 800,
                      }}>
                        {PAIR_LOGOS[pair] || pair[0]}
                      </span>
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{pair}</span>
                      <span style={{
                        width: 20, height: 20, borderRadius: 6, flexShrink: 0,
                        border: `2px solid ${active ? color : 'var(--border-bright)'}`,
                        background: active ? color : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#fff', fontSize: 12, fontWeight: 900,
                      }}>
                        {active ? '✓' : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <h3 style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)', marginBottom: 4 }}>You&apos;re starting in Paper Trading</h3>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
                Every new account begins in paper mode — safe by default.
              </p>
              <div style={{ background: 'rgba(0,184,122,0.06)', border: '1px solid rgba(0,184,122,0.2)', borderRadius: 10, padding: '14px 16px', marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: GREEN, fontWeight: 800, marginBottom: 4 }}>📝 Paper Trading (active now)</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  Real market prices, simulated execution. The engine detects real arbitrage opportunities and tracks what it would have earned — with zero real funds at risk.
                </div>
              </div>
              <div style={{ background: `${AMBER}0f`, border: `1px solid ${AMBER}30`, borderRadius: 10, padding: '14px 16px' }}>
                <div style={{ fontSize: 12, color: AMBER, fontWeight: 800, marginBottom: 4 }}>⚡ Live Trading (opt-in later)</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  Executes real trades with real funds across connected exchanges. Requires valid API keys and explicit confirmation in Settings — never enabled automatically.
                </div>
              </div>
            </div>
          )}

          {error && (
            <div style={{
              marginTop: 16, padding: '10px 14px', borderRadius: 8,
              background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
              color: 'var(--color-red)', fontSize: 12,
            }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ padding: '0 28px 24px', flexShrink: 0 }}>
          <StepDots total={TOTAL_STEPS} current={step} />
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            {step > 0 && (
              <button onClick={goBack} disabled={saving} style={{
                background: 'var(--bg-surface-2)', border: '1px solid var(--border)',
                color: 'var(--text-muted)', borderRadius: 10, padding: '11px 20px',
                fontWeight: 700, fontSize: 13, cursor: saving ? 'not-allowed' : 'pointer',
              }}>
                ← Back
              </button>
            )}
            <button onClick={goNext} disabled={saving} style={{
              flex: 1, background: `linear-gradient(135deg, ${PINK}, ${GREEN})`,
              color: '#fff', border: 'none', borderRadius: 10, padding: '12px 22px',
              fontWeight: 800, fontSize: 13, cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.7 : 1,
              boxShadow: `0 4px 14px ${PINK}33`,
            }}>
              {saving ? 'Saving…' : step === 2 ? 'Start using Kukora →' : 'Continue →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import LiveAnomalyBanner from '../common/LiveAnomalyBanner';
import Onboarding from '../common/Onboarding';
import { useOnboarding } from '../../hooks/useOnboarding';
import OnboardingWizard from '../common/OnboardingWizard';
import NotificationBell from './NotificationBell';
import { useAlertMonitor } from '../../hooks/useAlertMonitor';
import { useAuth } from '../../state/AuthContext';
import BirdsAnimation from './BirdsAnimation';
import NavItem from './NavItem';
import NAV from './navConfig';
import { fetchMarketTrend } from './marketTrend';
import { Text } from '../common/design-system';
import { useTranslation } from '../../i18n/I18nContext';

const HEADER_H = 56;

export default function Layout() {
  const [open, setOpen]             = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [toolsOpen, setToolsOpen]       = useState(false);
  const [time, setTime]             = useState('');
  const [lastUpdate, setLastUpdate] = useState(null);
  const lastUpdateRef = useRef(null);
  const [marketTrend, setMkt]       = useState('neutral');
  const location                    = useLocation();
  const onboarding                  = useOnboarding();
  const { user, isAuthenticated, logout } = useAuth();
  const navigate                    = useNavigate();
  const [theme, setTheme]           = useState(() => localStorage.getItem('kukora-theme') || 'light');
  useAlertMonitor();

  const [showSetupWizard, setShowSetupWizard] = useState(false);
  useEffect(() => {
    setShowSetupWizard(isAuthenticated && user && user.onboardingDone !== true);
  }, [isAuthenticated, user]);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark-theme');
    } else {
      document.documentElement.classList.remove('dark-theme');
    }
    localStorage.setItem('kukora-theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(prev => prev === 'light' ? 'dark' : 'light');

  const { t, lang, setLang } = useTranslation();
  const currentNav = NAV.find(n => location.pathname.startsWith(n.path));
  const page       = (currentNav?.labelKey ? t(currentNav.labelKey) : currentNav?.label) || '';

  useEffect(() => {
    const inAdvanced = NAV.filter(n => n.group === 'advanced').some(n => location.pathname.startsWith(n.path));
    const inResearch = NAV.filter(n => n.group === 'research').some(n => location.pathname.startsWith(n.path));
    const inTools    = NAV.filter(n => n.group === 'tools').some(n => location.pathname.startsWith(n.path));
    if (inAdvanced || inResearch) setAdvancedOpen(true);
    if (inResearch) setResearchOpen(true);
    if (inTools) setToolsOpen(true);
  }, [location.pathname]);

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setTime(now.toLocaleTimeString('en-US', { hour12: false }));
      if (!lastUpdateRef.current || now - lastUpdateRef.current > 30000) {
        lastUpdateRef.current = now;
        setLastUpdate(now);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchMarketTrend().then(t => { if (!cancelled) setMkt(t); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handle = (e) => {
      if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
      if (e.key === '?') { e.preventDefault(); onboarding.open(); }
      if (e.key === '[') setOpen(o => !o);
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [onboarding]);

  return (
    <div style={{
      display: 'flex', height: '100vh', overflow: 'hidden',
      background: 'var(--bg-base)',
    }}>
      <aside style={{
        width: open ? 'var(--sidebar-width)' : 0,
        minWidth: open ? 'var(--sidebar-width)' : 0,
        flexShrink: 0,
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        height: '100vh', overflow: 'hidden',
        transition: 'width 0.2s ease, min-width 0.2s ease',
        boxShadow: open ? '2px 0 16px rgba(0,0,0,0.06)' : 'none',
      }}>
        <div style={{
          height: HEADER_H, flexShrink: 0,
          display: 'flex', alignItems: 'center',
          padding: '0 16px', gap: 10,
          borderBottom: '1px solid var(--border)',
          overflow: 'hidden',
        }}>
          <img src="/favicon.png" alt="kukora"
            style={{ width: 30, height: 30, borderRadius: 7, objectFit: 'contain', flexShrink: 0 }}
            onError={e => { e.target.style.display = 'none'; }}
          />
          <div style={{ minWidth: 0, overflow: 'hidden' }}>
            <div style={{
              fontSize: 18, fontWeight: 900, letterSpacing: '-0.5px', lineHeight: 1.1,
              background: 'var(--brand-gradient)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              whiteSpace: 'nowrap',
            }}>
              kukora
            </div>
            <div style={{
              fontSize: 9, color: 'var(--text-dim)', fontWeight: 600,
              letterSpacing: '0.08em', textTransform: 'uppercase', lineHeight: 1, marginTop: 2,
              whiteSpace: 'nowrap',
            }}>
              Bitcoin Arbitrage
            </div>
          </div>
        </div>

        <nav style={{ flex: 1, padding: '6px 8px', overflowY: 'auto', overflowX: 'hidden' }}>
          <div style={{ marginBottom: 8 }}>
            <div style={{
              fontSize: 9, fontWeight: 900, color: '#FF2D78',
              letterSpacing: '0.10em', textTransform: 'uppercase',
              padding: '10px 10px 4px', userSelect: 'none',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#FF2D78', boxShadow: '0 0 5px #FF2D78' }} />
              Arbitrage System
            </div>
            <div style={{
              background: 'linear-gradient(135deg, rgba(255,45,120,0.04), rgba(87,65,217,0.03))',
              border: '1px solid rgba(255,45,120,0.15)',
              borderRadius: 10, padding: '3px', marginBottom: 4,
            }}>
              {NAV.filter(n => n.group === 'arb').map(item => (
                <NavItem key={item.path} item={item} />
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 2 }}>
            <div style={{ padding: '10px 10px 4px' }}>
              <Text size="xs" weight="bold" color="dim" uppercase>Markets</Text>
            </div>
            {NAV.filter(n => n.group === 'core').map(item => (
              <NavItem key={item.path} item={item} />
            ))}
          </div>

          <div style={{ marginBottom: 2 }}>
            <div
              onClick={() => setToolsOpen(o => !o)}
              style={{
                padding: '10px 10px 4px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                cursor: 'pointer', borderRadius: 6,
              }}
            >
              <Text size="xs" weight="bold" color="dim" uppercase>Tools</Text>
              <span style={{
                fontSize: 10, transition: 'transform 0.2s', display: 'inline-block',
                color: 'var(--text-dim)',
                transform: toolsOpen ? 'rotate(90deg)' : 'rotate(0deg)',
              }}>›</span>
            </div>
            {toolsOpen && NAV.filter(n => n.group === 'tools').map(item => (
              <NavItem key={item.path} item={item} />
            ))}
          </div>

          <div style={{ marginBottom: 2 }}>
            <div
              onClick={() => setAdvancedOpen(o => !o)}
              style={{
                fontSize: 9, fontWeight: 800, color: 'var(--text-dim)',
                letterSpacing: '0.10em', textTransform: 'uppercase',
                padding: '10px 10px 4px', userSelect: 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                cursor: 'pointer', borderRadius: 6, transition: 'color 0.13s',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-muted)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = ''; }}
            >
              <span>Quantitative Analysis</span>
              <span style={{
                fontSize: 10, transition: 'transform 0.2s', display: 'inline-block',
                transform: advancedOpen ? 'rotate(90deg)' : 'rotate(0deg)',
              }}>›</span>
            </div>

            {advancedOpen && (
              <>
                {NAV.filter(n => n.group === 'advanced').map(item => (
                  <NavItem key={item.path} item={item} />
                ))}

                <div style={{ marginTop: 2 }}>
                  <div
                    onClick={() => setResearchOpen(o => !o)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '5px 10px 4px 10px',
                      fontSize: 9, fontWeight: 800, color: 'var(--text-dim)',
                      letterSpacing: '0.10em', textTransform: 'uppercase',
                      cursor: 'pointer', userSelect: 'none', borderRadius: 6, transition: 'color 0.13s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-muted)'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = ''; }}
                  >
                    <span>🔬 Research</span>
                    <span style={{
                      fontSize: 10, transition: 'transform 0.2s', display: 'inline-block',
                      transform: researchOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                    }}>›</span>
                  </div>

                  {researchOpen && (
                    <div style={{ borderLeft: '2px solid var(--border)', marginLeft: 18, paddingLeft: 0 }}>
                      {NAV.filter(n => n.group === 'research').map(item => (
                        <NavItem key={item.path} item={item} indent />
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {(() => {
            const items = NAV.filter(n => n.group === 'info');
            if (items.length === 0) return null;
            return (
              <div style={{ marginBottom: 2 }}>
                <div style={{
                  fontSize: 9, fontWeight: 800, color: 'var(--text-dim)',
                  letterSpacing: '0.10em', textTransform: 'uppercase',
                  padding: '10px 10px 4px', userSelect: 'none',
                }}>
                  Platform
                </div>
                {items.map(item => <NavItem key={item.path} item={item} />)}
              </div>
            );
          })()}
        </nav>

        <div style={{ padding: '8px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 10px', fontSize: 11, color: 'var(--text-muted)',
            background: 'var(--bg-surface-2)', borderRadius: 8, marginBottom: 6,
          }}>
            <div className="pulse-dot" />
            <span style={{ fontWeight: 600, flex: 1, whiteSpace: 'nowrap' }}>Live · {time}</span>
          </div>
          <button
            onClick={onboarding.open}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 10px', fontSize: 11, color: 'var(--text-dim)',
              background: 'none', border: 'none', borderRadius: 8,
              cursor: 'pointer', fontFamily: 'var(--font-ui)', fontWeight: 500,
              transition: 'all 0.13s', textAlign: 'left',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface-2)'; e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-dim)'; }}
          >
            <span style={{ fontSize: 12 }}>?</span>
            <span>User Guide</span>
            <kbd style={{
              marginLeft: 'auto', fontSize: 9, fontWeight: 700,
              background: 'var(--bg-surface-3)', border: '1px solid var(--border)',
              borderRadius: 4, padding: '1px 5px', fontFamily: 'var(--font-mono)',
              color: 'var(--text-dim)',
            }}>?</kbd>
          </button>
        </div>
      </aside>

      <main style={{
        flex: 1, minWidth: 0,
        display: 'flex', flexDirection: 'column',
        height: '100vh', overflow: 'hidden',
      }}>
        <header style={{
          height: HEADER_H, flexShrink: 0,
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 20px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
          gap: 12, overflow: 'hidden', position: 'relative',
        }}>
          <BirdsAnimation marketTrend={marketTrend} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1, position: 'relative', zIndex: 1 }}>
            <button
              onClick={() => setOpen(o => !o)}
              title="Collapse sidebar"
              style={{
                background: 'none', border: 'none',
                color: 'var(--text-muted)', fontSize: 17,
                padding: '4px 6px', borderRadius: 6,
                cursor: 'pointer', lineHeight: 1, flexShrink: 0, transition: 'all 0.13s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-surface-2)'; e.currentTarget.style.color = 'var(--text)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-muted)'; }}
            >☰</button>

            <span style={{ color: 'var(--border-bright)', fontSize: 16, flexShrink: 0, userSelect: 'none' }}>›</span>

            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {page}
            </span>

            {currentNav?.badge && (
              <span style={{
                fontSize: 8, fontWeight: 800, flexShrink: 0,
                textTransform: 'uppercase', letterSpacing: '0.06em',
                color: currentNav.badge === 'AI' ? 'var(--color-primary)' : currentNav.badge === 'LIVE' ? 'var(--color-green)' : 'var(--color-blue)',
                background: currentNav.badge === 'AI' ? 'var(--color-primary-dim)' : currentNav.badge === 'LIVE' ? 'var(--color-green-dim)' : 'var(--color-blue-dim)',
                padding: '2px 7px', borderRadius: 99,
              }}>
                {currentNav.badge}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, position: 'relative', zIndex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                color: marketTrend === 'bullish' ? 'var(--color-green)' : marketTrend === 'bearish' ? 'var(--color-red)' : 'var(--text-dim)',
                opacity: 0.7,
              }}>
                {marketTrend === 'bullish' ? '▲' : marketTrend === 'bearish' ? '▼' : '—'}
              </span>
            </div>

            {lastUpdate && (
              <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                ↺ {lastUpdate.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })}
              </span>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div className="pulse-dot" />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>Live</span>
            </div>

            <div style={{ width: 1, height: 18, background: 'var(--border)' }} />

            <div style={{ width: 1, height: 18, background: 'var(--border)' }} />

            <button
              onClick={() => setLang(lang === 'es' ? 'en' : 'es')}
              title={t('common.language')}
              aria-label={t('common.language')}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, borderRadius: 8,
                background: 'var(--bg-surface-2)', border: '1px solid var(--border)',
                color: 'var(--text-muted)', fontSize: 10.5, fontWeight: 800,
                letterSpacing: '0.02em', cursor: 'pointer', transition: 'all 0.13s',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.color = 'var(--color-primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
            >
              {lang.toUpperCase()}
            </button>

            <button
              onClick={toggleTheme}
              title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, borderRadius: 8,
                background: 'var(--bg-surface-2)', border: '1px solid var(--border)',
                color: 'var(--text-muted)', fontSize: 13, cursor: 'pointer', transition: 'all 0.13s',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.color = 'var(--color-primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
            >
              {theme === 'light' ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
              )}
            </button>

             

            {isAuthenticated && (
              <>
                <div style={{ width: 1, height: 18, background: 'var(--border)' }} />
                <NotificationBell />
                <div style={{ width: 1, height: 18, background: 'var(--border)' }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, minWidth: 0 }}>
                  <button
                    onClick={() => navigate('/profile')}
                    title="View profile"
                    style={{
                      width: 28, height: 28, borderRadius: 8,
                      background: 'linear-gradient(135deg, var(--color-primary, #FF2D78), #5741D9)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 11, fontWeight: 800, color: '#fff', flexShrink: 0,
                      border: 'none', cursor: 'pointer', transition: 'opacity 0.13s, transform 0.13s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.opacity = '0.85'; e.currentTarget.style.transform = 'scale(1.08)'; }}
                    onMouseLeave={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.transform = 'scale(1)'; }}
                  >
                    {(user?.name || user?.email || 'U').charAt(0).toUpperCase()}
                  </button>
                  <span
                    onClick={() => navigate('/profile')}
                    title="View profile"
                    style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 1 }}
                  >
                    {user?.name || user?.email?.split('@')[0] || 'User'}
                  </span>
                  <button
                    onClick={() => navigate('/settings')}
                    title="Settings"
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                      background: 'none', border: '1px solid var(--border)',
                      color: 'var(--text-dim)', cursor: 'pointer', transition: 'all 0.13s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-primary, #FF2D78)'; e.currentTarget.style.color = 'var(--color-primary, #FF2D78)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-dim)'; }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                    </svg>
                  </button>
                  <button
                    onClick={logout}
                    title="Sign out"
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                      background: 'none', border: '1px solid var(--border)',
                      color: 'var(--text-dim)', cursor: 'pointer', transition: 'all 0.13s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-red, #EF4444)'; e.currentTarget.style.color = 'var(--color-red, #EF4444)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-dim)'; }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                    </svg>
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        <div style={{ flex: 1, overflow: 'auto', padding: '24px' }}>
          <div style={{ maxWidth: 1440, margin: '0 auto' }}>
            <Outlet />
          </div>
        </div>
      </main>

      <LiveAnomalyBanner />
      {showSetupWizard && (
        <OnboardingWizard onComplete={() => setShowSetupWizard(false)} />
      )}
      <Onboarding
        show={onboarding.show}
        step={onboarding.step}
        setStep={onboarding.setStep}
        onDismiss={onboarding.dismiss}
      />
    </div>
  );
}
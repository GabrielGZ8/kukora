/**
 * AuthLayout — shared shell for LoginPage / RegisterPage.
 *
 * Adapts the provided split-panel reference design to Kukora's existing
 * design tokens (see src/styles/global.css): the brand pink/orange
 * gradient, --bg-surface, --border, --radius-* etc. Right-hand panel shows
 * a decorative brand gradient + the product mark rather than a stock photo,
 * since none was supplied — keeps things on-brand instead of inventing
 * unrelated imagery.
 */
export default function AuthLayout({ eyebrow, title, subtitle, children }) {
  return (
    <div style={{
      minHeight: '100vh', width: '100%', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg-base)', fontFamily: 'var(--font-ui)',
      padding: '24px 16px', boxSizing: 'border-box',
    }}>
      <div className="auth-card" style={{
        width: '100%', maxWidth: 1040, minHeight: 600,
        background: 'var(--bg-surface)', borderRadius: 28,
        boxShadow: 'var(--shadow-lg)', border: '1px solid var(--border)',
        display: 'flex', overflow: 'hidden',
      }}>
        {/* ── Left panel: form ───────────────────────────────────────── */}
        <div className="auth-form-panel" style={{
          flex: '1 1 480px', minWidth: 0,
          padding: '40px 48px', display: 'flex', flexDirection: 'column',
        }}>
          {/* Wordmark — same icon + gradient-text pattern as the app shell */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28 }}>
            <img src="/favicon.png" alt="" aria-hidden="true"
              style={{ width: 30, height: 30, borderRadius: 7, objectFit: 'contain' }}
              onError={e => { e.target.style.display = 'none'; }}
            />
            <span style={{
              fontSize: 20, fontWeight: 900, letterSpacing: '-0.5px',
              background: 'var(--brand-gradient)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
            }}>
              kukora
            </span>
          </div>

          <div style={{ marginBottom: 28 }}>
            {eyebrow && (
              <div style={{
                fontSize: 11, fontWeight: 700, color: 'var(--color-primary)',
                textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8,
              }}>
                {eyebrow}
              </div>
            )}
            <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--text)', margin: 0, letterSpacing: '-0.3px' }}>
              {title}
            </h1>
            {subtitle && (
              <p style={{ fontSize: 13.5, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
                {subtitle}
              </p>
            )}
          </div>

          <div style={{ flex: 1 }}>{children}</div>
        </div>

        {/* ── Right panel: brand illustration ────────────────────────── */}
        <div className="auth-illustration-panel" style={{
          flex: '1 1 460px', minWidth: 0, position: 'relative',
          background: 'var(--brand-gradient)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 40, overflow: 'hidden',
        }}>
          {/* Soft decorative blobs, purely visual */}
          <div style={{
            position: 'absolute', width: 320, height: 320, borderRadius: '50%',
            background: 'rgba(255,255,255,0.14)', top: -90, right: -90,
          }} />
          <div style={{
            position: 'absolute', width: 220, height: 220, borderRadius: '50%',
            background: 'rgba(255,255,255,0.10)', bottom: -60, left: -60,
          }} />

          <div style={{ position: 'relative', textAlign: 'center', color: '#fff', maxWidth: 360 }}>
            <img src="/kukora-logo.jpeg" alt="Kukora"
              style={{
                width: 220, maxWidth: '70%', borderRadius: 18,
                boxShadow: '0 20px 50px rgba(0,0,0,0.25)', marginBottom: 28,
                background: '#fff', padding: 14,
              }}
              onError={e => { e.target.style.display = 'none'; }}
            />
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-0.2px', marginBottom: 10 }}>
              Quantitative Arbitrage Intelligence
            </div>
            <div style={{ fontSize: 13.5, lineHeight: 1.6, opacity: 0.92 }}>
              Real-time spread detection, risk-managed execution, and
              institutional-grade analytics — all in one platform.
            </div>
          </div>
        </div>
      </div>

      {/* Responsive: stack panels and hide illustration on small screens */}
      <style>{`
        @media (max-width: 860px) {
          .auth-card { flex-direction: column; min-height: auto !important; }
          .auth-illustration-panel { display: none !important; }
          .auth-form-panel { padding: 32px 24px !important; }
        }
      `}</style>
    </div>
  );
}

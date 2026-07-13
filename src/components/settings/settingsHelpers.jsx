// ─── Settings shared style helpers and utility components ──────────────────
// Extracted from SettingsPage.jsx (Round 7 — audit 4.3: split large components).
// ─── Shared style helpers ──────────────────────────────────────────────────
const card = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 14,
  overflow: 'hidden',
  marginBottom: 20,
};

const cardHeader = {
  padding: '16px 22px',
  borderBottom: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const cardBody = { padding: '22px' };

const label = {
  display: 'block',
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom: 6,
};

const input = {
  width: '100%',
  padding: '10px 14px',
  borderRadius: 8,
  fontSize: 13,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  outline: 'none',
  boxSizing: 'border-box',
  fontFamily: 'var(--font-ui)',
};

const btnPrimary = {
  padding: '10px 22px',
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 700,
  border: 'none',
  cursor: 'pointer',
  background: 'var(--color-primary)',
  color: '#fff',
  transition: 'opacity 0.15s',
};

const btnSecondary = {
  padding: '10px 22px',
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 700,
  border: '1px solid var(--border)',
  cursor: 'pointer',
  background: 'var(--bg-elevated)',
  color: 'var(--text)',
  transition: 'all 0.15s',
};

function SectionTitle({ icon, title, subtitle }) {
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 7 }}>
        <span>{icon}</span> {title}
      </div>
      {subtitle && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{subtitle}</div>}
    </div>
  );
}

function StatusPill({ type = 'success', children }) {
  const colors = {
    success: { bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.35)', color: 'var(--color-green, #22C55E)' },
    error:   { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.35)', color: 'var(--color-red, #EF4444)' },
    warn:    { bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.35)', color: '#F59E0B' },
    info:    { bg: 'rgba(99,102,241,0.10)', border: 'rgba(99,102,241,0.30)', color: '#818CF8' },
  };
  const c = colors[type] || colors.info;
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '5px 12px', borderRadius: 99,
      background: c.bg, border: `1px solid ${c.border}`,
      fontSize: 11, fontWeight: 700, color: c.color,
    }}>
      {children}
    </div>
  );
}
export { card, cardHeader, cardBody, label, input, btnPrimary, btnSecondary, SectionTitle, StatusPill };

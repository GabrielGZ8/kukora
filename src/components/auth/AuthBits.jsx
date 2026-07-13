export function AuthDivider({ text = 'or' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0' }}>
      <div style={{ flex: 1, height: 1, background: 'var(--border-bright)' }} />
      <span style={{ fontSize: 11.5, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {text}
      </span>
      <div style={{ flex: 1, height: 1, background: 'var(--border-bright)' }} />
    </div>
  );
}

export function SubmitButton({ children, loading, disabled }) {
  return (
    <button
      type="submit"
      disabled={loading || disabled}
      style={{
        width: '100%', padding: '13px 0', borderRadius: 12, fontSize: 14.5, fontWeight: 700,
        cursor: (loading || disabled) ? 'not-allowed' : 'pointer',
        background: (loading || disabled) ? 'var(--bg-surface-3)' : 'var(--brand-gradient)',
        color: (loading || disabled) ? 'var(--text-dim)' : '#fff',
        border: 'none', boxShadow: (loading || disabled) ? 'none' : 'var(--shadow-glow)',
        transition: 'opacity 0.15s, box-shadow 0.15s',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      }}
    >
      {loading && (
        <span style={{
          width: 15, height: 15, borderRadius: '50%',
          border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff',
          animation: 'kukora-spin 0.7s linear infinite',
        }} />
      )}
      {children}
      <style>{`@keyframes kukora-spin { to { transform: rotate(360deg); } }`}</style>
    </button>
  );
}

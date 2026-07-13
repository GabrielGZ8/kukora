function scorePassword(pw) {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^a-zA-Z0-9]/.test(pw)) score++;
  return Math.min(score, 4);
}

const LEVELS = [
  { label: 'Too short', color: 'var(--color-red)' },
  { label: 'Weak', color: 'var(--color-red)' },
  { label: 'Fair', color: 'var(--color-yellow)' },
  { label: 'Good', color: 'var(--color-blue)' },
  { label: 'Strong', color: 'var(--color-green)' },
];

export default function PasswordStrength({ password }) {
  if (!password) return null;
  const score = scorePassword(password);
  const level = LEVELS[score];

  return (
    <div style={{ marginTop: -6, marginBottom: 16 }} aria-live="polite">
      <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} style={{
            flex: 1, height: 4, borderRadius: 2,
            background: i < score ? level.color : 'var(--border-bright)',
            transition: 'background 0.2s',
          }} />
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: level.color, fontWeight: 600 }}>
        {level.label}{password.length < 8 ? ' — minimum 8 characters' : ''}
      </div>
    </div>
  );
}

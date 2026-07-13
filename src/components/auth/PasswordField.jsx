import { useState } from 'react';
import { fieldStyle } from './FormField';

const labelStyle = {
  display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-dim)',
  marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em',
};

function EyeIcon({ open }) {
  return open ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.94 10.94 0 0112 19c-4.477 0-8.268-2.943-9.542-7a10.94 10.94 0 012.412-4.226M9.88 9.88a3 3 0 104.24 4.24" />
      <path d="M1 1l22 22" />
    </svg>
  );
}

export default function PasswordField({
  label, value, onChange, placeholder, required, autoComplete, error, disabled, name, autoFocus,
}) {
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(false);

  return (
    <div style={{ marginBottom: 16 }}>
      <label htmlFor={name} style={labelStyle}>{label}</label>
      <div style={{ position: 'relative' }}>
        <input
          id={name}
          name={name}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          required={required}
          autoComplete={autoComplete}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-invalid={!!error}
          aria-describedby={error ? `${name}-error` : undefined}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{ ...fieldStyle({ error, focused }), paddingRight: 44, opacity: disabled ? 0.6 : 1 }}
        />
        <button
          type="button"
          onClick={() => setVisible(v => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          tabIndex={0}
          disabled={disabled}
          style={{
            position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
            width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'none', border: 'none', borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer',
            color: 'var(--text-dim)', padding: 0,
          }}
          onMouseDown={e => e.preventDefault()} // keep focus on input for screen readers
        >
          <EyeIcon open={visible} />
        </button>
      </div>
      {error && (
        <div id={`${name}-error`} role="alert" style={{ fontSize: 12, color: 'var(--color-red)', marginTop: 6 }}>
          {error}
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';

const labelStyle = {
  display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-dim)',
  marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em',
};

export function fieldStyle({ error, focused }) {
  return {
    width: '100%', padding: '12px 16px', borderRadius: 12, fontSize: 14,
    background: 'var(--bg-elevated)',
    border: `1px solid ${error ? 'var(--color-red)' : focused ? 'var(--color-primary)' : 'var(--border)'}`,
    color: 'var(--text)', outline: 'none', boxSizing: 'border-box',
    transition: 'border-color 0.15s, box-shadow 0.15s',
    boxShadow: focused && !error ? '0 0 0 3px var(--color-primary-dim)' : 'none',
  };
}

export default function FormField({
  label, type = 'text', value, onChange, placeholder, required, autoComplete,
  error, disabled, autoFocus, name,
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ marginBottom: 16 }}>
      <label htmlFor={name} style={labelStyle}>{label}</label>
      <input
        id={name}
        name={name}
        type={type}
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
        style={{ ...fieldStyle({ error, focused }), opacity: disabled ? 0.6 : 1 }}
      />
      {error && (
        <div id={`${name}-error`} role="alert" style={{ fontSize: 12, color: 'var(--color-red)', marginTop: 6 }}>
          {error}
        </div>
      )}
    </div>
  );
}
